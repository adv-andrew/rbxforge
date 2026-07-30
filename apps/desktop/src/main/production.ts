import { watch as watchDirectory } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname } from "node:path";
import type { BrowserWindowConstructorOptions } from "electron";
import { RojoService, type RojoSourcemapPort } from "@rbxforge/rojo";
import type { ProjectRecord } from "../shared/domain.js";
import { AppController, type RecapturedProjectContext } from "./app-controller.js";
import { startDesktopHost, type DesktopComposition, type DesktopHost } from "./index.js";
import { registerDesktopCloseBarrier, registerDesktopIpc, type DesktopIpcMain } from "./ipc.js";
import {
  captureProjectIdentity,
  assertProjectIdentityCurrent,
  readProjectConfig,
} from "./projects/project-identity.js";
import { ProjectService } from "./projects/project-service.js";
import { ProjectWatcher } from "./projects/project-watcher.js";
import { resolveDesktopPaths, type DesktopPaths } from "./packaged-paths.js";
import { BindingCoordinator } from "./runtime/binding-coordinator.js";
import { createStudioBrokerSession } from "./runtime/mcp-client-port.js";
import { createNodeProcessRunner } from "./runtime/node-process-runner.js";
import type { ProjectRuntimeInvalidation } from "./runtime/project-runtime-registry.js";
import { ProjectRuntimeRegistry } from "./runtime/project-runtime-registry.js";
import { RojoExecutableResolver } from "./runtime/rojo-executable.js";
import type { StudioBrokerInvalidationReason, StudioBrokerSnapshot } from "./runtime/studio-broker-controller.js";
import { StudioBrokerController } from "./runtime/studio-broker-controller.js";
import { StudioPluginInstaller } from "./runtime/studio-plugin-installer.js";
import { ConversationRepository } from "./storage/conversation-repository.js";
import { openDesktopDatabase, type DesktopDatabase } from "./storage/database.js";
import { runMigrations } from "./storage/migrations.js";
import { ProjectRepository } from "./storage/project-repository.js";
import { SettingsRepository } from "./storage/settings-repository.js";
import { createMainWindow, type MainWindowLike, type PermissionSession } from "./window.js";

export interface ProductionAppPort {
  requestSingleInstanceLock(): boolean;
  whenReady(): Promise<void>;
  quit(): void;
}

export async function startProductionApplication<THost>(options: {
  readonly app: ProductionAppPort;
  readonly startReadyHost: () => Promise<THost>;
}): Promise<THost | undefined> {
  if (!options.app.requestSingleInstanceLock()) {
    options.app.quit();
    return undefined;
  }
  await options.app.whenReady();
  return options.startReadyHost();
}

interface ProductionElectronApp extends ProductionAppPort {
  readonly isPackaged: boolean;
  getAppPath(): string;
  getPath(name: "home" | "userData"): string;
  on(name: "before-quit", listener: (event: { preventDefault(): void }) => void): void;
  on(name: "activate" | "second-instance" | "window-all-closed", listener: () => void): void;
  removeListener(name: "before-quit", listener: (event: { preventDefault(): void }) => void): void;
  removeListener(name: "activate" | "second-instance" | "window-all-closed", listener: () => void): void;
}

interface ProductionPowerMonitor {
  on(name: "resume", listener: () => void): void;
  removeListener(name: "resume", listener: () => void): void;
}

export interface ProductionElectronRuntime extends ProductionElectronPorts {
  readonly app: ProductionElectronApp;
  readonly powerMonitor: ProductionPowerMonitor;
  readonly resourcesPath: string;
}

declare const __RBXFORGE_CSP_NONCE__: string;

