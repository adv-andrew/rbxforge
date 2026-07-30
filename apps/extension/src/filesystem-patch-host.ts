import { createHash, randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type {
  IgnorePolicyAttestation,
  IgnorePolicyPort,
  ImmutableApprovalProposal,
  OpaqueWriteAuthorization,
  PreparedWrite,
  ToolContext,
  ToolReceipt,
} from "@rbxforge/agent";
import { InMemoryApprovalBroker, isSensitivePath } from "@rbxforge/agent";
import type { MutationJournal } from "@rbxforge/core";

import type {
  DisposablePort,
  DocumentSnapshotPort,
  RangePort,
  WorkspaceEditSubmissionPort,
  WorkspaceEditSubmissionResultPort,
  WorkspaceTextEditPort,
} from "./vscode-facade.js";

export const FILE_PATCH_LIMITS = Object.freeze({
  files: 8,
  edits: 64,
  replacementBytes: 256 * 1024,
  proposals: 16,
  proposalLifetimeMs: 60_000,
});

export interface StructuredTextEdit {
  readonly range: RangePort;
  readonly newText: string;
}

export interface FilesystemPatchFile {
  readonly path: string;
  readonly expectedVersion: number;
  readonly expectedSha256: string;
  readonly edits: readonly StructuredTextEdit[];
}

export interface FilesystemPatchSpec {
  readonly files: readonly FilesystemPatchFile[];
}

export interface FilesystemPatchFacade {
  documentSnapshot(path: string): Promise<DocumentSnapshotPort | undefined>;
  registerVirtualTextDocumentProvider(scheme: string, provide: (uri: string) => string | undefined): DisposablePort;
  openDiff(leftPath: string, rightUri: string, title: string): Promise<void>;
  applyWorkspaceEdit(submission: WorkspaceEditSubmissionPort): WorkspaceEditSubmissionResultPort;
}

export interface FilesystemPatchHostOptions {
  readonly vscode: FilesystemPatchFacade;
  readonly journal: MutationJournal;
  readonly approvalBroker: InMemoryApprovalBroker;
  readonly workspaceRoot: () => Promise<string | undefined>;
  readonly now?: () => number;
  readonly randomId?: () => string;
  readonly ignorePolicy?: IgnorePolicyPort;
  readonly limits?: Partial<typeof FILE_PATCH_LIMITS>;
}

interface PreparedFile {
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly expectedUri: string;
  readonly expectedVersion: number;
  readonly expectedSha256: string;
  readonly expectedDevice: string;
  readonly expectedInode: string;
  readonly beforeSha256: string;
  readonly afterSha256: string;
  readonly afterText: string;
  readonly edits: readonly StructuredTextEdit[];
}

interface StoredPatch {
  readonly prepared: PreparedWrite;
  readonly root: string;
  readonly files: readonly PreparedFile[];
  readonly virtualUris: readonly string[];
  readonly expiryTimer: ReturnType<typeof setTimeout>;
  readonly context: Readonly<{ sessionId: string; generation: number; runId: string }>;
}

const SHA256 = /^[a-f0-9]{64}$/u;

export class FilesystemPatchHost implements DisposablePort {
  readonly #vscode: FilesystemPatchFacade;
  readonly #journal: MutationJournal;
  readonly #approvalBroker: InMemoryApprovalBroker;
  readonly #workspaceRoot: () => Promise<string | undefined>;
  readonly #now: () => number;
  readonly #randomId: () => string;
  readonly #ignorePolicy: IgnorePolicyPort;
  readonly #limits: typeof FILE_PATCH_LIMITS;
  readonly #patches = new Map<string, StoredPatch>();
  readonly #virtualText = new Map<string, string>();
  readonly #virtualProvider: DisposablePort;
  #disposed = false;

  constructor(options: FilesystemPatchHostOptions) {
    this.#vscode = options.vscode;
    this.#journal = options.journal;
    this.#approvalBroker = options.approvalBroker;
    this.#workspaceRoot = options.workspaceRoot;
    this.#now = options.now ?? Date.now;
    this.#randomId = options.randomId ?? randomUUID;
    this.#ignorePolicy = options.ignorePolicy ?? failClosedIgnorePolicy();
    this.#limits = Object.freeze({ ...FILE_PATCH_LIMITS, ...options.limits });
    this.#virtualProvider = this.#vscode.registerVirtualTextDocumentProvider("rbxforge-diff", (uri) =>
      this.#virtualText.get(uri),
    );
  }

  async prepare(spec: FilesystemPatchSpec, context: ToolContext): Promise<PreparedWrite> {
    this.#assertLive();
    throwIfAborted(context.signal);
    this.#discardExpired();
    if (this.#patches.size >= this.#limits.proposals) {
      throw new Error("Filesystem patch proposal capacity was reached");
    }
    if (spec.files.length === 0 || spec.files.length > this.#limits.files) {
      throw new Error("Filesystem patch file count is outside the bounded limit");
    }
    const selectedRoot = await this.#workspaceRoot();
    if (selectedRoot === undefined) throw new Error("A single workspace boundary is required");
    const root = await realpath(selectedRoot);
    const paths = new Set<string>();
    let editCount = 0;
    let replacementBytes = 0;
    const files: PreparedFile[] = [];
    for (const file of spec.files) {
      throwIfAborted(context.signal);
      validateRelativePath(file.path);
      const requested = resolve(root, file.path);
      if (!within(root, requested)) throw new Error("Filesystem patch target is outside the workspace boundary");
      if (isSensitivePath(requested)) throw new Error("Filesystem patch target is sensitive");
      let absolutePath: string;
      try {
        absolutePath = await realpath(requested);
      } catch {
        throw new Error("Filesystem patch targets existing files only");
      }
      if (!within(root, absolutePath)) throw new Error("Filesystem patch target escapes the workspace boundary");
      if (paths.has(absolutePath)) throw new Error("Filesystem patch contains a duplicate target");
      paths.add(absolutePath);
      if (isSensitivePath(absolutePath)) throw new Error("Filesystem patch target is sensitive");
      await this.#assertNotIgnored([absolutePath], context.signal, "Filesystem patch target is ignored");
      const fileInfo = await stat(absolutePath, { bigint: true });
      if (!fileInfo.isFile()) throw new Error("Filesystem patch targets existing files only");
      if (!Number.isSafeInteger(file.expectedVersion) || file.expectedVersion < 0) {
        throw new Error("Filesystem patch expected version is invalid");
      }
      if (!SHA256.test(file.expectedSha256)) throw new Error("Filesystem patch expected hash is invalid");
      if (file.edits.length === 0) throw new Error("Filesystem patch needs at least one edit");
      editCount += file.edits.length;
      replacementBytes += file.edits.reduce((sum, edit) => sum + Buffer.byteLength(edit.newText), 0);
      if (editCount > this.#limits.edits || replacementBytes > this.#limits.replacementBytes) {
        throw new Error("Filesystem patch exceeds the bounded edit limit");
      }
      const snapshot = await this.#vscode.documentSnapshot(absolutePath);
      if (snapshot === undefined) throw new Error("Filesystem patch document is unavailable");
      assertSnapshot(snapshot, file.expectedVersion, file.expectedSha256);
      const afterText = applyToText(snapshot.text, file.edits);
      files.push(
        Object.freeze({
          relativePath: normalizeRelative(root, absolutePath),
          absolutePath,
          expectedUri: snapshot.uri,
          expectedVersion: file.expectedVersion,
          expectedSha256: file.expectedSha256,
          expectedDevice: fileInfo.dev.toString(),
          expectedInode: fileInfo.ino.toString(),
          beforeSha256: sha256(snapshot.text),
          afterSha256: sha256(afterText),
          afterText,
          edits: Object.freeze(
            file.edits.map((edit) =>
              Object.freeze({
                range: freezeRange(edit.range),
                newText: edit.newText,
              }),
            ),
          ),
        }),
      );
    }
    const preparedId = this.#uniqueId();
    const approvalId = this.#uniqueId(new Set([preparedId]));
    const proposal: ImmutableApprovalProposal = Object.freeze({
      approvalId,
      preparedId,
      sessionId: context.sessionId,
      generation: context.generation,
      runId: context.runId,
      kind: "filesystem",
      summary: `Edit ${files.length} existing file${files.length === 1 ? "" : "s"} (${editCount} text edit${editCount === 1 ? "" : "s"})`,
      expiresAt: this.#now() + this.#limits.proposalLifetimeMs,
    });
    const prepared = Object.freeze({ id: preparedId, proposal });
    const virtualUris = Object.freeze(
      files.map((file, index) => {
        const uri = `rbxforge-diff:/${preparedId}/${index}`;
        this.#virtualText.set(uri, file.afterText);
        return uri;
      }),
    );
    const expiryTimer = setTimeout(() => this.#discard(preparedId), Math.max(0, proposal.expiresAt - this.#now()));
    expiryTimer.unref?.();
    this.#patches.set(
      preparedId,
      Object.freeze({
        prepared,
        root,
        files: Object.freeze(files),
        virtualUris,
        expiryTimer,
        context: Object.freeze({
          sessionId: context.sessionId,
          generation: context.generation,
          runId: context.runId,
        }),
      }),
    );
    return prepared;
  }

  async preview(preparedId: string): Promise<void> {
    this.#assertLive();
    const stored = this.#required(preparedId);
    for (const [index, file] of stored.files.entries()) {
      await this.#vscode.openDiff(
        file.absolutePath,
        stored.virtualUris[index]!,
        `RbxForge proposed edit: ${file.relativePath}`,
      );
    }
  }

  async previewApproval(approvalId: string): Promise<boolean> {
    const stored = [...this.#patches.values()].find((patch) => patch.prepared.proposal.approvalId === approvalId);
    if (stored === undefined) return false;
    await this.preview(stored.prepared.id);
    return true;
  }

  async execute(
    preparedId: string,
    authorization: OpaqueWriteAuthorization,
    context: ToolContext,
  ): Promise<ToolReceipt> {
    this.#assertLive();
    const stored = this.#required(preparedId);
    assertContext(stored, context);
    if (stored.prepared.proposal.expiresAt <= this.#now()) {
      this.#discard(preparedId);
      throw new Error("Filesystem patch approval expired");
    }
    throwIfAborted(context.signal);
    const edits: WorkspaceTextEditPort[] = [];
    for (const file of stored.files) {
      const canonical = await realpath(file.absolutePath);
      if (isSensitivePath(canonical)) {
        throw new Error("Filesystem patch target became sensitive before apply");
      }
      if (canonical !== file.absolutePath || !within(stored.root, canonical)) {
        throw new Error("Filesystem patch target changed before apply");
      }
      await this.#assertNotIgnored([canonical], context.signal, "Filesystem patch target became ignored before apply");
      if (!(await stat(canonical)).isFile()) {
        throw new Error("Filesystem patch target changed before apply");
      }
      const snapshot = await this.#vscode.documentSnapshot(file.absolutePath);
      if (snapshot === undefined) throw new Error("Filesystem patch document changed before apply");
      assertSnapshot(snapshot, file.expectedVersion, file.expectedSha256, "changed before apply");
      edits.push(
        ...file.edits.map((edit) => ({
          path: file.absolutePath,
          range: edit.range,
          newText: edit.newText,
        })),
      );
    }
    throwIfAborted(context.signal);
    let finalStates: readonly Readonly<{
      canonical: string;
      isFile: boolean;
      snapshot: DocumentSnapshotPort | undefined;
    }>[];
    try {
      finalStates = await Promise.all(
        stored.files.map(async (file) => {
          const [canonical, info, snapshot] = await Promise.all([
            realpath(file.absolutePath),
            stat(file.absolutePath),
            this.#vscode.documentSnapshot(file.absolutePath),
          ]);
          return Object.freeze({
            canonical,
            isFile: info.isFile(),
            snapshot,
          });
        }),
      );
    } catch {
      throw new Error("Filesystem patch target changed before apply");
    }
    throwIfAborted(context.signal);
    for (const [index, file] of stored.files.entries()) {
      const final = finalStates[index];
      if (final === undefined) throw new Error("Filesystem patch target changed before apply");
      if (isSensitivePath(final.canonical)) {
        throw new Error("Filesystem patch target became sensitive before apply");
      }
      if (final.canonical !== file.absolutePath || !within(stored.root, final.canonical)) {
        throw new Error("Filesystem patch target changed before apply");
      }
      if (!final.isFile || final.snapshot === undefined || final.snapshot.path !== file.absolutePath) {
        throw new Error("Filesystem patch target changed before apply");
      }
      assertSnapshot(final.snapshot, file.expectedVersion, file.expectedSha256, "changed before apply");
    }
    let policyEvaluation: Readonly<{
      readonly attestation: IgnorePolicyAttestation;
      readonly results: readonly Readonly<{ path: string; ignored: boolean }>[];
    }>;
    try {
      policyEvaluation = await this.#ignorePolicy.evaluate(
        stored.files.map((file) => file.absolutePath),
        context.signal,
      );
    } catch (error: unknown) {
      if (context.signal.aborted) throw error;
      throw new Error("Filesystem patch target became ignored before apply");
    }
    if (
      policyEvaluation.results.length !== stored.files.length ||
      policyEvaluation.results.some(
        (result, index) => result.path !== stored.files[index]?.absolutePath || result.ignored,
      ) ||
      !this.#ignorePolicy.isCurrent(policyEvaluation.attestation)
    ) {
      throw new Error("Filesystem patch target became ignored before apply");
    }
    // The facade owns the true side-effect boundary. It prebuilds the complete
    // WorkspaceEdit, synchronously rechecks the already-open documents and
    // target identities, invokes this one-shot callback, and calls
    // workspace.applyEdit in the same stack without yielding.
    let authorizationChecked = false;
    let authorizationConsumed = false;
    let submitted = false;
    let applyThrew = false;
    let submission: WorkspaceEditSubmissionResultPort | undefined;
    try {
      submission = this.#vscode.applyWorkspaceEdit({
        edits,
        files: stored.files.map((file) =>
          Object.freeze({
            path: file.absolutePath,
            expectedUri: file.expectedUri,
            canonicalPath: file.absolutePath,
            workspaceRoot: stored.root,
            expectedVersion: file.expectedVersion,
            expectedSha256: file.expectedSha256,
            expectedDevice: file.expectedDevice,
            expectedInode: file.expectedInode,
          }),
        ),
        signal: context.signal,
        ignorePolicyAttestation: policyEvaluation.attestation,
        isIgnorePolicyCurrent: (attestation) =>
          policyEvaluation.results.length === stored.files.length &&
          policyEvaluation.results.every(
            (result, index) => result.path === stored.files[index]?.absolutePath && !result.ignored,
          ) &&
          this.#ignorePolicy.isCurrent(attestation),
        authorize: () => {
          authorizationChecked = true;
          if (context.signal.aborted) return false;
          authorizationConsumed = this.#approvalBroker.consumeAuthorization(authorization, stored.prepared.proposal);
          return authorizationConsumed;
        },
      });
    } catch {
      applyThrew = true;
    }
    if (!authorizationConsumed) {
      if (context.signal.aborted) {
        throw context.signal.reason ?? new Error("Filesystem patch aborted");
      }
      if (authorizationChecked) {
        this.#discard(preparedId);
        throw new Error("Filesystem patch authorization is unknown, stale, or already used");
      }
      throw new Error("Filesystem patch target changed before apply");
    }
    if (submission?.attempted === true) {
      try {
        submitted = await submission.completion;
      } catch {
        applyThrew = true;
      }
    }
    let verified = true;
    for (const file of stored.files) {
      const after = await this.#vscode.documentSnapshot(file.absolutePath);
      if (after === undefined || sha256(after.text) !== file.afterSha256) verified = false;
    }
    this.#journal.append({
      id: this.#uniqueId(),
      timestamp: new Date(this.#now()).toISOString(),
      kind: "filesystem",
      operation: "file-edit",
      target: stored.files.map((file) => file.relativePath).join(", "),
      before: Object.freeze({
        files: Object.freeze(
          stored.files.map((file) =>
            Object.freeze({
              path: file.relativePath,
              sha256: file.beforeSha256,
              version: file.expectedVersion,
            }),
          ),
        ),
      }),
      requested: Object.freeze({
        files: Object.freeze(
          stored.files.map((file) =>
            Object.freeze({
              path: file.relativePath,
              sha256: file.afterSha256,
              edits: file.edits.length,
            }),
          ),
        ),
      }),
      result: verified ? "applied" : "failed",
      verification: verified ? "verified" : "unverifiable",
      detail: `${stored.files.length} file(s), ${edits.length} edit(s); WorkspaceEdit ${submitted ? "reported success" : applyThrew ? "threw" : "reported failure"}; local bytes reread; Studio synchronization not claimed`,
    });
    this.#discard(preparedId);
    return Object.freeze({
      ok: verified,
      code: verified ? "applied" : applyThrew ? "workspace-edit-failed" : "apply-failed",
      summary: verified
        ? "Local file bytes were applied and reread. Studio synchronization is unverified."
        : "The local edit could not be verified.",
      output: Object.freeze({
        files: stored.files.length,
        edits: edits.length,
        localBytesVerified: verified,
        studioSyncVerified: false,
      }),
      verification: verified ? "verified" : "unverified",
    });
  }

  async #assertNotIgnored(paths: readonly string[], signal: AbortSignal, message: string): Promise<void> {
    let evaluation;
    try {
      evaluation = await this.#ignorePolicy.evaluate(paths, signal);
    } catch (error: unknown) {
      if (signal.aborted) throw error;
      throw new Error(message);
    }
    if (
      evaluation.results.length !== paths.length ||
      evaluation.results.some((result, index) => result.path !== paths[index] || result.ignored) ||
      !this.#ignorePolicy.isCurrent(evaluation.attestation)
    ) {
      throw new Error(message);
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const patch of this.#patches.values()) clearTimeout(patch.expiryTimer);
    this.#patches.clear();
    this.#virtualText.clear();
    this.#virtualProvider.dispose();
  }

  #required(preparedId: string): StoredPatch {
    const stored = this.#patches.get(preparedId);
    if (stored === undefined) throw new Error("Filesystem patch proposal is unknown or already used");
    if (stored.prepared.proposal.expiresAt <= this.#now()) {
      this.#discard(preparedId);
      throw new Error("Filesystem patch proposal is expired");
    }
    return stored;
  }

  #discard(preparedId: string): void {
    const stored = this.#patches.get(preparedId);
    if (stored !== undefined) {
      clearTimeout(stored.expiryTimer);
      for (const uri of stored.virtualUris) this.#virtualText.delete(uri);
      this.#patches.delete(preparedId);
    }
  }

  #discardExpired(): void {
    for (const [preparedId, stored] of this.#patches) {
      if (stored.prepared.proposal.expiresAt <= this.#now()) this.#discard(preparedId);
    }
  }

  #uniqueId(reserved: ReadonlySet<string> = new Set()): string {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const value = this.#randomId();
      if (value.length > 0 && !this.#patches.has(value) && !reserved.has(value)) return value;
    }
    throw new Error("Unable to allocate patch capability");
  }

  #assertLive(): void {
    if (this.#disposed) throw new Error("Filesystem patch host is disposed");
  }
}

