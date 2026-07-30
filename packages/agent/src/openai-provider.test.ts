import { describe, expect, test, vi } from "vitest";
import type {
  ResponseCreateParamsStreaming,
  ResponseOutputItem,
  ResponseStreamEvent,
} from "openai/resources/responses/responses";

import {
  OpenAIResponsesProvider,
  assertNodeRuntimeCompatibility,
  assertStrictToolSchema,
  normalizeEndpoint,
  type ClientFactory,
  type ResponsesClientPort,
} from "./openai-provider.js";
import type { AgentContext, ProviderEvent, ProviderRequest } from "./types.js";

describe("OpenAIResponsesProvider", () => {
  test("lazily obtains a credential and sends bounded direct strict stateless requests", async () => {
    const create = vi.fn();
    const client: ResponsesClientPort = { responses: { create } };
    const factory: ClientFactory = vi.fn(() => client);
    const secret = vi.fn(async () => ({
      apiKey: "sk-sentinel-never-leak",
      endpoint: "https://api.openai.com/v1/",
    }));
    const provider = new OpenAIResponsesProvider({ getCredential: secret, clientFactory: factory });
    expect(secret).not.toHaveBeenCalled();

    create.mockResolvedValueOnce(stream(firstTurn())).mockResolvedValueOnce(stream(secondTurn()));
    const session = await provider.open(providerRequest(), new AbortController().signal);
    expect(secret).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledWith({
      apiKey: "sk-sentinel-never-leak",
      baseURL: "https://api.openai.com/v1",
      timeout: 45_000,
      maxRetries: 0,
      logLevel: "off",
    });

    const one = await collect(session.respond({ request: providerRequest() }, new AbortController().signal));
    expect(one).toEqual([
      { type: "text-delta", delta: "Working" },
      {
        type: "tool-call",
        callId: "call-a",
        name: "selected_context",
        arguments: { ok: true, value: { chipId: "chip-a" }, bytes: 19 },
      },
      { type: "completed" },
    ]);
    const firstBody = create.mock.calls[0]?.[0] as ResponseCreateParamsStreaming;
    expect(firstBody).toMatchObject({
      model: "gpt-5.6",
      stream: true,
      store: false,
      parallel_tool_calls: false,
      include: ["reasoning.encrypted_content"],
    });
    expect(firstBody).not.toHaveProperty("previous_response_id");
    expect(firstBody.tools).toEqual([
      expect.objectContaining({
        type: "function",
        name: "selected_context",
        strict: true,
        allowed_callers: ["direct"],
      }),
    ]);
    expect(create.mock.calls[0]?.[1]).toEqual({
      signal: expect.any(AbortSignal),
      timeout: 45_000,
      maxRetries: 0,
    });

    const two = await collect(
      session.respond(
        {
          toolOutputs: [{ callId: "call-a", output: '{"ok":true}' }],
        },
        new AbortController().signal,
      ),
    );
    expect(two).toEqual([{ type: "text-delta", delta: "Done" }, { type: "completed" }]);
    const secondBody = create.mock.calls[1]?.[0] as ResponseCreateParamsStreaming;
    const input = secondBody.input as readonly Record<string, unknown>[];
    expect(input.map((item) => item.type)).toEqual(["message", "reasoning", "function_call", "function_call_output"]);
    expect(input.at(-1)).toEqual({
      type: "function_call_output",
      call_id: "call-a",
      output: '{"ok":true}',
    });
    expect(JSON.stringify(input)).not.toContain("sk-sentinel");
    await session.close();
    await session.close();
  });

  test("emits one bounded event for malformed and oversized arguments without retaining raw text", async () => {
    const raw = `{"secret":"${"x".repeat(100)}"}`;
    const create = vi
      .fn()
      .mockResolvedValueOnce(stream(functionTurn("bad", raw, raw)))
      .mockResolvedValueOnce(stream(functionTurn("malformed", '{"secret":', '{"secret":')));
    const provider = new OpenAIResponsesProvider({
      getCredential: async () => ({ apiKey: "sentinel", endpoint: "http://127.0.0.1:8080/v1" }),
      clientFactory: () => ({ responses: { create } }),
      limits: { argumentBytes: 16 },
    });
    const malformed = await provider.open(providerRequest(), new AbortController().signal);
    const malformedEvents = await collect(
      malformed.respond({ request: providerRequest() }, new AbortController().signal),
    );
    expect(malformedEvents).toContainEqual({
      type: "tool-call",
      callId: "bad",
      name: "selected_context",
      arguments: { ok: false, code: "oversized", bytes: Buffer.byteLength(raw) },
    });
    expect(JSON.stringify(malformedEvents)).not.toContain(raw);
    await malformed.close();

    const providerTwo = new OpenAIResponsesProvider({
      getCredential: async () => ({ apiKey: "sentinel", endpoint: "http://localhost:8080/v1" }),
      clientFactory: () => ({ responses: { create } }),
      limits: { argumentBytes: 1_000 },
    });
    const malformedSession = await providerTwo.open(providerRequest(), new AbortController().signal);
    const invalidEvents = await collect(
      malformedSession.respond({ request: providerRequest() }, new AbortController().signal),
    );
    expect(invalidEvents).toContainEqual(
      expect.objectContaining({
        type: "tool-call",
        arguments: expect.objectContaining({ ok: false, code: "malformed" }),
      }),
    );
    await malformedSession.close();
  });

  test("rejects an invalid completed batch without retaining raw arguments in continuation history", async () => {
    const oversizedRaw = `{"sentinel":"${"never-forward-".repeat(4)}"}`;
    const malformedRaw = '{"sentinel":';
    const oversized = functionCallItem("rejected-oversized", oversizedRaw, { type: "direct" });
    const malformed = functionCallItem("rejected-malformed", malformedRaw, { type: "direct" });
    const create = vi
      .fn()
      .mockResolvedValueOnce(
        stream([event({ type: "response.completed", response: response([oversized, malformed]), sequence_number: 1 })]),
      )
      .mockResolvedValueOnce(
        stream([event({ type: "response.completed", response: response([]), sequence_number: 1 })]),
      );
    const provider = new OpenAIResponsesProvider({
      getCredential: async () => ({ apiKey: "sentinel", endpoint: "https://api.openai.com/v1" }),
      clientFactory: () => ({ responses: { create } }),
      limits: { argumentBytes: 16 },
    });
    const session = await provider.open(providerRequest(), new AbortController().signal);

    const rejected = await collect(session.respond({ request: providerRequest() }, new AbortController().signal));

    expect(rejected).toEqual([
      {
        type: "tool-call",
        callId: "rejected-oversized",
        name: "selected_context",
        arguments: { ok: false, code: "oversized", bytes: Buffer.byteLength(oversizedRaw) },
      },
      {
        type: "tool-call",
        callId: "rejected-malformed",
        name: "selected_context",
        arguments: { ok: false, code: "malformed", bytes: Buffer.byteLength(malformedRaw) },
      },
      {
        type: "error",
        code: "invalid-tool-call-batch",
        message: "The model emitted invalid tool-call arguments.",
      },
    ]);
    expect(rejected).not.toContainEqual({ type: "completed" });

    const next = await collect(session.respond({ toolOutputs: [] }, new AbortController().signal));
    expect(next).toEqual([{ type: "completed" }]);
    const nextInput = (create.mock.calls[1]?.[0] as ResponseCreateParamsStreaming).input;
    expect(JSON.stringify(nextInput)).not.toContain("never-forward");
    expect(JSON.stringify(nextInput)).not.toContain("rejected-oversized");
    expect(JSON.stringify(nextInput)).not.toContain("rejected-malformed");
    await session.close();
  });

  test("emits every completed call as a non-executable attempt before a continuation-limit error", async () => {
    const calls = [
      functionCallItem("continuation-a", "{}", { type: "direct" }),
      functionCallItem("continuation-b", "{}", { type: "direct" }),
    ];
    const create = vi
      .fn()
      .mockResolvedValue(
        stream([event({ type: "response.completed", response: response(calls), sequence_number: 1 })]),
      );
    const provider = new OpenAIResponsesProvider({
      getCredential: async () => ({ apiKey: "sentinel", endpoint: "https://api.openai.com/v1" }),
      clientFactory: () => ({ responses: { create } }),
      limits: { continuationItems: 1 },
    });
    const session = await provider.open(providerRequest(), new AbortController().signal);

    const observed = await collect(session.respond({ request: providerRequest() }, new AbortController().signal));

    expect(observed).toEqual([
      {
        type: "tool-call",
        callId: "continuation-a",
        name: "selected_context",
        arguments: { ok: false, code: "malformed", bytes: 2 },
      },
      {
        type: "tool-call",
        callId: "continuation-b",
        name: "selected_context",
        arguments: { ok: false, code: "malformed", bytes: 2 },
      },
      {
        type: "error",
        code: "continuation-limit",
        message: "The in-memory continuation limit was reached.",
      },
    ]);
    expect(observed.some((value) => value.type === "tool-call" && value.arguments.ok)).toBe(false);
    expect(create).toHaveBeenCalledTimes(1);
    await session.close();
  });

  test("synthesizes one malformed attempt for a completed delta-only call", async () => {
    const create = vi.fn().mockResolvedValue(
      stream([
        event({
          type: "response.function_call_arguments.delta",
          item_id: "delta-only-completed",
          output_index: 0,
          delta: "{}",
          sequence_number: 1,
        }),
        event({ type: "response.completed", response: response([]), sequence_number: 2 }),
      ]),
    );
    const provider = new OpenAIResponsesProvider({
      getCredential: async () => ({ apiKey: "sentinel", endpoint: "https://api.openai.com/v1" }),
      clientFactory: () => ({ responses: { create } }),
    });
    const session = await provider.open(providerRequest(), new AbortController().signal);

    const observed = await collect(session.respond({ request: providerRequest() }, new AbortController().signal));

    expect(observed).toEqual([
      {
        type: "tool-call",
        callId: "malformed-call-0",
        name: "malformed-tool-call",
        arguments: { ok: false, code: "malformed", bytes: 2 },
      },
      {
        type: "error",
        code: "invalid-tool-call-batch",
        message: "The model emitted invalid tool-call arguments.",
      },
    ]);
    expect(observed).not.toContainEqual({ type: "completed" });
    await session.close();
  });

  test("gives an oversized final observation precedence over an earlier short done value", async () => {
    const short = functionCallItem("late-oversized", "{}", { type: "direct" });
    const final = { ...short, arguments: "x".repeat(17) };
    const create = vi.fn().mockResolvedValue(
      stream([
        event({
          type: "response.output_item.added",
          item: { ...short, arguments: "" },
          output_index: 0,
          sequence_number: 1,
        }),
        event({
          type: "response.function_call_arguments.done",
          item_id: short.id,
          output_index: 0,
          name: short.name,
          arguments: short.arguments,
          sequence_number: 2,
        }),
        event({ type: "response.completed", response: response([final]), sequence_number: 3 }),
      ]),
    );
    const provider = new OpenAIResponsesProvider({
      getCredential: async () => ({ apiKey: "sentinel", endpoint: "https://api.openai.com/v1" }),
      clientFactory: () => ({ responses: { create } }),
      limits: { argumentBytes: 16 },
    });
    const session = await provider.open(providerRequest(), new AbortController().signal);

    const observed = await collect(session.respond({ request: providerRequest() }, new AbortController().signal));

    expect(observed[0]).toEqual({
      type: "tool-call",
      callId: "late-oversized",
      name: "selected_context",
      arguments: { ok: false, code: "oversized", bytes: 17 },
    });
    expect(observed.at(-1)).toEqual({
      type: "error",
      code: "invalid-tool-call-batch",
      message: "The model emitted invalid tool-call arguments.",
    });
    await session.close();
  });

  test("reports the maximum observed final byte count for unequal below-limit arguments", async () => {
    const short = functionCallItem("late-unequal", "{}", { type: "direct" });
    const final = { ...short, arguments: '{"x":1}' };
    const create = vi.fn().mockResolvedValue(
      stream([
        event({
          type: "response.output_item.added",
          item: { ...short, arguments: "" },
          output_index: 0,
          sequence_number: 1,
        }),
        event({
          type: "response.function_call_arguments.done",
          item_id: short.id,
          output_index: 0,
          name: short.name,
          arguments: short.arguments,
          sequence_number: 2,
        }),
        event({ type: "response.completed", response: response([final]), sequence_number: 3 }),
      ]),
    );
    const provider = new OpenAIResponsesProvider({
      getCredential: async () => ({ apiKey: "sentinel", endpoint: "https://api.openai.com/v1" }),
      clientFactory: () => ({ responses: { create } }),
      limits: { argumentBytes: 16 },
    });
    const session = await provider.open(providerRequest(), new AbortController().signal);

    const observed = await collect(session.respond({ request: providerRequest() }, new AbortController().signal));

    expect(observed[0]).toEqual({
      type: "tool-call",
      callId: "late-unequal",
      name: "selected_context",
      arguments: { ok: false, code: "malformed", bytes: Buffer.byteLength(final.arguments) },
    });
    await session.close();
  });

  test("accepts identical repeated arguments exactly at the byte limit without double counting", async () => {
    const exact = '{"chipId":"abc"}';
    expect(Buffer.byteLength(exact)).toBe(16);
    const item = functionCallItem("repeat-at-limit", exact, { type: "direct" });
    const create = vi.fn().mockResolvedValue(
      stream([
        event({ type: "response.output_item.added", item, output_index: 0, sequence_number: 1 }),
        event({
          type: "response.function_call_arguments.done",
          item_id: item.id,
          output_index: 0,
          name: item.name,
          arguments: exact,
          sequence_number: 2,
        }),
        event({ type: "response.completed", response: response([item]), sequence_number: 3 }),
      ]),
    );
    const provider = new OpenAIResponsesProvider({
      getCredential: async () => ({ apiKey: "sentinel", endpoint: "https://api.openai.com/v1" }),
      clientFactory: () => ({ responses: { create } }),
      limits: { argumentBytes: 16 },
    });
    const session = await provider.open(providerRequest(), new AbortController().signal);

    const observed = await collect(session.respond({ request: providerRequest() }, new AbortController().signal));

    expect(observed).toEqual([
      {
        type: "tool-call",
        callId: "repeat-at-limit",
        name: "selected_context",
        arguments: { ok: true, value: { chipId: "abc" }, bytes: 16 },
      },
      { type: "completed" },
    ]);
    await session.close();
  });

  test("measures every distinct final before enforcing the aggregate observation limit", async () => {
    const short = Array.from({ length: 5 }, (_, index) =>
      functionCallItem(`aggregate-final-${index}`, "{}", { type: "direct" }),
    );
    const finals = short.map((item, index) => ({
      ...item,
      arguments: `${index}${"x".repeat(60 * 1024 - 1)}`,
    }));
    expect(finals.map((item) => Buffer.byteLength(item.arguments))).toEqual(Array(5).fill(60 * 1024));
    const create = vi.fn().mockResolvedValue(
      stream([
        ...short.map((item, index) =>
          event({
            type: "response.output_item.added",
            item: { ...item, arguments: "" },
            output_index: index,
            sequence_number: index + 1,
          }),
        ),
        ...short.map((item, index) =>
          event({
            type: "response.function_call_arguments.done",
            item_id: item.id,
            output_index: index,
            name: item.name,
            arguments: item.arguments,
            sequence_number: short.length + index + 1,
          }),
        ),
        event({ type: "response.completed", response: response(finals), sequence_number: 11 }),
      ]),
    );
    const provider = new OpenAIResponsesProvider({
      getCredential: async () => ({ apiKey: "sentinel", endpoint: "https://api.openai.com/v1" }),
      clientFactory: () => ({ responses: { create } }),
    });
    const session = await provider.open(providerRequest(), new AbortController().signal);

    const observed = await collect(session.respond({ request: providerRequest() }, new AbortController().signal));

    expect(observed).toEqual([
      ...finals.map((item) => ({
        type: "tool-call" as const,
        callId: item.call_id,
        name: item.name,
        arguments: { ok: false as const, code: "malformed" as const, bytes: 60 * 1024 },
      })),
      {
        type: "error",
        code: "argument-discovery-limit",
        message: "The model emitted too many tool-call argument bytes.",
      },
    ]);
    expect(JSON.stringify(observed)).not.toContain(finals[0]!.arguments);
    expect(observed.some((value) => value.type === "tool-call" && value.arguments.ok)).toBe(false);
    await session.close();
  });

  test("fails closed on program callers and normalizes provider failures without leaked data", async () => {
    const sentinel = "sk-super-secret";
    const create = vi
      .fn()
      .mockResolvedValueOnce(stream(functionTurn("program", "{}", "{}", "program")))
      .mockRejectedValueOnce(Object.assign(new Error(`401 ${sentinel}`), { name: "AuthenticationError" }));
    const provider = new OpenAIResponsesProvider({
      getCredential: async () => ({ apiKey: sentinel, endpoint: "https://api.openai.com/v1" }),
      clientFactory: () => ({ responses: { create } }),
    });
    const session = await provider.open(providerRequest(), new AbortController().signal);
    const events = await collect(session.respond({ request: providerRequest() }, new AbortController().signal));
    expect(events).toEqual([
      {
        type: "tool-call",
        callId: "program",
        name: "selected_context",
        arguments: { ok: false, code: "malformed", bytes: 2 },
      },
      {
        type: "error",
        code: "programmatic-tool-call",
        message: "Programmatic tool calls are disabled.",
      },
    ]);
    const thrown = await collect(session.respond({ toolOutputs: [] }, new AbortController().signal));
    expect(thrown).toEqual([
      {
        type: "error",
        code: "authentication",
        message: "The model provider rejected the credential.",
      },
    ]);
    expect(JSON.stringify([...events, ...thrown])).not.toContain(sentinel);
    await session.close();
  });

  test("preflights every completed caller before releasing an earlier direct call", async () => {
    const direct = functionCallItem("direct-before-program", "{}", { type: "direct" });
    const program = functionCallItem("later-program", "{}", {
      type: "program",
      caller_id: "program-a",
    });
    const create = vi
      .fn()
      .mockResolvedValue(
        stream([event({ type: "response.completed", response: response([direct, program]), sequence_number: 1 })]),
      );
    const provider = new OpenAIResponsesProvider({
      getCredential: async () => ({ apiKey: "sentinel", endpoint: "https://api.openai.com/v1" }),
      clientFactory: () => ({ responses: { create } }),
    });
    const session = await provider.open(providerRequest(), new AbortController().signal);

    const events = await collect(session.respond({ request: providerRequest() }, new AbortController().signal));

    expect(events).toEqual([
      {
        type: "tool-call",
        callId: "direct-before-program",
        name: "selected_context",
        arguments: { ok: false, code: "malformed", bytes: 2 },
      },
      {
        type: "tool-call",
        callId: "later-program",
        name: "selected_context",
        arguments: { ok: false, code: "malformed", bytes: 2 },
      },
      {
        type: "error",
        code: "programmatic-tool-call",
        message: "Programmatic tool calls are disabled.",
      },
    ]);
    expect(events.some((value) => value.type === "tool-call" && value.arguments.ok)).toBe(false);
    await session.close();
  });

  test("emits a bounded malformed attempt when arguments finish before a failed terminal response", async () => {
    const item = functionCallItem("failed-after-done", "{}", { type: "direct" });
    const create = vi.fn().mockResolvedValue(
      stream([
        event({
          type: "response.output_item.added",
          item,
          output_index: 0,
          sequence_number: 1,
        }),
        event({
          type: "response.function_call_arguments.done",
          item_id: item.id,
          output_index: 0,
          name: item.name,
          arguments: item.arguments,
          sequence_number: 2,
        }),
        event({
          type: "response.failed",
          response: { ...response([item]), status: "failed" },
          sequence_number: 3,
        }),
      ]),
    );
    const provider = new OpenAIResponsesProvider({
      getCredential: async () => ({ apiKey: "sentinel", endpoint: "https://api.openai.com/v1" }),
      clientFactory: () => ({ responses: { create } }),
    });
    const session = await provider.open(providerRequest(), new AbortController().signal);

    const events = await collect(session.respond({ request: providerRequest() }, new AbortController().signal));

    expect(events).toEqual([
      {
        type: "tool-call",
        callId: "failed-after-done",
        name: "selected_context",
        arguments: { ok: false, code: "malformed", bytes: 2 },
      },
      {
        type: "error",
        code: "response-failed",
        message: "The model provider failed the response.",
      },
    ]);
    await session.close();
  });

  test("bounds distinct function-call discovery before an unterminated stream can retain calls", async () => {
    const items = Array.from({ length: 17 }, (_, index) => functionCallItem(`call-${index}`, "", { type: "direct" }));
    const create = vi.fn().mockResolvedValue(
      stream(
        items.map((item, index) =>
          event({
            type: "response.output_item.added",
            item,
            output_index: index,
            sequence_number: index + 1,
          }),
        ),
      ),
    );
    const provider = new OpenAIResponsesProvider({
      getCredential: async () => ({ apiKey: "sentinel", endpoint: "https://api.openai.com/v1" }),
      clientFactory: () => ({ responses: { create } }),
    });
    const session = await provider.open(providerRequest(), new AbortController().signal);

    const events = await collect(session.respond({ request: providerRequest() }, new AbortController().signal));

    expect(events).toHaveLength(17);
    expect(events.slice(0, -1)).toEqual(
      items.slice(0, 16).map((item) => ({
        type: "tool-call",
        callId: item.call_id,
        name: "selected_context",
        arguments: { ok: false, code: "malformed", bytes: 0 },
      })),
    );
    expect(events.at(-1)).toEqual({
      type: "error",
      code: "tool-call-discovery-limit",
      message: "The model emitted too many tool calls.",
    });
    await session.close();
  });

  test("caps duplicate completed-output item IDs with exactly sixteen non-executable attempts", async () => {
    const items = Array.from({ length: 17 }, (_, index) => ({
      ...functionCallItem(`duplicate-${index}`, "{}", { type: "direct" }),
      id: "duplicate-item",
    }));
    const create = vi
      .fn()
      .mockResolvedValue(
        stream([event({ type: "response.completed", response: response(items), sequence_number: 1 })]),
      );
    const provider = new OpenAIResponsesProvider({
      getCredential: async () => ({ apiKey: "sentinel", endpoint: "https://api.openai.com/v1" }),
      clientFactory: () => ({ responses: { create } }),
    });
    const session = await provider.open(providerRequest(), new AbortController().signal);

    const events = await collect(session.respond({ request: providerRequest() }, new AbortController().signal));

    expect(events).toEqual([
      ...Array.from({ length: 16 }, (_, index) => ({
        type: "tool-call" as const,
        callId: `duplicate-${index}`,
        name: "selected_context",
        arguments: { ok: false as const, code: "malformed" as const, bytes: 2 },
      })),
      {
        type: "error",
        code: "tool-call-discovery-limit",
        message: "The model emitted too many tool calls.",
      },
    ]);
    expect(events.some((value) => value.type === "tool-call" && value.arguments.ok)).toBe(false);
    await session.close();
  });

  test("caps missing completed-output item IDs with exactly sixteen non-executable attempts", async () => {
    const items = Array.from({ length: 17 }, (_, index) => ({
      ...functionCallItem(`anonymous-${index}`, "{}", { type: "direct" }),
      id: undefined,
    })) as unknown as readonly ResponseOutputItem[];
    const create = vi
      .fn()
      .mockResolvedValue(
        stream([event({ type: "response.completed", response: response(items), sequence_number: 1 })]),
      );
    const provider = new OpenAIResponsesProvider({
      getCredential: async () => ({ apiKey: "sentinel", endpoint: "https://api.openai.com/v1" }),
      clientFactory: () => ({ responses: { create } }),
    });
    const session = await provider.open(providerRequest(), new AbortController().signal);

    const events = await collect(session.respond({ request: providerRequest() }, new AbortController().signal));

    expect(events).toEqual([
      ...Array.from({ length: 16 }, (_, index) => ({
        type: "tool-call" as const,
        callId: `anonymous-${index}`,
        name: "selected_context",
        arguments: { ok: false as const, code: "malformed" as const, bytes: 2 },
      })),
      {
        type: "error",
        code: "tool-call-discovery-limit",
        message: "The model emitted too many tool calls.",
      },
    ]);
    expect(events.some((value) => value.type === "tool-call" && value.arguments.ok)).toBe(false);
    await session.close();
  });

  test("bounds aggregate retained argument bytes even when every individual call is valid", async () => {
    const chunk = `{"chipId":"${"x".repeat(60 * 1024 - 13)}"}`;
    expect(Buffer.byteLength(chunk)).toBe(60 * 1024);
    const items = Array.from({ length: 5 }, (_, index) =>
      functionCallItem(`aggregate-${index}`, "", { type: "direct" }),
    );
    const create = vi.fn().mockResolvedValue(
      stream([
        ...items.map((item, index) =>
          event({
            type: "response.output_item.added",
            item,
            output_index: index,
            sequence_number: index + 1,
          }),
        ),
        ...items.map((item, index) =>
          event({
            type: "response.function_call_arguments.delta",
            item_id: item.id,
            output_index: index,
            delta: chunk,
            sequence_number: index + items.length + 1,
          }),
        ),
      ]),
    );
    const provider = new OpenAIResponsesProvider({
      getCredential: async () => ({ apiKey: "sentinel", endpoint: "https://api.openai.com/v1" }),
      clientFactory: () => ({ responses: { create } }),
    });
    const session = await provider.open(providerRequest(), new AbortController().signal);

    const events = await collect(session.respond({ request: providerRequest() }, new AbortController().signal));

    expect(events).toEqual([
      ...items.slice(0, 4).map((item) => ({
        type: "tool-call" as const,
        callId: item.call_id,
        name: item.name,
        arguments: { ok: false as const, code: "malformed" as const, bytes: 60 * 1024 },
      })),
      {
        type: "tool-call",
        callId: "aggregate-4",
        name: "selected_context",
        arguments: { ok: false, code: "malformed", bytes: 60 * 1024 },
      },
      {
        type: "error",
        code: "argument-discovery-limit",
        message: "The model emitted too many tool-call argument bytes.",
      },
    ]);
    expect(JSON.stringify(events)).not.toContain(chunk);
    await session.close();
  });

  test("reconciles four calls at the retained-byte boundary without joining raw chunks", async () => {
    const finals = Array.from({ length: 4 }, (_, index) => {
      const prefix = `{"chipId":"boundary-${index}-`;
      const suffix = `"}`;
      return `${prefix}${"x".repeat(64 * 1024 - Buffer.byteLength(prefix) - Buffer.byteLength(suffix))}${suffix}`;
    });
    expect(finals.map((value) => Buffer.byteLength(value))).toEqual([64 * 1024, 64 * 1024, 64 * 1024, 64 * 1024]);
    const output = finals.map((argumentsJson, index) =>
      functionCallItem(`boundary-${index}`, argumentsJson, { type: "direct" }),
    );
    const added = output.map((item) => ({ ...item, arguments: "" }));
    const events: ResponseStreamEvent[] = [
      ...added.map((item, index) =>
        event({
          type: "response.output_item.added",
          item,
          output_index: index,
          sequence_number: index + 1,
        }),
      ),
      ...finals.flatMap((argumentsJson, index) => {
        const split = argumentsJson.length / 2;
        return [
          event({
            type: "response.function_call_arguments.delta",
            item_id: output[index]!.id,
            output_index: index,
            delta: argumentsJson.slice(0, split),
            sequence_number: 5 + index * 2,
          }),
          event({
            type: "response.function_call_arguments.delta",
            item_id: output[index]!.id,
            output_index: index,
            delta: argumentsJson.slice(split),
            sequence_number: 6 + index * 2,
          }),
        ];
      }),
      ...finals.map((argumentsJson, index) =>
        event({
          type: "response.function_call_arguments.done",
          item_id: output[index]!.id,
          output_index: index,
          name: output[index]!.name,
          arguments: argumentsJson,
          sequence_number: 13 + index,
        }),
      ),
      event({ type: "response.completed", response: response(output), sequence_number: 17 }),
    ];
    const create = vi.fn().mockResolvedValue(stream(events));
    const provider = new OpenAIResponsesProvider({
      getCredential: async () => ({ apiKey: "sentinel", endpoint: "https://api.openai.com/v1" }),
      clientFactory: () => ({ responses: { create } }),
    });
    const session = await provider.open(providerRequest(), new AbortController().signal);
    const originalJoin = Array.prototype.join;
    const join = vi.spyOn(Array.prototype, "join").mockImplementation(function (this: unknown[], separator?: string) {
      if (this.some((value) => typeof value === "string" && value.includes("boundary-"))) {
        throw new Error("raw chunks must not be joined");
      }
      return originalJoin.call(this, separator);
    });

    try {
      const observed = await collect(session.respond({ request: providerRequest() }, new AbortController().signal));

      expect(
        observed.map((value) =>
          value.type === "tool-call"
            ? {
                type: value.type,
                callId: value.callId,
                ok: value.arguments.ok,
                bytes: value.arguments.bytes,
              }
            : value,
        ),
      ).toEqual([
        ...Array.from({ length: 4 }, (_, index) => ({
          type: "tool-call",
          callId: `boundary-${index}`,
          ok: true,
          bytes: 64 * 1024,
        })),
        { type: "completed" },
      ]);
    } finally {
      join.mockRestore();
      await session.close();
    }
  });

  test.each([
    [
      "failed",
      event({ type: "response.failed", response: { ...response([]), status: "failed" }, sequence_number: 2 }),
      "response-failed",
      "The model provider failed the response.",
    ],
    [
      "incomplete",
      event({
        type: "response.incomplete",
        response: { ...response([]), status: "incomplete", incomplete_details: { reason: "max_output_tokens" } },
        sequence_number: 2,
      }),
      "incomplete-max-output-tokens",
      "The model provider returned an incomplete response.",
    ],
    [
      "provider error",
      event({ type: "error", code: "upstream", message: "untrusted", sequence_number: 2 }),
      "provider-error",
      "The model provider reported an error.",
    ],
    ["thrown", undefined, "provider-failure", "The model provider request failed."],
    ["unterminated", undefined, "stream-incomplete", "The model stream ended without completion."],
  ] as const)("accounts for a delta-only call before a %s terminal stream", async (kind, terminal, code, message) => {
    const delta = event({
      type: "response.function_call_arguments.delta",
      item_id: "delta-only-item",
      output_index: 0,
      delta: "{}",
      sequence_number: 1,
    });
    const source =
      kind === "thrown"
        ? throwingStream([delta], new Error("untrusted provider failure"))
        : stream([delta, ...(terminal === undefined ? [] : [terminal])]);
    const create = vi.fn().mockResolvedValue(source);
    const provider = new OpenAIResponsesProvider({
      getCredential: async () => ({ apiKey: "sentinel", endpoint: "https://api.openai.com/v1" }),
      clientFactory: () => ({ responses: { create } }),
    });
    const session = await provider.open(providerRequest(), new AbortController().signal);

    const events = await collect(session.respond({ request: providerRequest() }, new AbortController().signal));

    expect(events).toEqual([
      {
        type: "tool-call",
        callId: "malformed-call-0",
        name: "malformed-tool-call",
        arguments: { ok: false, code: "malformed", bytes: 2 },
      },
      { type: "error", code, message },
    ]);
    await session.close();
  });

  test.each(["absent", "null"] as const)("treats a %s final caller as direct-compatible", async (caller) => {
    const base = functionCallItem("callerless", '{"chipId":"chip-a"}');
    const item = caller === "null" ? ({ ...base, caller: null } as unknown as typeof base) : base;
    const create = vi.fn().mockResolvedValue(
      stream([
        event({ type: "response.output_item.added", item, output_index: 0, sequence_number: 1 }),
        event({
          type: "response.function_call_arguments.delta",
          item_id: item.id,
          output_index: 0,
          delta: item.arguments,
          sequence_number: 2,
        }),
        event({
          type: "response.function_call_arguments.done",
          item_id: item.id,
          output_index: 0,
          name: item.name,
          arguments: item.arguments,
          sequence_number: 3,
        }),
        event({ type: "response.completed", response: response([item]), sequence_number: 4 }),
      ]),
    );
    const provider = new OpenAIResponsesProvider({
      getCredential: async () => ({ apiKey: "sentinel", endpoint: "https://api.openai.com/v1" }),
      clientFactory: () => ({ responses: { create } }),
    });
    const session = await provider.open(providerRequest(), new AbortController().signal);

    const events = await collect(session.respond({ request: providerRequest() }, new AbortController().signal));

    expect(events).toEqual([
      {
        type: "tool-call",
        callId: "callerless",
        name: "selected_context",
        arguments: { ok: true, value: { chipId: "chip-a" }, bytes: 19 },
      },
      { type: "completed" },
    ]);
    await session.close();
  });

  test.each([
    [
      "failed",
      event({ type: "response.failed", response: { ...response([]), status: "failed" }, sequence_number: 3 }),
      "response-failed",
      "The model provider failed the response.",
    ],
    [
      "incomplete",
      event({
        type: "response.incomplete",
        response: { ...response([]), status: "incomplete", incomplete_details: { reason: "max_output_tokens" } },
        sequence_number: 3,
      }),
      "incomplete-max-output-tokens",
      "The model provider returned an incomplete response.",
    ],
    [
      "provider error",
      event({ type: "error", code: "upstream", message: "untrusted", sequence_number: 3 }),
      "provider-error",
      "The model provider reported an error.",
    ],
    ["unterminated", undefined, "stream-incomplete", "The model stream ended without completion."],
  ] as const)(
    "emits one bounded malformed attempt per discovered call on a %s terminal stream",
    async (_kind, terminal, code, message) => {
      const item = functionCallItem(`terminal-${code}`, "{}", { type: "direct" });
      const events = [
        event({ type: "response.output_item.added", item, output_index: 0, sequence_number: 1 }),
        event({
          type: "response.function_call_arguments.done",
          item_id: item.id,
          output_index: 0,
          name: item.name,
          arguments: item.arguments,
          sequence_number: 2,
        }),
        ...(terminal === undefined ? [] : [terminal]),
      ];
      const create = vi.fn().mockResolvedValue(stream(events));
      const provider = new OpenAIResponsesProvider({
        getCredential: async () => ({ apiKey: "sentinel", endpoint: "https://api.openai.com/v1" }),
        clientFactory: () => ({ responses: { create } }),
      });
      const session = await provider.open(providerRequest(), new AbortController().signal);

      const observed = await collect(session.respond({ request: providerRequest() }, new AbortController().signal));

      expect(observed).toEqual([
        {
          type: "tool-call",
          callId: item.call_id,
          name: item.name,
          arguments: { ok: false, code: "malformed", bytes: 2 },
        },
        { type: "error", code, message },
      ]);
      await session.close();
    },
  );

  test("reconciles completed output and rejects a program caller learned after arguments finish", async () => {
    const added = functionCallItem("late-program", "{}");
    const program = functionCallItem("late-program", "{}", {
      type: "program",
      caller_id: "program-a",
    });
    const create = vi.fn().mockResolvedValue(
      stream([
        event({
          type: "response.output_item.added",
          item: added,
          output_index: 0,
          sequence_number: 1,
        }),
        event({
          type: "response.function_call_arguments.done",
          item_id: added.id,
          output_index: 0,
          name: added.name,
          arguments: added.arguments,
          sequence_number: 2,
        }),
        event({
          type: "response.output_item.done",
          item: program,
          output_index: 0,
          sequence_number: 3,
        }),
        event({
          type: "response.completed",
          response: response([program]),
          sequence_number: 4,
        }),
      ]),
    );
    const provider = new OpenAIResponsesProvider({
      getCredential: async () => ({ apiKey: "sentinel", endpoint: "https://api.openai.com/v1" }),
      clientFactory: () => ({ responses: { create } }),
    });
    const session = await provider.open(providerRequest(), new AbortController().signal);

    const events = await collect(session.respond({ request: providerRequest() }, new AbortController().signal));

    expect(events).toEqual([
      {
        type: "tool-call",
        callId: "late-program",
        name: "selected_context",
        arguments: { ok: false, code: "malformed", bytes: 2 },
      },
      {
        type: "error",
        code: "programmatic-tool-call",
        message: "Programmatic tool calls are disabled.",
      },
    ]);
    await session.close();
  });

  test("validates recursive strict schemas and rejects unsafe endpoints", () => {
    expect(() => assertNodeRuntimeCompatibility("20.18.1")).not.toThrow();
    expect(() => assertNodeRuntimeCompatibility("19.9.0")).toThrow("Node 20 LTS");
    expect(() => assertStrictToolSchema(providerRequest().tools[0]!.parameters)).not.toThrow();
    expect(() =>
      assertStrictToolSchema({
        type: "object",
        properties: {
          nested: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
        },
        required: ["nested"],
        additionalProperties: false,
      } as never),
    ).toThrow("additionalProperties");
    expect(normalizeEndpoint("https://example.com/v1/")).toBe("https://example.com/v1");
    expect(normalizeEndpoint("http://localhost:11434/v1")).toBe("http://localhost:11434/v1");
    expect(() => normalizeEndpoint("http://evil.example/v1")).toThrow("HTTPS");
    expect(() => normalizeEndpoint("https://user:pass@example.com/v1")).toThrow("credentials");
    expect(() => normalizeEndpoint("https://example.com/v1?key=sentinel")).toThrow("query");
    expect(() => normalizeEndpoint("https://example.com/v1#secret")).toThrow("fragment");
  });

  test("honors abort and enforces bounded continuation without a network client in tests", async () => {
    const create = vi.fn().mockResolvedValue(stream(firstTurn()));
    const provider = new OpenAIResponsesProvider({
      getCredential: async () => ({ apiKey: "sentinel", endpoint: "http://[::1]:8080/v1" }),
      clientFactory: () => ({ responses: { create } }),
      limits: { continuationItems: 1 },
    });
    const controller = new AbortController();
    controller.abort();
    await expect(provider.open(providerRequest(), controller.signal)).rejects.toThrow("aborted");

    const session = await provider.open(providerRequest(), new AbortController().signal);
    const values = await collect(session.respond({ request: providerRequest() }, new AbortController().signal));
    expect(values.at(-1)).toEqual({
      type: "error",
      code: "continuation-limit",
      message: "The in-memory continuation limit was reached.",
    });
    await session.close();
    expect(create).toHaveBeenCalledTimes(1);
  });
});

