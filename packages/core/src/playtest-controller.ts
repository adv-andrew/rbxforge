import type { ActivityEvent, ActivityOperation } from "./activity-store.js";

export type PlayMode = "play" | "run";
export type PlaytestState = "idle" | "starting" | "running" | "stopping" | "unknown";
export type LogCursor = number | Readonly<Record<string, number>>;
export type RuntimeLogLevel = "OUT" | "WARN" | "ERR" | "INFO";

export interface RuntimeLogEntry {
  readonly seq: number;
  readonly ts: number;
  readonly level: RuntimeLogLevel;
  readonly message: string;
  readonly data?: Readonly<Record<string, unknown>>;
  readonly capturedBy?: string;
}

export interface RuntimeLogBatch {
  readonly entries: readonly RuntimeLogEntry[];
  readonly totalDropped: number;
  readonly nextSince?: number;
  readonly perCaptureNextSince: Readonly<Record<string, number>>;
  readonly perCaptureErrors: Readonly<Record<string, string>>;
  readonly capturedBy?: string;
}

export interface ScreenshotResult {
  readonly data: string;
  readonly mimeType: "image/jpeg" | "image/png";
  readonly format: "jpeg" | "png";
  readonly target: "client-1" | "edit" | "auto";
  readonly capturedAt: number;
  readonly width?: number;
  readonly height?: number;
  readonly quality?: number;
  readonly message?: string;
}

export interface PlaytestStartResult {
  readonly success: boolean;
  readonly action: "start";
  readonly message: string;
  readonly roles?: readonly string[];
}

export interface PlaytestStopResult {
  readonly success: boolean;
  readonly action: "stop";
  readonly message: string;
}

export interface PlaytestStatusResult {
  readonly success: boolean;
  readonly action: "status";
  readonly running: boolean;
  readonly roles: readonly string[];
}

export interface PlaytestCapabilityPort {
  start(mode: PlayMode, signal: AbortSignal, onIssued?: () => void): Promise<PlaytestStartResult>;
  stop(signal: AbortSignal): Promise<PlaytestStopResult>;
  status(signal: AbortSignal): Promise<PlaytestStatusResult>;
  logs(cursor: LogCursor | undefined, signal: AbortSignal): Promise<RuntimeLogBatch>;
  screenshot(signal: AbortSignal): Promise<ScreenshotResult>;
}

export interface PlaytestSnapshot {
  readonly instanceId: string;
  readonly status: PlaytestState;
  readonly mode?: PlayMode;
  readonly roles: readonly string[];
  readonly runtimeGeneration: number;
  readonly observedAt: number;
  readonly error?: string;
}

export type InspectionStep<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

export interface InspectionReceipt {
  readonly instanceId: string;
  readonly preExisting: boolean;
  readonly playtest: InspectionStep<"pre-existing" | "started">;
  readonly logs: InspectionStep<RuntimeLogBatch>;
  readonly screenshot: InspectionStep<ScreenshotResult>;
  readonly stop: InspectionStep<"not-required" | "stopped">;
}

export interface PlaytestControllerOptions {
  readonly instanceId: string;
  readonly capability: PlaytestCapabilityPort;
  readonly now?: () => number;
  readonly createId?: () => string;
  readonly operationTimeoutMs?: number;
  readonly cleanupTimeoutMs?: number;
  readonly onActivity?: (event: ActivityEvent) => void;
}

/**
 * Serializes all runtime operations for one captured Studio instance. Selection
 * changes cannot retarget the injected capability port.
 */
export class PlaytestController {
  readonly #instanceId: string;
  readonly #capability: PlaytestCapabilityPort;
  readonly #now: () => number;
  readonly #createId: () => string;
  readonly #operationTimeoutMs: number;
  readonly #cleanupTimeoutMs: number;
  readonly #onActivity: ((event: ActivityEvent) => void) | undefined;
  readonly #listeners = new Set<(snapshot: PlaytestSnapshot) => void>();
  readonly #lifetime = new AbortController();
  readonly #operations = new Set<AbortController>();
  #snapshot: PlaytestSnapshot;
  #tail: Promise<void> = Promise.resolve();
  #disposed = false;
  #epoch = 0;
  #resetAllCursors = false;
  readonly #resetCursorRoles = new Set<string>();

