import { describe, expect, it, vi } from "vitest";
import { buildContentSecurityPolicy, createMainWindow } from "./window.js";

describe("secure main window", () => {
  it("uses the exact hardened BrowserWindow preferences and production file", async () => {
    const harness = windowHarness();
    createMainWindow({
      BrowserWindow: harness.BrowserWindow,
      rendererFile: "/absolute/renderer/index.html",
      preloadFile: "/absolute/preload/index.cjs",
      permissionSession: harness.permissionSession,
    });
    expect(harness.options).toMatchObject({
      width: 1280,
      height: 800,
      minWidth: 960,
      minHeight: 640,
      titleBarStyle: "hiddenInset",
      webPreferences: {
        preload: "/absolute/preload/index.cjs",
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        webviewTag: false,
      },
    });
    expect(harness.options.show).not.toBe(false);
    expect(harness.loadedFiles).toEqual(["/absolute/renderer/index.html"]);
    expect(harness.loadedUrls).toEqual([]);
  });

  it("pins native traffic lights inside the reserved 84px by 60px titlebar clearance", () => {
    const harness = windowHarness();
    createMainWindow({
      BrowserWindow: harness.BrowserWindow,
      rendererFile: "/absolute/renderer/index.html",
      preloadFile: "/absolute/preload/index.cjs",
      permissionSession: harness.permissionSession,
    });
    expect(harness.windowButtonPositions).toEqual([{ x: 14, y: 14 }]);
  });

  it("constructs only the exact loopback development URL", () => {
    const harness = windowHarness();
    createMainWindow({
      BrowserWindow: harness.BrowserWindow,
      rendererFile: "/absolute/renderer/index.html",
      preloadFile: "/absolute/preload/index.cjs",
      developmentPort: 5173,
      permissionSession: harness.permissionSession,
    });
    expect(harness.loadedUrls).toEqual(["http://127.0.0.1:5173"]);
  });

  it("uses the correctly encoded exact file URL as the production navigation identity", () => {
    const harness = windowHarness();
    createMainWindow({
      BrowserWindow: harness.BrowserWindow,
      rendererFile: "/absolute/renderer with space/index.html",
      preloadFile: "/absolute/preload/index.cjs",
      permissionSession: harness.permissionSession,
    });
    const navigate = harness.listeners.get("will-navigate");
    const exact = { preventDefault: vi.fn() };
    navigate?.(exact, "file:///absolute/renderer%20with%20space/index.html");
    expect(exact.preventDefault).not.toHaveBeenCalled();
  });

  it("prevents every navigation except the exact initially loaded URL and denies every window open", () => {
    const harness = windowHarness();
    createMainWindow({
      BrowserWindow: harness.BrowserWindow,
      rendererFile: "/absolute/renderer/index.html",
      preloadFile: "/absolute/preload/index.cjs",
      developmentPort: 5173,
      permissionSession: harness.permissionSession,
    });
    const navigate = harness.listeners.get("will-navigate");
    const exact = { preventDefault: vi.fn() };
    navigate?.(exact, "http://127.0.0.1:5173");
    expect(exact.preventDefault).not.toHaveBeenCalled();
    for (const url of [
      "http://localhost:5173",
      "https://127.0.0.1:5173",
      "http://user@127.0.0.1:5173",
      "http://127.0.0.1:5174",
      "http://127.0.0.1:5173/other",
    ]) {
      const event = { preventDefault: vi.fn() };
      navigate?.(event, url);
      expect(event.preventDefault).toHaveBeenCalledOnce();
    }
    expect(harness.openHandler?.({ url: "https://example.com" })).toEqual({ action: "deny" });
  });

  it("denies every permission request and applies a remote-free CSP", () => {
    const harness = windowHarness();
    createMainWindow({
      BrowserWindow: harness.BrowserWindow,
      rendererFile: "/absolute/renderer/index.html",
      preloadFile: "/absolute/preload/index.cjs",
      permissionSession: harness.permissionSession,
    });
    const decision = vi.fn();
    harness.permissionHandler?.({}, "media", decision);
    expect(decision).toHaveBeenCalledWith(false);
    const production = buildContentSecurityPolicy();
    expect(production).not.toMatch(/\*|https?:\/\/(?!127\.0\.0\.1)|unsafe-inline|unsafe-eval/);
    expect(production).toContain("script-src 'self'");
    expect(production).toContain("img-src 'self' data:");
  });

  it("allows only the exact development HTTP/WebSocket origins plus nonce styles", () => {
    const csp = buildContentSecurityPolicy({ developmentPort: 5173, styleNonce: "nonce-value" });
    expect(csp).toContain("http://127.0.0.1:5173");
    expect(csp).toContain("ws://127.0.0.1:5173");
    expect(csp).toContain("'nonce-nonce-value'");
    expect(csp).not.toContain("localhost");
    expect(csp).not.toContain("*");
  });

  it("persists only finite host-observed bounds", () => {
    const harness = windowHarness();
    const bounds: unknown[] = [];
    createMainWindow({
      BrowserWindow: harness.BrowserWindow,
      rendererFile: "/absolute/renderer/index.html",
      preloadFile: "/absolute/preload/index.cjs",
      permissionSession: harness.permissionSession,
      persistBounds: (value) => bounds.push(value),
    });
    harness.windowListeners.get("resize")?.();
    expect(bounds).toEqual([{ x: 10, y: 20, width: 1200, height: 760 }]);
  });

  it("restores only finite persisted bounds at least 960x640", () => {
    const valid = windowHarness();
    createMainWindow({
      BrowserWindow: valid.BrowserWindow,
      rendererFile: "/absolute/renderer/index.html",
      preloadFile: "/absolute/preload/index.cjs",
      permissionSession: valid.permissionSession,
      initialBounds: { x: -200, y: 40, width: 1440, height: 900 },
    });
    expect(valid.options).toMatchObject({ x: -200, y: 40, width: 1440, height: 900 });

    for (const initialBounds of [
      { x: 0, y: 0, width: 959, height: 800 },
      { x: 0, y: 0, width: 1280, height: 639 },
      { x: Number.NaN, y: 0, width: 1280, height: 800 },
    ]) {
      const invalid = windowHarness();
      createMainWindow({
        BrowserWindow: invalid.BrowserWindow,
        rendererFile: "/absolute/renderer/index.html",
        preloadFile: "/absolute/preload/index.cjs",
        permissionSession: invalid.permissionSession,
        initialBounds,
      });
      expect(invalid.options).toMatchObject({ width: 1280, height: 800 });
      expect(invalid.options).not.toHaveProperty("x");
      expect(invalid.options).not.toHaveProperty("y");
    }
  });
});

