import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { basename } from "node:path";
import * as nativePath from "node:path";
import { createHash } from "node:crypto";
import { parse, type ParseError } from "jsonc-parser";
import type { ProjectRef } from "../../shared/domain.js";

export type ProjectIdentityErrorCode =
  "missing" | "unreadable" | "symlink" | "outside-root" | "inode-changed" | "digest-changed";

export class ProjectIdentityError extends Error {
  constructor(
    readonly code: ProjectIdentityErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ProjectIdentityError";
  }
}

export function captureProjectIdentity(input: {
  readonly projectId: string;
  readonly rootPath: string;
  readonly projectFilePath: string;
  readonly revision: number;
}): ProjectRef {
  const root = captureRoot(input.rootPath);
  const file = captureFile(input.projectFilePath, root.canonicalRoot);
  return Object.freeze({
    projectId: input.projectId,
    canonicalRoot: root.canonicalRoot,
    rootDevice: root.device,
    rootInode: root.inode,
    canonicalProjectFile: file.canonicalPath,
    projectFileDevice: file.device,
    projectFileInode: file.inode,
    configDigest: file.digest,
    revision: input.revision,
  });
}

export function assertProjectIdentityCurrent(ref: ProjectRef): void {
  revalidate(ref);
}

export function readProjectConfig(ref: ProjectRef): {
  readonly displayName: string;
  readonly servePlaceIds: readonly number[];
} {
  const source = revalidate(ref).bytes.toString("utf8");
  const errors: ParseError[] = [];
  const value: unknown = parse(source, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0 || !isRecord(value) || !isRecord(value.tree)) {
    throw new ProjectIdentityError(
      "digest-changed",
      "Project configuration is malformed; reconnect after correcting it.",
    );
  }
  const displayName =
    typeof value.name === "string" ? value.name : basename(ref.canonicalProjectFile).replace(/\.project\.jsonc?$/, "");
  const placeIds = value.servePlaceIds;
  if (
    placeIds !== undefined &&
    (!Array.isArray(placeIds) || !placeIds.every((id) => Number.isSafeInteger(id) && id >= 0))
  ) {
    throw new ProjectIdentityError(
      "digest-changed",
      "Project servePlaceIds are malformed; reconnect after correcting them.",
    );
  }
  return Object.freeze({ displayName, servePlaceIds: Object.freeze(placeIds === undefined ? [] : [...placeIds]) });
}

function revalidate(ref: ProjectRef): ReturnType<typeof captureFile> {
  const root = captureRoot(ref.canonicalRoot);
  if (root.canonicalRoot !== ref.canonicalRoot || root.device !== ref.rootDevice || root.inode !== ref.rootInode) {
    throw new ProjectIdentityError("inode-changed", "Project root identity changed; reconnect the project explicitly.");
  }
  const file = captureFile(ref.canonicalProjectFile, root.canonicalRoot);
  if (
    file.canonicalPath !== ref.canonicalProjectFile ||
    file.device !== ref.projectFileDevice ||
    file.inode !== ref.projectFileInode
  ) {
    throw new ProjectIdentityError("inode-changed", "Project file identity changed; reconnect the project explicitly.");
  }
  if (file.digest !== ref.configDigest) {
    throw new ProjectIdentityError(
      "digest-changed",
      "Project file contents changed; reconnect the project explicitly.",
    );
  }
  return file;
}

function captureRoot(path: string): {
  readonly canonicalRoot: string;
  readonly device: string;
  readonly inode: string;
} {
  const initial = safeLstat(path, "Project root");
  if (initial.isSymbolicLink()) throw new ProjectIdentityError("symlink", "Project root cannot be a symbolic link.");
  const canonicalRoot = safeRealpath(path, "Project root");
  const stat = safeLstat(canonicalRoot, "Project root");
  if (!stat.isDirectory()) throw new ProjectIdentityError("missing", "Project root is not a directory.");
  return { canonicalRoot, device: String(stat.dev), inode: String(stat.ino) };
}

function captureFile(
  path: string,
  canonicalRoot: string,
): {
  readonly canonicalPath: string;
  readonly device: string;
  readonly inode: string;
  readonly digest: string;
  readonly bytes: Buffer;
} {
  const before = safeLstat(path, "Project file");
  if (before.isSymbolicLink()) throw new ProjectIdentityError("symlink", "Project file cannot be a symbolic link.");
  const canonicalPath = safeRealpath(path, "Project file");
  if (!isPathWithin(canonicalRoot, canonicalPath)) {
    throw new ProjectIdentityError("outside-root", "Selected project file is outside the selected root.");
  }
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    throw classifyFsError(error, "Project file is unreadable.");
  }
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) throw new ProjectIdentityError("missing", "Project file is not a regular file.");
    if (String(stat.dev) !== String(before.dev) || String(stat.ino) !== String(before.ino)) {
      throw new ProjectIdentityError("inode-changed", "Project file identity changed while it was opened.");
    }
    const bytes = readAll(descriptor, stat.size);
    return {
      canonicalPath,
      device: String(stat.dev),
      inode: String(stat.ino),
      digest: createHash("sha256").update(bytes).digest("hex"),
      bytes,
    };
  } catch (error) {
    if (error instanceof ProjectIdentityError) throw error;
    throw classifyFsError(error, "Project file is unreadable.");
  } finally {
    closeSync(descriptor);
  }
}

function readAll(descriptor: number, expectedSize: number): Buffer {
  const chunks: Buffer[] = [];
  let offset = 0;
  do {
    const buffer = Buffer.allocUnsafe(Math.max(1, Math.min(64 * 1024, expectedSize - offset || 64 * 1024)));
    const read = readSync(descriptor, buffer, 0, buffer.length, offset);
    if (read === 0) break;
    chunks.push(buffer.subarray(0, read));
    offset += read;
  } while (true);
  return Buffer.concat(chunks);
}

function safeLstat(path: string, label: string) {
  try {
    return lstatSync(path);
  } catch (error) {
    throw classifyFsError(error, `${label} is unavailable.`);
  }
}

function safeRealpath(path: string, label: string): string {
  try {
    return realpathSync(path);
  } catch (error) {
    throw classifyFsError(error, `${label} is unavailable.`);
  }
}

function classifyFsError(error: unknown, message: string): ProjectIdentityError {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? (error as { readonly code?: string }).code
      : undefined;
  return new ProjectIdentityError(
    code === "ENOENT" || code === "ENOTDIR" ? "missing" : code === "ELOOP" ? "symlink" : "unreadable",
    message,
    { cause: error },
  );
}

type PathSemantics = Pick<typeof nativePath, "isAbsolute" | "relative" | "resolve" | "sep">;

export function isPathWithin(root: string, file: string, paths: PathSemantics = nativePath): boolean {
  const result = paths.relative(paths.resolve(root), paths.resolve(file));
  return result === "" || (!paths.isAbsolute(result) && result !== ".." && !result.startsWith(`..${paths.sep}`));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
