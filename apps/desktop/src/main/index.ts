import { isAbsolute } from "node:path";
import type { DesktopSnapshot } from "../shared/domain.js";
import { desktopEventSchema } from "../shared/protocol.js";
import { EVENT_CHANNEL, type DesktopCloseBarrier, type DesktopCloseBarrierOutcome } from "./ipc.js";

interface AppPort {
  quit(): void;
  on(name: "before-quit", listener: (event: { preventDefault(): void }) => void): void;
  on(name: "activate" | "second-instance" | "window-all-closed", listener: () => void): void;
  removeListener(name: "before-quit", listener: (event: { preventDefault(): void }) => void): void;
  removeListener(name: "activate" | "second-instance" | "window-all-closed", listener: () => void): void;
}

interface PowerMonitorPort {
  on(name: "resume", listener: () => void): void;
  removeListener(name: "resume", listener: () => void): void;
}

interface DatabasePort {
  close(): void;
}

interface HostController {
  initialize(): Promise<DesktopSnapshot>;
  execute(command: never): Promise<unknown>;
  subscribe(listener: (snapshot: DesktopSnapshot) => void): () => void;
  dispose(): Promise<void>;
}

interface HostWindow {
  readonly webContents: {
    isDestroyed(): boolean;
    send(channel: string, value: unknown): void;
    on(name: "destroyed" | "did-finish-load" | "render-process-gone", listener: (...args: unknown[]) => void): unknown;
    removeListener(
      name: "destroyed" | "did-finish-load" | "render-process-gone",
      listener: (...args: unknown[]) => void,
    ): unknown;
  };
  on(name: "close", listener: (event: { preventDefault(): void }) => void): unknown;
  on(name: "closed", listener: () => void): unknown;
  removeListener?(name: "close", listener: (event: { preventDefault(): void }) => void): unknown;
  removeListener?(name: "closed", listener: () => void): unknown;
  close(): void;
  focus(): void;
  show(): void;
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
}

export interface DesktopComposition {
  readonly controller: HostController;
  readonly registerIpc: () => () => void;
  readonly registerCloseBarrier: () => DesktopCloseBarrier;
  readonly createWindow: (paths: {
    readonly rendererFile: string;
    readonly preloadFile: string;
    readonly mcpEntryPath: string;
    readonly pluginSourcePath: string;
  }) => HostWindow;
  readonly bindingCoordinator: {
    invalidateAll(reason: string): void;
  };
}

export interface DesktopHostOptions<TDatabase extends DatabasePort = DatabasePort> {
  readonly app: AppPort;
  readonly powerMonitor: PowerMonitorPort;
  readonly openDatabase: (path: string) => TDatabase;
  readonly migrate: (database: TDatabase) => void;
  readonly compose: (database: TDatabase) => DesktopComposition;
  readonly databasePath: string;
  readonly rendererFile: string;
  readonly preloadFile: string;
  readonly mcpEntryPath: string;
  readonly pluginSourcePath: string;
}

export interface DesktopHost {
  readonly controller: HostController;
  readonly window: HostWindow | undefined;
  dispose(): Promise<void>;
}

/**
 * Starts the Electron-owned lifecycle after absolute packaged/development paths
 * have been composed by the caller. The production launcher owns choosing
 * those absolute paths before this post-ready host starts.
 */
