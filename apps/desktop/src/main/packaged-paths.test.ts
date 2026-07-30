import { describe, expect, it } from "vitest";
import { resolveDesktopPaths } from "./packaged-paths.js";

describe("desktop packaged paths", () => {
  it("keeps executable application code in app.asar and vendor data in Resources", () => {
    expect(
      resolveDesktopPaths({
        app: {
          isPackaged: true,
          getAppPath: () => "/Applications/RbxForge.app/Contents/Resources/app.asar",
          getPath: (name) => {
            expect(name).toBe("userData");
            return "/Users/andy/Library/Application Support/RbxForge";
          },
        },
        resourcesPath: "/Applications/RbxForge.app/Contents/Resources",
      }),
    ).toEqual({
      databasePath: "/Users/andy/Library/Application Support/RbxForge/rbxforge.sqlite",
      rendererFile: "/Applications/RbxForge.app/Contents/Resources/app.asar/dist/renderer/index.html",
      preloadFile: "/Applications/RbxForge.app/Contents/Resources/app.asar/dist/preload/index.cjs",
      mcpEntryPath: "/Applications/RbxForge.app/Contents/Resources/vendor/robloxstudio-mcp/index.mjs",
      pluginSourcePath: "/Applications/RbxForge.app/Contents/Resources/vendor/studio-plugin/MCPPlugin.rbxmx",
    });
  });

  it("resolves every development asset inside app.getAppPath()/dist", () => {
    const paths = resolveDesktopPaths({
      app: {
        isPackaged: false,
        getAppPath: () => "/workspace/apps/desktop",
        getPath: () => "/tmp/RbxForge-dev",
      },
      resourcesPath: "/untrusted/electron/resources",
    });
    expect(paths).toEqual({
      databasePath: "/tmp/RbxForge-dev/rbxforge.sqlite",
      rendererFile: "/workspace/apps/desktop/dist/renderer/index.html",
      preloadFile: "/workspace/apps/desktop/dist/preload/index.cjs",
      mcpEntryPath: "/workspace/apps/desktop/dist/vendor/robloxstudio-mcp/index.mjs",
      pluginSourcePath: "/workspace/apps/desktop/dist/vendor/studio-plugin/MCPPlugin.rbxmx",
    });
    expect(JSON.stringify(paths)).not.toContain("/untrusted/electron/resources");
  });

  it("rejects relative application-data or resource roots", () => {
    expect(() =>
      resolveDesktopPaths({
        app: {
          isPackaged: true,
          getAppPath: () => "relative/app.asar",
          getPath: () => "/absolute/user-data",
        },
        resourcesPath: "/absolute/resources",
      }),
    ).toThrow(/absolute/i);
    expect(() =>
      resolveDesktopPaths({
        app: {
          isPackaged: true,
          getAppPath: () => "/absolute/app.asar",
          getPath: () => "relative/user-data",
        },
        resourcesPath: "/absolute/resources",
      }),
    ).toThrow(/absolute/i);
  });
});
