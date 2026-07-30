import { randomBytes } from "node:crypto";
import { isAbsolute } from "node:path";
import { createServer } from "node:net";
import { StudioMcpService, type McpClientPort, type StudioMutationGate } from "@rbxforge/studio-mcp";

const PRIMARY_RECORD = /^HTTP server listening on 127\.0\.0\.1:(\d+) for Studio plugin \(primary mode\)$/;
const ANY_PRIMARY_RECORD = /^HTTP server listening on ([^:]+):(\d+) for Studio plugin \(primary mode\)$/;
const PROXY_RECORD = /^Port (\d+) in use - entering proxy mode \(forwarding to localhost:(\d+)\)$/;
const LEGACY_READY_RECORD = /^Legacy HTTP server also listening on 127\.0\.0\.1:3002 for old plugins$/;
const LEGACY_SKIPPED_RECORD = /^Legacy port 3002 in use, skipping backward-compat listener$/;
const MAX_DIAGNOSTIC_BYTES = 32_768;
const MAX_DIAGNOSTIC_RECORDS = 512;
const SAFE_ENVIRONMENT_KEYS = Object.freeze([
  "PATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TMPDIR",
  "SYSTEMROOT",
  "WINDIR",
  "PATHEXT",
] as const);

export interface StudioBrokerReady {
  readonly brokerEpoch: string;
  readonly primaryPort: number;
  readonly legacyPort?: 3002;
  readonly legacyStatus: "listening" | "occupied" | "unknown";
  readonly startedAt: number;
}

export interface StudioBrokerLease {
  readonly ready: StudioBrokerReady;
  release(): Promise<void>;
}

export interface StudioBrokerSnapshot {
  readonly state: "stopped" | "starting" | "ready" | "error";
  readonly ready?: StudioBrokerReady;
  readonly referenceCount: number;
  readonly diagnostic?: string;
}

export interface StudioBrokerSession {
  readonly client: McpClientPort;
  onStderr(listener: (line: string) => void): () => void;
  onExit(listener: (result: { readonly exitCode: number | null; readonly signal: string | null }) => void): () => void;
  close(): Promise<void>;
}

export interface StudioBrokerLaunch {
  readonly vendoredEntryPath: string;
  readonly primaryPort: number;
  readonly authToken: string;
  readonly env: Readonly<Record<string, string>>;
}

export type StudioBrokerInvalidationReason = "broker-exit";

export interface StudioBrokerControllerOptions {
  readonly primaryPort: number;
  readonly vendoredEntryPath: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly preflightPort?: (primaryPort: number) => Promise<boolean>;
  readonly createSession: (launch: StudioBrokerLaunch) => Promise<StudioBrokerSession>;
  readonly createService?: (client: McpClientPort, gate: StudioMutationGate) => StudioMcpService;
  readonly createToken?: () => string;
  readonly createEpoch?: () => string;
  readonly now?: () => number;
  readonly readinessTimeoutMs?: number;
  readonly legacyTimeoutMs?: number;
  readonly onInvalidated?: (reason: StudioBrokerInvalidationReason) => void;
}

export type StudioBrokerErrorCode =
  | "mcp-entry-not-absolute"
  | "mcp-primary-port-occupied"
  | "mcp-preflight-failed"
  | "mcp-primary-port-race"
  | "mcp-primary-mismatch"
  | "mcp-readiness-timeout"
  | "mcp-broker-exited"
  | "mcp-session-failed"
  | "mcp-session-close-failed"
  | "mcp-discovery-failed"
  | "mcp-startup-stopped";

export class StudioBrokerError extends Error {
  constructor(
    readonly code: StudioBrokerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "StudioBrokerError";
  }
}

interface Startup {
  readonly identity: object;
  readonly abort: AbortController;
  readonly signalChanged: () => void;
  readonly waiters: Set<() => void>;
  promise?: Promise<ReadyRun>;
  session?: StudioBrokerSession;
  token?: string;
  cancelled: boolean;
  intentionalClose: boolean;
  primaryReady: boolean;
  legacyStatus?: "listening" | "occupied";
  exit?: { readonly exitCode: number | null; readonly signal: string | null };
  mismatch?: string;
  proxyRace: boolean;
  readonly diagnostics: BoundedDiagnostics;
}

interface ReadyRun {
  readonly identity: object;
  readonly session: StudioBrokerSession;
  readonly service: StudioMcpService;
  readonly ready: StudioBrokerReady;
  readonly removeStderr: () => void;
  readonly removeExit: () => void;
  closing: boolean;
  invalidated: boolean;
}