export async function launchProductionElectron(
  injectedRuntime?: ProductionElectronRuntime,
): Promise<DesktopHost | undefined> {
  const runtime = injectedRuntime ?? (await loadElectronRuntime());
  const paths = resolveDesktopPaths({
    app: runtime.app,
    resourcesPath: runtime.resourcesPath,
  });
  const developmentPort = runtime.app.isPackaged
    ? undefined
    : developmentServerPort(process.env.RBXFORGE_DEV_SERVER_PORT);
  const styleNonce = productionCspNonce();
  return startProductionApplication({
    app: runtime.app,
    startReadyHost: () =>
      startDesktopHost({
        app: runtime.app,
        powerMonitor: runtime.powerMonitor,
        openDatabase: openDesktopDatabase,
        migrate: runMigrations,
        compose: (database) =>
          createProductionComposition({
            database,
            paths,
            homeDirectory: runtime.app.getPath("home"),
            electron: runtime,
            environment: process.env,
            styleNonce,
            ...(developmentPort === undefined ? {} : { developmentPort }),
          }),
        ...paths,
      }),
  });
}

export interface ProductionElectronPorts {
  readonly BrowserWindow: new (options: BrowserWindowConstructorOptions) => MainWindowLike;
  readonly permissionSession: PermissionSession;
  readonly dialog: {
    showOpenDialog(options: {
      readonly properties: readonly ("openDirectory" | "openFile")[];
    }): Promise<{ readonly canceled: boolean; readonly filePaths: readonly string[] }>;
  };
  readonly clipboard: {
    writeText(value: string): void;
  };
  readonly shell: {
    showItemInFolder(path: string): void;
  };
  readonly ipcMain: DesktopIpcMain;
}

export function createProductionComposition(options: {
  readonly database: DesktopDatabase;
  readonly paths: DesktopPaths;
  readonly homeDirectory: string;
  readonly electron: ProductionElectronPorts;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly styleNonce: string;
  readonly developmentPort?: number;
}): DesktopComposition {
  const projects = new ProjectRepository(options.database);
  const conversations = new ConversationRepository(options.database);
  const settings = new SettingsRepository(options.database);
  const projectService = new ProjectService({ projects });
  const native = {
    pickDirectories: async (): Promise<readonly string[]> => {
      const result = await options.electron.dialog.showOpenDialog({ properties: ["openDirectory"] });
      return result.canceled ? [] : Object.freeze([...result.filePaths]);
    },
    pickFiles: async (): Promise<readonly string[]> => {
      const result = await options.electron.dialog.showOpenDialog({ properties: ["openFile"] });
      return result.canceled ? [] : Object.freeze([...result.filePaths]);
    },
    writeClipboard: (value: string): void => options.electron.clipboard.writeText(value),
    showItemInFolder: (path: string): void => options.electron.shell.showItemInFolder(path),
  };
  const runner = createNodeProcessRunner();
  const envPath = options.environment?.PATH;
  const resolver = new RojoExecutableResolver({
    runner,
    ...(envPath === undefined ? {} : { envPath }),
    homeDirectory: options.homeDirectory,
  });
  const runtimeInvalidations = new RuntimeInvalidationHub();
  const sourcemap = createProductionSourcemapPort();
  const runtimes = new ProjectRuntimeRegistry({
    createService: ({ command }) =>
      new RojoService({
        runner,
        command,
        allocatePort: allocateLoopbackPort,
        probeHealth: probeLoopbackRojoHealth,
        sourcemap,
      }),
    assertProjectCurrent: assertProjectIdentityCurrent,
    onInvalidated: (event) => runtimeInvalidations.forward(event),
  });
  const brokerProvider = new TransactionalStudioBrokerProvider({
    initialPort: settings.getMcpPort() ?? 58_741,
    createController: (primaryPort, onInvalidated) =>
      new StudioBrokerController({
        primaryPort,
        vendoredEntryPath: options.paths.mcpEntryPath,
        ...(options.environment === undefined ? {} : { environment: options.environment }),
        createSession: createStudioBrokerSession,
        onInvalidated,
      }),
  });
  const bindings = new BindingCoordinator({
    projectContext: (projectId) => {
      const project = projects.findById(projectId);
      if (project === undefined) throw new Error("Project context is unavailable.");
      return {
        project: projectRefFromRecord(project, 1),
        servePlaceIds: project.servePlaceIds,
      };
    },
    runtimes,
    broker: () => brokerProvider.current(),
  });
  const plugin = new StudioPluginInstaller({
    sourcePath: options.paths.pluginSourcePath,
    homeDirectory: options.homeDirectory,
  });
  const appController = new AppController({
    projects,
    conversations,
    settings,
    projectService,
    native,
    recaptureProject: recaptureStoredProject,
    createWatcher: (ref, invalidated) =>
      new ProjectWatcher().start(ref, ({ projectId, reason }) => invalidated(projectId, reason.code)),
    resolver,
    plugin,
    runtimes,
    subscribeRuntimeInvalidation: (listener) => runtimeInvalidations.subscribe(listener),
    brokerProvider,
    bindings,
  });
  const controller = {
    initialize: () => appController.initialize(),
    execute: (command: Parameters<AppController["execute"]>[0]) => appController.execute(command),
    subscribe: (listener: Parameters<AppController["subscribe"]>[0]) => appController.subscribe(listener),
    dispose: () => disposeProductionController(appController, brokerProvider),
  };
  return Object.freeze({
    controller,
    bindingCoordinator: bindings,
    registerIpc: () => registerDesktopIpc({ ipcMain: options.electron.ipcMain, controller }),
    registerCloseBarrier: () => registerDesktopCloseBarrier({ ipcMain: options.electron.ipcMain }),
    createWindow: (paths: {
      readonly rendererFile: string;
      readonly preloadFile: string;
      readonly mcpEntryPath: string;
      readonly pluginSourcePath: string;
    }) => {
      const initialBounds = safeWindowBounds(settings);
      return createMainWindow({
        BrowserWindow: options.electron.BrowserWindow,
        rendererFile: paths.rendererFile,
        preloadFile: paths.preloadFile,
        permissionSession: options.electron.permissionSession,
        ...(initialBounds === undefined ? {} : { initialBounds }),
        persistBounds: (bounds) => settings.setWindowBounds(bounds),
        styleNonce: options.styleNonce,
        ...(options.developmentPort === undefined ? {} : { developmentPort: options.developmentPort }),
      });
    },
  });
}

