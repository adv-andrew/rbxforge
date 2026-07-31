import { describe, expect, it } from "vitest";

import { desktopResponseSchema, desktopSnapshotSchema } from "../../src/shared/protocol.js";
import {
  INSPECTOR_VISUAL_STATES,
  VISUAL_STATES,
  createVisualFixtureController,
  createVisualFixtureSnapshot,
  parseVisualStateArgument,
} from "../visual/visual-fixtures.js";

describe("test-only Electron fixture contract", () => {
  it("accepts exactly one closed visual-state argument", () => {
    for (const state of VISUAL_STATES) {
      expect(parseVisualStateArgument(["electron", `--rbxforge-visual-state=${state}`])).toBe(state);
    }

    for (const argv of [
      ["electron"],
      ["electron", "--rbxforge-visual-state=unknown"],
      ["electron", "--rbxforge-visual-state=empty-chat", "--rbxforge-visual-state=studio-bound"],
      ["electron", "--rbxforge-visual-state"],
      ["electron", "--rbxforge-visual-state="],
    ]) {
      expect(() => parseVisualStateArgument(argv)).toThrow(/exactly one supported.*visual state/i);
    }
  });

  it("accepts Inspector-only states without changing the exact six-state matrix", () => {
    expect(INSPECTOR_VISUAL_STATES).toEqual(["studio-inspector", "studio-inspector-error"]);
    for (const state of INSPECTOR_VISUAL_STATES) {
      expect(parseVisualStateArgument(["electron", `--rbxforge-visual-state=${state}`])).toBe(state);
      expect(desktopSnapshotSchema.safeParse(createVisualFixtureSnapshot(state)).success).toBe(true);
    }
    expect(VISUAL_STATES).toHaveLength(6);
  });

  it("produces the exact six schema-valid deterministic snapshots", () => {
    expect(VISUAL_STATES).toEqual([
      "onboarding",
      "empty-chat",
      "populated-chat",
      "studio-selection",
      "studio-bound",
      "mismatch-error",
    ]);

    for (const state of VISUAL_STATES) {
      expect(desktopSnapshotSchema.safeParse(createVisualFixtureSnapshot(state)).success).toBe(true);
    }

    expect(createVisualFixtureSnapshot("onboarding").projects).toEqual([]);
    expect(createVisualFixtureSnapshot("empty-chat").messages).toEqual([]);
    expect(createVisualFixtureSnapshot("populated-chat").messages.map(({ role }) => role)).toEqual(["user", "system"]);
    expect(createVisualFixtureSnapshot("studio-selection").runtimeByProject["fixture-project"]?.state).toBe(
      "studio-selection-required",
    );
    expect(createVisualFixtureSnapshot("studio-bound").runtimeByProject["fixture-project"]?.studio?.instanceId).toBe(
      "studio-instance-101",
    );
    expect(createVisualFixtureSnapshot("mismatch-error").runtimeByProject["fixture-project"]?.error?.code).toBe(
      "project-place-mismatch",
    );
  });

  it("returns protocol-valid responses without fabricating an assistant or network action", async () => {
    const controller = createVisualFixtureController("studio-bound");
    const snapshot = await controller.initialize();
    const events: unknown[] = [];
    const unsubscribe = controller.subscribe((event) => events.push(event));

    const bootstrap = await controller.execute({
      version: 1,
      requestId: "fixture-bootstrap",
      type: "bootstrap",
    });
    const inspection = await controller.execute({
      version: 1,
      requestId: "fixture-plugin",
      type: "plugin.inspect",
    });

    expect(desktopResponseSchema.safeParse(bootstrap).success).toBe(true);
    expect(desktopResponseSchema.safeParse(inspection).success).toBe(true);
    expect(inspection.ok && inspection.result.kind === "plugin-inspection" && inspection.result.inspection.state).toBe(
      "installed",
    );
    expect(snapshot.messages.every(({ role }) => role === "user" || role === "system")).toBe(true);
    expect(events).toEqual([]);

    unsubscribe();
    await controller.dispose();
  });

  it("returns exact schema-valid Inspector results and fails unknown paths closed", async () => {
    const controller = createVisualFixtureController("studio-inspector");
    const identity = {
      projectId: "fixture-project",
      instanceId: "studio-instance-101",
      bindingRevision: 19,
    } as const;
    const root = await controller.execute({
      version: 1,
      requestId: "fixture-inspector-root",
      type: "studioInspector.children",
      ...identity,
      instancePath: "game",
      expectedRevision: 7,
    });
    const workspace = await controller.execute({
      version: 1,
      requestId: "fixture-inspector-workspace",
      type: "studioInspector.children",
      ...identity,
      instancePath: "game.Workspace",
      expectedRevision: 7,
    });
    const properties = await controller.execute({
      version: 1,
      requestId: "fixture-inspector-properties",
      type: "studioInspector.properties",
      ...identity,
      instancePath: "game.Workspace.MainPart",
      expectedRevision: 7,
    });
    const unknown = await controller.execute({
      version: 1,
      requestId: "fixture-inspector-unknown",
      type: "studioInspector.children",
      ...identity,
      instancePath: "game.Unknown",
      expectedRevision: 7,
    });

    for (const response of [root, workspace, properties, unknown]) {
      expect(desktopResponseSchema.safeParse(response).success).toBe(true);
    }
    expect(root).toMatchObject({
      ok: true,
      result: {
        kind: "studio-inspector-children",
        ...identity,
        brokerEpoch: "fixture-broker-epoch-7",
        instancePath: "game",
        observedAt: Date.UTC(2026, 6, 28, 18, 30, 0),
      },
    });
    expect(
      root.ok && root.result.kind === "studio-inspector-children" && root.result.children.map(({ name }) => name),
    ).toEqual(["Workspace", "Players", "ReplicatedStorage", "ServerScriptService", "Lighting"]);
    expect(
      workspace.ok &&
        workspace.result.kind === "studio-inspector-children" &&
        workspace.result.children.map(({ name }) => name),
    ).toEqual(["Map", "SpawnLocation", "MainPart"]);
    expect(properties).toMatchObject({
      ok: true,
      result: {
        kind: "studio-inspector-properties",
        ...identity,
        brokerEpoch: "fixture-broker-epoch-7",
        instancePath: "game.Workspace.MainPart",
        className: "Part",
        observedAt: Date.UTC(2026, 6, 28, 18, 30, 0),
      },
    });
    expect(
      properties.ok &&
        properties.result.kind === "studio-inspector-properties" && [
          ...new Set(properties.result.properties.map(({ category }) => category)),
        ],
    ).toEqual(["Appearance", "Behavior", "Transform", "Data"]);
    expect(unknown).toMatchObject({
      ok: false,
      error: { layer: "studio", code: "studio-inspector-fixture-path", recovery: { action: "retry" } },
    });
    await controller.dispose();
  });

  it("returns a normalized Inspector failure for the error visual state", async () => {
    const controller = createVisualFixtureController("studio-inspector-error");
    const response = await controller.execute({
      version: 1,
      requestId: "fixture-inspector-error",
      type: "studioInspector.children",
      projectId: "fixture-project",
      instanceId: "studio-instance-101",
      bindingRevision: 19,
      instancePath: "game",
      expectedRevision: 7,
    });

    expect(desktopResponseSchema.safeParse(response).success).toBe(true);
    expect(response).toMatchObject({
      ok: false,
      error: {
        layer: "studio",
        code: "studio-inspector-fixture-unavailable",
        message: "Studio inspection is temporarily unavailable.",
        recovery: { action: "retry", label: "Retry Studio inspection" },
      },
    });
    await controller.dispose();
  });
});
