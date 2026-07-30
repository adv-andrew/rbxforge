import { constants, type Stats } from "node:fs";
import { lstat, link, mkdir, open, realpath, rename } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

export const AUDITED_STUDIO_PLUGIN = Object.freeze({
  fileName: "MCPPlugin.rbxmx",
  inspectorFileName: "MCPInspectorPlugin.rbxmx",
  sha256: "57f16e4e89f4e60d327fa76c89fc44e85a16d8a7051579d38ec0ee7501cad09c",
  size: 5_396_699,
  variant: "main",
  version: "2.22.5",
});

/** Hard resource ceilings for installer-owned files and the anchored helper. */
export const STUDIO_PLUGIN_INSTALL_LIMITS = Object.freeze({
  maxExistingPluginBytes: 16 * 1024 * 1024,
  maxHelperRequestBytes: 64 * 1024,
  maxHelperStdinBytes: 16 * 1024 * 1024,
  maxHelperTotalPayloadBytes: 16 * 1024 * 1024 + 64 * 1024,
  maxRetainedPartialBytes: 24 * 1024 * 1024,
  maxRetainedPartialCount: 4,
});

export interface PluginInspection {
  readonly state: "missing" | "installed" | "replace-required" | "inspector-conflict" | "error";
  readonly sourcePath: string;
  readonly destinationPath: string;
  readonly sourceSha256?: string;
  readonly destinationSha256?: string;
  readonly inspectorPath?: string;
  readonly restartRequired: boolean;
  readonly detail: string;
}

export interface PluginInstallResult extends PluginInspection {
  readonly state: "installed";
  readonly changed: boolean;
  readonly backupPath?: string;
}

export interface PluginInstallerFileHandle {
  stat(): Promise<Stats>;
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number | null,
  ): Promise<{ readonly bytesRead: number }>;
  write(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number | null,
  ): Promise<{ readonly bytesWritten: number }>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface PluginInstallerIo {
  /** @internal Allows deterministic path-race injection in temporary-directory tests only. */
  readonly pathOperationsForTesting?: true;
  lstat(path: string): Promise<Stats>;
  realpath(path: string): Promise<string>;
  open(path: string, flags: string | number, mode?: number): Promise<PluginInstallerFileHandle>;
  mkdir(path: string): Promise<string | undefined>;
  link(existingPath: string, newPath: string): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
}

export interface StudioPluginInstallerOptions {
  readonly sourcePath: string;
  readonly homeDirectory: string;
  readonly io?: PluginInstallerIo;
  readonly now?: () => number;
  readonly randomName?: () => string;
  /** @internal Forces the production directory anchor while retaining injected read seams. */
  readonly useAnchoredOperations?: boolean;
  /** @internal Deterministic race seam used only by temporary-directory tests. */
  readonly beforeAnchoredDirectoryOperation?: (operation: AnchoredDirectoryOperation) => void | Promise<void>;
  /** @internal Executes an injected helper outcome after the real mutation in temporary-directory tests. */
  readonly anchoredHelperRunnerForTesting?: AnchoredHelperRunnerForTesting;
}

export interface AnchoredHelperProcessResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly error?: Error;
}

export type AnchoredHelperRunnerForTesting = (
  operation: string,
  runDefault: () => AnchoredHelperProcessResult,
) => AnchoredHelperProcessResult;

export type AnchoredDirectoryOperation =
  | "ensure-documents"
  | "ensure-roblox"
  | "ensure-plugins"
  | "write-backup"
  | "write-temporary"
  | "commit-missing"
  | "commit-replacement";

export type PluginInstallErrorCode =
  | "plugin-anchoring-unavailable"
  | "plugin-backup-collision"
  | "plugin-commit-indeterminate"
  | "plugin-destination-changed"
  | "plugin-destination-invalid"
  | "plugin-final-verification-failed"
  | "plugin-file-too-large"
  | "plugin-helper-payload-too-large"
  | "plugin-inspector-conflict"
  | "plugin-install-io-failed"
  | "plugin-path-invalid"
  | "plugin-permission-denied"
  | "plugin-replace-confirmation-required"
  | "plugin-retained-partial-limit"
  | "plugin-source-changed"
  | "plugin-source-invalid"
  | "plugin-temporary-verification-failed";

export class PluginInstallError extends Error {
  readonly code: PluginInstallErrorCode;

  constructor(code: PluginInstallErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PluginInstallError";
    this.code = code;
  }
}

interface FileSnapshot {
  readonly dev: string;
  readonly ino: string;
  readonly mode: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}

interface AuditedFile {
  readonly bytes: Buffer;
  readonly sha256: string;
  readonly snapshot: FileSnapshot;
}

interface ValidScan {
  readonly inspection: Exclude<PluginInspection, { readonly state: "error" | "inspector-conflict" }>;
  readonly source: AuditedFile;
  readonly destination?: AuditedFile;
}

interface OwnedPath {
  readonly path: string;
  readonly snapshot: FileSnapshot;
}

interface DirectoryAnchor {
  readonly path: string;
  readonly canonicalPath: string;
  readonly snapshot: FileSnapshot;
}

interface AnchoredResult {
  readonly snapshot?: FileSnapshot;
  readonly sha256?: string;
  readonly canonicalPath?: string;
  readonly partials?: {
    readonly count: number;
    readonly bytes: number;
    readonly names: readonly string[];
  };
}

const defaultIo: PluginInstallerIo = {
  lstat,
  realpath,
  open: (path, flags, mode) => open(path, flags, mode),
  mkdir,
  link,
  rename,
};

