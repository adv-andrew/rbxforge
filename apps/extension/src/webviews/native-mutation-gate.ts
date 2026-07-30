import { randomUUID } from "node:crypto";

import type {
  StudioAgentClaimRedemptionHooks,
  StudioAgentMutationClaim,
  StudioAgentMutationClaimBinding,
  StudioAuthorizationBinding,
  StudioAuthorizationState,
  StudioMutationGate,
} from "@rbxforge/studio-mcp";
import { sanitizeForWebview } from "@rbxforge/webview-ui/protocol";

export interface NativeStudioMutationGate extends StudioMutationGate {
  issueAgentClaim(
    binding: StudioAgentMutationClaimBinding,
    hooks: StudioAgentClaimRedemptionHooks,
  ): StudioAgentMutationClaim;
  revokeRun(runId: string): void;
  disposeClaims(): void;
}

export function createNativeStudioMutationGate(
  confirm: (preview: string) => Promise<boolean>,
  state: StudioAuthorizationState,
  options: { readonly now?: () => number } = {},
): NativeStudioMutationGate {
  const now = options.now ?? Date.now;
  const authorizations = new Map<
    string,
    {
      readonly proposal: Parameters<StudioMutationGate["authorize"]>[0];
      readonly request: Parameters<StudioMutationGate["authorize"]>[2];
      readonly runId?: string;
      readonly consumeAuthorization?: () => boolean;
    }
  >();
  const claims = new Map<
    string,
    {
      readonly binding: StudioAgentMutationClaimBinding;
      readonly hooks: StudioAgentClaimRedemptionHooks;
    }
  >();

  return {
    authorize: async (proposal, decision, request) => {
      const binding = authorizationBinding(proposal);
      if (!Object.isFrozen(proposal) || !Object.isFrozen(request) || !isDeepFrozen(request.input)) {
        throw new Error("Studio authorization requires a frozen proposal and request");
      }
      const warning = decision.warning === undefined ? "" : `\n\n${decision.warning}`;
      const input = JSON.stringify(sanitizeForWebview(request.input));
      const approved = await confirm(
        `${request.tool} → ${proposal.target}\nPlace: ${safeLabel(binding.placeName)}\nInstance: ${safeLabel(binding.instanceId)}\n\n${input}${warning}`,
      );
      if (!approved) {
        return { approved: false, reason: "User cancelled the native Studio mutation preview." };
      }
      const authorizationId = randomUUID();
      authorizations.set(authorizationId, {
        proposal,
        request,
      });
      return { approved: true, authorizationId };
    },
    consume: (authorizationId, proposal, request) => {
      const authorized = authorizations.get(authorizationId);
      authorizations.delete(authorizationId);
      if (authorized === undefined) {
        throw new Error("Studio authorization was already consumed or is unknown");
      }
      if (authorized.proposal !== proposal || authorized.request !== request) {
        throw new Error("Studio authorization binding does not match");
      }
      state.assertCurrent(authorizationBinding(proposal));
      let consumed = true;
      try {
        consumed = authorized.consumeAuthorization?.() ?? true;
      } catch {
        consumed = false;
      }
      if (consumed !== true) {
        throw new Error("Agent Studio authorization is stale or already used");
      }
    },
    authorizeClaim: async (claim, proposal, _decision, request) => {
      const entry = claims.get(claim.id);
      if (
        entry === undefined ||
        entry.binding.expiresAt <= now() ||
        !sameValue(entry.binding.proposal, proposal) ||
        !sameValue(entry.binding.request, request)
      ) {
        claims.delete(claim.id);
        return { approved: false, reason: "Agent Studio authorization is stale or does not match." };
      }
      let preconditionValid = false;
      try {
        preconditionValid = (await entry.hooks.validatePrecondition()) === true;
      } catch {
        preconditionValid = false;
      }
      if (!preconditionValid || claims.get(claim.id) !== entry || entry.binding.expiresAt <= now()) {
        if (claims.get(claim.id) === entry) claims.delete(claim.id);
        return { approved: false, reason: "Agent Studio authorization is stale or does not match." };
      }
      try {
        state.assertCurrent(authorizationBinding(proposal));
      } catch {
        claims.delete(claim.id);
        return { approved: false, reason: "Agent Studio authorization is stale or does not match." };
      }
      claims.delete(claim.id);
      const authorizationId = randomUUID();
      authorizations.set(authorizationId, {
        proposal,
        request,
        runId: entry.binding.runId,
        consumeAuthorization: entry.hooks.consumeAuthorization,
      });
      return { approved: true, authorizationId };
    },
    issueAgentClaim: (binding, hooks) => {
      if (
        !Object.isFrozen(binding) ||
        !isDeepFrozen(binding) ||
        !Object.isFrozen(hooks) ||
        typeof hooks.validatePrecondition !== "function" ||
        typeof hooks.consumeAuthorization !== "function" ||
        typeof binding.expectedClassName !== "string" ||
        binding.expectedClassName.length === 0 ||
        !/^[a-f0-9]{64}$/u.test(binding.expectedPropertyValueHash) ||
        binding.expiresAt <= now()
      ) {
        throw new Error("Agent Studio claim binding is invalid");
      }
      const id = randomUUID();
      claims.set(id, Object.freeze({ binding, hooks }));
      return Object.freeze({ id }) as StudioAgentMutationClaim;
    },
    revokeRun: (runId) => {
      for (const [id, entry] of claims) {
        if (entry.binding.runId === runId) claims.delete(id);
      }
      for (const [id, authorization] of authorizations) {
        if (authorization.runId === runId) authorizations.delete(id);
      }
    },
    disposeClaims: () => {
      claims.clear();
      authorizations.clear();
    },
  };
}

function authorizationBinding(proposal: Parameters<StudioMutationGate["authorize"]>[0]): StudioAuthorizationBinding {
  if (proposal.instanceId === undefined || proposal.placeName === undefined || proposal.graphRevision === undefined) {
    throw new Error("Studio authorization binding is incomplete");
  }
  return Object.freeze({
    instanceId: proposal.instanceId,
    placeName: proposal.placeName,
    graphRevision: proposal.graphRevision,
  });
}

function safeLabel(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 160);
}

function isDeepFrozen(value: unknown): boolean {
  if (value === null || typeof value !== "object") return true;
  if (!Object.isFrozen(value)) return false;
  return Object.values(value).every(isDeepFrozen);
}

function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => sameValue(value, right[index]))
    );
  }
  if (!plainRecord(left) || !plainRecord(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && sameValue(left[key], right[key]))
  );
}

function plainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
