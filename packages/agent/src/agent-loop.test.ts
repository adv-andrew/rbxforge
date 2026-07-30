import { describe, expect, test, vi } from "vitest";

import { InMemoryApprovalBroker } from "./approval-broker.js";
import { AgentLoop } from "./agent-loop.js";
import type {
  AgentContext,
  AgentEvent,
  AgentRequest,
  ModelProvider,
  ModelSession,
  ProviderEvent,
  ProviderTurnInput,
  RegisteredAgentTool,
  ToolReceipt,
} from "./types.js";

const context: AgentContext = Object.freeze({
  records: Object.freeze([]),
  receipts: Object.freeze([]),
  instructions: "untrusted",
  totalBytes: 0,
});

describe("AgentLoop", () => {
  test("preserves streamed text order and continues completed tool turns with exact call IDs", async () => {
    const read = readTool("selected_context", async () => receipt("read-ok", "verified"));
    const session = fakeSession([
      [{ type: "text-delta", delta: "A" }, call("call-1", "selected_context", {}), { type: "completed" }],
      [{ type: "text-delta", delta: "B" }, { type: "completed" }],
    ]);
    const loop = makeLoop(session, [read]);

    const events = await collect(loop.run(request("ask"), new AbortController().signal));

    expect(events.filter(isText).map((event) => event.delta)).toEqual(["A", "B"]);
    expect(session.inputs[1]?.toolOutputs).toEqual([
      {
        callId: "call-1",
        output: JSON.stringify(receipt("read-ok", "verified")),
      },
    ]);
    expect(events.at(-1)).toEqual({ type: "completed", verification: "verified" });
    expect(session.close).toHaveBeenCalledTimes(1);
  });

  test("counts malformed, oversized, unknown, replayed and rejected calls and never starts call 13", async () => {
    const invoke = vi.fn(async () => receipt("ok", "verified"));
    const calls: ProviderEvent[] = [
      { type: "tool-call", callId: "bad", name: "read", arguments: { ok: false, code: "malformed", bytes: 8 } },
      { type: "tool-call", callId: "huge", name: "read", arguments: { ok: false, code: "oversized", bytes: 70_000 } },
      call("unknown", "not_registered", {}),
      call("duplicate", "read", {}),
      call("duplicate", "read", {}),
      ...Array.from({ length: 8 }, (_, index) => call(`extra-${index}`, "read", {})),
      { type: "completed" },
    ];
    const session = fakeSession([calls]);
    const loop = makeLoop(session, [readTool("read", invoke)]);

    const events = await collect(loop.run(request("ask"), new AbortController().signal));

    expect(invoke).toHaveBeenCalledTimes(8);
    expect(events).toContainEqual(expect.objectContaining({ type: "error", code: "tool-call-limit" }));
    expect(session.inputs).toHaveLength(1);
    expect(session.close).toHaveBeenCalledTimes(1);
  });

  test("Ask blocks writes and Build yields one opaque approval then executes", async () => {
    const execute = vi.fn(async () => receipt("written", "verified"));
    const write = writeTool(execute);
    const askSession = fakeSession([
      [call("write-ask", "set_studio_property", {}), { type: "completed" }],
      [{ type: "completed" }],
    ]);
    const askLoop = makeLoop(askSession, [write]);
    const askEvents = await collect(askLoop.run(request("ask"), new AbortController().signal));
    expect(execute).not.toHaveBeenCalled();
    expect(askEvents).toContainEqual(
      expect.objectContaining({
        type: "tool-call",
        name: "set_studio_property",
        access: "blocked",
      }),
    );

    let broker: InMemoryApprovalBroker;
    broker = new InMemoryApprovalBroker({
      now: () => 0,
      randomId: () => "authorization-1",
      onRequested: (proposal) => {
        broker.resolve({
          sessionId: proposal.sessionId,
          generation: proposal.generation,
          runId: proposal.runId,
          approvalId: proposal.approvalId,
          decision: "approve",
        });
      },
    });
    const buildSession = fakeSession([
      [call("write-build", "set_studio_property", {}), { type: "completed" }],
      [{ type: "completed" }],
    ]);
    const buildLoop = makeLoop(buildSession, [write], broker);
    const buildEvents = await collect(buildLoop.run(request("build"), new AbortController().signal));
    expect(buildEvents.filter((event) => event.type === "approval-required")).toEqual([
      {
        type: "approval-required",
        approvalId: "approval-1",
        kind: "studio",
        summary: "Set one property",
        expiresAt: 10_000,
      },
    ]);
    expect(execute).toHaveBeenCalledWith(
      "prepared-1",
      expect.objectContaining({ id: "authorization-1" }),
      expect.objectContaining({ runId: "run-1" }),
    );
  });

  test("aborts before provider open and closes once when aborted while streaming", async () => {
    const provider: ModelProvider = {
      capabilities: { vision: false },
      open: vi.fn(async () => fakeSession([])),
    };
    const loop = new AgentLoop({
      contextAssembler: { build: async () => context },
      provider,
      tools: [],
      approvalBroker: new InMemoryApprovalBroker(),
    });
    const pre = new AbortController();
    pre.abort();
    const before = await collect(loop.run(request("ask"), pre.signal));
    expect(before).toContainEqual(expect.objectContaining({ type: "error", code: "cancelled" }));
    expect(provider.open).not.toHaveBeenCalled();

    const abort = new AbortController();
    const session: ModelSession & { close: ReturnType<typeof vi.fn> } = {
      respond: async function* () {
        yield { type: "text-delta", delta: "before" };
        abort.abort();
        yield { type: "text-delta", delta: "late" };
      },
      close: vi.fn(async () => undefined),
    };
    const during = await collect(makeLoop(session).run(request("ask"), abort.signal));
    expect(during.filter(isText).map((event) => event.delta)).toEqual(["before"]);
    expect(during).toContainEqual(expect.objectContaining({ type: "error", code: "cancelled" }));
    expect(session.close).toHaveBeenCalledTimes(1);
  });

  test("dispose aborts active runs, cancels approvals and suppresses late events", async () => {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const session: ModelSession & { close: ReturnType<typeof vi.fn> } = {
      respond: async function* () {
        yield { type: "text-delta", delta: "before" };
        await waiting;
        yield { type: "text-delta", delta: "late" };
      },
      close: vi.fn(async () => undefined),
    };
    const loop = makeLoop(session);
    const events: AgentEvent[] = [];
    const consume = (async () => {
      for await (const event of loop.run(request("ask"), new AbortController().signal)) events.push(event);
    })();
    await vi.waitFor(() => expect(events.some(isText)).toBe(true));
    const disposed = loop.dispose();
    release();
    await disposed;
    await consume;
    expect(events.filter(isText).map((event) => event.delta)).toEqual(["before"]);
    expect(session.close).toHaveBeenCalledTimes(1);
  });

  test("redacts secret-like string values recursively before returning tool receipts to the provider", async () => {
    const session = fakeSession([
      [call("read-1", "selected_context", {}), { type: "completed" }],
      [{ type: "completed" }],
    ]);
    const read = readTool("selected_context", async () => ({
      ok: true,
      code: "password=receipt-code-sentinel",
      summary: ["Authorization", "Bearer summary-sentinel"].join(": "),
      output: {
        harmless: "api_key=sk-value-sentinel",
        password: "receipt-password-key-sentinel",
        PASSWD: "receipt-passwd-key-sentinel",
        nested: {
          value: "client_secret=deep-sentinel",
          rows: [
            "safe",
            "Authorization: Basic row-sentinel",
            "password=receipt-password-assignment-sentinel",
            '{"PaSsWd":"receipt-passwd-assignment-sentinel"}',
            "password=abc",
            "passwd=x",
            "DB_PASSWORD=q",
            "dbPassword=z",
            {
              password: "receipt-nested-password-key-sentinel",
              harmless: "passwd=receipt-nested-passwd-assignment-sentinel",
            },
          ],
        },
      },
      verification: "verified",
    }));

    await collect(makeLoop(session, [read]).run(request("ask"), new AbortController().signal));

    const encoded = session.inputs[1]?.toolOutputs?.[0]?.output ?? "";
    expect(encoded).not.toContain("summary-sentinel");
    expect(encoded).not.toContain("value-sentinel");
    expect(encoded).not.toContain("deep-sentinel");
    expect(encoded).not.toContain("row-sentinel");
    expect(encoded).not.toContain("receipt-password-key-sentinel");
    expect(encoded).not.toContain("receipt-passwd-key-sentinel");
    expect(encoded).not.toContain("receipt-password-assignment-sentinel");
    expect(encoded).not.toContain("receipt-passwd-assignment-sentinel");
    expect(encoded).not.toContain("receipt-nested-password-key-sentinel");
    expect(encoded).not.toContain("receipt-nested-passwd-assignment-sentinel");
    expect(encoded).not.toContain("password=abc");
    expect(encoded).not.toContain("passwd=x");
    expect(encoded).not.toContain("DB_PASSWORD=q");
    expect(encoded).not.toContain("dbPassword=z");
    expect(encoded).not.toContain("receipt-code-sentinel");
    expect(JSON.parse(encoded)).toMatchObject({ code: "sensitive-tool-result" });
    expect(encoded).toContain("[omitted sensitive content]");
  });
});

