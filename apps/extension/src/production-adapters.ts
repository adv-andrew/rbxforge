import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, watch } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type {
  FileProjectionNode,
  LogCursor,
  PlayMode,
  PlaytestCapabilityPort,
  PlaytestStartResult,
  PlaytestStatusResult,
  PlaytestStopResult,
  ProjectionNode,
  RuntimeLogBatch,
  ScreenshotResult,
} from "@rbxforge/core";
import { RojoService, type ProcessResult, type ProcessRunner, type SourcedProjectionNode } from "@rbxforge/rojo";
import {
  StudioMcpService,
  type McpClientPort,
  type StudioAgentMutationClaim,
  type StudioInstance,
  type StudioMutationGate,
  type StudioPlaytestCommandOptions,
  type StudioPlaytestReadOptions,
  type StudioProperties,
  type StudioPropertyReadOptions,
  type StudioCapability,
  type StudioWriteOwnershipContext,
} from "@rbxforge/studio-mcp";

import type { ConnectionStateStore } from "./connection-state.js";
import type { LiveGraphSources, ProjectionChildrenPort } from "./service-container.js";
import type { EventPort } from "./vscode-facade.js";

export interface ProductionAdapters {
  readonly sources: LiveGraphSources;
  startRojo(projectPath: string): Promise<void>;
  stopRojo(): Promise<void>;
  instances(): Promise<readonly StudioInstance[]>;
  selectInstance(id: string): Promise<void>;
  properties(path: string): Promise<StudioProperties | undefined>;
  snapshot(): { readonly activeInstanceId: string | undefined; readonly stale: boolean };
  guardedProperties(path: string, options: StudioPropertyReadOptions): Promise<StudioProperties>;
  callWrite(tool: string, input: object, context: StudioWriteOwnershipContext): Promise<unknown>;
  callWriteWithClaim(
    tool: string,
    input: object,
    context: StudioWriteOwnershipContext,
    claim: StudioAgentMutationClaim,
  ): Promise<unknown>;
  playtestAvailability(): {
    readonly lifecycle: boolean;
    readonly logs: boolean;
    readonly screenshot: boolean;
    readonly reason?: string;
  };
  playtestPort(instanceId: string, graphRevision: () => number): PlaytestCapabilityPort;
  pathFor(path: string): string | undefined;
  dispose(): Promise<void>;
}

export interface StudioRuntimePort {
  discover(): Promise<ReadonlySet<string>>;
  listConnectedInstances(): Promise<readonly StudioInstance[]>;
  snapshot(): {
    readonly activeInstanceId: string | undefined;
    readonly stale?: boolean;
    readonly capabilities?: Readonly<Partial<Record<StudioCapability, string | undefined>>>;
  };
  selectInstance(id: string): void;
  children(path: string): Promise<readonly ProjectionNode[]>;
  properties(path: string, options?: StudioPropertyReadOptions): Promise<StudioProperties>;
  callWrite?(tool: string, input: object, context: StudioWriteOwnershipContext): Promise<unknown>;
  callWriteWithClaim?(
    tool: string,
    input: object,
    context: StudioWriteOwnershipContext,
    claim: StudioAgentMutationClaim,
  ): Promise<unknown>;
  playtestStatus?(options: StudioPlaytestReadOptions): Promise<PlaytestStatusResult>;
  startPlaytest?(
    mode: PlayMode,
    context: StudioWriteOwnershipContext,
    options: StudioPlaytestCommandOptions,
  ): Promise<PlaytestStartResult>;
  stopPlaytest?(
    context: StudioWriteOwnershipContext,
    options: StudioPlaytestCommandOptions,
  ): Promise<PlaytestStopResult>;
  runtimeLogs?(
    cursor: LogCursor | undefined,
    options: StudioPlaytestReadOptions & { readonly filter?: string; readonly tail?: number },
  ): Promise<RuntimeLogBatch>;
  captureScreenshot?(
    options: StudioPlaytestReadOptions & { readonly format?: "jpeg" | "png"; readonly quality?: number },
  ): Promise<ScreenshotResult>;
  close(): Promise<void>;
}

export interface RojoRuntimeStatus {
  readonly processRunning: boolean;
  readonly apiHealthy: boolean;
  readonly port: number;
  readonly state?: "failed" | "stopped";
  readonly stderr?: string;
}

