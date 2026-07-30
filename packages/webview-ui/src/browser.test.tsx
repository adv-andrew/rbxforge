import { fireEvent, screen, waitFor } from "@testing-library/dom";
import { describe, expect, test, vi } from "vitest";

import { mountWebview, type VsCodeWebviewApi } from "./index.js";
import type { HostMessage, PropertiesSnapshot } from "./protocol.js";

const snapshot: PropertiesSnapshot = {
  snapshotId: "snapshot-1",
  instanceId: "place:123",
  instancePath: "game.Workspace.Part",
  name: "Part",
  className: "Part",
  placeName: "Forge",
  ownership: "studio",
  freshness: "fresh",
  simulation: false,
  connected: true,
  observedAt: 1,
  properties: [
    {
      name: "Anchored",
      category: "Behavior",
      kind: "boolean",
      editable: true,
      liveValue: false,
      declaredValue: false,
      comparable: true,
    },
    {
      name: "Transparency",
      category: "Appearance",
      kind: "number",
      editable: true,
      liveValue: 0.25,
      declaredValue: 0.25,
      comparable: true,
    },
  ],
};

function dispatch(message: HostMessage): void {
  window.dispatchEvent(new MessageEvent("message", { data: message }));
}

function initProperties(requestId = "init-1"): HostMessage {
  return {
    v: 1,
    type: "init",
    sessionId: "session-1",
    requestId,
    generation: 1,
    view: "properties",
  };
}

function propertiesMessage(value: PropertiesSnapshot, requestId: string): HostMessage {
  return {
    v: 1,
    type: "propertiesSnapshot",
    sessionId: "session-1",
    requestId,
    generation: 1,
    snapshot: value,
  };
}

function initAgent(requestId = "agent-init-1"): HostMessage {
  return {
    v: 1,
    type: "init",
    sessionId: "agent-session-1",
    requestId,
    generation: 1,
    view: "agent",
  };
}

function agentSnapshot(requestId: string, status: "ready" | "running" = "ready"): HostMessage {
  return {
    v: 1,
    type: "agentSnapshot",
    sessionId: "agent-session-1",
    requestId,
    generation: 1,
    snapshot: {
      simulation: false,
      connected: true,
      status,
      mode: "ask",
      ...(status === "running" ? { runId: "run-current" } : {}),
      chips: [
        {
          id: "opaque-chip-1",
          label: "Workspace.Door",
          kind: "studio-properties",
        },
      ],
      canRetry: false,
    },
  };
}

test("mounts the real browser entry, revives harmless state, and performs the init/ready handshake", () => {
  document.body.innerHTML = '<main id="root"></main>';
  const postMessage = vi.fn();
  const setState = vi.fn();
  const api: VsCodeWebviewApi = {
    postMessage,
    getState: () => ({ query: "Anchor", apiToken: "discard" }),
    setState,
  };
  const dispose = mountWebview(document.querySelector("#root")!, api, window);

  window.dispatchEvent(
    new MessageEvent("message", {
      data: {
        v: 1,
        type: "init",
        sessionId: "session-1",
        requestId: "init-1",
        generation: 1,
        view: "connection",
      },
    }),
  );

  expect(postMessage).toHaveBeenCalledWith({
    v: 1,
    type: "ready",
    sessionId: "session-1",
    requestId: "ready:init-1",
    generation: 1,
  });
  expect(setState).toHaveBeenCalledWith({});
  dispose();
});

