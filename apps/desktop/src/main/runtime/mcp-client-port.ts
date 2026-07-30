import { isAbsolute } from "node:path";
import type { Stream } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  DEFAULT_INHERITED_ENV_VARS,
  StdioClientTransport,
  type StdioServerParameters,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import type { McpCallOptions, McpClientPort } from "@rbxforge/studio-mcp";
import type { StudioBrokerLaunch, StudioBrokerSession } from "./studio-broker-controller.js";

const MAX_STDERR_BYTES = 32_768;
const MAX_STDERR_RECORDS = 512;
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const ALL_SDK_DEFAULT_ENVIRONMENT_KEYS = Object.freeze(
  Array.from(
    new Set([
      ...DEFAULT_INHERITED_ENV_VARS,
      "APPDATA",
      "HOMEDRIVE",
      "HOMEPATH",
      "LOCALAPPDATA",
      "PATH",
      "PROCESSOR_ARCHITECTURE",
      "SYSTEMDRIVE",
      "SYSTEMROOT",
      "TEMP",
      "USERNAME",
      "USERPROFILE",
      "PROGRAMFILES",
      "HOME",
      "LOGNAME",
      "SHELL",
      "TERM",
      "USER",
    ]),
  ),
);
const APPROVED_CHILD_ENVIRONMENT_KEYS = Object.freeze([
  "PATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TMPDIR",
  "SYSTEMROOT",
  "WINDIR",
  "PATHEXT",
] as const);

interface SdkRequestOptions {
  readonly signal?: AbortSignal;
  readonly timeout: number;
  readonly maxTotalTimeout: number;
}

export interface SdkTransport {
  readonly stderr: Pick<Stream, "on" | "off"> | null;
  onclose: (() => void) | undefined;
  close(): Promise<void>;
}

export interface SdkClient {
  connect(transport: SdkTransport, options?: SdkRequestOptions): Promise<void>;
  listTools(
    params?: Record<string, never>,
    options?: SdkRequestOptions,
  ): Promise<{ tools: readonly { name: string; inputSchema?: unknown }[] }>;
  callTool(
    input: { name: string; arguments: Record<string, unknown> },
    resultSchema?: undefined,
    options?: SdkRequestOptions,
  ): Promise<unknown>;
  close(): Promise<void>;
}

export interface McpClientPortOptions {
  readonly timeoutMs?: number;
  readonly maxTotalTimeoutMs?: number;
}

export interface StudioBrokerSessionFactoryDependencies {
  readonly createTransport?: (parameters: StdioServerParameters) => SdkTransport;
  readonly createClient?: (info: { readonly name: string; readonly version: string }) => SdkClient;
  readonly connectTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly maxTotalTimeoutMs?: number;
}

