import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { DEFAULT_INHERITED_ENV_VARS } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it, vi } from "vitest";
import {
  createBoundedMcpClientPort,
  createStudioBrokerSession,
  type SdkClient,
  type SdkTransport,
} from "./mcp-client-port.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("createBoundedMcpClientPort", () => {
  it("bounds every SDK request and forwards the caller abort signal", async () => {
    const calls: unknown[] = [];
    const client: SdkClient = {
      connect: async () => undefined,
      listTools: async (params, options) => {
        calls.push(["list", params, options]);
        return { tools: [] };
      },
      callTool: async (input, schema, options) => {
        calls.push(["call", input, schema, options]);
        return { content: [] };
      },
      close: async () => undefined,
    };
    const port = createBoundedMcpClientPort(client, { timeoutMs: 4_000, maxTotalTimeoutMs: 5_000 });
    const abort = new AbortController();

    await port.listTools();
    await port.callTool(
      { name: "get_file_tree", arguments: { instance_id: "studio-a" } },
      { signal: abort.signal, timeoutMs: 9_000 },
    );

    expect(calls).toEqual([
      ["list", {}, { timeout: 4_000, maxTotalTimeout: 5_000 }],
      [
        "call",
        { name: "get_file_tree", arguments: { instance_id: "studio-a" } },
        undefined,
        { signal: abort.signal, timeout: 4_000, maxTotalTimeout: 5_000 },
      ],
    ]);
  });

  it("closes its SDK client exactly once", async () => {
    const close = vi.fn(async () => undefined);
    const port = createBoundedMcpClientPort({
      connect: async () => undefined,
      listTools: async () => ({ tools: [] }),
      callTool: async () => ({}),
      close,
    });

    await Promise.all([port.close(), port.close()]);

    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe("createStudioBrokerSession", () => {
  it("attaches stderr and close capture before connect and replays complete early records", async () => {
    const stderr = new PassThrough();
    const connected = deferred<undefined>();
    const order: string[] = [];
    const transport: SdkTransport = {
      stderr,
      onclose: undefined,
      close: vi.fn(async () => undefined),
    };
    const client: SdkClient = {
      connect: async (received, options) => {
        order.push(`connect:${received === transport}`);
        expect(options).toEqual({ timeout: 3_000, maxTotalTimeout: 3_000 });
        stderr.write("HTTP server listening on 127.0.0.1:58741 for Studio plugin (primary mode)\r");
        stderr.write("\n");
        await connected.promise;
      },
      listTools: async () => ({ tools: [] }),
      callTool: async () => ({}),
      close: vi.fn(async () => undefined),
    };

    const creating = createStudioBrokerSession(
      {
        vendoredEntryPath: "/Applications/RbxForge/mcp/index.js",
        primaryPort: 58741,
        authToken: "a".repeat(64),
        env: { PATH: "/usr/bin", ROBLOX_STUDIO_AUTH_TOKEN: "a".repeat(64) },
      },
      {
        createTransport: (parameters) => {
          order.push("transport");
          expect(parameters).toMatchObject({
            command: process.execPath,
            args: ["/Applications/RbxForge/mcp/index.js"],
            env: {
              PATH: "/usr/bin",
              ELECTRON_RUN_AS_NODE: "1",
              ROBLOX_STUDIO_HOST: "127.0.0.1",
              ROBLOX_STUDIO_PORT: "58741",
              ROBLOX_STUDIO_AUTH_TOKEN: "a".repeat(64),
            },
            stderr: "pipe",
          });
          for (const key of DEFAULT_INHERITED_ENV_VARS) {
            if (key !== "PATH") expect(parameters.env?.[key]).toBe("");
          }
          return transport;
        },
        createClient: (info) => {
          order.push("client");
          expect(info).toEqual({ name: "rbxforge-desktop", version: "0.1.0" });
          return client;
        },
        connectTimeoutMs: 3_000,
      },
    );
    connected.resolve(undefined);
    const session = await creating;
    await new Promise<void>((resolve) => setImmediate(resolve));
    const records: string[] = [];
    session.onStderr((record) => records.push(record));

    expect(order).toEqual(["transport", "client", "connect:true"]);
    expect(records).toEqual(["HTTP server listening on 127.0.0.1:58741 for Studio plugin (primary mode)"]);
    expect(transport.onclose).toBeTypeOf("function");
  });

  it("bounds completed history and unterminated UTF-8 input without turning a suffix into a valid record", async () => {
    const stderr = new PassThrough();
    const transport: SdkTransport = { stderr, onclose: undefined, close: async () => undefined };
    const client: SdkClient = {
      connect: async () => undefined,
      listTools: async () => ({ tools: [] }),
      callTool: async () => ({}),
      close: async () => undefined,
    };
    const session = await createStudioBrokerSession(
      {
        vendoredEntryPath: "/mcp/index.js",
        primaryPort: 58741,
        authToken: "b".repeat(64),
        env: {},
      },
      { createTransport: () => transport, createClient: () => client },
    );
    stderr.write(Buffer.from("é".repeat(17_000)));
    stderr.write(Buffer.from("\nHTTP server listening on 127.0.0.1:58741 for Studio plugin (primary mode)\n"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    const initialRecords: string[] = [];
    const unsubscribe = session.onStderr((record) => initialRecords.push(record));
    expect(initialRecords).toEqual([
      "[stderr record exceeded 32768 bytes]",
      "HTTP server listening on 127.0.0.1:58741 for Studio plugin (primary mode)",
    ]);
    unsubscribe();

    stderr.write(`${"x".repeat(20_000)}\n${"y".repeat(20_000)}\n`);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const boundedReplay: string[] = [];
    session.onStderr((record) => boundedReplay.push(record));
    expect(Buffer.byteLength(boundedReplay.join("\n"), "utf8")).toBeLessThanOrEqual(32_768);
  });

  it("bounds blank-line replay by framed bytes and record count", async () => {
    const stderr = new PassThrough();
    const transport: SdkTransport = { stderr, onclose: undefined, close: async () => undefined };
    const client: SdkClient = {
      connect: async () => undefined,
      listTools: async () => ({ tools: [] }),
      callTool: async () => ({}),
      close: async () => undefined,
    };
    const session = await createStudioBrokerSession(
      { vendoredEntryPath: "/mcp/index.js", primaryPort: 58741, authToken: "f".repeat(64), env: {} },
      { createTransport: () => transport, createClient: () => client },
    );

    stderr.write("\n".repeat(10_000));
    await new Promise<void>((resolve) => setImmediate(resolve));
    const replay: string[] = [];
    session.onStderr((record) => replay.push(record));

    expect(replay.length).toBeLessThanOrEqual(512);
    expect(Buffer.byteLength(replay.join("\n"), "utf8")).toBeLessThanOrEqual(32_768);
  });

  it("redacts the exact token and generic secret-like values before replay or exposure", async () => {
    const stderr = new PassThrough();
    const token = "c".repeat(64);
    const transport: SdkTransport = { stderr, onclose: undefined, close: async () => undefined };
    const client: SdkClient = {
      connect: async () => {
        stderr.write(`token=${token} password=hunter2 API_KEY=key-value Bearer abc.def.ghi\n`);
      },
      listTools: async () => ({ tools: [] }),
      callTool: async () => ({}),
      close: async () => undefined,
    };
    const session = await createStudioBrokerSession(
      { vendoredEntryPath: "/mcp/index.js", primaryPort: 58741, authToken: token, env: {} },
      { createTransport: () => transport, createClient: () => client },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    const records: string[] = [];
    session.onStderr((record) => records.push(record));

    expect(records.join("\n")).not.toContain(token);
    expect(records.join("\n")).not.toContain("hunter2");
    expect(records.join("\n")).not.toContain("key-value");
    expect(records.join("\n")).not.toContain("abc.def.ghi");
    expect(records.join("\n")).toContain("[REDACTED]");
  });

  it("preserves the SDK transport close callback and emits one public exit", async () => {
    const stderr = new EventEmitter() as PassThrough;
    const sdkClose = vi.fn();
    const transport: SdkTransport = { stderr, onclose: sdkClose, close: async () => undefined };
    const client: SdkClient = {
      connect: async (received) => {
        const prior = received.onclose;
        received.onclose = () => {
          prior?.();
        };
      },
      listTools: async () => ({ tools: [] }),
      callTool: async () => ({}),
      close: async () => undefined,
    };
    const session = await createStudioBrokerSession(
      { vendoredEntryPath: "/mcp/index.js", primaryPort: 58741, authToken: "d".repeat(64), env: {} },
      { createTransport: () => transport, createClient: () => client },
    );
    const exits: unknown[] = [];
    session.onExit((result) => exits.push(result));

    transport.onclose?.();
    transport.onclose?.();

    expect(sdkClose).toHaveBeenCalledTimes(2);
    expect(exits).toEqual([{ exitCode: null, signal: null }]);
  });

  it("closes the exact SDK client once when initialization fails", async () => {
    const stderr = new PassThrough();
    const close = vi.fn(async () => undefined);
    const transport: SdkTransport = { stderr, onclose: undefined, close: async () => undefined };
    const client: SdkClient = {
      connect: async () => {
        throw new Error("initialize failed");
      },
      listTools: async () => ({ tools: [] }),
      callTool: async () => ({}),
      close,
    };

    await expect(
      createStudioBrokerSession(
        { vendoredEntryPath: "/mcp/index.js", primaryPort: 58741, authToken: "e".repeat(64), env: {} },
        { createTransport: () => transport, createClient: () => client },
      ),
    ).rejects.toThrow("initialize failed");

    expect(close).toHaveBeenCalledTimes(1);
    expect(stderr.listenerCount("data")).toBe(0);
  });

  it("overrides every SDK-default inherited key before an actual child spawn", async () => {
    const root = await mkdtemp(join(tmpdir(), "rbxforge-mcp-env-"));
    const entry = join(root, "server.mjs");
    const originalEnvironment = new Map<string, string | undefined>();
    const hostile = "hostile-parent-value";
    for (const key of [...DEFAULT_INHERITED_ENV_VARS, "NODE_OPTIONS"]) {
      originalEnvironment.set(key, process.env[key]);
      process.env[key] = hostile;
    }
    await writeFile(
      entry,
      [
        `const defaultKeys = ${JSON.stringify(DEFAULT_INHERITED_ENV_VARS)};`,
        `const report = { defaults: Object.fromEntries(defaultKeys.map((key) => [key, process.env[key]])), hostileSeen: Object.values(process.env).includes(${JSON.stringify(hostile)}), mixedPathSeen: Object.keys(process.env).includes("Path"), unsafeSeen: Object.keys(process.env).includes("UNSAFE_SECRET"), nodeOptionsSeen: Object.keys(process.env).includes("NODE_OPTIONS"), electronForced: process.env.ELECTRON_RUN_AS_NODE === "1", hostForced: process.env.ROBLOX_STUDIO_HOST === "127.0.0.1", portForced: process.env.ROBLOX_STUDIO_PORT === "58741", tokenForced: process.env.ROBLOX_STUDIO_AUTH_TOKEN === ${JSON.stringify("9".repeat(64))} };`,
        "process.stderr.write(`CHILD_ENV ${JSON.stringify(report)}\\n`);",
        'process.stdin.setEncoding("utf8");',
        'let pending = "";',
        'process.stdin.on("data", (chunk) => {',
        "  pending += chunk;",
        '  for (let newline = pending.indexOf("\\n"); newline !== -1; newline = pending.indexOf("\\n")) {',
        "    const raw = pending.slice(0, newline);",
        "    pending = pending.slice(newline + 1);",
        "    if (raw.length === 0) continue;",
        "    const message = JSON.parse(raw);",
        '    if (message.method === "initialize") {',
        '      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "env-fixture", version: "1" } } }) + "\\n");',
        '    } else if (message.method === "tools/list") {',
        '      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: [] } }) + "\\n");',
        "    }",
        "  }",
        "});",
      ].join("\n"),
      "utf8",
    );

    let session: Awaited<ReturnType<typeof createStudioBrokerSession>> | undefined;
    try {
      session = await createStudioBrokerSession({
        vendoredEntryPath: entry,
        primaryPort: 58741,
        authToken: "9".repeat(64),
        env: {
          PATH: "/approved/path",
          Path: "hostile-mixed-case",
          UNSAFE_SECRET: "must-not-pass",
          ELECTRON_RUN_AS_NODE: "wrong",
          ROBLOX_STUDIO_HOST: "0.0.0.0",
          ROBLOX_STUDIO_PORT: "1",
          ROBLOX_STUDIO_AUTH_TOKEN: "wrong",
        },
      });
      const records: string[] = [];
      session.onStderr((record) => records.push(record));
      const record = records.find((candidate) => candidate.startsWith("CHILD_ENV "));
      expect(record).toBeDefined();
      const report = JSON.parse(record?.slice("CHILD_ENV ".length) ?? "{}") as {
        readonly defaults: Record<string, string>;
        readonly hostileSeen: boolean;
        readonly mixedPathSeen: boolean;
        readonly unsafeSeen: boolean;
        readonly nodeOptionsSeen: boolean;
        readonly electronForced: boolean;
        readonly hostForced: boolean;
        readonly portForced: boolean;
        readonly tokenForced: boolean;
      };

      expect(report).toMatchObject({
        hostileSeen: false,
        mixedPathSeen: false,
        unsafeSeen: false,
        nodeOptionsSeen: false,
        electronForced: true,
        hostForced: true,
        portForced: true,
        tokenForced: true,
      });
      for (const key of DEFAULT_INHERITED_ENV_VARS) {
        expect(report.defaults[key]).toBe(key === "PATH" ? "/approved/path" : "");
      }
    } finally {
      await session?.close();
      for (const [key, value] of originalEnvironment) {
        if (value === undefined) Reflect.deleteProperty(process.env, key);
        else process.env[key] = value;
      }
      await rm(root, { recursive: true, force: true });
    }
  });
});
