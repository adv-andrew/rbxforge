import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

const STDERR_READINESS_WINDOW_LENGTH = 8_192;

export interface ProcessSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly readinessToken: string;
  readonly timeoutMs?: number;
  readonly terminationTimeoutMs?: number;
  readonly redact?: readonly string[];
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface ProcessSupervisorSnapshot {
  readonly running: boolean;
  readonly ready: boolean;
  readonly diagnostics: readonly string[];
}

export class ProcessSupervisor {
  readonly #onDiagnostic: ((line: string) => void) | undefined;
  #child: ChildProcessWithoutNullStreams | undefined;
  #ready = false;
  #diagnostics: string[] = [];
  #exitPromise: Promise<void> | undefined;
  #terminationTimeoutMs = 1_000;
  #stderrReadinessWindow = "";

  constructor(options: { readonly onDiagnostic?: (line: string) => void } = {}) {
    this.#onDiagnostic = options.onDiagnostic;
  }

  snapshot(): ProcessSupervisorSnapshot {
    return Object.freeze({
      running: this.#child !== undefined,
      ready: this.#ready,
      diagnostics: Object.freeze([...this.#diagnostics]),
    });
  }

  async start(spec: ProcessSpec): Promise<void> {
    if (this.#child !== undefined) {
      throw new Error("Process supervisor is already running");
    }
    this.#ready = false;
    this.#diagnostics = [];
    this.#stderrReadinessWindow = "";
    this.#terminationTimeoutMs = spec.terminationTimeoutMs ?? 1_000;
    const child = spawn(spec.command, [...spec.args], {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      ...(spec.env === undefined ? {} : { env: { ...process.env, ...spec.env } }),
    });
    this.#child = child;

    let resolveExit: (() => void) | undefined;
    this.#exitPromise = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (outcome: "resolve" | "reject", error?: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        if (outcome === "resolve") {
          resolve();
        } else {
          reject(error ?? new Error("Process failed before readiness"));
        }
      };

      child.once("error", (error) => {
        this.recordDiagnostic(`process error: ${error.message}`, spec.redact);
        if (this.#child === child) {
          this.#child = undefined;
          this.#ready = false;
        }
        resolveExit?.();
        finish("reject", error);
      });
      child.once("exit", (code, signal) => {
        const wasReady = this.#ready;
        if (this.#child === child) {
          this.#child = undefined;
          this.#ready = false;
        }
        resolveExit?.();
        if (!wasReady) {
          finish(
            "reject",
            new Error(`Process exited before readiness (code ${String(code)}, signal ${String(signal)})`),
          );
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        const output = chunk.toString("utf8");
        this.recordDiagnostic(output, spec.redact);
        this.#stderrReadinessWindow = `${this.#stderrReadinessWindow}${output}`.slice(-STDERR_READINESS_WINDOW_LENGTH);
        if (!this.#ready && this.#stderrReadinessWindow.includes(spec.readinessToken)) {
          this.#ready = true;
          finish("resolve");
        }
      });

      const timeoutMs = spec.timeoutMs ?? 10_000;
      timer = setTimeout(() => {
        finish("reject", new Error(`Process did not become ready within ${timeoutMs}ms`));
        void this.stop();
      }, timeoutMs);
    });
  }

  async stop(): Promise<void> {
    const child = this.#child;
    const exitPromise = this.#exitPromise;
    if (child === undefined || exitPromise === undefined) {
      return;
    }
    child.kill("SIGTERM");
    let forced = false;
    const forceTimer = setTimeout(() => {
      if (this.#child === child) {
        forced = true;
        this.recordDiagnostic("Process did not exit after SIGTERM; sending SIGKILL", []);
        child.kill("SIGKILL");
      }
    }, this.#terminationTimeoutMs);
    await exitPromise;
    clearTimeout(forceTimer);
    if (forced) {
      return;
    }
  }

  recordDiagnostic(output: string, redact: readonly string[] | undefined): void {
    const redacted = (redact ?? []).reduce(
      (line, secret) => (secret === "" ? line : line.split(secret).join("[REDACTED]")),
      output,
    );
    for (const line of redacted.split(/\r?\n/).filter((line) => line.length > 0)) {
      this.#diagnostics.push(line);
      this.#onDiagnostic?.(line);
    }
  }
}
