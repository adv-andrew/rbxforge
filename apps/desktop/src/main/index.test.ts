import { describe, expect, it, vi } from "vitest";
import { startDesktopHost } from "./index.js";

describe("Electron host lifecycle", () => {
  it("starts the post-ready lifecycle without acquiring a second single-instance lock", async () => {
    const harness = lifecycleHarness();
    await startDesktopHost(harness.options);
    expect(harness.sequence.slice(0, 4)).toEqual(["open-database", "migrate", "compose", "controller-initialize"]);
    expect(harness.sequence).not.toContain("single-instance-lock");
  });

  it("fails closed on migration and creates no IPC handler or window", async () => {
    const harness = lifecycleHarness({ migrationFailure: true });
    await expect(startDesktopHost(harness.options)).rejects.toThrow("migration");
    expect(harness.sequence).toEqual(["open-database", "migrate", "database-close"]);
  });

  it("disposes a partially initialized controller before closing SQLite", async () => {
    const harness = lifecycleHarness({ initializeFailure: true });
    await expect(startDesktopHost(harness.options)).rejects.toThrow("initialize");
    expect(harness.sequence).toEqual([
      "open-database",
      "migrate",
      "compose",
      "controller-initialize",
      "controller-dispose",
      "database-close",
    ]);
    expect(harness.sequence).not.toContain("ipc-register");
    expect(harness.sequence).not.toContain("window-create");
  });

  it("initializes before registering IPC and creating exactly one window", async () => {
    const harness = lifecycleHarness();
    await startDesktopHost(harness.options);
    expect(harness.sequence.slice(0, 5)).toEqual([
      "open-database",
      "migrate",
      "compose",
      "controller-initialize",
      "ipc-register",
    ]);
    expect(harness.sequence.filter((item) => item === "window-create")).toHaveLength(1);
  });

  it("invalidates all bindings on resume and removes the exact handler during quit", async () => {
    const harness = lifecycleHarness();
    await startDesktopHost(harness.options);
    harness.powerHandlers.get("resume")?.();
    expect(harness.sequence).toContain("invalidate-all:resume");
    await harness.fireBeforeQuit();
    expect(harness.powerHandlers.has("resume")).toBe(false);
  });

  it("never sends a snapshot event into destroyed web contents", async () => {
    const harness = lifecycleHarness();
    await startDesktopHost(harness.options);
    harness.destroyed = true;
    harness.snapshotListener?.(validSnapshot(1));
    expect(harness.sent).toEqual([]);
  });

  it("keeps the host live, recreates the sole window on activate, and restores/focuses it for a second instance", async () => {
    const harness = lifecycleHarness();
    await startDesktopHost(harness.options);
    harness.fireWindowClosed();
    expect(harness.sequence.filter((item) => item === "window-create")).toHaveLength(1);

    harness.fireAppEvent("activate");
    expect(harness.sequence.filter((item) => item === "window-create")).toHaveLength(2);
    harness.minimized = true;
    harness.fireAppEvent("second-instance");
    expect(harness.sequence.slice(-3)).toEqual(["window-restore", "window-show", "window-focus"]);
    expect(harness.sequence).not.toContain("controller-dispose");
    expect(harness.sequence).not.toContain("database-close");
  });

  it("closes only after a successful bounded renderer draft flush and refocuses after failure", async () => {
    const harness = lifecycleHarness();
    await startDesktopHost(harness.options);

    harness.closeBarrierResult = { kind: "save-failed" };
    harness.fireWindowClose();
    await harness.flushTasks();
    expect(harness.sequence).toContain("close-barrier-request");
    expect(harness.sequence).not.toContain("window-close");
    expect(harness.sequence.slice(-2)).toEqual(["window-show", "window-focus"]);

    harness.closeBarrierResult = { kind: "flushed" };
    harness.fireWindowClose();
    await harness.flushTasks();
    expect(harness.sequence.filter((item) => item === "window-close")).toHaveLength(1);
  });

  it("cancels normal quit after a failed draft flush, then retries and disposes exactly once", async () => {
    const harness = lifecycleHarness();
    await startDesktopHost(harness.options);

    harness.closeBarrierResult = { kind: "timeout" };
    await harness.fireBeforeQuit();
    await harness.flushTasks();
    expect(harness.sequence.slice(-2)).toEqual(["window-show", "window-focus"]);
    expect(harness.sequence).not.toContain("controller-dispose");
    expect(harness.sequence).not.toContain("database-close");
    expect(harness.sequence).not.toContain("app-quit");

    harness.closeBarrierResult = { kind: "flushed" };
    await harness.fireBeforeQuit();
    await harness.flushTasks();
    expect(harness.sequence.filter((item) => item === "controller-dispose")).toHaveLength(1);
    expect(harness.sequence.filter((item) => item === "database-close")).toHaveLength(1);
    expect(harness.sequence.filter((item) => item === "app-quit")).toHaveLength(1);
  });

  it("allows window close and normal quit when the renderer is unavailable", async () => {
    const windowClose = lifecycleHarness();
    await startDesktopHost(windowClose.options);
    windowClose.fireRenderProcessGone();
    windowClose.fireWindowClose();
    await windowClose.flushTasks();
    expect(windowClose.sequence.filter((item) => item === "window-close")).toHaveLength(1);
    expect(windowClose.sequence).not.toContain("window-focus");
    expect(windowClose.sequence).not.toContain("close-barrier-request");

    const normalQuit = lifecycleHarness();
    await startDesktopHost(normalQuit.options);
    normalQuit.destroyed = true;
    await normalQuit.fireBeforeQuit();
    await normalQuit.flushTasks();
    expect(normalQuit.sequence.filter((item) => item === "controller-dispose")).toHaveLength(1);
    expect(normalQuit.sequence.filter((item) => item === "database-close")).toHaveLength(1);
    expect(normalQuit.sequence.filter((item) => item === "app-quit")).toHaveLength(1);
    expect(normalQuit.sequence).not.toContain("window-focus");
    expect(normalQuit.sequence).not.toContain("close-barrier-request");
  });

  it("restores snapshot publication and the close barrier after the same live renderer finishes reloading", async () => {
    const harness = lifecycleHarness();
    await startDesktopHost(harness.options);

    harness.fireRenderProcessGone();
    harness.snapshotListener?.(validSnapshot(1));
    expect(harness.sent).toEqual([]);

    harness.fireDidFinishLoad();
    harness.snapshotListener?.(validSnapshot(2));
    expect(harness.sent).toEqual([
      [
        "rbxforge:event",
        expect.objectContaining({
          version: 1,
          type: "snapshot",
          snapshot: expect.objectContaining({ revision: 2 }),
        }),
      ],
    ]);

    harness.fireWindowClose();
    await harness.flushTasks();
    expect(harness.sequence).toContain("close-barrier-request");
    expect(harness.sequence.filter((item) => item === "window-close")).toHaveLength(1);
  });

  it.each(["web-contents", "browser-window"] as const)(
    "does not accept did-finish-load as renderer recovery while the %s is destroyed",
    async (destroyedTarget) => {
      const harness = lifecycleHarness();
      await startDesktopHost(harness.options);

      harness.fireRenderProcessGone();
      if (destroyedTarget === "web-contents") harness.destroyed = true;
      else harness.setCurrentWindowDestroyed(true);
      harness.fireDidFinishLoad();
      if (destroyedTarget === "web-contents") harness.destroyed = false;
      else harness.setCurrentWindowDestroyed(false);

      harness.snapshotListener?.(validSnapshot(1));
      expect(harness.sent).toEqual([]);
      harness.fireWindowClose();
      await harness.flushTasks();
      expect(harness.sequence).not.toContain("close-barrier-request");
      expect(harness.sequence.filter((item) => item === "window-close")).toHaveLength(1);
    },
  );

  it("keeps a healthy renderer fail-closed when the close barrier unexpectedly rejects", async () => {
    const windowClose = lifecycleHarness({ closeBarrierRejection: true });
    await startDesktopHost(windowClose.options);
    windowClose.fireWindowClose();
    await windowClose.flushTasks();
    expect(windowClose.sequence).not.toContain("window-close");
    expect(windowClose.sequence.slice(-2)).toEqual(["window-show", "window-focus"]);

    const normalQuit = lifecycleHarness({ closeBarrierRejection: true });
    await startDesktopHost(normalQuit.options);
    await normalQuit.fireBeforeQuit();
    await normalQuit.flushTasks();
    expect(normalQuit.sequence.slice(-2)).toEqual(["window-show", "window-focus"]);
    expect(normalQuit.sequence).not.toContain("controller-dispose");
    expect(normalQuit.sequence).not.toContain("database-close");
    expect(normalQuit.sequence).not.toContain("app-quit");
  });

  it.each(["activate", "second-instance"] as const)(
    "replaces a destroyed BrowserWindow on %s without calling methods on the stale window",
    async (eventName) => {
      const harness = lifecycleHarness();
      await startDesktopHost(harness.options);
      harness.destroyCurrentWindow();

      harness.fireAppEvent(eventName);

      expect(harness.sequence.filter((item) => item === "window-create")).toHaveLength(2);
      expect(harness.sequence.filter((item) => item.startsWith("destroyed-window-call:"))).toEqual([]);
      expect(harness.sequence.slice(-2)).toEqual(["window-show", "window-focus"]);
    },
  );

  it("stops accepting IPC, disposes once, closes SQLite in finally, and reenters quit without recursion", async () => {
    const harness = lifecycleHarness({ disposeFailure: true });
    await startDesktopHost(harness.options);
    expect(harness.activeWebContentsEvents()).toEqual(["did-finish-load", "render-process-gone"]);
    await harness.fireBeforeQuit();
    expect(harness.sequence.slice(-15)).toEqual([
      "prevent-default",
      "close-barrier-request",
      "ipc-remove",
      "close-barrier-dispose",
      "snapshot-unsubscribe",
      "power-remove",
      "activate-remove",
      "second-instance-remove",
      "window-all-closed-remove",
      "window-remove",
      "window-remove",
      "before-quit-remove",
      "controller-dispose",
      "database-close",
      "app-quit",
    ]);
    await harness.fireBeforeQuit();
    expect(harness.sequence.filter((item) => item === "controller-dispose")).toHaveLength(1);
    expect(harness.sequence.filter((item) => item === "database-close")).toHaveLength(1);
    expect(harness.activeWebContentsEvents()).toEqual([]);
  });

  it("propagates controller cleanup failure from direct host disposal after closing SQLite", async () => {
    const harness = lifecycleHarness({ disposeFailure: true });
    const host = await startDesktopHost(harness.options);

    await expect(host.dispose()).rejects.toThrow("dispose failed /private");
    await expect(host.dispose()).rejects.toThrow("dispose failed /private");
    expect(harness.sequence.filter((item) => item === "controller-dispose")).toHaveLength(1);
    expect(harness.sequence.filter((item) => item === "database-close")).toHaveLength(1);
  });

  it.each([
    ["ipc-remove", "window-create", ["controller-dispose", "database-close"]],
    ["controller-dispose", "window-create", ["database-close"]],
    ["snapshot-unsubscribe", "power-on", ["controller-dispose", "database-close"]],
    ["power-remove", "before-quit-on", ["window-remove", "controller-dispose", "database-close"]],
    ["window-remove", "before-quit-on", ["controller-dispose", "database-close"]],
  ] as const)(
    "continues startup-failure cleanup after synchronous %s failure",
    async (cleanupFailure, startupFailureAt, later) => {
      const harness = lifecycleHarness({ cleanupFailure, startupFailureAt });

      await expect(startDesktopHost(harness.options)).rejects.toBeDefined();

      for (const stage of later) expect(harness.sequence).toContain(stage);
      expect(harness.sequence.filter((item) => item === "database-close")).toHaveLength(1);
    },
  );

  it.each([
    "ipc-remove",
    "snapshot-unsubscribe",
    "power-remove",
    "window-remove",
    "before-quit-remove",
    "controller-dispose",
  ] as const)("continues normal shutdown after synchronous %s failure", async (cleanupFailure) => {
    const harness = lifecycleHarness({ cleanupFailure });
    await startDesktopHost(harness.options);

    await harness.fireBeforeQuit();
    await harness.fireBeforeQuit();

    expect(harness.sequence).toEqual(
      expect.arrayContaining([
        "ipc-remove",
        "snapshot-unsubscribe",
        "power-remove",
        "window-remove",
        "before-quit-remove",
        "controller-dispose",
        "database-close",
        "app-quit",
      ]),
    );
    expect(harness.sequence.filter((item) => item === "controller-dispose")).toHaveLength(1);
    expect(harness.sequence.filter((item) => item === "database-close")).toHaveLength(1);
    expect(harness.sequence.filter((item) => item === "app-quit")).toHaveLength(1);
  });

  it.each([
    ["successful", undefined],
    ["rejected", "controller-dispose"],
  ] as const)("preserves the app receiver when cleanup settlement is %s", async (_label, cleanupFailure) => {
    const harness = lifecycleHarness({
      receiverSensitiveQuit: true,
      ...(cleanupFailure === undefined ? {} : { cleanupFailure }),
    });
    await startDesktopHost(harness.options);

    await harness.fireBeforeQuit();

    expect(harness.sequence).not.toContain("app-quit-wrong-receiver");
    expect(harness.sequence.filter((item) => item === "app-quit")).toHaveLength(1);
    expect(harness.sequence.filter((item) => item === "database-close")).toHaveLength(1);
  });
});

