import { describe, expect, it } from "vitest";
import { reconcileInstanceGraph } from "./index.js";

describe("reconcileInstanceGraph", () => {
  it("marks a sourcemap-matched Studio object as files-owned", () => {
    const graph = reconcileInstanceGraph({
      files: [{ path: "game.Workspace.Part", filePaths: ["/repo/part.model.json"] }],
      rojo: [{ path: "game.Workspace.Part", name: "Part", className: "Part" }],
      studio: [{ path: "game.Workspace.Part", name: "Part", className: "Part" }],
    });

    expect(graph.get("game.Workspace.Part")?.ownership).toBe("files");
  });

  it("marks unequal comparable properties as drift", () => {
    const graph = reconcileInstanceGraph({
      files: [{ path: "game.Workspace.Part", filePaths: ["/repo/part.model.json"] }],
      rojo: [
        {
          path: "game.Workspace.Part",
          name: "Part",
          className: "Part",
          properties: { Anchored: false },
        },
      ],
      studio: [
        {
          path: "game.Workspace.Part",
          name: "Part",
          className: "Part",
          properties: { Anchored: true },
        },
      ],
    });

    const node = graph.get("game.Workspace.Part");
    expect(node?.ownership).toBe("drift");
    expect(node?.rojo?.properties).toEqual({ Anchored: false });
    expect(node?.studio?.properties).toEqual({ Anchored: true });
  });

  it("marks mismatched source names as drift and keeps the declared name", () => {
    const graph = reconcileInstanceGraph({
      files: [{ path: "game.Workspace.Part", filePaths: ["/repo/part.model.json"] }],
      rojo: [{ path: "game.Workspace.Part", name: "Declared Part", className: "Part" }],
      studio: [{ path: "game.Workspace.Part", name: "Live Part", className: "Part" }],
    });

    const node = graph.get("game.Workspace.Part");
    expect(node?.ownership).toBe("drift");
    expect(node?.name).toBe("Declared Part");
  });

  it("marks mismatched source classes as drift", () => {
    const graph = reconcileInstanceGraph({
      files: [{ path: "game.Workspace.Part", filePaths: ["/repo/part.model.json"] }],
      rojo: [{ path: "game.Workspace.Part", name: "Part", className: "Part" }],
      studio: [{ path: "game.Workspace.Part", name: "Part", className: "Model" }],
    });

    expect(graph.get("game.Workspace.Part")?.ownership).toBe("drift");
  });

  it("prefers projection names and falls back to the canonical path", () => {
    const graph = reconcileInstanceGraph({
      files: [{ path: "game.Workspace.FileOnly", filePaths: ["/repo/file-only.model.json"] }],
      rojo: [],
      studio: [{ path: "game.Workspace.LiveOnly", name: "Live Alias", className: "Folder" }],
    });

    expect(graph.get("game.Workspace.LiveOnly")?.name).toBe("Live Alias");
    expect(graph.get("game.Workspace.FileOnly")?.name).toBe("FileOnly");
  });

  it("marks a live object without a file mapping as studio-owned", () => {
    const graph = reconcileInstanceGraph({
      files: [],
      rojo: [],
      studio: [{ path: "game.Workspace.LiveOnly", name: "LiveOnly", className: "Folder" }],
    });

    expect(graph.get("game.Workspace.LiveOnly")?.ownership).toBe("studio");
  });

  it("marks a Rojo object without a file mapping as unknown", () => {
    const graph = reconcileInstanceGraph({
      files: [],
      rojo: [{ path: "game.Workspace.DeclaredOnly", name: "DeclaredOnly", className: "Folder" }],
      studio: [],
    });

    expect(graph.get("game.Workspace.DeclaredOnly")?.ownership).toBe("unknown");
  });

  it("keeps a stale file mapping unknown without a live node", () => {
    const graph = reconcileInstanceGraph({
      files: [{ path: "game.Workspace.Stale", filePaths: ["/repo/stale.model.json"] }],
      rojo: [{ path: "game.Workspace.Stale", name: "Stale", className: "Model" }],
      studio: [],
    });

    expect(graph.get("game.Workspace.Stale")?.ownership).toBe("unknown");
  });

  it("normalizes quoted paths before joining source projections", () => {
    const graph = reconcileInstanceGraph({
      files: [{ path: 'game.Workspace["Door.Hinge"]', filePaths: ["/repo/door.model.json"] }],
      rojo: [{ path: 'game.Workspace["Door.Hinge"]', name: "Door.Hinge", className: "Model" }],
      studio: [{ path: 'game.Workspace["Door.Hinge"]', name: "Door.Hinge", className: "Model" }],
    });

    expect(graph.get('game.Workspace["Door.Hinge"]')?.ownership).toBe("files");
  });

  it("compares shared properties independent of object key order", () => {
    const graph = reconcileInstanceGraph({
      files: [{ path: "game.Workspace.Config", filePaths: ["/repo/config.model.json"] }],
      rojo: [
        {
          path: "game.Workspace.Config",
          name: "Config",
          className: "Configuration",
          properties: { Value: { alpha: 1, beta: ["x", "y"] } },
        },
      ],
      studio: [
        {
          path: "game.Workspace.Config",
          name: "Config",
          className: "Configuration",
          properties: { Extra: true, Value: { beta: ["x", "y"], alpha: 1 } },
        },
      ],
    });

    expect(graph.get("game.Workspace.Config")?.ownership).toBe("files");
  });

  it("treats differently ordered arrays as drift", () => {
    const graph = reconcileInstanceGraph({
      files: [{ path: "game.Workspace.Config", filePaths: ["/repo/config.model.json"] }],
      rojo: [
        {
          path: "game.Workspace.Config",
          name: "Config",
          className: "Configuration",
          properties: { Values: ["x", "y"] },
        },
      ],
      studio: [
        {
          path: "game.Workspace.Config",
          name: "Config",
          className: "Configuration",
          properties: { Values: ["y", "x"] },
        },
      ],
    });

    expect(graph.get("game.Workspace.Config")?.ownership).toBe("drift");
  });

  it("propagates an unsafe Rojo parent warning to descendants", () => {
    const graph = reconcileInstanceGraph({
      files: [],
      rojo: [
        {
          path: "game.Workspace",
          name: "Workspace",
          className: "Workspace",
          unsafeUnknownChildren: true,
        },
        { path: "game.Workspace.Folder", name: "Folder", className: "Folder" },
        { path: "game.Workspace.Folder.Part", name: "Part", className: "Part" },
      ],
      studio: [],
    });

    expect(graph.get("game.Workspace")?.unsafeUnknownChildren).toBe(true);
    expect(graph.get("game.Workspace")?.unsafeParent).toBe(false);
    expect(graph.get("game.Workspace.Folder")?.unsafeParent).toBe(true);
    expect(graph.get("game.Workspace.Folder.Part")?.unsafeParent).toBe(true);
  });

  it("orders children deterministically by their canonical names", () => {
    const graph = reconcileInstanceGraph({
      files: [],
      rojo: [
        { path: "game.Workspace", name: "Workspace", className: "Workspace" },
        { path: "game.Workspace.Zebra", name: "Zebra", className: "Folder" },
        { path: "game.Workspace.Alpha", name: "Alpha", className: "Part" },
        { path: "game.Workspace.Mango", name: "Mango", className: "Model" },
      ],
      studio: [],
    });

    expect(graph.get("game.Workspace")?.children).toEqual([
      "game.Workspace.Alpha",
      "game.Workspace.Mango",
      "game.Workspace.Zebra",
    ]);
  });
});
