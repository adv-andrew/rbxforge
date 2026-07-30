import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";

import { AgentView } from "./AgentView.js";

const snapshot = {
  simulation: false,
  connected: true,
  status: "ready" as const,
  mode: "ask" as const,
  chips: [{ id: "opaque-chip", label: "Workspace.Part", kind: "studio-properties" as const }],
  canRetry: false,
};

describe("AgentView", () => {
  test("offers Ask Build Debug and submits explicit opaque chips", () => {
    const onStart = vi.fn();
    render(
      <AgentView
        snapshot={snapshot}
        text=""
        cards={[]}
        approvals={[]}
        onStart={onStart}
        onStop={vi.fn()}
        onRetry={vi.fn()}
        onRemoveChip={vi.fn()}
        onDecision={vi.fn()}
        onOpenDiff={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: "Build" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Prompt" }), { target: { value: "Make a door" } });
    fireEvent.click(screen.getByRole("button", { name: "Build" }));
    expect(onStart).toHaveBeenCalledWith("build", "Make a door", ["opaque-chip"]);
  });

  test("renders simulation, ordered output, safe tool cards and separate approval actions", () => {
    const onDecision = vi.fn();
    const onOpenDiff = vi.fn();
    render(
      <AgentView
        snapshot={{ ...snapshot, simulation: true, status: "running", runId: "run-1" }}
        text="FirstSecond"
        cards={[
          {
            runId: "run-1",
            callId: "call-1",
            name: "workspace_patch",
            access: "write",
            state: "running",
          },
        ]}
        approvals={[
          {
            runId: "run-1",
            approvalId: "approval-1",
            kind: "filesystem",
            summary: "Edit one file",
            expiresAt: 200,
          },
        ]}
        onStart={vi.fn()}
        onStop={vi.fn()}
        onRetry={vi.fn()}
        onRemoveChip={vi.fn()}
        onDecision={onDecision}
        onOpenDiff={onOpenDiff}
      />,
    );
    expect(screen.getByText(/SIMULATION/)).toBeTruthy();
    expect(screen.getByText("FirstSecond")).toBeTruthy();
    expect(screen.getByText("workspace patch")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open Diff" }));
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(onOpenDiff).toHaveBeenCalledWith("run-1", "approval-1");
    expect(onDecision).toHaveBeenCalledWith("run-1", "approval-1", "approve");
  });

  test("labels bounded Studio change descriptors as old and new display values", () => {
    render(
      <AgentView
        snapshot={{ ...snapshot, status: "running", runId: "run-1" }}
        text=""
        cards={[]}
        approvals={[
          {
            runId: "run-1",
            approvalId: "approval-1",
            kind: "studio",
            summary: "Workspace.Door.Anchored",
            expiresAt: 200,
            change: {
              before: "false",
              after: "true",
            },
          },
        ]}
        onStart={vi.fn()}
        onStop={vi.fn()}
        onRetry={vi.fn()}
        onRemoveChip={vi.fn()}
        onDecision={vi.fn()}
        onOpenDiff={vi.fn()}
      />,
    );
    expect(screen.getByText("Studio proposal")).toBeTruthy();
    expect(screen.getByText("Old")).toBeTruthy();
    expect(screen.getByText("false")).toBeTruthy();
    expect(screen.getByText("New")).toBeTruthy();
    expect(screen.getByText("true")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open Diff" })).toBeNull();
  });

  test("supports stop, retry, chip removal and keyboard submission", () => {
    const onStop = vi.fn();
    const onRetry = vi.fn();
    const onRemoveChip = vi.fn();
    const onStart = vi.fn();
    const { rerender } = render(
      <AgentView
        snapshot={{ ...snapshot, status: "running", runId: "run-1" }}
        text=""
        cards={[]}
        approvals={[]}
        onStart={onStart}
        onStop={onStop}
        onRetry={onRetry}
        onRemoveChip={onRemoveChip}
        onDecision={vi.fn()}
        onOpenDiff={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(onStop).toHaveBeenCalledWith("run-1");
    rerender(
      <AgentView
        snapshot={{ ...snapshot, status: "completed", runId: "run-1", canRetry: true }}
        text=""
        cards={[]}
        approvals={[]}
        onStart={onStart}
        onStop={onStop}
        onRetry={onRetry}
        onRemoveChip={onRemoveChip}
        onDecision={vi.fn()}
        onOpenDiff={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove Workspace.Part" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Prompt" }), { target: { value: "Inspect" } });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Prompt" }), { key: "Enter", ctrlKey: true });
    expect(onRetry).toHaveBeenCalledWith("run-1");
    expect(onRemoveChip).toHaveBeenCalledWith("opaque-chip");
    expect(onStart).toHaveBeenCalledWith("ask", "Inspect", ["opaque-chip"]);
  });
});