const denyMutations: StudioMutationGate = Object.freeze({
  async authorize() {
    return {
      approved: false as const,
      reason: "Studio mutations are not available in the desktop MVP.",
    };
  },
  consume() {
    throw new Error("Studio mutations are not available in the desktop MVP.");
  },
});

export class StudioBrokerController {
  readonly #options: StudioBrokerControllerOptions;
  #snapshot: StudioBrokerSnapshot = Object.freeze({ state: "stopped", referenceCount: 0 });
  #startup: Startup | undefined;
  #run: ReadyRun | undefined;
  #closing: Promise<void> | undefined;
  #closeFailure: StudioBrokerError | undefined;
  #referenceCount = 0;
  readonly #sessionClosePromises = new WeakMap<StudioBrokerSession, Promise<void>>();

  constructor(options: StudioBrokerControllerOptions) {
    this.#options = options;
  }

  async retain(): Promise<StudioBrokerLease> {
    if (this.#closing !== undefined) {
      await this.#closing;
      return this.retain();
    }

    const currentRun = this.#run;
    if (currentRun !== undefined && !currentRun.closing && !currentRun.invalidated) {
      this.#referenceCount += 1;
      this.#publishReady(currentRun);
      return this.#leaseFor(currentRun);
    }

    this.#referenceCount += 1;
    this.#publishStarting();
    let startup = this.#startup;
    if (startup === undefined) {
      startup = this.#createStartup();
      this.#startup = startup;
      startup.promise = this.#start(startup);
    }
    const startupPromise = startup.promise;
    if (startupPromise === undefined) {
      throw new StudioBrokerError("mcp-session-failed", "Studio MCP startup was not initialized");
    }
    const run = await startupPromise;
    return this.#leaseFor(run);
  }

  service(): StudioMcpService {
    const run = this.#run;
    if (run === undefined || run.closing || run.invalidated) {
      throw new StudioBrokerError("mcp-session-failed", "Studio MCP broker is not ready");
    }
    return run.service;
  }

  snapshot(): StudioBrokerSnapshot {
    return this.#snapshot;
  }

