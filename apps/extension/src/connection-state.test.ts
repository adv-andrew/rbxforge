import { describe, expect, test } from "vitest";

import { createConnectionState } from "./connection-state.js";

describe("connection state", () => {
  test("tracks all ten checks independently", () => {
    const state = createConnectionState();

    expect(Object.keys(state.snapshot().checks)).toEqual([
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
    ]);
    state.update("rojoApi", { health: "healthy", detail: "reachable" });
    expect(state.snapshot().checks.rojoApi.health).toBe("healthy");
    expect(state.snapshot().checks.workspace.health).toBe("unknown");
  });

  test("is ready only when every required check is healthy", () => {
    const state = createConnectionState();
    for (const id of state.requiredCheckIds()) {
      state.update(id, { health: "healthy", detail: "ok" });
    }
    expect(state.snapshot().aggregate).toEqual({ label: "Ready", failing: [] });
  });

  test("reports every required non-healthy check once without optional blockers", () => {
    const state = createConnectionState();
    state.update("aiProvider", { health: "unhealthy", detail: "not configured", required: false });
    const failing = state.snapshot().aggregate.failing;
    expect(failing).not.toContain("aiProvider");
    expect(new Set(failing).size).toBe(failing.length);
    expect(failing).toContain("workspace");
  });

  test("publishes frozen replacement snapshots with increasing revisions", () => {
    const state = createConnectionState({ now: () => 42 });
    const first = state.snapshot();
    const received: number[] = [];
    state.onDidChange((snapshot) => received.push(snapshot.revision));
    state.update("workspace", { health: "healthy", detail: "found" });
    const second = state.snapshot();

    expect(second).not.toBe(first);
    expect(second.revision).toBe(first.revision + 1);
    expect(received).toEqual([second.revision]);
    expect(Object.isFrozen(second)).toBe(true);
    expect(Object.isFrozen(second.checks)).toBe(true);
    expect(Object.isFrozen(second.checks.workspace)).toBe(true);
  });

  test("disconnect atomically replaces formerly green dependent checks", () => {
    const state = createConnectionState();
    for (const id of [
      "rojoProcess",
      "rojoApi",
      "mcpProcess",
      "studioPlugin",
      "studioPlace",
      "activeStudioInstance",
      "placeRestriction",
    ] as const) {
      state.update(id, { health: "healthy", detail: "connected" });
    }
    const before = state.snapshot().revision;
    state.disconnect("Studio connection closed");
    const snapshot = state.snapshot();

    expect(snapshot.revision).toBe(before + 1);
    expect(snapshot.checks.rojoProcess.health).toBe("unhealthy");
    expect(snapshot.checks.activeStudioInstance.detail).toBe("Studio connection closed");
    expect(snapshot.checks.placeRestriction.health).toBe("unhealthy");
  });

  test("updates related checks in one emitted snapshot", () => {
    const state = createConnectionState();
    const revisions: number[] = [];
    state.onDidChange((snapshot) => revisions.push(snapshot.revision));

    state.updateMany({
      rojoProcess: { health: "healthy", detail: "running" },
      rojoApi: { health: "unhealthy", detail: "not reachable" },
    });

    expect(revisions).toEqual([1]);
    expect(state.snapshot().checks.rojoProcess.health).toBe("healthy");
    expect(state.snapshot().checks.rojoApi.health).toBe("unhealthy");
  });

  test("does not replace or emit for a domain-equivalent observation", () => {
    let now = 10;
    const state = createConnectionState({ now: () => now });
    state.update("studioPlace", {
      health: "healthy",
      detail: "Studio place connected",
    });
    const observed = state.snapshot();
    const revisions: number[] = [];
    state.onDidChange((snapshot) => revisions.push(snapshot.revision));

    now = 20;
    state.updateMany({
      studioPlace: {
        health: "healthy",
        detail: "Studio place connected",
        required: true,
      },
    });

    expect(state.snapshot()).toBe(observed);
    expect(state.snapshot().checks.studioPlace.observedAt).toBe(10);
    expect(revisions).toEqual([]);
  });

  test("keeps simulation visible in every snapshot", () => {
    const state = createConnectionState({ simulation: true });
    state.update("workspace", { health: "healthy", detail: "fixture" });
    expect(state.snapshot().simulation).toBe(true);
  });
});
