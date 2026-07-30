import type { RojoStatus } from "@rbxforge/rojo";
import { describe, expect, it } from "vitest";
import type { ProjectRef } from "../../shared/domain.js";
import {
  ProjectRuntimeRegistry,
  type ProjectRojoService,
  type ProjectRojoServiceFactoryOptions,
  type ResolvedRojoExecutable,
} from "./project-runtime-registry.js";

const executable: ResolvedRojoExecutable = Object.freeze({
  path: "/tools/rojo",
  version: "7.8.0",
  source: "path",
});

function projectRef(projectId: string, revision = 1): ProjectRef {
  return Object.freeze({
    projectId,
    canonicalRoot: `/projects/${projectId}`,
    rootDevice: `root-device-${projectId}`,
    rootInode: `root-inode-${projectId}`,
    canonicalProjectFile: `/projects/${projectId}/default.project.json`,
    projectFileDevice: `file-device-${projectId}`,
    projectFileInode: `file-inode-${projectId}`,
    configDigest: `digest-${projectId}`,
    revision,
  });
}

function sequence<T>(...values: readonly T[]): () => T {
  let index = 0;
  return () => {
    const value = values[index];
    if (value === undefined) throw new Error("sequence exhausted");
    index += 1;
    return value;
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class FakeRojoService implements ProjectRojoService {
  readonly startCalls: string[] = [];
  stopCalls = 0;
  readonly #listeners = new Set<(status: RojoStatus) => void>();

  constructor(
    readonly port: number,
    private readonly startResult: Promise<RojoStatus> = Promise.resolve({
      processRunning: true,
      apiHealthy: true,
      port,
    }),
    private readonly stopBehavior: () => Promise<void> = () => Promise.resolve(),
    private readonly healthBehavior: () => Promise<RojoStatus> = () =>
      Promise.resolve({ processRunning: true, apiHealthy: true, port }),
  ) {}

  async start(projectPath: string): Promise<RojoStatus> {
    this.startCalls.push(projectPath);
    const status = await this.startResult;
    this.emit(status);
    return status;
  }

  onStatus(listener: (status: RojoStatus) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  checkHealth(): Promise<RojoStatus> {
    return this.healthBehavior();
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
    await this.stopBehavior();
    this.emit({ processRunning: false, apiHealthy: false, port: this.port, state: "stopped" });
  }

  emit(status: RojoStatus): void {
    for (const listener of this.#listeners) listener(status);
  }
}

function serviceFactory(services: readonly FakeRojoService[]) {
  const options: ProjectRojoServiceFactoryOptions[] = [];
  let index = 0;
  return {
    options,
    factory(factoryOptions: ProjectRojoServiceFactoryOptions): ProjectRojoService {
      options.push(factoryOptions);
      const service = services[index];
      if (service === undefined) throw new Error("service factory exhausted");
      index += 1;
      return service;
    },
  };
}

describe("ProjectRuntimeRegistry", () => {
  it("issues unique ports and monotonically increasing generations per project", async () => {
    const services = [new FakeRojoService(34872), new FakeRojoService(34873), new FakeRojoService(34874)];
    const factory = serviceFactory(services);
    const registry = new ProjectRuntimeRegistry({
      createService: factory.factory,
      createId: sequence("lease-a", "lease-b", "lease-c"),
      now: sequence(100, 200, 300),
      assertProjectCurrent: () => undefined,
    });

    const a1 = await registry.connect(projectRef("a"), executable);
    const b1 = await registry.connect(projectRef("b"), executable);
    await registry.disconnect("a");
    const a2 = await registry.connect(projectRef("a"), executable);

    expect([a1.port, b1.port, a2.port]).toEqual([34872, 34873, 34874]);
    expect([a1.generation, b1.generation, a2.generation]).toEqual([1, 1, 2]);
    expect(new Set([a1.leaseId, b1.leaseId, a2.leaseId]).size).toBe(3);
    expect(factory.options).toEqual([
      { command: "/tools/rojo" },
      { command: "/tools/rojo" },
      { command: "/tools/rojo" },
    ]);
  });

  it("deduplicates concurrent connects for the same current project", async () => {
    const start = deferred<RojoStatus>();
    const service = new FakeRojoService(34872, start.promise);
    const factory = serviceFactory([service]);
    const registry = new ProjectRuntimeRegistry({
      createService: factory.factory,
      createId: () => "lease-a",
      now: () => 100,
      assertProjectCurrent: () => undefined,
    });
    const project = projectRef("a");

    const first = registry.connect(project, executable);
    const second = registry.connect(project, executable);
    expect(registry.snapshot("a")).toEqual({
      projectId: "a",
      state: "starting",
      executablePath: "/tools/rojo",
      version: "7.8.0",
    });
    start.resolve({ processRunning: true, apiHealthy: true, port: 34872 });

    const [firstLease, secondLease] = await Promise.all([first, second]);
    expect(secondLease).toBe(firstLease);
    expect(factory.options).toHaveLength(1);
    expect(service.startCalls).toEqual(["/projects/a/default.project.json"]);
  });

  it("revalidates project identity before start and after readiness and stops on drift", async () => {
    const service = new FakeRojoService(34872);
    const factory = serviceFactory([service]);
    let validations = 0;
    const registry = new ProjectRuntimeRegistry({
      createService: factory.factory,
      createId: () => "lease-a",
      now: () => 100,
      assertProjectCurrent: () => {
        validations += 1;
        if (validations === 2) throw new Error("project drifted");
      },
    });

    await expect(registry.connect(projectRef("a"), executable)).rejects.toThrow("project drifted");
    expect(validations).toBe(2);
    expect(service.stopCalls).toBe(1);
    expect(registry.snapshot("a")).toMatchObject({ projectId: "a", state: "failed", diagnostic: "project drifted" });
  });

  it("rejects failed pre-start identity validation without creating a service", async () => {
    const factory = serviceFactory([]);
    const registry = new ProjectRuntimeRegistry({
      createService: factory.factory,
      assertProjectCurrent: () => {
        throw new Error("project is stale");
      },
    });

    await expect(registry.connect(projectRef("a"), executable)).rejects.toThrow("project is stale");
    expect(factory.options).toHaveLength(0);
    expect(registry.snapshot("a")).toBeUndefined();
  });

  it("rejects a non-absolute executable before creating a service", async () => {
    const factory = serviceFactory([]);
    const registry = new ProjectRuntimeRegistry({
      createService: factory.factory,
      assertProjectCurrent: () => undefined,
    });

    await expect(registry.connect(projectRef("a"), { ...executable, path: "relative/rojo" })).rejects.toThrow(
      /absolute Rojo executable/i,
    );
    expect(factory.options).toHaveLength(0);
  });

  it("rejects a cross-project port collision and stops only the colliding service", async () => {
    const first = new FakeRojoService(34872);
    const colliding = new FakeRojoService(34872);
    const factory = serviceFactory([first, colliding]);
    const registry = new ProjectRuntimeRegistry({
      createService: factory.factory,
      createId: sequence("lease-a", "lease-b"),
      now: sequence(100, 200),
      assertProjectCurrent: () => undefined,
    });

    await registry.connect(projectRef("a"), executable);
    await expect(registry.connect(projectRef("b"), executable)).rejects.toThrow(/port.*already held/i);
    expect(first.stopCalls).toBe(0);
    expect(colliding.stopCalls).toBe(1);
    expect(registry.snapshot("a")?.state).toBe("ready");
    expect(registry.snapshot("b")?.state).toBe("failed");
  });

  it("invalidates and removes a lease when its retained Rojo service exits unexpectedly", async () => {
    const service = new FakeRojoService(34872);
    const factory = serviceFactory([service]);
    const invalidations: unknown[] = [];
    const registry = new ProjectRuntimeRegistry({
      createService: factory.factory,
      createId: () => "lease-a",
      now: () => 100,
      assertProjectCurrent: () => undefined,
      onInvalidated: (event) => invalidations.push(event),
    });
    const project = projectRef("a");
    const lease = await registry.connect(project, executable);

    service.emit({ processRunning: false, apiHealthy: false, port: 34872, state: "failed", stderr: "crashed" });

    expect(invalidations).toEqual([{ projectId: "a", reason: "rojo-exit" }]);
    expect(registry.snapshot("a")).toMatchObject({ projectId: "a", state: "failed", diagnostic: "crashed" });
    expect(() => registry.assertCurrent(project, lease)).toThrow(/lease is not current/i);
  });

  it("fails closed when a retained process no longer passes a live API health probe", async () => {
    const service = new FakeRojoService(34872, undefined, undefined, async () => ({
      processRunning: true,
      apiHealthy: false,
      port: 34872,
      state: "failed",
    }));
    const invalidations: unknown[] = [];
    const registry = new ProjectRuntimeRegistry({
      createService: serviceFactory([service]).factory,
      createId: () => "lease-a",
      now: () => 100,
      assertProjectCurrent: () => undefined,
      onInvalidated: (event) => invalidations.push(event),
    });
    await registry.connect(projectRef("a"), executable);

    await expect(registry.refresh("a")).rejects.toThrow(/health/i);

    expect(service.stopCalls).toBe(1);
    expect(registry.snapshot("a")).toMatchObject({ state: "failed" });
    expect(invalidations).toEqual([{ projectId: "a", reason: "rojo-exit" }]);
  });

  it("bounds a live health probe timeout and invalidates without trusting cached PID or port state", async () => {
    const service = new FakeRojoService(34872, undefined, undefined, () => new Promise<RojoStatus>(() => undefined));
    const registry = new ProjectRuntimeRegistry({
      createService: serviceFactory([service]).factory,
      createId: () => "lease-a",
      now: () => 100,
      healthTimeoutMs: 5,
      assertProjectCurrent: () => undefined,
    });
    await registry.connect(projectRef("a"), executable);

    await expect(registry.refresh("a")).rejects.toThrow(/timed out/i);

    expect(service.stopCalls).toBe(1);
    expect(registry.snapshot("a")).toMatchObject({ state: "failed" });
  });

  it("compares every lease field and the retained project identity in assertCurrent", async () => {
    let validations = 0;
    const service = new FakeRojoService(34872);
    const factory = serviceFactory([service]);
    const registry = new ProjectRuntimeRegistry({
      createService: factory.factory,
      createId: () => "lease-a",
      now: () => 100,
      assertProjectCurrent: () => {
        validations += 1;
      },
    });
    const project = projectRef("a");
    const lease = await registry.connect(project, executable);
    expect(() => registry.assertCurrent(project, lease)).not.toThrow();
    expect(validations).toBe(3);

    for (const [field, value] of [
      ["leaseId", "other"],
      ["projectId", "b"],
      ["projectRevision", 2],
      ["generation", 2],
      ["port", 34873],
      ["startedAt", 101],
    ] as const) {
      expect(() => registry.assertCurrent(project, { ...lease, [field]: value })).toThrow(/lease is not current/i);
    }
    expect(() => registry.assertCurrent({ ...project, configDigest: "forged" }, lease)).toThrow(
      /project is not current/i,
    );
  });

  it("disconnects only the matching retained service", async () => {
    const serviceA = new FakeRojoService(34872);
    const serviceB = new FakeRojoService(34873);
    const factory = serviceFactory([serviceA, serviceB]);
    const registry = new ProjectRuntimeRegistry({
      createService: factory.factory,
      createId: sequence("lease-a", "lease-b"),
      now: sequence(100, 200),
      assertProjectCurrent: () => undefined,
    });
    await registry.connect(projectRef("a"), executable);
    await registry.connect(projectRef("b"), executable);

    await registry.disconnect("a");

    expect(serviceA.stopCalls).toBe(1);
    expect(serviceB.stopCalls).toBe(0);
    expect(registry.snapshot("a")).toBeUndefined();
    expect(registry.snapshot("b")?.state).toBe("ready");
  });

  it("does not let an old deferred disconnect erase a replacement runtime snapshot", async () => {
    const oldStop = deferred<undefined>();
    const oldService = new FakeRojoService(34872, undefined, () => oldStop.promise);
    const replacementService = new FakeRojoService(34873);
    const factory = serviceFactory([oldService, replacementService]);
    const registry = new ProjectRuntimeRegistry({
      createService: factory.factory,
      createId: sequence("lease-old", "lease-new"),
      now: sequence(100, 200),
      assertProjectCurrent: () => undefined,
    });
    await registry.connect(projectRef("a"), executable);

    const disconnectingOldRuntime = registry.disconnect("a");
    const replacementLease = await registry.connect(projectRef("a"), executable);
    expect(registry.snapshot("a")).toMatchObject({ state: "ready", lease: replacementLease });

    oldStop.resolve(undefined);
    await disconnectingOldRuntime;

    expect(registry.snapshot("a")).toMatchObject({ state: "ready", lease: replacementLease });
    expect(oldService.stopCalls).toBe(1);
    expect(replacementService.stopCalls).toBe(0);
    expect(() => registry.assertCurrent(projectRef("a"), replacementLease)).not.toThrow();
  });

  it("clears disconnected runtime state even when its exact service stop rejects", async () => {
    const service = new FakeRojoService(34872, undefined, () => Promise.reject(new Error("stop-a failed")));
    const factory = serviceFactory([service]);
    const registry = new ProjectRuntimeRegistry({
      createService: factory.factory,
      createId: () => "lease-a",
      now: () => 100,
      assertProjectCurrent: () => undefined,
    });
    await registry.connect(projectRef("a"), executable);

    await expect(registry.disconnect("a")).rejects.toThrow("stop-a failed");

    expect(registry.snapshot("a")).toBeUndefined();
    expect(service.stopCalls).toBe(1);
  });

  it("disposes every retained service exactly once and rejects later connections", async () => {
    const serviceA = new FakeRojoService(34872);
    const serviceB = new FakeRojoService(34873);
    const factory = serviceFactory([serviceA, serviceB]);
    const registry = new ProjectRuntimeRegistry({
      createService: factory.factory,
      createId: sequence("lease-a", "lease-b"),
      now: sequence(100, 200),
      assertProjectCurrent: () => undefined,
    });
    await registry.connect(projectRef("a"), executable);
    await registry.connect(projectRef("b"), executable);

    await Promise.all([registry.dispose(), registry.dispose()]);

    expect(serviceA.stopCalls).toBe(1);
    expect(serviceB.stopCalls).toBe(1);
    await expect(registry.connect(projectRef("c"), executable)).rejects.toThrow(/disposed/i);
  });

  it("attempts pending and retained cleanup before surfacing a stop failure", async () => {
    const pendingStart = deferred<RojoStatus>();
    const retained = new FakeRojoService(34872);
    const pending = new FakeRojoService(34873, pendingStart.promise, async () => {
      pendingStart.reject(new Error("pending start cancelled"));
      throw new Error("pending stop failed");
    });
    const factory = serviceFactory([retained, pending]);
    const registry = new ProjectRuntimeRegistry({
      createService: factory.factory,
      createId: () => "lease-a",
      now: () => 100,
      assertProjectCurrent: () => undefined,
    });
    await registry.connect(projectRef("a"), executable);
    const pendingConnection = registry.connect(projectRef("b"), executable);

    await expect(registry.dispose()).rejects.toThrow("pending stop failed");
    await expect(pendingConnection).rejects.toThrow();

    expect(retained.stopCalls).toBe(1);
    expect(pending.stopCalls).toBe(1);
    expect(registry.snapshot("a")).toBeUndefined();
    expect(registry.snapshot("b")).toBeUndefined();
  });

  it("aggregates multiple cleanup failures in deterministic service order", async () => {
    const serviceA = new FakeRojoService(34872, undefined, () => Promise.reject(new Error("stop-a failed")));
    const serviceB = new FakeRojoService(34873, undefined, () => Promise.reject(new Error("stop-b failed")));
    const factory = serviceFactory([serviceA, serviceB]);
    const registry = new ProjectRuntimeRegistry({
      createService: factory.factory,
      createId: sequence("lease-a", "lease-b"),
      now: sequence(100, 200),
      assertProjectCurrent: () => undefined,
    });
    await registry.connect(projectRef("a"), executable);
    await registry.connect(projectRef("b"), executable);

    const failure = await registry.dispose().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors.map((error: Error) => error.message)).toEqual([
      "stop-a failed",
      "stop-b failed",
    ]);
    expect(serviceA.stopCalls).toBe(1);
    expect(serviceB.stopCalls).toBe(1);
    expect(registry.snapshot("a")).toBeUndefined();
    expect(registry.snapshot("b")).toBeUndefined();
  });

  it("settles a repeated dispose after a surfaced cleanup failure without stopping again", async () => {
    const service = new FakeRojoService(34872, undefined, () => Promise.reject(new Error("stop-a failed")));
    const factory = serviceFactory([service]);
    const registry = new ProjectRuntimeRegistry({
      createService: factory.factory,
      createId: () => "lease-a",
      now: () => 100,
      assertProjectCurrent: () => undefined,
    });
    await registry.connect(projectRef("a"), executable);

    await expect(registry.dispose()).rejects.toThrow("stop-a failed");
    await expect(registry.dispose()).resolves.toBeUndefined();

    expect(service.stopCalls).toBe(1);
    expect(registry.snapshot("a")).toBeUndefined();
  });
});
