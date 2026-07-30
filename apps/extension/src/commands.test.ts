import { describe, expect, test } from "vitest";

import { COMMANDS, registerCommands } from "./commands.js";
import { LiveStudioTreeProvider } from "./live-studio-tree.js";
import { createFixtureServices } from "./service-container.js";
import { FakeVsCode } from "./test/fake-vscode.js";

describe("extension commands", () => {
  test("declares and registers every manifest command from one shared constant", () => {
    const vscode = new FakeVsCode();
    const services = createFixtureServices();
    const disposables = registerCommands(vscode, services, new LiveStudioTreeProvider({ graph: services.graph }));
    expect(COMMANDS.map((command) => command.id)).toEqual([
      "rbxforge.openWorkbench",
      "rbxforge.selectProject",
      "rbxforge.startRojo",
      "rbxforge.stopRojo",
      "rbxforge.installStudioPlugin",
      "rbxforge.selectStudioInstance",
      "rbxforge.refreshStudio",
      "rbxforge.copyDataModelPath",
      "rbxforge.revealSource",
      "rbxforge.openProperties",
      "rbxforge.addAgentContext",
      "rbxforge.captureScreenshot",
      "rbxforge.configureAiProvider",
    ]);
    expect([...vscode.commands.keys()]).toEqual(COMMANDS.map((command) => command.id));
    disposables.forEach((disposable) => disposable.dispose());
    expect([...vscode.commands.keys()]).toEqual([]);
  });

  test("runs only lazy, guarded command effects", async () => {
    const vscode = new FakeVsCode();
    vscode.openDialogResult = [{ fsPath: "/tmp/game.project.json" }];
    vscode.quickPickResult = { label: "Fixture Studio", description: "fixture-instance" };
    const services = createFixtureServices();
    const added: string[] = [];
    registerCommands(vscode, services, new LiveStudioTreeProvider({ graph: services.graph }), undefined, (target) => {
      added.push(target.path);
    });

    await vscode.executeCommand("rbxforge.openWorkbench");
    await vscode.executeCommand("rbxforge.selectProject");
    await vscode.executeCommand("rbxforge.startRojo");
    await vscode.executeCommand("rbxforge.stopRojo");
    await vscode.executeCommand("rbxforge.installStudioPlugin");
    await vscode.executeCommand("rbxforge.selectStudioInstance");
    await vscode.executeCommand("rbxforge.refreshStudio");
    await vscode.executeCommand("rbxforge.copyDataModelPath", 'game.Workspace["Door.Hinge"]');
    await vscode.executeCommand("rbxforge.copyDataModelPath", { path: 'game.Workspace["Door.Hinge"]' });
    await vscode.executeCommand("rbxforge.revealSource", "game.Workspace.Mapped");
    await vscode.executeCommand("rbxforge.openProperties", "game.Workspace.Mapped");
    await vscode.executeCommand("rbxforge.addAgentContext", "game.Workspace.Mapped");
    await vscode.executeCommand("rbxforge.captureScreenshot");

    expect(vscode.executed[0]?.id).toBe("rbxforge.openWorkbench");
    expect(services.project.currentPath()).toBe("/tmp/game.project.json");
    expect(vscode.clipboard).toEqual(['game.Workspace["Door.Hinge"]', 'game.Workspace["Door.Hinge"]']);
    expect(vscode.documents).toEqual(["/fixture/Mapped.server.lua"]);
    expect(added).toEqual(["game.Workspace.Mapped"]);
    expect(vscode.executed.some(({ id }) => id === "rbxforge.agent.focus")).toBe(true);
    expect(vscode.messages.join(" ")).toContain("No download or installation");
    expect(vscode.warnings).toContain("Studio MCP screenshot capability is unavailable.");
  });

  test("preserves an exact safe screenshot capability reason from the viewport command", async () => {
    const vscode = new FakeVsCode();
    const services = createFixtureServices();
    registerCommands(
      vscode,
      services,
      new LiveStudioTreeProvider({ graph: services.graph }),
      undefined,
      undefined,
      undefined,
      async () => ({
        ok: false,
        reason: "Studio MCP capability unavailable: capture_screenshot",
      }),
    );

    await vscode.executeCommand("rbxforge.captureScreenshot");

    expect(vscode.warnings).toEqual(["Studio MCP capability unavailable: capture_screenshot"]);
  });
});
