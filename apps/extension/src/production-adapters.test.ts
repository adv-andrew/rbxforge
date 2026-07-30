import { MutationJournal, type ProjectionNode } from "@rbxforge/core";
import type { StudioInstance } from "@rbxforge/studio-mcp";
import { describe, expect, test, vi } from "vitest";

import { createConnectionState } from "./connection-state.js";
import {
  createProductionAdapters,
  vendoredStudioMcpLaunch,
  type RojoRuntimePort,
  type StudioRuntimePort,
} from "./production-adapters.js";
import { createReconciledLiveGraph } from "./service-container.js";
import { createConnectionViewModel } from "./webviews/connection-provider.js";
import { PropertiesProvider, type PropertiesSelection } from "./webviews/properties-provider.js";

const sdkHarness = vi.hoisted(() => ({
  responses: [] as unknown[],
  calls: [] as Array<{ readonly name: string; readonly arguments: Record<string, unknown> }>,
}));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    async connect(): Promise<void> {}
    async listTools(): Promise<{ tools: readonly { name: string; inputSchema: unknown }[] }> {
      return {
        tools: ["get_connected_instances", "get_instance_children"].map((name) => ({
          name,
          inputSchema: { type: "object" },
        })),
      };
    }
    async callTool(input: { readonly name: string; readonly arguments: Record<string, unknown> }): Promise<unknown> {
      sdkHarness.calls.push(input);
      return sdkHarness.responses.shift();
    }
    async close(): Promise<void> {}
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: class {
    constructor(readonly options: unknown) {}
  },
}));

interface RojoRuntimeStatus {
  readonly processRunning: boolean;
  readonly apiHealthy: boolean;
  readonly port: number;
  readonly state?: "failed" | "stopped";
  readonly stderr?: string;
}
type SourcedProjection = ProjectionNode & { readonly filePaths?: readonly string[] };
type RojoProjectionUpdate =
  | { readonly type: "snapshot" | "update"; readonly sessionId: string; readonly nodes: readonly SourcedProjection[] }
  | { readonly type: "reset"; readonly sessionId: string }
  | { readonly type: "failed"; readonly stderr: string };

const studioInstance = (instanceId: string): StudioInstance =>
  Object.freeze({
    instanceId,
    role: "edit",
    placeId: 123,
    placeName: "Test Place",
    dataModelName: `Model ${instanceId}`,
    isRunning: false,
    pluginVersion: "1.0.0",
    pluginVariant: "test",
    serverVersion: "1.0.0",
    versionMismatch: false,
    lastActivity: 1,
    connectedAt: 1,
  });

class DeferredRojo implements RojoRuntimePort {
  readonly #events = new DeferredAsyncIterable<RojoProjectionUpdate>();
  readonly #statusListeners = new Set<(status: RojoRuntimeStatus) => void>();
  starts = 0;
  stops = 0;
  statusValue: RojoRuntimeStatus | undefined;
  stopBarrier: Promise<void> | undefined;
  stopError: Error | undefined;

  async start(_path: string): Promise<RojoRuntimeStatus> {
    this.starts += 1;
    this.statusValue = Object.freeze({ processRunning: true, apiHealthy: true, port: 34872 });
    return this.statusValue;
  }

