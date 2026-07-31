// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { StudioInspectorController } from "../../app/useStudioInspector.js";
import type { StudioInspectorState } from "../../app/studio-inspector-model.js";
import { StudioInspector } from "./StudioInspector.js";

afterEach(cleanup);

const identity = {
  projectId: "project-a",
  instanceId: "studio-instance-a",
  bindingRevision: 23,
  brokerEpoch: "broker-epoch-a",
};

function inspectorState(overrides: Partial<StudioInspectorState> = {}): StudioInspectorState {
  return {
    identity,
    isOpen: true,
    childrenByPath: {
      game: {
        status: "ready",
        generation: 1,
        rows: [
          {
            name: "Workspace",
            className: "Workspace",
            path: "game.Workspace",
            hasChildren: true,
          },
          {
            name: "ReplicatedStorage",
            className: "ReplicatedStorage",
            path: "game.ReplicatedStorage",
            hasChildren: false,
          },
        ],
      },
    },
    expandedPaths: [],
    selectedPath: undefined,
    properties: undefined,
    ...overrides,
  };
}

function controller(overrides: Partial<StudioInspectorState> = {}): StudioInspectorController {
  return {
    state: inspectorState(overrides),
    open: vi.fn(),
    close: vi.fn(),
    refresh: vi.fn(),
    togglePath: vi.fn(),
    selectPath: vi.fn(),
    retryChildren: vi.fn(),
    retryProperties: vi.fn(),
  };
}

