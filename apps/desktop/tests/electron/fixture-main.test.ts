import { describe, expect, it } from "vitest";

import { desktopResponseSchema, desktopSnapshotSchema } from "../../src/shared/protocol.js";
import {
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
});
