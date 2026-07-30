import type { StudioInstance } from "@rbxforge/studio-mcp";

const MAX_AGE_MS = 5_000;
const MAX_FUTURE_SKEW_MS = 1_000;

export interface StudioEligibilityContext {
  readonly now: number;
  readonly catalogObservedAt: number;
  readonly pinnedVersion: string;
  readonly servePlaceIds: readonly number[];
}

export type StudioEligibility =
  | {
      readonly eligible: true;
      readonly warningRequired: boolean;
      readonly warning?: "unknown-place" | "unpublished-place";
    }
  | {
      readonly eligible: false;
      readonly reason:
        | "role"
        | "plugin-variant"
        | "plugin-version"
        | "server-version"
        | "version-mismatch"
        | "stale"
        | "project-mismatch";
    };

export function eligibleStudioInstance(instance: StudioInstance, context: StudioEligibilityContext): StudioEligibility {
  if (instance.role !== "edit") return blocked("role");
  if (instance.pluginVariant !== "main") return blocked("plugin-variant");
  if (instance.pluginVersion !== context.pinnedVersion) return blocked("plugin-version");
  if (instance.serverVersion !== context.pinnedVersion) return blocked("server-version");
  if (instance.versionMismatch) return blocked("version-mismatch");
  if (staleTimestamp(context.catalogObservedAt, context.now) || staleTimestamp(instance.lastActivity, context.now)) {
    return blocked("stale");
  }
  if (!Number.isSafeInteger(instance.placeId) || instance.placeId < 0) {
    return blocked("project-mismatch");
  }
  if (instance.placeId === 0) {
    return Object.freeze({
      eligible: true,
      warningRequired: true,
      warning: "unpublished-place" as const,
    });
  }
  const knownPlaceIds = context.servePlaceIds.filter((placeId) => Number.isSafeInteger(placeId) && placeId > 0);
  if (knownPlaceIds.length === 0) {
    return Object.freeze({
      eligible: true,
      warningRequired: true,
      warning: "unknown-place" as const,
    });
  }
  if (!knownPlaceIds.includes(instance.placeId)) return blocked("project-mismatch");
  return Object.freeze({ eligible: true, warningRequired: false });
}

function staleTimestamp(timestamp: number, now: number): boolean {
  if (!Number.isFinite(timestamp) || !Number.isFinite(now)) return true;
  const age = now - timestamp;
  return age > MAX_AGE_MS || age < -MAX_FUTURE_SKEW_MS;
}

function blocked(reason: Extract<StudioEligibility, { readonly eligible: false }>["reason"]): StudioEligibility {
  return Object.freeze({ eligible: false, reason });
}
