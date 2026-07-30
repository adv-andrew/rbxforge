import {
  HostContextRegistry,
  InMemoryApprovalBroker,
  RevisionedIgnorePolicy,
  type IgnorePolicyPort,
} from "@rbxforge/agent";
import {
  ActivityEventStore,
  MutationJournal,
  PlaytestController,
  parentDataModelPath,
  reconcileInstanceGraph,
  type FileProjectionNode,
  type PlaytestCapabilityPort,
  type ProjectionNode,
  type UnifiedInstanceNode,
} from "@rbxforge/core";
import type { RojoService } from "@rbxforge/rojo";
import type {
  StudioInstance,
  StudioMcpService,
  StudioMutationGate,
  StudioProperties,
  StudioPropertyReadOptions,
  StudioWriteOwnershipContext,
} from "@rbxforge/studio-mcp";

import { createConnectionState, type ConnectionStateSnapshot, type ConnectionStateStore } from "./connection-state.js";
import {
  createBrokerBackedStudioWrites,
  type BrokerBackedStudioWritePort,
  type StudioAgentClaimIssuer,
} from "./broker-backed-studio-write.js";
import type { LiveGraphPort } from "./live-studio-tree.js";
import type { EventPort } from "./vscode-facade.js";
import { createProductionAdapters, type ProductionAdapters } from "./production-adapters.js";

export interface ProjectionChildrenPort<T> {
  children(path: string, signal: AbortSignal): Promise<readonly T[]>;
  readonly onInvalidated: EventPort<{ readonly path: string }>;
}
export interface LiveGraphSources {
  readonly files: ProjectionChildrenPort<FileProjectionNode>;
  readonly rojo: ProjectionChildrenPort<ProjectionNode>;
  readonly studio: ProjectionChildrenPort<ProjectionNode>;
  readonly onConnectionChanged: EventPort<ConnectionStateSnapshot>;
}
export interface ProductionServiceOptions {
  readonly sources?: LiveGraphSources;
  readonly extensionRoot?: string;
  readonly mutationGate?: StudioMutationGate;
  readonly ignorePolicy?: IgnorePolicyPort;
  readonly studioClaimIssuer?: StudioAgentClaimIssuer;
}

export interface ExtensionServices {
  readonly connection: ConnectionStateStore;
  readonly graph: LiveGraphPort;
  readonly project: { select(path: string): Promise<void>; readonly currentPath: () => string | undefined };
  readonly rojo: { start(projectPath: string): Promise<void>; stop(): Promise<void>; readonly accepted?: RojoService };
  readonly studio: {
    instances(): Promise<readonly StudioInstance[]>;
    selectInstance(id: string): Promise<void>;
    properties(path: string): Promise<StudioProperties | undefined>;
    guardedProperties(path: string, options: StudioPropertyReadOptions): Promise<StudioProperties>;
    snapshot(): { readonly activeInstanceId: string | undefined; readonly stale: boolean };
    callWrite(tool: string, input: object, context: StudioWriteOwnershipContext): Promise<unknown>;
    readonly accepted?: StudioMcpService;
  };
  readonly source: { pathFor(dataModelPath: string): string | undefined };
  readonly agent: {
    readonly contextRegistry: HostContextRegistry;
    readonly approvalBroker: InMemoryApprovalBroker;
    readonly ignorePolicy: IgnorePolicyPort;
    readonly studioWrites?: BrokerBackedStudioWritePort;
  };
  readonly journal: MutationJournal;
  readonly activity: ActivityEventStore;
  readonly playtest: {
    availability(): {
      readonly lifecycle: boolean;
      readonly logs: boolean;
      readonly screenshot: boolean;
      readonly reason?: string;
    };
    controller(instanceId: string): PlaytestController | undefined;
  };
  dispose(): Promise<void>;
}

