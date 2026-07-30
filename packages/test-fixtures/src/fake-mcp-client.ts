export interface FakeTool {
  readonly name: string;
  readonly inputSchema: unknown;
}

export interface FakeMcpCall {
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

type ToolResponse = unknown | ((input: FakeMcpCall) => unknown | Promise<unknown>);

export class FakeMcpClient {
  readonly #responses: ToolResponse[];
  readonly #tools: readonly FakeTool[];
  readonly #calls: FakeMcpCall[] = [];
  #closed = false;

  constructor(options: { readonly tools: readonly FakeTool[]; readonly responses?: readonly ToolResponse[] }) {
    this.#tools = Object.freeze(options.tools.map((tool) => Object.freeze({ ...tool })));
    this.#responses = [...(options.responses ?? [])];
  }

  get calls(): readonly FakeMcpCall[] {
    return Object.freeze([...this.#calls]);
  }

  get closed(): boolean {
    return this.#closed;
  }

  async listTools(): Promise<{ tools: readonly FakeTool[] }> {
    return { tools: this.#tools };
  }

  async callTool(input: { name: string; arguments: Record<string, unknown> }): Promise<unknown> {
    const call = Object.freeze({
      name: input.name,
      arguments: Object.freeze({ ...input.arguments }),
    });
    this.#calls.push(call);
    const response = this.#responses.shift();
    if (typeof response === "function") {
      return response(call);
    }
    return response;
  }

  async close(): Promise<void> {
    this.#closed = true;
  }
}