const noFollow = constants.O_NOFOLLOW ?? 0;
const directoryFlag = constants.O_DIRECTORY ?? 0;
const installLocks = new Map<string, Promise<void>>();
const anchoredHelperRequestEnvironment = "RBXFORGE_PLUGIN_HELPER_REQUEST";
const anchoredHelperSource = String.raw`
const fs = require("node:fs");
const crypto = require("node:crypto");

function fail(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  error.cause = cause;
  throw error;
}

function snapshot(value) {
  return {
    dev: String(value.dev),
    ino: String(value.ino),
    mode: value.mode,
    size: value.size,
    mtimeMs: value.mtimeMs,
    ctimeMs: value.ctimeMs,
  };
}

function sameIdentity(left, right) {
  return String(left.dev) === String(right.dev) && String(left.ino) === String(right.ino);
}

function sameSnapshot(left, right) {
  return (
    sameIdentity(left, right) &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

const maxFileBytes = ${STUDIO_PLUGIN_INSTALL_LIMITS.maxExistingPluginBytes};
const maxStdinBytes = ${STUDIO_PLUGIN_INSTALL_LIMITS.maxHelperStdinBytes};
const partialPattern = /^\.MCPPlugin\.rbxmx\.(?:tmp|backup-partial)-[0-9a-f]{24}$/;

function audit(name, expected) {
  const before = fs.lstatSync(name);
  if (before.isSymbolicLink() || !before.isFile()) fail("plugin-destination-invalid", name + " is not a regular file.");
  if (before.size > maxFileBytes) {
    fail("plugin-file-too-large", name + " exceeds the 16 MiB installer file limit.");
  }
  if (expected && !sameSnapshot(snapshot(before), expected.snapshot)) {
    fail("plugin-destination-changed", name + " changed before audit.");
  }
  const fd = fs.openSync(name, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || !sameIdentity(before, opened)) fail("plugin-destination-changed", name + " changed before audit.");
    if (opened.size > maxFileBytes) {
      fail("plugin-file-too-large", name + " exceeds the 16 MiB installer file limit.");
    }
    if (expected && !sameSnapshot(snapshot(opened), expected.snapshot)) {
      fail("plugin-destination-changed", name + " changed before allocation.");
    }
    if (!sameSnapshot(snapshot(before), snapshot(opened))) {
      fail("plugin-destination-changed", name + " changed before allocation.");
    }
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count === 0) fail("plugin-destination-changed", name + " ended during audit.");
      offset += count;
    }
    const afterHandle = fs.fstatSync(fd);
    const afterPath = fs.lstatSync(name);
    if (
      afterPath.isSymbolicLink() ||
      !afterPath.isFile() ||
      !sameSnapshot(snapshot(before), snapshot(afterHandle)) ||
      !sameSnapshot(snapshot(before), snapshot(afterPath))
    ) {
      fail("plugin-destination-changed", name + " changed during audit.");
    }
    return {
      snapshot: snapshot(afterHandle),
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    };
  } finally {
    fs.closeSync(fd);
  }
}

function readStdinBounded() {
  const chunks = [];
  let total = 0;
  for (;;) {
    const remaining = maxStdinBytes - total;
    const chunk = Buffer.alloc(Math.min(64 * 1024, remaining + 1));
    const count = fs.readSync(0, chunk, 0, chunk.length, null);
    if (count === 0) break;
    total += count;
    if (total > maxStdinBytes) {
      fail("plugin-helper-payload-too-large", "The anchored helper stdin exceeds 16 MiB.");
    }
    chunks.push(chunk.subarray(0, count));
  }
  return Buffer.concat(chunks, total);
}

function inventoryPartials() {
  let count = 0;
  let bytes = 0;
  const names = [];
  const directory = fs.opendirSync(".");
  try {
    for (;;) {
      const entry = directory.readSync();
      if (!entry) break;
      if (!partialPattern.test(entry.name)) continue;
      const item = fs.lstatSync(entry.name);
      if (item.isSymbolicLink() || !item.isFile()) continue;
      count += 1;
      bytes += item.size;
      if (names.length < ${STUDIO_PLUGIN_INSTALL_LIMITS.maxRetainedPartialCount}) names.push(entry.name);
    }
  } finally {
    directory.closeSync();
  }
  return { count, bytes, names: names.sort() };
}

function matchesExpected(actual, expected) {
  return (
    actual.sha256 === expected.sha256 &&
    actual.snapshot.dev === expected.snapshot.dev &&
    actual.snapshot.ino === expected.snapshot.ino &&
    actual.snapshot.size === expected.snapshot.size &&
    actual.snapshot.mode === expected.snapshot.mode &&
    actual.snapshot.mtimeMs === expected.snapshot.mtimeMs &&
    actual.snapshot.ctimeMs === expected.snapshot.ctimeMs
  );
}

function fsyncDirectory() {
  const fd = fs.openSync(".", fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0) | (fs.constants.O_NOFOLLOW || 0));
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function inspectorAbsent(name) {
  try {
    fs.lstatSync(name);
  } catch (error) {
    if (error && error.code === "ENOENT") return;
    throw error;
  }
  fail("plugin-inspector-conflict", name + " conflicts with the supported main plugin.");
}

function destinationAbsent(name) {
  try {
    fs.lstatSync(name);
  } catch (error) {
    if (error && error.code === "ENOENT") return;
    throw error;
  }
  fail("plugin-destination-changed", "The destination appeared before exclusive commit.");
}

try {
  const request = JSON.parse(process.env.${anchoredHelperRequestEnvironment});
  const directory = fs.lstatSync(".");
  if (
    directory.isSymbolicLink() ||
    !directory.isDirectory() ||
    String(directory.dev) !== request.anchor.snapshot.dev ||
    String(directory.ino) !== request.anchor.snapshot.ino
  ) {
    fail("plugin-path-invalid", "The anchored Plugins directory identity changed before mutation.");
  }

  let result = {};
  if (request.operation === "ensure-directory") {
    try {
      fs.mkdirSync(request.name, { mode: 0o755 });
    } catch (error) {
      if (!error || error.code !== "EEXIST") throw error;
    }
    const child = fs.lstatSync(request.name);
    if (child.isSymbolicLink() || !child.isDirectory()) {
      fail("plugin-path-invalid", request.name + " is not a real directory.");
    }
    result = { snapshot: snapshot(child), canonicalPath: fs.realpathSync(request.name) };
  } else if (request.operation === "write-exclusive") {
    const bytes = readStdinBounded();
    const fd = fs.openSync(
      request.name,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW || 0),
      0o600,
    );
    try {
      let offset = 0;
      while (offset < bytes.length) {
        const count = fs.writeSync(fd, bytes, offset, bytes.length - offset, offset);
        if (count === 0) fail("plugin-install-io-failed", "The anchored filesystem accepted a zero-byte write.");
        offset += count;
      }
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    result = audit(request.name);
    if (result.sha256 !== request.expectedSha256 || result.snapshot.size !== bytes.length) {
      fail(
        request.kind === "temporary" ? "plugin-temporary-verification-failed" : "plugin-install-io-failed",
        "The anchored " + request.kind + " failed digest verification.",
      );
    }
    if (request.syncDirectory === true) {
      fsyncDirectory();
      const afterSync = audit(request.name);
      if (!matchesExpected(afterSync, result)) {
        fail("plugin-install-io-failed", "The anchored backup changed after directory fsync.");
      }
      result = afterSync;
    }
  } else if (request.operation === "inventory-partials") {
    result = { partials: inventoryPartials() };
  } else if (request.operation === "promote-backup") {
    const partial = audit(request.partialName, request.partial);
    if (!matchesExpected(partial, request.partial)) {
      fail("plugin-install-io-failed", "The backup partial changed before promotion.");
    }
    try {
      fs.linkSync(request.partialName, request.backupName);
    } catch (error) {
      if (error && error.code === "EEXIST") fail("plugin-backup-collision", "The backup name already exists.", error);
      throw error;
    }
    fsyncDirectory();
    const promoted = audit(request.backupName);
    if (promoted.sha256 !== request.partial.sha256 || promoted.snapshot.size !== request.partial.snapshot.size) {
      fail("plugin-install-io-failed", "The promoted backup failed final verification.");
    }
    result = promoted;
  } else if (request.operation === "commit") {
    inspectorAbsent(request.inspectorName);
    const temporary = audit(request.temporaryName, request.temporary);
    if (!matchesExpected(temporary, request.temporary)) {
      fail("plugin-temporary-verification-failed", "The anchored temporary changed before commit.");
    }
    let committed = false;
    try {
      if (request.mode === "missing") {
        destinationAbsent(request.destinationName);
        try {
          fs.linkSync(request.temporaryName, request.destinationName);
        } catch (error) {
          if (error && error.code === "EEXIST") {
            fail("plugin-destination-changed", "The destination appeared during exclusive commit.", error);
          }
          throw error;
        }
      } else {
        const destination = audit(request.destinationName, request.destination);
        if (!matchesExpected(destination, request.destination)) {
          fail("plugin-destination-changed", "The destination changed before atomic replacement.");
        }
        fs.renameSync(request.temporaryName, request.destinationName);
      }
      committed = true;
      try {
        fsyncDirectory();
      } catch (error) {
        fail("plugin-commit-indeterminate", "The committed Plugins directory could not be synced.", error);
      }
      const finalDestination = audit(request.destinationName);
      if (
        finalDestination.sha256 !== request.finalSha256 ||
        finalDestination.snapshot.size !== request.finalSize
      ) {
        fail("plugin-final-verification-failed", "The final anchored destination failed digest verification.");
      }
      result = finalDestination;
    } catch (error) {
      if (committed && (!error || typeof error.code !== "string")) {
        fail("plugin-commit-indeterminate", "The anchored commit completed but verification failed.", error);
      }
      throw error;
    }
  } else if (request.operation === "sync-directory") {
    fsyncDirectory();
  } else {
    fail("plugin-install-io-failed", "Unknown anchored helper operation.");
  }

  process.stdout.write(JSON.stringify({ ok: true, ...result }));
} catch (error) {
  process.stdout.write(
    JSON.stringify({
      ok: false,
      code: error && typeof error.code === "string" ? error.code : "plugin-install-io-failed",
      message: error instanceof Error ? error.message : "Anchored helper failed.",
    }),
  );
  process.exitCode = 1;
}
`;

