import { describe, expect, test, vi } from "vitest";

import { activateWithFacade } from "./activation.js";
import { createFixtureServices } from "./service-container.js";
import { FakeVsCode } from "./test/fake-vscode.js";
import type { UnifiedInstanceNode } from "@rbxforge/core";
import type { ExtensionServices } from "./service-container.js";

describe("activation", () => {
  test("registers commands, views, and status without starting external services", async () => {
    const vscode = new FakeVsCode();
    const context = { subscriptions: [] as { dispose(): void }[], extensionPath: "/extension" };
    const fixture = createFixtureServices();
    const calls: string[] = [];
    const services = {
      ...fixture,
      graph: {
        ...fixture.graph,
        children: async (path: string) => {
          calls.push(path);
          return [];
        },
      },
    };
    const activation = await activateWithFacade(vscode, context, services);

    expect(vscode.commands.size).toBe(13);
    expect(vscode.trees.has("rbxforge.liveStudio")).toBe(true);
    expect([...vscode.webviewProviders.keys()]).toEqual([
      "rbxforge.connection",
      "rbxforge.playtest",
      "rbxforge.activity",
      "rbxforge.properties",
      "rbxforge.agent",
    ]);
    const connection = await vscode.resolveWebview("rbxforge.connection");
    expect(connection.options).toEqual({
      enableScripts: true,
      localResourceRoots: ["/extension/media/webview"],
    });
    expect(connection.html).toContain("webview-resource:/extension/media/webview/webview.js");
    expect(connection.html).toContain("webview-resource:/extension/media/webview/webview.css");
    expect(connection.posted[0]).toMatchObject({ v: 1, type: "init", view: "connection" });
    const revived = await vscode.resolveWebview("rbxforge.connection");
    const firstInit = connection.posted[0] as {
      readonly sessionId: string;
      readonly generation: number;
    };
    connection.receive({
      v: 1,
      type: "ready",
      sessionId: firstInit.sessionId,
      requestId: "stale-ready",
      generation: firstInit.generation,
    });
    await Promise.resolve();
    expect(connection.posted).toHaveLength(1);
    expect(revived.posted[0]).toMatchObject({ type: "init", view: "connection" });
    const playtest = await vscode.resolveWebview("rbxforge.playtest");
    const activity = await vscode.resolveWebview("rbxforge.activity");
    const agent = await vscode.resolveWebview("rbxforge.agent");
    expect(playtest.posted[0]).toMatchObject({ type: "init", view: "playtest" });
    expect(activity.posted[0]).toMatchObject({ type: "init", view: "activity" });
    expect(agent.posted[0]).toMatchObject({ type: "init", view: "agent" });
    expect(context.subscriptions.length).toBeGreaterThanOrEqual(19);
    expect(vscode.statusItems.some((item) => item.text.includes("Simulation"))).toBe(true);
    expect(vscode.statusItems[0]?.command).toBe("rbxforge.connection.focus");
    await vscode.executeCommand("rbxforge.refreshStudio");
    expect(calls).toEqual(["game"]);
    calls.length = 0;
    const workspace = {
      path: "game.Workspace",
      name: "Workspace",
      className: "Folder",
      ownership: "files",
      children: [],
      unsafeUnknownChildren: false,
      unsafeParent: false,
    } as const satisfies UnifiedInstanceNode;
    vscode.treeViews[0]?.emitExpand(workspace);
    await vscode.executeCommand("rbxforge.refreshStudio");
    expect(calls).toEqual(["game", "game.Workspace"]);
    context.subscriptions.forEach((subscription) => subscription.dispose());
    await activation.shutdown();
    expect(vscode.disposables.every((disposable) => disposable.disposed)).toBe(true);
  });

  test("synchronous VS Code disposal contains an asynchronous service disposal failure", async () => {
    const vscode = new FakeVsCode();
    const context = { subscriptions: [] as { dispose(): void }[], extensionPath: "/extension" };
    const fixture = createFixtureServices();
    const services: ExtensionServices = {
      ...fixture,
      dispose: async () => {
        throw new Error("close failed");
      },
    };
    const activation = await activateWithFacade(vscode, context, services);

    expect(() => context.subscriptions.forEach((subscription) => subscription.dispose())).not.toThrow();
    await expect(activation.shutdown()).rejects.toThrow("close failed");
  });

  test("activation failure disposes partial registrations and services exactly once", async () => {
    const vscode = new FakeVsCode();
    const context = { subscriptions: [] as { dispose(): void }[], extensionPath: "/extension" };
    const fixture = createFixtureServices();
    const dispose = vi.fn(async () => fixture.dispose());
    const services: ExtensionServices = { ...fixture, dispose };
    vi.spyOn(vscode, "registerTreeDataProvider").mockImplementation(() => {
      throw new Error("registration failed");
    });

    await expect(activateWithFacade(vscode, context, services)).rejects.toThrow("registration failed");

    expect(context.subscriptions).toEqual([]);
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