export type RojoProjectionUpdate =
  | {
      readonly type: "snapshot" | "update";
      readonly sessionId: string;
      readonly nodes: readonly SourcedProjectionNode[];
    }
  | { readonly type: "reset"; readonly sessionId: string }
  | { readonly type: "fallback"; readonly reason: "protocol-mismatch" | "protocol-unavailable" }
  | { readonly type: "failed"; readonly stderr: string };

export interface RojoRuntimePort {
  start(path: string): Promise<RojoRuntimeStatus>;
  stop(): Promise<void>;
  status(): RojoRuntimeStatus | undefined;
  onStatus(listener: (status: RojoRuntimeStatus) => void): () => void;
  watchProjection(path: string): AsyncIterable<RojoProjectionUpdate>;
}

export interface ProductionAdapterOptions {
  readonly connection: ConnectionStateStore;
  readonly extensionRoot?: string;
  readonly createStudio?: () => Promise<StudioRuntimePort>;
  readonly createRojo?: () => Promise<RojoRuntimePort>;
  readonly mutationGate?: StudioMutationGate;
}

/** Creates adapters only; no child process or MCP transport starts until a user command calls them. */
export function createProductionAdapters(options: ProductionAdapterOptions): ProductionAdapters {
  const invalidated = new Emitter<{ readonly path: string }>();
  let fileNodes: readonly FileProjectionNode[] = Object.freeze([]);
  let rojoNodes: readonly ProjectionNode[] = Object.freeze([]);
  let studioNodes: readonly ProjectionNode[] = Object.freeze([]);
  let studioCreation: Promise<StudioRuntimePort> | undefined;
  let studio: StudioRuntimePort | undefined;
  let rojo: RojoRuntimePort | undefined;
  let rojoStatusDispose: (() => void) | undefined;
  let projectionIterator: AsyncIterator<RojoProjectionUpdate> | undefined;
  let projectionLoop: Promise<void> | undefined;
  let rojoStart: Promise<void> | undefined;
  let rojoStop: Promise<void> | undefined;
  let rojoGeneration = 0;
  let disposed = false;
  let disposePromise: Promise<void> | undefined;

  const port = <T>(get: () => readonly T[]): ProjectionChildrenPort<T> => ({
    children: async () => get(),
    onInvalidated: invalidated.event,
  });

  const connectionEvent: EventPort<ReturnType<ConnectionStateStore["snapshot"]>> = (listener) => {
    const dispose = options.connection.onDidChange(listener);
    return { dispose };
  };

  const updateStudioAvailability = (instances: readonly StudioInstance[], service: StudioRuntimePort): void => {
    const selected = service.snapshot().activeInstanceId;
    const selectedConnected = selected !== undefined && instances.some((instance) => instance.instanceId === selected);
    const plugin =
      instances.length === 0
        ? { health: "unhealthy" as const, detail: "No Studio plugin connection" }
        : {
            health: "healthy" as const,
            detail: `${instances.length} Studio plugin connection${instances.length === 1 ? "" : "s"}`,
          };
    const place =
      instances.length === 0
        ? { health: "unhealthy" as const, detail: "No Studio place connected" }
        : {
            health: "healthy" as const,
            detail: `${instances.length} Studio place${instances.length === 1 ? "" : "s"} connected`,
          };
    const active = !selectedConnected
      ? {
          health: "unhealthy" as const,
          detail: instances.length === 0 ? "No Studio instance connected" : "Select a Studio instance",
        }
      : { health: "healthy" as const, detail: `Studio instance ${selected} selected` };
    options.connection.updateMany({
      studioPlugin: plugin,
      studioPlace: place,
      activeStudioInstance: active,
      placeRestriction: !selectedConnected
        ? { health: "unhealthy", detail: "No active Studio place" }
        : { health: "healthy", detail: "Active Studio place selected" },
    });
  };

  const markStudioError = (error: unknown): void => {
    void error;
    const detail = "Studio MCP unavailable";
    options.connection.updateMany({
      mcpProcess: { health: "unhealthy", detail },
      studioPlugin: { health: "unhealthy", detail },
      studioPlace: { health: "unhealthy", detail },
      activeStudioInstance: { health: "unhealthy", detail },
      placeRestriction: { health: "unhealthy", detail },
    });
  };

  const ensureStudio = async (): Promise<StudioRuntimePort> => {
    if (disposed) throw new Error("Production adapters are disposed");
    studioCreation ??= (async () => {
      options.connection.updateMany({
        mcpProcess: { health: "checking", detail: "Discovering Studio MCP" },
        studioPlugin: { health: "checking", detail: "Discovering Studio plugin" },
        studioPlace: { health: "checking", detail: "Discovering Studio place" },
        activeStudioInstance: { health: "checking", detail: "Discovering Studio instances" },
      });
      try {
        const service =
          options.createStudio === undefined
            ? await createPinnedStudioService(options.extensionRoot, options.mutationGate)
            : await options.createStudio();
        studio = service;
        await service.discover();
        if (disposed) throw new Error("Production adapters are disposed");
        options.connection.update("mcpProcess", {
          health: "healthy",
          detail: "Studio MCP discovered",
        });
        return service;
      } catch (error: unknown) {
        markStudioError(error);
        throw error;
      }
    })();
    return studioCreation;
  };

  const listStudioInstances = async (): Promise<readonly StudioInstance[]> => {
    try {
      const service = await ensureStudio();
      const instances = await service.listConnectedInstances();
      updateStudioAvailability(instances, service);
      return instances;
    } catch (error: unknown) {
      markStudioError(error);
      throw error;
    }
  };

  const applyRojoStatus = (status: RojoRuntimeStatus): void => {
    const detail =
      status.state === "stopped"
        ? "Rojo stopped"
        : status.state === "failed"
          ? "Rojo process failed"
          : status.processRunning
            ? "Rojo running"
            : "Rojo process unavailable";
    options.connection.updateMany({
      rojoBinary: { health: "healthy", detail: "Rojo executable started" },
      rojoProcess: {
        health: status.processRunning ? "healthy" : "unhealthy",
        detail,
      },
      rojoApi: {
        health: status.apiHealthy ? "healthy" : "unhealthy",
        detail: status.apiHealthy ? `Rojo API reachable on ${status.port}` : detail,
      },
    });
  };

  const replaceRojoProjection = (nodes: readonly SourcedProjectionNode[]): void => {
    rojoNodes = Object.freeze([...nodes]);
    fileNodes = Object.freeze(
      nodes.flatMap((node) =>
        node.filePaths === undefined
          ? []
          : [Object.freeze({ path: node.path, filePaths: Object.freeze([...node.filePaths]) })],
      ),
    );
    invalidated.emit({ path: "game" });
  };

  const consumeProjection = async (
    iterator: AsyncIterator<RojoProjectionUpdate>,
    generation: number,
  ): Promise<void> => {
    try {
      while (!disposed && generation === rojoGeneration) {
        const item = await iterator.next();
        if (item.done || disposed || generation !== rojoGeneration) return;
        const event = item.value;
        if (event.type === "snapshot" || event.type === "update") {
          replaceRojoProjection(event.nodes);
        } else if (event.type === "reset") {
          replaceRojoProjection(Object.freeze([]));
        } else if (event.type === "failed") {
          void event.stderr;
          options.connection.update("rojoApi", {
            health: "unhealthy",
            detail: "Rojo projection failed",
          });
        }
      }
    } catch (error: unknown) {
      if (!disposed && generation === rojoGeneration) {
        void error;
        const detail = "Rojo projection watcher failed";
        options.connection.updateMany({
          rojoProcess: { health: "unhealthy", detail },
          rojoApi: { health: "unhealthy", detail },
        });
      }
    }
  };

  const stopActiveRojo = (detail: string): Promise<void> => {
    if (rojoStop !== undefined) return rojoStop;
    const service = rojo;
    const iterator = projectionIterator;
    const loop = projectionLoop;
    rojoGeneration += 1;
    rojoStatusDispose?.();
    rojoStatusDispose = undefined;
    rojoStop = (async () => {
      const failures: string[] = [];
      if (service !== undefined) {
        try {
          await service.stop();
        } catch (error: unknown) {
          void error;
          const failure = "Rojo stop failed";
          failures.push(failure);
          options.connection.updateMany({
            rojoProcess: { health: "unhealthy", detail: failure },
            rojoApi: { health: "unhealthy", detail: failure },
          });
        }
      }
      try {
        if (iterator?.return !== undefined) await iterator.return();
      } catch (error: unknown) {
        void error;
        const failure = "Rojo projection close failed";
        failures.push(failure);
        options.connection.updateMany({
          rojoProcess: { health: "unhealthy", detail: failure },
          rojoApi: { health: "unhealthy", detail: failure },
        });
      }
      await loop;
      if (rojo === service) rojo = undefined;
      if (projectionIterator === iterator) projectionIterator = undefined;
      if (projectionLoop === loop) projectionLoop = undefined;
      fileNodes = Object.freeze([]);
      rojoNodes = Object.freeze([]);
      invalidated.emit({ path: "game" });
      options.connection.updateMany({
        rojoProcess: { health: "unhealthy", detail: failures.join("; ") || detail },
        rojoApi: { health: "unhealthy", detail: failures.join("; ") || detail },
      });
    })().finally(() => {
      rojoStop = undefined;
    });
    return rojoStop;
  };

  const startRojo = async (projectPath: string): Promise<void> => {
    if (disposed) throw new Error("Production adapters are disposed");
    if (rojo !== undefined || rojoStart !== undefined) {
      throw new Error("Rojo service is already started");
    }
    options.connection.updateMany({
      rojoBinary: { health: "checking", detail: "Starting Rojo executable" },
      rojoProcess: { health: "checking", detail: "Starting Rojo process" },
      rojoApi: { health: "checking", detail: "Probing Rojo API" },
    });
    const pending = (async () => {
      try {
        const service =
          options.createRojo === undefined
            ? new RojoService({
                runner: nodeProcessRunner(),
                command: "rojo",
                allocatePort,
                probeHealth,
                sourcemap: nodeSourcemapPort(),
              })
            : await options.createRojo();
        rojo = service;
        if (disposed) {
          await stopActiveRojo("Production adapters disposed");
          throw new Error("Production adapters are disposed");
        }
        rojoStatusDispose = service.onStatus(applyRojoStatus);
        const status = await service.start(projectPath);
        if (disposed) {
          await stopActiveRojo("Production adapters disposed");
          throw new Error("Production adapters are disposed");
        }
        applyRojoStatus(status);
        const generation = rojoGeneration + 1;
        rojoGeneration = generation;
        const iterator = service.watchProjection(projectPath)[Symbol.asyncIterator]();
        projectionIterator = iterator;
        projectionLoop = consumeProjection(iterator, generation);
      } catch (error: unknown) {
        rojoStatusDispose?.();
        rojoStatusDispose = undefined;
        const detail = "Rojo start failed";
        options.connection.updateMany({
          rojoBinary: { health: "unhealthy", detail },
          rojoProcess: { health: "unhealthy", detail },
          rojoApi: { health: "unhealthy", detail },
        });
        throw error;
      }
    })();
    rojoStart = pending;
    try {
      await pending;
    } finally {
      if (rojoStart === pending) rojoStart = undefined;
    }
  };

  const adapters: ProductionAdapters = {
    sources: {
      files: port(() => fileNodes),
      rojo: port(() => rojoNodes),
      studio: {
        children: async (path, signal) => {
          try {
            if (signal.aborted) throw abortError();
            const service = await ensureStudio();
            const instances = await service.listConnectedInstances();
            if (signal.aborted) throw abortError();
            updateStudioAvailability(instances, service);
            if (instances.length === 0) return Object.freeze([]);
            const selected = service.snapshot().activeInstanceId;
            if (selected === undefined) return Object.freeze([]);
            const nodes = await service.children(path);
            if (signal.aborted || disposed) throw abortError();
            studioNodes = Object.freeze(
              nodes.map((node) =>
                Object.freeze({
                  path: node.path,
                  name: node.name,
                  className: node.className,
                  ...(node.properties === undefined ? {} : { properties: node.properties }),
                  ...(node.revision === undefined ? {} : { revision: node.revision }),
                  ...(node.unsafeUnknownChildren === undefined
                    ? {}
                    : { unsafeUnknownChildren: node.unsafeUnknownChildren }),
                }),
              ),
            );
            return studioNodes;
          } catch (error: unknown) {
            if (signal.aborted || isAbortError(error)) throw error;
            markStudioError(error);
            return Object.freeze([]);
          }
        },
        onInvalidated: invalidated.event,
      },
      onConnectionChanged: connectionEvent,
    },

    startRojo,

    stopRojo: async () => {
      try {
        await rojoStart;
      } catch {
        // Start failures already update connection state.
      }
      await stopActiveRojo("Rojo stopped");
    },

    instances: listStudioInstances,

    selectInstance: async (id) => {
      try {
        const service = await ensureStudio();
        service.selectInstance(id);
        options.connection.updateMany({
          activeStudioInstance: { health: "healthy", detail: `Studio instance ${id} selected` },
          studioPlace: { health: "healthy", detail: "Studio place connected" },
          placeRestriction: { health: "healthy", detail: "Active Studio place selected" },
        });
      } catch (error: unknown) {
        markStudioError(error);
        throw error;
      }
    },

    properties: async (path) => {
      try {
        return await (await ensureStudio()).properties(path);
      } catch (error: unknown) {
        markStudioError(error);
        throw error;
      }
    },

    snapshot: () => ({
      activeInstanceId: studio?.snapshot().activeInstanceId,
      stale: studio?.snapshot().stale ?? studio === undefined,
    }),

    guardedProperties: async (path, readOptions) => {
      const service = await ensureStudio();
      return service.properties(path, readOptions);
    },

    callWrite: async (tool, input, context) => {
      const service = await ensureStudio();
      if (service.callWrite === undefined) throw new Error("Studio mutation capability is unavailable");
      return service.callWrite(tool, input, context);
    },
    callWriteWithClaim: async (tool, input, context, claim) => {
      const service = await ensureStudio();
      if (service.callWriteWithClaim === undefined) throw new Error("Agent Studio mutation capability is unavailable");
      return service.callWriteWithClaim(tool, input, context, claim);
    },

    playtestAvailability: () => {
      const capabilities = studio?.snapshot().capabilities;
      const lifecycle = capabilities?.soloPlaytest !== undefined;
      const logs = capabilities?.runtimeLogs !== undefined;
      const screenshot = capabilities?.screenshot !== undefined;
      return {
        lifecycle,
        logs,
        screenshot,
        ...(!lifecycle || !logs || !screenshot
          ? {
              reason:
                studio === undefined
                  ? "Studio MCP has not been discovered"
                  : missingPlaytestCapabilitiesReason({ lifecycle, logs, screenshot }),
            }
          : {}),
      };
    },

    playtestPort: (instanceId, graphRevision) => {
      const port: PlaytestCapabilityPort = {
        status: async (signal: AbortSignal) => {
          const service = await ensureStudio();
          if (service.playtestStatus === undefined) throw new Error("Studio MCP capability unavailable: soloPlaytest");
          return service.playtestStatus({ expectedInstanceId: instanceId, signal });
        },
        start: async (mode: PlayMode, signal: AbortSignal, onIssued?: () => void) => {
          const service = await ensureStudio();
          if (service.startPlaytest === undefined) throw new Error("Studio MCP capability unavailable: soloPlaytest");
          return service.startPlaytest(
            mode,
            {
              ownership: "studio",
              expectedInstanceId: instanceId,
              expectedGraphRevision: graphRevision(),
            },
            { signal, ...(onIssued === undefined ? {} : { onIssued }) },
          );
        },
        stop: async (signal: AbortSignal) => {
          const service = await ensureStudio();
          if (service.stopPlaytest === undefined) throw new Error("Studio MCP capability unavailable: soloPlaytest");
          return service.stopPlaytest(
            {
              ownership: "studio",
              expectedInstanceId: instanceId,
              expectedGraphRevision: graphRevision(),
            },
            { signal },
          );
        },
        logs: async (cursor: LogCursor | undefined, signal: AbortSignal) => {
          const service = await ensureStudio();
          if (service.runtimeLogs === undefined) throw new Error("Studio MCP capability unavailable: runtimeLogs");
          return service.runtimeLogs(cursor, { expectedInstanceId: instanceId, signal, tail: 2_000 });
        },
        screenshot: async (signal: AbortSignal) => {
          const service = await ensureStudio();
          if (service.captureScreenshot === undefined) throw new Error("Studio MCP capability unavailable: screenshot");
          return service.captureScreenshot({ expectedInstanceId: instanceId, signal, format: "jpeg" });
        },
      };
      return Object.freeze(port);
    },

    pathFor: (path) => {
      const matches = fileNodes.filter((node) => node.path === path).flatMap((node) => node.filePaths);
      return matches.length === 1 ? matches[0] : undefined;
    },

    dispose: () => {
      disposePromise ??= (async () => {
        disposed = true;
        try {
          await rojoStart;
        } catch {
          // Start failures already update connection state.
        }
        await stopActiveRojo("Production adapters disposed");
        try {
          await studioCreation;
        } catch {
          // Discovery errors are already represented in connection state.
        }
        const service = studio;
        studio = undefined;
        if (service !== undefined) {
          try {
            await service.close();
          } catch (error: unknown) {
            markStudioError(new Error(`Studio MCP close failed: ${message(error, "unknown error")}`));
          }
        }
        studioNodes = Object.freeze([]);
        invalidated.emit({ path: "game" });
        options.connection.disconnect("Production adapters disposed");
      })();
      return disposePromise;
    },
  };

  return Object.freeze(adapters);
}

