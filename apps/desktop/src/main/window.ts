import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import type { BrowserWindowConstructorOptions, Rectangle } from "electron";
import type { WindowBounds } from "./storage/settings-repository.js";

interface NavigationEvent {
  preventDefault(): void;
}

interface WindowWebContents {
  on(name: "will-navigate", listener: (event: NavigationEvent, url: string) => void): void;
  on(name: "destroyed" | "did-finish-load" | "render-process-gone", listener: (...args: unknown[]) => void): void;
  removeListener(
    name: "destroyed" | "did-finish-load" | "render-process-gone",
    listener: (...args: unknown[]) => void,
  ): void;
  setWindowOpenHandler(handler: (details: { readonly url: string }) => { readonly action: "deny" }): void;
  readonly session: {
    readonly webRequest: {
      onHeadersReceived(
        listener: (
          details: { readonly responseHeaders?: Readonly<Record<string, readonly string[]>> },
          callback: (response: { readonly responseHeaders: Readonly<Record<string, readonly string[]>> }) => void,
        ) => void,
      ): void;
    };
  };
  isDestroyed(): boolean;
  send(channel: string, value: unknown): void;
}

export interface MainWindowLike {
  readonly webContents: WindowWebContents;
  loadFile(path: string): Promise<void>;
  loadURL(url: string): Promise<void>;
  on(name: "close", listener: (event: { preventDefault(): void }) => void): MainWindowLike;
  on(name: "move" | "resize" | "closed", listener: () => void): MainWindowLike;
  removeListener(name: "close", listener: (event: { preventDefault(): void }) => void): MainWindowLike;
  removeListener(name: "move" | "resize" | "closed", listener: () => void): MainWindowLike;
  close(): void;
  focus(): void;
  show(): void;
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  getBounds(): Rectangle;
  setWindowButtonPosition?(position: { readonly x: number; readonly y: number } | null): void;
}

export interface PermissionSession {
  setPermissionRequestHandler(
    handler: (webContents: unknown, permission: string, callback: (allowed: boolean) => void) => void,
  ): void;
}

export interface MainWindowOptions {
  readonly BrowserWindow: new (options: BrowserWindowConstructorOptions) => MainWindowLike;
  readonly rendererFile: string;
  readonly preloadFile: string;
  readonly developmentPort?: number;
  readonly styleNonce?: string;
  readonly permissionSession: PermissionSession;
  readonly initialBounds?: WindowBounds;
  readonly persistBounds?: (bounds: WindowBounds) => void;
}

export function createMainWindow(options: MainWindowOptions): MainWindowLike {
  assertAbsoluteFile(options.preloadFile, "Preload");
  assertAbsoluteFile(options.rendererFile, "Renderer");
  const developmentUrl =
    options.developmentPort === undefined
      ? undefined
      : `http://127.0.0.1:${validateDevelopmentPort(options.developmentPort)}`;
  const initialUrl = developmentUrl ?? pathToFileURL(options.rendererFile).href;
  const restoredBounds =
    options.initialBounds !== undefined && validBounds(options.initialBounds) ? options.initialBounds : undefined;
  const browserWindowOptions: BrowserWindowConstructorOptions = {
    width: restoredBounds?.width ?? 1280,
    height: restoredBounds?.height ?? 800,
    ...(restoredBounds === undefined ? {} : { x: restoredBounds.x, y: restoredBounds.y }),
    minWidth: 960,
    minHeight: 640,
    titleBarStyle: "hiddenInset",
    webPreferences: {
      preload: options.preloadFile,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
    },
  };
  const window = new options.BrowserWindow(browserWindowOptions);
  window.setWindowButtonPosition?.({ x: 14, y: 14 });
  window.webContents.on("will-navigate", (event, url) => {
    if (url !== initialUrl) event.preventDefault();
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  options.permissionSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));

  const csp = buildContentSecurityPolicy({
    ...(options.developmentPort === undefined ? {} : { developmentPort: options.developmentPort }),
    ...(options.styleNonce === undefined ? {} : { styleNonce: options.styleNonce }),
  });
  window.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...(details.responseHeaders ?? {}),
        "Content-Security-Policy": [csp],
      },
    });
  });

  if (options.persistBounds !== undefined) {
    const persist = (): void => {
      const bounds = window.getBounds();
      if (validBounds(bounds)) options.persistBounds?.(bounds);
    };
    window.on("move", persist);
    window.on("resize", persist);
  }
  if (developmentUrl === undefined) void window.loadFile(options.rendererFile);
  else void window.loadURL(developmentUrl);
  return window;
}

export function buildContentSecurityPolicy(
  options: {
    readonly developmentPort?: number;
    readonly styleNonce?: string;
  } = {},
): string {
  const origin =
    options.developmentPort === undefined
      ? undefined
      : `http://127.0.0.1:${validateDevelopmentPort(options.developmentPort)}`;
  const socket =
    options.developmentPort === undefined
      ? undefined
      : `ws://127.0.0.1:${validateDevelopmentPort(options.developmentPort)}`;
  const nonce = options.styleNonce === undefined ? undefined : `'nonce-${validateNonce(options.styleNonce)}'`;
  return [
    "default-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "form-action 'none'",
    "script-src 'self'",
    `style-src 'self'${nonce === undefined ? "" : ` ${nonce}`}`,
    "img-src 'self' data:",
    `connect-src 'self'${origin === undefined ? "" : ` ${origin} ${socket}`}`,
  ].join("; ");
}

function validateDevelopmentPort(port: number): number {
  if (!Number.isSafeInteger(port) || port < 1_024 || port > 65_535) {
    throw new Error("Development port is invalid.");
  }
  return port;
}

function validateNonce(nonce: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(nonce)) throw new Error("Style nonce is invalid.");
  return nonce;
}

function assertAbsoluteFile(path: string, label: string): void {
  if (!isAbsolute(path)) throw new Error(`${label} file path must be absolute.`);
}

function validBounds(bounds: Rectangle): bounds is WindowBounds {
  return (
    [bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) &&
    bounds.width >= 960 &&
    bounds.height >= 640
  );
}