export class StudioPluginInstaller {
  readonly #sourcePath: string;
  readonly #homeDirectory: string;
  readonly #pluginsDirectory: string;
  readonly #destinationPath: string;
  readonly #inspectorPath: string;
  readonly #io: PluginInstallerIo;
  readonly #now: () => number;
  readonly #randomName: () => string;
  readonly #useAnchoredOperations: boolean;
  readonly #beforeAnchoredDirectoryOperation:
    ((operation: AnchoredDirectoryOperation) => void | Promise<void>) | undefined;
  readonly #anchoredHelperRunnerForTesting: AnchoredHelperRunnerForTesting | undefined;

  constructor(options: StudioPluginInstallerOptions) {
    if (!isAbsolute(options.sourcePath) || !isAbsolute(options.homeDirectory)) {
      throw new PluginInstallError(
        "plugin-path-invalid",
        "The Studio plugin source and injected home directory must be absolute paths.",
      );
    }
    this.#sourcePath = resolve(options.sourcePath);
    this.#homeDirectory = resolve(options.homeDirectory);
    this.#pluginsDirectory = join(this.#homeDirectory, "Documents", "Roblox", "Plugins");
    this.#destinationPath = join(this.#pluginsDirectory, AUDITED_STUDIO_PLUGIN.fileName);
    this.#inspectorPath = join(this.#pluginsDirectory, AUDITED_STUDIO_PLUGIN.inspectorFileName);
    this.#io = options.io ?? defaultIo;
    this.#now = options.now ?? Date.now;
    this.#randomName = options.randomName ?? (() => randomBytes(12).toString("hex"));
    this.#useAnchoredOperations = options.useAnchoredOperations ?? options.io?.pathOperationsForTesting !== true;
    this.#beforeAnchoredDirectoryOperation = options.beforeAnchoredDirectoryOperation;
    this.#anchoredHelperRunnerForTesting = options.anchoredHelperRunnerForTesting;
  }

  pluginsDirectory(): string {
    return this.#pluginsDirectory;
  }

