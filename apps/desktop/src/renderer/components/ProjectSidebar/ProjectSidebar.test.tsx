// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { project, thread } from "../../test/fixtures.js";
import { ProjectSidebar, type ProjectSidebarProps } from "./ProjectSidebar.js";

afterEach(cleanup);

function renderSidebar(overrides: Partial<ProjectSidebarProps> = {}) {
  const props: ProjectSidebarProps = {
    projects: [project(), project({ id: "project-b", displayName: "Obby", canonicalRoot: "/projects/obby" })],
    threads: [
      thread(),
      thread({ id: "thread-b", title: "Round loop" }),
      thread({ id: "thread-c", projectId: "project-b", title: "Obby ideas" }),
    ],
    selectedProjectId: "project-a",
    selectedThreadId: "thread-a",
    sidebarWidth: 272,
    onAddProject: vi.fn(),
    onSelectProject: vi.fn(async () => true),
    onCreateThread: vi.fn(async () => true),
    onSelectThread: vi.fn(async () => true),
    onRenameThread: vi.fn(async () => true),
    onDeleteThread: vi.fn(async () => true),
    onRemoveProject: vi.fn(async () => true),
    onSidebarWidthChange: vi.fn(),
    onSidebarWidthCommit: vi.fn(async () => true),
    ...overrides,
  };
  return { props, ...render(<ProjectSidebar {...props} />) };
}