  constructor(options: PlaytestControllerOptions) {
    if (options.instanceId.length === 0) throw new Error("Playtest controller requires an instance ID");
    this.#instanceId = options.instanceId;
    this.#capability = options.capability;
    this.#now = options.now ?? Date.now;
    this.#createId = options.createId ?? (() => globalThis.crypto.randomUUID());
    this.#operationTimeoutMs = boundedDuration(options.operationTimeoutMs ?? 70_000, "operation timeout");
    this.#cleanupTimeoutMs = boundedDuration(options.cleanupTimeoutMs ?? 20_000, "cleanup timeout");
    this.#onActivity = options.onActivity;
    this.#snapshot = freezeSnapshot({
      instanceId: this.#instanceId,
      status: "idle",
      roles: [],
      runtimeGeneration: 0,
      observedAt: this.#now(),
    });
  }

  state(): PlaytestSnapshot {
    return this.#snapshot;
  }

  onDidChange(listener: (snapshot: PlaytestSnapshot) => void): { dispose(): void } {
    this.#listeners.add(listener);
    return { dispose: () => this.#listeners.delete(listener) };
  }

  start(mode: PlayMode, signal: AbortSignal): Promise<void> {
    return this.#enqueue(signal, async (operationSignal, epoch) => {
      if (this.#snapshot.status !== "idle") {
        throw new Error(`Cannot start a playtest from ${this.#snapshot.status}`);
      }
      await this.#startDirect(mode, operationSignal, epoch);
    });
  }

  stop(signal: AbortSignal): Promise<void> {
    return this.#enqueue(signal, async (operationSignal, epoch) => {
      if (this.#snapshot.status === "idle") throw new Error("No playtest is running");
      await this.#stopDirect(operationSignal, epoch);
    });
  }

  refreshStatus(signal: AbortSignal): Promise<void> {
    return this.#enqueue(signal, async (operationSignal, epoch) => {
      try {
        const result = await this.#capability.status(operationSignal);
        this.#assertOperation(epoch, operationSignal);
        requireStatus(result);
        this.#reconcileStatus(result, epoch);
        this.#assertOperation(epoch, operationSignal);
        this.#activity("playtest.status", "success", result.running ? "running" : "idle");
      } catch (error: unknown) {
        if (!this.#isCurrent(epoch)) throw createAbortError();
        this.#uncertain(error, "playtest.status", epoch);
        throw error;
      }
    });
  }

  pollLogs(cursor: LogCursor | undefined, signal: AbortSignal): Promise<RuntimeLogBatch> {
    return this.#enqueue(signal, async (operationSignal, epoch) => {
      try {
        const effectiveCursor = this.#effectiveCursor(cursor);
        const result = freezeLogBatch(await this.#capability.logs(effectiveCursor, operationSignal));
        this.#assertOperation(epoch, operationSignal);
        this.#acknowledgeCursorReset(result);
        this.#observeCursorReset(effectiveCursor, result);
        this.#activity("runtime.logs", "success", `${result.entries.length} rows`, result.totalDropped);
        return result;
      } catch (error: unknown) {
        if (!this.#isCurrent(epoch)) throw createAbortError();
        this.#activity("runtime.logs", activityResult(error), safeErrorMessage("runtime.logs", error));
        throw error;
      }
    });
  }

  captureScreenshot(signal: AbortSignal): Promise<ScreenshotResult> {
    return this.#enqueue(signal, async (operationSignal, epoch) => {
      try {
        const result = freezeScreenshot(await this.#capability.screenshot(operationSignal));
        this.#assertOperation(epoch, operationSignal);
        this.#activity("viewport.capture", "success", result.target);
        return result;
      } catch (error: unknown) {
        if (!this.#isCurrent(epoch)) throw createAbortError();
        this.#activity("viewport.capture", activityResult(error), safeErrorMessage("viewport.capture", error));
        throw error;
      }
    });
  }

  runInspectCapture(signal: AbortSignal): Promise<InspectionReceipt> {
    return this.#enqueue(signal, async (operationSignal, epoch) => {
      let preExisting = false;
      let issued = false;
      let playtest: InspectionReceipt["playtest"] = { ok: false, error: "Playtest status failed" };
      let logs: InspectionReceipt["logs"] = { ok: false, error: "Not attempted" };
      let screenshot: InspectionReceipt["screenshot"] = { ok: false, error: "Not attempted" };
      let stop: InspectionReceipt["stop"] = { ok: true, value: "not-required" };
      let canCollect = false;

      try {
        try {
          const status = await this.#capability.status(operationSignal);
          this.#assertOperation(epoch, operationSignal);
          requireStatus(status);
          this.#reconcileStatus(status, epoch);
          this.#assertOperation(epoch, operationSignal);
          this.#activity("playtest.status", "success", status.running ? "running" : "idle");
          preExisting = status.running;
        } catch (error: unknown) {
          if (!this.#isCurrent(epoch)) throw createAbortError();
          this.#uncertain(error, "playtest.status", epoch);
          playtest = { ok: false, error: safeErrorMessage("playtest.status", error) };
        }

        if (this.#snapshot.status !== "unknown") {
          if (preExisting) {
            playtest = { ok: true, value: "pre-existing" };
            canCollect = true;
          } else {
            try {
              await this.#startDirect("play", operationSignal, epoch, () => {
                issued = true;
              });
              canCollect = true;
              playtest = { ok: true, value: "started" };
            } catch (error: unknown) {
              if (!this.#isCurrent(epoch)) throw createAbortError();
              playtest = { ok: false, error: safeErrorMessage("playtest.start", error) };
            }
          }
        }

        if (canCollect) {
          try {
            logs = { ok: true, value: freezeLogBatch(await this.#capability.logs(undefined, operationSignal)) };
            this.#assertOperation(epoch, operationSignal);
            this.#activity("runtime.logs", "success", `${logs.value.entries.length} rows`, logs.value.totalDropped);
          } catch (error: unknown) {
            if (!this.#isCurrent(epoch)) throw createAbortError();
            logs = { ok: false, error: safeErrorMessage("runtime.logs", error) };
            this.#activity("runtime.logs", activityResult(error), logs.error);
          }
          try {
            screenshot = { ok: true, value: freezeScreenshot(await this.#capability.screenshot(operationSignal)) };
            this.#assertOperation(epoch, operationSignal);
            this.#activity("viewport.capture", "success", screenshot.value.target);
          } catch (error: unknown) {
            if (!this.#isCurrent(epoch)) throw createAbortError();
            screenshot = { ok: false, error: safeErrorMessage("viewport.capture", error) };
            this.#activity("viewport.capture", activityResult(error), screenshot.error);
          }
        }
      } finally {
        if (issued) {
          stop = await this.#cleanupIssuedStart(epoch);
        }
      }

      return freezeReceipt({
        instanceId: this.#instanceId,
        preExisting,
        playtest,
        logs,
        screenshot,
        stop,
      });
    });
  }

  disconnect(): void {
    if (this.#disposed) return;
    this.#epoch += 1;
    for (const operation of this.#operations) operation.abort();
    this.#operations.clear();
    this.#replace({ status: "unknown", roles: [], mode: undefined, error: "Studio disconnected" });
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#epoch += 1;
    for (const operation of this.#operations) operation.abort();
    this.#operations.clear();
    this.#lifetime.abort();
    this.#listeners.clear();
  }

  async #startDirect(mode: PlayMode, signal: AbortSignal, epoch: number, onIssued?: () => void): Promise<void> {
    this.#assertOperation(epoch, signal);
    this.#replace({ status: "starting", mode, error: undefined });
    try {
      let reportedIssued = false;
      const reportIssued = (): void => {
        if (reportedIssued) return;
        reportedIssued = true;
        onIssued?.();
      };
      const result = await this.#capability.start(mode, signal, reportIssued);
      this.#assertOperation(epoch, signal);
      reportIssued();
      requireStart(result);
      this.#replace({
        status: "running",
        mode,
        roles: result.roles ?? [],
        runtimeGeneration: this.#snapshot.runtimeGeneration + 1,
        error: undefined,
      });
      this.#assertOperation(epoch, signal);
      this.#resetAllCursors = true;
      this.#activity("playtest.start", "success", mode);
    } catch (error: unknown) {
      if (!this.#isCurrent(epoch)) throw createAbortError();
      this.#uncertain(error, "playtest.start", epoch);
      throw error;
    }
  }

  async #stopDirect(signal: AbortSignal, epoch: number): Promise<void> {
    this.#assertOperation(epoch, signal);
    this.#replace({ status: "stopping", error: undefined });
    try {
      const result = await this.#capability.stop(signal);
      this.#assertOperation(epoch, signal);
      requireStop(result);
      this.#replace({ status: "idle", roles: [], mode: undefined, error: undefined });
      this.#assertOperation(epoch, signal);
      this.#activity("playtest.stop", "success", "stopped");
    } catch (error: unknown) {
      if (!this.#isCurrent(epoch)) throw createAbortError();
      this.#uncertain(error, "playtest.stop", epoch);
      throw error;
    }
  }

  #enqueue<T>(externalSignal: AbortSignal, work: (signal: AbortSignal, epoch: number) => Promise<T>): Promise<T> {
    const requestEpoch = this.#epoch;
    const run = async (): Promise<T> => {
      if (this.#disposed) throw new Error("Playtest controller is disposed");
      throwIfAborted(externalSignal);
      this.#assertCurrent(requestEpoch);
      const operation = new AbortController();
      this.#operations.add(operation);
      const composed = composeSignals(
        [externalSignal, this.#lifetime.signal, operation.signal],
        this.#operationTimeoutMs,
      );
      try {
        throwIfAborted(composed.signal);
        const result = await work(composed.signal, requestEpoch);
        this.#assertOperation(requestEpoch, composed.signal);
        return result;
      } finally {
        this.#operations.delete(operation);
        composed.dispose();
      }
    };
    const operation = this.#tail.then(run, run);
    this.#tail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  #effectiveCursor(cursor: LogCursor | undefined): LogCursor | undefined {
    if (this.#resetAllCursors) return undefined;
    if (typeof cursor === "number" && this.#resetCursorRoles.size > 0) {
      return Object.freeze(
        Object.fromEntries(
          this.#snapshot.roles.filter((role) => !this.#resetCursorRoles.has(role)).map((role) => [role, cursor]),
        ),
      );
    }
    if (typeof cursor !== "object" || cursor === null || this.#resetCursorRoles.size === 0) {
      return cloneCursor(cursor);
    }
    return Object.freeze(
      Object.fromEntries(Object.entries(cursor).filter(([role]) => !this.#resetCursorRoles.has(role))),
    );
  }

  #observeCursorReset(cursor: LogCursor | undefined, result: RuntimeLogBatch): void {
    if (typeof cursor === "number") {
      if (result.nextSince !== undefined && result.nextSince < cursor) this.#resetAllCursors = true;
      for (const [role, next] of Object.entries(result.perCaptureNextSince)) {
        if (next < cursor) this.#resetCursorRoles.add(role);
      }
      return;
    }
    if (cursor === undefined) return;
    for (const [role, next] of Object.entries(result.perCaptureNextSince)) {
      const previous = cursor[role];
      if (previous !== undefined && next < previous) this.#resetCursorRoles.add(role);
    }
  }

  #acknowledgeCursorReset(result: RuntimeLogBatch): void {
    const polledRoles = new Set(Object.keys(result.perCaptureNextSince));
    if (result.capturedBy !== undefined && result.nextSince !== undefined) {
      polledRoles.add(result.capturedBy);
    }
    this.#resetAllCursors = false;
    for (const role of Object.keys(result.perCaptureErrors)) this.#resetCursorRoles.add(role);
    for (const role of polledRoles) {
      if (!(role in result.perCaptureErrors)) this.#resetCursorRoles.delete(role);
    }
  }

  #reconcileStatus(result: PlaytestStatusResult, epoch: number): void {
    this.#assertCurrent(epoch);
    const previous = this.#snapshot;
    let runtimeGeneration = previous.runtimeGeneration;
    if (result.running && previous.status !== "running") {
      runtimeGeneration += 1;
      this.#resetAllCursors = true;
      this.#resetCursorRoles.clear();
    } else if (result.running) {
      const previousRoles = new Set(previous.roles);
      for (const role of result.roles) {
        if (!previousRoles.has(role)) this.#resetCursorRoles.add(role);
      }
    }
    this.#replace({
      status: result.running ? "running" : "idle",
      roles: result.roles,
      runtimeGeneration,
      ...(result.running ? {} : { mode: undefined }),
      error: undefined,
    });
  }

  async #cleanupIssuedStart(epoch: number): Promise<InspectionReceipt["stop"]> {
    const cleanup = timeoutSignal(this.#cleanupTimeoutMs);
    try {
      if (this.#isCurrent(epoch)) this.#replace({ status: "stopping", error: undefined });
      const result = await this.#capability.stop(cleanup.signal);
      requireStop(result);
      if (this.#isCurrent(epoch)) {
        this.#replace({ status: "idle", roles: [], mode: undefined, error: undefined });
        this.#activity("playtest.stop", "success", "stopped");
      }
      return { ok: true, value: "stopped" };
    } catch (error: unknown) {
      if (this.#isCurrent(epoch)) this.#uncertain(error, "playtest.stop", epoch);
      return { ok: false, error: safeErrorMessage("playtest.stop", error) };
    } finally {
      cleanup.dispose();
    }
  }

  #isCurrent(epoch: number): boolean {
    return !this.#disposed && epoch === this.#epoch;
  }

  #assertCurrent(epoch: number): void {
    if (!this.#isCurrent(epoch)) throw createAbortError();
  }

  #assertOperation(epoch: number, signal: AbortSignal): void {
    throwIfAborted(signal);
    this.#assertCurrent(epoch);
  }

  #replace(update: {
    readonly status?: PlaytestState;
    readonly mode?: PlayMode | undefined;
    readonly roles?: readonly string[];
    readonly runtimeGeneration?: number;
    readonly error?: string | undefined;
  }): void {
    if (this.#disposed) return;
    const mode = Object.prototype.hasOwnProperty.call(update, "mode") ? update.mode : this.#snapshot.mode;
    const error = Object.prototype.hasOwnProperty.call(update, "error") ? update.error : this.#snapshot.error;
    const next: PlaytestSnapshot = freezeSnapshot({
      instanceId: this.#snapshot.instanceId,
      status: update.status ?? this.#snapshot.status,
      roles: update.roles ?? this.#snapshot.roles,
      runtimeGeneration: update.runtimeGeneration ?? this.#snapshot.runtimeGeneration,
      observedAt: this.#now(),
      ...(mode === undefined ? {} : { mode }),
      ...(error === undefined ? {} : { error }),
    });
    this.#snapshot = next;
    for (const listener of this.#listeners) listener(next);
  }

  #uncertain(error: unknown, operation: ActivityOperation, epoch: number): void {
    if (!this.#isCurrent(epoch)) return;
    const detail = safeErrorMessage(operation, error);
    this.#replace({ status: "unknown", error: detail });
    this.#activity(operation, activityResult(error), detail);
  }

  #activity(
    operation: ActivityOperation,
    result: ActivityEvent["result"],
    detail?: string,
    droppedLogs?: number,
  ): void {
    if (this.#disposed || this.#onActivity === undefined) return;
    this.#onActivity(
      Object.freeze({
        id: this.#createId(),
        timestamp: new Date(this.#now()).toISOString(),
        instanceId: this.#instanceId,
        operation,
        result,
        ...(detail === undefined ? {} : { detail }),
        ...(droppedLogs === undefined ? {} : { droppedLogs }),
      }),
    );
  }
}

function boundedDuration(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 180_000) {
    throw new Error(`${label} must be an integer from 1 to 180000ms`);
  }
  return value;
}

function requireStart(result: PlaytestStartResult): void {
  if (result.action !== "start" || result.success !== true) throw new Error("Playtest start failed");
}

function requireStop(result: PlaytestStopResult): void {
  if (result.action !== "stop" || result.success !== true) throw new Error("Playtest stop failed");
}

function requireStatus(result: PlaytestStatusResult): void {
  if (result.action !== "status" || result.success !== true) throw new Error("Playtest status failed");
}

function composeSignals(
  signals: readonly AbortSignal[],
  timeoutMs: number,
): { readonly signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  for (const signal of signals) signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  if (signals.some((signal) => signal.aborted)) controller.abort();
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      for (const signal of signals) signal.removeEventListener("abort", abort);
    },
  };
}