function windowHarness() {
  let options: Record<string, unknown> = {};
  const loadedFiles: string[] = [];
  const loadedUrls: string[] = [];
  const listeners = new Map<string, (event: { preventDefault(): void }, url: string) => void>();
  const windowListeners = new Map<string, () => void>();
  const windowButtonPositions: Array<{ readonly x: number; readonly y: number } | null> = [];
  let openHandler: ((details: { url: string }) => { action: "deny" }) | undefined;
  let permissionHandler:
    ((contents: unknown, permission: string, callback: (allowed: boolean) => void) => void) | undefined;
  class FakeBrowserWindow {
    readonly webContents = {
      on: (name: string, listener: (event: { preventDefault(): void }, url: string) => void) =>
        listeners.set(name, listener),
      setWindowOpenHandler: (handler: (details: { url: string }) => { action: "deny" }) => {
        openHandler = handler;
      },
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
    loadFile(path: string) {
      loadedFiles.push(path);
      return Promise.resolve();
    }
    loadURL(url: string) {
      loadedUrls.push(url);
      return Promise.resolve();
    }
    on(name: string, listener: () => void) {
      windowListeners.set(name, listener);
      return this;
    }
    removeListener(name: string, listener: () => void) {
      if (windowListeners.get(name) === listener) windowListeners.delete(name);
      return this;
    }
    getBounds() {
      return { x: 10, y: 20, width: 1200, height: 760 };
    }
    setWindowButtonPosition(position: { readonly x: number; readonly y: number } | null) {
      windowButtonPositions.push(position);
    }
  }
  const permissionSession = {
    setPermissionRequestHandler: (handler: typeof permissionHandler) => {
      permissionHandler = handler;
    },
  };
  return {
    BrowserWindow: FakeBrowserWindow,
    permissionSession,
    get options() {
      return options;
    },
    loadedFiles,
    loadedUrls,
    listeners,
    windowListeners,
    windowButtonPositions,
    get openHandler() {
      return openHandler;
    },
    get permissionHandler() {
      return permissionHandler;
    },
  };
}