  async stop(): Promise<void> {
    let startupCloseFailure: StudioBrokerError | undefined;
    const startup = this.#startup;
    if (startup !== undefined) {
      startup.cancelled = true;
      startup.abort.abort();
      startup.signalChanged();
      const startupPromise = startup.promise;
      try {
        if (startupPromise !== undefined) await startupPromise;
      } catch (error) {
        startupCloseFailure = findSessionCloseFailure(error);
        if (startupCloseFailure !== undefined) this.#closeFailure ??= startupCloseFailure;
      }
    }
    const run = this.#run;
    if (run !== undefined) await this.#closeRun(run);
    if (this.#closing !== undefined) await this.#closing;
    this.#referenceCount = 0;
    this.#snapshot = Object.freeze({ state: "stopped", referenceCount: 0 });
    if (this.#closeFailure !== undefined) throw this.#closeFailure;
  }

  #createStartup(): Startup {
    const waiters = new Set<() => void>();
    return {
      identity: {},
      abort: new AbortController(),
      waiters,
      signalChanged: () => {
        for (const waiter of [...waiters]) waiter();
      },
      cancelled: false,
      intentionalClose: false,
      primaryReady: false,
      proxyRace: false,
      diagnostics: new BoundedDiagnostics(),
    };
  }

  async #start(startup: Startup): Promise<ReadyRun> {
    let removeStderr: () => void = () => undefined;
    let removeExit: () => void = () => undefined;
    try {
      if (!isAbsolute(this.#options.vendoredEntryPath)) {
        throw new StudioBrokerError("mcp-entry-not-absolute", "Studio MCP entry path must be absolute");
      }
      const preflight = this.#options.preflightPort ?? preflightLoopbackPort;
      let available: boolean;
      try {
        available = await preflight(this.#options.primaryPort);
      } catch {
        throw new StudioBrokerError("mcp-preflight-failed", "Studio MCP primary-port preflight failed");
      }
      this.#assertStartupActive(startup);
      if (!available) {
        throw new StudioBrokerError(
          "mcp-primary-port-occupied",
          `Studio MCP primary port ${this.#options.primaryPort} is occupied`,
        );
      }

      const token = (this.#options.createToken ?? (() => randomBytes(32).toString("hex")))();
      if (!/^[a-f0-9]{64}$/.test(token)) {
        throw new StudioBrokerError("mcp-session-failed", "Studio MCP authentication token generation failed");
      }
      startup.token = token;
      const launch = Object.freeze({
        vendoredEntryPath: this.#options.vendoredEntryPath,
        primaryPort: this.#options.primaryPort,
        authToken: token,
        env: Object.freeze(this.#launchEnvironment(token)),
      });
      const session = await this.#options.createSession(launch);
      startup.session = session;
      this.#assertStartupActive(startup);

      removeStderr = session.onStderr((untrustedLine) => {
        const line = startup.diagnostics.add(untrustedLine, token);
        const proxy = PROXY_RECORD.exec(line);
        if (proxy !== null) {
          startup.proxyRace = true;
          startup.signalChanged();
          return;
        }
        const primary = PRIMARY_RECORD.exec(line);
        if (primary !== null) {
          if (Number(primary[1]) === this.#options.primaryPort) startup.primaryReady = true;
          else startup.mismatch = "Studio MCP primary readiness reported a different port";
          startup.signalChanged();
          return;
        }
        const anyPrimary = ANY_PRIMARY_RECORD.exec(line);
        if (anyPrimary !== null) {
          startup.mismatch = "Studio MCP primary readiness reported a different host or port";
          startup.signalChanged();
          return;
        }
        if (LEGACY_READY_RECORD.test(line)) {
          startup.legacyStatus = "listening";
          startup.signalChanged();
          return;
        }
        if (LEGACY_SKIPPED_RECORD.test(line)) {
          startup.legacyStatus = "occupied";
          startup.signalChanged();
        }
      });
      removeExit = session.onExit((result) => {
        if (startup.intentionalClose) return;
        const run = this.#run;
        if (run !== undefined && run.identity === startup.identity) {
          this.#handleUnexpectedExit(run, result);
          return;
        }
        if (this.#startup === startup) {
          startup.exit = result;
          startup.signalChanged();
        }
      });

      await this.#waitForStartup(
        startup,
        () => startup.primaryReady,
        positiveMilliseconds(this.#options.readinessTimeoutMs, 10_000),
        "mcp-readiness-timeout",
        "Studio MCP primary readiness timed out",
      );

      try {
        await this.#waitForStartup(
          startup,
          () => startup.legacyStatus !== undefined,
          positiveMilliseconds(this.#options.legacyTimeoutMs, 1_000),
          "mcp-readiness-timeout",
          "Studio MCP legacy listener status timed out",
        );
      } catch (error) {
        if (!(error instanceof StudioBrokerError && error.code === "mcp-readiness-timeout")) throw error;
      }

      this.#assertStartupActive(startup);
      const createService =
        this.#options.createService ??
        ((client: McpClientPort, gate: StudioMutationGate) => new StudioMcpService(client, gate));
      const service = createService(session.client, denyMutations);
      try {
        await service.discover();
      } catch {
        throw new StudioBrokerError("mcp-discovery-failed", "Studio MCP tool discovery failed");
      }
      this.#assertStartupActive(startup);

      const legacyStatus = startup.legacyStatus ?? "unknown";
      const ready: StudioBrokerReady = Object.freeze({
        brokerEpoch: (this.#options.createEpoch ?? (() => randomBytes(16).toString("hex")))(),
        primaryPort: this.#options.primaryPort,
        ...(legacyStatus === "listening" ? { legacyPort: 3002 as const } : {}),
        legacyStatus,
        startedAt: (this.#options.now ?? Date.now)(),
      });
      const run: ReadyRun = {
        identity: startup.identity,
        session,
        service,
        ready,
        removeStderr,
        removeExit,
        closing: false,
        invalidated: false,
      };
      this.#run = run;
      this.#startup = undefined;
      this.#publishReady(run);
      return run;
    } catch (cause) {
      const error = this.#normalizeStartupError(startup, cause);
      startup.intentionalClose = true;
      removeStderr();
      removeExit();
      let closeFailure: unknown;
      if (startup.session !== undefined) {
        try {
          await this.#closeSession(startup.session);
        } catch (caught) {
          closeFailure = caught;
          this.#closeFailure ??= findSessionCloseFailure(caught);
        }
      }
      if (this.#startup === startup) this.#startup = undefined;
      this.#referenceCount = 0;
      if (startup.cancelled) {
        this.#snapshot = Object.freeze({ state: "stopped", referenceCount: 0 });
      } else {
        this.#snapshot = Object.freeze({
          state: "error",
          referenceCount: 0,
          diagnostic: startup.diagnostics.format(error.code, error.message),
        });
      }
      if (closeFailure !== undefined) {
        throw new AggregateError([error, closeFailure], "Studio MCP startup cleanup failed.");
      }
      throw error;
    }
  }

  #normalizeStartupError(startup: Startup, cause: unknown): StudioBrokerError {
    if (startup.cancelled || startup.abort.signal.aborted) {
      return new StudioBrokerError("mcp-startup-stopped", "Studio MCP broker startup was stopped");
    }
    if (startup.proxyRace) {
      return new StudioBrokerError(
        "mcp-primary-port-race",
        `Studio MCP primary port ${this.#options.primaryPort} was claimed during startup`,
      );
    }
    if (startup.mismatch !== undefined) {
      return new StudioBrokerError("mcp-primary-mismatch", startup.mismatch);
    }
    if (startup.exit !== undefined) {
      return new StudioBrokerError("mcp-broker-exited", "Studio MCP broker exited before readiness");
    }
    if (cause instanceof StudioBrokerError) return cause;
    return new StudioBrokerError("mcp-session-failed", "Studio MCP session startup failed");
  }

  #assertStartupActive(startup: Startup): void {
    if (startup.cancelled || startup.abort.signal.aborted || this.#startup !== startup) {
      throw new StudioBrokerError("mcp-startup-stopped", "Studio MCP broker startup was stopped");
    }
    if (startup.proxyRace) {
      throw new StudioBrokerError("mcp-primary-port-race", "Studio MCP primary port was claimed during startup");
    }
    if (startup.mismatch !== undefined) {
      throw new StudioBrokerError("mcp-primary-mismatch", startup.mismatch);
    }
    if (startup.exit !== undefined) {
      throw new StudioBrokerError("mcp-broker-exited", "Studio MCP broker exited before readiness");
    }
  }

  async #waitForStartup(
    startup: Startup,
    predicate: () => boolean,
    timeoutMs: number,
    timeoutCode: StudioBrokerErrorCode,
    timeoutMessage: string,
  ): Promise<void> {
    this.#assertStartupActive(startup);
    if (predicate()) return;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        startup.waiters.delete(check);
        if (error === undefined) resolve();
        else reject(error);
      };
      const check = (): void => {
        try {
          this.#assertStartupActive(startup);
          if (predicate()) finish();
        } catch (error) {
          finish(error);
        }
      };
      const timeout = setTimeout(() => finish(new StudioBrokerError(timeoutCode, timeoutMessage)), timeoutMs);
      startup.waiters.add(check);
      check();
    });
  }

