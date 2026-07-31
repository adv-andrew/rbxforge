import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RuntimeInvalidationHub,
  TransactionalStudioBrokerProvider,
  allocateLoopbackPort,
  createProductionElectronRuntime,
  createProductionComposition,
  createProductionSourcemapPort,
  probeLoopbackRojoHealth,
  recaptureStoredProject,
  startProductionApplication,
} from "./production.js";
import { openDesktopDatabase } from "./storage/database.js";
import { runMigrations } from "./storage/migrations.js";
import { ProjectRepository } from "./storage/project-repository.js";

const temporaryDirectories: string[] = [];
const inspectorBindingConstructions = vi.hoisted(() => [] as unknown[]);

vi.mock("./runtime/studio-inspector-service.js", () => ({
  StudioInspectorService: class {
    constructor(options: { readonly bindings: unknown }) {
      inspectorBindingConstructions.push(options.bindings);
    }

    async children(): Promise<never> {
      throw new Error("Production composition inspector fixture is read-only.");
    }

    async properties(): Promise<never> {
      throw new Error("Production composition inspector fixture is read-only.");
    }
  },
}));

afterEach(async () => {
  inspectorBindingConstructions.length = 0;
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("production Electron startup", () => {
  it("acquires the single-instance lock before awaiting readiness or composing services", async () => {
    const sequence: string[] = [];
    const result = await startProductionApplication({
      app: {
        requestSingleInstanceLock: () => {
          sequence.push("single-instance-lock");
          return true;
        },
        whenReady: async () => {
          sequence.push("when-ready");
        },
        quit: () => sequence.push("quit"),
      },
      startReadyHost: async () => {
        sequence.push("compose-ready-host");
        return "host";
      },
    });
    expect(result).toBe("host");
    expect(sequence).toEqual(["single-instance-lock", "when-ready", "compose-ready-host"]);
  });

  it("quits a rejected second instance without readiness, database, or composition work", async () => {
    const whenReady = vi.fn();
    const startReadyHost = vi.fn();
    const quit = vi.fn();
    await expect(
      startProductionApplication({
        app: {
          requestSingleInstanceLock: () => false,
          whenReady,
          quit,
        },
        startReadyHost,
      }),
    ).resolves.toBeUndefined();
    expect(quit).toHaveBeenCalledOnce();
    expect(whenReady).not.toHaveBeenCalled();
    expect(startReadyHost).not.toHaveBeenCalled();
  });

  it("defers the default session lookup until after Electron readiness", async () => {
    const sequence: string[] = [];
    let ready = false;
    const permissionSession = {};
    const runtime = createProductionElectronRuntime(
      {
        app: {
          requestSingleInstanceLock: () => {
            sequence.push("single-instance-lock");
            return true;
          },
          whenReady: async () => {
            sequence.push("when-ready");
            ready = true;
          },
          quit: vi.fn(),
        },
        session: {
          get defaultSession() {
            if (!ready) throw new Error("defaultSession was read before app readiness");
            sequence.push("default-session");
            return permissionSession;
          },
        },
        powerMonitor: {},
        BrowserWindow: class {
          readonly marker = "fake-browser-window";
        },
        dialog: {},
        clipboard: {},
        shell: {},
        ipcMain: {},
      } as never,
      "/absolute/resources",
    );

    await expect(
      startProductionApplication({
        app: runtime.app,
        startReadyHost: async () => runtime.permissionSession,
      }),
    ).resolves.toBe(permissionSession);
    expect(sequence).toEqual(["single-instance-lock", "when-ready", "default-session"]);
  });

  it("is a side-effecting Electron entry with no fixture activation branch", async () => {
    const source = await readFile(new URL("./production.ts", import.meta.url), "utf8");
    expect(source).toMatch(/isElectronMainProcess\(\)/);
    expect(source).toMatch(/void launchProductionElectron\(\)/);
    expect(source).not.toMatch(/fixture|test[-_ ]?mode|RBXFORGE_FIXTURE/i);
  });
});

describe("post-migration production composition", () => {
  it("constructs the real repositories, controller, runtimes, broker, IPC, and window only from production ports", async () => {
    const database = openDesktopDatabase(":memory:");
    runMigrations(database);
    const root = await mkdtemp(join(tmpdir(), "rbxforge-production-composition-"));
    temporaryDirectories.push(root);
    const window = windowHarness();
    const ipcHandlers = new Map<string, (event: unknown, input: unknown) => Promise<unknown>>();
    const composition = createProductionComposition({
      database,
      paths: {
        databasePath: join(root, "rbxforge.sqlite"),
        rendererFile: join(root, "dist/renderer/index.html"),
        preloadFile: join(root, "dist/preload/index.cjs"),
        mcpEntryPath: join(root, "dist/vendor/robloxstudio-mcp/index.mjs"),
        pluginSourcePath: join(root, "dist/vendor/studio-plugin/MCPPlugin.rbxmx"),
      },
      homeDirectory: root,
      electron: {
        BrowserWindow: window.BrowserWindow,
        permissionSession: window.permissionSession,
        dialog: {
          showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
        },
        clipboard: { writeText: vi.fn() },
        shell: { showItemInFolder: vi.fn() },
        ipcMain: {
          handle: (channel, handler) => ipcHandlers.set(channel, handler),
          removeHandler: (channel) => ipcHandlers.delete(channel),
        },
      },
      environment: {},
      styleNonce: "shared-build-nonce",
    });

    await expect(composition.controller.initialize()).resolves.toMatchObject({
      projects: [],
      settings: { preferredMcpPort: 58_741, sidebarWidth: 272 },
    });
    expect(inspectorBindingConstructions).toEqual([composition.bindingCoordinator]);
    const removeIpc = composition.registerIpc();
    expect([...ipcHandlers.keys()]).toEqual(["rbxforge:request"]);
    composition.createWindow({
      rendererFile: join(root, "dist/renderer/index.html"),
      preloadFile: join(root, "dist/preload/index.cjs"),
      mcpEntryPath: join(root, "dist/vendor/robloxstudio-mcp/index.mjs"),
      pluginSourcePath: join(root, "dist/vendor/studio-plugin/MCPPlugin.rbxmx"),
    });
    expect(window.options).toMatchObject({
      width: 1280,
      height: 800,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });
    removeIpc();
    await composition.controller.dispose();
    database.close();
  });

  it("opens with a persisted project in needs-reconnect when its directory was moved or deleted", async () => {
    const database = openDesktopDatabase(":memory:");
    runMigrations(database);
    const root = await mkdtemp(join(tmpdir(), "rbxforge-production-missing-project-"));
    temporaryDirectories.push(root);
    const missingRoot = join(root, "moved-project");
    new ProjectRepository(database).insertWithFirstThread({
      id: "missing-project",
      displayName: "Moved project",
      canonicalRoot: missingRoot,
      rootDevice: "missing",
      rootInode: "missing",
      canonicalProjectFile: join(missingRoot, "default.project.json"),
      projectFileDevice: "missing",
      projectFileInode: "missing",
      configDigest: "a".repeat(64),
      servePlaceIds: [101],
      createdAt: 1,
      updatedAt: 1,
      lastOpenedAt: 1,
    });
    const window = windowHarness();
    const composition = createProductionComposition({
      database,
      paths: {
        databasePath: join(root, "rbxforge.sqlite"),
        rendererFile: join(root, "dist/renderer/index.html"),
        preloadFile: join(root, "dist/preload/index.cjs"),
        mcpEntryPath: join(root, "dist/vendor/robloxstudio-mcp/index.mjs"),
        pluginSourcePath: join(root, "dist/vendor/studio-plugin/MCPPlugin.rbxmx"),
      },
      homeDirectory: root,
      electron: {
        BrowserWindow: window.BrowserWindow,
        permissionSession: window.permissionSession,
        dialog: {
          showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
        },
        clipboard: { writeText: vi.fn() },
        shell: { showItemInFolder: vi.fn() },
        ipcMain: {
          handle: vi.fn(),
          removeHandler: vi.fn(),
        },
      },
      environment: {},
      styleNonce: "shared-build-nonce",
    });

    await expect(composition.controller.initialize()).resolves.toMatchObject({
      projects: [expect.objectContaining({ id: "missing-project" })],
      runtimeByProject: {
        "missing-project": expect.objectContaining({ state: "needs-reconnect" }),
      },
    });
    await composition.controller.dispose();
    database.close();
  });

  it("recaptures the stored canonical root/file at a new revision and rereads servePlaceIds", async () => {
    const root = await mkdtemp(join(tmpdir(), "rbxforge-production-recapture-"));
    temporaryDirectories.push(root);
    const projectFile = join(root, "default.project.json");
    await writeFile(
      projectFile,
      JSON.stringify({
        name: "Live project",
        servePlaceIds: [123, 456],
        tree: { $className: "DataModel" },
      }),
    );
    const context = await recaptureStoredProject(
      {
        id: "project-a",
        displayName: "Stored name",
        canonicalRoot: root,
        rootDevice: "stale",
        rootInode: "stale",
        canonicalProjectFile: projectFile,
        projectFileDevice: "stale",
        projectFileInode: "stale",
        configDigest: "stale",
        servePlaceIds: [],
        createdAt: 1,
        updatedAt: 1,
        lastOpenedAt: 1,
      },
      7,
    );
    const canonicalRoot = await realpath(root);
    const canonicalProjectFile = await realpath(projectFile);
    expect(context.project).toMatchObject({
      projectId: "project-a",
      canonicalRoot,
      canonicalProjectFile,
      revision: 7,
    });
    expect(context.servePlaceIds).toEqual([123, 456]);
  });
});

describe("transactional production broker provider", () => {
  it("commits one replacement, stops the idle old controller, and identity-gates stale invalidations", async () => {
    const controllers: FakeBroker[] = [];
    const provider = new TransactionalStudioBrokerProvider({
      initialPort: 58_741,
      createController: (port, onInvalidated) => {
        const controller = new FakeBroker(port, onInvalidated);
        controllers.push(controller);
        return controller;
      },
    });
    const invalidations: string[] = [];
    const unsubscribe = provider.subscribeInvalidation((reason) => invalidations.push(reason));
    const old = provider.current() as FakeBroker;
    const replacement = await provider.prepareReplacement(58_742);
    const staged = controllers.at(-1)!;
    staged.invalidate();
    expect(invalidations).toEqual([]);

    await replacement.commit();
    expect(provider.current()).toBe(staged);
    expect(provider.configuredPort()).toBe(58_742);
    expect(old.stopCalls).toBe(1);
    old.invalidate();
    staged.invalidate();
    expect(invalidations).toEqual(["broker-exit"]);

    unsubscribe();
    staged.invalidate();
    expect(invalidations).toEqual(["broker-exit"]);
    await provider.shutdown();
    expect(staged.stopCalls).toBe(1);
  });

  it("rolls back a staged controller and leaves no staged or orphan controller on shutdown", async () => {
    const controllers: FakeBroker[] = [];
    const provider = new TransactionalStudioBrokerProvider({
      initialPort: 58_741,
      createController: (port, onInvalidated) => {
        const controller = new FakeBroker(port, onInvalidated);
        controllers.push(controller);
        return controller;
      },
    });
    const initial = provider.current();
    const replacement = await provider.prepareReplacement(58_742);
    const staged = controllers.at(-1)!;
    await replacement.rollback();
    await replacement.rollback();
    expect(provider.current()).toBe(initial);
    expect(staged.stopCalls).toBe(1);
    await provider.shutdown();
    expect((initial as FakeBroker).stopCalls).toBe(1);
    expect(controllers.every((controller) => controller.stopCalls === 1)).toBe(true);
  });

  it("propagates an idempotent redacted broker stop failure through provider shutdown", async () => {
    const closeFailure = new Error("Studio MCP session close failed");
    const controller = new FakeBroker(58_741, () => undefined, closeFailure);
    const provider = new TransactionalStudioBrokerProvider({
      initialPort: 58_741,
      createController: () => controller,
    });

    const first = provider.shutdown();
    expect(provider.shutdown()).toBe(first);
    await expect(first).rejects.toBe(closeFailure);
    expect(controller.stopCalls).toBe(1);
  });
});

describe("production Rojo adapters", () => {
  it("allocates an OS-selected loopback port and validates bounded health URLs", async () => {
    const port = await allocateLoopbackPort();
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThanOrEqual(65_535);

    const calls: string[] = [];
    await expect(
      probeLoopbackRojoHealth(port, {
        timeoutMs: 200,
        fetch: async (input, init) => {
          calls.push(String(input));
          expect(init?.signal).toBeInstanceOf(AbortSignal);
          return { ok: true };
        },
      }),
    ).resolves.toBe(true);
    expect(calls).toEqual([`http://127.0.0.1:${port}`]);
    await expect(probeLoopbackRojoHealth(0)).rejects.toThrow(/port/i);
  });

  it("reads sourcemap JSON only after an abort-aware watch notification", async () => {
    const root = await mkdtemp(join(tmpdir(), "rbxforge-sourcemap-port-"));
    temporaryDirectories.push(root);
    const path = join(root, "sourcemap.json");
    await writeFile(path, JSON.stringify({ name: "game", className: "DataModel" }));
    let notify: (() => void) | undefined;
    let closed = false;
    const port = createProductionSourcemapPort({
      watch: (_path, listener) => {
        notify = listener;
        return { close: () => (closed = true) };
      },
    });
    const controller = new AbortController();
    const iterator = port.watch(path, controller.signal)[Symbol.asyncIterator]();
    const next = iterator.next();
    notify?.();
    await expect(next).resolves.toEqual({
      done: false,
      value: { name: "game", className: "DataModel" },
    });
    controller.abort();
    await iterator.return?.();
    expect(closed).toBe(true);
  });

  it("waits for an absent sourcemap output and retains a notification delivered between iterator reads", async () => {
    const root = await mkdtemp(join(tmpdir(), "rbxforge-sourcemap-create-"));
    temporaryDirectories.push(root);
    const path = join(root, "sourcemap.json");
    let source: string | undefined;
    let notify: (() => void) | undefined;
    let watchedPath: string | undefined;
    let closed = false;
    const port = createProductionSourcemapPort({
      watch: (target, listener) => {
        watchedPath = target;
        notify = listener;
        return { close: () => (closed = true) };
      },
      read: async () => {
        if (source === undefined) {
          throw Object.assign(new Error("sourcemap output does not exist yet"), { code: "ENOENT" });
        }
        return source;
      },
    });
    const controller = new AbortController();
    const iterator = port.watch(path, controller.signal)[Symbol.asyncIterator]();
    const first = iterator.next();
    source = JSON.stringify({ name: "first", className: "DataModel" });
    notify?.();

    await expect(first).resolves.toEqual({
      done: false,
      value: { name: "first", className: "DataModel" },
    });
    expect(watchedPath).toBe(root);

    source = JSON.stringify({ name: "second", className: "DataModel" });
    notify?.();
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { name: "second", className: "DataModel" },
    });

    controller.abort();
    await iterator.return?.();
    expect(closed).toBe(true);
  });
});

