import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import type { ProcessHandle, ProcessResult, ProcessRunner, ProcessSpec } from "@rbxforge/rojo";

const OUTPUT_LIMIT_BYTES = 8_192;
const DEFAULT_TERMINATION_GRACE_MS = 250;
const DEFAULT_KILL_GRACE_MS = 250;

type OwnedChild = ChildProcessByStdio<null, Readable, Readable>;

export interface NodeProcessRunnerOptions {
  readonly terminationGraceMs?: number;
  readonly killGraceMs?: number;
}

export function createNodeProcessRunner(options: NodeProcessRunnerOptions = {}): ProcessRunner {
  const terminationGraceMs = positiveDuration(options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS);
  const killGraceMs = positiveDuration(options.killGraceMs ?? DEFAULT_KILL_GRACE_MS);

  return Object.freeze({
    async run(spec: ProcessSpec): Promise<ProcessResult> {
      const timeoutMs = spec.timeoutMs === undefined ? undefined : positiveDuration(spec.timeoutMs);
      const handle = startOwned(spec, terminationGraceMs, killGraceMs);
      if (timeoutMs === undefined) return handle.exited();
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
        timer.unref();
      });
      const exit = handle.exited();
      const winner = await Promise.race([exit.then(() => "exit" as const), timeout.then(() => "timeout" as const)]);
      if (winner === "timeout") await handle.stop();
      if (timer !== undefined) clearTimeout(timer);
      return exit;
    },

    async start(spec: ProcessSpec): Promise<ProcessHandle> {
      return startOwned(spec, terminationGraceMs, killGraceMs);
    },
  });
}

export class ProcessTerminationError extends Error {
  constructor() {
    super("Owned process did not close after SIGKILL within the bounded grace period.");
    this.name = "ProcessTerminationError";
  }
}

function startOwned(spec: ProcessSpec, terminationGraceMs: number, killGraceMs: number): ProcessHandle {
  const stdout = new BoundedByteTail(OUTPUT_LIMIT_BYTES);
  const stderr = new BoundedByteTail(OUTPUT_LIMIT_BYTES);
  const child = spawn(spec.command, [...spec.args], {
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.on("data", (chunk: Buffer | string) => stdout.append(chunk));
  child.stderr.on("data", (chunk: Buffer | string) => stderr.append(chunk));

  let settled = false;
  let resolveExit!: (result: ProcessResult) => void;
  const exitPromise = new Promise<ProcessResult>((resolve) => {
    resolveExit = resolve;
  });
  const settle = (exitCode: number): void => {
    if (settled) return;
    settled = true;
    resolveExit(
      Object.freeze({
        exitCode,
        stdout: stdout.toString(),
        stderr: stderr.toString(),
      }),
    );
  };

  child.once("error", (error) => {
    stderr.append(error.message);
  });
  child.once("close", (code, signal) => {
    settle(code ?? signalExitCode(signal));
  });

  let stopPromise: Promise<void> | undefined;
  const handle: ProcessHandle = Object.freeze({
    exited(): Promise<ProcessResult> {
      return exitPromise;
    },
    stop(): Promise<void> {
      if (stopPromise !== undefined) return stopPromise;
      stopPromise = stopOwnedChild(child, exitPromise, terminationGraceMs, killGraceMs);
      return stopPromise;
    },
  });
  return handle;
}

async function stopOwnedChild(
  child: OwnedChild,
  exited: Promise<ProcessResult>,
  terminationGraceMs: number,
  killGraceMs: number,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    if (!(await settlesWithin(exited, killGraceMs))) throw new ProcessTerminationError();
    return;
  }
  child.kill("SIGTERM");
  if (await settlesWithin(exited, terminationGraceMs)) return;
  child.kill("SIGKILL");
  if (!(await settlesWithin(exited, killGraceMs))) throw new ProcessTerminationError();
}

async function settlesWithin(exited: Promise<ProcessResult>, milliseconds: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), milliseconds);
    timer.unref();
  });
  const settled = await Promise.race([exited.then(() => true), deadline]);
  if (timer !== undefined) clearTimeout(timer);
  return settled;
}

function positiveDuration(value: number): number {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError("Process duration must be a positive finite number");
  return value;
}

function signalExitCode(signal: NodeJS.Signals | null): number {
  return signal === "SIGTERM" ? 143 : signal === "SIGKILL" ? 137 : 1;
}

class BoundedByteTail {
  readonly #limit: number;
  #chunks: Buffer[] = [];
  #length = 0;

  constructor(limit: number) {
    this.#limit = limit;
  }

  append(chunk: Buffer | string): void {
    const bytes = Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk);
    if (bytes.length === 0) return;
    this.#chunks.push(bytes);
    this.#length += bytes.length;
    while (this.#length > this.#limit && this.#chunks.length > 0) {
      const first = this.#chunks[0];
      if (first === undefined) break;
      const excess = this.#length - this.#limit;
      if (first.length <= excess) {
        this.#chunks.shift();
        this.#length -= first.length;
      } else {
        this.#chunks[0] = first.subarray(excess);
        this.#length -= excess;
      }
    }
  }

  toString(): string {
    let bytes = Buffer.concat(this.#chunks, this.#length);
    let value = bytes.toString("utf8");
    while (Buffer.byteLength(value) > this.#limit && bytes.length > 0) {
      bytes = bytes.subarray(1);
      value = bytes.toString("utf8");
    }
    return value;
  }
}