  status(): RojoRuntimeStatus | undefined {
    return this.statusValue;
  }
  onStatus(listener: (status: RojoRuntimeStatus) => void): () => void {
    this.#statusListeners.add(listener);
    return () => this.#statusListeners.delete(listener);
  }
  watchProjection(_path: string): AsyncIterable<RojoProjectionUpdate> {
    return this.#events;
  }
  emit(event: RojoProjectionUpdate): void {
    this.#events.emit(event);
  }
  fail(error: Error): void {
    this.#events.fail(error);
  }
  publish(status: RojoRuntimeStatus): void {
    this.statusValue = status;
    for (const listener of this.#statusListeners) listener(status);
  }
  async stop(): Promise<void> {
    this.stops += 1;
    await this.stopBarrier;
    if (this.stopError !== undefined) throw this.stopError;
    this.statusValue = Object.freeze({
      processRunning: false,
      apiHealthy: false,
      port: 34872,
      state: "stopped",
    });
    for (const listener of this.#statusListeners) listener(this.statusValue);
    this.#events.end();
  }
}

class DeferredAsyncIterable<T> implements AsyncIterable<T> {
  readonly #values: T[] = [];
  readonly #waiters: {
    readonly resolve: (result: IteratorResult<T>) => void;
    readonly reject: (error: Error) => void;
  }[] = [];
  #done = false;

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async () => {
        const value = this.#values.shift();
        if (value !== undefined) return { done: false, value };
        if (this.#done) return { done: true, value: undefined };
        return new Promise<IteratorResult<T>>((resolve, reject) => this.#waiters.push({ resolve, reject }));
      },
      return: async () => {
        this.end();
        return { done: true, value: undefined };
      },
    };
  }

  emit(value: T): void {
    const waiter = this.#waiters.shift();
    if (waiter === undefined) this.#values.push(value);
    else waiter.resolve({ done: false, value });
  }

  fail(error: Error): void {
    const waiter = this.#waiters.shift();
    if (waiter === undefined) throw new Error("Deferred iterable has no active consumer");
    this.#done = true;
    waiter.reject(error);
  }

  end(): void {
    this.#done = true;
    for (const waiter of this.#waiters.splice(0)) waiter.resolve({ done: true, value: undefined });
  }
}

async function eventually(assertion: () => void): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      assertion();
      return;
    } catch {
      await Promise.resolve();
    }
  }
  assertion();
}