describe("StudioInspector", () => {
  it("shows game children as the first tree level without exposing a synthetic game row", () => {
    render(<StudioInspector controller={controller()} />);

    const tree = screen.getByRole("tree", { name: "Studio Explorer" });
    expect(within(tree).queryByText("game")).toBeNull();
    const rows = within(tree).getAllByRole("treeitem");
    expect(rows.map((row) => row.getAttribute("aria-level"))).toEqual(["1", "1"]);
    expect(rows[0]!.querySelector(".nodeName")?.textContent).toBe("Workspace");
    expect(rows[0]!.getAttribute("aria-expanded")).toBe("false");
    expect(rows[0]!.getAttribute("tabindex")).toBe("0");
    expect(rows[1]!.getAttribute("aria-expanded")).toBeNull();
  });

  it("separates branch expansion from selection and shows selected-property loading", async () => {
    const value = controller();
    const view = render(<StudioInspector controller={value} />);

    await userEvent.click(screen.getByRole("button", { name: "Expand Workspace" }));
    expect(value.togglePath).toHaveBeenCalledWith("game.Workspace");
    expect(value.selectPath).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("treeitem", { name: /Workspace/ }));
    expect(value.selectPath).toHaveBeenCalledWith("game.Workspace");

    view.rerender(
      <StudioInspector
        controller={controller({
          selectedPath: "game.Workspace",
          properties: {
            status: "loading",
            generation: 2,
            path: "game.Workspace",
          },
        })}
      />,
    );
    expect(screen.getByText("Loading properties…")).not.toBeNull();
  });

  it("renders read-only properties in stable groups and filters names case-insensitively", async () => {
    render(
      <StudioInspector
        controller={controller({
          selectedPath: "game.Workspace",
          properties: {
            status: "ready",
            generation: 2,
            path: "game.Workspace",
            className: "Workspace",
            observedAt: 42,
            rows: [
              { name: "ZIndexBehavior", category: "Behavior", value: "Sibling", valueKind: "string" },
              { name: "Archivable", category: "Data", value: "true", valueKind: "boolean" },
              { name: "Name", category: "Data", value: "Workspace", valueKind: "string" },
              { name: "Transparency", category: "Appearance", value: "0", valueKind: "number" },
            ],
          },
        })}
      />,
    );

    const appearance = screen.getByRole("heading", { level: 3, name: "Appearance" });
    const behavior = screen.getByRole("heading", { level: 3, name: "Behavior" });
    const data = screen.getByRole("heading", { level: 3, name: "Data" });
    expect(appearance.compareDocumentPosition(behavior) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(behavior.compareDocumentPosition(data) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(document.querySelector("code[data-value-kind='string'][title='Workspace']")?.textContent).toBe("Workspace");
    expect(screen.queryByRole("button", { name: /Apply|Revert|Open source|Select in Studio/i })).toBeNull();

    fireEvent.keyDown(document, { key: "/" });
    const filter = screen.getByRole<HTMLInputElement>("searchbox", { name: "Filter properties" });
    expect(document.activeElement).toBe(filter);
    await userEvent.type(filter, "name");
    expect(screen.getByText("Name")).not.toBeNull();
    expect(screen.queryByText("Transparency")).toBeNull();
    expect(document.querySelectorAll("input")).toHaveLength(1);
    expect(document.querySelectorAll("textarea, select, [contenteditable='true']")).toHaveLength(0);
  });

  it("shows safely derived canonical selection metadata and a deterministic observation time", () => {
    const selectedPath = 'game.Workspace["Door.Hinge"]';
    render(
      <StudioInspector
        controller={controller({
          selectedPath,
          properties: {
            status: "ready",
            generation: 2,
            path: selectedPath,
            className: "Part",
            observedAt: 42,
            rows: [],
          },
        })}
      />,
    );

    expect(screen.getByText("Door.Hinge")).not.toBeNull();
    expect(screen.getByText("Part")).not.toBeNull();
    const path = screen.getByText(selectedPath);
    expect(path.tagName).toBe("CODE");
    expect(path.getAttribute("title")).toBe(selectedPath);
    expect(path.getAttribute("data-ellipsized")).toBe("true");
    const observed = screen.getByText("Observed 1970-01-01 00:00:00.042 UTC");
    expect(observed.tagName).toBe("TIME");
    expect(observed.getAttribute("datetime")).toBe("1970-01-01T00:00:00.042Z");
  });

  it("uses restrained class-family icons with a safe unknown-class fallback", () => {
    render(
      <StudioInspector
        controller={controller({
          childrenByPath: {
            game: {
              status: "ready",
              generation: 1,
              rows: [
                { name: "CurrentCamera", className: "Camera", path: "game.CurrentCamera", hasChildren: false },
                { name: "Bootstrap", className: "Script", path: "game.Bootstrap", hasChildren: false },
                { name: "Hud", className: "Frame", path: "game.Hud", hasChildren: false },
                { name: "Players", className: "Players", path: "game.Players", hasChildren: false },
                { name: "Oddity", className: "FutureClass", path: "game.Oddity", hasChildren: false },
              ],
            },
          },
        })}
      />,
    );

    expect(screen.getByRole("treeitem", { name: /CurrentCamera/ }).querySelector(".lucide-camera")).not.toBeNull();
    expect(screen.getByRole("treeitem", { name: /Bootstrap/ }).querySelector(".lucide-file-code")).not.toBeNull();
    expect(screen.getByRole("treeitem", { name: /Hud/ }).querySelector(".lucide-panels-top-left")).not.toBeNull();
    expect(screen.getByRole("treeitem", { name: /Players/ }).querySelector(".lucide-users")).not.toBeNull();
    expect(screen.getByRole("treeitem", { name: /Oddity/ }).querySelector(".lucide-component")).not.toBeNull();
  });

  it("keeps deep tree indentation bounded instead of resetting after level ten", () => {
    const childrenByPath: Record<string, StudioInspectorState["childrenByPath"][string]> = {};
    const expandedPaths: string[] = [];
    let parentPath = "game";
    for (let level = 1; level <= 18; level += 1) {
      const path = `${parentPath}.Node${level}`;
      childrenByPath[parentPath] = {
        status: "ready",
        generation: level,
        rows: [{ name: `Node${level}`, className: "Folder", path, hasChildren: level < 18 }],
      };
      if (level < 18) expandedPaths.push(path);
      parentPath = path;
    }
    render(<StudioInspector controller={controller({ childrenByPath, expandedPaths })} />);

    const levelTwelve = screen.getByRole("treeitem", { name: /Node12/ });
    expect(levelTwelve.getAttribute("aria-level")).toBe("12");
    expect(levelTwelve.querySelector(".indent")?.getAttribute("data-level")).toBe("12");
    const levelEighteen = screen.getByRole("treeitem", { name: /Node18/ });
    expect(levelEighteen.getAttribute("aria-level")).toBe("18");
    expect(levelEighteen.querySelector(".indent")?.getAttribute("data-level")).toBe("16");
  });

  it("provides explicit no-selection, no-match, empty, and property error recovery states", async () => {
    const empty = render(<StudioInspector controller={controller()} />);
    expect(screen.getByText("Select an object to inspect its properties.")).not.toBeNull();

    empty.rerender(
      <StudioInspector
        controller={controller({
          selectedPath: "game.Workspace",
          properties: {
            status: "ready",
            generation: 2,
            path: "game.Workspace",
            className: "Workspace",
            observedAt: 42,
            rows: [],
          },
        })}
      />,
    );
    expect(screen.getByText("No properties available")).not.toBeNull();

    empty.rerender(
      <StudioInspector
        controller={controller({
          selectedPath: "game.Workspace",
          properties: {
            status: "ready",
            generation: 2,
            path: "game.Workspace",
            className: "Workspace",
            observedAt: 42,
            rows: [{ name: "Name", category: "Data", value: "Workspace", valueKind: "string" }],
          },
        })}
      />,
    );
    await userEvent.type(screen.getByRole("searchbox", { name: "Filter properties" }), "missing");
    expect(screen.getByText("No matching properties")).not.toBeNull();

    const errored = controller({
      selectedPath: "game.Workspace",
      properties: {
        status: "error",
        generation: 3,
        path: "game.Workspace",
        message: "Properties could not be loaded.",
      },
    });
    empty.rerender(<StudioInspector controller={errored} />);
    expect(screen.getByRole("alert").textContent).toContain("Properties could not be loaded.");
    await userEvent.click(screen.getByRole("button", { name: "Retry properties" }));
    expect(errored.retryProperties).toHaveBeenCalledTimes(1);
  });

  it("keeps branch-local loading and errors in the tree with exact retry ownership", async () => {
    const value = controller({
      expandedPaths: ["game.Workspace"],
      childrenByPath: {
        ...inspectorState().childrenByPath,
        "game.Workspace": {
          status: "error",
          generation: 2,
          message: "Workspace children could not be loaded.",
        },
      },
    });
    const view = render(<StudioInspector controller={value} />);
    expect(screen.getByRole("alert").textContent).toContain("Workspace children could not be loaded.");
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(value.retryChildren).toHaveBeenCalledWith("game.Workspace");

    view.rerender(
      <StudioInspector
        controller={controller({
          expandedPaths: ["game.Workspace"],
          childrenByPath: {
            ...inspectorState().childrenByPath,
            "game.Workspace": { status: "loading", generation: 3 },
          },
        })}
      />,
    );
    expect(screen.getByText("Loading Workspace children…")).not.toBeNull();
  });

  it("implements roving tree focus with Arrow, Home, End, expand, and parent movement", () => {
    const value = controller({
      expandedPaths: ["game.Workspace"],
      childrenByPath: {
        ...inspectorState().childrenByPath,
        "game.Workspace": {
          status: "ready",
          generation: 2,
          rows: [
            {
              name: "Camera",
              className: "Camera",
              path: "game.Workspace.Camera",
              hasChildren: false,
            },
          ],
        },
      },
    });
    render(<StudioInspector controller={value} />);

    const workspace = screen.getByRole("treeitem", { name: /Workspace/ });
    const camera = screen.getByRole("treeitem", { name: /Camera/ });
    const storage = screen.getByRole("treeitem", { name: /ReplicatedStorage/ });
    workspace.focus();
    fireEvent.keyDown(workspace, { key: "ArrowDown" });
    expect(document.activeElement).toBe(camera);
    fireEvent.keyDown(camera, { key: "End" });
    expect(document.activeElement).toBe(storage);
    fireEvent.keyDown(storage, { key: "Home" });
    expect(document.activeElement).toBe(workspace);
    fireEvent.keyDown(workspace, { key: "ArrowLeft" });
    expect(value.togglePath).toHaveBeenCalledWith("game.Workspace");
    camera.focus();
    fireEvent.keyDown(camera, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(workspace);
  });

  it("switches compact Explorer and Properties tabs without losing selected data", async () => {
    const originalMatchMedia = window.matchMedia;
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: () =>
        ({
          matches: true,
          media: "(max-width: 1100px)",
          onchange: null,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          addListener: vi.fn(),
          removeListener: vi.fn(),
          dispatchEvent: vi.fn(),
        }) satisfies MediaQueryList,
    });
    try {
      render(
        <StudioInspector
          controller={controller({
            selectedPath: "game.Workspace",
            properties: {
              status: "ready",
              generation: 2,
              path: "game.Workspace",
              className: "Workspace",
              observedAt: 42,
              rows: [{ name: "Name", category: "Data", value: "Workspace", valueKind: "string" }],
            },
          })}
        />,
      );

      const explorer = screen.getByRole("tab", { name: "Explorer" });
      const properties = screen.getByRole("tab", { name: "Properties" });
      expect(explorer.getAttribute("aria-selected")).toBe("true");
      explorer.focus();
      fireEvent.keyDown(explorer, { key: "ArrowRight" });
      expect(properties.getAttribute("aria-selected")).toBe("true");
      expect(document.activeElement).toBe(properties);
      fireEvent.keyDown(properties, { key: "Home" });
      expect(explorer.getAttribute("aria-selected")).toBe("true");
      await userEvent.click(properties);
      expect(properties.getAttribute("aria-selected")).toBe("true");
      expect(screen.getByText("Name")).not.toBeNull();
      await userEvent.click(explorer);
      expect(screen.getByRole("treeitem", { name: /Workspace/ }).getAttribute("aria-selected")).toBe("true");

      const externalEditor = document.createElement("textarea");
      document.body.append(externalEditor);
      externalEditor.focus();
      fireEvent.keyDown(externalEditor, { key: "/" });
      expect(explorer.getAttribute("aria-selected")).toBe("true");
      expect(document.activeElement).toBe(externalEditor);
      externalEditor.remove();

      fireEvent.keyDown(document, { key: "/" });
      expect(properties.getAttribute("aria-selected")).toBe("true");
      expect(document.activeElement).toBe(screen.getByRole("searchbox", { name: "Filter properties" }));
    } finally {
      Object.defineProperty(window, "matchMedia", {
        configurable: true,
        value: originalMatchMedia,
      });
    }
  });

  it("wires close and refresh while exposing only read-only inspector actions", async () => {
    const value = controller();
    render(<StudioInspector controller={value} />);

    expect(screen.getByRole("heading", { name: "Studio Inspector" })).not.toBeNull();
    expect(screen.getByText("Studio · read-only")).not.toBeNull();
    const refresh = screen.getByRole("button", { name: "Refresh Studio inspector" });
    const close = screen.getByRole("button", { name: "Close Studio inspector" });
    expect(refresh.getAttribute("title")).toBe("Refresh Studio inspector");
    expect(close.getAttribute("title")).toBe("Close Studio inspector");
    await userEvent.click(refresh);
    await userEvent.click(close);
    expect(value.refresh).toHaveBeenCalledTimes(1);
    expect(value.close).toHaveBeenCalledTimes(1);

    for (const label of ["Apply", "Revert", "Open source", "Select in Studio", "Delete", "Rename"]) {
      expect(screen.queryByRole("button", { name: label })).toBeNull();
    }
  });

  it("fails closed with explicit copy when the bound identity is no longer available", () => {
    render(<StudioInspector controller={controller({ identity: undefined })} />);
    expect(screen.getByText("Studio connection changed. Reconnect to inspect.")).not.toBeNull();
    expect(screen.queryByRole("tree")).toBeNull();
  });

  it("renders nothing when the controller is closed", () => {
    render(<StudioInspector controller={controller({ isOpen: false })} />);
    expect(screen.queryByRole("heading", { name: "Studio Inspector" })).toBeNull();
  });
});