describe("protocol mismatch", () => {
  test("renders a safe Reload state and makes no coerced request", async () => {
    document.body.innerHTML = '<main id="root"></main>';
    const postMessage = vi.fn();
    const reload = vi.fn();
    const api: VsCodeWebviewApi = {
      postMessage,
      getState: () => undefined,
      setState: vi.fn(),
    };
    const dispose = mountWebview(document.querySelector("#root")!, api, window, reload);

    window.dispatchEvent(
      new MessageEvent("message", {
        data: { v: 99, type: "init", sessionId: "bad", requestId: "bad", generation: 1, view: "connection" },
      }),
    );

    expect(await screen.findByRole("heading", { name: "Reload required" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(reload).toHaveBeenCalledTimes(1);
    expect(postMessage).not.toHaveBeenCalled();
    dispose();
  });

  test("rejects replayed init envelopes instead of re-handshaking", async () => {
    document.body.innerHTML = '<main id="root"></main>';
    const postMessage = vi.fn();
    const api: VsCodeWebviewApi = { postMessage, getState: () => undefined, setState: vi.fn() };
    const dispose = mountWebview(document.querySelector("#root")!, api, window, vi.fn());
    const init = {
      v: 1,
      type: "init",
      sessionId: "session-1",
      requestId: "init-1",
      generation: 1,
      view: "connection",
    };
    window.dispatchEvent(new MessageEvent("message", { data: init }));
    window.dispatchEvent(new MessageEvent("message", { data: init }));

    expect(await screen.findByRole("heading", { name: "Reload required" })).toBeTruthy();
    expect(postMessage).toHaveBeenCalledTimes(1);
    dispose();
  });

  test("accepts a same-session next-generation init even when the host reuses init request ID", async () => {
    document.body.innerHTML = '<main id="root"></main>';
    const postMessage = vi.fn();
    const api: VsCodeWebviewApi = { postMessage, getState: () => undefined, setState: vi.fn() };
    const dispose = mountWebview(document.querySelector("#root")!, api, window, vi.fn());
    dispatch({
      v: 1,
      type: "init",
      sessionId: "session-1",
      requestId: "init",
      generation: 1,
      view: "playtest",
    });
    dispatch({
      v: 1,
      type: "init",
      sessionId: "session-1",
      requestId: "init",
      generation: 2,
      view: "playtest",
    });

    expect(postMessage).toHaveBeenCalledTimes(2);
    expect(postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: "ready",
        generation: 2,
      }),
    );
    expect(screen.queryByRole("heading", { name: "Reload required" })).toBeNull();
    dispose();
  });
});

describe("properties browser flow", () => {
  test("applies mutation statuses to the mounted view and refreshes verified truth after completion", async () => {
    document.body.innerHTML = '<main id="root"></main>';
    const postMessage = vi.fn();
    const api: VsCodeWebviewApi = { postMessage, getState: () => ({}), setState: vi.fn() };
    const dispose = mountWebview(document.querySelector("#root")!, api, window);
    dispatch(initProperties());
    dispatch(propertiesMessage(snapshot, "properties-1"));

    fireEvent.change(await screen.findByRole("textbox", { name: "Anchored value" }), {
      target: { value: "true" },
    });
    fireEvent.click(screen.getAllByRole("button", { name: "Apply" })[0]!);

    await waitFor(() =>
      expect((screen.getAllByRole("button", { name: "Apply" })[0] as HTMLButtonElement).disabled).toBe(true),
    );
    expect(postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: "proposePropertyMutation",
        requestId: "webview:1",
      }),
    );

    dispatch({
      v: 1,
      type: "mutationStatus",
      sessionId: "session-1",
      requestId: "operation-1:1",
      generation: 1,
      instanceId: "place:123",
      instancePath: "game.Workspace.Part",
      propertyName: "Anchored",
      state: "approval-pending",
    });
    expect(await screen.findByText("Approval pending")).toBeTruthy();

    dispatch({
      v: 1,
      type: "mutationStatus",
      sessionId: "session-1",
      requestId: "operation-1:2",
      generation: 1,
      instanceId: "place:123",
      instancePath: "game.Workspace.Part",
      propertyName: "Anchored",
      state: "applying",
    });
    expect(await screen.findByText("Applying…")).toBeTruthy();

    dispatch({
      v: 1,
      type: "mutationStatus",
      sessionId: "session-1",
      requestId: "operation-1:3",
      generation: 1,
      instanceId: "place:123",
      instancePath: "game.Workspace.Part",
      propertyName: "Anchored",
      state: "complete",
      verification: "verified",
    });
    expect(await screen.findByText("Verified")).toBeTruthy();
    expect(postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: "refreshProperties",
        requestId: "webview:2",
      }),
    );
    expect((screen.getAllByRole("button", { name: "Apply" })[0] as HTMLButtonElement).disabled).toBe(true);

    dispatch(
      propertiesMessage(
        {
          ...snapshot,
          snapshotId: "snapshot-2",
          observedAt: 2,
          properties: snapshot.properties.map((property) =>
            property.name === "Anchored" ? { ...property, liveValue: true, declaredValue: true } : property,
          ),
        },
        "properties-2",
      ),
    );
    await waitFor(() =>
      expect((screen.getByRole("textbox", { name: "Anchored value" }) as HTMLInputElement).value).toBe("true"),
    );
    dispose();
  });

  test("renders a blocked mutation and keeps the displayed snapshot read-only", async () => {
    document.body.innerHTML = '<main id="root"></main>';
    const api: VsCodeWebviewApi = { postMessage: vi.fn(), getState: () => ({}), setState: vi.fn() };
    const dispose = mountWebview(document.querySelector("#root")!, api, window);
    dispatch(initProperties());
    dispatch(propertiesMessage(snapshot, "properties-1"));
    dispatch({
      v: 1,
      type: "mutationStatus",
      sessionId: "session-1",
      requestId: "operation-2:1",
      generation: 1,
      instanceId: "place:123",
      instancePath: "game.Workspace.Part",
      propertyName: "Anchored",
      state: "blocked",
      detail: "Ownership changed",
    });

    expect(await screen.findByText("Blocked: Ownership changed")).toBeTruthy();
    expect((screen.getAllByRole("button", { name: "Apply" })[0] as HTMLButtonElement).disabled).toBe(true);
    dispose();
  });
});

