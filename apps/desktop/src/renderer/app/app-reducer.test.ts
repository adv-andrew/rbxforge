import { describe, expect, it } from "vitest";

import type { DesktopResponse } from "../../shared/protocol.js";
import { project, snapshot, thread } from "../test/fixtures.js";
import {
  initialAppState,
  reduceAppState,
  selectBlockedDraftSaveCandidates,
  selectCurrentView,
  selectDraftContent,
  selectDraftSaveCandidates,
  type RequestKey,
} from "./app-reducer.js";

function success(revision: number): DesktopResponse {
  return {
    version: 1,
    requestId: `request-${revision}`,
    ok: true,
    snapshot: snapshot({ revision }),
    result: { kind: "none" },
  };
}

function failure(revision: number): DesktopResponse {
  return {
    version: 1,
    requestId: `request-${revision}`,
    ok: false,
    snapshot: snapshot({ revision }),
    error: {
      layer: "storage",
      code: "save-failed",
      message: "Local desktop data could not be updated.",
      recovery: { action: "retry", label: "Retry" },
    },
  };
}

describe("app reducer snapshots", () => {
  it("accepts monotonic snapshots and ignores an older event", () => {
    const state = reduceAppState(initialAppState, { type: "snapshot.received", snapshot: snapshot({ revision: 8 }) });
    const unchanged = reduceAppState(state, { type: "snapshot.received", snapshot: snapshot({ revision: 7 }) });
    expect(unchanged).toBe(state);
  });

  it("adopts an event before a stale bootstrap response and clears only that response generation", () => {
    let state = reduceAppState(initialAppState, {
      type: "request.started",
      key: "bootstrap",
      generation: 1,
      exclusive: false,
    });
    state = reduceAppState(state, { type: "snapshot.received", snapshot: snapshot({ revision: 9 }) });
    state = reduceAppState(state, {
      type: "request.completed",
      key: "bootstrap",
      generation: 1,
      response: success(4),
    });
    expect(state.snapshot?.revision).toBe(9);
    expect(state.requests.bootstrap?.inFlight).toBe(false);
  });

  it("keeps a newer ready conversation when an older bootstrap later fails", () => {
    let state = reduceAppState(initialAppState, {
      type: "request.started",
      key: "bootstrap",
      generation: 1,
      exclusive: false,
    });
    state = reduceAppState(state, {
      type: "snapshot.received",
      snapshot: snapshot({
        revision: 9,
        projects: [project({ displayName: "Event project" })],
      }),
    });
    state = reduceAppState(state, {
      type: "request.completed",
      key: "bootstrap",
      generation: 1,
      response: failure(4),
    });
    expect(state.status).toBe("ready");
    expect(state.snapshot?.revision).toBe(9);
    expect(state.snapshot?.projects[0]?.displayName).toBe("Event project");
    expect(state.requests.bootstrap?.error).toMatchObject({ layer: "storage", code: "save-failed" });
  });

  it("does not let a late first request clear a later retry or its mutation reservation", () => {
    let state = reduceAppState(initialAppState, { type: "snapshot.received", snapshot: snapshot({ revision: 1 }) });
    state = reduceAppState(state, {
      type: "request.started",
      key: "thread.rename",
      generation: 1,
      exclusive: true,
    });
    state = reduceAppState(state, {
      type: "request.started",
      key: "thread.rename",
      generation: 2,
      exclusive: true,
    });
    state = reduceAppState(state, {
      type: "request.completed",
      key: "thread.rename",
      generation: 1,
      response: success(2),
    });
    expect(state.requests["thread.rename"]).toMatchObject({ generation: 2, inFlight: true });
    expect(state.exclusiveMutation).toEqual({ key: "thread.rename", generation: 2 });
  });

  it("adopts a newer safe failure snapshot before storing the bounded controller error", () => {
    let state = reduceAppState(initialAppState, { type: "snapshot.received", snapshot: snapshot({ revision: 3 }) });
    state = reduceAppState(state, {
      type: "request.started",
      key: "draft.save",
      generation: 1,
      exclusive: true,
    });
    state = reduceAppState(state, {
      type: "request.completed",
      key: "draft.save",
      generation: 1,
      response: failure(5),
    });
    expect(state.snapshot?.revision).toBe(5);
    expect(state.requests["draft.save"]?.error?.message).toBe("Local desktop data could not be updated.");
  });

  it("tracks independent request keys plus one exclusive host mutation", () => {
    let state = reduceAppState(initialAppState, {
      type: "request.started",
      key: "project.add",
      generation: 1,
      exclusive: true,
    });
    state = reduceAppState(state, {
      type: "request.started",
      key: "project.cancelAdd",
      generation: 1,
      exclusive: false,
    });
    expect(state.requests["project.add"]?.inFlight).toBe(true);
    expect(state.requests["project.cancelAdd"]?.inFlight).toBe(true);
    expect(state.exclusiveMutation).toEqual({ key: "project.add", generation: 1 });
  });

  it("turns a thrown bootstrap bridge call into a retryable safe error", () => {
    let state = reduceAppState(initialAppState, {
      type: "request.started",
      key: "bootstrap",
      generation: 1,
      exclusive: false,
    });
    state = reduceAppState(state, {
      type: "request.crashed",
      key: "bootstrap",
      generation: 1,
      error: {
        layer: "ipc",
        code: "renderer-request-failed",
        message: "The desktop host could not complete the request.",
        recovery: { action: "retry", label: "Retry" },
      },
    });
    expect(state.status).toBe("error");
    expect(state.requests.bootstrap).toMatchObject({
      inFlight: false,
      error: { message: "The desktop host could not complete the request." },
    });
  });
});