class Emitter<T> {
  readonly #listeners = new Set<(value: T) => void>();
  readonly event: EventPort<T> = (listener) => {
    this.#listeners.add(listener);
    return { dispose: () => this.#listeners.delete(listener) };
  };
  emit(value: T): void {
    for (const listener of this.#listeners) listener(value);
  }
}

/** Reconciles real filesystem, Rojo, and Studio projections only when a tree request asks for a path. */
export function createReconciledLiveGraph(sources: LiveGraphSources): LiveGraphPort {
  const connectionChanged = new Emitter<ConnectionStateSnapshot>();
  const graphInvalidated = new Emitter<{ readonly path: string }>();
  let revision = 0;
  const disposables = [
    sources.onConnectionChanged((snapshot) => {
      revision += 1;
      connectionChanged.emit(snapshot);
    }),
    ...[sources.files, sources.rojo, sources.studio].map((source) =>
      source.onInvalidated((event) => {
        revision += 1;
        graphInvalidated.emit(event);
      }),
    ),
  ];
  const children = async (path: string, signal: AbortSignal): Promise<readonly UnifiedInstanceNode[]> => {
    const failSoft = async <T>(source: ProjectionChildrenPort<T>): Promise<readonly T[]> => {
      try {
        return await source.children(path, signal);
      } catch (error: unknown) {
        if (signal.aborted) throw error;
        return Object.freeze([]);
      }
    };
    const [files, rojo, studio] = await Promise.all([
      failSoft(sources.files),
      failSoft(sources.rojo),
      failSoft(sources.studio),
    ]);
    if (signal.aborted) return Object.freeze([]);
    return Object.freeze(
      [...reconcileInstanceGraph({ files, rojo, studio }).values()].filter(
        (node) => parentDataModelPath(node.path) === path,
      ),
    );
  };
  return Object.freeze({
    children,
    resolve: async (path: string, signal: AbortSignal) => {
      const expectedRevision = revision;
      const matches = (await children(parentDataModelPath(path) ?? "game", signal)).filter(
        (node) => node.path === path,
      );
      if (revision !== expectedRevision) throw new Error("Unified graph changed during target resolution");
      if (matches.length !== 1 || matches[0] === undefined) {
        throw new Error(`Unified graph target not found: ${path}`);
      }
      return Object.freeze({ node: matches[0], revision: expectedRevision });
    },
    assertRevision: (expectedRevision: number) => {
      if (expectedRevision !== revision) throw new Error("Unified graph changed before mutation");
    },
    revision: () => revision,
    onConnectionChanged: connectionChanged.event,
    onGraphInvalidated: graphInvalidated.event,
    dispose: () => disposables.forEach((disposable) => disposable.dispose()),
  });
}

/** Deterministic, process-free composition used by tests and local fixture mode. */
export function createFixtureServices(): ExtensionServices {
  return createServices(
    true,
    fixtureSources(),
    undefined,
    undefined,
    undefined,
    new RevisionedIgnorePolicy({ evaluate: () => false }),
  );
}

/** Production construction accepts real projection ports but starts no process or provider during activation. */
export function createProductionServices(options: ProductionServiceOptions = {}): ExtensionServices {
  const connection = createConnectionState({ simulation: false });
  const adapters =
    options.sources === undefined
      ? createProductionAdapters({
          connection,
          ...(options.extensionRoot === undefined ? {} : { extensionRoot: options.extensionRoot }),
          ...(options.mutationGate === undefined ? {} : { mutationGate: options.mutationGate }),
        })
      : undefined;
  return createServices(
    false,
    options.sources ?? adapters?.sources ?? disconnectedSources(),
    adapters,
    connection,
    options.studioClaimIssuer,
    options.ignorePolicy ?? new RevisionedIgnorePolicy({ evaluate: () => true }),
  );
}

function createServices(
  simulation: boolean,
  sources: LiveGraphSources,
  adapters?: ProductionAdapters,
  providedConnection?: ConnectionStateStore,
  studioClaimIssuer?: ProductionServiceOptions["studioClaimIssuer"],
  ignorePolicy: IgnorePolicyPort = new RevisionedIgnorePolicy({ evaluate: () => true }),
): ExtensionServices {
  const connection = providedConnection ?? createConnectionState({ simulation });
  const connectionEvents = new Emitter<ConnectionStateSnapshot>();
  const disposeConnectionListener = connection.onDidChange((snapshot) => connectionEvents.emit(snapshot));
  let projectPath: string | undefined;
  const journal = new MutationJournal();
  const activity = new ActivityEventStore();
  const contextRegistry = new HostContextRegistry({ ignorePolicy });
  const approvalBroker = new InMemoryApprovalBroker();
  const studioWrites = createBrokerBackedStudioWrites({
    broker: approvalBroker,
    issuer: studioClaimIssuer,
    guardedProperties: adapters?.guardedProperties,
    writeWithClaim: adapters?.callWriteWithClaim,
  });
  const controllers = new Map<string, PlaytestController>();
  let disposePromise: Promise<void> | undefined;
  const fixture = simulation;
  const graph = createReconciledLiveGraph({
    ...sources,
    onConnectionChanged:
      adapters === undefined
        ? mergeEvents([sources.onConnectionChanged, connectionEvents.event])
        : connectionEvents.event,
  });
  const instances: readonly StudioInstance[] = fixture
    ? Object.freeze([
        {
          instanceId: "fixture-instance",
          role: "edit",
          placeId: 0,
          placeName: "Fixture",
          dataModelName: "Fixture",
          isRunning: false,
          pluginVersion: "fixture",
          pluginVariant: "fixture",
          serverVersion: "fixture",
          versionMismatch: false,
          lastActivity: 0,
          connectedAt: 0,
        },
      ])
    : Object.freeze([]);
  return Object.freeze({
    connection,
    graph,
    project: Object.freeze({
      select: async (path: string) => {
        projectPath = path;
        connection.update("workspace", { health: "healthy", detail: path });
      },
      currentPath: () => projectPath,
    }),
    rojo: Object.freeze({
      start: async (projectPath: string) => {
        if (!fixture) {
          await adapters?.startRojo(projectPath);
          return;
        }
        connection.update("rojoProcess", { health: "healthy", detail: "Fixture Rojo started" });
      },
      stop: async () => {
        if (!fixture) {
          await adapters?.stopRojo();
          return;
        }
        connection.update("rojoProcess", { health: "unhealthy", detail: "Fixture Rojo stopped" });
      },
    }),
    studio: Object.freeze({
      instances: async () => (fixture ? instances : (adapters?.instances() ?? [])),
      selectInstance: async (id: string) => {
        if (!fixture) {
          await adapters?.selectInstance(id);
          return;
        }
        connection.update("activeStudioInstance", { health: "healthy", detail: "Fixture Studio selected" });
      },
      properties: async (path: string) =>
        fixture
          ? Object.freeze({ instancePath: path, className: "Script", properties: Object.freeze({}) })
          : adapters?.properties(path),
      guardedProperties: async (path: string, readOptions: StudioPropertyReadOptions) => {
        if (fixture) {
          if (readOptions.expectedInstanceId !== "fixture-instance") throw new Error("Active Studio instance changed");
          return Object.freeze({ instancePath: path, className: "Script", properties: Object.freeze({}) });
        }
        if (adapters === undefined) throw new Error("Studio properties unavailable");
        return adapters.guardedProperties(path, readOptions);
      },
      snapshot: () =>
        fixture
          ? { activeInstanceId: "fixture-instance", stale: false }
          : (adapters?.snapshot() ?? { activeInstanceId: undefined, stale: true }),
      callWrite: async (tool: string, input: object, context: StudioWriteOwnershipContext) => {
        if (fixture) throw new Error("Fixture Studio mutations require an explicit gate");
        if (adapters === undefined) throw new Error("Studio mutations unavailable");
        return adapters.callWrite(tool, input, context);
      },
    }),
    source: Object.freeze({
      pathFor: (path: string) =>
        fixture && path === "game.Workspace.Mapped" ? "/fixture/Mapped.server.lua" : adapters?.pathFor(path),
    }),
    agent: Object.freeze({
      contextRegistry,
      approvalBroker,
      ignorePolicy,
      ...(studioWrites === undefined ? {} : { studioWrites }),
    }),
    journal,
    activity,
    playtest: Object.freeze({
      availability: () =>
        fixture
          ? {
              lifecycle: false,
              logs: false,
              screenshot: false,
              reason: "Studio MCP playtest capabilities are unavailable in fixture mode",
            }
          : (adapters?.playtestAvailability() ?? {
              lifecycle: false,
              logs: false,
              screenshot: false,
              reason: "Studio MCP has not been discovered",
            }),
      controller: (instanceId: string) => {
        if (fixture || adapters === undefined) return undefined;
        const existing = controllers.get(instanceId);
        if (existing !== undefined) return existing;
        const capability: PlaytestCapabilityPort = adapters.playtestPort(instanceId, () => graph.revision?.() ?? 0);
        const controller = new PlaytestController({
          instanceId,
          capability,
          onActivity: (event) => activity.append(event),
        });
        controllers.set(instanceId, controller);
        return controller;
      },
    }),
    dispose: () => {
      disposePromise ??= (async () => {
        disposeConnectionListener();
        for (const controller of controllers.values()) controller.dispose();
        controllers.clear();
        graph.dispose?.();
        ignorePolicy.dispose();
        studioClaimIssuer?.disposeClaims?.();
        approvalBroker.dispose();
        await adapters?.dispose();
      })();
      return disposePromise;
    },
  });
}

function fixtureSources(): LiveGraphSources {
  const connection = new Emitter<ConnectionStateSnapshot>();
  const invalidated = new Emitter<{ readonly path: string }>();
  const files: readonly FileProjectionNode[] = Object.freeze([
    { path: "game.Workspace", filePaths: ["/fixture/src"] },
    { path: "game.Workspace.Mapped", filePaths: ["/fixture/Mapped.server.lua"] },
  ]);
  const projection = (path: string, name: string, className: string): ProjectionNode =>
    Object.freeze({ path, name, className });
  const rojo = Object.freeze([
    projection("game.Workspace", "Workspace", "Folder"),
    projection("game.Workspace.Mapped", "Mapped", "Script"),
  ]);
  const studio = Object.freeze([
    projection("game.Workspace", "Workspace", "Folder"),
    projection("game.Workspace.Mapped", "Mapped", "Script"),
  ]);
  const port = <T>(nodes: readonly T[]): ProjectionChildrenPort<T> => ({
    children: async () => nodes,
    onInvalidated: invalidated.event,
  });
  return { files: port(files), rojo: port(rojo), studio: port(studio), onConnectionChanged: connection.event };
}

function disconnectedSources(): LiveGraphSources {
  const empty = new Emitter<{ readonly path: string }>();
  const connection = new Emitter<ConnectionStateSnapshot>();
  const port = <T>(): ProjectionChildrenPort<T> => ({
    children: async () => Object.freeze([]),
    onInvalidated: empty.event,
  });
  return {
    files: port<FileProjectionNode>(),
    rojo: port<ProjectionNode>(),
    studio: port<ProjectionNode>(),
    onConnectionChanged: connection.event,
  };
}

function mergeEvents<T>(events: readonly EventPort<T>[]): EventPort<T> {
  return (listener) => {
    const disposables = events.map((event) => event(listener));
    return { dispose: () => disposables.forEach((disposable) => disposable.dispose()) };
  };
}