describe("agent browser flow", () => {
  test("handshakes, streams ordered output, submits explicit context, and resolves approval by IDs only", async () => {
    document.body.innerHTML = '<main id="root"></main>';
    const postMessage = vi.fn();
    const setState = vi.fn();
    const api: VsCodeWebviewApi = {
      postMessage,
      getState: () => ({ agentMode: "debug" }),
      setState,
    };
    const dispose = mountWebview(document.querySelector("#root")!, api, window);

    dispatch(initAgent());
    expect(postMessage).toHaveBeenCalledWith({
      v: 1,
      type: "ready",
      sessionId: "agent-session-1",
      requestId: "ready:agent-init-1",
      generation: 1,
    });
    dispatch(agentSnapshot("agent-snapshot-ready"));

    expect(await screen.findByRole("heading", { name: "Build with Agent" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Debug" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("tab", { name: "Build" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Prompt" }), {
      target: { value: "  Build a secure door  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Build" }));

    expect(postMessage).toHaveBeenLastCalledWith({
      v: 1,
      type: "startAgentRun",
      sessionId: "agent-session-1",
      requestId: "webview:1",
      generation: 1,
      mode: "build",
      prompt: "Build a secure door",
      chipIds: ["opaque-chip-1"],
    });
    expect(setState).toHaveBeenLastCalledWith({ agentMode: "build" });
    expect(JSON.stringify(setState.mock.calls)).not.toMatch(/prompt|Build a secure door|token|secret/i);

    dispatch(agentSnapshot("agent-snapshot-running", "running"));
    dispatch({
      v: 1,
      type: "agentTextDelta",
      sessionId: "agent-session-1",
      requestId: "agent-delta-1",
      generation: 1,
      runId: "run-current",
      sequence: 1,
      delta: "First",
    });
    dispatch({
      v: 1,
      type: "agentTextDelta",
      sessionId: "agent-session-1",
      requestId: "agent-delta-2",
      generation: 1,
      runId: "run-current",
      sequence: 2,
      delta: "Second",
    });
    expect(await screen.findByText("FirstSecond")).toBeTruthy();

    dispatch({
      v: 1,
      type: "agentApproval",
      sessionId: "agent-session-1",
      requestId: "agent-approval-1",
      generation: 1,
      approval: {
        runId: "run-current",
        approvalId: "approval-opaque-1",
        kind: "studio",
        summary: "Set Workspace.Door.Anchored",
        expiresAt: 500,
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));

    expect(postMessage).toHaveBeenLastCalledWith({
      v: 1,
      type: "resolveAgentApproval",
      sessionId: "agent-session-1",
      requestId: "webview:2",
      generation: 1,
      runId: "run-current",
      approvalId: "approval-opaque-1",
      decision: "approve",
    });
    await waitFor(() => {
      expect(screen.queryByText("Set Workspace.Door.Anchored")).toBeNull();
    });
    dispose();
  });

  test("ignores wrong-run deltas without advancing sequence and reloads on a current-run gap", async () => {
    document.body.innerHTML = '<main id="root"></main>';
    const reload = vi.fn();
    const api: VsCodeWebviewApi = {
      postMessage: vi.fn(),
      getState: () => ({}),
      setState: vi.fn(),
    };
    const dispose = mountWebview(document.querySelector("#root")!, api, window, reload);
    dispatch(initAgent());
    dispatch(agentSnapshot("agent-snapshot-running", "running"));

    dispatch({
      v: 1,
      type: "agentTextDelta",
      sessionId: "agent-session-1",
      requestId: "wrong-run-delta",
      generation: 1,
      runId: "run-stale",
      sequence: 1,
      delta: "stale text",
    });
    expect(screen.queryByText("stale text")).toBeNull();

    dispatch({
      v: 1,
      type: "agentTextDelta",
      sessionId: "agent-session-1",
      requestId: "current-run-delta-1",
      generation: 1,
      runId: "run-current",
      sequence: 1,
      delta: "kept text",
    });
    expect(await screen.findByText("kept text")).toBeTruthy();

    dispatch({
      v: 1,
      type: "agentTextDelta",
      sessionId: "agent-session-1",
      requestId: "current-run-delta-3",
      generation: 1,
      runId: "run-current",
      sequence: 3,
      delta: "gap text",
    });
    expect(await screen.findByRole("heading", { name: "Reload required" })).toBeTruthy();
    expect(screen.queryByText("gap text")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(reload).toHaveBeenCalledTimes(1);
    dispose();
  });

  test("reconstructs consecutive bounded multibyte chunks without requesting a reload", async () => {
    document.body.innerHTML = '<main id="root"></main>';
    const reload = vi.fn();
    const api: VsCodeWebviewApi = {
      postMessage: vi.fn(),
      getState: () => ({}),
      setState: vi.fn(),
    };
    const dispose = mountWebview(document.querySelector("#root")!, api, window, reload);
    dispatch(initAgent());
    dispatch(agentSnapshot("agent-snapshot-running", "running"));
    const first = `${"a".repeat(16_380)}💎`;
    const second = `界${"b".repeat(32)}`;

    dispatch({
      v: 1,
      type: "agentTextDelta",
      sessionId: "agent-session-1",
      requestId: "bounded-delta-1",
      generation: 1,
      runId: "run-current",
      sequence: 1,
      delta: first,
    });
    dispatch({
      v: 1,
      type: "agentTextDelta",
      sessionId: "agent-session-1",
      requestId: "bounded-delta-2",
      generation: 1,
      runId: "run-current",
      sequence: 2,
      delta: second,
    });

    expect(await screen.findByText(`${first}${second}`)).toBeTruthy();
    expect(reload).not.toHaveBeenCalled();
    dispose();
  });
});

describe("persisted UI state", () => {
  test("revives and updates only validated harmless query state", async () => {
    document.body.innerHTML = '<main id="root"></main>';
    let persisted: unknown = {
      query: "Anchor",
      collapsedCategories: ["Behavior"],
      scrollAnchor: "Anchored",
    };
    const setState = vi.fn((state: unknown) => {
      persisted = state;
    });
    const api: VsCodeWebviewApi = { postMessage: vi.fn(), getState: () => persisted, setState };
    let dispose = mountWebview(document.querySelector("#root")!, api, window);
    dispatch(initProperties());
    dispatch(propertiesMessage(snapshot, "properties-1"));

    expect(await screen.findByRole("textbox", { name: "Anchored value" })).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Transparency value" })).toBeNull();
    fireEvent.change(screen.getByRole("searchbox", { name: "Filter properties" }), {
      target: { value: "Trans" },
    });
    expect(setState).toHaveBeenLastCalledWith({
      query: "Trans",
      collapsedCategories: ["Behavior"],
      scrollAnchor: "Anchored",
    });
    expect(JSON.stringify(setState.mock.calls)).not.toMatch(/propertyValue|draft|apiToken|secret/i);

    dispose();
    document.body.innerHTML = '<main id="root"></main>';
    dispose = mountWebview(document.querySelector("#root")!, api, window);
    dispatch(initProperties("init-2"));
    dispatch(propertiesMessage(snapshot, "properties-2"));
    expect(await screen.findByRole("textbox", { name: "Transparency value" })).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Anchored value" })).toBeNull();
    dispose();
  });
});
