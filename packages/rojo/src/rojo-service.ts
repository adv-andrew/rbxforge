import { mkdtemp, realpath, rm } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { formatDataModelPath, parseDataModelPath, type ProjectionNode } from "@rbxforge/core";

const OUTPUT_LIMIT = 8_192;
const PROCESS_SETTLE_MS = 250;

export interface ProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ProcessHandle {
  exited(): Promise<ProcessResult>;
  stop(): Promise<void>;
}

export interface ProcessRunner {
  run(spec: ProcessSpec): Promise<ProcessResult>;
  start(spec: ProcessSpec): Promise<ProcessHandle>;
}
export interface ProcessSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly shell: false;
  readonly timeoutMs?: number;
}

export interface RojoProtocolEvent {
  readonly type: "snapshot" | "patch";
  readonly sessionId: string;
  readonly protocolVersion: number;
  readonly nodes: readonly ProjectionNode[];
}

export interface RojoProtocolPort {
  events(projectPath: string, signal: AbortSignal): AsyncIterable<RojoProtocolEvent>;
}

export interface RojoSourcemapPort {
  watch(outputPath: string, signal: AbortSignal): AsyncIterable<unknown>;
}

export interface RojoStatus {
  readonly processRunning: boolean;
  readonly apiHealthy: boolean;
  readonly port: number;
  readonly state?: "failed" | "stopped";
  readonly stderr?: string;
}

export interface BuildResult {
  readonly ok: boolean;
  readonly outputPath: string;
  readonly stdout: string;
  readonly stderr: string;
}

export type RojoProjectionEvent =
  | { readonly type: "snapshot"; readonly sessionId: string; readonly nodes: readonly ProjectionNode[] }
  | { readonly type: "update"; readonly sessionId: string; readonly nodes: readonly ProjectionNode[] }
  | { readonly type: "reset"; readonly sessionId: string }
  | { readonly type: "fallback"; readonly reason: "protocol-mismatch" | "protocol-unavailable" }
  | { readonly type: "failed"; readonly stderr: string };

export interface RojoServiceOptions {
  readonly runner: ProcessRunner;
  readonly command: string;
  readonly allocatePort: () => Promise<number>;
  readonly probeHealth: (port: number) => Promise<boolean>;
  readonly launchAttempts?: number;
  readonly healthPollIntervalMs?: number;
  readonly healthDeadlineMs?: number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly now?: () => number;
  readonly temporaryPath?: (suffix: string) => Promise<string>;
  readonly removeTemporary?: (path: string) => Promise<void>;
  readonly protocol?: RojoProtocolPort;
  readonly sourcemap: RojoSourcemapPort;
}

export class RojoLaunchError extends Error {
  readonly attempts: number;
  readonly diagnostic: string;

  constructor(attempts: number, diagnostic: string) {
    super(`Rojo failed to become healthy after ${attempts} attempt${attempts === 1 ? "" : "s"}: ${diagnostic}`);
    this.name = "RojoLaunchError";
    this.attempts = attempts;
    this.diagnostic = diagnostic;
  }
}

/** Orchestrates Rojo using exact argv and injected process/protocol seams. */
export class RojoService {
  readonly #runner: ProcessRunner;
  readonly #command: string;
  readonly #allocatePort: () => Promise<number>;
  readonly #probeHealth: (port: number) => Promise<boolean>;
  readonly #launchAttempts: number;
  readonly #healthPollIntervalMs: number;
  readonly #healthDeadlineMs: number;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #now: () => number;
  readonly #temporaryPath: (suffix: string) => Promise<string>;
  readonly #removeTemporary: (path: string) => Promise<void>;
  readonly #protocol: RojoProtocolPort | undefined;
  readonly #sourcemap: RojoSourcemapPort;
  #serve: ProcessHandle | undefined;
  #watch: ProcessHandle | undefined;
  #status: RojoStatus | undefined;
  #watchAbort: AbortController | undefined;
  #watchIterator: AsyncIterator<unknown> | undefined;
  #protocolAbort: AbortController | undefined;
  #protocolIterator: AsyncIterator<RojoProtocolEvent> | undefined;
  #stopped = false;
  #launching = false;
  #launchAbort: AbortController | undefined;
  #starting: ProcessHandle | undefined;
  readonly #stoppedHandles = new WeakSet<ProcessHandle>();
  readonly #listeners = new Set<(status: RojoStatus) => void>();

