import type {
  ModelProvider,
  ModelSession,
  ProviderCapabilities,
  ProviderEvent,
  ProviderRequest,
  ProviderTurnInput,
} from "@rbxforge/agent";

export class FakeModelProvider implements ModelProvider {
  readonly capabilities: ProviderCapabilities;
  readonly requests: ProviderRequest[] = [];
  readonly sessions: FakeModelSession[] = [];
  readonly #turns: readonly (readonly ProviderEvent[])[];

  constructor(
    turns: readonly (readonly ProviderEvent[])[] = [
      [
        { type: "text-delta", delta: "Fixture Agent is ready. Select context and describe a Roblox change." },
        { type: "completed" },
      ],
    ],
    capabilities: ProviderCapabilities = { vision: false },
  ) {
    this.#turns = turns;
    this.capabilities = Object.freeze({ ...capabilities });
  }

  async open(request: ProviderRequest, signal: AbortSignal): Promise<ModelSession> {
    if (signal.aborted) throw signal.reason ?? new Error("Fixture provider aborted");
    this.requests.push(request);
    const session = new FakeModelSession(this.#turns);
    this.sessions.push(session);
    return session;
  }
}

export class FakeModelSession implements ModelSession {
  readonly inputs: ProviderTurnInput[] = [];
  closeCount = 0;
  readonly #turns: readonly (readonly ProviderEvent[])[];
  #index = 0;

  constructor(turns: readonly (readonly ProviderEvent[])[]) {
    this.#turns = turns;
  }

  async *respond(input: ProviderTurnInput, signal: AbortSignal): AsyncIterable<ProviderEvent> {
    this.inputs.push(input);
    for (const event of this.#turns[this.#index++] ?? [{ type: "completed" as const }]) {
      if (signal.aborted) return;
      yield Object.freeze(event);
    }
  }

  async close(): Promise<void> {
    this.closeCount += 1;
  }
}
