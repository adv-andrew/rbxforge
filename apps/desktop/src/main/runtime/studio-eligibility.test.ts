import { describe, expect, it } from "vitest";
import type { StudioInstance } from "@rbxforge/studio-mcp";
import { eligibleStudioInstance } from "./studio-eligibility.js";

const baseInstance: StudioInstance = Object.freeze({
  instanceId: "studio-a",
  role: "edit",
  placeId: 1_537_690_962,
  placeName: "Deepwater",
  dataModelName: "Deepwater",
  isRunning: false,
  pluginVersion: "2.22.5",
  pluginVariant: "main",
  serverVersion: "2.22.5",
  versionMismatch: false,
  lastActivity: 10_000,
  connectedAt: 1_000,
});

const context = Object.freeze({
  now: 10_000,
  catalogObservedAt: 10_000,
  pinnedVersion: "2.22.5",
  servePlaceIds: Object.freeze([1_537_690_962]),
});

function studioInstance(patch: Partial<StudioInstance> = {}): StudioInstance {
  return Object.freeze({ ...baseInstance, ...patch });
}

describe("Studio eligibility", () => {
  it("accepts only a fresh main edit instance with matching versions and numeric place ID", () => {
    expect(eligibleStudioInstance(studioInstance(), context)).toEqual({
      eligible: true,
      warningRequired: false,
    });
  });

  it.each([
    [{ role: "play" }, "role"],
    [{ pluginVariant: "inspector" }, "plugin-variant"],
    [{ pluginVariant: "" }, "plugin-variant"],
    [{ pluginVersion: "2.22.4" }, "plugin-version"],
    [{ pluginVersion: "" }, "plugin-version"],
    [{ serverVersion: "2.22.4" }, "server-version"],
    [{ serverVersion: "" }, "server-version"],
    [{ versionMismatch: true }, "version-mismatch"],
    [{ placeId: 999 }, "project-mismatch"],
    [{ placeId: Number.NaN }, "project-mismatch"],
  ])("blocks %j as %s", (patch, reason) => {
    expect(eligibleStudioInstance(studioInstance(patch), context)).toEqual({ eligible: false, reason });
  });

  it("uses inclusive 5,000ms freshness and rejects 5,001ms for catalog and activity", () => {
    expect(
      eligibleStudioInstance(studioInstance({ lastActivity: 5_000 }), {
        ...context,
        catalogObservedAt: 5_000,
      }),
    ).toMatchObject({ eligible: true });
    expect(eligibleStudioInstance(studioInstance({ lastActivity: 4_999 }), context)).toEqual({
      eligible: false,
      reason: "stale",
    });
    expect(
      eligibleStudioInstance(studioInstance(), {
        ...context,
        catalogObservedAt: 4_999,
      }),
    ).toEqual({ eligible: false, reason: "stale" });
  });

  it("accepts exactly 1,000ms future skew and rejects 1,001ms or non-finite timestamps", () => {
    expect(
      eligibleStudioInstance(studioInstance({ lastActivity: 11_000 }), {
        ...context,
        catalogObservedAt: 11_000,
      }),
    ).toMatchObject({ eligible: true });
    for (const timestamp of [11_001, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(eligibleStudioInstance(studioInstance({ lastActivity: timestamp }), context)).toEqual({
        eligible: false,
        reason: "stale",
      });
      expect(
        eligibleStudioInstance(studioInstance(), {
          ...context,
          catalogObservedAt: timestamp,
        }),
      ).toEqual({ eligible: false, reason: "stale" });
    }
  });

  it("requires an unknown-place warning when the project has no known place IDs", () => {
    expect(
      eligibleStudioInstance(studioInstance(), {
        ...context,
        servePlaceIds: Object.freeze([]),
      }),
    ).toEqual({ eligible: true, warningRequired: true, warning: "unknown-place" });
  });

  it("requires an unpublished-place warning for place ID zero", () => {
    expect(
      eligibleStudioInstance(studioInstance({ placeId: 0 }), {
        ...context,
        servePlaceIds: Object.freeze([]),
      }),
    ).toEqual({ eligible: true, warningRequired: true, warning: "unpublished-place" });
  });

  it("matches IDs rather than equal place names", () => {
    expect(eligibleStudioInstance(studioInstance({ placeId: 999, placeName: "Deepwater" }), context)).toEqual({
      eligible: false,
      reason: "project-mismatch",
    });
  });
});