export async function recaptureStoredProject(
  record: ProjectRecord,
  revision: number,
): Promise<RecapturedProjectContext> {
  const project = captureProjectIdentity({
    projectId: record.id,
    rootPath: record.canonicalRoot,
    projectFilePath: record.canonicalProjectFile,
    revision,
  });
  const config = readProjectConfig(project);
  return Object.freeze({
    project,
    servePlaceIds: config.servePlaceIds,
  });
}

interface ReplaceableBroker {
  snapshot(): StudioBrokerSnapshot;
  stop(): Promise<void>;
}

export class TransactionalStudioBrokerProvider<TController extends ReplaceableBroker> {
  readonly #createController: (
    port: number,
    onInvalidated: (reason: StudioBrokerInvalidationReason) => void,
  ) => TController;
  readonly #listeners = new Set<(reason: StudioBrokerInvalidationReason) => void>();
  readonly #controllers = new Set<TController>();
  readonly #stopPromises = new WeakMap<TController, Promise<void>>();
  #current: TController;
  #configuredPort: number;
  #staged:
    | {
        readonly identity: object;
        readonly controller: TController;
        readonly port: number;
      }
    | undefined;
  #shutdown: Promise<void> | undefined;

  constructor(options: {
    readonly initialPort: number;
    readonly createController: (
      port: number,
      onInvalidated: (reason: StudioBrokerInvalidationReason) => void,
    ) => TController;
  }) {
    this.#createController = options.createController;
    this.#configuredPort = validPort(options.initialPort);
    this.#current = this.#newController(this.#configuredPort);
  }

  current(): TController {
    return this.#current;
  }

  configuredPort(): number {
    return this.#configuredPort;
  }

  subscribeInvalidation(listener: (reason: StudioBrokerInvalidationReason) => void): () => void {
    this.#listeners.add(listener);
    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      this.#listeners.delete(listener);
    };
  }

  async prepareReplacement(primaryPort: number): Promise<{
    commit(): Promise<void>;
    rollback(): Promise<void>;
  }> {
    if (this.#shutdown !== undefined) throw new Error("Studio broker provider is shut down.");
    if (this.#staged !== undefined) throw new Error("A Studio broker replacement is already staged.");
    const port = validPort(primaryPort);
    const oldPort = this.#configuredPort;
    const oldController = this.#current;
    const staged = {
      identity: {},
      controller: this.#newController(port),
      port,
    };
    this.#staged = staged;
    let state: "prepared" | "committed" | "rolled-back" = "prepared";
    return Object.freeze({
      commit: async () => {
        if (state === "committed") return;
        if (state !== "prepared" || this.#staged !== staged || this.#current !== oldController) {
          throw new Error("Studio broker replacement is no longer current.");
        }
        if (oldController.snapshot().referenceCount !== 0) {
          throw new Error("The current Studio broker is not idle.");
        }
        this.#current = staged.controller;
        this.#configuredPort = staged.port;
        this.#staged = undefined;
        state = "committed";
        await this.#stopOnce(oldController);
      },
      rollback: async () => {
        if (state === "rolled-back") return;
        if (state === "prepared") {
          if (this.#staged === staged) this.#staged = undefined;
          state = "rolled-back";
          await this.#stopOnce(staged.controller);
          return;
        }
        const replacementForOldPort = this.#newController(oldPort);
        if (this.#current === staged.controller) {
          this.#current = replacementForOldPort;
          this.#configuredPort = oldPort;
        }
        state = "rolled-back";
        await this.#stopOnce(staged.controller);
      },
    });
  }

  shutdown(): Promise<void> {
    if (this.#shutdown !== undefined) return this.#shutdown;
    this.#listeners.clear();
    this.#staged = undefined;
    this.#shutdown = (async () => {
      const results = await Promise.allSettled([...this.#controllers].map((controller) => this.#stopOnce(controller)));
      const failures = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, "Studio broker provider shutdown failed.");
    })();
    return this.#shutdown;
  }

  #newController(port: number): TController {
    let controller: TController;
    controller = this.#createController(port, (reason) => {
      if (this.#current !== controller || this.#shutdown !== undefined) return;
      for (const listener of [...this.#listeners]) {
        try {
          listener(reason);
        } catch {
          // An observer cannot retain or revive a retired broker.
        }
      }
    });
    this.#controllers.add(controller);
    return controller;
  }

  #stopOnce(controller: TController): Promise<void> {
    const retained = this.#stopPromises.get(controller);
    if (retained !== undefined) return retained;
    const stopping = Promise.resolve().then(() => controller.stop());
    this.#stopPromises.set(controller, stopping);
    return stopping;
  }
}

