// @vitest-environment jsdom

import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DesktopSnapshot, RuntimeSnapshot, StudioCatalogRow } from "../../shared/domain.js";
import type {
  DesktopCommandInput,
  DesktopEvent,
  DesktopResponse,
  PluginInspectionView,
} from "../../shared/protocol.js";
import { project, snapshot, thread } from "../test/fixtures.js";
import { App } from "./App.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function ok(
  command: DesktopCommandInput,
  options: { revision?: number; result?: Extract<DesktopResponse, { ok: true }>["result"] } = {},
): DesktopResponse {
  return {
    version: 1,
    requestId: command.type,
    ok: true,
    snapshot: snapshot({ revision: options.revision ?? 2 }),
    result: options.result ?? { kind: "none" },
  };
}

type RendererRbxForgeApi = Window["rbxforge"];

function apiHarness(
  handler: (command: DesktopCommandInput) => Promise<DesktopResponse> = async (command) => ok(command),
) {
  const sequence: string[] = [];
  const listeners = new Set<(event: DesktopEvent) => void>();
  let maximumListeners = 0;
  const request = vi.fn(async (command: DesktopCommandInput) => {
    sequence.push(`request:${command.type}`);
    return handler(command);
  });
  const subscribe = vi.fn((listener: (event: DesktopEvent) => void) => {
    sequence.push("subscribe");
    listeners.add(listener);
    maximumListeners = Math.max(maximumListeners, listeners.size);
    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      listeners.delete(listener);
      sequence.push("unsubscribe");
    };
  });
  let closeRequestHandler: (() => Promise<boolean>) | undefined;
  let closeBlockedHandler: ((reason: "save-failed" | "timeout") => void) | undefined;
  const api = {
    platform: "darwin",
    request,
    subscribe,
    onCloseBlocked: vi.fn((handler: (reason: "save-failed" | "timeout") => void) => {
      closeBlockedHandler = handler;
      return () => {
        if (closeBlockedHandler === handler) closeBlockedHandler = undefined;
      };
    }),
    onCloseRequest: vi.fn((handler: () => Promise<boolean>) => {
      closeRequestHandler = handler;
      return () => {
        if (closeRequestHandler === handler) closeRequestHandler = undefined;
      };
    }),
  } as unknown as RendererRbxForgeApi;
  return {
    api,
    request,
    sequence,
    emit(next = snapshot({ revision: 9 })) {
      for (const listener of listeners) listener({ version: 1, type: "snapshot", snapshot: next });
    },
    activeListeners: () => listeners.size,
    maximumListeners: () => maximumListeners,
    closeBlocked: (reason: "save-failed" | "timeout") => {
      closeBlockedHandler?.(reason);
      return closeBlockedHandler !== undefined;
    },
    closeRequest: () => closeRequestHandler?.(),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function holdPrimaryPointerThroughNextMacrotask(target: HTMLElement) {
  fireEvent.pointerDown(target, { button: 0, pointerId: 1, pointerType: "mouse" });
  fireEvent.mouseDown(target, { button: 0 });
  act(() => target.focus());
  await act(async () => {
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
  });
}

function releasePrimaryPointer(target: HTMLElement) {
  fireEvent.pointerUp(target, { button: 0, pointerId: 1, pointerType: "mouse" });
  fireEvent.mouseUp(target, { button: 0 });
  fireEvent.click(target, { button: 0 });
}

function failed(
  command: DesktopCommandInput,
  options: {
    revision?: number;
    layer?: "ipc" | "storage" | "validation" | "rojo" | "mcp";
    recovery?: { action: string; label: string };
  } = {},
): DesktopResponse {
  return {
    version: 1,
    requestId: command.type,
    ok: false,
    snapshot: snapshot({ revision: options.revision ?? 3 }),
    error: {
      layer: options.layer ?? "storage",
      code: `${command.type}-failed`,
      message: "Local desktop data could not be updated.",
      recovery: (options.recovery ?? { action: "retry", label: "Retry" }) as never,
    },
  };
}

function catalogRow(overrides: Partial<StudioCatalogRow> = {}): StudioCatalogRow {
  return {
    instanceId: "studio-instance-a",
    role: "edit",
    placeId: 101,
    placeName: "Deepwater",
    dataModelName: "Deepwater",
    pluginVersion: "2.22.5",
    pluginVariant: "main",
    serverVersion: "2.22.5",
    versionMismatch: false,
    connectedAt: 1,
    lastActivity: 2,
    eligible: true,
    warningRequired: false,
    ...overrides,
  };
}

function runtime(overrides: Partial<RuntimeSnapshot> = {}): RuntimeSnapshot {
  return {
    ...snapshot().runtimeByProject["project-a"]!,
    ...overrides,
  };
}

function boundRuntime(overrides: Partial<RuntimeSnapshot> = {}): RuntimeSnapshot {
  return runtime({
    state: "studio-bound",
    detail: "Studio is explicitly bound for read-only inspection.",
    rojo: {
      port: 34_872,
      generation: 3,
      executablePath: "/tools/rojo",
      version: "7.8.0",
    },
    broker: {
      state: "ready",
      primaryPort: 58_741,
      legacyStatus: "unknown",
      brokerEpoch: "broker-epoch-a",
    },
    studio: {
      instanceId: "studio-instance-a",
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
    bindingRevision: 23,
    ...overrides,
  });
}

function pluginResponse(
  command: DesktopCommandInput,
  current: DesktopSnapshot,
  state: PluginInspectionView["state"] = "installed",
  restartRequired = false,
): DesktopResponse {
  return {
    version: 1,
    requestId: command.type,
    ok: true,
    snapshot: current,
    result: {
      kind: "plugin-inspection",
      inspection: {
        state,
        sourcePath: "/app/MCPPlugin.rbxmx",
        destinationPath: "/plugins/MCPPlugin.rbxmx",
        restartRequired,
        detail: `${state} plugin`,
      },
    },
  };
}

describe("application lifecycle", () => {
  it("subscribes before bootstrap and preserves a newer event that arrives before the response", async () => {
    let resolveBootstrap: ((value: DesktopResponse) => void) | undefined;
    const harness = apiHarness(
      (_command) =>
        new Promise((resolve) => {
          if (command.type === "bootstrap") resolveBootstrap = resolve;
          else resolve(ok(command));
        }),
    );
    render(<App api={harness.api} />);
    expect(harness.sequence.slice(0, 2)).toEqual(["subscribe", "request:bootstrap"]);
    harness.emit(snapshot({ revision: 8, projects: [project({ displayName: "Event project" })] }));
    resolveBootstrap?.(ok({ type: "bootstrap" }, { revision: 3 }));
    expect(await screen.findByRole("button", { name: "Event project" })).not.toBeNull();
  });

  it("keeps at most one subscription through StrictMode and cleans it up", async () => {
    const harness = apiHarness();
    const view = render(
      <StrictMode>
        <App api={harness.api} />
      </StrictMode>,
    );
    await screen.findByRole("navigation", { name: "Projects and conversations" });
    expect(harness.maximumListeners()).toBe(1);
    expect(harness.activeListeners()).toBe(1);
    view.unmount();
    expect(harness.activeListeners()).toBe(0);
  });

  it("shows a bounded bootstrap error and retries without adding a subscription", async () => {
    let attempts = 0;
    const harness = apiHarness(async (command) => {
      attempts += 1;
      if (attempts === 1) {
        return {
          version: 1,
          requestId: "bootstrap",
          ok: false,
          snapshot: snapshot({ revision: 1 }),
          error: {
            layer: "ipc",
            code: "bootstrap-failed",
            message: "The desktop host could not complete the request.",
            recovery: { action: "retry", label: "Retry" },
          },
        };
      }
      return ok(command, { revision: 2 });
    });
    render(<App api={harness.api} />);
    expect(await screen.findByText("The desktop host could not complete the request.")).not.toBeNull();
    expect(screen.getByText("IPC")).not.toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByRole("button", { name: "Deepwater" });
    expect(harness.maximumListeners()).toBe(1);
    expect(harness.request).toHaveBeenCalledTimes(2);
  });

  it("keeps a newer event ready when a truly deferred older bootstrap fails", async () => {
    const bootstrap = deferred<DesktopResponse>();
    const harness = apiHarness(async (command) => (command.type === "bootstrap" ? bootstrap.promise : ok(command)));
    render(<App api={harness.api} />);
    harness.emit(
      snapshot({
        revision: 9,
        projects: [project({ displayName: "Event project" })],
      }),
    );
    expect(await screen.findByRole("button", { name: "Event project" })).not.toBeNull();
    bootstrap.resolve(failed({ type: "bootstrap" }, { revision: 3 }));
    await waitFor(() => expect(screen.getByText("Local desktop data could not be updated.")).not.toBeNull());
    expect(screen.getByRole("button", { name: "Event project" })).not.toBeNull();
    expect(screen.getByRole("main", { name: "Conversation" }).textContent).not.toContain(
      "RbxForge could not load local data",
    );
  });
});

describe("project-scoped shell flows", () => {
  it("sends only project.add and renders only opaque host candidate display fields", async () => {
    const harness = apiHarness(async (command) => {
      if (command.type === "project.add") {
        return ok(command, {
          result: {
            kind: "project-candidates",
            selectionId: "selection-opaque",
            candidates: [
              {
                candidateId: "candidate-opaque",
                displayName: "Game",
                relativeProjectFile: "games/default.project.json",
              },
            ],
          },
        });
      }
      return ok(command);
    });
    render(<App api={harness.api} />);
    await userEvent.click(await screen.findByRole("button", { name: "Add project" }));
    expect(screen.getByText("Game")).not.toBeNull();
    expect(screen.getByText("games/default.project.json")).not.toBeNull();
    expect(document.body.textContent).not.toContain("/projects/deepwater");
    expect(harness.request.mock.calls[1]?.[0]).toEqual({ type: "project.add", expectedRevision: 2 });
    await userEvent.click(screen.getByRole("button", { name: /Game.*games\/default\.project\.json/ }));
    expect(harness.request.mock.calls[2]?.[0]).toEqual({
      type: "project.addCandidate",
      selectionId: "selection-opaque",
      candidateId: "candidate-opaque",
      expectedRevision: 2,
    });
  });

  it("cancels a candidate selection exactly once when dismissed", async () => {
    const harness = apiHarness(async (command) =>
      command.type === "project.add"
        ? ok(command, {
            result: {
              kind: "project-candidates",
              selectionId: "selection-opaque",
              candidates: [{ candidateId: "candidate-a", displayName: "Game", relativeProjectFile: "a.project.json" }],
            },
          })
        : ok(command),
    );
    render(<App api={harness.api} />);
    await userEvent.click(await screen.findByRole("button", { name: "Add project" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel project selection" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(harness.request.mock.calls.filter(([command]) => command.type === "project.cancelAdd")).toHaveLength(1);
  });

  it("switches a project using only project.select and restores its owned selected thread", async () => {
    const populated = snapshot({
      projects: [project(), project({ id: "project-b", displayName: "Obby" })],
      threads: [thread(), thread({ id: "thread-b", projectId: "project-b", title: "Obby ideas" })],
      selectedThreadIdByProject: { "project-a": "thread-a", "project-b": "thread-b" },
    });
    const harness = apiHarness(async (command) =>
      ok(command, {
        revision: 3,
        result: { kind: "none" },
      }),
    );
    harness.api.request = vi.fn(async (command) => {
      harness.sequence.push(`request:${command.type}`);
      return command.type === "bootstrap"
        ? { ...ok(command), snapshot: populated }
        : {
            ...ok(command, { revision: 3 }),
            snapshot: { ...populated, revision: 3, selectedProjectId: "project-b" },
          };
    });
    render(<App api={harness.api} />);
    await userEvent.click(await screen.findByRole("button", { name: "Obby" }));
    expect(await screen.findByRole("button", { name: "Obby ideas" })).not.toBeNull();
    const postBootstrap = harness.api.request.mock.calls.slice(1).map(([command]) => command.type);
    expect(postBootstrap).toEqual(["project.select"]);
    expect(postBootstrap.some((type) => type.startsWith("runtime."))).toBe(false);
  });

  it("has a visible-on-focus skip link and semantic aside/nav/header/main landmarks", async () => {
    const harness = apiHarness();
    render(<App api={harness.api} />);
    const skip = await screen.findByRole("link", { name: "Skip to conversation" });
    expect(skip.getAttribute("href")).toBe("#conversation");
    expect(screen.getByRole("complementary", { name: "RbxForge projects" })).not.toBeNull();
    expect(screen.getByRole("navigation", { name: "Projects and conversations" })).not.toBeNull();
    expect(screen.getByRole("banner", { name: "Project status" })).not.toBeNull();
    expect(screen.getByRole("main", { name: "Conversation" })).not.toBeNull();
    const ordered = [
      skip,
      screen.getByRole("button", { name: "Add project" }),
      screen.getByRole("button", { name: "Deepwater" }),
      screen.getByRole("button", { name: "New chat" }),
      screen.getByRole("region", { name: "Conversation history" }),
      screen.getByRole("textbox", { name: "Local project prompt" }),
    ];
    for (let index = 0; index < ordered.length - 1; index += 1) {
      expect(ordered[index]?.compareDocumentPosition(ordered[index + 1]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING,
      );
    }
    expect(document.querySelector("[tabindex]:not([tabindex='-1']):not([tabindex='0'])")).toBeNull();
  });

  it("uses one nonce-bearing sidebar rule and no inline style attributes", async () => {
    const nonceMeta = document.createElement("meta");
    nonceMeta.setAttribute("property", "csp-nonce");
    nonceMeta.nonce = "test-renderer-nonce";
    document.head.append(nonceMeta);
    try {
      const harness = apiHarness();
      render(<App api={harness.api} />);
      await screen.findByRole("main", { name: "Conversation" });
      expect(document.querySelectorAll("[style]")).toHaveLength(0);
      const sidebarRules = [...document.querySelectorAll("style")].filter((style) =>
        style.textContent?.includes("--sidebar-width"),
      );
      expect(sidebarRules).toHaveLength(1);
      expect(sidebarRules[0]?.nonce).toBe("test-renderer-nonce");
      expect(sidebarRules[0]?.textContent).toMatch(/\.[^\s]+ \{ --sidebar-width: (?:232|2\d\d|3[0-5]\d|360)px; \}/);
    } finally {
      nonceMeta.remove();
    }
  });

  it("stores one local user prompt and trusts the transactional message snapshot without a second draft clear", async () => {
    const harness = apiHarness(async (command) => ok(command, { revision: 3 }));
    render(<App api={harness.api} />);
    const composer = await screen.findByRole("textbox", { name: "Local project prompt" });
    await userEvent.type(composer, "Build a lobby");
    fireEvent.keyDown(composer, { key: "Enter", metaKey: true });
    await waitFor(() =>
      expect(harness.request.mock.calls.filter(([command]) => command.type === "message.create")).toHaveLength(1),
    );
    expect((composer as HTMLTextAreaElement).value).toBe("");
    expect(await screen.findByText("Prompt saved locally")).not.toBeNull();
    expect(harness.request.mock.calls.filter(([command]) => command.type === "draft.save")).toEqual([]);
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(document.body.textContent).not.toMatch(/assistant|thinking|generating/i);
  });

  it("clears only the submitted thread after message.create and preserves the sibling host draft", async () => {
    let current = snapshot({
      revision: 2,
      threads: [thread(), thread({ id: "thread-b", title: "Second chat" })],
      drafts: [
        { threadId: "thread-a", content: "Alpha host draft", updatedAt: 1 },
        { threadId: "thread-b", content: "Beta host draft", updatedAt: 1 },
      ],
      selectedThreadIdByProject: { "project-a": "thread-a" },
    });
    const harness = apiHarness(async (command) => {
      if (command.type === "bootstrap") return { ...ok(command), snapshot: current };
      if (command.type === "message.create") {
        current = {
          ...current,
          revision: 3,
          drafts: current.drafts.filter(({ threadId }) => threadId !== command.threadId),
        };
      }
      if (command.type === "thread.select") {
        current = {
          ...current,
          revision: 4,
          selectedThreadIdByProject: { "project-a": command.threadId },
        };
      }
      return { ...ok(command, { revision: current.revision }), snapshot: current };
    });
    render(<App api={harness.api} />);
    const composer = await screen.findByRole<HTMLTextAreaElement>("textbox", { name: "Local project prompt" });
    expect(composer.value).toBe("Alpha host draft");
    await userEvent.clear(composer);
    await userEvent.type(composer, "Submit only alpha");
    fireEvent.keyDown(composer, { key: "Enter", metaKey: true });
    expect(await screen.findByText("Prompt saved locally")).not.toBeNull();
    expect(composer.value).toBe("");
    expect(harness.request.mock.calls.filter(([command]) => command.type === "message.create")).toHaveLength(1);
    expect(harness.request.mock.calls.filter(([command]) => command.type === "draft.save")).toHaveLength(0);

    await userEvent.click(screen.getByRole("button", { name: "Second chat" }));
    await waitFor(() => expect(composer.value).toBe("Beta host draft"));
  });

  it("retains the exact draft when storing a prompt fails", async () => {
    const harness = apiHarness(async (command) =>
      command.type === "message.create"
        ? {
            version: 1,
            requestId: "message.create",
            ok: false,
            snapshot: snapshot({ revision: 3 }),
            error: {
              layer: "storage",
              code: "message-failed",
              message: "Local desktop data could not be updated.",
              recovery: { action: "retry", label: "Retry" },
            },
          }
        : ok(command),
    );
    render(<App api={harness.api} />);
    const composer = await screen.findByRole("textbox", { name: "Local project prompt" });
    await userEvent.type(composer, "Keep this draft");
    fireEvent.keyDown(composer, { key: "Enter", ctrlKey: true });
    await screen.findByText("Local desktop data could not be updated.");
    expect((composer as HTMLTextAreaElement).value).toBe("Keep this draft");
  });

  it("emits one success toast after a host-confirmed conversation rename", async () => {
    const harness = apiHarness(async (command) => ok(command, { revision: 3 }));
    render(<App api={harness.api} />);
    await userEvent.click(await screen.findByRole("button", { name: "Actions for New chat" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    const input = screen.getByRole("textbox", { name: "Conversation name" });
    await userEvent.clear(input);
    await userEvent.type(input, "Round plan");
    await userEvent.click(screen.getByRole("button", { name: "Rename conversation" }));
    expect(await screen.findByText("Conversation renamed")).not.toBeNull();
    expect(screen.getAllByText("Conversation renamed")).toHaveLength(1);
  });

  it("renders stable loading, no-project, no-thread, empty, and safe error states", async () => {
    let resolveBootstrap: ((value: DesktopResponse) => void) | undefined;
    const harness = apiHarness(
      (_command) =>
        new Promise((resolve) => {
          resolveBootstrap = resolve;
        }),
    );
    const view = render(<App api={harness.api} />);
    expect(screen.getAllByTestId("skeleton").length).toBeGreaterThan(2);
    resolveBootstrap?.({
      ...ok({ type: "bootstrap" }),
      snapshot: snapshot({ projects: [], threads: [], drafts: [], selectedProjectId: undefined }),
    });
    const onboarding = (await screen.findByRole("heading", { name: "Build locally with RbxForge" })).closest("section");
    expect(onboarding).not.toBeNull();
    expect(
      screen.getByText("Add a Roblox project, save prompts locally, then connect Studio when you are ready."),
    ).not.toBeNull();
    expect(screen.getByTestId("onboarding-mark").getAttribute("aria-hidden")).toBe("true");
    expect(onboarding?.querySelector("button")?.textContent).toBe("Add project");

    const noThread = apiHarness(async (command) => ({
      ...ok(command),
      snapshot: snapshot({ threads: [], drafts: [], selectedThreadIdByProject: {} }),
    }));
    view.unmount();
    render(<App api={noThread.api} />);
    expect(await screen.findByText("Create a local conversation for this project.")).not.toBeNull();
    expect(screen.getByRole("button", { name: "New chat" })).not.toBeNull();
  });
});

describe("Studio Inspector integration", () => {
  it("opens from the complete bound header, requests game once, and keeps the conversation mounted", async () => {
    const current = snapshot({
      revision: 2,
      runtimeByProject: { "project-a": boundRuntime() },
    });
    const harness = apiHarness(async (command) => {
      if (command.type === "bootstrap") return { ...ok(command), snapshot: current };
      if (command.type === "studioInspector.children") {
        return {
          ...ok(command, {
            result: {
              kind: "studio-inspector-children",
              projectId: command.projectId,
              instanceId: command.instanceId,
              bindingRevision: command.bindingRevision,
              brokerEpoch: "broker-epoch-a",
              observedAt: 10,
              instancePath: command.instancePath,
              children: [
                {
                  name: "Workspace",
                  className: "Workspace",
                  path: "game.Workspace",
                  hasChildren: true,
                },
              ],
            },
          }),
          snapshot: current,
        };
      }
      return { ...ok(command), snapshot: current };
    });
    render(<App api={harness.api} />);

    const composer = await screen.findByRole("textbox", { name: "Local project prompt" });
    const conversation = screen.getByRole("main", { name: "Conversation" });
    const opener = await screen.findByRole("button", { name: "Inspect Studio" });
    await userEvent.click(opener);

    expect(await screen.findByRole("complementary", { name: "Studio inspector" })).not.toBeNull();
    expect(await screen.findByRole("treeitem", { name: /Workspace/ })).not.toBeNull();
    expect(conversation.contains(composer)).toBe(true);
    expect(harness.request.mock.calls.filter(([command]) => command.type === "studioInspector.children")).toEqual([
      [
        {
          type: "studioInspector.children",
          projectId: "project-a",
          instanceId: "studio-instance-a",
          bindingRevision: 23,
          instancePath: "game",
          expectedRevision: 2,
        },
      ],
    ]);

    await userEvent.click(screen.getByRole("button", { name: "Close Studio inspector" }));
    expect(screen.queryByRole("complementary", { name: "Studio inspector" })).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("loads the exact selected node and displays its read-only properties", async () => {
    const current = snapshot({
      revision: 2,
      runtimeByProject: { "project-a": boundRuntime() },
    });
    const harness = apiHarness(async (command) => {
      if (command.type === "bootstrap") return { ...ok(command), snapshot: current };
      if (command.type === "studioInspector.children") {
        return {
          ...ok(command, {
            result: {
              kind: "studio-inspector-children",
              projectId: command.projectId,
              instanceId: command.instanceId,
              bindingRevision: command.bindingRevision,
              brokerEpoch: "broker-epoch-a",
              observedAt: 10,
              instancePath: command.instancePath,
              children: [
                {
                  name: "Workspace",
                  className: "Workspace",
                  path: "game.Workspace",
                  hasChildren: false,
                },
              ],
            },
          }),
          snapshot: current,
        };
      }
      if (command.type === "studioInspector.properties") {
        return {
          ...ok(command, {
            result: {
              kind: "studio-inspector-properties",
              projectId: command.projectId,
              instanceId: command.instanceId,
              bindingRevision: command.bindingRevision,
              brokerEpoch: "broker-epoch-a",
              observedAt: 11,
              instancePath: command.instancePath,
              className: "Workspace",
              properties: [{ name: "Gravity", category: "Behavior", value: "196.2", valueKind: "number" }],
            },
          }),
          snapshot: current,
        };
      }
      return { ...ok(command), snapshot: current };
    });
    render(<App api={harness.api} />);

    await userEvent.click(await screen.findByRole("button", { name: "Inspect Studio" }));
    await userEvent.click(await screen.findByRole("treeitem", { name: /Workspace/ }));
    expect(await screen.findByText("Gravity")).not.toBeNull();
    expect(document.querySelector("code[title='196.2']")?.textContent).toBe("196.2");
    expect(harness.request.mock.calls.filter(([command]) => command.type === "studioInspector.properties")).toEqual([
      [
        {
          type: "studioInspector.properties",
          projectId: "project-a",
          instanceId: "studio-instance-a",
          bindingRevision: 23,
          instancePath: "game.Workspace",
          expectedRevision: 2,
        },
      ],
    ]);
  });

  it("removes and clears the inspector synchronously when the binding revision changes", async () => {
    let current = snapshot({
      revision: 2,
      runtimeByProject: { "project-a": boundRuntime() },
    });
    const harness = apiHarness(async (command) => {
      if (command.type === "bootstrap") return { ...ok(command), snapshot: current };
      if (command.type === "studioInspector.children") {
        const name = command.bindingRevision === 23 ? "OldWorkspace" : "NewWorkspace";
        return {
          ...ok(command, {
            result: {
              kind: "studio-inspector-children",
              projectId: command.projectId,
              instanceId: command.instanceId,
              bindingRevision: command.bindingRevision,
              brokerEpoch: "broker-epoch-a",
              observedAt: 10,
              instancePath: command.instancePath,
              children: [{ name, className: "Workspace", path: `game.${name}`, hasChildren: false }],
            },
          }),
          snapshot: current,
        };
      }
      return { ...ok(command), snapshot: current };
    });
    render(<App api={harness.api} />);

    await userEvent.click(await screen.findByRole("button", { name: "Inspect Studio" }));
    expect(await screen.findByRole("treeitem", { name: /OldWorkspace/ })).not.toBeNull();

    current = snapshot({
      revision: 3,
      runtimeByProject: { "project-a": boundRuntime({ bindingRevision: 24 }) },
    });
    act(() => harness.emit(current));
    expect(screen.queryByRole("complementary", { name: "Studio inspector" })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Inspect Studio" }));
    expect(await screen.findByRole("treeitem", { name: /NewWorkspace/ })).not.toBeNull();
    expect(screen.queryByRole("treeitem", { name: /OldWorkspace/ })).toBeNull();
    const reads = harness.request.mock.calls
      .map(([command]) => command)
      .filter((command) => command.type === "studioInspector.children");
    expect(reads.map((command) => command.bindingRevision)).toEqual([23, 24]);
  });

  it("clears an open inspector on project selection and withholds the action while disconnected", async () => {
    const projectB = project({ id: "project-b", displayName: "Obby" });
    let current = snapshot({
      revision: 2,
      projects: [project(), projectB],
      threads: [thread(), thread({ id: "thread-b", projectId: "project-b", title: "Obby ideas" })],
      selectedThreadIdByProject: { "project-a": "thread-a", "project-b": "thread-b" },
      runtimeByProject: {
        "project-a": boundRuntime(),
        "project-b": boundRuntime({
          detail: "Obby is disconnected.",
          state: "disconnected",
          broker: undefined,
          studio: undefined,
          bindingRevision: undefined,
          rojo: undefined,
        }),
      },
    });
    const harness = apiHarness(async (command) => {
      if (command.type === "bootstrap") return { ...ok(command), snapshot: current };
      if (command.type === "studioInspector.children") {
        return {
          ...ok(command, {
            result: {
              kind: "studio-inspector-children",
              projectId: command.projectId,
              instanceId: command.instanceId,
              bindingRevision: command.bindingRevision,
              brokerEpoch: "broker-epoch-a",
              observedAt: 10,
              instancePath: command.instancePath,
              children: [],
            },
          }),
          snapshot: current,
        };
      }
      if (command.type === "project.select") {
        current = { ...current, revision: 3, selectedProjectId: command.projectId };
      }
      return { ...ok(command), snapshot: current };
    });
    render(<App api={harness.api} />);

    await userEvent.click(await screen.findByRole("button", { name: "Inspect Studio" }));
    expect(await screen.findByRole("complementary", { name: "Studio inspector" })).not.toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Obby" }));
    await screen.findByRole("button", { name: "Obby ideas" });
    expect(screen.queryByRole("complementary", { name: "Studio inspector" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Inspect Studio" })).toBeNull();
    expect(screen.getByRole("textbox", { name: "Local project prompt" })).not.toBeNull();
  });
});

describe("explicit connection workflow integration", () => {
  it("inspects exactly once per open in StrictMode and only then starts a disconnected runtime", async () => {
    const current = snapshot({ revision: 2 });
    const harness = apiHarness(async (command) => {
      if (command.type === "bootstrap") return { ...ok(command), snapshot: current };
      if (command.type === "plugin.inspect") return pluginResponse(command, current);
      return { ...ok(command, { revision: 3 }), snapshot: { ...current, revision: 3 } };
    });
    render(
      <StrictMode>
        <App api={harness.api} />
      </StrictMode>,
    );

    await userEvent.click(await screen.findByRole("button", { name: "Reconnect" }));
    expect(await screen.findByRole("dialog", { name: "Connection setup" })).not.toBeNull();
    await waitFor(() =>
      expect(
        harness.request.mock.calls
          .map(([command]) => command.type)
          .filter((type) => type === "plugin.inspect" || type === "runtime.connect"),
      ).toEqual(["plugin.inspect", "runtime.connect"]),
    );
  });

  it("does not start the runtime when inspection or installation says the plugin needs attention", async () => {
    const current = snapshot({ revision: 2 });
    const harness = apiHarness(async (command) => {
      if (command.type === "bootstrap") return { ...ok(command), snapshot: current };
      if (command.type === "plugin.inspect") return pluginResponse(command, current, "missing");
      if (command.type === "plugin.install") {
        return pluginResponse(command, { ...current, revision: 3 }, "installed", true);
      }
      return { ...ok(command), snapshot: current };
    });
    render(<App api={harness.api} />);

    await userEvent.click(await screen.findByRole("button", { name: "Reconnect" }));
    const install = await screen.findByRole("button", { name: "Install Studio plugin" });
    expect(harness.request.mock.calls.filter(([command]) => command.type === "runtime.connect")).toHaveLength(0);
    await userEvent.click(install);
    expect(await screen.findByText("Restart Studio before continuing.")).not.toBeNull();
    expect(harness.request.mock.calls.filter(([command]) => command.type === "runtime.connect")).toHaveLength(0);
  });

  it("continues only after an explicit Studio-restarted acknowledgement and a fresh clean inspection", async () => {
    let current = snapshot({ revision: 2 });
    let inspectionAttempts = 0;
    const harness = apiHarness(async (command) => {
      if (command.type === "bootstrap") return { ...ok(command), snapshot: current };
      if (command.type === "plugin.inspect") {
        inspectionAttempts += 1;
        return pluginResponse(command, current, inspectionAttempts === 1 ? "missing" : "installed");
      }
      if (command.type === "plugin.install") {
        current = { ...current, revision: 3 };
        return pluginResponse(command, current, "installed", true);
      }
      return { ...ok(command), snapshot: current };
    });
    render(<App api={harness.api} />);

    await userEvent.click(await screen.findByRole("button", { name: "Reconnect" }));
    await userEvent.click(await screen.findByRole("button", { name: "Install Studio plugin" }));
    expect(await screen.findByText("Restart Studio before continuing.")).not.toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Close connection setup" }));
    await userEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    await waitFor(() =>
      expect(harness.request.mock.calls.filter(([command]) => command.type === "plugin.inspect")).toHaveLength(2),
    );
    expect(await screen.findByText("Restart Studio before continuing.")).not.toBeNull();
    expect(harness.request.mock.calls.filter(([command]) => command.type === "runtime.connect")).toHaveLength(0);

    await userEvent.click(screen.getByRole("button", { name: "Studio restarted" }));
    await waitFor(() =>
      expect(harness.request.mock.calls.filter(([command]) => command.type === "plugin.inspect")).toHaveLength(3),
    );
    expect(harness.request.mock.calls.filter(([command]) => command.type === "runtime.connect")).toHaveLength(1);
  });

  it("does not continue from inspection into connect after the user closes the sheet", async () => {
    const current = snapshot({ revision: 2 });
    const inspection = deferred<DesktopResponse>();
    const harness = apiHarness(async (command) => {
      if (command.type === "bootstrap") return { ...ok(command), snapshot: current };
      if (command.type === "plugin.inspect") return inspection.promise;
      return { ...ok(command), snapshot: current };
    });
    render(<App api={harness.api} />);
    await userEvent.click(await screen.findByRole("button", { name: "Reconnect" }));
    await userEvent.click(screen.getByRole("button", { name: "Close connection setup" }));
    inspection.resolve(pluginResponse({ type: "plugin.inspect" }, current));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(harness.request.mock.calls.filter(([command]) => command.type === "runtime.connect")).toHaveLength(0);
  });

  it("restores focus to the guarded header action when setup closes during connect", async () => {
    const current = snapshot({ revision: 2 });
    const connect = deferred<DesktopResponse>();
    const harness = apiHarness(async (command) => {
      if (command.type === "bootstrap") return { ...ok(command), snapshot: current };
      if (command.type === "plugin.inspect") return pluginResponse(command, current);
      if (command.type === "runtime.connect") return connect.promise;
      return { ...ok(command), snapshot: current };
    });
    render(<App api={harness.api} />);

    await userEvent.click(await screen.findByRole("button", { name: "Reconnect" }));
    await waitFor(() =>
      expect(harness.request.mock.calls.filter(([command]) => command.type === "runtime.connect")).toHaveLength(1),
    );
    const connecting = screen.getByRole<HTMLButtonElement>("button", { name: "Connecting…", hidden: true });
    expect(connecting.disabled).toBe(false);
    expect(connecting.getAttribute("aria-disabled")).toBe("true");

    await userEvent.click(screen.getByRole("button", { name: "Close connection setup" }));

    expect(document.activeElement).toBe(connecting);
    await userEvent.click(connecting);
    expect(harness.request.mock.calls.filter(([command]) => command.type === "plugin.inspect")).toHaveLength(1);
    connect.resolve({ ...ok({ type: "runtime.connect", projectId: "project-a" }), snapshot: current });
  });

  it("keeps a newer bound event authoritative when an older connect response fails", async () => {
    const current = snapshot({ revision: 2 });
    const connect = deferred<DesktopResponse>();
    const harness = apiHarness(async (command) => {
      if (command.type === "bootstrap") return { ...ok(command), snapshot: current };
      if (command.type === "plugin.inspect") return pluginResponse(command, current);
      if (command.type === "runtime.connect") return connect.promise;
      return { ...ok(command), snapshot: current };
    });
    render(<App api={harness.api} />);
    await userEvent.click(await screen.findByRole("button", { name: "Reconnect" }));
    await waitFor(() =>
      expect(harness.request.mock.calls.filter(([command]) => command.type === "runtime.connect")).toHaveLength(1),
    );

    const bound = runtime({
      state: "studio-bound",
      rojo: { port: 34_872, generation: 3, executablePath: "/tools/rojo", version: "7.8.0" },
      broker: {
        state: "ready",
        primaryPort: 58_741,
        legacyPort: 3_002,
        legacyStatus: "listening",
        brokerEpoch: "broker-epoch-new",
      },
      studio: {
        instanceId: "studio-instance-new",
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
      bindingRevision: 31,
    });
    harness.emit(snapshot({ revision: 9, runtimeByProject: { "project-a": bound } }));
    expect(await screen.findByText("Studio bound after your manual Rojo handoff confirmation.")).not.toBeNull();
    connect.resolve(failed({ type: "runtime.connect", projectId: "project-a" }, { revision: 3, layer: "rojo" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText("Studio bound after your manual Rojo handoff confirmation.")).not.toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Close connection setup" }));
    expect(screen.getByRole("button", { name: "Connection details" })).not.toBeNull();
  });

  it("keeps connection failures inside setup and out of the conversation pane", async () => {
    const initial = snapshot({ revision: 2 });
    const connectionFailure = {
      layer: "app" as const,
      code: "operation-failed",
      message: "The desktop operation could not be completed.",
      recovery: { action: "retry" as const, label: "Retry" },
    };
    const failedRuntime = runtime({
      state: "error",
      detail: connectionFailure.message,
      error: connectionFailure,
    });
    const failedSnapshot = snapshot({
      revision: 3,
      runtimeByProject: { "project-a": failedRuntime },
    });
    const harness = apiHarness(async (command) => {
      if (command.type === "bootstrap") return { ...ok(command), snapshot: initial };
      if (command.type === "plugin.inspect") return pluginResponse(command, initial);
      if (command.type === "runtime.connect") {
        return {
          version: 1,
          requestId: command.type,
          ok: false,
          snapshot: failedSnapshot,
          error: connectionFailure,
        };
      }
      return { ...ok(command), snapshot: failedSnapshot };
    });
    render(<App api={harness.api} />);

    await userEvent.click(await screen.findByRole("button", { name: "Reconnect" }));

    const dialog = await screen.findByRole("dialog", { name: "Connection setup" });
    expect(within(dialog).getByText(connectionFailure.message)).not.toBeNull();
    expect(within(screen.getByRole("main", { hidden: true })).queryByText(connectionFailure.message)).toBeNull();
  });

  it("clears a failed Studio selection after a successful refresh in the same connection flow", async () => {
    const selectionError = {
      layer: "studio" as const,
      code: "studio-selection-stale",
      message: "The selected Studio instance became stale.",
      recovery: { action: "refresh" as const, label: "Refresh Studio list" },
    };
    let current = snapshot({
      revision: 2,
      runtimeByProject: {
        "project-a": runtime({
          state: "studio-selection-required",
          rojo: { port: 34_872, generation: 3, executablePath: "/tools/rojo", version: "7.8.0" },
          broker: {
            state: "ready",
            primaryPort: 58_741,
            legacyStatus: "unknown",
            brokerEpoch: "broker-epoch-a",
          },
          catalog: [catalogRow()],
          catalogRevision: 7,
        }),
      },
    });
    const harness = apiHarness(async (command) => {
      if (command.type === "bootstrap") return { ...ok(command), snapshot: current };
      if (command.type === "plugin.inspect") return pluginResponse(command, current);
      if (command.type === "runtime.selectStudio") {
        return {
          version: 1,
          requestId: command.type,
          ok: false,
          snapshot: current,
          error: selectionError,
        };
      }
      if (command.type === "runtime.refresh") {
        current = { ...current, revision: 3 };
      }
      return { ...ok(command, { revision: current.revision }), snapshot: current };
    });
    render(<App api={harness.api} />);

    await userEvent.click(await screen.findByRole("button", { name: "Continue setup" }));
    await userEvent.click(await screen.findByRole("radio", { name: /Deepwater.*101/ }));
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText(selectionError.message)).not.toBeNull();
    await userEvent.click(within(alert).getByRole("button", { name: "Refresh Studio list" }));

    await waitFor(() => expect(screen.queryByText(selectionError.message)).toBeNull());
  });

  it("does not expose a late connection failure from a dismissed project flow in another project's sheet", async () => {
    const projectASelection = deferred<DesktopResponse>();
    const projectAError = {
      layer: "studio" as const,
      code: "project-a-selection-failed",
      message: "Project A Studio selection failed.",
      recovery: { action: "refresh" as const, label: "Refresh Studio list" },
    };
    const selectionRuntime = (catalog: StudioCatalogRow): RuntimeSnapshot =>
      runtime({
        state: "studio-selection-required",
        rojo: { port: 34_872, generation: 3, executablePath: "/tools/rojo", version: "7.8.0" },
        broker: {
          state: "ready",
          primaryPort: 58_741,
          legacyStatus: "unknown",
          brokerEpoch: `broker-${catalog.instanceId}`,
        },
        catalog: [catalog],
        catalogRevision: 7,
      });
    let current = snapshot({
      revision: 2,
      projects: [project(), project({ id: "project-b", displayName: "Obby" })],
      threads: [thread(), thread({ id: "thread-b", projectId: "project-b", title: "Obby ideas" })],
      selectedThreadIdByProject: { "project-a": "thread-a", "project-b": "thread-b" },
      runtimeByProject: {
        "project-a": selectionRuntime(catalogRow()),
        "project-b": selectionRuntime(
          catalogRow({ instanceId: "studio-instance-b", placeId: 202, placeName: "Obby", dataModelName: "Obby" }),
        ),
      },
    });
    const harness = apiHarness(async (command) => {
      if (command.type === "bootstrap") return { ...ok(command), snapshot: current };
      if (command.type === "plugin.inspect") return pluginResponse(command, current);
      if (command.type === "runtime.selectStudio" && command.projectId === "project-a") {
        return projectASelection.promise;
      }
      if (command.type === "project.select") {
        current = { ...current, revision: 3, selectedProjectId: command.projectId };
      }
      return { ...ok(command, { revision: current.revision }), snapshot: current };
    });
    render(<App api={harness.api} />);

    await userEvent.click(await screen.findByRole("button", { name: "Continue setup" }));
    await userEvent.click(await screen.findByRole("radio", { name: /Deepwater.*101/ }));
    await waitFor(() =>
      expect(harness.request.mock.calls.filter(([command]) => command.type === "runtime.selectStudio")).toHaveLength(1),
    );
    await userEvent.click(screen.getByRole("button", { name: "Close connection setup" }));
    projectASelection.resolve({
      version: 1,
      requestId: "runtime.selectStudio",
      ok: false,
      snapshot: current,
      error: projectAError,
    });
    const obby = screen.getByRole<HTMLButtonElement>("button", { name: "Obby" });
    await waitFor(() => expect(obby.disabled).toBe(false));
    await userEvent.click(obby);
    await userEvent.click(await screen.findByRole("button", { name: "Continue setup" }));

    const dialog = await screen.findByRole("dialog", { name: "Connection setup" });
    expect(within(dialog).queryByText(projectAError.message)).toBeNull();
  });

  it("does not replay a dismissed connection error when the same project opens a new sheet flow", async () => {
    const selectionError = {
      layer: "studio" as const,
      code: "dismissed-selection-failed",
      message: "This dismissed Studio selection must not return.",
      recovery: { action: "refresh" as const, label: "Refresh Studio list" },
    };
    const current = snapshot({
      revision: 2,
      runtimeByProject: {
        "project-a": runtime({
          state: "studio-selection-required",
          rojo: { port: 34_872, generation: 3, executablePath: "/tools/rojo", version: "7.8.0" },
          broker: {
            state: "ready",
            primaryPort: 58_741,
            legacyStatus: "unknown",
            brokerEpoch: "broker-epoch-a",
          },
          catalog: [catalogRow()],
          catalogRevision: 7,
        }),
      },
    });
    const harness = apiHarness(async (command) => {
      if (command.type === "bootstrap") return { ...ok(command), snapshot: current };
      if (command.type === "plugin.inspect") return pluginResponse(command, current);
      if (command.type === "runtime.selectStudio") {
        return {
          version: 1,
          requestId: command.type,
          ok: false,
          snapshot: current,
          error: selectionError,
        };
      }
      return { ...ok(command), snapshot: current };
    });
    render(<App api={harness.api} />);

    await userEvent.click(await screen.findByRole("button", { name: "Continue setup" }));
    await userEvent.click(await screen.findByRole("radio", { name: /Deepwater.*101/ }));
    expect(await screen.findByText(selectionError.message)).not.toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Close connection setup" }));
    await userEvent.click(screen.getByRole("button", { name: "Continue setup" }));

    const dialog = await screen.findByRole("dialog", { name: "Connection setup" });
    expect(within(dialog).queryByText(selectionError.message)).toBeNull();
  });

  it("uses the explicit Rojo choice result when cancel races an intervening newer snapshot", async () => {
    let chooseAttempts = 0;
    let current = snapshot({ revision: 2 });
    const canceledChoice = deferred<DesktopResponse>();
    const harness = apiHarness(async (command) => {
      if (command.type === "bootstrap") return { ...ok(command), snapshot: current };
      if (command.type === "plugin.inspect") return pluginResponse(command, current);
      if (command.type === "runtime.connect") {
        return { ...failed(command, { revision: current.revision, layer: "rojo" }), snapshot: current };
      }
      if (command.type === "settings.chooseRojo") {
        chooseAttempts += 1;
        if (chooseAttempts === 1) return canceledChoice.promise;
        current = { ...current, revision: 6 };
        return {
          ...ok(command, {
            revision: current.revision,
            result: { kind: "rojo-choice", changed: true },
          }),
          snapshot: current,
        };
      }
      return { ...ok(command), snapshot: current };
    });
    render(<App api={harness.api} />);
    await userEvent.click(await screen.findByRole("button", { name: "Reconnect" }));
    await waitFor(() =>
      expect(harness.request.mock.calls.filter(([command]) => command.type === "runtime.connect")).toHaveLength(1),
    );

    const choose = screen.getAllByRole("button", { name: "Choose Rojo executable" })[0]!;
    void userEvent.click(choose);
    await waitFor(() =>
      expect(harness.request.mock.calls.filter(([command]) => command.type === "settings.chooseRojo")).toHaveLength(1),
    );
    current = { ...current, revision: 5 };
    harness.emit(current);
    canceledChoice.resolve({
      ...ok(
        { type: "settings.chooseRojo" },
        {
          revision: 5,
          result: { kind: "rojo-choice", changed: false },
        },
      ),
      snapshot: current,
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(harness.request.mock.calls.filter(([command]) => command.type === "settings.chooseRojo")).toHaveLength(1);
    expect(harness.request.mock.calls.filter(([command]) => command.type === "runtime.connect")).toHaveLength(1);
    await userEvent.click(choose);
    await waitFor(() =>
      expect(harness.request.mock.calls.filter(([command]) => command.type === "runtime.connect")).toHaveLength(2),
    );
    expect(harness.request.mock.calls.filter(([command]) => command.type === "settings.chooseRojo")).toHaveLength(2);
  });

  it("wires exact host-derived selection and pending revision while suppressing duplicate binds", async () => {
    const pendingBind = deferred<DesktopResponse>();
    let current = snapshot({
      revision: 2,
      runtimeByProject: {
        "project-a": runtime({
          state: "studio-selection-required",
          rojo: { port: 34_872, generation: 3, executablePath: "/tools/rojo", version: "7.8.0" },
          broker: {
            state: "ready",
            primaryPort: 58_741,
            legacyStatus: "unknown",
            brokerEpoch: "broker-epoch-a",
          },
          catalog: [catalogRow()],
          catalogRevision: 7,
        }),
      },
    });
    const harness = apiHarness(async (command) => {
      if (command.type === "bootstrap") return { ...ok(command), snapshot: current };
      if (command.type === "plugin.inspect") return pluginResponse(command, current);
      if (command.type === "runtime.selectStudio") {
        current = {
          ...current,
          revision: 3,
          runtimeByProject: {
            "project-a": {
              ...current.runtimeByProject["project-a"]!,
              pending: {
                instanceId: command.instanceId,
                catalogRevision: command.catalogRevision,
                bindingRevision: 23,
                rojoHandoffRequired: true,
              },
            },
          },
        };
        return { ...ok(command, { revision: 3 }), snapshot: current };
      }
      if (command.type === "runtime.confirmRojoHandoff") return pendingBind.promise;
      return { ...ok(command), snapshot: current };
    });
    render(<App api={harness.api} />);
    await userEvent.click(await screen.findByRole("button", { name: "Continue setup" }));
    await userEvent.click(await screen.findByRole("radio", { name: /Deepwater.*101/ }));
    expect(harness.request.mock.calls.filter(([command]) => command.type === "runtime.selectStudio")).toEqual([
      [
        {
          type: "runtime.selectStudio",
          projectId: "project-a",
          instanceId: "studio-instance-a",
          catalogRevision: 7,
          warningAccepted: false,
          expectedRevision: 2,
        },
      ],
    ]);

    const handoff = await screen.findByRole("checkbox", {
      name: "I connected this Studio window to the Rojo server above",
    });
    await userEvent.click(handoff);
    const bind = screen.getByRole("button", { name: "Bind Studio" });
    await userEvent.click(bind);
    await userEvent.click(bind);
    expect(harness.request.mock.calls.filter(([command]) => command.type === "runtime.confirmRojoHandoff")).toEqual([
      [
        {
          type: "runtime.confirmRojoHandoff",
          projectId: "project-a",
          bindingRevision: 23,
          expectedRevision: 3,
        },
      ],
    ]);
    pendingBind.resolve({ ...ok({ type: "bootstrap" }), snapshot: current });
  });

  it("disables MCP port changes when a different project owns a broker lease", async () => {
    const current = snapshot({
      revision: 2,
      projects: [project(), project({ id: "project-b", displayName: "Obby" })],
      settings: {
        preferredMcpPort: 58_741,
        sidebarWidth: 272,
        mcpPortChangeAllowed: false,
      },
      runtimeByProject: {
        "project-a": runtime(),
        "project-b": runtime({
          broker: {
            state: "ready",
            primaryPort: 58_741,
            legacyStatus: "unknown",
            brokerEpoch: "broker-shared",
          },
        }),
      },
    });
    const harness = apiHarness(async (command) =>
      command.type === "plugin.inspect"
        ? pluginResponse(command, current, "missing")
        : { ...ok(command), snapshot: current },
    );
    render(<App api={harness.api} />);
    await userEvent.click(await screen.findByRole("button", { name: "Reconnect" }));
    const port = await screen.findByRole<HTMLInputElement>("spinbutton", { name: "Preferred MCP port" });
    expect(port.disabled).toBe(true);
    expect(screen.getByText("Disconnect every project using Studio MCP before changing this port.")).not.toBeNull();
  });

  it("uses the host global MCP-port gate even when no project projects a broker lease", async () => {
    const current = snapshot({
      revision: 2,
      settings: {
        preferredMcpPort: 58_741,
        sidebarWidth: 272,
        mcpPortChangeAllowed: false,
      },
    });
    const harness = apiHarness(async (command) =>
      command.type === "plugin.inspect"
        ? pluginResponse(command, current, "missing")
        : { ...ok(command), snapshot: current },
    );
    render(<App api={harness.api} />);

    await userEvent.click(await screen.findByRole("button", { name: "Reconnect" }));

    expect((await screen.findByRole<HTMLInputElement>("spinbutton", { name: "Preferred MCP port" })).disabled).toBe(
      true,
    );
  });
});

describe("durable local draft and request recovery", () => {
  it.each([
    ["save-failed", "RbxForge stayed open because a local draft could not be saved."],
    ["timeout", "RbxForge stayed open because draft saving did not finish in time."],
  ] as const)(
    "announces healthy close failure %s in the visible assertive notification region",
    async (reason, message) => {
      const harness = apiHarness();
      render(<App api={harness.api} />);
      await screen.findByRole("button", { name: "Reconnect" });

      act(() => expect(harness.closeBlocked(reason)).toBe(true));

      expect(within(screen.getByRole("alert")).getByText(message)).not.toBeNull();
    },
  );

  it("waits for an in-flight exclusive mutation before acknowledging a main-controlled dirty-draft close", async () => {
    const pendingMessage = deferred<DesktopResponse>();
    const harness = apiHarness(async (command) =>
      command.type === "message.create" ? pendingMessage.promise : ok(command, { revision: 4 }),
    );
    render(<App api={harness.api} />);
    const composer = await screen.findByRole<HTMLTextAreaElement>("textbox", { name: "Local project prompt" });
    fireEvent.change(composer, { target: { value: "Submitted text" } });
    fireEvent.keyDown(composer, { key: "Enter", metaKey: true });
    await waitFor(() =>
      expect(harness.request.mock.calls.filter(([command]) => command.type === "message.create")).toHaveLength(1),
    );
    fireEvent.change(composer, { target: { value: "Newer close-safe draft" } });

    const closing = harness.closeRequest();
    expect(closing).toBeDefined();
    expect(harness.request.mock.calls.filter(([command]) => command.type === "draft.save")).toHaveLength(0);

    pendingMessage.resolve(ok({ type: "message.create", projectId: "project-a", threadId: "thread-a", content: "" }));
    await expect(closing).resolves.toBe(true);
    expect(
      harness.request.mock.calls.map(([command]) => command).filter((command) => command.type === "draft.save"),
    ).toEqual([
      expect.objectContaining({
        type: "draft.save",
        projectId: "project-a",
        threadId: "thread-a",
        content: "Newer close-safe draft",
      }),
    ]);
  });

  it("does not let a held Save pointer start an exclusive blur save before click", async () => {
    const pendingDraft = deferred<DesktopResponse>();
    const harness = apiHarness(async (command) =>
      command.type === "draft.save" ? pendingDraft.promise : ok(command, { revision: 3 }),
    );
    render(<App api={harness.api} />);
    const composer = await screen.findByRole("textbox", { name: "Local project prompt" });
    const saveButton = screen.getByRole("button", { name: "Save prompt" });
    await userEvent.type(composer, "Click-safe prompt");
    await holdPrimaryPointerThroughNextMacrotask(saveButton);
    const draftCallsWhileHeld = harness.request.mock.calls.filter(([command]) => command.type === "draft.save").length;
    releasePrimaryPointer(saveButton);
    const messageCallsBeforeDraftSettles = harness.request.mock.calls.filter(
      ([command]) => command.type === "message.create",
    ).length;
    try {
      expect(draftCallsWhileHeld).toBe(0);
      expect(messageCallsBeforeDraftSettles).toBe(1);
      expect(harness.request.mock.calls.filter(([command]) => command.type === "draft.save")).toHaveLength(0);
    } finally {
      pendingDraft.resolve(
        ok({
          type: "draft.save",
          projectId: "project-a",
          threadId: "thread-a",
          content: "Click-safe prompt",
        }),
      );
      await act(async () => {
        await Promise.resolve();
      });
    }
  });

  it("persists an ordinary composer blur with no internal focus target", async () => {
    const harness = apiHarness();
    render(<App api={harness.api} />);
    const composer = await screen.findByRole("textbox", { name: "Local project prompt" });
    await userEvent.type(composer, "Blur-persisted draft");
    fireEvent.blur(composer, { relatedTarget: null });
    await waitFor(
      () =>
        expect(harness.request.mock.calls.filter(([command]) => command.type === "draft.save")).toEqual([
          [
            expect.objectContaining({
              projectId: "project-a",
              threadId: "thread-a",
              content: "Blur-persisted draft",
            }),
          ],
        ]),
      { timeout: 150 },
    );
  });

  it("does not let a held thread pointer start a blur save before its explicit flush", async () => {
    const pendingDraft = deferred<DesktopResponse>();
    let current = snapshot({
      revision: 2,
      threads: [thread(), thread({ id: "thread-b", title: "Second chat" })],
      selectedThreadIdByProject: { "project-a": "thread-a" },
    });
    const harness = apiHarness(async (command) => {
      if (command.type === "bootstrap") return { ...ok(command), snapshot: current };
      if (command.type === "draft.save") return pendingDraft.promise;
      if (command.type === "thread.select") {
        current = {
          ...current,
          revision: 4,
          selectedThreadIdByProject: { "project-a": command.threadId },
        };
      }
      return { ...ok(command, { revision: current.revision }), snapshot: current };
    });
    render(<App api={harness.api} />);
    const composer = await screen.findByRole("textbox", { name: "Local project prompt" });
    const secondThread = screen.getByRole("button", { name: "Second chat" });
    await userEvent.type(composer, "Thread-owned draft");
    await holdPrimaryPointerThroughNextMacrotask(secondThread);
    const draftCallsWhileHeld = harness.request.mock.calls.filter(([command]) => command.type === "draft.save").length;
    releasePrimaryPointer(secondThread);
    pendingDraft.resolve({
      ...ok({ type: "draft.save", projectId: "project-a", threadId: "thread-a", content: "" }, { revision: 3 }),
      snapshot: { ...current, revision: 3 },
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(draftCallsWhileHeld).toBe(0);
    await waitFor(() =>
      expect(harness.request.mock.calls.filter(([command]) => command.type === "thread.select")).toHaveLength(1),
    );
    expect(harness.request.mock.calls.filter(([command]) => command.type === "draft.save")).toEqual([
      [
        expect.objectContaining({
          projectId: "project-a",
          threadId: "thread-a",
          content: "Thread-owned draft",
        }),
      ],
    ]);
  });

  it("does not let a held project pointer start a blur save before its explicit flush", async () => {
    const pendingDraft = deferred<DesktopResponse>();
    let current = snapshot({
      revision: 2,
      projects: [project(), project({ id: "project-b", displayName: "Obby" })],
      threads: [thread(), thread({ id: "thread-b", projectId: "project-b", title: "Obby ideas" })],
      selectedThreadIdByProject: { "project-a": "thread-a", "project-b": "thread-b" },
    });
    const harness = apiHarness(async (command) => {
      if (command.type === "bootstrap") return { ...ok(command), snapshot: current };
      if (command.type === "draft.save") return pendingDraft.promise;
      if (command.type === "project.select")
        current = { ...current, revision: 4, selectedProjectId: command.projectId };
      return { ...ok(command, { revision: current.revision }), snapshot: current };
    });
    render(<App api={harness.api} />);
    const composer = await screen.findByRole("textbox", { name: "Local project prompt" });
    const obbyProject = screen.getByRole("button", { name: "Obby" });
    await userEvent.type(composer, "Project-owned draft");
    await holdPrimaryPointerThroughNextMacrotask(obbyProject);
    const draftCallsWhileHeld = harness.request.mock.calls.filter(([command]) => command.type === "draft.save").length;
    releasePrimaryPointer(obbyProject);
    pendingDraft.resolve({
      ...ok({ type: "draft.save", projectId: "project-a", threadId: "thread-a", content: "" }, { revision: 3 }),
      snapshot: { ...current, revision: 3 },
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(draftCallsWhileHeld).toBe(0);
    await waitFor(() =>
      expect(harness.request.mock.calls.filter(([command]) => command.type === "project.select")).toHaveLength(1),
    );
    expect(harness.request.mock.calls.filter(([command]) => command.type === "draft.save")).toEqual([
      [
        expect.objectContaining({
          projectId: "project-a",
          threadId: "thread-a",
          content: "Project-owned draft",
        }),
      ],
    ]);
  });

  it("flushes each outgoing thread draft immediately with exact ownership and no duplicates", async () => {
    let revision = 2;
    let current = snapshot({
      revision,
      threads: [thread(), thread({ id: "thread-b", title: "Second chat" })],
      selectedThreadIdByProject: { "project-a": "thread-a" },
    });
    const harness = apiHarness(async (command) => {
      if (command.type === "bootstrap") {
        return { ...ok(command), snapshot: current };
      }
      revision += 1;
      if (command.type === "draft.save") {
        current = {
          ...current,
          revision,
          drafts: [
            ...current.drafts.filter(({ threadId }) => threadId !== command.threadId),
            { threadId: command.threadId, content: command.content, updatedAt: `2026-07-29T00:00:0${revision}Z` },
          ],
        };
      }
      if (command.type === "thread.select") {
        current = {
          ...current,
          revision,
          selectedThreadIdByProject: { ...current.selectedThreadIdByProject, [command.projectId]: command.threadId },
        };
      }
      return { ...ok(command, { revision }), snapshot: current };
    });
    render(<App api={harness.api} />);
    const composer = await screen.findByRole("textbox", { name: "Local project prompt" });
    fireEvent.change(composer, { target: { value: "Alpha draft" } });
    await userEvent.click(screen.getByRole("button", { name: "Second chat" }));
    await waitFor(() => expect((composer as HTMLTextAreaElement).value).toBe(""));
    fireEvent.change(composer, { target: { value: "Beta draft" } });
    await userEvent.click(screen.getByRole("button", { name: "New chat" }));
    await waitFor(() => expect((composer as HTMLTextAreaElement).value).toBe("Alpha draft"));

    const saves = harness.request.mock.calls
      .map(([command]) => command)
      .filter(
        (command): command is Extract<DesktopCommandInput, { type: "draft.save" }> => command.type === "draft.save",
      );
    expect(saves).toEqual([
      expect.objectContaining({
        type: "draft.save",
        projectId: "project-a",
        threadId: "thread-a",
        content: "Alpha draft",
      }),
      expect.objectContaining({
        type: "draft.save",
        projectId: "project-a",
        threadId: "thread-b",
        content: "Beta draft",
      }),
    ]);
  });

  it("flushes the outgoing dirty thread immediately when a newer host event changes selection", async () => {
    const populated = snapshot({
      revision: 2,
      threads: [thread(), thread({ id: "thread-b", title: "Second chat" })],
      selectedThreadIdByProject: { "project-a": "thread-a" },
    });
    const harness = apiHarness(async (command) => ({ ...ok(command, { revision: 4 }), snapshot: populated }));
    render(<App api={harness.api} />);
    const composer = await screen.findByRole("textbox", { name: "Local project prompt" });
    fireEvent.change(composer, { target: { value: "Event-safe draft" } });
    harness.emit({
      ...populated,
      revision: 3,
      selectedThreadIdByProject: { "project-a": "thread-b" },
    });
    await waitFor(
      () =>
        expect(harness.request.mock.calls.filter(([command]) => command.type === "draft.save")).toEqual([
          [
            expect.objectContaining({
              projectId: "project-a",
              threadId: "thread-a",
              content: "Event-safe draft",
            }),
          ],
        ]),
      { timeout: 150 },
    );
  });

  it("best-effort flushes a dirty owned draft across close and unmount exactly once", async () => {
    const harness = apiHarness();
    const view = render(<App api={harness.api} />);
    const composer = await screen.findByRole("textbox", { name: "Local project prompt" });
    fireEvent.change(composer, { target: { value: "Close-safe draft" } });
    fireEvent(window, new Event("beforeunload"));
    view.unmount();
    await waitFor(
      () =>
        expect(
          harness.request.mock.calls.map(([command]) => command).filter((command) => command.type === "draft.save"),
        ).toEqual([
          expect.objectContaining({
            projectId: "project-a",
            threadId: "thread-a",
            content: "Close-safe draft",
          }),
        ]),
      { timeout: 250 },
    );
  });

  it("best-effort flushes multiple dirty event-selected threads with their exact owners", async () => {
    let revision = 2;
    let current = snapshot({
      revision,
      threads: [thread(), thread({ id: "thread-b", title: "Second chat" })],
      selectedThreadIdByProject: { "project-a": "thread-a" },
    });
    const harness = apiHarness(async (command) => {
      if (command.type === "bootstrap") return { ...ok(command), snapshot: current };
      if (command.type === "draft.save") {
        revision += 1;
        current = {
          ...current,
          revision,
          drafts: [
            ...current.drafts.filter(({ threadId }) => threadId !== command.threadId),
            { threadId: command.threadId, content: command.content, updatedAt: `2026-07-29T00:00:0${revision}Z` },
          ],
        };
      }
      return { ...ok(command, { revision }), snapshot: current };
    });
    const view = render(<App api={harness.api} />);
    const composer = await screen.findByRole<HTMLTextAreaElement>("textbox", { name: "Local project prompt" });
    fireEvent.change(composer, { target: { value: "Alpha close draft" } });
    revision = 3;
    current = {
      ...current,
      revision,
      selectedThreadIdByProject: { "project-a": "thread-b" },
    };
    harness.emit(current);
    await waitFor(() => expect(composer.value).toBe(""));
    fireEvent.change(composer, { target: { value: "Beta close draft" } });
    fireEvent(window, new Event("beforeunload"));
    view.unmount();

    await waitFor(() => {
      const saves = harness.request.mock.calls
        .map(([command]) => command)
        .filter(
          (command): command is Extract<DesktopCommandInput, { type: "draft.save" }> => command.type === "draft.save",
        );
      expect(saves).toEqual([
        expect.objectContaining({
          projectId: "project-a",
          threadId: "thread-a",
          content: "Alpha close draft",
        }),
        expect.objectContaining({
          projectId: "project-a",
          threadId: "thread-b",
          content: "Beta close draft",
        }),
      ]);
    });
  });

  it("blocks a permanently failed autosave version until one explicit retry", async () => {
    const harness = apiHarness(async (command) => (command.type === "draft.save" ? failed(command) : ok(command)));
    render(<App api={harness.api} />);
    const composer = await screen.findByRole("textbox", { name: "Local project prompt" });
    vi.useFakeTimers();
    fireEvent.change(composer, { target: { value: "Retry this once" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_500);
    });
    expect(harness.request.mock.calls.filter(([command]) => command.type === "draft.save")).toHaveLength(1);
    expect(screen.getByText("Storage")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(harness.request.mock.calls.filter(([command]) => command.type === "draft.save")).toHaveLength(2);
  });

  it("removes the submitted thread's dead draft Retry after transactional message success", async () => {
    const harness = apiHarness(async (command) => {
      if (command.type === "draft.save") return failed(command, { revision: 3 });
      return ok(command, { revision: command.type === "message.create" ? 4 : 2 });
    });
    render(<App api={harness.api} />);
    const composer = await screen.findByRole("textbox", { name: "Local project prompt" });
    fireEvent.change(composer, { target: { value: "Submit after draft failure" } });
    fireEvent.blur(composer, { relatedTarget: null });
    expect(await screen.findByRole("alert", { name: "Storage error" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "Retry" })).not.toBeNull();

    fireEvent.keyDown(composer, { key: "Enter", metaKey: true });
    expect(await screen.findByText("Prompt saved locally")).not.toBeNull();
    expect(harness.request.mock.calls.filter(([command]) => command.type === "draft.save")).toHaveLength(1);
    expect(harness.request.mock.calls.filter(([command]) => command.type === "message.create")).toHaveLength(1);
    expect(screen.queryByRole("alert", { name: "Storage error" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("keeps a sibling draft Retry until that exact blocked thread also submits successfully", async () => {
    let revision = 2;
    let current = snapshot({
      revision,
      threads: [thread(), thread({ id: "thread-b", title: "Second chat" })],
      selectedThreadIdByProject: { "project-a": "thread-a" },
    });
    const harness = apiHarness(async (command) => {
      if (command.type === "bootstrap") return { ...ok(command), snapshot: current };
      revision += 1;
      if (command.type === "thread.select") {
        current = {
          ...current,
          revision,
          selectedThreadIdByProject: { "project-a": command.threadId },
        };
      } else {
        current = { ...current, revision };
      }
      const response = command.type === "draft.save" ? failed(command, { revision }) : ok(command, { revision });
      return { ...response, snapshot: current };
    });
    render(<App api={harness.api} />);
    const composer = await screen.findByRole<HTMLTextAreaElement>("textbox", { name: "Local project prompt" });

    fireEvent.change(composer, { target: { value: "Alpha blocked draft" } });
    fireEvent.blur(composer, { relatedTarget: null });
    await waitFor(() =>
      expect(harness.request.mock.calls.filter(([command]) => command.type === "draft.save")).toHaveLength(1),
    );
    await userEvent.click(screen.getByRole("button", { name: "Second chat" }));
    await waitFor(() => expect(composer.value).toBe(""));

    fireEvent.change(composer, { target: { value: "Beta blocked draft" } });
    fireEvent.blur(composer, { relatedTarget: null });
    await waitFor(() =>
      expect(harness.request.mock.calls.filter(([command]) => command.type === "draft.save")).toHaveLength(2),
    );
    await userEvent.click(screen.getByRole("button", { name: "New chat" }));
    await waitFor(() => expect(composer.value).toBe("Alpha blocked draft"));

    fireEvent.keyDown(composer, { key: "Enter", metaKey: true });
    await waitFor(() =>
      expect(harness.request.mock.calls.filter(([command]) => command.type === "message.create")).toHaveLength(1),
    );
    expect(composer.value).toBe("");
    expect(screen.getByRole("alert", { name: "Storage error" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "Retry" })).not.toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Second chat" }));
    await waitFor(() => expect(composer.value).toBe("Beta blocked draft"));
    fireEvent.keyDown(composer, { key: "Enter", metaKey: true });
    await waitFor(() =>
      expect(harness.request.mock.calls.filter(([command]) => command.type === "message.create")).toHaveLength(2),
    );
    expect(composer.value).toBe("");
    expect(screen.queryByRole("alert", { name: "Storage error" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(harness.request.mock.calls.filter(([command]) => command.type === "draft.save")).toHaveLength(2);
  });

  it("allows newer typing while message submission is pending and suppresses duplicate submit", async () => {
    const pendingMessage = deferred<DesktopResponse>();
    const harness = apiHarness(async (command) =>
      command.type === "message.create" ? pendingMessage.promise : ok(command),
    );
    render(<App api={harness.api} />);
    const composer = await screen.findByRole<HTMLTextAreaElement>("textbox", { name: "Local project prompt" });
    fireEvent.change(composer, { target: { value: "Submitted text" } });
    fireEvent.keyDown(composer, { key: "Enter", metaKey: true });
    await waitFor(() =>
      expect(harness.request.mock.calls.filter(([command]) => command.type === "message.create")).toHaveLength(1),
    );
    expect(composer.disabled).toBe(false);
    fireEvent.change(composer, { target: { value: "Newer unsent text" } });
    fireEvent.keyDown(composer, { key: "Enter", metaKey: true });
    expect(harness.request.mock.calls.filter(([command]) => command.type === "message.create")).toHaveLength(1);
    pendingMessage.resolve(ok({ type: "message.create", projectId: "project-a", threadId: "thread-a", content: "" }));
    await waitFor(() => expect(composer.value).toBe("Newer unsent text"));
    expect(screen.getByText("Prompt saved locally")).not.toBeNull();
    expect(harness.request.mock.calls.filter(([command]) => command.type === "draft.save")).toHaveLength(0);
  });

  it("allows newer typing while a background draft save is pending", async () => {
    const pendingDraft = deferred<DesktopResponse>();
    const harness = apiHarness(async (command) => (command.type === "draft.save" ? pendingDraft.promise : ok(command)));
    render(<App api={harness.api} />);
    const composer = await screen.findByRole<HTMLTextAreaElement>("textbox", { name: "Local project prompt" });
    vi.useFakeTimers();
    fireEvent.change(composer, { target: { value: "First draft" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(harness.request.mock.calls.filter(([command]) => command.type === "draft.save")).toHaveLength(1);
    expect(composer.disabled).toBe(false);
    fireEvent.change(composer, { target: { value: "Newer draft" } });
    expect(composer.value).toBe("Newer draft");
    pendingDraft.resolve(ok({ type: "draft.save", projectId: "project-a", threadId: "thread-a", content: "" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(composer.value).toBe("Newer draft");
  });

  it("renders bounded layered inline errors, fails closed on unknown recovery, and avoids error toasts", async () => {
    const harness = apiHarness(async (command) =>
      command.type === "message.create"
        ? failed(command, { recovery: { action: "erase-everything", label: "Erase everything" } })
        : ok(command),
    );
    render(<App api={harness.api} />);
    const composer = await screen.findByRole("textbox", { name: "Local project prompt" });
    fireEvent.change(composer, { target: { value: "Keep this" } });
    fireEvent.keyDown(composer, { key: "Enter", ctrlKey: true });
    const inline = await screen.findByRole("alert", { name: "Storage error" });
    expect(inline.textContent).toContain("Local desktop data could not be updated.");
    expect(screen.queryByRole("button", { name: "Erase everything" })).toBeNull();
    const notifications = screen.getByRole("complementary", { name: "Notifications" });
    expect(within(notifications).queryByText("Local desktop data could not be updated.")).toBeNull();
  });

  it("keeps a project-add failure inline when there is no conversation yet", async () => {
    const empty = snapshot({ projects: [], threads: [], drafts: [], selectedProjectId: undefined });
    const harness = apiHarness(async (command) =>
      command.type === "project.add"
        ? { ...failed(command), snapshot: { ...empty, revision: 3 } }
        : { ...ok(command), snapshot: empty },
    );
    render(<App api={harness.api} />);
    const addButtons = await screen.findAllByRole("button", { name: "Add project" });
    await userEvent.click(addButtons[0]!);
    expect(await screen.findByRole("alert", { name: "Storage error" })).not.toBeNull();
    expect(screen.getByText("Build locally with RbxForge")).not.toBeNull();
  });

  it("expires success notifications and lets users dismiss them", async () => {
    const harness = apiHarness(async (command) => ok(command, { revision: 3 }));
    render(<App api={harness.api} />);
    await userEvent.click(await screen.findByRole("button", { name: "Actions for New chat" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    const input = screen.getByRole("textbox", { name: "Conversation name" });
    await userEvent.clear(input);
    await userEvent.type(input, "Round plan");
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "Rename conversation" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText("Conversation renamed")).not.toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_500);
    });
    expect(screen.queryByText("Conversation renamed")).toBeNull();
  });
});

describe("sidebar width transaction", () => {
  it("suppresses duplicate commits while pending, rolls back on failure, and retries the attempted width", async () => {
    const firstWidth = deferred<DesktopResponse>();
    let widthAttempts = 0;
    const harness = apiHarness(async (command) => {
      if (command.type !== "ui.sidebarWidth") return ok(command);
      widthAttempts += 1;
      return widthAttempts === 1 ? firstWidth.promise : ok(command, { revision: 4 });
    });
    render(<App api={harness.api} />);
    const separator = await screen.findByRole("separator", { name: "Resize sidebar" });
    fireEvent.keyDown(separator, { key: "ArrowRight" });
    fireEvent.keyDown(separator, { key: "ArrowRight" });
    expect(harness.request.mock.calls.filter(([command]) => command.type === "ui.sidebarWidth")).toHaveLength(1);
    expect(separator.getAttribute("aria-disabled")).toBe("true");
    firstWidth.resolve(failed({ type: "ui.sidebarWidth", width: 276 }, { revision: 3 }));
    await waitFor(() => expect(screen.getByRole("separator").getAttribute("aria-valuenow")).toBe("272"));
    expect(screen.getByText("Storage")).not.toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(harness.request.mock.calls.filter(([command]) => command.type === "ui.sidebarWidth")).toHaveLength(2),
    );
    expect(harness.request.mock.calls.findLast(([command]) => command.type === "ui.sidebarWidth")?.[0]).toEqual({
      type: "ui.sidebarWidth",
      width: 276,
      expectedRevision: 3,
    });
  });
});
