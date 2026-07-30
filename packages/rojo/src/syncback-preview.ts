import { dirname, extname, isAbsolute, normalize, resolve } from "node:path";
import type { ProcessRunner } from "./rojo-service.js";

const OUTPUT_LIMIT = 8_192;
const OPERATION_LIMIT = 256;
const DEFAULT_TTL_MS = 5 * 60_000;
const acceptedExtensions = new Set([".rbxl", ".rbxlx", ".rbxm", ".rbxmx"]);

export interface SyncbackInput {
  readonly projectPath: string;
  readonly inputPath: string;
}

export interface SyncbackPreview {
  readonly id: string;
  readonly approvable: boolean;
  readonly additionsOrChanges: readonly string[];
  readonly removals: readonly string[];
  readonly stdout: string;
  readonly stderr: string;
  readonly args: readonly string[];
  readonly truncated: boolean;
  readonly safetyReason?: "output-truncated" | "operation-limit-exceeded" | "dirty-overlap" | "command-failed";
}

export interface SyncbackApplyResult {
  readonly ok: boolean;
  readonly changedPaths: readonly string[];
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
}

export interface SyncbackController {
  previewSyncback(input: SyncbackInput): Promise<SyncbackPreview>;
  approveSyncback(previewId: string): Promise<void>;
  applyApprovedSyncback(previewId: string): Promise<SyncbackApplyResult>;
}

export interface SyncbackControllerOptions {
  readonly runner: ProcessRunner;
  readonly now: () => number;
  readonly createId: () => string;
  readonly fingerprint: (path: string) => Promise<string>;
  readonly dirtyPaths: () => Promise<readonly string[]>;
  readonly ttlMs?: number;
}

interface StoredPreview {
  readonly preview: SyncbackPreview;
  readonly projectFingerprint: string;
  readonly inputFingerprint: string;
  readonly sourceFingerprints: ReadonlyMap<string, string>;
  readonly createdAt: number;
  approved: boolean;
  approving: boolean;
  consumed: boolean;
}

/** Creates an approval-bound controller for bounded, batch Rojo syncback. */
export function createSyncbackController(options: SyncbackControllerOptions): SyncbackController {
  const previews = new Map<string, StoredPreview>();
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;

  const previewSyncback = async (input: SyncbackInput): Promise<SyncbackPreview> => {
    validateInput(input.inputPath);
    const args = ["--color", "never", "syncback", input.projectPath, "--input", input.inputPath, "--list", "--dry-run"];
    const result = await options.runner.run({ command: "rojo", args, shell: false });
    const stdout = bound(result.stdout);
    const stderr = bound(result.stderr);
    const operations = parseOperations(stdout.value, dirname(input.projectPath));
    const dirty = await options.dirtyPaths();
    const allChanged = [...operations.additionsOrChanges, ...operations.removals];
    const overlaps = dirty.some((path) => allChanged.some((changed) => overlapsPath(path, changed)));
    const safetyReason =
      stdout.truncated || stderr.truncated
        ? ("output-truncated" as const)
        : operations.exceeded
          ? ("operation-limit-exceeded" as const)
          : overlaps
            ? ("dirty-overlap" as const)
            : result.exitCode !== 0
              ? ("command-failed" as const)
              : undefined;
    const preview = Object.freeze({
      id: options.createId(),
      approvable: safetyReason === undefined,
      additionsOrChanges: Object.freeze(operations.additionsOrChanges),
      removals: Object.freeze(operations.removals),
      stdout: stdout.value,
      stderr: stderr.value,
      truncated: stdout.truncated || stderr.truncated,
      args: Object.freeze([...args]),
      ...(safetyReason === undefined ? {} : { safetyReason }),
    });
    const sourceFingerprints = new Map<string, string>();
    for (const path of allChanged) {
      sourceFingerprints.set(path, await options.fingerprint(path));
    }
    previews.set(preview.id, {
      preview,
      projectFingerprint: await options.fingerprint(input.projectPath),
      inputFingerprint: await options.fingerprint(input.inputPath),
      sourceFingerprints,
      createdAt: options.now(),
      approved: false,
      approving: false,
      consumed: false,
    });
    return preview;
  };

  const approveSyncback = async (previewId: string): Promise<void> => {
    const stored = getFresh(previews, previewId, options.now(), ttlMs);
    if (!stored.preview.approvable || stored.approving) {
      throw new Error(
        `Syncback preview cannot be approved${stored.preview.safetyReason === undefined ? "" : `: ${stored.preview.safetyReason}`}`,
      );
    }
    stored.approving = true;
    try {
      await assertFresh(stored, options);
      stored.approved = true;
    } finally {
      stored.approving = false;
    }
  };

  const applyApprovedSyncback = async (previewId: string): Promise<SyncbackApplyResult> => {
    const stored = getFresh(previews, previewId, options.now(), ttlMs);
    if (!stored.approved || stored.approving || stored.consumed) {
      throw new Error("Syncback preview is not approved");
    }
    stored.consumed = true;
    await assertFresh(stored, options);
    const args = stored.preview.args.filter((argument) => argument !== "--dry-run");
    args.push("--non-interactive");
    const result = await options.runner.run({ command: "rojo", args, shell: false });
    const changedPaths = Object.freeze([...stored.preview.additionsOrChanges, ...stored.preview.removals]);
    const stdout = bound(result.stdout);
    const stderr = bound(result.stderr);
    return Object.freeze({
      ok: result.exitCode === 0,
      changedPaths,
      stdout: stdout.value,
      stderr: stderr.value,
      truncated: stdout.truncated || stderr.truncated,
    });
  };

  return Object.freeze({ previewSyncback, approveSyncback, applyApprovedSyncback });
}