function makeLoop(
  session: ModelSession,
  tools: readonly RegisteredAgentTool[] = [],
  approvalBroker = new InMemoryApprovalBroker(),
): AgentLoop {
  return new AgentLoop({
    contextAssembler: { build: async () => context },
    provider: {
      capabilities: { vision: false },
      open: async () => session,
    },
    tools,
    approvalBroker,
    now: () => 0,
  });
}

function request(mode: "ask" | "build" | "debug"): AgentRequest {
  return {
    sessionId: "session-1",
    generation: 1,
    runId: "run-1",
    mode,
    prompt: "Build a safe Roblox feature",
    model: "gpt-5.6",
    context: {
      chipIds: [],
      workspaceRoot: "/workspace",
      sessionId: "session-1",
      generation: 1,
    },
    simulation: false,
  };
}

function call(callId: string, name: string, value: unknown): ProviderEvent {
  return {
    type: "tool-call",
    callId,
    name,
    arguments: { ok: true, value, bytes: Buffer.byteLength(JSON.stringify(value)) },
  };
}

function receipt(summary: string, verification: "verified" | "fixture-verified" | "unverified"): ToolReceipt {
  return { ok: true, code: "ok", summary, verification };
}

function readTool(name: string, invoke: () => Promise<ToolReceipt>): RegisteredAgentTool {
  return {
    name,
    access: "read",
    parameters: schema(),
    validate: (value) => value as Readonly<Record<string, unknown>>,
    invoke,
  };
}