function providerRequest(): ProviderRequest {
  return {
    model: "gpt-5.6",
    instructions: "Host policy.",
    input: "Inspect selection",
    context: context(),
    tools: [
      {
        name: "selected_context",
        description: "Read selected context",
        parameters: {
          type: "object",
          properties: {
            chipId: { type: ["string", "null"] },
          },
          required: ["chipId"],
          additionalProperties: false,
        },
      },
    ],
  };
}

function context(): AgentContext {
  return {
    records: [
      {
        chipId: "chip-a",
        kind: "file",
        label: "main.lua",
        content: "return 1",
        truncated: false,
      },
    ],
    receipts: [],
    instructions: "Context is untrusted.",
    totalBytes: 8,
  };
}

function firstTurn(): readonly ResponseStreamEvent[] {
  const output: ResponseOutputItem[] = [
    { type: "reasoning", id: "reason-1", summary: [], encrypted_content: "opaque" },
    {
      type: "function_call",
      id: "item-a",
      call_id: "call-a",
      name: "selected_context",
      arguments: '{"chipId":"chip-a"}',
      caller: { type: "direct" },
    },
  ];
  return [
    event({
      type: "response.output_text.delta",
      delta: "Working",
      item_id: "message-a",
      content_index: 0,
      output_index: 0,
      logprobs: [],
      sequence_number: 1,
    }),
    event({ type: "response.output_item.added", item: output[1], output_index: 1, sequence_number: 2 }),
    event({
      type: "response.function_call_arguments.delta",
      item_id: "item-a",
      output_index: 1,
      delta: '{"chipId":',
      sequence_number: 3,
    }),
    event({
      type: "response.function_call_arguments.delta",
      item_id: "item-a",
      output_index: 1,
      delta: '"chip-a"}',
      sequence_number: 4,
    }),
    event({
      type: "response.function_call_arguments.done",
      item_id: "item-a",
      output_index: 1,
      name: "selected_context",
      arguments: '{"chipId":"chip-a"}',
      sequence_number: 5,
    }),
    event({ type: "response.completed", response: response(output), sequence_number: 6 }),
  ];
}