  async inspect(): Promise<PluginInspection> {
    try {
      return (await this.#scan()).inspection;
    } catch (error) {
      if (error instanceof PluginInstallError && error.code === "plugin-inspector-conflict") {
        return this.#inspection({
          state: "inspector-conflict",
          inspectorPath: this.#inspectorPath,
          restartRequired: false,
          detail: `${error.message} Use Show Plugins folder to remove it manually, then inspect again.`,
        });
      }
      const failure = this.#normalizeError(error);
      return this.#inspection({
        state: "error",
        restartRequired: false,
        detail: failure.message,
      });
    }
  }

  install(options: { readonly confirmReplace: boolean }): Promise<PluginInstallResult> {
    return this.#canonicalLockKey().then((key) => withInstallLock(key, () => this.#installLocked(options)));
  }

  async #canonicalLockKey(): Promise<string> {
    try {
      const canonicalHome = await this.#io.realpath(this.#homeDirectory);
      return join(canonicalHome, "Documents", "Roblox", "Plugins", AUDITED_STUDIO_PLUGIN.fileName);
    } catch (error) {
      throw this.#normalizeError(
        error,
        "plugin-path-invalid",
        "The injected home directory could not be resolved for installation.",
      );
    }
  }

  async #installLocked(options: { readonly confirmReplace: boolean }): Promise<PluginInstallResult> {
    const initial = await this.#scan();
    if (initial.inspection.state === "installed") {
      return {
        ...initial.inspection,
        state: "installed",
        changed: false,
        restartRequired: false,
      };
    }
    if (initial.inspection.state === "replace-required" && !options.confirmReplace) {
      throw new PluginInstallError(
        "plugin-replace-confirmation-required",
        "Replacing the existing Studio plugin requires explicit confirmation.",
      );
    }

    const directoryAnchor = await this.#ensurePluginsDirectory();
    const source = await this.#auditSource();
    await this.#validateDirectoryComponents(false);
    await this.#assertInspectorAbsent();
    const destination = await this.#auditDestinationIfPresent();

    if (initial.inspection.state === "missing") {
      if (destination !== undefined) {
        throw new PluginInstallError(
          "plugin-destination-changed",
          "The Studio plugin destination appeared after inspection; inspect again before installing.",
        );
      }
    } else if (
      initial.destination === undefined ||
      destination === undefined ||
      !sameAudit(initial.destination, destination)
    ) {
      throw new PluginInstallError(
        "plugin-destination-changed",
        "The existing Studio plugin changed after inspection; inspect again before replacing it.",
      );
    }

    let backup: OwnedPath | undefined;
    let backupPartial: OwnedPath | undefined;
    let backupVerified = false;
    let temporary: OwnedPath | undefined;
    let committed = false;
    try {
      if (destination !== undefined) {
        const backupPath = join(
          this.#pluginsDirectory,
          `${AUDITED_STUDIO_PLUGIN.fileName}.backup-${utcTimestamp(this.#now())}`,
        );
        if (this.#useAnchoredOperations) {
          const backupPartialPath = join(
            this.#pluginsDirectory,
            `.${AUDITED_STUDIO_PLUGIN.fileName}.backup-partial-${this.#nextRandomName()}`,
          );
          await this.#assertRetainedPartialBudget(directoryAnchor, destination.bytes.length + source.bytes.length, 2);
          backupPartial = await this.#writeExclusiveVerified(
            backupPartialPath,
            destination.bytes,
            destination.sha256,
            "backup",
            directoryAnchor,
          );
          backup = await this.#promoteBackup(directoryAnchor, backupPartial, backupPath, destination.sha256);
        } else {
          backup = await this.#writeExclusiveVerified(
            backupPath,
            destination.bytes,
            destination.sha256,
            "backup",
            directoryAnchor,
          );
          await this.#syncDirectory(false, directoryAnchor);
          await this.#assertOwnedFileReady(
            backup,
            destination.bytes.length,
            destination.sha256,
            "plugin-install-io-failed",
            "The exact owned backup changed after its directory fsync.",
          );
        }
        backupVerified = true;
      }

      const temporaryRandomName = this.#nextRandomName();
      const temporaryPath = join(
        this.#pluginsDirectory,
        `.${AUDITED_STUDIO_PLUGIN.fileName}.tmp-${temporaryRandomName}`,
      );
      if (this.#useAnchoredOperations) {
        await this.#assertRetainedPartialBudget(directoryAnchor, source.bytes.length);
      }
      temporary = await this.#writeExclusiveVerified(
        temporaryPath,
        source.bytes,
        AUDITED_STUDIO_PLUGIN.sha256,
        "temporary",
        directoryAnchor,
      );

      await this.#validateDirectoryComponents(false);
      await this.#assertInspectorAbsent();
      const latestSource = await this.#auditSource();
      if (!sameAudit(source, latestSource)) {
        throw new PluginInstallError(
          "plugin-source-changed",
          "The audited Studio plugin source changed before commit.",
        );
      }

      let finalDestination: AuditedFile;
      if (this.#useAnchoredOperations) {
        finalDestination = await this.#commitAnchored(directoryAnchor, temporary, destination);
        committed = true;
      } else {
        if (destination === undefined) {
          await this.#assertDestinationAbsent();
          await this.#validateDirectoryComponents(false);
          await this.#assertTemporaryReady(temporary);
          await this.#assertInspectorAbsent();
          try {
            await this.#io.link(temporary.path, this.#destinationPath);
          } catch (error) {
            if (errorCode(error) === "EEXIST") {
              throw new PluginInstallError(
                "plugin-destination-changed",
                "The Studio plugin destination appeared during commit; no file was overwritten.",
                { cause: error },
              );
            }
            throw error;
          }
        } else {
          const latestDestination = await this.#auditDestinationIfPresent();
          if (latestDestination === undefined || !sameAudit(destination, latestDestination)) {
            throw new PluginInstallError(
              "plugin-destination-changed",
              "The existing Studio plugin changed before atomic replacement; the verified backup was preserved.",
            );
          }
          await this.#validateDirectoryComponents(false);
          await this.#assertTemporaryReady(temporary);
          await this.#assertInspectorAbsent();
          // Node does not expose compare-and-swap rename on macOS. The immediate
          // retained-handle revalidation above is the same-user final-component race boundary.
          await this.#io.rename(temporary.path, this.#destinationPath);
        }
        committed = true;

        try {
          await this.#syncDirectory(true, directoryAnchor);
        } catch (error) {
          throw new PluginInstallError(
            "plugin-commit-indeterminate",
            "The plugin bytes were committed but the Plugins directory could not be synced. Reinspect before retrying.",
            { cause: error },
          );
        }

        const auditedDestination = await this.#auditDestinationIfPresent();
        if (
          auditedDestination === undefined ||
          auditedDestination.sha256 !== AUDITED_STUDIO_PLUGIN.sha256 ||
          auditedDestination.snapshot.size !== AUDITED_STUDIO_PLUGIN.size
        ) {
          throw new PluginInstallError(
            "plugin-final-verification-failed",
            "The final Studio plugin digest could not be verified. Reinspect before retrying.",
          );
        }
        finalDestination = auditedDestination;
      }

      return {
        ...this.#inspection({
          state: "installed",
          sourceSha256: source.sha256,
          destinationSha256: finalDestination.sha256,
          restartRequired: true,
          detail:
            destination === undefined
              ? "The exact audited Studio plugin was installed. A hidden owned staging hard link was retained because Node cannot conditionally unlink by inode; restart Roblox Studio before connecting."
              : "The exact audited Studio plugin and intentional timestamped backup were verified. A hidden owned backup partial was retained because Node cannot conditionally unlink by inode; restart Roblox Studio before connecting.",
        }),
        state: "installed",
        changed: true,
        restartRequired: true,
        ...(backup === undefined ? {} : { backupPath: backup.path }),
      };
    } catch (error) {
      if (committed && !(error instanceof PluginInstallError)) {
        throw new PluginInstallError(
          "plugin-commit-indeterminate",
          "The plugin commit completed but final verification failed. Reinspect before retrying.",
          { cause: error },
        );
      }
      throw this.#normalizeError(error);
    } finally {
      if (temporary !== undefined) await this.#cleanupOwned(temporary);
      if (backupPartial !== undefined) await this.#cleanupOwned(backupPartial);
      if (backup !== undefined && !backupVerified) await this.#cleanupOwned(backup);
    }
  }

  #nextRandomName(): string {
    const value = this.#randomName();
    if (Buffer.byteLength(value) > STUDIO_PLUGIN_INSTALL_LIMITS.maxHelperRequestBytes) {
      throw new PluginInstallError(
        "plugin-helper-payload-too-large",
        "The anchored helper request exceeds its bounded input limit; no staging file was created.",
      );
    }
    if (!/^[0-9a-f]{24}$/.test(value)) {
      throw new PluginInstallError("plugin-path-invalid", "The installer staging identifier is invalid.");
    }
    return value;
  }

  async #scan(): Promise<ValidScan> {
    const source = await this.#auditSource();
    const componentsExist = await this.#validateDirectoryComponents(true);
    if (!componentsExist) {
      return {
        source,
        inspection: this.#inspection({
          state: "missing",
          sourceSha256: source.sha256,
          restartRequired: false,
          detail: "The audited Studio plugin is ready to install.",
        }),
      };
    }
    await this.#assertInspectorAbsent();
    const destination = await this.#auditDestinationIfPresent();
    if (destination === undefined) {
      return {
        source,
        inspection: this.#inspection({
          state: "missing",
          sourceSha256: source.sha256,
          restartRequired: false,
          detail: "The audited Studio plugin is ready to install.",
        }),
      };
    }
    if (
      destination.sha256 === AUDITED_STUDIO_PLUGIN.sha256 &&
      destination.snapshot.size === AUDITED_STUDIO_PLUGIN.size
    ) {
      return {
        source,
        destination,
        inspection: this.#inspection({
          state: "installed",
          sourceSha256: source.sha256,
          destinationSha256: destination.sha256,
          restartRequired: false,
          detail: "The exact audited Studio plugin is already installed.",
        }),
      };
    }
    return {
      source,
      destination,
      inspection: this.#inspection({
        state: "replace-required",
        sourceSha256: source.sha256,
        destinationSha256: destination.sha256,
        restartRequired: false,
        detail: "A different regular Studio plugin exists and requires confirmed replacement.",
      }),
    };
  }

  #inspection(
    fields: Pick<PluginInspection, "state" | "restartRequired" | "detail"> &
      Partial<Pick<PluginInspection, "sourceSha256" | "destinationSha256" | "inspectorPath">>,
  ): PluginInspection {
    return {
      ...fields,
      sourcePath: this.#sourcePath,
      destinationPath: this.#destinationPath,
    };
  }

  async #auditSource(): Promise<AuditedFile> {
    let audit: AuditedFile;
    try {
      audit = await this.#auditRegularFile(this.#sourcePath, "source");
    } catch (error) {
      if (error instanceof PluginInstallError) throw error;
      throw this.#normalizeError(error, "plugin-source-invalid", "The Studio plugin source could not be audited.");
    }
    if (audit.snapshot.size !== AUDITED_STUDIO_PLUGIN.size) {
      throw new PluginInstallError(
        "plugin-source-invalid",
        `The Studio plugin source does not match the audited size ${AUDITED_STUDIO_PLUGIN.size}.`,
      );
    }
    if (audit.sha256 !== AUDITED_STUDIO_PLUGIN.sha256) {
      throw new PluginInstallError(
        "plugin-source-invalid",
        "The Studio plugin source does not match the audited digest.",
      );
    }
    return audit;
  }

  async #auditDestinationIfPresent(): Promise<AuditedFile | undefined> {
    let pathStat: Stats;
    try {
      pathStat = await this.#io.lstat(this.#destinationPath);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return undefined;
      throw this.#normalizeError(error);
    }
    if (pathStat.isSymbolicLink() || !pathStat.isFile()) {
      throw new PluginInstallError(
        "plugin-destination-invalid",
        "The Studio plugin destination must be a regular file that is not a symlink, or be absent.",
      );
    }
    return this.#auditRegularFile(this.#destinationPath, "destination", pathStat);
  }

  async #auditRegularFile(path: string, kind: "source" | "destination", knownPathStat?: Stats): Promise<AuditedFile> {
    let before: Stats;
    try {
      before = knownPathStat ?? (await this.#io.lstat(path));
    } catch (error) {
      throw this.#normalizeError(
        error,
        kind === "source" ? "plugin-source-invalid" : "plugin-destination-invalid",
        `The Studio plugin ${kind} could not be inspected.`,
      );
    }
    if (before.isSymbolicLink() || !before.isFile()) {
      throw new PluginInstallError(
        kind === "source" ? "plugin-source-invalid" : "plugin-destination-invalid",
        `The Studio plugin ${kind} must be a regular non-symlink file.`,
      );
    }

    let handle: PluginInstallerFileHandle;
    try {
      handle = await this.#io.open(path, constants.O_RDONLY | noFollow);
    } catch (error) {
      throw this.#normalizeError(
        error,
        kind === "source" ? "plugin-source-changed" : "plugin-destination-changed",
        `The Studio plugin ${kind} changed while it was being opened.`,
      );
    }
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || !sameSnapshot(snapshot(before), snapshot(opened))) {
        throw new PluginInstallError(
          kind === "source" ? "plugin-source-changed" : "plugin-destination-changed",
          `The Studio plugin ${kind} changed before its retained handle was audited.`,
        );
      }
      if (opened.size > STUDIO_PLUGIN_INSTALL_LIMITS.maxExistingPluginBytes) {
        throw new PluginInstallError(
          "plugin-file-too-large",
          `The 16 MiB installer limit was exceeded; the Studio plugin ${kind} is too large.`,
        );
      }
      if (kind === "source" && opened.size !== AUDITED_STUDIO_PLUGIN.size) {
        throw new PluginInstallError(
          "plugin-source-invalid",
          `The Studio plugin source does not match the audited size ${AUDITED_STUDIO_PLUGIN.size}.`,
        );
      }
      const bytes = await readExact(handle, opened.size);
      const afterHandle = await handle.stat();
      const afterPath = await this.#io.lstat(path);
      if (
        !afterHandle.isFile() ||
        afterPath.isSymbolicLink() ||
        !afterPath.isFile() ||
        !sameSnapshot(snapshot(before), snapshot(afterHandle)) ||
        !sameSnapshot(snapshot(before), snapshot(afterPath))
      ) {
        throw new PluginInstallError(
          kind === "source" ? "plugin-source-changed" : "plugin-destination-changed",
          `The Studio plugin ${kind} changed during its retained-handle audit.`,
        );
      }
      return {
        bytes,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        snapshot: snapshot(afterHandle),
      };
    } catch (error) {
      if (error instanceof PluginInstallError) throw error;
      throw this.#normalizeError(
        error,
        kind === "source" ? "plugin-source-changed" : "plugin-destination-changed",
        `The Studio plugin ${kind} changed during audit.`,
      );
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  async #validateDirectoryComponents(allowMissing: boolean): Promise<boolean> {
    const components = [
      this.#homeDirectory,
      join(this.#homeDirectory, "Documents"),
      join(this.#homeDirectory, "Documents", "Roblox"),
      this.#pluginsDirectory,
    ];
    let canonicalHome: string | undefined;
    for (const [index, path] of components.entries()) {
      let pathStat: Stats;
      try {
        pathStat = await this.#io.lstat(path);
      } catch (error) {
        if (errorCode(error) === "ENOENT" && allowMissing) return false;
        throw this.#normalizeError(
          error,
          "plugin-path-invalid",
          `The Plugins directory component ${path} could not be inspected.`,
        );
      }
      if (pathStat.isSymbolicLink() || !pathStat.isDirectory()) {
        throw new PluginInstallError(
          "plugin-path-invalid",
          `The Plugins directory component ${path} must be a real directory, not a symlink or another file kind.`,
        );
      }
      const canonical = await this.#io.realpath(path);
      if (index === 0) {
        canonicalHome = canonical;
      } else if (canonicalHome === undefined || !isContained(canonicalHome, canonical)) {
        throw new PluginInstallError(
          "plugin-path-invalid",
          `The Plugins directory component ${path} escapes the injected home directory.`,
        );
      }
    }
    return true;
  }

  async #ensurePluginsDirectory(): Promise<DirectoryAnchor> {
    if (this.#useAnchoredOperations) {
      let anchor = await this.#captureDirectoryAnchor(this.#homeDirectory);
      for (const [name, operation] of [
        ["Documents", "ensure-documents"],
        ["Roblox", "ensure-roblox"],
        ["Plugins", "ensure-plugins"],
      ] as const) {
        const childPath = join(anchor.path, name);
        const result = await this.#runAnchored(anchor, { operation: "ensure-directory", name }, operation);
        if (result.snapshot === undefined || result.canonicalPath === undefined) {
          throw new PluginInstallError("plugin-anchoring-unavailable", "The directory anchor returned no identity.");
        }
        anchor = {
          path: childPath,
          canonicalPath: result.canonicalPath,
          snapshot: result.snapshot,
        };
      }
      return anchor;
    }

    const homeStat = await this.#io.lstat(this.#homeDirectory).catch((error: unknown) => {
      throw this.#normalizeError(
        error,
        "plugin-path-invalid",
        "The injected home directory does not exist or cannot be inspected.",
      );
    });
    if (homeStat.isSymbolicLink() || !homeStat.isDirectory()) {
      throw new PluginInstallError("plugin-path-invalid", "The injected home path must be a real directory.");
    }
    for (const path of [
      join(this.#homeDirectory, "Documents"),
      join(this.#homeDirectory, "Documents", "Roblox"),
      this.#pluginsDirectory,
    ]) {
      try {
        await this.#io.mkdir(path);
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw this.#normalizeError(error);
      }
      const pathStat = await this.#io.lstat(path).catch((error: unknown) => {
        throw this.#normalizeError(error, "plugin-path-invalid", `Directory creation could not verify ${path}.`);
      });
      if (pathStat.isSymbolicLink() || !pathStat.isDirectory()) {
        throw new PluginInstallError(
          "plugin-path-invalid",
          `The Plugins directory component ${path} is not a real directory.`,
        );
      }
    }
    await this.#validateDirectoryComponents(false);
    return this.#captureDirectoryAnchor(this.#pluginsDirectory);
  }

  async #captureDirectoryAnchor(path: string): Promise<DirectoryAnchor> {
    const pathStat = await this.#io.lstat(path).catch((error: unknown) => {
      throw this.#normalizeError(error, "plugin-path-invalid", `The directory anchor ${path} could not be inspected.`);
    });
    if (pathStat.isSymbolicLink() || !pathStat.isDirectory()) {
      throw new PluginInstallError("plugin-path-invalid", `The directory anchor ${path} must be a real directory.`);
    }
    const handle = await this.#io.open(path, constants.O_RDONLY | directoryFlag | noFollow).catch((error: unknown) => {
      throw this.#normalizeError(error, "plugin-path-invalid", `The directory anchor ${path} could not be opened.`);
    });
    try {
      const opened = await handle.stat();
      if (!opened.isDirectory() || !sameIdentity(pathStat, opened)) {
        throw new PluginInstallError("plugin-path-invalid", `The directory anchor ${path} changed while opening.`);
      }
      return {
        path,
        canonicalPath: await this.#io.realpath(path),
        snapshot: snapshot(opened),
      };
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  async #runAnchored(
    anchor: DirectoryAnchor,
    request: Readonly<Record<string, unknown>>,
    boundary?: AnchoredDirectoryOperation,
    input?: Buffer,
  ): Promise<AnchoredResult> {
    if (boundary !== undefined) await this.#beforeAnchoredDirectoryOperation?.(boundary);
    if (process.platform === "win32") {
      throw new PluginInstallError(
        "plugin-anchoring-unavailable",
        "Audited Studio plugin installation currently requires the macOS/Linux anchored helper.",
      );
    }
    // Node exposes no openat/linkat/renameat API. On macOS/Linux the helper's
    // cwd is an OS-retained directory vnode: it verifies that vnode's dev/ino
    // before any synchronous relative mutation. A pre-spawn ancestor swap
    // fails identity validation; a post-spawn swap cannot retarget the cwd.
    const serializedRequest = JSON.stringify({ ...request, anchor });
    const requestBytes = Buffer.byteLength(serializedRequest);
    const inputBytes = input?.byteLength ?? 0;
    if (
      requestBytes > STUDIO_PLUGIN_INSTALL_LIMITS.maxHelperRequestBytes ||
      inputBytes > STUDIO_PLUGIN_INSTALL_LIMITS.maxHelperStdinBytes ||
      requestBytes + inputBytes > STUDIO_PLUGIN_INSTALL_LIMITS.maxHelperTotalPayloadBytes
    ) {
      throw new PluginInstallError(
        "plugin-helper-payload-too-large",
        "The anchored helper request exceeds its bounded input limit; no helper was started.",
      );
    }
    const runDefault = (): AnchoredHelperProcessResult => {
      const child = spawnSync(process.execPath, ["--eval", anchoredHelperSource], {
        cwd: anchor.path,
        input,
        encoding: "utf8",
        timeout: 30_000,
        maxBuffer: 256 * 1024,
        env: {
          ELECTRON_RUN_AS_NODE: "1",
          [anchoredHelperRequestEnvironment]: serializedRequest,
        },
      });
      return {
        stdout: child.stdout ?? "",
        stderr: child.stderr ?? "",
        status: child.status,
        signal: child.signal,
        ...(child.error === undefined ? {} : { error: child.error }),
      };
    };
    const operation = typeof request.operation === "string" ? request.operation : "unknown";
    const child = this.#anchoredHelperRunnerForTesting?.(operation, runDefault) ?? runDefault();
    if (operation === "commit" && (child.error !== undefined || child.signal !== null)) {
      throw new PluginInstallError(
        "plugin-commit-indeterminate",
        "The commit helper did not exit normally after dispatch. Reinspect before retrying; installation status was not inferred.",
        { cause: child.error },
      );
    }
    let response: unknown;
    try {
      response = JSON.parse(child.stdout);
    } catch (error) {
      if (operation === "commit") {
        throw new PluginInstallError(
          "plugin-commit-indeterminate",
          "The commit helper outcome is indeterminate after dispatch. Reinspect before retrying; installation status was not inferred.",
          { cause: child.error ?? error },
        );
      }
      if (child.error !== undefined) {
        throw new PluginInstallError(
          "plugin-anchoring-unavailable",
          `The anchored filesystem helper could not be started: ${child.error.message}`,
          { cause: child.error },
        );
      }
      throw new PluginInstallError(
        "plugin-anchoring-unavailable",
        "The anchored filesystem helper returned an invalid response.",
        { cause: error },
      );
    }
    if (!isAnchoredHelperResponse(response)) {
      if (operation === "commit") {
        throw new PluginInstallError(
          "plugin-commit-indeterminate",
          "The commit helper returned an incomplete outcome after dispatch. Reinspect before retrying; installation status was not inferred.",
        );
      }
      throw new PluginInstallError(
        "plugin-anchoring-unavailable",
        "The anchored filesystem helper returned an incomplete response.",
      );
    }
    if (!response.ok) {
      if (response.code === "EACCES" || response.code === "EPERM") {
        throw this.#normalizeError(Object.assign(new Error(response.message), { code: response.code }));
      }
      if (isPluginInstallErrorCode(response.code)) {
        throw new PluginInstallError(response.code, response.message);
      }
      throw Object.assign(new Error(response.message), { code: response.code });
    }
    if (
      operation === "commit" &&
      (response.snapshot === undefined ||
        response.sha256 !== request.finalSha256 ||
        response.snapshot.size !== request.finalSize)
    ) {
      throw new PluginInstallError(
        "plugin-commit-indeterminate",
        "The commit helper returned an invalid success payload after dispatch. Reinspect before retrying; installation status was not inferred.",
      );
    }
    return {
      ...(response.snapshot === undefined ? {} : { snapshot: response.snapshot }),
      ...(response.sha256 === undefined ? {} : { sha256: response.sha256 }),
      ...(response.canonicalPath === undefined ? {} : { canonicalPath: response.canonicalPath }),
      ...(response.partials === undefined ? {} : { partials: response.partials }),
    };
  }

  async #commitAnchored(
    anchor: DirectoryAnchor,
    temporary: OwnedPath,
    destination: AuditedFile | undefined,
  ): Promise<AuditedFile> {
    const mode = destination === undefined ? "missing" : "replacement";
    const result = await this.#runAnchored(
      anchor,
      {
        operation: "commit",
        mode,
        temporaryName: basename(temporary.path),
        temporary: {
          snapshot: temporary.snapshot,
          sha256: AUDITED_STUDIO_PLUGIN.sha256,
        },
        destinationName: AUDITED_STUDIO_PLUGIN.fileName,
        ...(destination === undefined
          ? {}
          : {
              destination: {
                snapshot: destination.snapshot,
                sha256: destination.sha256,
              },
            }),
        inspectorName: AUDITED_STUDIO_PLUGIN.inspectorFileName,
        finalSha256: AUDITED_STUDIO_PLUGIN.sha256,
        finalSize: AUDITED_STUDIO_PLUGIN.size,
      },
      mode === "missing" ? "commit-missing" : "commit-replacement",
    );
    if (result.snapshot === undefined || result.sha256 === undefined) {
      throw new PluginInstallError(
        "plugin-commit-indeterminate",
        "The anchored commit returned an incomplete success payload. Reinspect before retrying.",
      );
    }
    return {
      bytes: Buffer.alloc(0),
      sha256: result.sha256,
      snapshot: result.snapshot,
    };
  }

  async #assertRetainedPartialBudget(anchor: DirectoryAnchor, incomingBytes: number, incomingCount = 1): Promise<void> {
    const result = await this.#runAnchored(anchor, { operation: "inventory-partials" });
    const partials = result.partials;
    if (partials === undefined) {
      throw new PluginInstallError(
        "plugin-anchoring-unavailable",
        "The anchored helper returned no retained-partial inventory.",
      );
    }
    if (
      partials.count + incomingCount <= STUDIO_PLUGIN_INSTALL_LIMITS.maxRetainedPartialCount &&
      partials.bytes + incomingBytes <= STUDIO_PLUGIN_INSTALL_LIMITS.maxRetainedPartialBytes
    ) {
      return;
    }
    const retainedNames = partials.names.length === 0 ? "(none reported)" : partials.names.join(", ");
    throw new PluginInstallError(
      "plugin-retained-partial-limit",
      `Retained installer staging is capped at 4 files and 24 MiB. Retained basenames: ${retainedNames}. Use Show Plugins folder and manually remove only reviewed installer staging files before retrying.`,
    );
  }

  async #promoteBackup(
    anchor: DirectoryAnchor,
    partial: OwnedPath,
    backupPath: string,
    sha256: string,
  ): Promise<OwnedPath> {
    const result = await this.#runAnchored(anchor, {
      operation: "promote-backup",
      partialName: basename(partial.path),
      partial: { snapshot: partial.snapshot, sha256 },
      backupName: basename(backupPath),
    });
    if (result.snapshot === undefined || result.sha256 !== sha256) {
      throw new PluginInstallError(
        "plugin-install-io-failed",
        "The verified backup could not be promoted to its intentional backup name.",
      );
    }
    return { path: backupPath, snapshot: result.snapshot };
  }

  async #assertInspectorAbsent(): Promise<void> {
    try {
      await this.#io.lstat(this.#inspectorPath);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return;
      throw this.#normalizeError(error);
    }
    throw new PluginInstallError(
      "plugin-inspector-conflict",
      "MCPInspectorPlugin.rbxmx conflicts with the supported main plugin.",
    );
  }

  async #assertDestinationAbsent(): Promise<void> {
    try {
      await this.#io.lstat(this.#destinationPath);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return;
      throw this.#normalizeError(error);
    }
    throw new PluginInstallError(
      "plugin-destination-changed",
      "The Studio plugin destination appeared before the exclusive commit.",
    );
  }

  async #writeExclusiveVerified(
    path: string,
    bytes: Buffer,
    expectedSha256: string,
    kind: "backup" | "temporary",
    anchor: DirectoryAnchor,
  ): Promise<OwnedPath> {
    if (this.#useAnchoredOperations) {
      try {
        const result = await this.#runAnchored(
          anchor,
          {
            operation: "write-exclusive",
            name: basename(path),
            kind,
            expectedSha256,
            syncDirectory: kind === "backup",
          },
          kind === "backup" ? "write-backup" : "write-temporary",
          bytes,
        );
        if (result.snapshot === undefined || result.sha256 !== expectedSha256) {
          throw new PluginInstallError(
            kind === "temporary" ? "plugin-temporary-verification-failed" : "plugin-install-io-failed",
            `The anchored ${kind} returned no verified identity.`,
          );
        }
        return { path, snapshot: result.snapshot };
      } catch (error) {
        if (kind === "backup" && errorCode(error) === "EEXIST") {
          throw new PluginInstallError(
            "plugin-backup-collision",
            `The backup path ${path} already exists; it was not overwritten.`,
            { cause: error },
          );
        }
        throw this.#normalizeError(error);
      }
    }

    let handle: PluginInstallerFileHandle;
    try {
      handle = await this.#io.open(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | noFollow, 0o600);
    } catch (error) {
      if (kind === "backup" && errorCode(error) === "EEXIST") {
        throw new PluginInstallError(
          "plugin-backup-collision",
          `The backup path ${path} already exists; it was not overwritten.`,
          { cause: error },
        );
      }
      throw this.#normalizeError(error);
    }

    let owned: OwnedPath | undefined;
    try {
      const created = await handle.stat();
      if (!created.isFile()) {
        throw new PluginInstallError("plugin-install-io-failed", `The owned ${kind} path is not a regular file.`);
      }
      owned = { path, snapshot: snapshot(created) };
      await writeAll(handle, bytes);
      await handle.sync();
      const verified = await this.#verifyOwnedHandle(path, handle, owned.snapshot);
      if (verified.sha256 !== expectedSha256 || verified.snapshot.size !== bytes.length) {
        throw new PluginInstallError(
          kind === "temporary" ? "plugin-temporary-verification-failed" : "plugin-install-io-failed",
          `The ${kind} file failed retained-descriptor digest verification.`,
        );
      }
      return owned;
    } catch (error) {
      await handle.close().catch(() => undefined);
      if (owned !== undefined) await this.#cleanupOwned(owned);
      if (error instanceof PluginInstallError) throw error;
      throw this.#normalizeError(error);
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  async #verifyOwnedHandle(
    path: string,
    handle: PluginInstallerFileHandle,
    created: FileSnapshot,
  ): Promise<AuditedFile> {
    const before = await handle.stat();
    const pathStat = await this.#io.lstat(path);
    if (
      !before.isFile() ||
      pathStat.isSymbolicLink() ||
      !pathStat.isFile() ||
      !sameIdentitySnapshot(created, snapshot(before)) ||
      !sameIdentitySnapshot(created, snapshot(pathStat))
    ) {
      throw new PluginInstallError(
        "plugin-temporary-verification-failed",
        "The owned install file identity changed before verification.",
      );
    }
    const bytes = await readExact(handle, before.size);
    const after = await handle.stat();
    const afterPath = await this.#io.lstat(path);
    if (!sameSnapshot(snapshot(before), snapshot(after)) || !sameSnapshot(snapshot(before), snapshot(afterPath))) {
      throw new PluginInstallError(
        "plugin-temporary-verification-failed",
        "The owned install file changed during retained-descriptor verification.",
      );
    }
    return {
      bytes,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      snapshot: snapshot(after),
    };
  }

  async #assertTemporaryReady(owned: OwnedPath): Promise<void> {
    await this.#assertOwnedFileReady(
      owned,
      AUDITED_STUDIO_PLUGIN.size,
      AUDITED_STUDIO_PLUGIN.sha256,
      "plugin-temporary-verification-failed",
      "The exact owned temporary file changed before commit.",
    );
  }

  async #assertOwnedFileReady(
    owned: OwnedPath,
    expectedSize: number,
    expectedSha256: string,
    code: PluginInstallErrorCode,
    message: string,
  ): Promise<void> {
    let audit: AuditedFile;
    try {
      audit = await this.#auditRegularFile(owned.path, "destination");
    } catch (error) {
      throw new PluginInstallError(code, message, { cause: error });
    }
    if (
      !sameIdentitySnapshot(owned.snapshot, audit.snapshot) ||
      audit.snapshot.size !== expectedSize ||
      audit.sha256 !== expectedSha256
    ) {
      throw new PluginInstallError(code, message);
    }
  }

  async #syncDirectory(afterCommit: boolean, anchor: DirectoryAnchor): Promise<void> {
    if (this.#useAnchoredOperations) {
      await this.#runAnchored(anchor, { operation: "sync-directory" });
      return;
    }
    const pathStat = await this.#io.lstat(this.#pluginsDirectory);
    if (pathStat.isSymbolicLink() || !pathStat.isDirectory()) {
      throw new PluginInstallError("plugin-path-invalid", "The Plugins directory changed before fsync.");
    }
    const handle = await this.#io.open(this.#pluginsDirectory, constants.O_RDONLY | directoryFlag | noFollow);
    try {
      const opened = await handle.stat();
      if (!opened.isDirectory() || !sameIdentity(pathStat, opened)) {
        throw new PluginInstallError("plugin-path-invalid", "The Plugins directory identity changed before fsync.");
      }
      await handle.sync();
    } catch (error) {
      if (afterCommit) throw error;
      throw this.#normalizeError(error);
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  async #cleanupOwned(owned: OwnedPath): Promise<void> {
    await this.#ownedPathStillMatches(owned);
    // Node exposes pathname unlink but not unlinkat with an inode condition.
    // Even after lstat, a same-user replacement can win the final window.
    // Retaining a random owned partial is safer than deleting an unverified path.
  }

  async #ownedPathStillMatches(owned: OwnedPath): Promise<boolean> {
    try {
      const current = await this.#io.lstat(owned.path);
      return current.isFile() && !current.isSymbolicLink() && sameIdentitySnapshot(owned.snapshot, snapshot(current));
    } catch {
      return false;
    }
  }

  #normalizeError(
    error: unknown,
    fallbackCode: PluginInstallErrorCode = "plugin-install-io-failed",
    fallbackMessage = "The Studio plugin filesystem operation failed.",
  ): PluginInstallError {
    if (error instanceof PluginInstallError) return error;
    if (errorCode(error) === "EACCES" || errorCode(error) === "EPERM") {
      return new PluginInstallError(
        "plugin-permission-denied",
        "Permission was denied while inspecting or updating the Roblox Plugins folder.",
        { cause: error },
      );
    }
    return new PluginInstallError(fallbackCode, fallbackMessage, { cause: error });
  }
}