export function createBoundedMcpClientPort(client: SdkClient, options: McpClientPortOptions = {}): McpClientPort {
  const timeoutMs = positiveBound(options.timeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
  const maxTotalTimeoutMs = positiveBound(options.maxTotalTimeoutMs, timeoutMs);
  let closePromise: Promise<void> | undefined;

  const requestOptions = (call?: McpCallOptions): SdkRequestOptions => {
    const requestedTimeout = positiveBound(call?.timeoutMs, timeoutMs);
    return {
      ...(call?.signal === undefined ? {} : { signal: call.signal }),
      timeout: Math.min(requestedTimeout, timeoutMs),
      maxTotalTimeout: maxTotalTimeoutMs,
    };
  };

  const port: McpClientPort = {
    async listTools() {
      const result = await client.listTools({}, requestOptions());
      return {
        tools: result.tools.map((tool) => ({
          name: tool.name,
          inputSchema: tool.inputSchema,
        })),
      };
    },
    callTool(input: { name: string; arguments: Record<string, unknown> }, callOptions?: McpCallOptions) {
      return client.callTool(input, undefined, requestOptions(callOptions));
    },
    close() {
      closePromise ??= client.close();
      return closePromise;
    },
  };
  return Object.freeze(port);
}

export async function createStudioBrokerSession(
  launch: StudioBrokerLaunch,
  dependencies: StudioBrokerSessionFactoryDependencies = {},
): Promise<StudioBrokerSession> {
  if (!isAbsolute(launch.vendoredEntryPath)) {
    throw new Error("Studio MCP entry path must be absolute");
  }

  const createTransport =
    dependencies.createTransport ??
    ((parameters: StdioServerParameters) => new StdioClientTransport(parameters) as unknown as SdkTransport);
  const createClient =
    dependencies.createClient ??
    ((info: { readonly name: string; readonly version: string }) => new Client(info) as unknown as SdkClient);
  const connectTimeoutMs = positiveBound(dependencies.connectTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
  const transport = createTransport({
    command: process.execPath,
    args: [launch.vendoredEntryPath],
    env: isolatedChildEnvironment(launch),
    stderr: "pipe",
  });
  const client = createClient({ name: "rbxforge-desktop", version: "0.1.0" });
  transport.close = onceAsync(transport.close.bind(transport));
  client.close = onceAsync(client.close.bind(client));
  const stderr = new BoundedStderrRecords(launch.authToken);
  const exitListeners = new Set<
    (result: { readonly exitCode: number | null; readonly signal: string | null }) => void
  >();
  let exited = false;

  const onData = (chunk: unknown): void => {
    if (typeof chunk === "string" || Buffer.isBuffer(chunk) || chunk instanceof Uint8Array) {
      stderr.push(chunk);
    }
  };
  transport.stderr?.on("data", onData);

  const inheritedClose = transport.onclose;
  transport.onclose = () => {
    inheritedClose?.();
    if (exited) return;
    exited = true;
    for (const listener of [...exitListeners]) {
      listener({ exitCode: null, signal: null });
    }
  };

  try {
    await client.connect(transport, {
      timeout: connectTimeoutMs,
      maxTotalTimeout: connectTimeoutMs,
    });
  } catch (error) {
    transport.stderr?.off("data", onData);
    await client.close().catch(() => transport.close().catch(() => undefined));
    throw error;
  }

  const port = createBoundedMcpClientPort(client, {
    ...(dependencies.requestTimeoutMs === undefined ? {} : { timeoutMs: dependencies.requestTimeoutMs }),
    ...(dependencies.maxTotalTimeoutMs === undefined ? {} : { maxTotalTimeoutMs: dependencies.maxTotalTimeoutMs }),
  });

  return Object.freeze({
    client: port,
    onStderr(listener: (line: string) => void) {
      return stderr.subscribe(listener);
    },
    onExit(listener: (result: { readonly exitCode: number | null; readonly signal: string | null }) => void) {
      exitListeners.add(listener);
      if (exited) listener({ exitCode: null, signal: null });
      return () => exitListeners.delete(listener);
    },
    close() {
      transport.stderr?.off("data", onData);
      return port.close();
    },
  });
}

class BoundedStderrRecords {
  readonly #listeners = new Set<(record: string) => void>();
  readonly #history: { readonly record: string; readonly bytes: number }[] = [];
  readonly #authToken: string;
  #historyBytes = 0;
  #partial = Buffer.alloc(0);
  #discardingOversized = false;

  constructor(authToken: string) {
    this.#authToken = authToken;
  }

  subscribe(listener: (record: string) => void): () => void {
    this.#listeners.add(listener);
    for (const { record } of this.#history) listener(record);
    return () => this.#listeners.delete(listener);
  }

  push(chunk: string | Uint8Array): void {
    let bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (this.#discardingOversized) {
      const newline = bytes.indexOf(0x0a);
      if (newline === -1) return;
      this.#discardingOversized = false;
      this.#emit("[stderr record exceeded 32768 bytes]");
      bytes = bytes.subarray(newline + 1);
    }

    let combined = this.#partial.length === 0 ? bytes : Buffer.concat([this.#partial, bytes]);
    this.#partial = Buffer.alloc(0);
    let newline = combined.indexOf(0x0a);
    while (newline !== -1) {
      const line = combined.subarray(0, newline);
      this.#emitBytes(line.length > 0 && line[line.length - 1] === 0x0d ? line.subarray(0, -1) : line);
      combined = combined.subarray(newline + 1);
      newline = combined.indexOf(0x0a);
    }

    if (combined.length > MAX_STDERR_BYTES) {
      this.#discardingOversized = true;
      return;
    }
    this.#partial = Buffer.from(combined);
  }

  #emitBytes(bytes: Buffer): void {
    if (bytes.length > MAX_STDERR_BYTES) {
      this.#emit("[stderr record exceeded 32768 bytes]");
      return;
    }
    this.#emit(redactDiagnostic(bytes.toString("utf8"), this.#authToken));
  }

  #emit(record: string): void {
    const boundedRecord = boundUtf8(record, MAX_STDERR_BYTES);
    const framedBytes = Buffer.byteLength(boundedRecord, "utf8") + 1;
    while (
      this.#history.length > 0 &&
      (this.#history.length >= MAX_STDERR_RECORDS || this.#historyBytes + framedBytes > MAX_STDERR_BYTES)
    ) {
      const removed = this.#history.shift();
      if (removed !== undefined) this.#historyBytes -= removed.bytes;
    }
    if (framedBytes <= MAX_STDERR_BYTES) {
      this.#history.push({ record: boundedRecord, bytes: framedBytes });
      this.#historyBytes += framedBytes;
    }
    for (const listener of [...this.#listeners]) listener(boundedRecord);
  }
}

function positiveBound(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isFinite(value) || value <= 0 ? fallback : Math.floor(value);
}

function onceAsync(action: () => Promise<void>): () => Promise<void> {
  let pending: Promise<void> | undefined;
  return () => {
    pending ??= action();
    return pending;
  };
}

function isolatedChildEnvironment(launch: StudioBrokerLaunch): Record<string, string> {
  const environment: Record<string, string> = {};
  const approvedKeys = new Set<string>(APPROVED_CHILD_ENVIRONMENT_KEYS);
  for (const key of ALL_SDK_DEFAULT_ENVIRONMENT_KEYS) {
    environment[key] = approvedKeys.has(key) ? safeEnvironmentValue(launch.env[key]) : "";
  }
  for (const key of APPROVED_CHILD_ENVIRONMENT_KEYS) {
    if (ALL_SDK_DEFAULT_ENVIRONMENT_KEYS.includes(key)) continue;
    const value = safeEnvironmentValue(launch.env[key]);
    if (value !== "") environment[key] = value;
  }
  return {
    ...environment,
    ELECTRON_RUN_AS_NODE: "1",
    ROBLOX_STUDIO_HOST: "127.0.0.1",
    ROBLOX_STUDIO_PORT: String(launch.primaryPort),
    ROBLOX_STUDIO_AUTH_TOKEN: launch.authToken,
  };
}

function safeEnvironmentValue(value: string | undefined): string {
  if (value === undefined || value.includes("\0") || value.startsWith("()")) return "";
  return value;
}

function redactDiagnostic(value: string, exactToken?: string): string {
  let redacted =
    exactToken === undefined || exactToken.length === 0 ? value : value.split(exactToken).join("[REDACTED]");
  redacted = redacted.replace(/\bBearer\s+[^\s]+/gi, "Bearer [REDACTED]");
  redacted = redacted.replace(
    /\b([a-z0-9_]*(?:password|passwd|secret|token|api[_-]?key|authorization|auth)[a-z0-9_]*)(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s]+)/gi,
    "$1$2[REDACTED]",
  );
  return redacted;
}

function boundUtf8(value: string, maximumBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maximumBytes) return value;
  return bytes
    .subarray(0, maximumBytes)
    .toString("utf8")
    .replace(/\uFFFD$/u, "");
}
