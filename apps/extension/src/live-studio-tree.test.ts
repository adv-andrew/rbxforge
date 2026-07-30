import type { UnifiedInstanceNode } from "@rbxforge/core";
import { describe, expect, test } from "vitest";

import type { ConnectionStateSnapshot } from "./connection-state.js";
import { LiveStudioTreeProvider } from "./live-studio-tree.js";
import type { DisposablePort, EventPort } from "./vscode-facade.js";

class Emitter<T> implements EventPort<T> {
  readonly #listeners = new Set<(value: T) => void>();
  readonly event = (listener: (value: T) => void): DisposablePort => {
    this.#listeners.add(listener);
    return { dispose: () => this.#listeners.delete(listener) };
  };
  emit(value: T): void {
    for (const listener of this.#listeners) listener(value);
  }
}

class Graph {
  readonly connectionEmitter = new Emitter<ConnectionStateSnapshot>();
  readonly invalidationEmitter = new Emitter<{ readonly path: string }>();
  readonly onConnectionChanged = this.connectionEmitter.event;
  readonly onGraphInvalidated = this.invalidationEmitter.event;
  readonly calls: string[] = [];
  readonly #children = new Map<string, readonly UnifiedInstanceNode[]>();
  set(path: string, nodes: readonly UnifiedInstanceNode[]): void {
    this.#children.set(path, nodes);
  }
  async children(path: string, signal: AbortSignal): Promise<readonly UnifiedInstanceNode[]> {
    this.calls.push(path);
    await Promise.resolve();
    if (signal.aborted) return [];
    return this.#children.get(path) ?? [];
  }
}

const node = (
  path: string,
  ownership: UnifiedInstanceNode["ownership"] = "files",
  unsafe = false,
): UnifiedInstanceNode =>
  Object.freeze({
    path,
    name: path.split(".").at(-1) ?? path,
    className: "Folder",
    ownership,
    children: Object.freeze([]),
    unsafeUnknownChildren: unsafe,
    unsafeParent: false,
  });

describe("Live Studio tree", () => {
  test("expanding a parent asks the graph for only its exact canonical path", async () => {
    const graph = new Graph();
    graph.set("game.Workspace", [node('game.Workspace["Door.Hinge"]')]);
    const tree = new LiveStudioTreeProvider({ graph });
    tree.setExpanded("game.Workspace", true);
    await tree.childrenFor("game.Workspace");
    expect(graph.calls).toEqual(["game.Workspace"]);
  });

  test("coalesces concurrent requests for the same parent", async () => {
    const graph = new Graph();
    const tree = new LiveStudioTreeProvider({ graph });
    tree.setExpanded("game.Workspace", true);
    const first = tree.childrenFor("game.Workspace");
    const second = tree.childrenFor("game.Workspace");
    expect(first).toBe(second);
    await first;
    expect(graph.calls).toEqual(["game.Workspace"]);
  });

  test("refreshes only expanded visible paths", async () => {
    const graph = new Graph();
    const tree = new LiveStudioTreeProvider({ graph });
    tree.setVisible(true);
    tree.setExpanded("game.Workspace", true);
    tree.setExpanded("game.ServerStorage", true);
    tree.setPathVisible("game.ServerStorage", false);
    await tree.refreshVisible();
    expect(graph.calls).toEqual(["game", "game.Workspace"]);
  });

  test("hidden trees do not fetch the canonical root or any expanded branch", async () => {
    const graph = new Graph();
    const tree = new LiveStudioTreeProvider({ graph });
    tree.setExpanded("game.Workspace", true);
    tree.setVisible(false);
    await tree.refreshVisible();
    expect(graph.calls).toEqual([]);
  });

  test("retains cached nodes but marks them stale after a disconnect", async () => {
    const graph = new Graph();
    graph.set("game.Workspace", [node("game.Workspace.Part")]);
    const tree = new LiveStudioTreeProvider({ graph });
    tree.setExpanded("game.Workspace", true);
    await tree.childrenFor("game.Workspace");
    graph.connectionEmitter.emit({
      aggregate: { label: "Not ready", failing: ["mcpProcess"] },
      checks: {} as ConnectionStateSnapshot["checks"],
      revision: 1,
      simulation: false,
      observedAt: 0,
    });
    expect(tree.getTreeItem(node("game.Workspace.Part")).description).toContain("stale");
  });

  test("preserves quoted canonical paths in item context values and decorates warnings", () => {
    const graph = new Graph();
    const tree = new LiveStudioTreeProvider({ graph });
    const drift = node('game.Workspace["Door.Hinge"]', "drift", true);
    const item = tree.getTreeItem(drift);
    expect(item.contextValue).toBe('game.Workspace["Door.Hinge"]');
    expect(item.collapsibleState).toBe("none");
    expect(item.description).toContain("drift");
    expect(item.icon).toBe("warning");
  });

  test("uses bounded exponential retry delays for visible expanded failures", () => {
    const graph = new Graph();
    const tree = new LiveStudioTreeProvider({ graph });
    expect([1, 2, 3, 4, 5, 6].map((attempt) => tree.retryDelaySeconds(attempt))).toEqual([1, 2, 4, 8, 15, 15]);
  });

  test("schedules retries only for a visible expanded failed path", async () => {
    const graph = new Graph();
    graph.children = async (path: string): Promise<readonly UnifiedInstanceNode[]> => {
      graph.calls.push(path);
      throw new Error("temporary disconnect");
    };
    const delays: number[] = [];
    const tree = new LiveStudioTreeProvider({
      graph,
      scheduleRetry: (delaySeconds: number) => delays.push(delaySeconds),
    });
    tree.setExpanded("game.Workspace", true);
    await expect(tree.childrenFor("game.Workspace")).rejects.toThrow("temporary disconnect");
    expect(delays).toEqual([1]);
    tree.setPathVisible("game.Workspace", false);
    await expect(tree.childrenFor("game.Workspace")).rejects.toThrow("temporary disconnect");
    expect(delays).toEqual([1]);
  });
});