type AnchoredHelperResponse =
  | {
      readonly ok: true;
      readonly snapshot?: FileSnapshot;
      readonly sha256?: string;
      readonly canonicalPath?: string;
      readonly partials?: {
        readonly count: number;
        readonly bytes: number;
        readonly names: readonly string[];
      };
    }
  | {
      readonly ok: false;
      readonly code: string;
      readonly message: string;
    };

function isAnchoredHelperResponse(value: unknown): value is AnchoredHelperResponse {
  if (typeof value !== "object" || value === null || !("ok" in value) || typeof value.ok !== "boolean") return false;
  if (!value.ok) {
    return "code" in value && typeof value.code === "string" && "message" in value && typeof value.message === "string";
  }
  return (
    (!("sha256" in value) || typeof value.sha256 === "string") &&
    (!("canonicalPath" in value) || typeof value.canonicalPath === "string") &&
    (!("snapshot" in value) || isFileSnapshot(value.snapshot)) &&
    (!("partials" in value) || isPartialInventory(value.partials))
  );
}

function isPartialInventory(value: unknown): value is {
  readonly count: number;
  readonly bytes: number;
  readonly names: readonly string[];
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "count" in value &&
    typeof value.count === "number" &&
    Number.isSafeInteger(value.count) &&
    value.count >= 0 &&
    "bytes" in value &&
    typeof value.bytes === "number" &&
    Number.isSafeInteger(value.bytes) &&
    value.bytes >= 0 &&
    "names" in value &&
    Array.isArray(value.names) &&
    value.names.every((name) => typeof name === "string" && ownedPartialBasenamePattern.test(name))
  );
}

