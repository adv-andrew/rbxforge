import { describe, expect, test, vi } from "vitest";

import { CapabilityUnavailableError, McpResponseError, StudioMcpService, type McpClientPort } from "./index.js";

const allTools = ["get_connected_instances", "solo_playtest", "get_runtime_logs", "capture_screenshot"].map((name) => ({
  name,
  inputSchema: {},
}));

const instance = {
  instanceId: "place:1",
  role: "edit",
  placeId: 1,
  placeName: "Place",
  dataModelName: "Place",
  isRunning: false,
  pluginVersion: "2.22.5",
  pluginVariant: "stable",
  serverVersion: "2.22.5",
  versionMismatch: false,
  lastActivity: 1,
  connectedAt: 1,
};

const text = (value: object): object => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
});

class Client implements McpClientPort {
  readonly calls: Array<{
    readonly input: { readonly name: string; readonly arguments: Record<string, unknown> };
    readonly options?: { readonly signal?: AbortSignal; readonly timeoutMs?: number };
  }> = [];
  readonly responses: unknown[];
  readonly onCall:
    ((input: { readonly name: string; readonly arguments: Record<string, unknown> }) => void) | undefined;
  constructor(
    responses: unknown[],
    onCall?: (input: { readonly name: string; readonly arguments: Record<string, unknown> }) => void,
  ) {
    this.responses = [...responses];
    this.onCall = onCall;
  }
  async listTools(): Promise<{ tools: readonly { name: string; inputSchema: unknown }[] }> {
    return { tools: allTools };
  }
  async callTool(
    input: { name: string; arguments: Record<string, unknown> },
    options?: { readonly signal?: AbortSignal; readonly timeoutMs?: number },
  ): Promise<unknown> {
    this.calls.push({ input, ...(options === undefined ? {} : { options }) });
    this.onCall?.(input);
    return this.responses.shift();
  }
  async close(): Promise<void> {}
}

class TailRespectingClient implements McpClientPort {
  readonly calls: Array<{ readonly name: string; readonly arguments: Record<string, unknown> }> = [];
  constructor(
    readonly roles: readonly string[],
    readonly rowsByRole: Readonly<
      Record<
        string,
        readonly {
          readonly seq: number;
          readonly ts: number;
          readonly level: "INFO";
          readonly message: string;
        }[]
      >
    >,
  ) {}
  async listTools(): Promise<{ tools: readonly { name: string; inputSchema: unknown }[] }> {
    return { tools: allTools };
  }
  async callTool(input: { name: string; arguments: Record<string, unknown> }): Promise<unknown> {
    this.calls.push(input);
    if (input.name === "get_connected_instances") {
      return text({ instances: [instance], count: 1 });
    }
    if (input.name === "solo_playtest") {
      return text({ success: true, action: "status", running: true, roles: this.roles });
    }
    const role = String(input.arguments.target);
    const tail = Number(input.arguments.tail);
    const rows = this.rowsByRole[role] ?? [];
    return text({
      entries: rows.slice(-tail),
      totalDropped: 0,
      nextSince: rows.at(-1)?.seq ?? 0,
      capturedBy: role,
    });
  }
  async close(): Promise<void> {}
}

const gate = {
  authorize: vi.fn(async () => ({ approved: true as const, authorizationId: "approved-playtest-command" })),
  consume: vi.fn(),
};

async function selected(client: McpClientPort): Promise<StudioMcpService> {
  const service = new StudioMcpService(client, gate);
  await service.listConnectedInstances();
  service.selectInstance(instance.instanceId);
  return service;
}

