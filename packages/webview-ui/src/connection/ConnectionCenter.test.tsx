import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";

import type { ConnectionSnapshot } from "../protocol.js";
import { ConnectionCenter } from "./ConnectionCenter.js";

const ids = [
  "workspace",
  "rojoBinary",
  "rojoProcess",
  "rojoApi",
  "mcpProcess",
  "studioPlugin",
  "studioPlace",
  "activeStudioInstance",
  "placeRestriction",
  "aiProvider",
] as const;

function connection(health: "unknown" | "checking" | "healthy" | "unhealthy" = "healthy"): ConnectionSnapshot {
  return {
    aggregate: "Ready",
    simulation: false,
    observedAt: 200,
    checks: ids.map((id) => ({
      id,
      label: id,
      required: id !== "aiProvider",
      health,
      detail: `${id} exact detail`,
      observedAt: 100,
      ...(id === "workspace" ? { action: "selectProject" as const } : {}),
    })),
  };
}

describe("ConnectionCenter", () => {
  test("renders ten independent compact rows with exact detail and freshness", () => {
    render(<ConnectionCenter snapshot={connection()} onAction={vi.fn()} />);
    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(10);
    expect(within(rows[0]!).getByText("workspace exact detail")).toBeTruthy();
    expect(rows[0]!.textContent).toContain("Observed 100");
  });

  test("dispatches only a host-supplied closed action", async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    render(<ConnectionCenter snapshot={connection("unhealthy")} onAction={onAction} />);
    await user.click(screen.getByRole("button", { name: "Select project" }));
    expect(onAction).toHaveBeenCalledWith("selectProject");
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  test("computes Ready only when every required check is healthy", () => {
    const processOnly = connection("unhealthy");
    processOnly.checks[2] = { ...processOnly.checks[2], health: "healthy" };
    const { rerender } = render(<ConnectionCenter snapshot={processOnly} onAction={vi.fn()} />);
    expect(screen.getByRole("status").textContent).toContain("Not ready");
    rerender(<ConnectionCenter snapshot={connection("healthy")} onAction={vi.fn()} />);
    expect(screen.getByRole("status").textContent).toContain("Ready");
  });

  test("renders loading and recoverable error/retry states", async () => {
    const user = userEvent.setup();
    const onRefresh = vi.fn();
    const { rerender } = render(<ConnectionCenter onAction={vi.fn()} onRefresh={onRefresh} />);
    expect(screen.getByText("Checking connections…")).toBeTruthy();
    rerender(<ConnectionCenter error="Studio MCP unavailable" onAction={vi.fn()} onRefresh={onRefresh} />);
    expect(screen.getByText("Studio MCP unavailable")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});
