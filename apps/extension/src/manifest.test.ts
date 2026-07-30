import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

import { COMMANDS } from "./commands.js";

const manifestPath = fileURLToPath(new URL("../package.json", import.meta.url));

describe("extension manifest", () => {
  test("contributes the complete Roblox workbench surface", async () => {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      name: string;
      version: string;
      publisher: string;
      displayName: string;
      description: string;
      license: string;
      icon: string;
      main: string;
      engines: { vscode: string };
      capabilities: {
        untrustedWorkspaces: { supported: boolean };
        virtualWorkspaces: { supported: boolean };
      };
      files: string[];
      activationEvents: string[];
      contributes?: {
        viewsContainers?: { activitybar?: { id: string; title: string; icon: string }[] };
        views?: Record<string, { id: string; type?: string }[]>;
        commands?: { command: string }[];
        menus?: { "view/item/context"?: { command: string; when: string }[] };
      };
    };

    expect(manifest).toMatchObject({
      name: "rbxforge",
      version: "0.1.0",
      publisher: "rbxforge",
      displayName: "RbxForge",
      license: "UNLICENSED",
      icon: "media/rbxforge.png",
      capabilities: {
        untrustedWorkspaces: { supported: false },
        virtualWorkspaces: { supported: false },
      },
    });
    expect(manifest.description).toMatch(/Roblox/i);
    expect(manifest.main).toBe("./dist/extension.js");
    expect(manifest.engines.vscode).toBe("^1.100.0");
    expect(manifest.files).toEqual([
      "dist/extension.js",
      "media/rbxforge.svg",
      "media/rbxforge.png",
      "media/webview/webview.js",
      "media/webview/webview.css",
      "vendor/package.json",
      "vendor/robloxstudio-mcp/index.mjs",
      "vendor/robloxstudio-mcp/assets/Baseplate.rbxl",
      "vendor/studio-plugin/MCPPlugin.rbxmx",
      "README.md",
      "LICENSE",
      "THIRD_PARTY_NOTICES",
    ]);
    expect(manifest.activationEvents).toContain("onView:rbxforge.liveStudio");
    expect(manifest.contributes?.viewsContainers?.activitybar).toEqual([
      { id: "rbxforge", title: "Roblox", icon: "media/rbxforge.svg" },
    ]);
    expect(new Set(manifest.contributes?.views?.rbxforge?.map((view) => view.id))).toEqual(
      new Set([
        "rbxforge.connection",
        "rbxforge.liveStudio",
        "rbxforge.properties",
        "rbxforge.agent",
        "rbxforge.playtest",
        "rbxforge.activity",
      ]),
    );
    expect(manifest.contributes?.views?.rbxforge?.filter(({ type }) => type === "webview").map(({ id }) => id)).toEqual(
      ["rbxforge.connection", "rbxforge.properties", "rbxforge.agent", "rbxforge.playtest", "rbxforge.activity"],
    );
    expect(manifest.activationEvents).toEqual(
      expect.arrayContaining([
        "onView:rbxforge.connection",
        "onView:rbxforge.properties",
        "onView:rbxforge.agent",
        "onView:rbxforge.playtest",
        "onView:rbxforge.activity",
      ]),
    );
    expect(new Set(manifest.contributes?.commands?.map((command) => command.command))).toEqual(
      new Set(COMMANDS.map((command) => command.id)),
    );
    expect(manifest.contributes?.menus?.["view/item/context"]?.map((item) => item.command)).toEqual([
      "rbxforge.copyDataModelPath",
      "rbxforge.revealSource",
      "rbxforge.openProperties",
      "rbxforge.addAgentContext",
      "rbxforge.captureScreenshot",
    ]);
  });
});
