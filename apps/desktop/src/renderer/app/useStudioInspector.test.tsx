import { StrictMode, type ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { DesktopSnapshot, StudioInspectorNode, StudioInspectorProperty } from "../../shared/domain.js";
import type { DesktopResponse } from "../../shared/protocol.js";
import { snapshot } from "../test/fixtures.js";
import type { DesktopClient } from "./desktop-client.js";
import type { StudioInspectorState } from "./studio-inspector-model.js";
import { useStudioInspector } from "./useStudioInspector.js";

const workspaceNode: StudioInspectorNode = {
  name: "Workspace",
  className: "Workspace",
  path: "game.Workspace",
  hasChildren: true,
};
const partNode: StudioInspectorNode = {
  name: "Part",
  className: "Part",
  path: "game.Workspace.Part",
  hasChildren: false,
};
const nameProperty: StudioInspectorProperty = {
  name: "Name",
  category: "Data",
  value: "Part B",
  valueKind: "string",
};

function boundSnapshot(bindingRevision = 7, brokerEpoch = "epoch-a"): DesktopSnapshot {
  const current = snapshot();
  return snapshot({
    revision: bindingRevision,
    runtimeByProject: {
      "project-a": {
        ...current.runtimeByProject["project-a"]!,
        state: "studio-bound",
        broker: {
          state: "ready",
          primaryPort: 58_741,
          legacyPort: 3_002,
          legacyStatus: "listening",
          brokerEpoch,
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
        bindingRevision,
      },
    },
  });
}

function childrenResponse(
  current: DesktopSnapshot,
  children: readonly StudioInspectorNode[],
  instancePath = "game",
  bindingRevision = 7,
  brokerEpoch = "epoch-a",
): DesktopResponse {
  return {
    version: 1,
    requestId: "children",
    ok: true,
    snapshot: current,
    result: {
      kind: "studio-inspector-children",
      projectId: "project-a",
      instanceId: "studio-a",
      bindingRevision,
      instancePath,
      brokerEpoch,
      observedAt: 100,
      children: [...children],
    },
  };
}

function propertiesResponse(
  current: DesktopSnapshot,
  properties: readonly StudioInspectorProperty[],
  instancePath: string,
  bindingRevision = 7,
  brokerEpoch = "epoch-a",
): DesktopResponse {
  return {
    version: 1,
    requestId: "properties",
    ok: true,
    snapshot: current,
    result: {
      kind: "studio-inspector-properties",
      projectId: "project-a",
      instanceId: "studio-a",
      bindingRevision,
      instancePath,
      brokerEpoch,
      observedAt: 200,
      className: "Part",
      properties: [...properties],
    },
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function fakeClient(options: {
  readonly loadChildren?: DesktopClient["loadStudioChildren"];
  readonly loadProperties?: DesktopClient["loadStudioProperties"];
}): DesktopClient {
  const unexpected = async (): Promise<DesktopResponse> => {
    throw new Error("Unexpected desktop request");
  };
  return {
    platform: "darwin",
    subscribe: () => () => undefined,
    bootstrap: unexpected,
    addProject: unexpected,
    addProjectCandidate: unexpected,
    cancelProjectAdd: () => unexpected,
    copyProjectFile: unexpected,
    selectProject: unexpected,
    removeProject: unexpected,
    createThread: unexpected,
    selectThread: unexpected,
    renameThread: unexpected,
    deleteThread: unexpected,
    saveDraft: unexpected,
    createMessage: unexpected,
    connectRuntime: unexpected,
    selectStudio: unexpected,
    confirmRojoHandoff: unexpected,
    disconnectRuntime: unexpected,
    refreshRuntime: unexpected,
    copyMcpUrl: unexpected,
    copyRojoAddress: unexpected,
    loadStudioChildren: options.loadChildren ?? unexpected,
    loadStudioProperties: options.loadProperties ?? unexpected,
    inspectPlugin: unexpected,
    installPlugin: unexpected,
    showPluginFolder: unexpected,
    chooseRojo: unexpected,
    setMcpPort: unexpected,
    setSidebarWidth: unexpected,
  };
}

describe("useStudioInspector", () => {
  it("opens by loading the root once and exposes the returned child cache", async () => {
    const current = boundSnapshot();
    let calls = 0;
    const client = fakeClient({
      loadChildren: async () => {
        calls += 1;
        return childrenResponse(current, [workspaceNode]);
      },
    });
    const { result } = renderHook(() => useStudioInspector(client, current));

    act(() => result.current.open());

    await waitFor(() =>
      expect(result.current.state.childrenByPath.game).toEqual({
        status: "ready",
        generation: 1,
        rows: [workspaceNode],
      }),
    );
    expect(result.current.state.isOpen).toBe(true);
    expect(calls).toBe(1);
  });

  it("starts only one request when an expansion remains loading through StrictMode effects", async () => {
    const current = boundSnapshot();
    const workspaceChildren = deferred<DesktopResponse>();
    let workspaceCalls = 0;
    const client = fakeClient({
      loadChildren: async (_projectId, _instanceId, _bindingRevision, path) => {
        if (path === "game") return childrenResponse(current, [workspaceNode]);
        workspaceCalls += 1;
        return workspaceChildren.promise;
      },
    });
    const wrapper = ({ children }: { readonly children: ReactNode }) => <StrictMode>{children}</StrictMode>;
    const { result } = renderHook(() => useStudioInspector(client, current), { wrapper });
    act(() => result.current.open());
    await waitFor(() => expect(result.current.state.childrenByPath.game?.status).toBe("ready"));

    act(() => result.current.togglePath("game.Workspace"));

    await waitFor(() =>
      expect(result.current.state.childrenByPath["game.Workspace"]).toMatchObject({
        status: "loading",
      }),
    );
    expect(workspaceCalls).toBe(1);
    workspaceChildren.resolve(childrenResponse(current, [partNode], "game.Workspace"));
    await waitFor(() => expect(result.current.state.childrenByPath["game.Workspace"]?.status).toBe("ready"));
    expect(workspaceCalls).toBe(1);
  });

  it("keeps only the second selection visible when property responses arrive out of order", async () => {
    const current = boundSnapshot();
    const partA = deferred<DesktopResponse>();
    const partB = deferred<DesktopResponse>();
    const client = fakeClient({
      loadChildren: async () => childrenResponse(current, [workspaceNode]),
      loadProperties: async (_projectId, _instanceId, _bindingRevision, path) =>
        path.endsWith("PartA") ? partA.promise : partB.promise,
    });
    const { result } = renderHook(() => useStudioInspector(client, current));
    act(() => result.current.open());
    await waitFor(() => expect(result.current.state.childrenByPath.game?.status).toBe("ready"));

    act(() => result.current.selectPath("game.Workspace.PartA"));
    await waitFor(() =>
      expect(result.current.state.properties).toMatchObject({
        status: "loading",
        path: "game.Workspace.PartA",
      }),
    );
    act(() => result.current.selectPath("game.Workspace.PartB"));
    await waitFor(() =>
      expect(result.current.state.properties).toMatchObject({
        status: "loading",
        path: "game.Workspace.PartB",
      }),
    );

    partB.resolve(propertiesResponse(current, [nameProperty], "game.Workspace.PartB"));
    await waitFor(() =>
      expect(result.current.state.properties).toMatchObject({
        status: "ready",
        path: "game.Workspace.PartB",
        rows: [nameProperty],
      }),
    );
    const accepted = result.current.state.properties;
    partA.resolve(propertiesResponse(current, [{ ...nameProperty, value: "Part A" }], "game.Workspace.PartA"));
    await act(async () => {
      await partA.promise;
    });
    expect(result.current.state.properties).toBe(accepted);
  });

  it("rejects a matching-identity child response for a different requested path", async () => {
    const current = boundSnapshot();
    const client = fakeClient({
      loadChildren: async () => childrenResponse(current, [workspaceNode], "game.ServerStorage"),
    });
    const { result } = renderHook(() => useStudioInspector(client, current));

    act(() => result.current.open());

    await waitFor(() => expect(result.current.state.childrenByPath.game?.status).toBe("error"));
    expect(result.current.state.childrenByPath.game).toMatchObject({
      status: "error",
      message: "Studio inspection could not be completed.",
    });
  });

  it("rejects a matching-identity property response for a different selected path", async () => {
    const current = boundSnapshot();
    const client = fakeClient({
      loadChildren: async () => childrenResponse(current, [workspaceNode]),
      loadProperties: async () => propertiesResponse(current, [nameProperty], "game.Workspace.OtherPart"),
    });
    const { result } = renderHook(() => useStudioInspector(client, current));
    act(() => result.current.open());
    await waitFor(() => expect(result.current.state.childrenByPath.game?.status).toBe("ready"));

    act(() => result.current.selectPath("game.Workspace.Part"));

    await waitFor(() => expect(result.current.state.properties?.status).toBe("error"));
    expect(result.current.state.properties).toMatchObject({
      status: "error",
      path: "game.Workspace.Part",
      message: "Studio inspection could not be completed.",
    });
  });

  it("closes and discards a pending result when the bound identity changes", async () => {
    const original = boundSnapshot();
    const changed = boundSnapshot(8, "epoch-b");
    const pending = deferred<DesktopResponse>();
    const renderedStates: StudioInspectorState[] = [];
    const client = fakeClient({
      loadChildren: async () => pending.promise,
    });
    const { result, rerender } = renderHook(
      ({ current }: { readonly current: DesktopSnapshot }) => {
        const controller = useStudioInspector(client, current);
        renderedStates.push(controller.state);
        return controller;
      },
      { initialProps: { current: original } },
    );
    act(() => result.current.open());
    await waitFor(() => expect(result.current.state.childrenByPath.game?.status).toBe("loading"));

    renderedStates.length = 0;
    rerender({ current: changed });

    expect(renderedStates.at(0)).toMatchObject({
      identity: {
        projectId: "project-a",
        instanceId: "studio-a",
        bindingRevision: 8,
        brokerEpoch: "epoch-b",
      },
      isOpen: false,
      childrenByPath: {},
      expandedPaths: [],
      selectedPath: undefined,
      properties: undefined,
    });
    pending.resolve(childrenResponse(original, [workspaceNode]));
    await act(async () => {
      await pending.promise;
    });
    expect(result.current.state.childrenByPath).toEqual({});
  });

  it("renders a failed desktop response as a bounded child error", async () => {
    const current = boundSnapshot();
    const client = fakeClient({
      loadChildren: async () => ({
        version: 1,
        requestId: "children-failed",
        ok: false,
        snapshot: current,
        error: {
          layer: "studio",
          code: "inspector-failed",
          message: "x".repeat(700),
          recovery: { action: "retry", label: "Retry" },
        },
      }),
    });
    const { result } = renderHook(() => useStudioInspector(client, current));

    act(() => result.current.open());

    await waitFor(() => expect(result.current.state.childrenByPath.game?.status).toBe("error"));
    const root = result.current.state.childrenByPath.game;
    expect(root?.status === "error" ? root.message : "").toBe("x".repeat(500));
  });

  it("does not inspect or apply a response after unmount", async () => {
    const current = boundSnapshot();
    const pending = deferred<DesktopResponse>();
    let responseInspected = false;
    const response = childrenResponse(current, [workspaceNode]);
    const guardedResponse = Object.defineProperty({ ...response }, "ok", {
      enumerable: true,
      get() {
        responseInspected = true;
        return true;
      },
    }) as DesktopResponse;
    const client = fakeClient({
      loadChildren: async () => pending.promise,
    });
    const { result, unmount } = renderHook(() => useStudioInspector(client, current));
    act(() => result.current.open());
    await waitFor(() => expect(result.current.state.childrenByPath.game?.status).toBe("loading"));
    const stateBeforeUnmount = result.current.state;

    unmount();
    pending.resolve(guardedResponse);
    await act(async () => {
      await pending.promise;
    });

    expect(responseInspected).toBe(false);
    expect(result.current.state).toBe(stateBeforeUnmount);
  });
});