  #leaseFor(run: ReadyRun): StudioBrokerLease {
    let released = false;
    return Object.freeze({
      ready: run.ready,
      release: async () => {
        if (released) return;
        released = true;
        if (this.#run !== run || run.invalidated || run.closing) return;
        this.#referenceCount = Math.max(0, this.#referenceCount - 1);
        if (this.#referenceCount > 0) {
          this.#publishReady(run);
          return;
        }
        await this.#closeRun(run);
      },
    });
  }

  async #closeRun(run: ReadyRun): Promise<void> {
    if (run.closing) {
      if (this.#closing !== undefined) await this.#closing;
      return;
    }
    run.closing = true;
    run.removeStderr();
    run.removeExit();
    run.service.clearSelectedInstance();
    if (this.#run === run) this.#run = undefined;
    this.#referenceCount = 0;
    const closing = this.#trackClosing(this.#closeSession(run.session));
    try {
      await closing;
    } finally {
      if (this.#run === undefined && this.#startup === undefined) {
        this.#snapshot = Object.freeze({ state: "stopped", referenceCount: 0 });
      }
    }
  }

  #handleUnexpectedExit(
    run: ReadyRun,
    _result: { readonly exitCode: number | null; readonly signal: string | null },
  ): void {
    if (this.#run !== run || run.closing || run.invalidated) return;
    run.invalidated = true;
    run.removeStderr();
    run.removeExit();
    run.service.clearSelectedInstance();
    this.#run = undefined;
    this.#referenceCount = 0;
    this.#snapshot = Object.freeze({
      state: "error",
      referenceCount: 0,
      diagnostic: "mcp-broker-exited: Studio MCP broker exited unexpectedly",
    });
    this.#trackClosing(this.#closeSession(run.session));
    try {
      this.#options.onInvalidated?.("broker-exit");
    } catch {
      // Observer failure cannot revive or retain an exited owned session.
    }
  }

  #closeSession(session: StudioBrokerSession): Promise<void> {
    const existing = this.#sessionClosePromises.get(session);
    if (existing !== undefined) return existing;
    let attempted: Promise<void>;
    try {
      attempted = session.close();
    } catch {
      attempted = Promise.reject(new Error("Studio MCP session close threw synchronously"));
    }
    const closing = attempted.catch(() => {
      throw new StudioBrokerError("mcp-session-close-failed", "Studio MCP session close failed");
    });
    this.#sessionClosePromises.set(session, closing);
    return closing;
  }

  #trackClosing(closing: Promise<void>): Promise<void> {
    const previous = this.#closing;
    const barrier =
      previous === undefined || previous === closing ? closing : Promise.all([previous, closing]).then(() => undefined);
    this.#closing = barrier;
    void barrier.then(
      () => {
        if (this.#closing === barrier) this.#closing = undefined;
      },
      (error) => {
        this.#closeFailure ??= findSessionCloseFailure(error);
        if (this.#closing === barrier) this.#closing = undefined;
      },
    );
    return barrier;
  }

  #launchEnvironment(token: string): Record<string, string> {
    const inherited = this.#options.environment ?? process.env;
    const safe: Record<string, string> = {};
    for (const key of SAFE_ENVIRONMENT_KEYS) {
      const value = inherited[key];
      if (value !== undefined) safe[key] = value;
    }
    return {
      ...safe,
      ELECTRON_RUN_AS_NODE: "1",
      ROBLOX_STUDIO_HOST: "127.0.0.1",
      ROBLOX_STUDIO_PORT: String(this.#options.primaryPort),
      ROBLOX_STUDIO_AUTH_TOKEN: token,
    };
  }

  #publishStarting(): void {
    this.#snapshot = Object.freeze({ state: "starting", referenceCount: this.#referenceCount });
  }

  #publishReady(run: ReadyRun): void {
    this.#snapshot = Object.freeze({
      state: "ready",
      ready: run.ready,
      referenceCount: this.#referenceCount,
    });
  }
}