interface LifecycleOptions {
  readonly migrationFailure?: boolean;
  readonly disposeFailure?: boolean;
  readonly initializeFailure?: boolean;
  readonly closeBarrierRejection?: boolean;
  readonly cleanupFailure?:
    | "ipc-remove"
    | "snapshot-unsubscribe"
    | "power-remove"
    | "window-remove"
    | "before-quit-remove"
    | "controller-dispose";
  readonly startupFailureAt?: "window-create" | "power-on" | "before-quit-on";
  readonly receiverSensitiveQuit?: boolean;
}

function lifecycleHarness(options: LifecycleOptions = {}) {
  const sequence: string[] = [];
  const appHandlers = new Map<string, (event: { preventDefault(): void }) => void>();
  const powerHandlers = new Map<string, () => void>();
  const sent: unknown[][] = [];
  let destroyed = false;
  let snapshotListener: ((snapshot: ReturnType<typeof validSnapshot>) => void) | undefined;
  let quitting = false;
  let minimized = false;
  let closeBarrierResult:
    | { readonly kind: "flushed" }
    | { readonly kind: "save-failed" }
    | { readonly kind: "timeout" }
    | { readonly kind: "unavailable" } = { kind: "flushed" };
  const windowHandlers: Array<Map<string, (event?: { preventDefault(): void }) => void>> = [];
  const windowDestroyed: Array<{ value: boolean }> = [];
  const webContentsHandlers: Array<Map<string, (...args: unknown[]) => void>> = [];
  const failCleanup = (stage: LifecycleOptions["cleanupFailure"]): void => {
    if (options.cleanupFailure === stage) throw new Error(`synchronous ${stage} failure`);
  };
  const database = {
    close: () => sequence.push("database-close"),
  };
  const controller = {
    initialize: async () => {
      sequence.push("controller-initialize");
      if (options.initializeFailure) throw new Error("initialize failed");
      return validSnapshot(0);
    },
    execute: vi.fn(),
    subscribe: (listener: typeof snapshotListener) => {
      snapshotListener = listener;
      return () => {
        sequence.push("snapshot-unsubscribe");
        failCleanup("snapshot-unsubscribe");
      };
    },
    dispose: () => {
      sequence.push("controller-dispose");
      failCleanup("controller-dispose");
      if (options.disposeFailure) throw new Error("dispose failed /private");
      return Promise.resolve();
    },
  };
  const appPort = {
    quit(this: unknown) {
      if (options.receiverSensitiveQuit && this !== appPort) {
        sequence.push("app-quit-wrong-receiver");
        throw new Error("app.quit receiver was lost");
      }
      sequence.push("app-quit");
      if (quitting) sequence.push("before-quit-reentry");
    },
    on: (name: string, listener: (event: { preventDefault(): void }) => void) => {
      sequence.push(`${name}-on`);
      appHandlers.set(name, listener);
      if (name === "before-quit" && options.startupFailureAt === "before-quit-on") {
        throw new Error("before quit registration failed");
      }
    },
    removeListener: (name: string, listener: (event: { preventDefault(): void }) => void) => {
      sequence.push(`${name}-remove`);
      failCleanup("before-quit-remove");
      if (appHandlers.get(name) === listener) appHandlers.delete(name);
    },
  };
  const hostOptions = {
    app: appPort,
    powerMonitor: {
      on: (name: string, listener: () => void) => {
        sequence.push(`${name}-on`);
        if (options.startupFailureAt === "power-on") throw new Error("power registration failed");
        powerHandlers.set(name, listener);
      },
      removeListener: (name: string, listener: () => void) => {
        sequence.push("power-remove");
        failCleanup("power-remove");
        if (powerHandlers.get(name) === listener) powerHandlers.delete(name);
      },
    },
    openDatabase: () => {
      sequence.push("open-database");
      return database;
    },
    migrate: () => {
      sequence.push("migrate");
      if (options.migrationFailure) throw new Error("migration failed");
    },
    compose: () => {
      sequence.push("compose");
      return {
        controller,
        registerIpc: () => {
          sequence.push("ipc-register");
          return () => {
            sequence.push("ipc-remove");
            failCleanup("ipc-remove");
          };
        },
        createWindow: () => {
          sequence.push("window-create");
          if (options.startupFailureAt === "window-create") throw new Error("window creation failed");
          const handlers = new Map<string, (event?: { preventDefault(): void }) => void>();
          const contentsHandlers = new Map<string, (...args: unknown[]) => void>();
          const destroyedWindow = { value: false };
          windowHandlers.push(handlers);
          webContentsHandlers.push(contentsHandlers);
          windowDestroyed.push(destroyedWindow);
          const windowCall = (name: string, run?: () => void): void => {
            if (destroyedWindow.value) {
              sequence.push(`destroyed-window-call:${name}`);
              return;
            }
            run?.();
            sequence.push(`window-${name}`);
          };
          return {
            webContents: {
              isDestroyed: () => destroyed,
              send: (channel: string, event: unknown) => sent.push([channel, event]),
              on: (name: string, listener: (...args: unknown[]) => void) => {
                contentsHandlers.set(name, listener);
              },
              removeListener: (name: string, listener: (...args: unknown[]) => void) => {
                if (contentsHandlers.get(name) === listener) contentsHandlers.delete(name);
              },
            },
            on: (name: string, listener: (event?: { preventDefault(): void }) => void) => {
              sequence.push("window-on");
              handlers.set(name, listener);
            },
            removeListener: (name: string, listener: (event?: { preventDefault(): void }) => void) => {
              sequence.push("window-remove");
              failCleanup("window-remove");
              if (handlers.get(name) === listener) handlers.delete(name);
            },
            close: () => {
              if (destroyedWindow.value) {
                sequence.push("destroyed-window-call:close");
                return;
              }
              sequence.push("window-close");
              handlers.get("closed")?.();
            },
            isDestroyed: () => destroyedWindow.value,
            isMinimized: () => minimized,
            restore: () => {
              windowCall("restore", () => {
                minimized = false;
              });
            },
            show: () => windowCall("show"),
            focus: () => windowCall("focus"),
          };
        },
        registerCloseBarrier: () => ({
          request: async () => {
            sequence.push("close-barrier-request");
            if (options.closeBarrierRejection) throw new Error("close barrier rejected");
            return closeBarrierResult;
          },
          dispose: () => sequence.push("close-barrier-dispose"),
        }),
        bindingCoordinator: {
          invalidateAll: (reason: string) => sequence.push(`invalidate-all:${reason}`),
        },
      };
    },
    databasePath: "/absolute/user-data/rbxforge.sqlite",
    rendererFile: "/absolute/renderer/index.html",
    preloadFile: "/absolute/preload/index.cjs",
    mcpEntryPath: "/absolute/vendor/mcp.js",
    pluginSourcePath: "/absolute/vendor/MCPPlugin.rbxmx",
  };
  return {
    options: hostOptions,
    sequence,
    powerHandlers,
    sent,
    get destroyed() {
      return destroyed;
    },
    set destroyed(value: boolean) {
      destroyed = value;
    },
    get snapshotListener() {
      return snapshotListener;
    },
    get minimized() {
      return minimized;
    },
    set minimized(value: boolean) {
      minimized = value;
    },
    get closeBarrierResult() {
      return closeBarrierResult;
    },
    set closeBarrierResult(
      value:
        | { readonly kind: "flushed" }
        | { readonly kind: "save-failed" }
        | { readonly kind: "timeout" }
        | { readonly kind: "unavailable" },
    ) {
      closeBarrierResult = value;
    },
    fireAppEvent(name: "activate" | "second-instance") {
      appHandlers.get(name)?.({ preventDefault: () => undefined });
    },
    fireWindowClose() {
      windowHandlers.at(-1)?.get("close")?.({ preventDefault: () => sequence.push("prevent-window-close") });
    },
    fireWindowClosed() {
      windowHandlers.at(-1)?.get("closed")?.();
    },
    destroyCurrentWindow() {
      const current = windowDestroyed.at(-1);
      if (current !== undefined) current.value = true;
    },
    setCurrentWindowDestroyed(value: boolean) {
      const current = windowDestroyed.at(-1);
      if (current !== undefined) current.value = value;
    },
    fireRenderProcessGone() {
      webContentsHandlers.at(-1)?.get("render-process-gone")?.();
    },
    fireDidFinishLoad() {
      webContentsHandlers.at(-1)?.get("did-finish-load")?.();
    },
    activeWebContentsEvents() {
      return [...(webContentsHandlers.at(-1)?.keys() ?? [])].sort();
    },
    async flushTasks() {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    async fireBeforeQuit() {
      const handler = appHandlers.get("before-quit");
      if (handler === undefined) return;
      let prevented = false;
      const previousLength = sequence.length;
      handler({
        preventDefault: () => {
          prevented = true;
          sequence.push("prevent-default");
        },
      });
      if (!prevented) return;
      for (let attempt = 0; attempt < 50 && sequence.length === previousLength + 1; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      quitting = true;
      await new Promise((resolve) => setTimeout(resolve, 0));
      quitting = false;
    },
  };
}

function validSnapshot(revision: number) {
  return {
    revision,
    projects: [],
    threads: [],
    messages: [],
    drafts: [],
    selectedThreadIdByProject: {},
    runtimeByProject: {},
    settings: { preferredMcpPort: 58741, sidebarWidth: 272, mcpPortChangeAllowed: true },
  };
}
