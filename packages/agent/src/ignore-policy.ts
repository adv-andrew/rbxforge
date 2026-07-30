export interface IgnorePolicyResult {
  readonly path: string;
  readonly ignored: boolean;
}

export interface IgnorePolicyAttestation {}

export interface IgnorePolicyEvaluation {
  readonly results: readonly IgnorePolicyResult[];
  readonly attestation: IgnorePolicyAttestation;
}

export interface IgnorePolicyPort {
  evaluate(paths: readonly string[], signal: AbortSignal): Promise<IgnorePolicyEvaluation>;
  isCurrent(attestation: IgnorePolicyAttestation): boolean;
  dispose(): void;
}

export interface RevisionedIgnorePolicyOptions {
  readonly evaluate: (path: string, signal: AbortSignal) => boolean | Promise<boolean>;
  readonly subscribe?: (invalidate: () => void) => Readonly<{ dispose(): void }>;
}

export class RevisionedIgnorePolicy implements IgnorePolicyPort {
  readonly #evaluatePath: RevisionedIgnorePolicyOptions["evaluate"];
  readonly #revisions = new WeakMap<object, number>();
  readonly #subscription: Readonly<{ dispose(): void }> | undefined;
  #revision = 0;
  #disposed = false;

  constructor(options: RevisionedIgnorePolicyOptions) {
    this.#evaluatePath = options.evaluate;
    this.#subscription = options.subscribe?.(() => this.invalidate());
  }

  async evaluate(paths: readonly string[], signal: AbortSignal): Promise<IgnorePolicyEvaluation> {
    if (this.#disposed) throw new Error("Ignore policy is disposed");
    throwIfAborted(signal);
    const revision = this.#revision;
    const results = Object.freeze(
      await Promise.all(
        paths.map(async (path) => {
          throwIfAborted(signal);
          let ignored: boolean;
          try {
            ignored = await this.#evaluatePath(path, signal);
          } catch (error: unknown) {
            if (signal.aborted) throw error;
            ignored = true;
          }
          throwIfAborted(signal);
          return Object.freeze({ path, ignored });
        }),
      ),
    );
    const attestation = Object.freeze({});
    this.#revisions.set(attestation, revision);
    return Object.freeze({ results, attestation });
  }

  isCurrent(attestation: IgnorePolicyAttestation): boolean {
    return (
      !this.#disposed &&
      typeof attestation === "object" &&
      attestation !== null &&
      this.#revisions.get(attestation) === this.#revision
    );
  }

  invalidate(): void {
    if (!this.#disposed) this.#revision += 1;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#revision += 1;
    this.#subscription?.dispose();
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new Error("Ignore policy evaluation aborted");
}
