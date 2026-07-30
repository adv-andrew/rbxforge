import type { DesktopDatabase } from "./database.js";
import { StorageError } from "./database.js";

export interface WindowBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const ROJO_PATH_KEY = "rojo_path";
const MCP_PORT_KEY = "mcp_port";
const SIDEBAR_WIDTH_KEY = "sidebar_width";
const WINDOW_BOUNDS_KEY = "window_bounds";

export class SettingsRepository {
  constructor(private readonly database: DesktopDatabase) {}

  getRojoPath(): string | undefined {
    return this.get(ROJO_PATH_KEY);
  }

  setRojoPath(path: string): void {
    this.set(ROJO_PATH_KEY, path);
  }

  getMcpPort(): number | undefined {
    return this.getInteger(MCP_PORT_KEY);
  }

  setMcpPort(port: number): void {
    this.setInteger(MCP_PORT_KEY, port);
  }

  getSidebarWidth(): number | undefined {
    return this.getInteger(SIDEBAR_WIDTH_KEY);
  }

  setSidebarWidth(width: number): void {
    this.setInteger(SIDEBAR_WIDTH_KEY, width);
  }

  getWindowBounds(): WindowBounds | undefined {
    const value = this.get(WINDOW_BOUNDS_KEY);
    if (value === undefined) return undefined;
    try {
      const bounds: unknown = JSON.parse(value);
      if (
        typeof bounds !== "object" ||
        bounds === null ||
        !["x", "y", "width", "height"].every(
          (key) =>
            typeof (bounds as Record<string, unknown>)[key] === "number" &&
            Number.isFinite((bounds as Record<string, number>)[key]),
        )
      ) {
        throw new Error("invalid window bounds");
      }
      const record = bounds as WindowBounds;
      return { x: record.x, y: record.y, width: record.width, height: record.height };
    } catch {
      throw new StorageError("invalid-window-bounds", "Stored window bounds are invalid.");
    }
  }

  setWindowBounds(bounds: WindowBounds): void {
    this.set(WINDOW_BOUNDS_KEY, JSON.stringify(bounds));
  }

  private get(key: string): string | undefined {
    const row = this.database.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
      { readonly value: string } | undefined;
    return row?.value;
  }

  private set(key: string, value: string): void {
    this.database
      .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }

  private getInteger(key: string): number | undefined {
    const value = this.get(key);
    if (value === undefined) return undefined;
    const number = Number(value);
    if (!Number.isSafeInteger(number)) throw new StorageError("invalid-setting", `Stored ${key} is invalid.`);
    return number;
  }

  private setInteger(key: string, value: number): void {
    if (!Number.isSafeInteger(value)) throw new StorageError("invalid-setting", `${key} must be a safe integer.`);
    this.set(key, String(value));
  }
}