function timeoutSignal(timeoutMs: number): { readonly signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    dispose: () => clearTimeout(timer),
  };
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw createAbortError();
}

function activityResult(error: unknown): ActivityEvent["result"] {
  return error instanceof Error && error.name === "AbortError" ? "cancelled" : "failed";
}

function createAbortError(): Error {
  const error = new Error("Operation cancelled");
  error.name = "AbortError";
  return error;
}

function safeErrorMessage(operation: ActivityOperation, error: unknown): string {
  if (error instanceof Error && error.name === "AbortError") return "Operation cancelled";
  switch (operation) {
    case "playtest.start":
      return "Playtest start failed";
    case "playtest.stop":
      return "Playtest stop failed";
    case "playtest.status":
      return "Playtest status failed";
    case "runtime.logs":
      return "Runtime log capture failed";
    case "viewport.capture":
      return "Viewport capture failed";
    default:
      return "Operation failed";
  }
}

function cloneCursor(cursor: LogCursor | undefined): LogCursor | undefined {
  return typeof cursor === "object" && cursor !== null ? Object.freeze({ ...cursor }) : cursor;
}

function freezeSnapshot(snapshot: PlaytestSnapshot): PlaytestSnapshot {
  return Object.freeze({ ...snapshot, roles: Object.freeze([...snapshot.roles]) });
}