function assertContext(stored: StoredPatch, context: ToolContext): void {
  if (
    context.sessionId !== stored.context.sessionId ||
    context.generation !== stored.context.generation ||
    context.runId !== stored.context.runId
  ) {
    throw new Error("Filesystem patch context is stale");
  }
}

function assertSnapshot(
  snapshot: DocumentSnapshotPort,
  expectedVersion: number,
  expectedSha256: string,
  suffix = "does not match expected version/hash",
): void {
  if (snapshot.version !== expectedVersion) throw new Error(`Filesystem patch document ${suffix}`);
  if (sha256(snapshot.text) !== expectedSha256) throw new Error(`Filesystem patch document hash ${suffix}`);
}

function applyToText(text: string, edits: readonly StructuredTextEdit[]): string {
  const ranged = edits
    .map((edit) => {
      const start = offsetAt(text, edit.range.start);
      const end = offsetAt(text, edit.range.end);
      if (end < start) throw new Error("Filesystem patch range is reversed");
      return { edit, start, end };
    })
    .sort((left, right) => left.start - right.start || left.end - right.end);
  for (let index = 1; index < ranged.length; index += 1) {
    if (ranged[index]!.start < ranged[index - 1]!.end) {
      throw new Error("Filesystem patch edits overlap");
    }
  }
  let result = text;
  for (const item of [...ranged].reverse()) {
    result = result.slice(0, item.start) + item.edit.newText + result.slice(item.end);
  }
  return result;
}