export class RuntimeInvalidationHub {
  readonly #listeners = new Set<(projectId: string, reason: "rojo-exit") => void>();

  subscribe(listener: (projectId: string, reason: "rojo-exit") => void): () => void {
    this.#listeners.add(listener);
    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      this.#listeners.delete(listener);
    };
  }

  forward(event: ProjectRuntimeInvalidation): void {
    for (const listener of [...this.#listeners]) listener(event.projectId, "rojo-exit");
  }
}

export async function allocateLoopbackPort(): Promise<number> {
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      server.once("error", onError);
      server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
        server.removeListener("error", onError);
        resolve();
      });
    });
    const address = server.address();
    if (typeof address !== "object" || address === null) {
      throw new Error("Loopback port allocation did not return a TCP address.");
    }
    return validPort(address.port);
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    }
  }
}

interface HealthResponse {
  readonly ok: boolean;
}

export async function probeLoopbackRojoHealth(
  port: number,
  options: {
    readonly timeoutMs?: number;
    readonly fetch?: (input: string, init?: { readonly signal?: AbortSignal }) => Promise<HealthResponse>;
  } = {},
): Promise<boolean> {
  const checkedPort = validPort(port);
  const timeoutMs = options.timeoutMs ?? 1_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Rojo health timeout is invalid.");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.floor(timeoutMs));
  timeout.unref();
  try {
    const fetchHealth = options.fetch ?? ((input, init) => fetch(input, init));
    const response = await fetchHealth(`http://127.0.0.1:${checkedPort}`, {
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

export function createProductionSourcemapPort(
  dependencies: {
    readonly watch?: (directory: string, listener: () => void) => { close(): void };
    readonly read?: (path: string) => Promise<string>;
    readonly initialWaitMs?: number;
    readonly retryMs?: number;
  } = {},
): RojoSourcemapPort {
  const createWatch =
    dependencies.watch ??
    ((directory: string, listener: () => void) => {
      const watcher = watchDirectory(directory, { persistent: false }, () => listener());
      return { close: () => watcher.close() };
    });
  const read = dependencies.read ?? ((path: string) => readFile(path, "utf8"));
  const initialWaitMs = boundedSourcemapDelay(dependencies.initialWaitMs ?? 5_000, "initial wait");
  const retryMs = boundedSourcemapDelay(dependencies.retryMs ?? 25, "retry");
  return Object.freeze({
    async *watch(path: string, signal: AbortSignal): AsyncIterable<unknown> {
      let version = 0;
      let notify: (() => void) | undefined;
      const watcher = createWatch(dirname(path), () => {
        version += 1;
        notify?.();
      });
      let resolveAbort!: () => void;
      const aborted = new Promise<"aborted">((resolve) => {
        resolveAbort = () => resolve("aborted");
      });
      const onAbort = () => resolveAbort();
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
      const waitForVersion = async (observed: number, tickMs?: number): Promise<"changed" | "aborted" | "tick"> => {
        if (signal.aborted) return "aborted";
        if (version !== observed) return "changed";
        let timer: ReturnType<typeof setTimeout> | undefined;
        const changed = new Promise<"changed">((resolve) => {
          notify = () => resolve("changed");
          if (version !== observed) resolve("changed");
        });
        const outcomes: Promise<"changed" | "aborted" | "tick">[] = [changed, aborted];
        if (tickMs !== undefined) {
          outcomes.push(
            new Promise<"tick">((resolve) => {
              timer = setTimeout(() => resolve("tick"), tickMs);
              timer.unref();
            }),
          );
        }
        try {
          return await Promise.race(outcomes);
        } finally {
          notify = undefined;
          if (timer !== undefined) clearTimeout(timer);
        }
      };
      const readStable = async (
        deadline: number,
      ): Promise<{ readonly value: unknown; readonly version: number } | undefined> => {
        while (!signal.aborted) {
          const observed = version;
          try {
            const value = JSON.parse(await read(path)) as unknown;
            if (version !== observed) continue;
            return Object.freeze({ value, version: observed });
          } catch (error) {
            if (!isMissingSourcemap(error)) throw error;
          }
          const remaining = deadline - Date.now();
          if (remaining <= 0) {
            throw new Error(`Rojo sourcemap output was not created within ${initialWaitMs}ms.`);
          }
          if ((await waitForVersion(observed, Math.min(retryMs, remaining))) === "aborted") return undefined;
        }
        return undefined;
      };
      try {
        if (signal.aborted) return;
        let snapshot = await readStable(Date.now() + initialWaitMs);
        if (snapshot === undefined || signal.aborted) return;
        let observedVersion = snapshot.version;
        yield snapshot.value;
        while (!signal.aborted) {
          if ((await waitForVersion(observedVersion)) === "aborted" || signal.aborted) return;
          snapshot = await readStable(Date.now() + initialWaitMs);
          if (snapshot === undefined || signal.aborted) return;
          observedVersion = snapshot.version;
          yield snapshot.value;
        }
      } finally {
        notify = undefined;
        signal.removeEventListener("abort", onAbort);
        watcher.close();
      }
    },
  });
}

function boundedSourcemapDelay(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 1 || value > 30_000) {
    throw new Error(`Rojo sourcemap ${label} is invalid.`);
  }
  return Math.floor(value);
}

function isMissingSourcemap(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function validPort(port: number): number {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Loopback port is invalid.");
  }
  return port;
}

function projectRefFromRecord(project: ProjectRecord, revision: number) {
  return Object.freeze({
    projectId: project.id,
    canonicalRoot: project.canonicalRoot,
    rootDevice: project.rootDevice,
    rootInode: project.rootInode,
    canonicalProjectFile: project.canonicalProjectFile,
    projectFileDevice: project.projectFileDevice,
    projectFileInode: project.projectFileInode,
    configDigest: project.configDigest,
    revision,
  });
}

function safeWindowBounds(settings: SettingsRepository) {
  try {
    const bounds = settings.getWindowBounds();
    if (
      bounds === undefined ||
      ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) ||
      bounds.width < 960 ||
      bounds.height < 640
    ) {
      return undefined;
    }
    return bounds;
  } catch {
    // Corrupt persisted presentation state never prevents the safe default window.
    return undefined;
  }
}

async function disposeProductionController(
  controller: AppController,
  brokerProvider: TransactionalStudioBrokerProvider<StudioBrokerController>,
): Promise<void> {
  const failures: unknown[] = [];
  try {
    await controller.dispose();
  } catch (error) {
    failures.push(error);
  }
  try {
    await brokerProvider.shutdown();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "Production controller disposal failed.");
}

async function loadElectronRuntime(): Promise<ProductionElectronRuntime> {
  const electron = await import("electron");
  return createProductionElectronRuntime(electron, process.resourcesPath);
}

export function createProductionElectronRuntime(
  electronModule: unknown,
  resourcesPath: string,
): ProductionElectronRuntime {
  const electron = electronModule as {
    readonly app: ProductionElectronApp;
    readonly powerMonitor: ProductionPowerMonitor;
    readonly BrowserWindow: unknown;
    readonly session: { readonly defaultSession: unknown };
    readonly dialog: {
      showOpenDialog(options: {
        readonly properties: readonly ("openDirectory" | "openFile")[];
      }): Promise<{ readonly canceled: boolean; readonly filePaths: readonly string[] }>;
    };
    readonly clipboard: { writeText(value: string): void };
    readonly shell: { showItemInFolder(path: string): void };
    readonly ipcMain: DesktopIpcMain;
  };
  return {
    app: electron.app,
    powerMonitor: electron.powerMonitor,
    resourcesPath,
    BrowserWindow: electron.BrowserWindow as unknown as ProductionElectronPorts["BrowserWindow"],
    get permissionSession() {
      // Electron rejects defaultSession access before app.whenReady(). The
      // composition consumes this getter only in startReadyHost.
      return electron.session.defaultSession as PermissionSession;
    },
    dialog: {
      showOpenDialog: (options) =>
        electron.dialog.showOpenDialog({
          properties: [...options.properties],
        }),
    },
    clipboard: {
      writeText: (value) => electron.clipboard.writeText(value),
    },
    shell: {
      showItemInFolder: (path) => electron.shell.showItemInFolder(path),
    },
    ipcMain: electron.ipcMain,
  };
}

function productionCspNonce(): string {
  if (typeof __RBXFORGE_CSP_NONCE__ !== "string" || !/^[A-Za-z0-9_-]{32,128}$/.test(__RBXFORGE_CSP_NONCE__)) {
    throw new Error("The desktop build CSP nonce is unavailable.");
  }
  return __RBXFORGE_CSP_NONCE__;
}

function developmentServerPort(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1_024 || value > 65_535) {
    throw new Error("The desktop development server port is invalid.");
  }
  return value;
}

function isElectronMainProcess(): boolean {
  return process.type === "browser" && typeof process.versions.electron === "string";
}

if (isElectronMainProcess()) {
  void launchProductionElectron().catch(async (error: unknown) => {
    const message = error instanceof Error ? error.message : "Unknown startup failure.";
    console.error(`RbxForge startup failed: ${message}`);
    try {
      const { app } = await import("electron");
      app.quit();
    } catch {
      // The process is already unable to load its Electron application boundary.
    }
  });
}
