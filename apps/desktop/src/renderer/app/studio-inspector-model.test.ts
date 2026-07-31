import { describe, expect, it } from "vitest";
import type { StudioInspectorNode, StudioInspectorProperty } from "../../shared/domain.js";
import {
  createStudioInspectorState,
  studioInspectorReducer,
  type InspectorIdentity,
  type StudioInspectorState,
} from "./studio-inspector-model.js";

const identityA: InspectorIdentity = {
  projectId: "project-a",
  instanceId: "studio-a",
  bindingRevision: 7,
  brokerEpoch: "epoch-a",
};
const identityB: InspectorIdentity = { ...identityA, bindingRevision: 8 };

const child: StudioInspectorNode = {
  name: "Workspace",
  className: "Workspace",
  path: "game.Workspace",
  hasChildren: true,
};
const property: StudioInspectorProperty = {
  name: "Name",
  category: "Data",
  value: "Workspace",
  valueKind: "string",
};

function populatedState(): StudioInspectorState {
  return {
    identity: identityA,
    isOpen: true,
    childrenByPath: {
      game: { status: "ready", generation: 1, rows: [child] },
    },
    expandedPaths: ["game"],
    selectedPath: "game.Workspace",
    properties: {
      status: "ready",
      generation: 2,
      path: "game.Workspace",
      className: "Workspace",
      rows: [property],
      observedAt: 100,
    },
  };
}

describe("Studio inspector identity state", () => {
  it.each([
    ["project", { ...identityA, projectId: "project-b" }],
    ["instance", { ...identityA, instanceId: "studio-b" }],
    ["binding revision", identityB],
    ["broker epoch", { ...identityA, brokerEpoch: "epoch-b" }],
  ] as const)("clears all transient inspection content when the %s changes", (_field, changedIdentity) => {
    const state = studioInspectorReducer(populatedState(), {
      type: "identity.changed",
      identity: changedIdentity,
    });

    expect(state).toEqual({
      ...createStudioInspectorState(changedIdentity),
      isOpen: false,
    });
  });

  it("clears transient content and closes when there is no bound identity", () => {
    const state = studioInspectorReducer(populatedState(), {
      type: "identity.changed",
      identity: undefined,
    });

    expect(state).toEqual(createStudioInspectorState());
  });

  it("clears transient content when the panel closes", () => {
    const state = studioInspectorReducer(populatedState(), { type: "closed" });

    expect(state).toEqual({
      ...createStudioInspectorState(identityA),
      isOpen: false,
    });
  });

  it("preserves the open panel and loaded cache when the identity is unchanged", () => {
    const current = populatedState();
    const state = studioInspectorReducer(current, {
      type: "identity.changed",
      identity: { ...identityA },
    });

    expect(state).toBe(current);
  });
});

