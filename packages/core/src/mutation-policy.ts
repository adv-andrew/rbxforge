import type { Ownership } from "./instance-types.js";

export type MutationKind = "read" | "filesystem" | "studio" | "command" | "destructive";

export type MutationOperation =
  | "read"
  | "file-edit"
  | "property-write"
  | "create"
  | "delete"
  | "bulk"
  | "arbitrary-luau"
  | "upload"
  | "publish"
  | "external-command";

export type MutationDisposition = "auto" | "preview" | "confirm-session-only" | "confirm-dangerous" | "blocked";

export interface MutationProposal {
  readonly kind: MutationKind;
  readonly operation: MutationOperation;
  readonly target: string;
  readonly ownership?: Ownership;
  readonly instanceId?: string;
  readonly placeName?: string;
  readonly graphRevision?: number;
  readonly connectedInstanceCount?: number;
}

export interface MutationDecision {
  readonly disposition: MutationDisposition;
  readonly warning?: string;
  readonly reason?: string;
}

/** Determines the approval required for a proposed mutation. */
export function decideMutation(proposal: MutationProposal): MutationDecision {
  if (proposal.kind === "read" || proposal.operation === "read") {
    return { disposition: "auto" };
  }

  if (
    proposal.kind === "studio" &&
    proposal.connectedInstanceCount !== undefined &&
    proposal.connectedInstanceCount > 1 &&
    proposal.instanceId === undefined
  ) {
    return {
      disposition: "blocked",
      reason: "Studio mutation requires an instanceId when multiple instances are connected",
    };
  }

  if (proposal.ownership === "unknown" || proposal.ownership === "drift") {
    return {
      disposition: "blocked",
      reason: "Mutations are blocked for unknown or drift ownership",
    };
  }

  if (isDangerous(proposal.operation)) {
    return { disposition: "confirm-dangerous" };
  }

  if (proposal.kind === "studio" && proposal.operation === "property-write") {
    if (proposal.ownership === "files") {
      return {
        disposition: "confirm-session-only",
        warning: "Session-only; Rojo may overwrite this",
      };
    }
    if (proposal.ownership === "studio") {
      return { disposition: "preview" };
    }
  }

  if (proposal.kind === "filesystem") {
    return { disposition: "preview" };
  }

  return {
    disposition: "blocked",
    reason: "Mutation is not covered by the approval policy",
  };
}

/** Compares a requested mutation result with observed data. */
export function verifyMutation(expected: unknown, actual: unknown): "verified" | "mismatch" | "unverifiable" {
  if (actual === undefined) {
    return "unverifiable";
  }
  return stableDeepEqual(expected, actual) ? "verified" : "mismatch";
}

function isDangerous(operation: MutationOperation): boolean {
  return (
    operation === "delete" ||
    operation === "bulk" ||
    operation === "arbitrary-luau" ||
    operation === "upload" ||
    operation === "publish" ||
    operation === "external-command"
  );
}

function stableDeepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => stableDeepEqual(value, right[index]))
    );
  }
  if (!isPlainObject(left) || !isPlainObject(right)) {
    return false;
  }

  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] &&
        Object.prototype.hasOwnProperty.call(right, key) &&
        stableDeepEqual(left[key], right[key]),
    )
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
