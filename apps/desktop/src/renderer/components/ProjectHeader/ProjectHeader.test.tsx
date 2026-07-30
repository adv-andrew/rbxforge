// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProjectRuntimeState, RuntimeSnapshot } from "../../../shared/domain.js";
import { project, snapshot } from "../../test/fixtures.js";
import { ProjectHeader } from "./ProjectHeader.js";

afterEach(cleanup);

function runtime(overrides: Partial<RuntimeSnapshot> = {}): RuntimeSnapshot {
  return {
    ...snapshot().runtimeByProject["project-a"]!,
    state: "disconnected",
    detail: "Project runtime is disconnected.",
    ...overrides,
  };
}

describe("ProjectHeader", () => {
  it.each([
    ["disconnected", "Connect", false],
    ["starting-rojo", "Connecting…", true],
    ["rojo-server-ready", "Continue setup", false],
    ["waiting-for-studio", "Continue setup", false],
    ["studio-selection-required", "Continue setup", false],
    ["catalog-ambiguous", "Continue setup", false],
    ["project-mismatch", "Continue setup", false],
    ["needs-reconnect", "Reconnect", false],
    ["error", "Reconnect", false],
    ["studio-bound", "Connection details", false],
  ] as const)("maps %s to one exact main action", async (state, label, disabled) => {
    const onOpenConnection = vi.fn();
    render(
      <ProjectHeader
        onOpenConnection={onOpenConnection}
        project={project()}
        runtime={runtime({ state: state as ProjectRuntimeState })}
      />,
    );

    const actions = document.querySelectorAll("[data-main-connection-action='true']");
    expect(actions).toHaveLength(1);
    const action = screen.getByRole<HTMLButtonElement>("button", { name: label });
    expect(action.getAttribute("aria-disabled")).toBe(disabled ? "true" : null);
    expect(action.disabled).toBe(false);
    if (!disabled) {
      await userEvent.click(action);
      expect(onOpenConnection).toHaveBeenCalledTimes(1);
    }
    expect(screen.queryByRole("button", { name: "Disconnect" })).toBeNull();
  });

  it("uses a focusable aria-disabled Connecting action with a guarded click", async () => {
    const onOpenConnection = vi.fn();
    render(
      <ProjectHeader
        connecting
        onOpenConnection={onOpenConnection}
        project={project()}
        runtime={runtime({ state: "needs-reconnect" })}
      />,
    );
    const action = screen.getByRole<HTMLButtonElement>("button", { name: "Connecting…" });
    expect(action.disabled).toBe(false);
    expect(action.getAttribute("aria-disabled")).toBe("true");
    action.focus();
    expect(document.activeElement).toBe(action);
    await userEvent.click(action);
    expect(onOpenConnection).not.toHaveBeenCalled();
    expect(screen.queryByText("Studio bound")).toBeNull();
  });

  it("renders the exact honest bound summary, visible place ID, and technical identity only in details", () => {
    render(
      <ProjectHeader
        onOpenConnection={vi.fn()}
        project={project()}
        runtime={runtime({
          state: "studio-bound",
          rojo: {
            port: 34_872,
            generation: 17,
            executablePath: "/tools/rojo",
            version: "7.8.0",
          },
          broker: {
            state: "ready",
            primaryPort: 58_741,
            legacyPort: 3_002,
            legacyStatus: "listening",
            brokerEpoch: "broker-epoch-secret",
          },
          studio: {
            instanceId: "studio-instance-secret",
            placeId: 1_537_690_962,
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
        })}
      />,
    );

    const exact = "Deepwater · Studio: Deepwater (1537690962) · MCP 58741 · Rojo server :34872 ready";
    const summary = screen.getByText(exact);
    expect(summary.getAttribute("title")).toBe(exact);
    expect(summary.getAttribute("data-ellipsized")).toBe("true");
    expect(screen.getByText("Studio bound").closest("[data-studio-bound]")?.getAttribute("data-studio-bound")).toBe(
      "true",
    );
    for (const raw of ["studio-instance-secret", "broker-epoch-secret", "17", "23"]) {
      expect(screen.getByText(raw).closest("details")).not.toBeNull();
    }
    expect(document.body.textContent).not.toMatch(/Rojo connected|Rojo verified/i);
  });

  it("keeps non-bound status chips flat and labels a ready Rojo process as a server", () => {
    render(
      <ProjectHeader
        onOpenConnection={vi.fn()}
        project={project()}
        runtime={runtime({
          state: "rojo-server-ready",
          rojo: {
            port: 34_872,
            generation: 1,
            executablePath: "/tools/rojo",
            version: "7.8.0",
          },
        })}
      />,
    );
    expect(screen.getByText("Deepwater · Rojo server :34872 ready")).not.toBeNull();
    expect(screen.getByText("Rojo ready").closest("[data-studio-bound]")?.getAttribute("data-studio-bound")).toBe(
      "false",
    );
  });
});
