import { join } from "node:path";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { FakeProcessHandle, FakeProcessRunner } from "@rbxforge/test-fixtures";
import { RojoService } from "./rojo-service.js";

async function* protocolEvents(): AsyncIterable<{
  readonly type: "snapshot" | "patch";
  readonly sessionId: string;
  readonly protocolVersion: number;
  readonly nodes: readonly [];
}> {
  yield { type: "snapshot", sessionId: "a", protocolVersion: 5, nodes: [] };
  yield { type: "patch", sessionId: "a", protocolVersion: 5, nodes: [] };
  yield { type: "snapshot", sessionId: "b", protocolVersion: 5, nodes: [] };
}

function noSourcemap() {
  return { watch: () => ({ async *[Symbol.asyncIterator]() {} }) };
}

function sequence(...ports: number[]) {
  return async () => ports.shift()!;
}

function deferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function flushMicrotasks(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
}

describe("RojoService", () => {
  it("polls until healthy and retains only the successful child", async () => {
    const first = new FakeProcessHandle({ exitResult: { exitCode: 1, stdout: "", stderr: "address in use" } });
    const second = new FakeProcessHandle();
    const runner = new FakeProcessRunner({ startedHandles: [first, second] });
    const ports = [34872, 34873];
    const probes = new Map([
      [34872, [false]],
      [34873, [false, true]],
    ]);
    let now = 0;
    const service = new RojoService({
      runner,
      command: "/opt/homebrew/bin/rojo",
      allocatePort: async () => ports.shift()!,
      probeHealth: async (port) => probes.get(port)!.shift() ?? false,
      sleep: async (milliseconds) => {
        now += milliseconds;
      },
      now: () => now,
      sourcemap: noSourcemap(),
    });

    await expect(service.start("/repo/default.project.json")).resolves.toEqual({
      processRunning: true,
      apiHealthy: true,
      port: 34873,
    });
    expect(runner.calls).toEqual([
      {
        command: "/opt/homebrew/bin/rojo",
        args: ["serve", "/repo/default.project.json", "--address", "127.0.0.1", "--port", "34872"],
        shell: false,
      },
      {
        command: "/opt/homebrew/bin/rojo",
        args: ["serve", "/repo/default.project.json", "--address", "127.0.0.1", "--port", "34873"],
        shell: false,
      },
    ]);
    expect(first.stopCalls).toBe(1);
    expect(second.stopCalls).toBe(0);
  });

  it("actively probes the retained API when refreshing health", async () => {
    const probes = [true, false];
    const service = new RojoService({
      runner: new FakeProcessRunner({ startedHandles: [new FakeProcessHandle()] }),
      command: "/usr/local/bin/rojo",
      allocatePort: async () => 34872,
      probeHealth: async () => probes.shift() ?? false,
      sourcemap: noSourcemap(),
    });
    await service.start("/repo/default.project.json");

    await expect(service.checkHealth()).resolves.toEqual({
      processRunning: true,
      apiHealthy: false,
      port: 34872,
      state: "failed",
    });
    expect(service.status()).toMatchObject({ apiHealthy: false, state: "failed" });
  });

  it("stops every exact child and fails after three eight-second deadlines", async () => {
    const handles = [new FakeProcessHandle(), new FakeProcessHandle(), new FakeProcessHandle()];
    let now = 0;
    const service = new RojoService({
      runner: new FakeProcessRunner({ startedHandles: handles }),
      command: "/usr/local/bin/rojo",
      allocatePort: sequence(40001, 40002, 40003),
      probeHealth: async () => false,
      sleep: async (milliseconds) => {
        now += milliseconds;
      },
      now: () => now,
      sourcemap: noSourcemap(),
    });

    await expect(service.start("/repo/default.project.json")).rejects.toMatchObject({
      name: "RojoLaunchError",
      attempts: 3,
    });
    expect(handles.map((handle) => handle.stopCalls)).toEqual([1, 1, 1]);
  });

  it("bounds a never-settling health probe by the launch deadline", async () => {
    const clock = deferred<undefined>();
    const handle = new FakeProcessHandle();
    let now = 0;
    const service = new RojoService({
      runner: new FakeProcessRunner({ startedHandles: [handle] }),
      command: "/opt/rojo",
      allocatePort: async () => 40501,
      probeHealth: async () => new Promise<boolean>(() => undefined),
      launchAttempts: 1,
      healthPollIntervalMs: 8_000,
      healthDeadlineMs: 8_000,
      sleep: async (milliseconds) => {
        await clock.promise;
        now += milliseconds;
      },
      now: () => now,
      sourcemap: noSourcemap(),
    });
    const outcome = service.start("/repo/default.project.json").then(
      (status) => status,
      (error: unknown) => error,
    );

    await flushMicrotasks();
    clock.resolve(undefined);
    await flushMicrotasks();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(await Promise.race([outcome, Promise.resolve("still pending")])).toMatchObject({
      name: "RojoLaunchError",
      attempts: 1,
    });
    expect(handle.stopCalls).toBe(1);
  });

  it("rejects a healthy probe result that arrives after the launch deadline", async () => {
    const clock = deferred<undefined>();
    const health = deferred<boolean>();
    let now = 0;
    const service = new RojoService({
      runner: new FakeProcessRunner({ startedHandles: [new FakeProcessHandle()] }),
      command: "/opt/rojo",
      allocatePort: async () => 40502,
      probeHealth: async () => health.promise,
      launchAttempts: 1,
      healthPollIntervalMs: 8_000,
      healthDeadlineMs: 8_000,
      sleep: async (milliseconds) => {
        await clock.promise;
        now += milliseconds;
      },
      now: () => now,
      sourcemap: noSourcemap(),
    });
    const outcome = service.start("/repo/default.project.json").then(
      (status) => status,
      (error: unknown) => error,
    );

    await flushMicrotasks();
    clock.resolve(undefined);
    await flushMicrotasks();
    health.resolve(true);

    expect(await outcome).toMatchObject({ name: "RojoLaunchError", attempts: 1 });
  });

  it("retries when a child exits before its first healthy probe can be retained", async () => {
    const exited = new FakeProcessHandle({ exitResult: { exitCode: 1, stdout: "", stderr: "bind failed" } });
    const retained = new FakeProcessHandle();
    const runner = new FakeProcessRunner({ startedHandles: [exited, retained] });
    const service = new RojoService({
      runner,
      command: "/opt/rojo",
      allocatePort: sequence(41001, 41002),
      probeHealth: async () => true,
      sourcemap: noSourcemap(),
    });

    await expect(service.start("/repo/default.project.json")).resolves.toMatchObject({ port: 41002, apiHealthy: true });
    expect(exited.stopCalls).toBe(1);
    expect(runner.calls).toHaveLength(2);
  });

  it("discards duplicate allocations until each retry receives a unique port", async () => {
    const first = new FakeProcessHandle({ exitResult: { exitCode: 1, stdout: "", stderr: "collision" } });
    const second = new FakeProcessHandle();
    const runner = new FakeProcessRunner({ startedHandles: [first, second] });
    const service = new RojoService({
      runner,
      command: "/opt/rojo",
      allocatePort: sequence(42001, 42001, 42002),
      probeHealth: async () => true,
      sourcemap: noSourcemap(),
    });

    await expect(service.start("/repo/default.project.json")).resolves.toMatchObject({ port: 42002 });
    expect(runner.calls.map((call) => call.args.at(-1))).toEqual(["42001", "42002"]);
  });

  it("limits duplicate and invalid allocation results to sixteen across the whole start", async () => {
    const first = new FakeProcessHandle({ exitResult: { exitCode: 1, stdout: "", stderr: "collision" } });
    const forbiddenRetry = new FakeProcessHandle();
    const runner = new FakeProcessRunner({ startedHandles: [first, forbiddenRetry] });
    let allocations = 0;
    const service = new RojoService({
      runner,
      command: "/opt/rojo",
      allocatePort: async () => {
        allocations += 1;
        return allocations <= 16 ? 42501 : 42502;
      },
      probeHealth: async () => true,
      sourcemap: noSourcemap(),
    });

    await expect(service.start("/repo/default.project.json")).rejects.toMatchObject({
      name: "RojoLaunchError",
      attempts: 1,
    });
    expect(allocations).toBe(16);
    expect(runner.calls).toHaveLength(1);
    expect(forbiddenRetry.stopCalls).toBe(0);
  });

  it("retries after a health probe throws and retains only the later healthy child", async () => {
    const first = new FakeProcessHandle();
    const second = new FakeProcessHandle();
    let probes = 0;
    const service = new RojoService({
      runner: new FakeProcessRunner({ startedHandles: [first, second] }),
      command: "/opt/rojo",
      allocatePort: sequence(43001, 43002),
      probeHealth: async () => {
        probes += 1;
        if (probes === 1) throw new Error("connection reset");
        return true;
      },
      sourcemap: noSourcemap(),
    });

    await expect(service.start("/repo/default.project.json")).resolves.toMatchObject({ port: 43002, apiHealthy: true });
    expect(first.stopCalls).toBe(1);
    expect(second.stopCalls).toBe(0);
  });

  it("fails boundedly without spawning a retry when the failed child cannot be reaped", async () => {
    vi.useFakeTimers();
    try {
      const unreaped = new FakeProcessHandle({ exitPromise: new Promise(() => undefined) });
      const forbiddenRetry = new FakeProcessHandle();
      const runner = new FakeProcessRunner({ startedHandles: [unreaped, forbiddenRetry] });
      let probes = 0;
      const service = new RojoService({
        runner,
        command: "/opt/rojo",
        allocatePort: sequence(43501, 43502),
        probeHealth: async () => {
          probes += 1;
          if (probes === 1) throw new Error("probe failed");
          return true;
        },
        launchAttempts: 2,
        sourcemap: noSourcemap(),
      });

      const start = service.start("/repo/default.project.json");
      const rejection = expect(start).rejects.toMatchObject({ name: "RojoLaunchError", attempts: 1 });
      await flushMicrotasks();
      expect(unreaped.stopCalls).toBe(1);
      await vi.advanceTimersByTimeAsync(250);

      await rejection;
      expect(runner.calls).toHaveLength(1);
      expect(forbiddenRetry.stopCalls).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds the final child diagnostic and never starts a fourth child", async () => {
    const handles = [
      new FakeProcessHandle({ exitResult: { exitCode: 1, stdout: "", stderr: "first" } }),
      new FakeProcessHandle({ exitResult: { exitCode: 1, stdout: "", stderr: "second" } }),
      new FakeProcessHandle({ exitResult: { exitCode: 1, stdout: "", stderr: "x".repeat(9_000) } }),
    ];
    const runner = new FakeProcessRunner({ startedHandles: handles });
    const service = new RojoService({
      runner,
      command: "/opt/rojo",
      allocatePort: sequence(44001, 44002, 44003, 44004),
      probeHealth: async () => false,
      sourcemap: noSourcemap(),
    });

    await expect(service.start("/repo/default.project.json")).rejects.toMatchObject({
      name: "RojoLaunchError",
      attempts: 3,
      diagnostic: "x".repeat(8_192),
    });
    expect(runner.calls).toHaveLength(3);
  });

  it.each([0, -1, 1.5, Number.POSITIVE_INFINITY, Number.NaN])(
    "rejects invalid launchAttempts at construction: %p",
    (launchAttempts) => {
      expect(
        () =>
          new RojoService({
            runner: new FakeProcessRunner(),
            command: "/opt/rojo",
            allocatePort: async () => 1,
            probeHealth: async () => true,
            launchAttempts,
            sourcemap: noSourcemap(),
          }),
      ).toThrow(RangeError);
    },
  );

  it("caps configured launchAttempts above three without spawning a fourth child", async () => {
    const handles = Array.from(
      { length: 4 },
      (_, index) =>
        new FakeProcessHandle({
          exitResult: { exitCode: 1, stdout: "", stderr: `attempt ${index + 1}` },
        }),
    );
    const runner = new FakeProcessRunner({ startedHandles: handles });
    const service = new RojoService({
      runner,
      command: "/opt/rojo",
      allocatePort: sequence(44501, 44502, 44503, 44504),
      probeHealth: async () => true,
      launchAttempts: 4,
      sourcemap: noSourcemap(),
    });

    await expect(service.start("/repo/default.project.json")).rejects.toMatchObject({
      name: "RojoLaunchError",
      attempts: 3,
    });
    expect(runner.calls).toHaveLength(3);
    expect(handles[3]!.stopCalls).toBe(0);
  });

  it("stops the starting child when stop races a blocked health probe", async () => {
    const handle = new FakeProcessHandle();
    let releaseProbe: (() => void) | undefined;
    const probe = new Promise<boolean>((resolve) => {
      releaseProbe = () => resolve(true);
    });
    const runner = new FakeProcessRunner({ startedHandles: [handle] });
    const service = new RojoService({
      runner,
      command: "/opt/rojo",
      allocatePort: async () => 45001,
      probeHealth: async () => probe,
      sourcemap: noSourcemap(),
    });

    const start = service.start("/repo/default.project.json");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runner.calls).toHaveLength(1);
    await service.stop();
    releaseProbe?.();

    await expect(start).rejects.toMatchObject({ name: "RojoLaunchError", attempts: 1 });
    expect(handle.stopCalls).toBe(1);
  });

  it("builds outside the project and removes failed temporary output", async () => {
    const runner = new FakeProcessRunner({ runResults: [{ exitCode: 1, stdout: "", stderr: "build failed" }] });
    let removedPath: string | undefined;
    const service = new RojoService({
      runner,
      command: "/usr/bin/rojo",
      allocatePort: async () => 1,
      probeHealth: async () => true,
      temporaryPath: async () => "/tmp/rbxforge-build.rbxlx",
      removeTemporary: async (path) => {
        removedPath = path;
      },
      sourcemap: { watch: () => ({ async *[Symbol.asyncIterator]() {} }) },
    });

    const result = await service.buildTemporary("/repo/game.project.json");

    expect(runner.calls[0]).toEqual({
      command: "/usr/bin/rojo",
      args: ["build", "/repo/game.project.json", "--output", "/tmp/rbxforge-build.rbxlx"],
      shell: false,
    });
    expect(result).toEqual({ ok: false, outputPath: "/tmp/rbxforge-build.rbxlx", stdout: "", stderr: "build failed" });
    expect(removedPath).toBe("/tmp/rbxforge-build.rbxlx");
  });

  it("fails closed to watched absolute sourcemaps for incompatible protocol snapshots", async () => {
    const runner = new FakeProcessRunner({ startedHandles: [new FakeProcessHandle()] });
    const service = new RojoService({
      runner,
      command: "/usr/bin/rojo",
      allocatePort: async () => 1,
      probeHealth: async () => true,
      temporaryPath: async (suffix) => `/tmp/map${suffix}`,
      protocol: {
        events: () => ({
          async *[Symbol.asyncIterator]() {
            yield { type: "snapshot" as const, sessionId: "old", protocolVersion: 4, nodes: [] };
          },
        }),
      },
      sourcemap: {
        watch: () => ({
          async *[Symbol.asyncIterator]() {
            yield { name: "Game", className: "DataModel" };
          },
        }),
      },
    });

    const iterator = service.watchProjection("/repo/game.project.json")[Symbol.asyncIterator]();
    const first = await iterator.next();

    expect(first.value).toEqual({ type: "fallback", reason: "protocol-mismatch" });
    expect(runner.calls[0]).toEqual({
      command: "/usr/bin/rojo",
      shell: false,
      args: [
        "sourcemap",
        "/repo/game.project.json",
        "--output",
        "/tmp/map.json",
        "--watch",
        "--absolute",
        "--include-non-scripts",
      ],
    });
    await iterator.return?.();
  });

  it("streams protocol updates and resets before a replacement session snapshot", async () => {
    const service = new RojoService({
      runner: new FakeProcessRunner({ startedHandles: [new FakeProcessHandle()] }),
      command: "/usr/bin/rojo",
      allocatePort: async () => 1,
      probeHealth: async () => true,
      temporaryPath: async (suffix) => `/tmp/map${suffix}`,
      protocol: { events: () => protocolEvents() },
      sourcemap: {
        watch: () => ({
          async *[Symbol.asyncIterator]() {
            yield { name: "Game", className: "DataModel" };
          },
        }),
      },
    });
    const events: unknown[] = [];
    for await (const event of service.watchProjection("/repo/game.project.json")) events.push(event);
    expect(events).toEqual([
      { type: "snapshot", sessionId: "a", nodes: [] },
      { type: "update", sessionId: "a", nodes: [] },
      { type: "reset", sessionId: "b" },
      { type: "snapshot", sessionId: "b", nodes: [] },
      { type: "fallback", reason: "protocol-unavailable" },
      { type: "snapshot", sessionId: "sourcemap", nodes: [{ path: "game", name: "Game", className: "DataModel" }] },
    ]);
  });

  it("fails closed when a session starts with a patch or nodes expose raw protocol ids", async () => {
    const runner = new FakeProcessRunner({ startedHandles: [new FakeProcessHandle()] });
    const service = new RojoService({
      runner,
      command: "/usr/bin/rojo",
      allocatePort: async () => 1,
      probeHealth: async () => true,
      temporaryPath: async () => "/tmp/map.json",
      protocol: {
        events: () => ({
          async *[Symbol.asyncIterator]() {
            yield {
              type: "patch",
              sessionId: "new",
              protocolVersion: 5,
              nodes: [{ path: "game", name: "Game", className: "DataModel", id: "raw" }],
            };
          },
        }),
      },
      sourcemap: {
        watch: (_path, _signal) => ({
          async *[Symbol.asyncIterator]() {
            yield { name: "Game", className: "DataModel" };
          },
        }),
      },
    });
    const iterator = service.watchProjection("/repo/game.project.json")[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual({ type: "fallback", reason: "protocol-mismatch" });
    await iterator.return?.();
  });

  it.each([null, [], "text", { nested: Infinity }, { nested: () => true }])(
    "fails closed on invalid ProjectionNode properties: %p",
    async (properties) => {
      const service = new RojoService({
        runner: new FakeProcessRunner({ startedHandles: [new FakeProcessHandle()] }),
        command: "/usr/bin/rojo",
        allocatePort: async () => 1,
        probeHealth: async () => true,
        temporaryPath: async () => "/tmp/map.json",
        protocol: {
          events: () => ({
            async *[Symbol.asyncIterator]() {
              yield {
                type: "snapshot" as const,
                sessionId: "s",
                protocolVersion: 5,
                nodes: [{ path: "game", name: "Game", className: "DataModel", properties }],
              };
            },
          }),
        },
        sourcemap: {
          watch: () => ({
            async *[Symbol.asyncIterator]() {
              yield { name: "Game", className: "DataModel" };
            },
          }),
        },
      });
      const iterator = service.watchProjection("/repo/game.project.json")[Symbol.asyncIterator]();
      expect((await iterator.next()).value).toEqual({ type: "fallback", reason: "protocol-mismatch" });
      await iterator.return?.();
    },
  );

  it("freezes valid nested JSON ProjectionNode properties", async () => {
    const service = new RojoService({
      runner: new FakeProcessRunner(),
      command: "/usr/bin/rojo",
      allocatePort: async () => 1,
      probeHealth: async () => true,
      temporaryPath: async () => "/tmp/map.json",
      protocol: {
        events: () => ({
          async *[Symbol.asyncIterator]() {
            yield {
              type: "snapshot" as const,
              sessionId: "s",
              protocolVersion: 5,
              nodes: [
                { path: "game", name: "Game", className: "DataModel", properties: { nested: [true, { value: 1 }] } },
              ],
            };
          },
        }),
      },
      sourcemap: { watch: () => ({ async *[Symbol.asyncIterator]() {} }) },
    });
    const event = (await service.watchProjection("/repo/game.project.json")[Symbol.asyncIterator]().next()).value as {
      nodes: readonly { properties: { nested: readonly unknown[] } }[];
    };
    expect(Object.isFrozen(event.nodes[0]?.properties)).toBe(true);
    expect(Object.isFrozen(event.nodes[0]?.properties.nested)).toBe(true);
  });

  it("aborts and closes a blocked protocol iterator without emitting a late snapshot", async () => {
    let released = false;
    let resolveNext: ((result: IteratorResult<unknown>) => void) | undefined;
    const next = new Promise<IteratorResult<unknown>>((resolve) => {
      resolveNext = resolve;
    });
    const service = new RojoService({
      runner: new FakeProcessRunner(),
      command: "/usr/bin/rojo",
      allocatePort: async () => 1,
      probeHealth: async () => true,
      temporaryPath: async () => "/tmp/map.json",
      protocol: {
        events: (_path, _signal) => ({
          [Symbol.asyncIterator]() {
            return {
              next: async () => next,
              return: async () => {
                released = true;
                resolveNext?.({ done: true, value: undefined });
                return { done: true, value: undefined };
              },
            };
          },
        }),
      },
      sourcemap: { watch: () => ({ async *[Symbol.asyncIterator]() {} }) },
    });
    const iterator = service.watchProjection("/repo/game.project.json")[Symbol.asyncIterator]();
    const pending = iterator.next();
    await service.stop();
    resolveNext?.({ done: false, value: { type: "snapshot", sessionId: "late", protocolVersion: 5, nodes: [] } });
    expect(await pending).toEqual({ done: true, value: undefined });
    expect(released).toBe(true);
  });

  it("aborts and closes a blocked sourcemap iterator without yielding after stop", async () => {
    const handle = new FakeProcessHandle();
    let sawAbort = false;
    let returned = false;
    let release: (() => void) | undefined;
    const blocked = new Promise<IteratorResult<unknown>>((resolve) => {
      release = () => resolve({ done: true, value: undefined });
    });
    const service = new RojoService({
      runner: new FakeProcessRunner({ startedHandles: [handle] }),
      command: "/usr/bin/rojo",
      allocatePort: async () => 1,
      probeHealth: async () => true,
      temporaryPath: async () => "/tmp/map.json",
      sourcemap: {
        watch: (_path, _signal) => ({
          [Symbol.asyncIterator]() {
            return {
              next: async () => blocked,
              return: async () => {
                returned = true;
                release?.();
                return { done: true, value: undefined };
              },
            };
          },
        }),
      },
    });
    const iterator = service.watchProjection("/repo/game.project.json")[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual({ type: "fallback", reason: "protocol-unavailable" });
    const pending = iterator.next();
    await service.stop();
    sawAbort = handle.stopped;
    expect(await pending).toEqual({ done: true, value: undefined });
    expect(sawAbort).toBe(true);
    expect(returned).toBe(true);
  });

  it("emits a bounded failed event when the sourcemap child exits unexpectedly", async () => {
    const handle = new FakeProcessHandle({ exitResult: { exitCode: 1, stdout: "", stderr: "x".repeat(9_000) } });
    const service = new RojoService({
      runner: new FakeProcessRunner({ startedHandles: [handle] }),
      command: "/usr/bin/rojo",
      allocatePort: async () => 1,
      probeHealth: async () => true,
      temporaryPath: async () => "/tmp/map.json",
      sourcemap: {
        watch: () => ({
          async *[Symbol.asyncIterator]() {
            await new Promise(() => undefined);
          },
        }),
      },
    });
    const iterator = service.watchProjection("/repo/game.project.json")[Symbol.asyncIterator]();
    await iterator.next();
    const failure = await iterator.next();
    expect(failure.value).toMatchObject({ type: "failed" });
    expect((failure.value as { stderr: string }).stderr).toHaveLength(8_192);
  });

  it("rejects a temporary output whose symlinked parent resolves inside the project", async () => {
    const root = await mkdtemp(join(tmpdir(), "rbxforge-rojo-temp-"));
    const project = join(root, "project");
    const outside = join(root, "outside");
    await mkdir(project);
    await mkdir(outside);
    await symlink(project, join(outside, "link"));
    const service = new RojoService({
      runner: new FakeProcessRunner(),
      command: "/usr/bin/rojo",
      allocatePort: async () => 1,
      probeHealth: async () => true,
      temporaryPath: async () => join(outside, "link", "build.rbxlx"),
      sourcemap: { watch: () => ({ async *[Symbol.asyncIterator]() {} }) },
    });
    await expect(service.buildTemporary(join(project, "game.project.json"))).rejects.toThrow(
      "Temporary build output must be outside the project directory",
    );
    await rm(root, { recursive: true, force: true });
  });
});
