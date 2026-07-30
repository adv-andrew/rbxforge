import { isAbsolute, join } from "node:path";

export interface DesktopPathApp {
  readonly isPackaged: boolean;
  getAppPath(): string;
  getPath(name: "userData"): string;
}

export interface DesktopPaths {
  readonly databasePath: string;
  readonly rendererFile: string;
  readonly preloadFile: string;
  readonly mcpEntryPath: string;
  readonly pluginSourcePath: string;
}

export function resolveDesktopPaths(options: {
  readonly app: DesktopPathApp;
  readonly resourcesPath: string;
}): DesktopPaths {
  const appPath = absolute(options.app.getAppPath(), "Electron application");
  const userData = absolute(options.app.getPath("userData"), "Electron user-data");
  const vendorRoot = options.app.isPackaged
    ? absolute(options.resourcesPath, "Electron resources")
    : join(appPath, "dist");
  return Object.freeze({
    databasePath: join(userData, "rbxforge.sqlite"),
    rendererFile: join(appPath, "dist", "renderer", "index.html"),
    preloadFile: join(appPath, "dist", "preload", "index.cjs"),
    mcpEntryPath: join(vendorRoot, "vendor", "robloxstudio-mcp", "index.mjs"),
    pluginSourcePath: join(vendorRoot, "vendor", "studio-plugin", "MCPPlugin.rbxmx"),
  });
}

function absolute(path: string, label: string): string {
  if (!isAbsolute(path)) throw new Error(`${label} path must be absolute.`);
  return path;
}
