export interface FakeProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface FakeProcessCall {
  readonly command: string;
  readonly args: readonly string[];
  readonly shell: false;
  readonly timeoutMs?: number;
}

export class FakeProcessHandle {
  stopCalls = 0;
  readonly #exit: Promise<FakeProcessResult>;
  #resolve: ((result: FakeProcessResult) => void) | undefined;
  #stopped = false;

  constructor(
    options: { readonly exitResult?: FakeProcessResult; readonly exitPromise?: Promise<FakeProcessResult> } = {},
  ) {
    this.#exit =
      options.exitPromise ??
      new Promise<FakeProcessResult>((resolve) => {
        this.#resolve = resolve;
      });
    if (options.exitResult !== undefined) {
      this.exit(options.exitResult);
    }
  }

  get stopped(): boolean {
    return this.#stopped;
  }

  exited(): Promise<FakeProcessResult> {
    return this.#exit;
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
    this.#stopped = true;
    this.exit({ exitCode: 0, stdout: "", stderr: "" });
  }

  exit(result: FakeProcessResult): void {
    this.#resolve?.(Object.freeze({ ...result }));
    this.#resolve = undefined;
  }
}

export class FakeProcessRunner {
  readonly #runResults: FakeProcessResult[];
  readonly #startedHandles: FakeProcessHandle[];
  readonly #calls: FakeProcessCall[] = [];

  constructor(
    options: {
      readonly runResults?: readonly FakeProcessResult[];
      readonly startedHandles?: readonly FakeProcessHandle[];
    } = {},
  ) {
    this.#runResults = [...(options.runResults ?? [])];
    this.#startedHandles = [...(options.startedHandles ?? [])];
  }

  get calls(): readonly FakeProcessCall[] {
    return Object.freeze([...this.#calls]);
  }

  async run(spec: {
    readonly command: string;
    readonly args: readonly string[];
    readonly shell: false;
    readonly timeoutMs?: number;
  }): Promise<FakeProcessResult> {
    this.#calls.push(
      Object.freeze({
        command: spec.command,
        args: Object.freeze([...spec.args]),
        shell: spec.shell,
        ...(spec.timeoutMs === undefined ? {} : { timeoutMs: spec.timeoutMs }),
      }),
    );
    return this.#runResults.shift() ?? { exitCode: 0, stdout: "", stderr: "" };
  }

  async start(spec: {
    readonly command: string;
    readonly args: readonly string[];
    readonly shell: false;
    readonly timeoutMs?: number;
  }): Promise<FakeProcessHandle> {
    this.#calls.push(
      Object.freeze({
        command: spec.command,
        args: Object.freeze([...spec.args]),
        shell: spec.shell,
        ...(spec.timeoutMs === undefined ? {} : { timeoutMs: spec.timeoutMs }),
      }),
    );
    const handle = this.#startedHandles.shift();
    if (handle === undefined) throw new Error("FakeProcessRunner started more children than configured");
    return handle;
  }
}