  constructor(options: RojoServiceOptions) {
    this.#runner = options.runner;
    this.#command = options.command;
    this.#allocatePort = options.allocatePort;
    this.#probeHealth = options.probeHealth;
    const launchAttempts = options.launchAttempts ?? 3;
    if (!Number.isFinite(launchAttempts) || !Number.isInteger(launchAttempts) || launchAttempts < 1) {
      throw new RangeError("launchAttempts must be a positive finite integer");
    }
    this.#launchAttempts = Math.min(launchAttempts, 3);
    this.#healthPollIntervalMs = options.healthPollIntervalMs ?? 250;
    this.#healthDeadlineMs = options.healthDeadlineMs ?? 8_000;
    this.#sleep = options.sleep ?? sleep;
    this.#now = options.now ?? Date.now;
    this.#temporaryPath = options.temporaryPath ?? createOwnedTemporaryPath;
    this.#removeTemporary = options.removeTemporary ?? (async (path) => rm(path, { force: true }));
    this.#protocol = options.protocol;
    this.#sourcemap = options.sourcemap;
  }

  async start(projectPath: string): Promise<RojoStatus> {
    if (this.#serve !== undefined || this.#launching) {
      throw new Error("Rojo service is already started");
    }
    this.#stopped = false;
    this.#launching = true;
    const controller = new AbortController();
    this.#launchAbort = controller;
    const usedPorts = new Set<number>();
    const allocationBudget = { remaining: 16 };
    let attempts = 0;
    let diagnostic = "Rojo did not become healthy";
    try {
      for (let attempt = 1; attempt <= this.#launchAttempts; attempt += 1) {
        if (controller.signal.aborted) break;
        let port: number;
        try {
          port = await this.allocateUniquePort(usedPorts, allocationBudget);
        } catch (error: unknown) {
          diagnostic = diagnosticFor(error);
          break;
        }
        if (controller.signal.aborted) break;
        attempts = attempt;
        let handle: ProcessHandle | undefined;
        let reaped = true;
        try {
          handle = await this.#runner.start({
            command: this.#command,
            args: ["serve", projectPath, "--address", "127.0.0.1", "--port", String(port)],
            shell: false,
          });
          this.#starting = handle;
          const ready = await this.waitForHealthy(handle, port, controller.signal);
          if (ready.kind === "healthy" && !controller.signal.aborted && !this.#stopped) {
            this.#serve = handle;
            this.#starting = undefined;
            const status = Object.freeze({ processRunning: true, apiHealthy: true, port });
            this.publish(status);
            void this.observeCrash(handle);
            return status;
          }
          diagnostic = ready.diagnostic;
        } catch (error: unknown) {
          diagnostic = diagnosticFor(error);
        } finally {
          if (handle !== undefined && this.#serve !== handle) {
            reaped = await this.stopAndSettle(handle);
            if (this.#starting === handle) this.#starting = undefined;
          }
        }
        if (!reaped) {
          diagnostic = `Rojo child did not exit within ${PROCESS_SETTLE_MS}ms after stop`;
          break;
        }
        if (controller.signal.aborted || this.#stopped) break;
      }
      throw new RojoLaunchError(attempts, bound(diagnostic));
    } finally {
      this.#launching = false;
      if (this.#launchAbort === controller) this.#launchAbort = undefined;
      this.#starting = undefined;
    }
  }

  status(): RojoStatus | undefined {
    return this.#status;
  }

  async checkHealth(): Promise<RojoStatus> {
    const retained = this.#status;
    if (this.#serve === undefined || retained === undefined || !retained.processRunning) {
      throw new Error("Rojo service is not running.");
    }
    const apiHealthy = await this.#probeHealth(retained.port);
    const status = apiHealthy
      ? Object.freeze({ processRunning: true, apiHealthy: true, port: retained.port })
      : Object.freeze({
          processRunning: true,
          apiHealthy: false,
          port: retained.port,
          state: "failed" as const,
        });
    this.publish(status);
    return status;
  }

  onStatus(listener: (status: RojoStatus) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#launchAbort?.abort();
    this.#watchAbort?.abort();
    this.#protocolAbort?.abort();
    const iterator = this.#watchIterator;
    if (iterator?.return !== undefined) await iterator.return();
    const protocolIterator = this.#protocolIterator;
    if (protocolIterator?.return !== undefined) await protocolIterator.return();
    const handles = [...new Set([this.#watch, this.#serve, this.#starting])].filter(
      (handle): handle is ProcessHandle => handle !== undefined,
    );
    this.#watch = undefined;
    this.#serve = undefined;
    if (this.#status !== undefined)
      this.publish({ ...this.#status, processRunning: false, apiHealthy: false, state: "stopped" });
    await Promise.all(handles.map((handle) => this.stopAndSettle(handle)));
  }

  async buildTemporary(projectPath: string): Promise<BuildResult> {
    const outputPath = await this.#temporaryPath(".rbxlx");
    if (!(await isOutsideProject(projectPath, outputPath))) {
      throw new Error("Temporary build output must be outside the project directory");
    }
    const result = await this.#runner.run({
      command: this.#command,
      args: ["build", projectPath, "--output", outputPath],
      shell: false,
    });
    if (result.exitCode !== 0) {
      await this.#removeTemporary(outputPath);
    }
    return Object.freeze({
      ok: result.exitCode === 0,
      outputPath,
      stdout: bound(result.stdout),
      stderr: bound(result.stderr),
    });
  }

  async *watchProjection(projectPath: string): AsyncIterable<RojoProjectionEvent> {
    if (this.#protocol !== undefined) {
      let sessionId: string | undefined;
      let hasSnapshot = false;
      const controller = new AbortController();
      this.#protocolAbort = controller;
      const iterator = this.#protocol.events(projectPath, controller.signal)[Symbol.asyncIterator]();
      this.#protocolIterator = iterator;
      try {
        while (!controller.signal.aborted && !this.#stopped) {
          const item = await iterator.next();
          if (item.done) break;
          const event = item.value;
          if (controller.signal.aborted || this.#stopped) return;
          if (
            !isProtocolEvent(event) ||
            event.protocolVersion !== 5 ||
            !validNodes(event.nodes) ||
            (event.type === "patch" && (sessionId !== event.sessionId || !hasSnapshot))
          ) {
            yield* this.watchSourcemapFallback(projectPath, "protocol-mismatch");
            return;
          }
          if (sessionId !== undefined && sessionId !== event.sessionId) {
            yield Object.freeze({ type: "reset", sessionId: event.sessionId });
            hasSnapshot = false;
          }
          sessionId = event.sessionId;
          if (event.type === "snapshot") hasSnapshot = true;
          yield Object.freeze({
            type: event.type === "patch" ? "update" : "snapshot",
            sessionId,
            nodes: freezeNodes(event.nodes),
          });
        }
        if (!this.#stopped) yield* this.watchSourcemapFallback(projectPath, "protocol-unavailable");
      } catch {
        if (!this.#stopped) yield* this.watchSourcemapFallback(projectPath, "protocol-unavailable");
      } finally {
        this.#protocolAbort = undefined;
        this.#protocolIterator = undefined;
        if (iterator.return !== undefined) await iterator.return();
      }
    } else {
      yield* this.watchSourcemapFallback(projectPath, "protocol-unavailable");
    }
  }

  async *watchSourcemapFallback(
    projectPath: string,
    reason: "protocol-mismatch" | "protocol-unavailable",
  ): AsyncIterable<RojoProjectionEvent> {
    const outputPath = await this.#temporaryPath(".json");
    this.#watch = await this.#runner.start({
      command: this.#command,
      args: ["sourcemap", projectPath, "--output", outputPath, "--watch", "--absolute", "--include-non-scripts"],
      shell: false,
    });
    yield Object.freeze({ type: "fallback", reason });
    try {
      let first = true;
      const controller = new AbortController();
      this.#watchAbort = controller;
      const iterator = this.#sourcemap.watch(outputPath, controller.signal)[Symbol.asyncIterator]();
      this.#watchIterator = iterator;
      while (!controller.signal.aborted && !this.#stopped) {
        const race = await Promise.race([
          iterator.next().then((next) => ({ kind: "next" as const, next })),
          this.#watch.exited().then((result) => ({ kind: "exit" as const, result })),
        ]);
        if (race.kind === "exit") {
          if (race.result.exitCode !== 0 && !this.#stopped) {
            if (this.#status !== undefined)
              this.publish({ ...this.#status, state: "failed", stderr: bound(race.result.stderr) });
            yield Object.freeze({ type: "failed", stderr: bound(race.result.stderr) });
          }
          return;
        }
        if (controller.signal.aborted || this.#stopped) return;
        if (race.next.done) return;
        const raw = race.next.value;
        const { parseRojoSourcemap } = await import("./sourcemap.js");
        if (controller.signal.aborted || this.#stopped) return;
        yield Object.freeze({
          type: first ? "snapshot" : "update",
          sessionId: "sourcemap",
          nodes: parseRojoSourcemap(raw),
        });
        first = false;
      }
    } finally {
      const iterator = this.#watchIterator;
      this.#watchIterator = undefined;
      if (iterator?.return !== undefined) await iterator.return();
      this.#watchAbort = undefined;
      const handle = this.#watch;
      this.#watch = undefined;
      if (handle !== undefined) {
        await handle.stop();
        await handle.exited();
      }
    }
  }

  async startSourcemapWatch(projectPath: string): Promise<ProcessHandle> {
    const outputPath = await this.#temporaryPath(".json");
    return this.#runner.start({
      command: this.#command,
      args: ["sourcemap", projectPath, "--output", outputPath, "--watch", "--absolute", "--include-non-scripts"],
      shell: false,
    });
  }

  async observeCrash(handle: ProcessHandle): Promise<void> {
    const result = await handle.exited();
    if (this.#serve === handle) {
      this.#serve = undefined;
      if (this.#status !== undefined) {
        this.publish({
          ...this.#status,
          processRunning: false,
          apiHealthy: false,
          state: "failed",
          stderr: bound(result.stderr),
        });
      }
    }
    void result;
  }

  publish(status: RojoStatus): void {
    this.#status = Object.freeze(status);
    for (const listener of this.#listeners) listener(this.#status);
  }

  async allocateUniquePort(usedPorts: Set<number>, budget: { remaining: number }): Promise<number> {
    while (budget.remaining > 0) {
      const port = await this.#allocatePort();
      budget.remaining -= 1;
      if (Number.isInteger(port) && port > 0 && port <= 65_535 && !usedPorts.has(port)) {
        usedPorts.add(port);
        return port;
      }
    }
    throw new Error("Rojo port allocation did not produce a unique valid port after 16 results");
  }

  async waitForHealthy(
    handle: ProcessHandle,
    port: number,
    signal: AbortSignal,
  ): Promise<
    { readonly kind: "healthy"; readonly diagnostic: string } | { readonly kind: "failed"; readonly diagnostic: string }
  > {
    let exit: ProcessResult | undefined;
    const exited = handle.exited().then((result) => {
      exit = result;
      return result;
    });
    const stopped = abortSignal(signal);
    const startedAt = this.#now();
    while (!signal.aborted && this.#now() - startedAt < this.#healthDeadlineMs) {
      const remainingMs = this.#healthDeadlineMs - (this.#now() - startedAt);
      const probe = this.#probeHealth(port)
        .then((value) => ({ kind: "probe" as const, value }))
        .catch((error: unknown) => ({ kind: "probe-error" as const, error }));
      const tick = Promise.resolve()
        .then(() => this.#sleep(Math.max(1, Math.min(this.#healthPollIntervalMs, remainingMs))))
        .then(() => ({ kind: "tick" as const }));
      const result = await Promise.race([
        exited.then((value) => ({ kind: "exit" as const, value })),
        stopped.then(() => ({ kind: "stopped" as const })),
        probe,
        tick,
      ]);
      if (result.kind === "exit") return { kind: "failed", diagnostic: outputDiagnostic(result.value) };
      if (result.kind === "stopped") return { kind: "failed", diagnostic: "Rojo service was stopped during launch" };
      if (result.kind === "probe-error") return { kind: "failed", diagnostic: diagnosticFor(result.error) };
      if (result.kind === "tick") {
        if (this.#now() - startedAt >= this.#healthDeadlineMs)
          return { kind: "failed", diagnostic: "Rojo health deadline exceeded" };
        continue;
      }
      if (result.value) {
        await Promise.resolve();
        if (exit !== undefined) return { kind: "failed", diagnostic: outputDiagnostic(exit) };
        if (this.#now() - startedAt >= this.#healthDeadlineMs)
          return { kind: "failed", diagnostic: "Rojo health deadline exceeded" };
        return { kind: "healthy", diagnostic: "" };
      }
      const delay = await Promise.race([
        exited.then((value) => ({ kind: "exit" as const, value })),
        stopped.then(() => ({ kind: "stopped" as const })),
        tick,
      ]);
      if (delay.kind === "exit") return { kind: "failed", diagnostic: outputDiagnostic(delay.value) };
      if (delay.kind === "stopped") return { kind: "failed", diagnostic: "Rojo service was stopped during launch" };
      if (this.#now() - startedAt >= this.#healthDeadlineMs)
        return { kind: "failed", diagnostic: "Rojo health deadline exceeded" };
    }
    return {
      kind: "failed",
      diagnostic: signal.aborted ? "Rojo service was stopped during launch" : "Rojo health deadline exceeded",
    };
  }

  async stopAndSettle(handle: ProcessHandle): Promise<boolean> {
    if (!this.#stoppedHandles.has(handle)) {
      this.#stoppedHandles.add(handle);
      await handle.stop();
    }
    return Promise.race([handle.exited().then(() => true), settleGuard().then(() => false)]);
  }
}

function outputDiagnostic(result: ProcessResult): string {
  return bound(result.stderr || result.stdout || `Rojo exited with code ${result.exitCode}`);
}

function diagnosticFor(error: unknown): string {
  return bound(error instanceof Error ? error.message : String(error));
}

function abortSignal(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function settleGuard(): Promise<void> {
  return sleep(PROCESS_SETTLE_MS);
}

function isProtocolEvent(value: unknown): value is RojoProtocolEvent {
  if (value === null || typeof value !== "object") return false;
  const event = value as Record<string, unknown>;
  return (
    (event.type === "snapshot" || event.type === "patch") &&
    typeof event.sessionId === "string" &&
    typeof event.protocolVersion === "number" &&
    Array.isArray(event.nodes)
  );
}

function validNodes(nodes: readonly ProjectionNode[]): boolean {
  return nodes.every((node) => {
    if (node === null || typeof node !== "object") return false;
    const record = node as unknown as Record<string, unknown>;
    const allowed = new Set(["path", "name", "className", "properties", "revision", "unsafeUnknownChildren"]);
    if (
      Object.keys(record).some((key) => !allowed.has(key)) ||
      typeof record.path !== "string" ||
      typeof record.name !== "string" ||
      typeof record.className !== "string" ||
      (record.revision !== undefined && typeof record.revision !== "string") ||
      (record.unsafeUnknownChildren !== undefined && typeof record.unsafeUnknownChildren !== "boolean") ||
      (record.properties !== undefined && !isJsonRecord(record.properties))
    )
      return false;
    try {
      return formatDataModelPath(parseDataModelPath(record.path)) === record.path;
    } catch {
      return false;
    }
  });
}

function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (value === null || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return false;
  return Object.values(value).every(isJsonValue);
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.values(value).every(isJsonValue)
  );
}

function bound(value: string): string {
  return value.length <= OUTPUT_LIMIT ? value : value.slice(-OUTPUT_LIMIT);
}

function freezeNodes(nodes: readonly ProjectionNode[]): readonly ProjectionNode[] {
  return Object.freeze(
    nodes.map((node) =>
      Object.freeze({
        ...node,
        ...(node.properties === undefined ? {} : { properties: freezeJsonRecord(node.properties) }),
      }),
    ),
  );
}

function freezeJsonRecord(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, freezeJson(nested)])));
}

function freezeJson(value: unknown): unknown {
  if (Array.isArray(value)) return Object.freeze(value.map(freezeJson));
  if (value !== null && typeof value === "object") return freezeJsonRecord(value as Readonly<Record<string, unknown>>);
  return value;
}

async function isOutsideProject(projectPath: string, outputPath: string): Promise<boolean> {
  const projectDirectory = await canonicalParent(projectPath);
  const outputDirectory = await canonicalParent(outputPath);
  const fromProject = relative(projectDirectory, outputDirectory);
  return fromProject === "" ||
    (fromProject !== ".." && !fromProject.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`))
    ? false
    : true;
}

async function canonicalParent(path: string): Promise<string> {
  const parent = resolve(dirname(path));
  try {
    return await realpath(parent);
  } catch {
    return parent;
  }
}

async function createOwnedTemporaryPath(suffix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "rbxforge-rojo-"));
  return join(directory, `artifact${suffix}`);
}