function writeTool(
  execute: (preparedId: string, authorization: never, context: never) => Promise<ToolReceipt>,
): RegisteredAgentTool {
  return {
    name: "set_studio_property",
    access: "write",
    parameters: schema(),
    validate: (value) => value as Readonly<Record<string, unknown>>,
    prepare: async (_args, toolContext) => ({
      id: "prepared-1",
      proposal: Object.freeze({
        approvalId: "approval-1",
        preparedId: "prepared-1",
        sessionId: toolContext.sessionId,
        generation: toolContext.generation,
        runId: toolContext.runId,
        kind: "studio",
        summary: "Set one property",
        bindingHash: "a".repeat(64),
        expiresAt: 10_000,
      }),
    }),
    execute,
  };
}

function schema() {
  return Object.freeze({
    type: "object" as const,
    properties: Object.freeze({}),
    additionalProperties: false as const,
    required: Object.freeze([]),
  });
}

function fakeSession(turns: readonly (readonly ProviderEvent[])[]): ModelSession & {
  readonly inputs: ProviderTurnInput[];
  readonly close: ReturnType<typeof vi.fn>;
} {
  const inputs: ProviderTurnInput[] = [];
  let index = 0;
  return {
    inputs,
    respond: async function* (input) {
      inputs.push(input);
      for (const event of turns[index++] ?? []) yield event;
    },
    close: vi.fn(async () => undefined),
  };
}

async function collect(source: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const values: AgentEvent[] = [];
  for await (const value of source) values.push(value);
  return values;
}

function isText(event: AgentEvent): event is Extract<AgentEvent, { type: "text-delta" }> {
  return event.type === "text-delta";
}