describe("production adapters", () => {
  test("binds Studio MCP to the installed extension with the current Node executable", () => {
    expect(vendoredStudioMcpLaunch("/installed/rbxforge")).toEqual({
      command: process.execPath,
      args: ["/installed/rbxforge/vendor/robloxstudio-mcp/index.mjs"],
      shell: false,
    });
  });

  test("the pinned extension Studio factory alone preserves sole-instance legacy selection", async () => {
    sdkHarness.calls.length = 0;
    sdkHarness.responses = [
      {
        content: [
          {
            type: "text",
            text: JSON.stringify({ instances: [studioInstance("legacy-only")], count: 1 }),
          },
        ],
      },
    ];
    const adapters = createProductionAdapters({
      connection: createConnectionState(),
      extensionRoot: "/installed/rbxforge",
    });

    await expect(adapters.instances()).resolves.toEqual([studioInstance("legacy-only")]);

    expect(adapters.snapshot()).toMatchObject({ activeInstanceId: "legacy-only", stale: false });
    expect(sdkHarness.calls).toEqual([{ name: "get_connected_instances", arguments: {} }]);
    await adapters.dispose();
  });

  test.each([
    [
      { soloPlaytest: "solo_playtest", runtimeLogs: "get_runtime_logs" },
      { lifecycle: true, logs: true, screenshot: false },
      "Studio MCP capability unavailable: capture_screenshot",
    ],
    [
      { runtimeLogs: "get_runtime_logs", screenshot: "capture_screenshot" },
      { lifecycle: false, logs: true, screenshot: true },
      "Studio MCP capability unavailable: solo_playtest",
    ],
    [
      { soloPlaytest: "solo_playtest", screenshot: "capture_screenshot" },
      { lifecycle: true, logs: false, screenshot: true },
      "Studio MCP capability unavailable: get_runtime_logs",
    ],
    [
      { screenshot: "capture_screenshot" },
      { lifecycle: false, logs: false, screenshot: true },
      "Studio MCP capabilities unavailable: solo_playtest, get_runtime_logs",
    ],
    [
      { runtimeLogs: "get_runtime_logs" },
      { lifecycle: false, logs: true, screenshot: false },
      "Studio MCP capabilities unavailable: solo_playtest, capture_screenshot",
    ],
    [
      { soloPlaytest: "solo_playtest" },
      { lifecycle: true, logs: false, screenshot: false },
      "Studio MCP capabilities unavailable: get_runtime_logs, capture_screenshot",
    ],
    [
      {},
      { lifecycle: false, logs: false, screenshot: false },
      "Studio MCP capabilities unavailable: solo_playtest, get_runtime_logs, capture_screenshot",
    ],
  ] as const)("reports exact missing canonical playtest capabilities %#", async (capabilities, expected, reason) => {
    const connection = createConnectionState();
    const adapters = createProductionAdapters({
      connection,
      createStudio: async () => ({
        ...unavailableStudio(),
        snapshot: () => ({ activeInstanceId: undefined, capabilities }),
      }),
    });
    await adapters.instances();

    expect(adapters.playtestAvailability()).toEqual({ ...expected, reason });
    await adapters.dispose();
  });

  test("construction is lazy and concurrent disposal is idempotent without starting a process", async () => {
    const connection = createConnectionState();
    let studioCreations = 0;
    let rojoCreations = 0;
    const adapters = createProductionAdapters({
      connection,
      createStudio: async () => {
        studioCreations += 1;
        throw new Error("must stay lazy");
      },
      createRojo: async () => {
        rojoCreations += 1;
        throw new Error("must stay lazy");
      },
    });

    expect(await adapters.sources.files.children("game", new AbortController().signal)).toEqual([]);
    expect(adapters.pathFor("game.Workspace.Mapped")).toBeUndefined();
    await Promise.all([adapters.dispose(), adapters.dispose()]);

    expect(studioCreations).toBe(0);
    expect(rojoCreations).toBe(0);
  });

  test("Studio factory is lazy and singular while list, select, and graph children map exact projections", async () => {
    const connection = createConnectionState();
    let creations = 0;
    let discoveries = 0;
    let selected: string | undefined;
    const childPaths: string[] = [];
    const closes: number[] = [];
    const expectedProjection: ProjectionNode = Object.freeze({
      path: "game.Workspace.Live",
      name: "Live",
      className: "Part",
    });
    const studio: StudioRuntimePort = {
      discover: async () => {
        discoveries += 1;
        return new Set(["connected", "children"]);
      },
      listConnectedInstances: async () => [studioInstance("a"), studioInstance("b")],
      snapshot: () => ({ activeInstanceId: selected }),
      selectInstance: (id) => {
        selected = id;
      },
      children: async (path) => {
        childPaths.push(path);
        return [expectedProjection];
      },
      properties: async (path) => ({ instancePath: path, className: "Part", properties: {} }),
      close: async () => {
        closes.push(1);
      },
    };
    const adapters = createProductionAdapters({
      connection,
      createStudio: async () => {
        creations += 1;
        return studio;
      },
    });
    const graph = createReconciledLiveGraph(adapters.sources);

    expect(creations).toBe(0);
    await expect(adapters.instances()).resolves.toHaveLength(2);
    await adapters.selectInstance("b");
    const nodes = await graph.children("game.Workspace", new AbortController().signal);

    expect(creations).toBe(1);
    expect(discoveries).toBe(1);
    expect(selected).toBe("b");
    expect(childPaths).toEqual(["game.Workspace"]);
    expect(connection.snapshot().checks).toMatchObject({
      mcpProcess: { health: "healthy" },
      studioPlugin: { health: "healthy" },
      studioPlace: { health: "healthy" },
      activeStudioInstance: { health: "healthy" },
      placeRestriction: { health: "healthy" },
    });
    expect(nodes).toEqual([
      {
        path: "game.Workspace.Live",
        name: "Live",
        className: "Part",
        ownership: "studio",
        studio: expectedProjection,
        children: [],
        unsafeUnknownChildren: false,
        unsafeParent: false,
      },
    ]);
    await Promise.all([adapters.dispose(), adapters.dispose()]);
    expect(closes).toEqual([1]);
    expect(connection.snapshot().checks.mcpProcess.health).toBe("unhealthy");
    expect(connection.snapshot().checks.placeRestriction.health).toBe("unhealthy");
  });

  test("does not bypass explicit selection for a custom Studio runtime with one instance", async () => {
    const connection = createConnectionState();
    let selected: string | undefined;
    let childrenCalls = 0;
    const adapters = createProductionAdapters({
      connection,
      createStudio: async () => ({
        discover: async () => new Set(["connectedInstances", "children"]),
        listConnectedInstances: async () => [studioInstance("only")],
        snapshot: () => ({ activeInstanceId: selected }),
        selectInstance: (id) => {
          selected = id;
        },
        children: async () => {
          childrenCalls += 1;
          return [];
        },
        properties: async (path) => ({ instancePath: path, className: "DataModel", properties: {} }),
        close: async () => undefined,
      }),
    });

    await expect(adapters.sources.studio.children("game.Workspace", new AbortController().signal)).resolves.toEqual([]);

    expect(selected).toBeUndefined();
    expect(childrenCalls).toBe(0);
    expect(connection.snapshot().checks.activeStudioInstance).toMatchObject({
      health: "unhealthy",
      detail: "Select a Studio instance",
    });
    await adapters.dispose();
  });

  test("a displayed production snapshot can mutate after benign reads, while a real disconnect invalidates it", async () => {
    const connection = createConnectionState();
    let connected: readonly StudioInstance[] = [studioInstance("place:123")];
    let propertyRead = 0;
    let writes = 0;
    const projection: ProjectionNode = {
      path: "game.Workspace.Part",
      name: "Part",
      className: "Part",
    };
    const studio: StudioRuntimePort = {
      discover: async () => new Set(["connectedInstances", "children"]),
      listConnectedInstances: async () => connected,
      snapshot: () => ({ activeInstanceId: "place:123", stale: false }),
      selectInstance: () => undefined,
      children: async () => [projection],
      properties: async (path) => {
        propertyRead += 1;
        return {
          instancePath: path,
          className: "Part",
          properties: { Anchored: propertyRead < 3 ? "false" : "true" },
        };
      },
      callWrite: async () => {
        writes += 1;
        return { success: true };
      },
      close: async () => undefined,
    };
    const adapters = createProductionAdapters({
      connection,
      createStudio: async () => studio,
    });
    const graph = createReconciledLiveGraph(adapters.sources);
    await adapters.instances();
    const resolved = await graph.resolve("game.Workspace.Part", new AbortController().signal);
    const selection = (): PropertiesSelection => ({
      instanceId: "place:123",
      instancePath: "game.Workspace.Part",
      name: "Part",
      placeName: "Test Place",
      ownership: resolved.node.ownership,
      freshness: "fresh",
      generation: 1,
      graphRevision: resolved.revision,
      simulation: false,
    });
    const provider = new PropertiesProvider({
      studio: {
        snapshot: adapters.snapshot,
        properties: adapters.guardedProperties,
        callWrite: adapters.callWrite,
      },
      journal: new MutationJournal(),
      sessionId: "production-composition",
      resolveSelection: async () => {
        await adapters.instances();
        graph.assertRevision(resolved.revision);
        return selection();
      },
      publish: async () => undefined,
      now: () => 1,
      createId: () => "production-journal",
    });
    const displayed = await provider.refresh(selection());

    await expect(
      provider.propose(
        {
          instanceId: "place:123",
          instancePath: "game.Workspace.Part",
          propertyName: "Anchored",
          snapshotId: displayed.snapshotId,
          value: true,
          displayGeneration: 1,
        },
        "operation-1",
      ),
    ).resolves.toEqual({ verification: "verified" });
    expect(writes).toBe(1);
    expect(() => graph.assertRevision(resolved.revision)).not.toThrow();

    connected = [];
    await adapters.instances();
    expect(() => graph.assertRevision(resolved.revision)).toThrow("graph changed");
    graph.dispose?.();
    await adapters.dispose();
  });

  test("Studio unavailability is fail-soft, singular, and clears every dependent green state", async () => {
    const connection = createConnectionState();
    let creations = 0;
    const adapters = createProductionAdapters({
      connection,
      createStudio: async () => {
        creations += 1;
        return {
          ...unavailableStudio(),
          discover: async () => {
            throw new Error("MCP discovery failed");
          },
        };
      },
    });

    await expect(adapters.sources.studio.children("game", new AbortController().signal)).resolves.toEqual([]);
    await expect(adapters.sources.studio.children("game", new AbortController().signal)).resolves.toEqual([]);

    expect(creations).toBe(1);
    expect(connection.snapshot().checks).toMatchObject({
      mcpProcess: { health: "unhealthy", detail: "Studio MCP unavailable" },
      studioPlugin: { health: "unhealthy" },
      studioPlace: { health: "unhealthy" },
      activeStudioInstance: { health: "unhealthy" },
      placeRestriction: { health: "unhealthy" },
    });
    await adapters.dispose();
  });

  test("Studio disappearance clears formerly green plugin, place, and active selection state", async () => {
    const connection = createConnectionState();
    let instances: readonly StudioInstance[] = [studioInstance("only")];
    let selected: string | undefined = "only";
    const adapters = createProductionAdapters({
      connection,
      createStudio: async () => ({
        discover: async () => new Set(["connected"]),
        listConnectedInstances: async () => instances,
        snapshot: () => ({ activeInstanceId: selected }),
        selectInstance: (id) => {
          selected = id;
        },
        children: async () => [],
        properties: async (path) => ({ instancePath: path, className: "DataModel", properties: {} }),
        close: async () => undefined,
      }),
    });

    await adapters.instances();
    expect(connection.snapshot().checks.activeStudioInstance.health).toBe("healthy");
    instances = [];
    await adapters.instances();

    expect(connection.snapshot().checks).toMatchObject({
      studioPlugin: { health: "unhealthy" },
      studioPlace: { health: "unhealthy" },
      activeStudioInstance: { health: "unhealthy" },
      placeRestriction: { health: "unhealthy" },
    });
    await adapters.dispose();
  });

  test("Rojo is created only by explicit start and projection updates replace mappings and invalidate the graph", async () => {
    const connection = createConnectionState();
    const fake = new DeferredRojo();
    let creations = 0;
    const invalidated: string[] = [];
    const adapters = createProductionAdapters({
      connection,
      createRojo: async () => {
        creations += 1;
        return fake;
      },
      createStudio: async () => unavailableStudio(),
    });
    adapters.sources.rojo.onInvalidated(({ path }) => invalidated.push(path));

    expect(creations).toBe(0);
    expect(await adapters.sources.rojo.children("game", new AbortController().signal)).toEqual([]);
    await adapters.startRojo("/repo/default.project.json");
    expect(creations).toBe(1);
    expect(fake.starts).toBe(1);

    const first = Object.freeze({
      path: "game.Workspace.First",
      name: "First",
      className: "Script",
      filePaths: Object.freeze(["/repo/src/First.server.lua"]),
    });
    fake.emit({ type: "snapshot", sessionId: "one", nodes: [first] });
    await eventually(() => expect(adapters.pathFor(first.path)).toBe("/repo/src/First.server.lua"));
    expect(await adapters.sources.rojo.children("game", new AbortController().signal)).toEqual([first]);
    expect(await adapters.sources.files.children("game", new AbortController().signal)).toEqual([
      { path: first.path, filePaths: first.filePaths },
    ]);

    const second = Object.freeze({
      path: "game.Workspace.Second",
      name: "Second",
      className: "ModuleScript",
      filePaths: Object.freeze(["/repo/src/Second.lua"]),
    });
    fake.emit({ type: "update", sessionId: "one", nodes: [second] });
    await eventually(() => expect(adapters.pathFor(second.path)).toBe("/repo/src/Second.lua"));
    expect(adapters.pathFor(first.path)).toBeUndefined();

    fake.emit({ type: "reset", sessionId: "two" });
    await eventually(() => expect(adapters.pathFor(second.path)).toBeUndefined());
    expect(await adapters.sources.rojo.children("game", new AbortController().signal)).toEqual([]);
    expect(invalidated).toEqual(["game", "game", "game"]);

    fake.emit({ type: "failed", stderr: "sourcemap exited" });
    await eventually(() => expect(connection.snapshot().checks.rojoApi.detail).toBe("Rojo projection failed"));
    expect(connection.snapshot().checks.rojoApi.health).toBe("unhealthy");

    fake.fail(new Error("watch exploded"));
    await eventually(() =>
      expect(connection.snapshot().checks.rojoProcess.detail).toBe("Rojo projection watcher failed"),
    );
    expect(connection.snapshot().checks.rojoProcess.health).toBe("unhealthy");
    await adapters.dispose();
    expect(fake.stops).toBe(1);
  });

  test("live Rojo status cannot leave process or API green after crash, stop, and double disposal", async () => {
    const connection = createConnectionState();
    const fake = new DeferredRojo();
    const adapters = createProductionAdapters({
      connection,
      createRojo: async () => fake,
      createStudio: async () => unavailableStudio(),
    });
    await adapters.startRojo("/repo/default.project.json");
    expect(connection.snapshot().checks.rojoProcess.health).toBe("healthy");
    expect(connection.snapshot().checks.rojoApi.health).toBe("healthy");

    const adversarialStderr = "serve crashed authorization=Bearer raw-secret-token xoxb-123456789";
    fake.publish({
      processRunning: false,
      apiHealthy: false,
      port: 34872,
      state: "failed",
      stderr: adversarialStderr,
    });
    expect(connection.snapshot().checks.rojoProcess).toMatchObject({
      health: "unhealthy",
      detail: "Rojo process failed",
    });
    expect(connection.snapshot().checks.rojoApi.health).toBe("unhealthy");
    expect(JSON.stringify(connection.snapshot())).not.toContain(adversarialStderr);
    expect(JSON.stringify(createConnectionViewModel(connection.snapshot()))).not.toMatch(/raw-secret-token|xoxb-/);

    await adapters.stopRojo();
    expect(fake.stops).toBe(1);
    expect(connection.snapshot().checks.rojoProcess.health).toBe("unhealthy");
    expect(connection.snapshot().checks.rojoApi.health).toBe("unhealthy");
    await Promise.all([adapters.dispose(), adapters.dispose()]);
    expect(fake.stops).toBe(1);
  });

  test("dispose waits for active Rojo teardown and suppresses late projection events", async () => {
    const connection = createConnectionState();
    const fake = new DeferredRojo();
    let releaseStop = (): void => undefined;
    fake.stopBarrier = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    const adapters = createProductionAdapters({
      connection,
      createRojo: async () => fake,
      createStudio: async () => unavailableStudio(),
    });
    await adapters.startRojo("/repo/default.project.json");
    fake.emit({
      type: "snapshot",
      sessionId: "one",
      nodes: [
        {
          path: "game.Workspace.Before",
          name: "Before",
          className: "Script",
          filePaths: ["/repo/src/Before.lua"],
        },
      ],
    });
    await eventually(() => expect(adapters.pathFor("game.Workspace.Before")).toBe("/repo/src/Before.lua"));

    let settled = false;
    const disposing = adapters.dispose().then(() => {
      settled = true;
    });
    fake.emit({
      type: "update",
      sessionId: "one",
      nodes: [
        {
          path: "game.Workspace.Late",
          name: "Late",
          className: "Script",
          filePaths: ["/repo/src/Late.lua"],
        },
      ],
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(adapters.pathFor("game.Workspace.Late")).toBeUndefined();

    releaseStop();
    await disposing;
    expect(settled).toBe(true);
    expect(fake.stops).toBe(1);
    expect(adapters.pathFor("game.Workspace.Before")).toBeUndefined();
  });

  test("dispose contains and reports Rojo stop and Studio close failures exactly once", async () => {
    const connection = createConnectionState();
    const fake = new DeferredRojo();
    fake.stopError = new Error("stop exploded");
    let closes = 0;
    const adapters = createProductionAdapters({
      connection,
      createRojo: async () => fake,
      createStudio: async () => ({
        ...unavailableStudio(),
        close: async () => {
          closes += 1;
          throw new Error("close exploded");
        },
      }),
    });
    await adapters.startRojo("/repo/default.project.json");
    await adapters.instances();

    await expect(Promise.all([adapters.dispose(), adapters.dispose()])).resolves.toEqual([undefined, undefined]);
    expect(fake.stops).toBe(1);
    expect(closes).toBe(1);
    expect(connection.snapshot().checks.rojoProcess).toMatchObject({
      health: "unhealthy",
      detail: "Rojo stop failed",
    });
    expect(connection.snapshot().checks.mcpProcess).toMatchObject({
      health: "unhealthy",
      detail: "Studio MCP unavailable",
    });
  });

  test("dispose suppresses an in-flight Rojo factory before it can start a process", async () => {
    const connection = createConnectionState();
    const fake = new DeferredRojo();
    let releaseFactory = (): void => undefined;
    const factoryBarrier = new Promise<void>((resolve) => {
      releaseFactory = resolve;
    });
    const adapters = createProductionAdapters({
      connection,
      createRojo: async () => {
        await factoryBarrier;
        return fake;
      },
      createStudio: async () => unavailableStudio(),
    });

    const starting = adapters.startRojo("/repo/default.project.json");
    let disposed = false;
    const disposing = adapters.dispose().then(() => {
      disposed = true;
    });
    await Promise.resolve();
    expect(disposed).toBe(false);

    releaseFactory();
    await disposing;
    await expect(starting).rejects.toThrow("disposed");
    expect(fake.starts).toBe(0);
    expect(fake.stops).toBe(1);
  });
});

function unavailableStudio(): StudioRuntimePort {
  return {
    discover: async () => new Set<string>(),
    listConnectedInstances: async () => [],
    snapshot: () => ({ activeInstanceId: undefined }),
    selectInstance: () => undefined,
    children: async () => [],
    properties: async (path) => ({ instancePath: path, className: "DataModel", properties: {} }),
    close: async () => undefined,
  };
}