export async function startDesktopHost<TDatabase extends DatabasePort>(
  options: DesktopHostOptions<TDatabase>,
): Promise<DesktopHost> {
  validateCompositionPaths(options);

  const database = options.openDatabase(options.databasePath);
  let databaseClosed = false;
  const closeDatabase = (): void => {
    if (databaseClosed) return;
    databaseClosed = true;
    database.close();
  };
  let controller: HostController | undefined;
  let composition: DesktopComposition | undefined;
  let window: HostWindow | undefined;
  let removeIpc: (() => unknown) | undefined;
  let closeBarrier: DesktopCloseBarrier | undefined;
  let removeSnapshotSubscription: (() => unknown) | undefined;
  let resumeRegistered = false;
  let activateRegistered = false;
  let secondInstanceRegistered = false;
  let windowAllClosedRegistered = false;
  let beforeQuitRegistered = false;
  let acceptingEvents = true;
  let shuttingDown = false;
  let quitAttempt: Promise<void> | undefined;
  let disposal: Promise<void> | undefined;
  const closeAllowed = new WeakSet<HostWindow>();
  const rendererUnavailable = new WeakSet<HostWindow>();
  const pendingFlushes = new WeakMap<HostWindow, Promise<DesktopCloseBarrierOutcome>>();
  const windowListeners = new WeakMap<
    HostWindow,
    {
      readonly close: (event: { preventDefault(): void }) => void;
      readonly closed: () => void;
      readonly didFinishLoad: (...args: unknown[]) => void;
      readonly renderProcessGone: (...args: unknown[]) => void;
    }
  >();
  const paths = {
    rendererFile: options.rendererFile,
    preloadFile: options.preloadFile,
    mcpEntryPath: options.mcpEntryPath,
    pluginSourcePath: options.pluginSourcePath,
  };

  const isWindowDestroyed = (target: HostWindow): boolean => {
    try {
      return target.isDestroyed();
    } catch {
      return true;
    }
  };
  const isWebContentsDestroyed = (target: HostWindow): boolean => {
    try {
      return target.webContents.isDestroyed();
    } catch {
      return true;
    }
  };
  const isRendererUnavailable = (target: HostWindow): boolean => {
    return isWindowDestroyed(target) || rendererUnavailable.has(target) || isWebContentsDestroyed(target);
  };
  const publish = (snapshot: DesktopSnapshot): void => {
    const target = window;
    if (!acceptingEvents || target === undefined || isRendererUnavailable(target)) return;
    const event = desktopEventSchema.parse({ version: 1, type: "snapshot", snapshot });
    try {
      target.webContents.send(EVENT_CHANNEL, event);
    } catch {
      rendererUnavailable.add(target);
    }
  };
  const onResume = (): void => {
    if (!shuttingDown) composition?.bindingCoordinator.invalidateAll("resume");
  };
  const focusWindow = (target: HostWindow): boolean => {
    if (isRendererUnavailable(target)) return false;
    try {
      if (target.isMinimized()) {
        if (isWindowDestroyed(target)) return false;
        target.restore();
      }
      if (isWindowDestroyed(target)) return false;
      target.show();
      if (isWindowDestroyed(target)) return false;
      target.focus();
      return true;
    } catch {
      if (isRendererUnavailable(target)) rendererUnavailable.add(target);
      return false;
    }
  };
  const requestDraftFlush = (target: HostWindow): Promise<DesktopCloseBarrierOutcome> => {
    if (isRendererUnavailable(target)) return Promise.resolve({ kind: "unavailable" });
    const retained = pendingFlushes.get(target);
    if (retained !== undefined) return retained;
    const pending = Promise.resolve()
      .then(() => closeBarrier?.request(target.webContents) ?? { kind: "save-failed" as const })
      .catch(() =>
        isRendererUnavailable(target) ? ({ kind: "unavailable" } as const) : ({ kind: "save-failed" } as const),
      );
    pendingFlushes.set(target, pending);
    void pending.then(() => pendingFlushes.delete(target));
    return pending;
  };
  const requestWindowClose = (target: HostWindow): void => {
    void requestDraftFlush(target).then((outcome) => {
      if (window !== target || shuttingDown) return;
      if ((outcome.kind === "save-failed" || outcome.kind === "timeout") && !isRendererUnavailable(target)) {
        focusWindow(target);
        return;
      }
      if (isWindowDestroyed(target)) {
        if (window === target) window = undefined;
        return;
      }
      closeAllowed.add(target);
      target.close();
    });
  };
  const createAndBindWindow = (): HostWindow => {
    if (composition === undefined) throw new Error("Desktop composition is unavailable.");
    const created = composition.createWindow(paths);
    const closed = (): void => {
      rendererUnavailable.add(created);
      if (window === created) window = undefined;
    };
    const renderProcessGone = (): void => {
      rendererUnavailable.add(created);
    };
    const didFinishLoad = (): void => {
      if (!isWindowDestroyed(created) && !isWebContentsDestroyed(created)) {
        rendererUnavailable.delete(created);
      }
    };
    const close = (event: { preventDefault(): void }): void => {
      if (closeAllowed.has(created) || shuttingDown) return;
      event.preventDefault();
      requestWindowClose(created);
    };
    windowListeners.set(created, { close, closed, didFinishLoad, renderProcessGone });
    created.on("close", close);
    created.on("closed", closed);
    created.webContents.on("did-finish-load", didFinishLoad);
    created.webContents.on("render-process-gone", renderProcessGone);
    window = created;
    return created;
  };
  const recoverOrFocusWindow = (): void => {
    if (shuttingDown) return;
    try {
      let current = window;
      if (current !== undefined && isRendererUnavailable(current)) {
        if (!isWindowDestroyed(current)) {
          closeAllowed.add(current);
          current.close();
        }
        if (window === current) window = undefined;
        current = undefined;
      }
      current ??= createAndBindWindow();
      if (!focusWindow(current)) {
        if (!isWindowDestroyed(current)) {
          closeAllowed.add(current);
          current.close();
        }
        if (window === current) window = undefined;
        focusWindow(createAndBindWindow());
      }
    } catch {
      shuttingDown = true;
      void dispose().then(
        () => options.app.quit(),
        () => options.app.quit(),
      );
    }
  };
  const onActivate = (): void => recoverOrFocusWindow();
  const onSecondInstance = (): void => recoverOrFocusWindow();
  const onWindowAllClosed = (): void => {
    // macOS keeps the host available for Dock activation.
  };
  const onBeforeQuit = (event: { preventDefault(): void }): void => {
    if (shuttingDown) return;
    event.preventDefault();
    if (quitAttempt !== undefined) return;
    quitAttempt = (async () => {
      const current = window;
      if (current !== undefined) {
        const outcome = await requestDraftFlush(current);
        if ((outcome.kind === "save-failed" || outcome.kind === "timeout") && !isRendererUnavailable(current)) {
          focusWindow(current);
          return;
        }
      }
      shuttingDown = true;
      await dispose().catch(() => undefined);
      options.app.quit();
    })().finally(() => {
      if (!shuttingDown) quitAttempt = undefined;
    });
  };
  const dispose = (): Promise<void> => {
    if (disposal !== undefined) return disposal;
    disposal = (async () => {
      acceptingEvents = false;
      const failures: unknown[] = [];
      try {
        failures.push(
          ...(await settleHostCleanup([
            ...(removeIpc === undefined ? [] : [removeIpc]),
            ...(closeBarrier === undefined ? [] : [() => closeBarrier?.dispose()]),
            ...(removeSnapshotSubscription === undefined ? [] : [removeSnapshotSubscription]),
            ...(resumeRegistered ? [() => options.powerMonitor.removeListener("resume", onResume)] : []),
            ...(activateRegistered ? [() => options.app.removeListener("activate", onActivate)] : []),
            ...(secondInstanceRegistered
              ? [() => options.app.removeListener("second-instance", onSecondInstance)]
              : []),
            ...(windowAllClosedRegistered
              ? [() => options.app.removeListener("window-all-closed", onWindowAllClosed)]
              : []),
            ...(window === undefined || window.removeListener === undefined
              ? []
              : [
                  () => {
                    const listeners = window === undefined ? undefined : windowListeners.get(window);
                    if (listeners === undefined || window === undefined) return;
                    window.removeListener?.("close", listeners.close);
                    window.removeListener?.("closed", listeners.closed);
                    window.webContents.removeListener("did-finish-load", listeners.didFinishLoad);
                    window.webContents.removeListener("render-process-gone", listeners.renderProcessGone);
                  },
                ]),
            ...(beforeQuitRegistered ? [() => options.app.removeListener("before-quit", onBeforeQuit)] : []),
          ])),
        );
        if (controller !== undefined) {
          failures.push(...(await settleHostCleanup([() => controller?.dispose()])));
        }
      } finally {
        failures.push(...(await settleHostCleanup([closeDatabase])));
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, "Desktop host cleanup failed.");
    })();
    return disposal;
  };

  try {
    options.migrate(database);
    composition = options.compose(database);
    controller = composition.controller;
    await controller.initialize();
    removeIpc = composition.registerIpc();
    closeBarrier = composition.registerCloseBarrier();
    removeSnapshotSubscription = onceCleanup(controller.subscribe(publish));
    resumeRegistered = true;
    options.powerMonitor.on("resume", onResume);
    activateRegistered = true;
    options.app.on("activate", onActivate);
    secondInstanceRegistered = true;
    options.app.on("second-instance", onSecondInstance);
    windowAllClosedRegistered = true;
    options.app.on("window-all-closed", onWindowAllClosed);
    createAndBindWindow();
    beforeQuitRegistered = true;
    options.app.on("before-quit", onBeforeQuit);
  } catch (error) {
    let cleanupError: unknown;
    try {
      await dispose();
    } catch (caught) {
      cleanupError = caught;
    }
    if (cleanupError !== undefined) {
      throw new AggregateError([error, cleanupError], "Desktop host startup and cleanup failed.");
    }
    throw error;
  }
  return Object.freeze({
    controller,
    get window() {
      return window;
    },
    dispose,
  });
}

function onceCleanup(run: () => unknown): () => unknown {
  let called = false;
  return () => {
    if (called) return;
    called = true;
    return run();
  };
}

async function settleHostCleanup(work: readonly (() => unknown | Promise<unknown>)[]): Promise<readonly unknown[]> {
  const results = await Promise.allSettled(work.map((run) => Promise.resolve().then(run)));
  return results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
}

function validateCompositionPaths(options: {
  readonly databasePath: string;
  readonly rendererFile: string;
  readonly preloadFile: string;
  readonly mcpEntryPath: string;
  readonly pluginSourcePath: string;
}): void {
  for (const [label, path] of [
    ["Database", options.databasePath],
    ["Renderer", options.rendererFile],
    ["Preload", options.preloadFile],
    ["Studio MCP", options.mcpEntryPath],
    ["Studio plugin", options.pluginSourcePath],
  ] as const) {
    if (!isAbsolute(path)) throw new Error(`${label} composition path must be absolute.`);
  }
}