function missingPlaytestCapabilitiesReason(availability: {
  readonly lifecycle: boolean;
  readonly logs: boolean;
  readonly screenshot: boolean;
}): string {
  const missing = [
    ...(availability.lifecycle ? [] : ["solo_playtest"]),
    ...(availability.logs ? [] : ["get_runtime_logs"]),
    ...(availability.screenshot ? [] : ["capture_screenshot"]),
  ];
  return missing.length === 1
    ? `Studio MCP capability unavailable: ${missing[0]}`
    : `Studio MCP capabilities unavailable: ${missing.join(", ")}`;
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

async function createPinnedStudioService(
  extensionRoot: string | undefined,
  mutationGate: StudioMutationGate = {
    authorize: async () => ({ approved: false, reason: "No native mutation confirmation is configured." }),
    consume: () => {
      throw new Error("No native mutation confirmation is configured.");
    },
  },
): Promise<StudioRuntimePort> {
  if (extensionRoot === undefined) {
    throw new Error("Installed extension root is required to start Studio MCP");
  }
  const client = await createPinnedMcpClient(extensionRoot);
  return new StudioMcpService(client, mutationGate, { selectionMode: "legacy-auto" });
}

export function vendoredStudioMcpLaunch(extensionRoot: string): {
  readonly command: string;
  readonly args: readonly string[];
  readonly shell: false;
} {
  return Object.freeze({
    command: process.execPath,
    args: Object.freeze([join(extensionRoot, "vendor", "robloxstudio-mcp", "index.mjs")]),
    shell: false,
  });
}

async function createPinnedMcpClient(extensionRoot: string): Promise<McpClientPort> {
  const launch = vendoredStudioMcpLaunch(extensionRoot);
  const client = new Client({ name: "rbxforge", version: "0.0.0" });
  // StdioClientTransport spawns this explicit command/argument pair with shell:false.
  const transport = new StdioClientTransport({
    command: launch.command,
    args: [...launch.args],
    stderr: "pipe",
  });
  await client.connect(transport);
  return {
    listTools: async () => client.listTools(),
    callTool: async (input, options) =>
      client.callTool(
        input,
        undefined,
        options === undefined
          ? undefined
          : {
              ...(options.signal === undefined ? {} : { signal: options.signal }),
              ...(options.timeoutMs === undefined
                ? {}
                : { timeout: options.timeoutMs, maxTotalTimeout: options.timeoutMs }),
            },
      ),
    close: async () => client.close(),
  };
}

function nodeProcessRunner(): ProcessRunner {
  return {
    run: async (spec) => waitFor(spawn(spec.command, [...spec.args], { shell: false })),
    start: async (spec) => {
      const child = spawn(spec.command, [...spec.args], { shell: false });
      return {
        exited: async () => waitFor(child),
        stop: async () => {
          if (!child.killed) child.kill();
        },
      };
    },
  };
}

async function waitFor(child: ReturnType<typeof spawn>): Promise<ProcessResult> {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout?.on("data", (data: Buffer) => stdout.push(data));
  child.stderr?.on("data", (data: Buffer) => stderr.push(data));
  const [code] = (await once(child, "close")) as [number | null];
  return {
    exitCode: code ?? 1,
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
  };
}

async function allocatePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  server.close();
  return typeof address === "object" && address !== null ? address.port : 0;
}

async function probeHealth(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}`);
    return response.ok;
  } catch {
    return false;
  }
}

function nodeSourcemapPort(): { watch(path: string, signal: AbortSignal): AsyncIterable<unknown> } {
  return {
    async *watch(path, signal) {
      yield JSON.parse(await readFile(path, "utf8")) as unknown;
      for await (const event of watch(path)) {
        if (signal.aborted) return;
        if (event.eventType === "change") {
          yield JSON.parse(await readFile(path, "utf8")) as unknown;
        }
      }
    },
  };
}

function message(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function abortError(): Error {
  const error = new Error("Aborted");
  error.name = "AbortError";
  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
