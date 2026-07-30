import type { ConnectionStateSnapshot } from "../connection-state.js";
import { describe, expect, test, vi } from "vitest";

import { createConnectionViewModel, runConnectionAction } from "./connection-provider.js";

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

function state(health: "healthy" | "unhealthy"): ConnectionStateSnapshot {
  const checks = Object.fromEntries(
    ids.map((id) => [
      id,
      {
        id,
        required: id !== "aiProvider",
        health,
        detail: `${id} detail`,
        observedAt: 10,
      },
    ]),
  ) as ConnectionStateSnapshot["checks"];
  return {
    revision: 1,
    checks,
    aggregate: { label: health === "healthy" ? "Ready" : "Not ready", failing: [] },
    simulation: false,
    observedAt: 11,
  };
}

describe("connection provider", () => {
  test("maps all ten independent checks and only registered recovery actions", () => {
    const model = createConnectionViewModel(state("unhealthy"));
    expect(model.checks).toHaveLength(10);
    expect(model.checks.find(({ id }) => id === "workspace")?.action).toBe("selectProject");
    expect(model.checks.find(({ id }) => id === "rojoProcess")?.action).toBe("startRojo");
    expect(model.checks.find(({ id }) => id === "studioPlugin")?.action).toBe("installStudioPlugin");
  });

  test("dispatches a closed action to its exact registered command", async () => {
    const executeCommand = vi.fn(async () => undefined);
    await runConnectionAction("refreshStudio", executeCommand);
    expect(executeCommand).toHaveBeenCalledWith("rbxforge.refreshStudio");
  });
});