function freezeLogBatch(batch: RuntimeLogBatch): RuntimeLogBatch {
  return Object.freeze({
    entries: Object.freeze(
      batch.entries.map((entry) =>
        Object.freeze({
          ...entry,
          message: safeRuntimeMessage(entry.message),
          ...(entry.data === undefined ? {} : { data: freezeSafeRecord(entry.data) }),
        }),
      ),
    ),
    totalDropped: batch.totalDropped,
    ...(batch.nextSince === undefined ? {} : { nextSince: batch.nextSince }),
    perCaptureNextSince: Object.freeze({ ...batch.perCaptureNextSince }),
    perCaptureErrors: Object.freeze(
      Object.fromEntries(Object.keys(batch.perCaptureErrors).map((role) => [role, "Runtime log capture failed"])),
    ),
    ...(batch.capturedBy === undefined ? {} : { capturedBy: batch.capturedBy }),
  });
}

const sensitiveText = /(?:api[_-]?key|token|secret|authorization|credential|bearer)\s*[:=]\s*\S+/i;
const sensitiveKey = /key|token|secret|authorization|credential/i;

function safeRuntimeMessage(message: string): string {
  return sensitiveText.test(message) ? "[sensitive runtime log omitted]" : message;
}

function freezeSafeRecord(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !sensitiveKey.test(key))
        .map(([key, entry]) => [key, safeValue(entry)]),
    ),
  );
}

function safeValue(value: unknown): unknown {
  if (Array.isArray(value)) return Object.freeze(value.map(safeValue));
  if (value !== null && typeof value === "object") {
    return freezeSafeRecord(value as Readonly<Record<string, unknown>>);
  }
  if (typeof value === "string" && sensitiveText.test(value)) return "[sensitive value omitted]";
  return value;
}

function freezeScreenshot(value: ScreenshotResult): ScreenshotResult {
  return Object.freeze({ ...value });
}

function freezeReceipt(receipt: InspectionReceipt): InspectionReceipt {
  return Object.freeze({
    ...receipt,
    playtest: Object.freeze(receipt.playtest),
    logs: Object.freeze(receipt.logs),
    screenshot: Object.freeze(receipt.screenshot),
    stop: Object.freeze(receipt.stop),
  });
}