function offsetAt(text: string, position: Readonly<{ line: number; character: number }>): number {
  if (
    !Number.isSafeInteger(position.line) ||
    position.line < 0 ||
    !Number.isSafeInteger(position.character) ||
    position.character < 0
  ) {
    throw new Error("Filesystem patch range is invalid");
  }
  const lines = text.split("\n");
  const line = lines[position.line];
  if (line === undefined || position.character > line.length)
    throw new Error("Filesystem patch range is outside the document");
  let offset = 0;
  for (let index = 0; index < position.line; index += 1) offset += lines[index]!.length + 1;
  return offset + position.character;
}

function freezeRange(range: RangePort): RangePort {
  return Object.freeze({
    start: Object.freeze({ ...range.start }),
    end: Object.freeze({ ...range.end }),
  });
}

function validateRelativePath(path: string): void {
  if (
    path.length === 0 ||
    path.length > 4_096 ||
    isAbsolute(path) ||
    path.includes("\0") ||
    /^[a-z][a-z0-9+.-]*:/iu.test(path)
  ) {
    throw new Error("Filesystem patch path is invalid");
  }
}

function normalizeRelative(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

function within(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function failClosedIgnorePolicy(): IgnorePolicyPort {
  const attestation = Object.freeze({});
  return Object.freeze({
    evaluate: async (paths: readonly string[], signal: AbortSignal) => {
      throwIfAborted(signal);
      return Object.freeze({
        results: Object.freeze(
          paths.map((path) =>
            Object.freeze({
              path,
              ignored: true,
            }),
          ),
        ),
        attestation,
      });
    },
    isCurrent: (candidate: IgnorePolicyAttestation) => candidate === attestation,
    dispose: () => undefined,
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new Error("Operation aborted");
}