describe("Studio inspector load state", () => {
  it("opens by creating one root loading generation", () => {
    const state = studioInspectorReducer(createStudioInspectorState(identityA), {
      type: "opened",
      identity: identityA,
      generation: 1,
    });

    expect(state.isOpen).toBe(true);
    expect(state.childrenByPath).toEqual({
      game: { status: "loading", generation: 1 },
    });
  });

  it("caches children returned for the matching identity, path, and generation", () => {
    const loading = studioInspectorReducer(createStudioInspectorState(identityA), {
      type: "opened",
      identity: identityA,
      generation: 4,
    });

    const state = studioInspectorReducer(loading, {
      type: "children.loaded",
      identity: identityA,
      path: "game",
      generation: 4,
      rows: [child],
    });

    expect(state.childrenByPath.game).toEqual({
      status: "ready",
      generation: 4,
      rows: [child],
    });
  });

  it("ignores an older child generation", () => {
    const loading = studioInspectorReducer(createStudioInspectorState(identityA), {
      type: "opened",
      identity: identityA,
      generation: 5,
    });

    const state = studioInspectorReducer(loading, {
      type: "children.loaded",
      identity: identityA,
      path: "game",
      generation: 4,
      rows: [child],
    });

    expect(state).toBe(loading);
  });

  it("expands an unloaded node and creates its loading generation", () => {
    const open = studioInspectorReducer(createStudioInspectorState(identityA), {
      type: "opened",
      identity: identityA,
      generation: 1,
    });

    const state = studioInspectorReducer(open, {
      type: "path.toggled",
      identity: identityA,
      path: "game.Workspace",
      generation: 2,
    });

    expect(state.expandedPaths).toEqual(["game.Workspace"]);
    expect(state.childrenByPath["game.Workspace"]).toEqual({
      status: "loading",
      generation: 2,
    });
  });

  it("expands a cached node without replacing its ready load state", () => {
    const cached: StudioInspectorState = {
      ...createStudioInspectorState(identityA),
      isOpen: true,
      childrenByPath: {
        "game.Workspace": { status: "ready", generation: 3, rows: [child] },
      },
    };

    const state = studioInspectorReducer(cached, {
      type: "path.toggled",
      identity: identityA,
      path: "game.Workspace",
      generation: 4,
    });

    expect(state.expandedPaths).toEqual(["game.Workspace"]);
    expect(state.childrenByPath["game.Workspace"]).toBe(cached.childrenByPath["game.Workspace"]);
  });

  it("collapses a node without deleting its cached children", () => {
    const cachedEntry = { status: "ready" as const, generation: 3, rows: [child] };
    const expanded: StudioInspectorState = {
      ...createStudioInspectorState(identityA),
      isOpen: true,
      childrenByPath: { "game.Workspace": cachedEntry },
      expandedPaths: ["game.Workspace"],
    };

    const state = studioInspectorReducer(expanded, {
      type: "path.toggled",
      identity: identityA,
      path: "game.Workspace",
      generation: 4,
    });

    expect(state.expandedPaths).toEqual([]);
    expect(state.childrenByPath["game.Workspace"]).toBe(cachedEntry);
  });

  it("selects a new path by clearing old visible properties and starting a new generation", () => {
    const selected: StudioInspectorState = {
      ...populatedState(),
      expandedPaths: [],
    };

    const state = studioInspectorReducer(selected, {
      type: "path.selected",
      identity: identityA,
      path: "game.Workspace.Part",
      generation: 3,
    });

    expect(state.selectedPath).toBe("game.Workspace.Part");
    expect(state.properties).toEqual({
      status: "loading",
      generation: 3,
      path: "game.Workspace.Part",
    });
  });

  it("ignores a late property result for the prior selection", () => {
    const selected: StudioInspectorState = {
      ...createStudioInspectorState(identityA),
      isOpen: true,
      selectedPath: "game.Workspace.PartB",
      properties: {
        status: "loading",
        generation: 9,
        path: "game.Workspace.PartB",
      },
    };

    const state = studioInspectorReducer(selected, {
      type: "properties.loaded",
      identity: identityA,
      path: "game.Workspace.PartA",
      generation: 8,
      className: "Part",
      rows: [property],
      observedAt: 200,
    });

    expect(state).toBe(selected);
  });

  it("refreshes root and expanded paths without invalidating other cached paths", () => {
    const untouchedEntry = { status: "ready" as const, generation: 4, rows: [child] };
    const cached: StudioInspectorState = {
      ...createStudioInspectorState(identityA),
      isOpen: true,
      childrenByPath: {
        game: { status: "ready", generation: 1, rows: [child] },
        "game.Workspace": { status: "ready", generation: 2, rows: [child] },
        "game.ReplicatedStorage": untouchedEntry,
      },
      expandedPaths: ["game.Workspace"],
    };

    const state = studioInspectorReducer(cached, {
      type: "refreshed",
      identity: identityA,
      loads: [
        { path: "game", generation: 10 },
        { path: "game.Workspace", generation: 11 },
      ],
    });

    expect(state.childrenByPath.game).toEqual({ status: "loading", generation: 10 });
    expect(state.childrenByPath["game.Workspace"]).toEqual({
      status: "loading",
      generation: 11,
    });
    expect(state.childrenByPath["game.ReplicatedStorage"]).toBe(untouchedEntry);
  });

  it("stores a matching child failure as a user-facing error state", () => {
    const loading = studioInspectorReducer(createStudioInspectorState(identityA), {
      type: "opened",
      identity: identityA,
      generation: 12,
    });

    const state = studioInspectorReducer(loading, {
      type: "children.failed",
      identity: identityA,
      path: "game",
      generation: 12,
      message: "Studio read failed.",
    });

    expect(state.childrenByPath.game).toEqual({
      status: "error",
      generation: 12,
      message: "Studio read failed.",
    });
  });

  it("retries only an errored child path with a new generation", () => {
    const failed: StudioInspectorState = {
      ...createStudioInspectorState(identityA),
      isOpen: true,
      childrenByPath: {
        game: { status: "error", generation: 12, message: "Studio read failed." },
      },
    };

    const state = studioInspectorReducer(failed, {
      type: "children.retried",
      identity: identityA,
      path: "game",
      generation: 13,
    });

    expect(state.childrenByPath.game).toEqual({ status: "loading", generation: 13 });
  });

  it("stores a matching property failure without restoring prior visible rows", () => {
    const loading: StudioInspectorState = {
      ...createStudioInspectorState(identityA),
      isOpen: true,
      selectedPath: "game.Workspace.Part",
      properties: {
        status: "loading",
        generation: 14,
        path: "game.Workspace.Part",
      },
    };

    const state = studioInspectorReducer(loading, {
      type: "properties.failed",
      identity: identityA,
      path: "game.Workspace.Part",
      generation: 14,
      message: "Property read failed.",
    });

    expect(state.properties).toEqual({
      status: "error",
      generation: 14,
      path: "game.Workspace.Part",
      message: "Property read failed.",
    });
  });

  it("retries only the currently selected errored property path", () => {
    const failed: StudioInspectorState = {
      ...createStudioInspectorState(identityA),
      isOpen: true,
      selectedPath: "game.Workspace.Part",
      properties: {
        status: "error",
        generation: 14,
        path: "game.Workspace.Part",
        message: "Property read failed.",
      },
    };

    const state = studioInspectorReducer(failed, {
      type: "properties.retried",
      identity: identityA,
      path: "game.Workspace.Part",
      generation: 15,
    });

    expect(state.properties).toEqual({
      status: "loading",
      generation: 15,
      path: "game.Workspace.Part",
    });
  });
});