function getFresh(previews: ReadonlyMap<string, StoredPreview>, id: string, now: number, ttlMs: number): StoredPreview {
  const stored = previews.get(id);
  if (stored === undefined) {
    throw new Error("Unknown syncback preview");
  }
  if (now - stored.createdAt > ttlMs) {
    throw new Error("Syncback preview has expired");
  }
  return stored;
}

async function assertFresh(stored: StoredPreview, options: SyncbackControllerOptions): Promise<void> {
  const args = stored.preview.args;
  const projectPath = args[3];
  const inputPath = args[5];
  if (
    projectPath === undefined ||
    inputPath === undefined ||
    (await options.fingerprint(projectPath)) !== stored.projectFingerprint ||
    (await options.fingerprint(inputPath)) !== stored.inputFingerprint
  ) {
    throw new Error("Syncback preview inputs changed since preview");
  }
  for (const [path, fingerprint] of stored.sourceFingerprints) {
    if ((await options.fingerprint(path)) !== fingerprint) {
      throw new Error("Syncback source changed since preview");
    }
  }
  const changed = [...stored.preview.additionsOrChanges, ...stored.preview.removals];
  const dirty = await options.dirtyPaths();
  if (dirty.some((path) => changed.some((target) => overlapsPath(path, target)))) {
    throw new Error("Syncback preview overlaps dirty paths");
  }
}

function validateInput(inputPath: string): void {
  if (!acceptedExtensions.has(extname(inputPath).toLowerCase())) {
    throw new Error("Syncback input must be a .rbxl, .rbxlx, .rbxm, or .rbxmx file");
  }
}

function parseOperations(
  stdout: string,
  projectDirectory: string,
): { readonly additionsOrChanges: string[]; readonly removals: string[]; readonly exceeded: boolean } {
  const additionsOrChanges: string[] = [];
  const removals: string[] = [];
  let exceeded = false;
  for (const line of stdout.split(/\r?\n/)) {
    const write = /^Writing (.+)$/.exec(line);
    const remove = /^Removing (.+)$/.exec(line);
    if (
      (write?.[1] !== undefined || remove?.[1] !== undefined) &&
      additionsOrChanges.length + removals.length >= OPERATION_LIMIT
    ) {
      exceeded = true;
      break;
    }
    if (write?.[1] !== undefined) additionsOrChanges.push(normalizePath(write[1], projectDirectory));
    if (remove?.[1] !== undefined) removals.push(normalizePath(remove[1], projectDirectory));
  }
  return { additionsOrChanges, removals, exceeded };
}

function overlapsPath(left: string, right: string): boolean {
  left = comparablePath(left);
  right = comparablePath(right);
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function normalizePath(path: string, projectDirectory: string): string {
  return comparablePath(normalize(isAbsolute(path) ? path : resolve(projectDirectory, path)));
}

function comparablePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^([A-Z]):/, (_, drive: string) => `${drive.toLowerCase()}:`);
}
function bound(value: string): { readonly value: string; readonly truncated: boolean } {
  return value.length <= OUTPUT_LIMIT
    ? { value, truncated: false }
    : { value: value.slice(0, OUTPUT_LIMIT), truncated: true };
}