function findSessionCloseFailure(error: unknown): StudioBrokerError | undefined {
  if (error instanceof StudioBrokerError && error.code === "mcp-session-close-failed") return error;
  if (error instanceof AggregateError) {
    for (const nested of error.errors) {
      const found = findSessionCloseFailure(nested);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

class BoundedDiagnostics {
  readonly #records: { readonly value: string; readonly bytes: number }[] = [];
  #bytes = 0;

  add(untrusted: string, token?: string): string {
    const redacted = redactDiagnostic(untrusted, token);
    const value =
      Buffer.byteLength(redacted, "utf8") > MAX_DIAGNOSTIC_BYTES ? "[stderr record exceeded 32768 bytes]" : redacted;
    const framedBytes = Buffer.byteLength(value, "utf8") + 1;
    while (
      this.#records.length > 0 &&
      (this.#records.length >= MAX_DIAGNOSTIC_RECORDS || this.#bytes + framedBytes > MAX_DIAGNOSTIC_BYTES)
    ) {
      const removed = this.#records.shift();
      if (removed !== undefined) this.#bytes -= removed.bytes;
    }
    if (framedBytes <= MAX_DIAGNOSTIC_BYTES) {
      this.#records.push({ value, bytes: framedBytes });
      this.#bytes += framedBytes;
    }
    return value;
  }

  format(code: string, message: string): string {
    const prefix = `${code}: ${message}`;
    const availableBytes = MAX_DIAGNOSTIC_BYTES - Buffer.byteLength(prefix, "utf8");
    let framedBytes = 0;
    const selected: string[] = [];
    for (let index = this.#records.length - 1; index >= 0; index -= 1) {
      const record = this.#records[index];
      if (record === undefined || framedBytes + record.bytes > availableBytes) break;
      selected.push(record.value);
      framedBytes += record.bytes;
    }
    selected.reverse();
    return selected.length === 0 ? prefix : `${prefix}\n${selected.join("\n")}`;
  }
}

export async function preflightLoopbackPort(primaryPort: number): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const server = createServer();
    let settled = false;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      action();
    };
    server.once("error", (error: NodeJS.ErrnoException) => {
      finish(() => {
        if (error.code === "EADDRINUSE") resolve(false);
        else reject(error);
      });
    });
    server.listen({ host: "127.0.0.1", port: primaryPort, exclusive: true }, () => {
      server.close((error) => {
        finish(() => {
          if (error === undefined) resolve(true);
          else reject(error);
        });
      });
    });
  });
}

function positiveMilliseconds(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isFinite(value) || value <= 0 ? fallback : Math.floor(value);
}

function redactDiagnostic(value: string, exactToken?: string): string {
  let redacted =
    exactToken === undefined || exactToken.length === 0 ? value : value.split(exactToken).join("[REDACTED]");
  redacted = redacted.replace(/\bBearer\s+[^\s]+/gi, "Bearer [REDACTED]");
  return redacted.replace(
    /\b([a-z0-9_]*(?:password|passwd|secret|token|api[_-]?key|authorization|auth)[a-z0-9_]*)(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s]+)/gi,
    "$1$2[REDACTED]",
  );
}