describe("runtime invalidation hub", () => {
  it("forwards registry invalidation as exact projectId/reason pairs and unsubscribes exactly", () => {
    const hub = new RuntimeInvalidationHub();
    const calls: unknown[][] = [];
    const listener = (...args: ["rojo-exit-project", "rojo-exit"]) => calls.push(args);
    const remove = hub.subscribe(listener);
    hub.forward({ projectId: "rojo-exit-project", reason: "rojo-exit" });
    remove();
    remove();
    hub.forward({ projectId: "rojo-exit-project", reason: "rojo-exit" });
    expect(calls).toEqual([["rojo-exit-project", "rojo-exit"]]);
  });
});

class FakeBroker {
  stopCalls = 0;
  constructor(
    readonly port: number,
    private readonly onInvalidated: (reason: "broker-exit") => void,
    private readonly stopError?: Error,
  ) {}
  snapshot() {
    return { state: "stopped" as const, referenceCount: 0 };
  }
  async retain(): Promise<never> {
    throw new Error("not used");
  }
  async stop() {
    this.stopCalls += 1;
    if (this.stopError !== undefined) throw this.stopError;
  }
  invalidate() {
    this.onInvalidated("broker-exit");
  }
}

function windowHarness() {
  let options: Record<string, unknown> = {};
  const listeners = new Map<string, () => void>();
  class FakeBrowserWindow {
    readonly webContents = {
      on: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      session: {
        webRequest: {
          onHeadersReceived: vi.fn(),
        },
      },
      isDestroyed: () => false,
      send: vi.fn(),
    };
    constructor(value: Record<string, unknown>) {
      options = value;
    }
    loadFile() {
      return Promise.resolve();
    }
    loadURL() {
      return Promise.resolve();
    }
    on(name: string, listener: () => void) {
      listeners.set(name, listener);
      return this;
    }
    removeListener(name: string, listener: () => void) {
      if (listeners.get(name) === listener) listeners.delete(name);
      return this;
    }
    getBounds() {
      return { x: 0, y: 0, width: 1280, height: 800 };
    }
  }
  return {
    BrowserWindow: FakeBrowserWindow,
    permissionSession: {
      setPermissionRequestHandler: vi.fn(),
    },
    get options() {
      return options;
    },
  };
}