const ownedPartialBasenamePattern = /^\.MCPPlugin\.rbxmx\.(?:tmp|backup-partial)-[0-9a-f]{24}$/;

function isFileSnapshot(value: unknown): value is FileSnapshot {
  return (
    typeof value === "object" &&
    value !== null &&
    "dev" in value &&
    typeof value.dev === "string" &&
    "ino" in value &&
    typeof value.ino === "string" &&
    "mode" in value &&
    typeof value.mode === "number" &&
    "size" in value &&
    typeof value.size === "number" &&
    "mtimeMs" in value &&
    typeof value.mtimeMs === "number" &&
    "ctimeMs" in value &&
    typeof value.ctimeMs === "number"
  );
}

function isPluginInstallErrorCode(value: string): value is PluginInstallErrorCode {
  return [
    "plugin-anchoring-unavailable",
    "plugin-backup-collision",
    "plugin-commit-indeterminate",
    "plugin-destination-changed",
    "plugin-destination-invalid",
    "plugin-final-verification-failed",
    "plugin-file-too-large",
    "plugin-helper-payload-too-large",
    "plugin-inspector-conflict",
    "plugin-install-io-failed",
    "plugin-path-invalid",
    "plugin-permission-denied",
    "plugin-replace-confirmation-required",
    "plugin-retained-partial-limit",
    "plugin-source-changed",
    "plugin-source-invalid",
    "plugin-temporary-verification-failed",
  ].includes(value);
}

