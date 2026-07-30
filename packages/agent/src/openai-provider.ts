import OpenAI from "openai";
import type {
  FunctionTool,
  ResponseCreateParamsStreaming,
  ResponseInput,
  ResponseInputItem,
  ResponseOutputItem,
  ResponseStreamEvent,
} from "openai/resources/responses/responses";
import { VERSION as OPENAI_RUNTIME_VERSION } from "openai/version";

import type {
  ModelProvider,
  ModelSession,
  ProviderCapabilities,
  ProviderEvent,
  ProviderRequest,
  ProviderTurnInput,
  StrictToolSchema,
} from "./types.js";

export const OPENAI_SDK_VERSION = "6.49.0" as const;
if (OPENAI_RUNTIME_VERSION !== OPENAI_SDK_VERSION) {
  throw new Error("Unsupported OpenAI SDK version");
}
assertNodeRuntimeCompatibility();

export const OPENAI_PROVIDER_LIMITS = Object.freeze({
  timeoutMs: 45_000,
  argumentBytes: 64 * 1024,
  continuationItems: 128,
  continuationBytes: 1024 * 1024,
});

const MAX_DISCOVERED_TOOL_CALLS = 16;
const MAX_TOOL_CALL_ARGUMENT_BYTES = 256 * 1024;

type DiscoveryFailure = "tool-call" | "arguments";

interface DiscoveryState {
  observedBytes: number;
  retainedBytes: number;
  failure: DiscoveryFailure | undefined;
  syntheticKey: number;
}

export interface ResponsesRequestOptions {
  readonly signal: AbortSignal;
  readonly timeout: number;
  readonly maxRetries: 0;
}

export interface ResponsesClientPort {
  readonly responses: {
    create(
      body: ResponseCreateParamsStreaming,
      options: ResponsesRequestOptions,
    ): Promise<AsyncIterable<ResponseStreamEvent>> | AsyncIterable<ResponseStreamEvent>;
  };
  close?: () => void;
}

export interface ClientFactoryOptions {
  readonly apiKey: string;
  readonly baseURL: string;
  readonly timeout: number;
  readonly maxRetries: 0;
  readonly logLevel: "off";
}

export type ClientFactory = (options: ClientFactoryOptions) => ResponsesClientPort;

export interface ProviderCredential {
  readonly apiKey: string;
  readonly endpoint: string;
}

export interface OpenAIResponsesProviderOptions {
  readonly getCredential: (signal: AbortSignal) => Promise<ProviderCredential>;
  readonly clientFactory?: ClientFactory;
  readonly capabilities?: ProviderCapabilities;
  readonly limits?: Partial<typeof OPENAI_PROVIDER_LIMITS>;
}

interface PendingCall {
  callId: string | undefined;
  name: string | undefined;
  caller: "direct" | "program" | undefined;
  finalCaller: "direct" | "program" | undefined;
  chunks: string[];
  initial: string | undefined;
  deltaBytes: number;
  bytes: number;
  retainedBytes: number;
  oversized: boolean;
  malformed: boolean;
  sawProgramCaller: boolean;
  final: string | undefined;
}

export class OpenAIResponsesProvider implements ModelProvider {
  readonly capabilities: ProviderCapabilities;
  readonly #getCredential: (signal: AbortSignal) => Promise<ProviderCredential>;
  readonly #clientFactory: ClientFactory;
  readonly #limits: typeof OPENAI_PROVIDER_LIMITS;

  constructor(options: OpenAIResponsesProviderOptions) {
    this.#getCredential = options.getCredential;
    this.#clientFactory = options.clientFactory ?? productionClientFactory;
    this.capabilities = Object.freeze(options.capabilities ?? { vision: true });
    this.#limits = Object.freeze({ ...OPENAI_PROVIDER_LIMITS, ...options.limits });
  }