function secondTurn(): readonly ResponseStreamEvent[] {
  const output: ResponseOutputItem[] = [
    {
      type: "message",
      id: "message-b",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "Done", annotations: [], logprobs: [] }],
    },
  ];
  return [
    event({
      type: "response.output_text.delta",
      delta: "Done",
      item_id: "message-b",
      content_index: 0,
      output_index: 0,
      logprobs: [],
      sequence_number: 1,
    }),
    event({ type: "response.completed", response: response(output), sequence_number: 2 }),
  ];
}

function functionTurn(
  callId: string,
  deltas: string,
  final: string,
  caller: "direct" | "program" = "direct",
): readonly ResponseStreamEvent[] {
  const item = {
    type: "function_call",
    id: `item-${callId}`,
    call_id: callId,
    name: "selected_context",
    arguments: final,
    caller: caller === "direct" ? { type: "direct" } : { type: "program", caller_id: "program-a" },
  } as const;
  return [
    event({ type: "response.output_item.added", item, output_index: 0, sequence_number: 1 }),
    event({
      type: "response.function_call_arguments.delta",
      item_id: item.id,
      output_index: 0,
      delta: deltas,
      sequence_number: 2,
    }),
    event({
      type: "response.function_call_arguments.done",
      item_id: item.id,
      output_index: 0,
      name: item.name,
      arguments: final,
      sequence_number: 3,
    }),
    event({ type: "response.completed", response: response([item]), sequence_number: 4 }),
  ];
}