describe("project sidebar", () => {
  it("renders one raised project row, indented owned threads, and sibling row actions", () => {
    renderSidebar();
    expect(screen.getByRole("navigation", { name: "Projects and conversations" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "Deepwater" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("button", { name: "New chat" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "Create new chat" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Obby ideas" })).toBeNull();
    expect(document.querySelector("button button")).toBeNull();
  });

  it("switches from the RF mark at 259 to the full wordmark at 260", () => {
    const view = renderSidebar({ sidebarWidth: 259 });
    expect(screen.getByAltText("RbxForge").getAttribute("data-brand")).toBe("mark");
    view.rerender(<ProjectSidebar {...view.props} sidebarWidth={260} />);
    expect(screen.getByAltText("RbxForge").getAttribute("data-brand")).toBe("wordmark");
  });

  it("resizes with keyboard at bounded steps and persists each completed change once", async () => {
    const onChange = vi.fn();
    const onCommit = vi.fn(async () => true);
    renderSidebar({ sidebarWidth: 272, onSidebarWidthChange: onChange, onSidebarWidthCommit: onCommit });
    const separator = screen.getByRole("separator", { name: "Resize sidebar" });
    expect(separator.getAttribute("aria-valuemin")).toBe("232");
    expect(separator.getAttribute("aria-valuemax")).toBe("360");
    fireEvent.keyDown(separator, { key: "ArrowRight" });
    fireEvent.keyDown(separator, { key: "ArrowLeft", shiftKey: true });
    fireEvent.keyDown(separator, { key: "Home" });
    fireEvent.keyDown(separator, { key: "End" });
    expect(onChange.mock.calls.map(([value]) => value)).toEqual([276, 256, 232, 360]);
    expect(onCommit.mock.calls.map(([value]) => value)).toEqual([276, 256, 232, 360]);
  });

  it("uses pointer capture, clamps dragging, and persists exactly once on drag end", () => {
    const onChange = vi.fn();
    const onCommit = vi.fn(async () => true);
    renderSidebar({ sidebarWidth: 272, onSidebarWidthChange: onChange, onSidebarWidthCommit: onCommit });
    const separator = screen.getByRole("separator", { name: "Resize sidebar" });
    Object.defineProperty(separator, "setPointerCapture", { configurable: true, value: vi.fn() });
    Object.defineProperty(separator, "releasePointerCapture", { configurable: true, value: vi.fn() });
    fireEvent.pointerDown(separator, { pointerId: 2, clientX: 272, button: 0 });
    fireEvent.pointerMove(separator, { pointerId: 2, clientX: 800 });
    fireEvent.pointerMove(separator, { pointerId: 2, clientX: 100 });
    fireEvent.pointerUp(separator, { pointerId: 2, clientX: 100 });
    expect(onChange).toHaveBeenCalledWith(360);
    expect(onChange).toHaveBeenLastCalledWith(232);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(232);
  });

  it("prevents keyboard and pointer resizing while a conflicting mutation is active", () => {
    const onChange = vi.fn();
    const onCommit = vi.fn(async () => true);
    renderSidebar({
      disabled: true,
      onSidebarWidthChange: onChange,
      onSidebarWidthCommit: onCommit,
    });
    const separator = screen.getByRole("separator", { name: "Resize sidebar" });
    expect(separator.getAttribute("aria-disabled")).toBe("true");
    expect(separator.tabIndex).toBe(-1);
    fireEvent.keyDown(separator, { key: "ArrowRight" });
    fireEvent.pointerDown(separator, { pointerId: 2, clientX: 272, button: 0 });
    fireEvent.pointerMove(separator, { pointerId: 2, clientX: 320 });
    fireEvent.pointerUp(separator, { pointerId: 2, clientX: 320 });
    expect(onChange).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("trims and validates rename, retains text on failure, and leaves success toast to the app", async () => {
    const onRename = vi.fn(async () => false);
    renderSidebar({ onRenameThread: onRename });
    await userEvent.click(screen.getByRole("button", { name: "Actions for New chat" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    const input = screen.getByRole("textbox", { name: "Conversation name" });
    await userEvent.clear(input);
    await userEvent.type(input, "  Round strategy  ");
    await userEvent.click(screen.getByRole("button", { name: "Rename conversation" }));
    await waitFor(() => expect(onRename).toHaveBeenCalledWith("project-a", "thread-a", "Round strategy"));
    expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Conversation name" }).value).toBe(
      "  Round strategy  ",
    );
    expect(screen.getByRole("dialog", { name: "Rename conversation" })).not.toBeNull();
  });

  it("confirms thread deletion and says project removal leaves files untouched", async () => {
    const onDelete = vi.fn(async () => true);
    const onRemove = vi.fn(async () => true);
    renderSidebar({ onDeleteThread: onDelete, onRemoveProject: onRemove });
    await userEvent.click(screen.getByRole("button", { name: "Actions for New chat" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(screen.getByText(/removes only this local conversation/i)).not.toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Delete conversation" }));
    expect(onDelete).toHaveBeenCalledWith("project-a", "thread-a");

    await userEvent.click(screen.getByRole("button", { name: "Actions for Deepwater" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Remove project" }));
    expect(screen.getByText(/project files remain untouched/i)).not.toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Remove from RbxForge" }));
    expect(onRemove).toHaveBeenCalledWith("project-a");
  });

  it("shows the exact About status and unofficial-tool disclaimer", async () => {
    renderSidebar();
    await userEvent.click(screen.getByRole("button", { name: "About RbxForge" }));
    expect(screen.getByText("Version 0.1.0")).not.toBeNull();
    expect(screen.getByText(/Project chats and settings stay on this device. AI is not connected./)).not.toBeNull();
    expect(
      screen.getByText(
        "RbxForge is an unofficial developer tool and is not affiliated with or endorsed by Roblox Corporation.",
      ),
    ).not.toBeNull();
  });

  it("restores predictable focus after creating and deleting conversations", async () => {
    function Harness() {
      const [items, setItems] = useState([thread()]);
      const [selected, setSelected] = useState("thread-a");
      return (
        <ProjectSidebar
          {...renderSidebarDefaults}
          onCreateThread={async () => {
            setItems((current) => [...current, thread({ id: "thread-created", title: "Created chat" })]);
            setSelected("thread-created");
            return true;
          }}
          onDeleteThread={async (_projectId, threadId) => {
            setItems((current) => current.filter(({ id }) => id !== threadId));
            setSelected("thread-created");
            return true;
          }}
          selectedThreadId={selected}
          threads={items}
        />
      );
    }
    render(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: "Create new chat" }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Created chat" })));
    await userEvent.click(screen.getByRole("button", { name: "Actions for New chat" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete conversation" }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Deepwater" })));
  });

  it("focuses the next project after a removal and Add project after the final removal", async () => {
    function Harness() {
      const [projects, setProjects] = useState([
        project(),
        project({ id: "project-b", displayName: "Obby", canonicalRoot: "/projects/obby" }),
      ]);
      return (
        <ProjectSidebar
          {...renderSidebarDefaults}
          onRemoveProject={async (projectId) => {
            setProjects((current) => current.filter(({ id }) => id !== projectId));
            return true;
          }}
          projects={projects}
          selectedProjectId={projects[0]?.id}
          threads={[]}
        />
      );
    }
    render(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: "Actions for Deepwater" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Remove project" }));
    await userEvent.click(screen.getByRole("button", { name: "Remove from RbxForge" }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Obby" })));

    await userEvent.click(screen.getByRole("button", { name: "Actions for Obby" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Remove project" }));
    await userEvent.click(screen.getByRole("button", { name: "Remove from RbxForge" }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Add project" })));
  });
});

const renderSidebarDefaults: ProjectSidebarProps = {
  projects: [project()],
  threads: [thread()],
  selectedProjectId: "project-a",
  selectedThreadId: "thread-a",
  sidebarWidth: 272,
  onAddProject: vi.fn(),
  onSelectProject: vi.fn(async () => true),
  onCreateThread: vi.fn(async () => true),
  onSelectThread: vi.fn(async () => true),
  onRenameThread: vi.fn(async () => true),
  onDeleteThread: vi.fn(async () => true),
  onRemoveProject: vi.fn(async () => true),
  onSidebarWidthChange: vi.fn(),
  onSidebarWidthCommit: vi.fn(async () => true),
};