  async open(request: ProviderRequest, signal: AbortSignal): Promise<ModelSession> {
    throwIfAborted(signal);
    const credential = await this.#getCredential(signal);
    throwIfAborted(signal);
    if (credential.apiKey.trim().length === 0) throw new Error("Model provider credential is unavailable");
    const endpoint = normalizeEndpoint(credential.endpoint);
    const client = this.#clientFactory({
      apiKey: credential.apiKey,
      baseURL: endpoint,
      timeout: this.#limits.timeoutMs,
      maxRetries: 0,
      logLevel: "off",
    });
    return new OpenAIResponsesSession(client, request, this.#limits);
  }
}

class OpenAIResponsesSession implements ModelSession {
  readonly #client: ResponsesClientPort;
  readonly #request: ProviderRequest;
  readonly #limits: typeof OPENAI_PROVIDER_LIMITS;
  readonly #initialInput: ResponseInput;
  readonly #tools: readonly FunctionTool[];
  #history: ResponseInput = [];
  #started = false;
  #closed = false;
  #responding = false;

  constructor(client: ResponsesClientPort, request: ProviderRequest, limits: typeof OPENAI_PROVIDER_LIMITS) {
    this.#client = client;
    this.#request = request;
    this.#limits = limits;
    this.#initialInput = Object.freeze(buildInput(request)) as ResponseInput;
    this.#tools = Object.freeze(
      request.tools.map((tool) => {
        assertStrictToolSchema(tool.parameters);
        return Object.freeze({
          type: "function" as const,
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          strict: true,
          allowed_callers: ["direct"],
        } satisfies FunctionTool);
      }),
    );
  }

  async *respond(input: ProviderTurnInput, signal: AbortSignal): AsyncIterable<ProviderEvent> {
    if (this.#closed) {
      yield providerError("session-closed", "The model session is closed.");
      return;
    }
    if (this.#responding) {
      yield providerError("concurrent-turn", "Concurrent model turns are disabled.");
      return;
    }
    throwIfAborted(signal);
    this.#responding = true;
    try {
      if (!this.#started) {
        this.#history = [...this.#initialInput];
        this.#started = true;
      } else {
        if (input.request !== undefined) {
          yield providerError("invalid-continuation", "The model continuation is invalid.");
          return;
        }
        for (const toolOutput of input.toolOutputs ?? []) {
          this.#history.push({
            type: "function_call_output",
            call_id: toolOutput.callId,
            output: toolOutput.output,
          } satisfies ResponseInputItem.FunctionCallOutput);
        }
      }
      if (!withinContinuationLimits(this.#history, this.#limits)) {
        yield providerError("continuation-limit", "The in-memory continuation limit was reached.");
        return;
      }
      const body: ResponseCreateParamsStreaming = {
        model: this.#request.model,
        instructions: this.#request.instructions,
        input: this.#history,
        tools: [...this.#tools],
        include: ["reasoning.encrypted_content"],
        stream: true,
        store: false,
        parallel_tool_calls: false,
      };
      let stream: AsyncIterable<ResponseStreamEvent>;
      try {
        stream = await this.#client.responses.create(body, {
          signal,
          timeout: this.#limits.timeoutMs,
          maxRetries: 0,
        });
      } catch (error: unknown) {
        yield normalizeProviderError(error, signal);
        return;
      }

      const pending = new Map<string, PendingCall>();
      const discovery: DiscoveryState = {
        observedBytes: 0,
        retainedBytes: 0,
        failure: undefined,
        syntheticKey: 0,
      };
      let terminal = false;
      try {
        for await (const event of stream) {
          throwIfAborted(signal);
          if (event.type === "response.output_text.delta") {
            yield { type: "text-delta", delta: event.delta };
            continue;
          }
          if (event.type === "response.output_item.added" || event.type === "response.output_item.done") {
            if (event.item.type === "function_call") {
              const itemId = event.item.id;
              const discoveryKey = itemId ?? nextSyntheticDiscoveryKey(pending, discovery);
              const state = discoverCall(pending, discoveryKey, discovery);
              if (state === undefined) {
                yield* terminalAttempts(pending, discovery, this.#limits.argumentBytes);
                yield discoveryError(discovery.failure!);
                return;
              }
              if (itemId === undefined) state.malformed = true;
              observeStreamItem(state, event.item);
              if (event.type === "response.output_item.added") {
                observeInitialArguments(state, event.item.arguments, discovery, this.#limits.argumentBytes);
              } else {
                observeFinalArguments(state, event.item.arguments, discovery, this.#limits.argumentBytes);
              }
              if (discovery.failure !== undefined) {
                yield* terminalAttempts(pending, discovery, this.#limits.argumentBytes);
                yield discoveryError(discovery.failure);
                return;
              }
            }
            continue;
          }
          if (event.type === "response.function_call_arguments.delta") {
            const state = discoverCall(pending, event.item_id, discovery);
            if (state === undefined) {
              yield* terminalAttempts(pending, discovery, this.#limits.argumentBytes);
              yield discoveryError(discovery.failure!);
              return;
            }
            observeArgumentDelta(state, event.delta, discovery, this.#limits.argumentBytes);
            if (discovery.failure !== undefined) {
              yield* terminalAttempts(pending, discovery, this.#limits.argumentBytes);
              yield discoveryError(discovery.failure);
              return;
            }
            continue;
          }
          if (event.type === "response.function_call_arguments.done") {
            const state = discoverCall(pending, event.item_id, discovery);
            if (state === undefined) {
              yield* terminalAttempts(pending, discovery, this.#limits.argumentBytes);
              yield discoveryError(discovery.failure!);
              return;
            }
            observeName(state, event.name);
            observeFinalArguments(state, event.arguments, discovery, this.#limits.argumentBytes);
            if (discovery.failure !== undefined) {
              yield* terminalAttempts(pending, discovery, this.#limits.argumentBytes);
              yield discoveryError(discovery.failure);
              return;
            }
            continue;
          }
          if (event.type === "response.completed") {
            const calls = reconcileCompletedCalls(
              pending,
              event.response.output,
              discovery,
              this.#limits.argumentBytes,
            );
            if (discovery.failure !== undefined) {
              yield* terminalAttempts(pending, discovery, this.#limits.argumentBytes);
              yield discoveryError(discovery.failure);
              return;
            }
            if (calls.some((state) => state.sawProgramCaller)) {
              yield* terminalAttempts(pending, discovery, this.#limits.argumentBytes);
              yield providerError("programmatic-tool-call", "Programmatic tool calls are disabled.");
              return;
            }
            const finalized = calls.map((state, index) =>
              finalizeCall(state, index, discovery, this.#limits.argumentBytes),
            );
            if (finalized.some((value) => !value.arguments.ok)) {
              for (const [index, state] of calls.entries()) {
                yield nonExecutableAttempt(state, index);
              }
              yield providerError("invalid-tool-call-batch", "The model emitted invalid tool-call arguments.");
              return;
            }
            const nextHistory = [...this.#history, ...(event.response.output as ResponseInputItem[])];
            if (!withinContinuationLimits(nextHistory, this.#limits)) {
              for (const [index, state] of calls.entries()) {
                yield nonExecutableAttempt(state, index);
              }
              yield providerError("continuation-limit", "The in-memory continuation limit was reached.");
              return;
            }
            yield* finalized;
            this.#history = nextHistory;
            terminal = true;
            yield { type: "completed" };
            return;
          }
          if (event.type === "response.failed") {
            terminal = true;
            yield* terminalAttempts(pending, discovery, this.#limits.argumentBytes);
            yield providerError("response-failed", "The model provider failed the response.");
            return;
          }
          if (event.type === "response.incomplete") {
            terminal = true;
            yield* terminalAttempts(pending, discovery, this.#limits.argumentBytes);
            yield providerError(
              incompleteCode(event.response.incomplete_details?.reason),
              "The model provider returned an incomplete response.",
            );
            return;
          }
          if (event.type === "error") {
            terminal = true;
            yield* terminalAttempts(pending, discovery, this.#limits.argumentBytes);
            yield providerError("provider-error", "The model provider reported an error.");
            return;
          }
        }
      } catch (error: unknown) {
        yield* terminalAttempts(pending, discovery, this.#limits.argumentBytes);
        yield normalizeProviderError(error, signal);
        return;
      }
      if (!terminal) {
        yield* terminalAttempts(pending, discovery, this.#limits.argumentBytes);
        yield providerError("stream-incomplete", "The model stream ended without completion.");
      }
    } finally {
      this.#responding = false;
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#history = [];
    this.#client.close?.();
  }
}

export function normalizeEndpoint(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Model endpoint is invalid");
  }
  if (url.username.length > 0 || url.password.length > 0) throw new Error("Model endpoint credentials are forbidden");
  if (url.search.length > 0) throw new Error("Model endpoint query strings are forbidden");
  if (url.hash.length > 0) throw new Error("Model endpoint fragments are forbidden");
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("Model endpoint must use HTTPS except for loopback development");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Model endpoint protocol is unsupported");
  const normalizedPath = url.pathname.replace(/\/+$/u, "");
  return `${url.origin}${normalizedPath}`;
}

export function assertStrictToolSchema(schema: StrictToolSchema): void {
  inspectSchema(schema, "$");
}

export function assertNodeRuntimeCompatibility(version = process.versions.node): void {
  const [majorText] = version.split(".");
  const major = Number(majorText);
  if (!Number.isSafeInteger(major) || major < 20) {
    throw new Error("RbxForge Agent requires Node 20 LTS or newer");
  }
}

function productionClientFactory(options: ClientFactoryOptions): ResponsesClientPort {
  const client = new OpenAI(options);
  return {
    responses: {
      create: async (body, requestOptions) => client.responses.create(body, requestOptions),
    },
  };
}

function buildInput(request: ProviderRequest): ResponseInput {
  const text = [
    request.input,
    ...request.context.records
      .filter((record) => record.kind !== "screenshot")
      .map(
        (record) => `<context kind="${record.kind}" label="${xmlLabel(record.label)}">\n${record.content}\n</context>`,
      ),
  ].join("\n\n");
  const content: Array<
    | { readonly type: "input_text"; readonly text: string }
    | { readonly type: "input_image"; readonly image_url: string; readonly detail: "auto" }
  > = [{ type: "input_text", text }];
  for (const record of request.context.records) {
    if (record.kind === "screenshot" && record.mimeType?.startsWith("image/") === true) {
      content.push({
        type: "input_image",
        image_url: `data:${record.mimeType};base64,${record.content}`,
        detail: "auto",
      });
    }
  }
  return [{ type: "message", role: "user", content }];
}

type ToolCallProviderEvent = Extract<ProviderEvent, { readonly type: "tool-call" }>;

function finalizeCall(
  state: PendingCall,
  index: number,
  discovery: DiscoveryState,
  argumentLimit: number,
): ToolCallProviderEvent {
  if (state.callId === undefined || state.name === undefined || state.final === undefined) {
    state.malformed = true;
  }
  const callId = state.callId ?? `malformed-call-${index}`;
  const name = state.name ?? "malformed-tool-call";
  const exact = state.final;
  if (state.oversized || state.bytes > argumentLimit) {
    clearRaw(state, discovery);
    return {
      type: "tool-call",
      callId,
      name,
      arguments: { ok: false, code: "oversized", bytes: state.bytes },
    };
  }
  if (state.sawProgramCaller || state.malformed || exact === undefined) {
    clearRaw(state, discovery);
    return {
      type: "tool-call",
      callId,
      name,
      arguments: { ok: false, code: "malformed", bytes: state.bytes },
    };
  }
  clearRaw(state, discovery);
  let parsed: unknown;
  try {
    parsed = JSON.parse(exact);
  } catch {
    state.malformed = true;
    return {
      type: "tool-call",
      callId,
      name,
      arguments: { ok: false, code: "malformed", bytes: state.bytes },
    };
  }
  return {
    type: "tool-call",
    callId,
    name,
    arguments: { ok: true, value: parsed, bytes: state.bytes },
  };
}

function newCall(): PendingCall {
  return {
    callId: undefined,
    name: undefined,
    caller: undefined,
    finalCaller: undefined,
    chunks: [],
    initial: undefined,
    deltaBytes: 0,
    bytes: 0,
    retainedBytes: 0,
    oversized: false,
    malformed: false,
    sawProgramCaller: false,
    final: undefined,
  };
}

function observeStreamItem(
  state: PendingCall,
  item: Extract<ResponseOutputItem, { readonly type: "function_call" }>,
): void {
  observeCallId(state, item.call_id);
  observeName(state, item.name);
  const caller = item.caller?.type;
  if (caller !== undefined) observeCaller(state, caller);
}

function observeCallId(state: PendingCall, value: string): void {
  if (state.callId !== undefined && state.callId !== value) state.malformed = true;
  state.callId ??= value;
}

function observeName(state: PendingCall, value: string): void {
  if (state.name !== undefined && state.name !== value) state.malformed = true;
  state.name ??= value;
}

function observeCaller(state: PendingCall, value: "direct" | "program"): void {
  if (state.caller !== undefined && state.caller !== value) state.malformed = true;
  state.caller ??= value;
  if (value === "program") state.sawProgramCaller = true;
}

function discoverCall(
  pending: Map<string, PendingCall>,
  itemId: string,
  discovery: DiscoveryState,
): PendingCall | undefined {
  const existing = pending.get(itemId);
  if (existing !== undefined) return existing;
  if (pending.size >= MAX_DISCOVERED_TOOL_CALLS) {
    discovery.failure = "tool-call";
    return undefined;
  }
  const state = newCall();
  pending.set(itemId, state);
  return state;
}

function nextSyntheticDiscoveryKey(pending: ReadonlyMap<string, PendingCall>, discovery: DiscoveryState): string {
  let key: string;
  do {
    key = `\u0000completed-${discovery.syntheticKey}`;
    discovery.syntheticKey += 1;
  } while (pending.has(key));
  return key;
}

function observeInitialArguments(
  state: PendingCall,
  value: string,
  discovery: DiscoveryState,
  argumentLimit: number,
): void {
  if (value.length === 0) return;
  const bytes = Buffer.byteLength(value);
  observeBytes(state, bytes, discovery, argumentLimit);
  if (state.initial !== undefined || state.final !== undefined) {
    const previous = state.initial ?? state.final;
    if (previous !== value) state.malformed = true;
    return;
  }
  if (state.oversized || discovery.failure !== undefined) {
    clearRaw(state, discovery);
    return;
  }
  if (retainRaw(state, value, discovery)) state.initial = value;
}

function observeArgumentDelta(
  state: PendingCall,
  value: string,
  discovery: DiscoveryState,
  argumentLimit: number,
): void {
  if (state.initial !== undefined || state.final !== undefined) return;
  const bytes = Buffer.byteLength(value);
  state.deltaBytes += bytes;
  observeBytes(state, state.deltaBytes, discovery, argumentLimit);
  if (state.oversized || discovery.failure !== undefined) {
    clearRaw(state, discovery);
    return;
  }
  if (retainRaw(state, value, discovery)) state.chunks.push(value);
}

function observeFinalArguments(
  state: PendingCall,
  value: string,
  discovery: DiscoveryState,
  argumentLimit: number,
): void {
  const bytes = Buffer.byteLength(value);
  observeBytes(state, bytes, discovery, argumentLimit);
  if (state.final !== undefined) {
    if (state.final !== value) state.malformed = true;
    if (state.oversized || discovery.failure !== undefined) clearRaw(state, discovery);
    return;
  }
  if (state.oversized || discovery.failure !== undefined) {
    clearRaw(state, discovery);
    return;
  }
  if (state.initial !== undefined) {
    if (state.initial !== value) state.malformed = true;
    state.final = state.initial;
    state.initial = undefined;
    return;
  }
  if (state.chunks.length > 0) {
    if (!chunksEqual(state.chunks, value)) {
      state.malformed = true;
      clearRaw(state, discovery);
      return;
    }
    clearRaw(state, discovery);
  }
  if (retainRaw(state, value, discovery)) state.final = value;
}

function chunksEqual(chunks: readonly string[], value: string): boolean {
  let offset = 0;
  for (const chunk of chunks) {
    if (!value.startsWith(chunk, offset)) return false;
    offset += chunk.length;
  }
  return offset === value.length;
}

function observeBytes(state: PendingCall, bytes: number, discovery: DiscoveryState, argumentLimit: number): void {
  if (bytes > state.bytes) {
    discovery.observedBytes += bytes - state.bytes;
    state.bytes = bytes;
  }
  if (state.bytes > argumentLimit) state.oversized = true;
  if (discovery.observedBytes > MAX_TOOL_CALL_ARGUMENT_BYTES) {
    discovery.failure = "arguments";
  }
}

function retainRaw(state: PendingCall, value: string, discovery: DiscoveryState): boolean {
  const bytes = Buffer.byteLength(value);
  if (discovery.failure !== undefined || discovery.retainedBytes + bytes > MAX_TOOL_CALL_ARGUMENT_BYTES) {
    clearRaw(state, discovery);
    discovery.failure = "arguments";
    return false;
  }
  state.retainedBytes += bytes;
  discovery.retainedBytes += bytes;
  return true;
}

function clearRaw(state: PendingCall, discovery?: DiscoveryState): void {
  if (discovery !== undefined) discovery.retainedBytes -= state.retainedBytes;
  state.retainedBytes = 0;
  state.chunks.splice(0);
  state.initial = undefined;
  state.final = undefined;
}

function terminalAttempts(
  pending: ReadonlyMap<string, PendingCall>,
  discovery: DiscoveryState,
  _argumentLimit: number,
): readonly ProviderEvent[] {
  const attempts: ProviderEvent[] = [];
  let index = 0;
  for (const state of pending.values()) {
    attempts.push(nonExecutableAttempt(state, index));
    clearRaw(state, discovery);
    index += 1;
  }
  return attempts;
}

function nonExecutableAttempt(state: PendingCall, index: number): ToolCallProviderEvent {
  return {
    type: "tool-call",
    callId: state.callId ?? `malformed-call-${index}`,
    name: state.name ?? "malformed-tool-call",
    arguments: {
      ok: false,
      code: state.oversized ? "oversized" : "malformed",
      bytes: state.bytes,
    },
  };
}

function discoveryError(failure: DiscoveryFailure): ProviderEvent {
  return failure === "tool-call"
    ? providerError("tool-call-discovery-limit", "The model emitted too many tool calls.")
    : providerError("argument-discovery-limit", "The model emitted too many tool-call argument bytes.");
}

function reconcileCompletedCalls(
  pending: Map<string, PendingCall>,
  output: readonly ResponseOutputItem[],
  discovery: DiscoveryState,
  argumentLimit: number,
): readonly PendingCall[] {
  const calls: PendingCall[] = [];
  const seenItemIds = new Set<string>();
  const reconciled = new Set<PendingCall>();
  for (const item of output) {
    if (item.type !== "function_call") continue;
    const itemId = item.id;
    const duplicate = itemId !== undefined && seenItemIds.has(itemId);
    const discoveryKey = itemId === undefined || duplicate ? nextSyntheticDiscoveryKey(pending, discovery) : itemId;
    const state = discoverCall(pending, discoveryKey, discovery);
    if (state === undefined) break;
    if (itemId === undefined || duplicate) state.malformed = true;
    if (itemId !== undefined) seenItemIds.add(itemId);

    if (state.callId !== undefined && state.callId !== item.call_id) state.malformed = true;
    if (state.name !== undefined && state.name !== item.name) state.malformed = true;
    const finalCaller = item.caller?.type;
    if (state.caller !== undefined && finalCaller !== undefined && state.caller !== finalCaller) state.malformed = true;
    if (finalCaller !== undefined) observeCaller(state, finalCaller);
    state.callId = item.call_id;
    state.name = item.name;
    observeFinalArguments(state, item.arguments, discovery, argumentLimit);
    state.finalCaller = finalCaller;
    calls.push(state);
    reconciled.add(state);
  }
  for (const state of pending.values()) {
    if (reconciled.has(state)) continue;
    state.malformed = true;
    state.finalCaller = undefined;
    calls.push(state);
  }
  return calls;
}

function withinContinuationLimits(
  history: readonly ResponseInputItem[],
  limits: typeof OPENAI_PROVIDER_LIMITS,
): boolean {
  if (history.length > limits.continuationItems) return false;
  try {
    return Buffer.byteLength(JSON.stringify(history)) <= limits.continuationBytes;
  } catch {
    return false;
  }
}

function inspectSchema(value: unknown, path: string): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return;
  const schema = value as Readonly<Record<string, unknown>>;
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.includes("object")) {
    if (schema.additionalProperties !== false) {
      throw new Error(`${path} object schema must set additionalProperties:false`);
    }
    const properties = isRecord(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    if (Object.keys(properties).some((key) => !required.includes(key))) {
      throw new Error(`${path} object schema must require every property`);
    }
    for (const [key, child] of Object.entries(properties)) inspectSchema(child, `${path}.${key}`);
  }
  if (Array.isArray(schema.items)) schema.items.forEach((child, index) => inspectSchema(child, `${path}[${index}]`));
  else if (schema.items !== undefined) inspectSchema(schema.items, `${path}[]`);
  for (const keyword of ["anyOf", "allOf", "oneOf"] as const) {
    const children = schema[keyword];
    if (Array.isArray(children))
      children.forEach((child, index) => inspectSchema(child, `${path}.${keyword}[${index}]`));
  }
}

function normalizeProviderError(error: unknown, signal: AbortSignal): ProviderEvent {
  if (signal.aborted || errorName(error) === "APIUserAbortError" || errorName(error) === "AbortError") {
    return providerError("cancelled", "The model request was stopped.");
  }
  switch (errorName(error)) {
    case "APIConnectionTimeoutError":
      return providerError("timeout", "The model provider timed out.");
    case "AuthenticationError":
      return providerError("authentication", "The model provider rejected the credential.");
    case "RateLimitError":
      return providerError("rate-limit", "The model provider rate limit was reached.");
    case "APIConnectionError":
      return providerError("connection", "The model provider connection failed.");
    case "APIError":
      return providerError("api-error", "The model provider rejected the request.");
    default:
      return providerError("provider-failure", "The model provider request failed.");
  }
}

function incompleteCode(reason: string | undefined): string {
  const allowed = new Set(["max_output_tokens", "content_filter"]);
  return reason !== undefined && allowed.has(reason)
    ? `incomplete-${reason.replaceAll("_", "-")}`
    : "response-incomplete";
}

function providerError(code: string, message: string): ProviderEvent {
  return Object.freeze({ type: "error", code, message });
}

function errorName(error: unknown): string {
  if (error !== null && typeof error === "object") {
    const name = (error as Readonly<{ name?: unknown }>).name;
    if (typeof name === "string") return name;
    const constructorName = (error as { constructor?: { name?: unknown } }).constructor?.name;
    if (typeof constructorName === "string") return constructorName;
  }
  return "";
}

function xmlLabel(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new Error("Operation aborted");
}