function functionCallItem(
  callId: string,
  argumentsJson: string,
  caller?: { readonly type: "direct" } | { readonly type: "program"; readonly caller_id: string },
) {
  return {
    type: "function_call",
    id: `item-${callId}`,
    call_id: callId,
    name: "selected_context",
    arguments: argumentsJson,
    ...(caller === undefined ? {} : { caller }),
  } as const;
}

function response(output: readonly ResponseOutputItem[]) {
  return {
    id: "response-1",
    created_at: 0,
    output_text: "",
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: null,
    model: "gpt-5.6",
    object: "response",
    output: [...output],
    parallel_tool_calls: false,
    temperature: null,
    tool_choice: "auto",
    tools: [],
    top_p: null,
    background: false,
    max_output_tokens: null,
    max_tool_calls: null,
    previous_response_id: null,
    prompt: null,
    prompt_cache_key: null,
    prompt_cache_retention: null,
    reasoning: null,
    safety_identifier: null,
    service_tier: "default",
    status: "completed",
    text: { format: { type: "text" } },
    top_logprobs: 0,
    truncation: "disabled",
    usage: null,
    user: null,
  } as const;
}

function event(value: unknown): ResponseStreamEvent {
  return value as ResponseStreamEvent;
}

function stream(events: readonly ResponseStreamEvent[]): AsyncIterable<ResponseStreamEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const value of events) yield value;
    },
  };
}

function throwingStream(events: readonly ResponseStreamEvent[], error: Error): AsyncIterable<ResponseStreamEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const value of events) yield value;
      throw error;
    },
  };
}

async function collect(source: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const values: ProviderEvent[] = [];
  for await (const value of source) values.push(value);
  return values;
}