describe("Studio playtest capabilities", () => {
  test("status is an exact allowlisted read while action smuggling is rejected", async () => {
    const client = new Client([
      text({ instances: [instance], count: 1 }),
      text({ success: true, action: "status", running: true, roles: ["edit", "server"] }),
    ]);
    const service = await selected(client);
    const signal = new AbortController().signal;

    await expect(
      service.playtestStatus({
        expectedInstanceId: instance.instanceId,
        signal,
      }),
    ).resolves.toMatchObject({ running: true, action: "status" });
    expect(client.calls[1]?.input).toEqual({
      name: "solo_playtest",
      arguments: { action: "status", instance_id: "place:1" },
    });
    await expect(service.callRead("solo_playtest", { action: "start", mode: "play" })).rejects.toThrow(
      "not an allowed read",
    );
  });

  test("start and stop authorize exactly once and reject mismatched actions", async () => {
    gate.authorize.mockClear();
    gate.consume.mockClear();
    const client = new Client([
      text({ instances: [instance], count: 1 }),
      text({ success: true, action: "start", message: "ready", roles: ["server"] }),
      text({ success: true, action: "status", message: "wrong" }),
    ]);
    const service = await selected(client);
    const context = {
      ownership: "studio" as const,
      expectedInstanceId: "place:1",
      expectedGraphRevision: 4,
    };

    await expect(
      service.startPlaytest("run", context, {
        signal: new AbortController().signal,
        timeoutSeconds: 12,
      }),
    ).resolves.toMatchObject({ success: true, action: "start" });
    expect(gate.authorize).toHaveBeenCalledTimes(1);
    expect(gate.consume).toHaveBeenCalledTimes(1);
    expect(client.calls[1]?.input.arguments).toEqual({
      action: "start",
      mode: "run",
      timeout: 12,
      instance_id: "place:1",
    });
    await expect(
      service.stopPlaytest(context, {
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(McpResponseError);
    expect(gate.authorize).toHaveBeenCalledTimes(2);
  });

  test("normalizes bounded logs without claiming script origin", async () => {
    const client = new Client([
      text({ instances: [instance], count: 1 }),
      text({
        entries: [{ seq: 2, ts: 10, level: "WARN", message: "literal [x]", capturedBy: "server" }],
        totalDropped: 3,
        perCaptureNextSince: { server: 2 },
        perCaptureErrors: { "client-1": "gone" },
      }),
    ]);
    const service = await selected(client);

    const result = await service.runtimeLogs(1, {
      expectedInstanceId: "place:1",
      signal: new AbortController().signal,
      filter: "[x]",
    });
    expect(result).toMatchObject({
      totalDropped: 3,
      perCaptureNextSince: { server: 2 },
      perCaptureErrors: { "client-1": "Runtime log capture failed" },
    });
    expect(result.entries[0]).toMatchObject({ capturedBy: "server" });
    expect(client.calls[1]?.input.arguments).toMatchObject({
      target: "all",
      since: 1,
      filter: "[x]",
      instance_id: "place:1",
    });
  });

  test("parses the dedicated screenshot blocks and enforces decoded size", async () => {
    const client = new Client([
      text({ instances: [instance], count: 1 }),
      text({ success: true, action: "status", running: true, roles: ["edit", "client-1"] }),
      {
        content: [
          { type: "text", text: "Screenshot 2x3px (jpeg q92). Native viewport." },
          { type: "image", data: "AQID", mimeType: "image/jpeg" },
        ],
      },
    ]);
    const service = await selected(client);

    await expect(
      service.captureScreenshot({
        expectedInstanceId: "place:1",
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      data: "AQID",
      mimeType: "image/jpeg",
      width: 2,
      height: 3,
      quality: 92,
      target: "client-1",
    });
  });

  test("reports absent canonical capabilities and ignores deprecated aliases", async () => {
    const client: McpClientPort = {
      listTools: async () => ({
        tools: [
          { name: "get_connected_instances", inputSchema: {} },
          { name: "start_playtest", inputSchema: {} },
          { name: "stop_playtest", inputSchema: {} },
        ],
      }),
      callTool: async () => text({ instances: [instance], count: 1 }),
      close: async () => undefined,
    };
    const service = new StudioMcpService(client, gate);
    await service.listConnectedInstances();
    service.selectInstance(instance.instanceId);
    await expect(
      service.playtestStatus({
        expectedInstanceId: "place:1",
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(CapabilityUnavailableError);
    expect(service.snapshot().capabilities.soloPlaytest).toBeUndefined();
  });

  test("enforces timeout locally and propagates cancellation to clients that never settle", async () => {
    let receivedSignal: AbortSignal | undefined;
    const client: McpClientPort = {
      listTools: async () => ({ tools: allTools }),
      callTool: async (input, options) => {
        if (input.name === "get_connected_instances") return text({ instances: [instance], count: 1 });
        receivedSignal = options?.signal;
        return new Promise<never>(() => undefined);
      },
      close: async () => undefined,
    };
    const service = await selected(client);
    await expect(
      service.playtestStatus({
        expectedInstanceId: "place:1",
        signal: new AbortController().signal,
        timeoutMs: 1,
      }),
    ).rejects.toThrow("timed out");
    expect(receivedSignal?.aborted).toBe(true);
  });

  test("discovers new runtime roles before cursor fanout and polls them from the beginning", async () => {
    const client = new Client([
      text({ instances: [instance], count: 1 }),
      text({ success: true, action: "status", running: true, roles: ["server", "client-1"] }),
      text({ entries: [], totalDropped: 0, nextSince: 10, capturedBy: "server" }),
      text({
        entries: [{ seq: 1, ts: 1, level: "OUT", message: "client", capturedBy: "client-1" }],
        totalDropped: 0,
        nextSince: 1,
        capturedBy: "client-1",
      }),
    ]);
    const service = await selected(client);

    const result = await service.runtimeLogs(
      { server: 9 },
      {
        expectedInstanceId: "place:1",
        signal: new AbortController().signal,
      },
    );

    expect(client.calls.slice(1).map(({ input }) => input)).toEqual([
      { name: "solo_playtest", arguments: { action: "status", instance_id: "place:1" } },
      { name: "get_runtime_logs", arguments: { target: "server", since: 9, tail: 2000, instance_id: "place:1" } },
      { name: "get_runtime_logs", arguments: { target: "client-1", tail: 2000, instance_id: "place:1" } },
    ]);
    expect(result.perCaptureNextSince).toEqual({ server: 10, "client-1": 1 });
  });

  test("retains newest aggregate rows and normalizes untrusted per-role errors", async () => {
    const rows = (offset: number) =>
      Array.from({ length: 1_100 }, (_, index) => ({
        seq: offset + index,
        ts: offset + index,
        level: "INFO",
        message: `row-${offset + index}`,
      }));
    const client = new Client([
      text({ instances: [instance], count: 1 }),
      text({ success: true, action: "status", running: true, roles: ["server", "client-1"] }),
      text({ entries: rows(0), totalDropped: 0, nextSince: 1_099, capturedBy: "server" }),
      text({
        entries: rows(1_100),
        totalDropped: 0,
        nextSince: 2_199,
        capturedBy: "client-1",
        perCaptureErrors: { edit: "SECRET_process_output" },
      }),
    ]);
    const service = await selected(client);

    const result = await service.runtimeLogs(
      { server: 0, "client-1": 0 },
      {
        expectedInstanceId: "place:1",
        signal: new AbortController().signal,
      },
    );

    expect(result.entries).toHaveLength(2_000);
    expect(result.entries[0]?.message).toBe("row-200");
    expect(result.entries.at(-1)?.message).toBe("row-2199");
    expect(JSON.stringify(result.perCaptureErrors)).not.toContain("SECRET_process_output");
  });

  test("rejects an over-row-limit response before cloning its entries", async () => {
    const client = new Client([
      text({ instances: [instance], count: 1 }),
      text({
        entries: Array.from({ length: 2_001 }, (_, seq) => ({
          seq,
          ts: seq,
          level: "INFO",
          message: "bounded",
        })),
        totalDropped: 0,
        perCaptureNextSince: {},
      }),
    ]);
    const service = await selected(client);
    await expect(
      service.runtimeLogs(undefined, {
        expectedInstanceId: "place:1",
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("Runtime logs response");
  });

  test("rejects oversized raw log text before attempting JSON parsing", async () => {
    const client = new Client([
      text({ instances: [instance], count: 1 }),
      {
        content: [
          {
            type: "text",
            text: `${" ".repeat(3 * 1_024 * 1_024 + 1)}not-json`,
          },
        ],
      },
    ]);
    const service = await selected(client);

    await expect(
      service.runtimeLogs(undefined, {
        expectedInstanceId: "place:1",
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("exceeds the allowed size");
  });

  test("prunes departed runtime roles from authoritative status fanout", async () => {
    const client = new Client([
      text({ instances: [instance], count: 1 }),
      text({ success: true, action: "status", running: true, roles: ["server"] }),
      text({ entries: [], totalDropped: 0, nextSince: 11, capturedBy: "server" }),
    ]);
    const service = await selected(client);

    const result = await service.runtimeLogs(
      { server: 10, "client-1": 4 },
      {
        expectedInstanceId: "place:1",
        signal: new AbortController().signal,
      },
    );

    expect(client.calls.slice(1).map(({ input }) => input.arguments.target)).toEqual([undefined, "server"]);
    expect(result.perCaptureNextSince).toEqual({ server: 11 });
  });

  test("applies a small requested tail across multi-role fanout", async () => {
    const roles = ["server", "client-1", "client-2"];
    const client = new Client([
      text({ instances: [instance], count: 1 }),
      text({ success: true, action: "status", running: true, roles }),
      ...roles.map((role, index) =>
        text({
          entries: [{ seq: 1, ts: index + 1, level: "INFO", message: role }],
          totalDropped: 0,
          nextSince: 1,
          capturedBy: role,
        }),
      ),
    ]);
    const service = await selected(client);

    const result = await service.runtimeLogs(
      { server: 0 },
      {
        expectedInstanceId: "place:1",
        signal: new AbortController().signal,
        tail: 2,
      },
    );

    expect(client.calls.slice(2).map(({ input }) => input.arguments.tail)).toEqual([2, 2, 2]);
    expect(result.entries.map(({ message }) => message)).toEqual(["client-1", "client-2"]);
    expect(result.totalDropped).toBe(1);
  });

  test("preserves an uneven newest global tail instead of dividing it across roles", async () => {
    const rows = Array.from({ length: 5 }, (_, index) => ({
      seq: index + 1,
      ts: index + 1,
      level: "INFO" as const,
      message: `server-${index + 1}`,
    }));
    const client = new TailRespectingClient(["server", "client-1"], { server: rows, "client-1": [] });
    const service = await selected(client);

    const result = await service.runtimeLogs(
      { server: 0, "client-1": 0 },
      {
        expectedInstanceId: "place:1",
        signal: new AbortController().signal,
        tail: 5,
      },
    );

    expect(
      client.calls.filter(({ name }) => name === "get_runtime_logs").map(({ arguments: input }) => input.tail),
    ).toEqual([5, 5]);
    expect(result.entries.map(({ message }) => message)).toEqual([
      "server-1",
      "server-2",
      "server-3",
      "server-4",
      "server-5",
    ]);
  });

  test("preserves a non-divisible global tail across three roles", async () => {
    const rows = (role: string, offset: number) =>
      Array.from({ length: 2 }, (_, index) => ({
        seq: index + 1,
        ts: offset + index,
        level: "INFO" as const,
        message: `${role}-${index + 1}`,
      }));
    const client = new TailRespectingClient(["server", "client-1", "client-2"], {
      server: rows("server", 1),
      "client-1": rows("client-1", 3),
      "client-2": rows("client-2", 5),
    });
    const service = await selected(client);

    const result = await service.runtimeLogs(
      { server: 0 },
      {
        expectedInstanceId: "place:1",
        signal: new AbortController().signal,
        tail: 5,
      },
    );

    expect(
      client.calls.filter(({ name }) => name === "get_runtime_logs").map(({ arguments: input }) => input.tail),
    ).toEqual([5, 5, 5]);
    expect(result.entries.map(({ message }) => message)).toEqual([
      "server-2",
      "client-1-1",
      "client-1-2",
      "client-2-1",
      "client-2-2",
    ]);
  });

  test("keeps each multi-role response inside its derived byte envelope", async () => {
    const oversizedRows = Array.from({ length: 55 }, (_, index) => ({
      seq: index,
      ts: index,
      level: "INFO",
      message: "x".repeat(60_000),
    }));
    const client = new Client([
      text({ instances: [instance], count: 1 }),
      text({ success: true, action: "status", running: true, roles: ["server", "client-1"] }),
      text({ entries: oversizedRows, totalDropped: 0, nextSince: 55, capturedBy: "server" }),
      text({
        entries: [{ seq: 1, ts: 100, level: "INFO", message: "client" }],
        totalDropped: 0,
        nextSince: 1,
        capturedBy: "client-1",
      }),
    ]);
    const service = await selected(client);

    const result = await service.runtimeLogs(
      { server: 0, "client-1": 0 },
      {
        expectedInstanceId: "place:1",
        signal: new AbortController().signal,
      },
    );

    expect(result.entries.map(({ message }) => message)).toEqual(["client"]);
    expect(result.perCaptureErrors).toEqual({ server: "Runtime log capture failed" });
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThan(2 * 1_024 * 1_024);
  });

  test("never invokes a command when selection changes at authorization continuation", async () => {
    const second = { ...instance, instanceId: "place:2", placeId: 2 };
    const client = new Client([text({ instances: [instance, second], count: 2 })]);
    let service: StudioMcpService;
    const raceGate = {
      authorize: async () => {
        queueMicrotask(() => service.selectInstance("place:2"));
        return { approved: true as const, authorizationId: "approved-race-command" };
      },
      consume: () => undefined,
    };
    service = new StudioMcpService(client, raceGate);
    await service.listConnectedInstances();
    service.selectInstance("place:1");

    await expect(
      service.startPlaytest(
        "play",
        {
          ownership: "studio",
          expectedInstanceId: "place:1",
          expectedGraphRevision: 1,
        },
        { signal: new AbortController().signal },
      ),
    ).rejects.toThrow("instance changed");
    expect(client.calls).toHaveLength(1);
  });

  test("gate revalidation failure cannot leave a microtask window before callTool", async () => {
    const client = new Client([text({ instances: [instance], count: 1 })]);
    const graphGate = {
      authorize: async () => ({ approved: true as const, authorizationId: "approved-graph-command" }),
      consume: () => {
        throw new Error("Graph changed before command");
      },
    };
    const service = new StudioMcpService(client, graphGate);
    await service.listConnectedInstances();
    service.selectInstance(instance.instanceId);

    await expect(
      service.stopPlaytest(
        {
          ownership: "studio",
          expectedInstanceId: "place:1",
          expectedGraphRevision: 1,
        },
        { signal: new AbortController().signal },
      ),
    ).rejects.toThrow("Graph changed");
    expect(client.calls).toHaveLength(1);
  });

  test("issues the command in the same continuation as successful consume", async () => {
    const trace: string[] = [];
    let service: StudioMcpService;
    const second = { ...instance, instanceId: "place:2", placeId: 2 };
    const client = new Client(
      [text({ instances: [instance, second], count: 2 }), text({ success: true, action: "stop", message: "stopped" })],
      (input) => {
        if (input.name === "solo_playtest") trace.push("call");
      },
    );
    const raceGate = {
      authorize: async () => ({ approved: true as const, authorizationId: "approved-consume-race" }),
      consume: () => {
        trace.push("consume");
        queueMicrotask(() => {
          trace.push("invalidate");
          service.selectInstance("place:2");
        });
      },
    };
    service = new StudioMcpService(client, raceGate);
    await service.listConnectedInstances();
    service.selectInstance(instance.instanceId);

    await expect(
      service.stopPlaytest(
        {
          ownership: "studio",
          expectedInstanceId: "place:1",
          expectedGraphRevision: 1,
        },
        { signal: new AbortController().signal },
      ),
    ).resolves.toMatchObject({ success: true });
    expect(trace).toEqual(["consume", "call", "invalidate"]);
  });
});