function snapshot(value: Stats): FileSnapshot {
  return {
    dev: String(value.dev),
    ino: String(value.ino),
    mode: value.mode,
    size: value.size,
    mtimeMs: value.mtimeMs,
    ctimeMs: value.ctimeMs,
  };
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameIdentitySnapshot(left: FileSnapshot, right: FileSnapshot): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameSnapshot(left: FileSnapshot, right: FileSnapshot): boolean {
  return (
    sameIdentitySnapshot(left, right) &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function sameAudit(left: AuditedFile, right: AuditedFile): boolean {
  return left.sha256 === right.sha256 && sameSnapshot(left.snapshot, right.snapshot);
}

function isContained(canonicalHome: string, canonicalPath: string): boolean {
  const pathFromHome = relative(canonicalHome, canonicalPath);
  return pathFromHome === "" || (!pathFromHome.startsWith("..") && !isAbsolute(pathFromHome));
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

async function readExact(handle: PluginInstallerFileHandle, size: number): Promise<Buffer> {
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < bytes.length) {
    const result = await handle.read(bytes, offset, bytes.length - offset, offset);
    if (result.bytesRead === 0) {
      throw new Error("Unexpected end of file during retained-handle audit.");
    }
    offset += result.bytesRead;
  }
  return bytes;
}

async function writeAll(handle: PluginInstallerFileHandle, bytes: Buffer): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    const result = await handle.write(bytes, offset, bytes.length - offset, offset);
    if (result.bytesWritten === 0) throw new Error("The filesystem accepted a zero-byte write.");
    offset += result.bytesWritten;
  }
}

function utcTimestamp(value: number): string {
  const date = new Date(value);
  const digits = [
    date.getUTCFullYear().toString().padStart(4, "0"),
    (date.getUTCMonth() + 1).toString().padStart(2, "0"),
    date.getUTCDate().toString().padStart(2, "0"),
    date.getUTCHours().toString().padStart(2, "0"),
    date.getUTCMinutes().toString().padStart(2, "0"),
    date.getUTCSeconds().toString().padStart(2, "0"),
  ];
  return `${digits[0]}${digits[1]}${digits[2]}-${digits[3]}${digits[4]}${digits[5]}`;
}

function withInstallLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = installLocks.get(key) ?? Promise.resolve();
  const result = previous.then(operation, operation);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  installLocks.set(key, tail);
  return result.finally(() => {
    if (installLocks.get(key) === tail) installLocks.delete(key);
  });
}