describe("app reducer relational state and drafts", () => {
  it("fails closed when the selected thread does not belong to the selected project", () => {
    const invalid = snapshot({
      threads: [thread({ id: "thread-b", projectId: "project-b" })],
      selectedThreadIdByProject: { "project-a": "thread-b" },
    });
    const state = reduceAppState(initialAppState, { type: "snapshot.received", snapshot: invalid });
    const view = selectCurrentView(state);
    expect(view.project?.id).toBe("project-a");
    expect(view.thread).toBeUndefined();
  });

  it("preserves and restores a versioned draft per thread", () => {
    let state = reduceAppState(initialAppState, { type: "snapshot.received", snapshot: snapshot() });
    state = reduceAppState(state, {
      type: "draft.changed",
      threadId: "thread-a",
      content: "hello",
    });
    state = reduceAppState(state, { type: "thread.focused", threadId: "thread-b" });
    state = reduceAppState(state, {
      type: "draft.changed",
      threadId: "thread-b",
      content: "other",
    });
    expect(selectDraftContent(state, "thread-a")).toBe("hello");
    expect(selectDraftContent(state, "thread-b")).toBe("other");
  });

  it("clears only the submitted version when no newer edit exists", () => {
    let state = reduceAppState(initialAppState, { type: "snapshot.received", snapshot: snapshot() });
    state = reduceAppState(state, { type: "draft.changed", threadId: "thread-a", content: "first" });
    state = reduceAppState(state, {
      type: "draft.submitted",
      threadId: "thread-a",
      requestKey: "message.create",
      generation: 1,
    });
    state = reduceAppState(state, {
      type: "draft.acknowledged",
      threadId: "thread-a",
      requestKey: "message.create",
      generation: 1,
      clear: true,
    });
    expect(selectDraftContent(state, "thread-a")).toBe("");
  });

  it("keeps newer typing after submission and retains content after a failed save", () => {
    let state = reduceAppState(initialAppState, { type: "snapshot.received", snapshot: snapshot() });
    state = reduceAppState(state, { type: "draft.changed", threadId: "thread-a", content: "first" });
    state = reduceAppState(state, {
      type: "draft.submitted",
      threadId: "thread-a",
      requestKey: "message.create",
      generation: 1,
    });
    state = reduceAppState(state, { type: "draft.changed", threadId: "thread-a", content: "first plus" });
    state = reduceAppState(state, {
      type: "draft.acknowledged",
      threadId: "thread-a",
      requestKey: "message.create",
      generation: 1,
      clear: true,
    });
    expect(selectDraftContent(state, "thread-a")).toBe("first plus");

    state = reduceAppState(state, {
      type: "draft.submitted",
      threadId: "thread-a",
      requestKey: "draft.save",
      generation: 2,
    });
    state = reduceAppState(state, {
      type: "draft.failed",
      threadId: "thread-a",
      requestKey: "draft.save",
      generation: 2,
    });
    expect(selectDraftContent(state, "thread-a")).toBe("first plus");
  });

  it("blocks only the failed draft edit version until an edit or explicit retry", () => {
    let state = reduceAppState(initialAppState, { type: "snapshot.received", snapshot: snapshot() });
    state = reduceAppState(state, { type: "draft.changed", threadId: "thread-a", content: "first" });
    state = reduceAppState(state, {
      type: "draft.submitted",
      threadId: "thread-a",
      requestKey: "draft.save",
      generation: 1,
    });
    state = reduceAppState(state, {
      type: "draft.failed",
      threadId: "thread-a",
      requestKey: "draft.save",
      generation: 1,
    });
    expect(selectDraftSaveCandidates(state)).toEqual([]);

    state = reduceAppState(state, { type: "draft.retry", threadId: "thread-a" });
    expect(selectDraftSaveCandidates(state)).toEqual([
      { projectId: "project-a", threadId: "thread-a", content: "first", editVersion: 1 },
    ]);

    state = reduceAppState(state, {
      type: "draft.submitted",
      threadId: "thread-a",
      requestKey: "draft.save",
      generation: 2,
    });
    state = reduceAppState(state, {
      type: "draft.failed",
      threadId: "thread-a",
      requestKey: "draft.save",
      generation: 2,
    });
    state = reduceAppState(state, { type: "draft.changed", threadId: "thread-a", content: "second" });
    expect(selectDraftSaveCandidates(state)).toEqual([
      { projectId: "project-a", threadId: "thread-a", content: "second", editVersion: 2 },
    ]);
  });

  it("orders multiple blocked draft failures by their exact failed request generation", () => {
    const populated = snapshot({
      revision: 1,
      threads: [thread(), thread({ id: "thread-b", title: "Second chat" })],
    });
    let state = reduceAppState(initialAppState, { type: "snapshot.received", snapshot: populated });
    for (const [generation, threadId] of [
      [1, "thread-a"],
      [2, "thread-b"],
    ] as const) {
      state = reduceAppState(state, { type: "draft.changed", threadId, content: `draft-${generation}` });
      state = reduceAppState(state, {
        type: "request.started",
        key: "draft.save",
        generation,
        exclusive: true,
      });
      state = reduceAppState(state, {
        type: "draft.submitted",
        threadId,
        requestKey: "draft.save",
        generation,
      });
      state = reduceAppState(state, {
        type: "request.completed",
        key: "draft.save",
        generation,
        response: { ...failure(generation + 1), snapshot: { ...populated, revision: generation + 1 } },
      });
      state = reduceAppState(state, {
        type: "draft.failed",
        threadId,
        requestKey: "draft.save",
        generation,
      });
    }
    expect(selectBlockedDraftSaveCandidates(state).map(({ threadId }) => threadId)).toEqual(["thread-b", "thread-a"]);
  });

  it.each<RequestKey>(["thread.rename", "draft.save", "message.create"])(
    "does not acknowledge %s with a different generation",
    (requestKey) => {
      let state = reduceAppState(initialAppState, { type: "snapshot.received", snapshot: snapshot() });
      state = reduceAppState(state, { type: "draft.changed", threadId: "thread-a", content: "first" });
      state = reduceAppState(state, {
        type: "draft.submitted",
        threadId: "thread-a",
        requestKey,
        generation: 2,
      });
      const unchanged = reduceAppState(state, {
        type: "draft.acknowledged",
        threadId: "thread-a",
        requestKey,
        generation: 1,
        clear: true,
      });
      expect(selectDraftContent(unchanged, "thread-a")).toBe("first");
    },
  );
});

describe("app reducer sidebar width transaction", () => {
  it("rolls a failed commit back to the newest durable event, not the stale response", () => {
    let state = reduceAppState(initialAppState, {
      type: "snapshot.received",
      snapshot: snapshot({ revision: 1, settings: { sidebarWidth: 272 } }),
    });
    state = reduceAppState(state, { type: "sidebar.width.changed", width: 320 });
    state = reduceAppState(state, {
      type: "request.started",
      key: "ui.sidebarWidth",
      generation: 1,
      exclusive: true,
    });
    state = reduceAppState(state, { type: "sidebar.width.commitStarted", generation: 1, width: 320 });
    state = reduceAppState(state, {
      type: "snapshot.received",
      snapshot: snapshot({ revision: 9, settings: { sidebarWidth: 300 } }),
    });
    state = reduceAppState(state, {
      type: "request.completed",
      key: "ui.sidebarWidth",
      generation: 1,
      response: failure(4),
    });
    state = reduceAppState(state, {
      type: "sidebar.width.commitCompleted",
      generation: 1,
      ok: false,
    });
    expect(state.snapshot?.revision).toBe(9);
    expect(state.durableSidebarWidth).toBe(300);
    expect(state.sidebarWidth).toBe(300);
    expect(state.sidebarWidthCommit).toBeUndefined();
    expect(state.failedSidebarWidth).toBe(320);
  });
});

describe("app reducer connection transactions", () => {
  const inspected = (detail: string, restartRequired = false): DesktopResponse => ({
    version: 1,
    requestId: detail,
    ok: true,
    snapshot: snapshot({ revision: 2 }),
    result: {
      kind: "plugin-inspection",
      inspection: {
        state: "installed",
        sourcePath: "/app/MCPPlugin.rbxmx",
        destinationPath: "/plugins/MCPPlugin.rbxmx",
        restartRequired,
        detail,
      },
    },
  });

  it("generation-gates plugin results while still adopting a newer host snapshot", () => {
    let state = reduceAppState(initialAppState, { type: "snapshot.received", snapshot: snapshot({ revision: 1 }) });
    state = reduceAppState(state, {
      type: "request.started",
      key: "plugin.inspect",
      generation: 1,
      exclusive: false,
    });
    state = reduceAppState(state, {
      type: "request.started",
      key: "plugin.inspect",
      generation: 2,
      exclusive: false,
    });
    state = reduceAppState(state, {
      type: "request.completed",
      key: "plugin.inspect",
      generation: 1,
      response: {
        ...inspected("stale inspection"),
        snapshot: snapshot({ revision: 9 }),
      },
    });
    expect(state.snapshot?.revision).toBe(9);
    expect(state.requests["plugin.inspect"]).toMatchObject({ generation: 2, inFlight: true });
    expect(state.pluginInspection).toBeUndefined();

    state = reduceAppState(state, {
      type: "request.completed",
      key: "plugin.inspect",
      generation: 2,
      response: {
        ...inspected("current inspection"),
        snapshot: snapshot({ revision: 10 }),
      },
    });
    expect(state.pluginInspection?.detail).toBe("current inspection");
  });

  it("keeps a changed-install restart recommendation sticky until the user acknowledges restarting Studio", () => {
    let state = reduceAppState(initialAppState, { type: "snapshot.received", snapshot: snapshot({ revision: 1 }) });
    state = reduceAppState(state, {
      type: "request.started",
      key: "plugin.install",
      generation: 1,
      exclusive: true,
    });
    state = reduceAppState(state, {
      type: "request.completed",
      key: "plugin.install",
      generation: 1,
      response: inspected("Plugin changed", true),
    });
    expect(state.studioRestartRecommended).toBe(true);

    state = reduceAppState(state, {
      type: "request.started",
      key: "plugin.inspect",
      generation: 1,
      exclusive: false,
    });
    state = reduceAppState(state, {
      type: "request.completed",
      key: "plugin.inspect",
      generation: 1,
      response: inspected("Bytes now match", false),
    });
    expect(state.pluginInspection?.restartRequired).toBe(false);
    expect(state.studioRestartRecommended).toBe(true);

    state = reduceAppState(state, { type: "studio.restartAcknowledged" } as never);
    expect(state.studioRestartRecommended).toBe(false);
    expect(state.pluginInspection?.detail).toBe("Bytes now match");
  });

  it("stores connection error ownership and clears only the exact project flow", () => {
    const connectionFlow = { projectId: "project-a", flowId: 1 };
    let state = reduceAppState(initialAppState, {
      type: "request.started",
      key: "runtime.selectStudio",
      generation: 1,
      exclusive: true,
      connectionFlow,
    });
    state = reduceAppState(state, {
      type: "request.completed",
      key: "runtime.selectStudio",
      generation: 1,
      response: failure(2),
    });

    expect(state.requests["runtime.selectStudio"]).toMatchObject({
      connectionFlow,
      error: { code: "save-failed" },
    });
    state = reduceAppState(state, {
      type: "connection.errorsCleared",
      connectionFlow: { projectId: "project-a", flowId: 2 },
    });
    state = reduceAppState(state, {
      type: "connection.errorsCleared",
      connectionFlow: { projectId: "project-b", flowId: 1 },
    });
    expect(state.requests["runtime.selectStudio"]?.error).toBeDefined();
    expect(state.lastErrorKey).toBe("runtime.selectStudio");

    state = reduceAppState(state, { type: "connection.errorsCleared", connectionFlow });
    expect(state.requests["runtime.selectStudio"]).toMatchObject({ connectionFlow, inFlight: false });
    expect(state.requests["runtime.selectStudio"]?.error).toBeUndefined();
    expect(state.lastErrorKey).toBeUndefined();
  });

  it("keeps a newer studio-bound event authoritative over a late failed connect response", () => {
    const boundRuntime = {
      ...snapshot().runtimeByProject["project-a"]!,
      state: "studio-bound" as const,
      rojo: { port: 34_872, generation: 2, executablePath: "/tools/rojo", version: "7.8.0" },
      broker: {
        state: "ready" as const,
        primaryPort: 58_741,
        legacyStatus: "unknown" as const,
        brokerEpoch: "epoch-b",
      },
      studio: {
        instanceId: "studio-a",
        placeId: 101,
        placeName: "Deepwater",
        dataModelName: "Deepwater",
        role: "edit",
        pluginVariant: "main",
        pluginVersion: "2.22.5",
        serverVersion: "2.22.5",
        connectedAt: 1,
        lastActivity: 2,
      },
      bindingRevision: 4,
    };
    let state = reduceAppState(initialAppState, { type: "snapshot.received", snapshot: snapshot({ revision: 1 }) });
    state = reduceAppState(state, {
      type: "request.started",
      key: "runtime.connect",
      generation: 1,
      exclusive: true,
    });
    state = reduceAppState(state, {
      type: "snapshot.received",
      snapshot: snapshot({ revision: 8, runtimeByProject: { "project-a": boundRuntime } }),
    });
    state = reduceAppState(state, {
      type: "request.completed",
      key: "runtime.connect",
      generation: 1,
      response: failure(3),
    });
    expect(state.snapshot?.revision).toBe(8);
    expect(state.snapshot?.runtimeByProject["project-a"]?.state).toBe("studio-bound");
  });
});
