import {
  type ImmutableApprovalProposal,
  type InMemoryApprovalBroker,
  type OpaqueWriteAuthorization,
} from "@rbxforge/agent";
import { stableValueHash } from "@rbxforge/core";
import {
  studioAgentBindingHash,
  type StudioAgentClaimRedemptionHooks,
  type StudioAgentMutationClaim,
  type StudioAgentMutationClaimBinding,
  type StudioProperties,
  type StudioPropertyReadOptions,
  type StudioWriteOwnershipContext,
} from "@rbxforge/studio-mcp";

export interface StudioAgentClaimIssuer {
  issueAgentClaim(
    binding: StudioAgentMutationClaimBinding,
    hooks: StudioAgentClaimRedemptionHooks,
  ): StudioAgentMutationClaim;
  revokeRun(runId: string): void;
  disposeClaims?(): void;
}

export type StudioWriteBoundaryOutcome =
  | {
      readonly boundaryCrossed: true;
      readonly outcome: "completed" | "post-boundary-ambiguous";
    }
  | {
      readonly boundaryCrossed: false;
      readonly outcome: "cancelled" | "pre-boundary-rejected";
    };

export interface BrokerBackedStudioWritePort {
  execute(
    input: Readonly<{
      approval: ImmutableApprovalProposal;
      authorization: OpaqueWriteAuthorization;
      binding: StudioAgentMutationClaimBinding;
      context: StudioWriteOwnershipContext;
      signal: AbortSignal;
    }>,
  ): Promise<StudioWriteBoundaryOutcome>;
  revokeRun(runId: string): void;
}

export interface BrokerBackedStudioWriteOptions {
  readonly broker: InMemoryApprovalBroker;
  readonly issuer: StudioAgentClaimIssuer | undefined;
  readonly guardedProperties:
    ((path: string, options: StudioPropertyReadOptions) => Promise<StudioProperties>) | undefined;
  readonly writeWithClaim:
    | ((
        tool: string,
        input: object,
        context: StudioWriteOwnershipContext,
        claim: StudioAgentMutationClaim,
      ) => Promise<unknown>)
    | undefined;
}

/** Composes the broker and native Studio gate without exposing either raw capability. */
export function createBrokerBackedStudioWrites(
  options: BrokerBackedStudioWriteOptions,
): BrokerBackedStudioWritePort | undefined {
  const { broker, issuer, guardedProperties, writeWithClaim } = options;
  if (issuer === undefined || guardedProperties === undefined || writeWithClaim === undefined) {
    return undefined;
  }
  return Object.freeze({
    execute: async (input: Parameters<BrokerBackedStudioWritePort["execute"]>[0]) => {
      const { approval, authorization, binding, context, signal } = input;
      assertBridgeBinding(approval, binding, context);
      const revokeIssuer = (): void => {
        try {
          issuer.revokeRun(binding.runId);
        } catch {
          // Cleanup cannot replace the fixed write-boundary outcome.
        }
      };
      const revoke = (): void => {
        try {
          broker.cancelRun(binding.runId);
        } catch {
          // Cleanup cannot expose an operational error.
        }
        revokeIssuer();
      };
      if (signal.aborted) {
        revoke();
        return Object.freeze({
          boundaryCrossed: false,
          outcome: "cancelled",
        });
      }
      signal.addEventListener("abort", revoke, { once: true });
      const expectedInstanceId = context.expectedInstanceId;
      if (expectedInstanceId === undefined) {
        signal.removeEventListener("abort", revoke);
        throw new Error("Agent Studio bridge binding is invalid");
      }
      const propertyName = binding.request.input.propertyName as string;
      let boundaryCrossed = false;
      const hooks: StudioAgentClaimRedemptionHooks = Object.freeze({
        validatePrecondition: async () => {
          const properties = await guardedProperties(binding.proposal.target, {
            expectedInstanceId,
          });
          return (
            properties.instancePath === binding.proposal.target &&
            properties.className === binding.expectedClassName &&
            stableValueHash(properties.properties[propertyName]) === binding.expectedPropertyValueHash
          );
        },
        consumeAuthorization: () => {
          const consumed = broker.consumeAuthorization(authorization, approval);
          if (consumed === true) boundaryCrossed = true;
          return consumed;
        },
      });
      try {
        const claim = issuer.issueAgentClaim(binding, hooks);
        await writeWithClaim(binding.request.tool, binding.request.input, context, claim);
        return boundaryCrossed
          ? Object.freeze({
              boundaryCrossed: true,
              outcome: "completed",
            })
          : Object.freeze({
              boundaryCrossed: false,
              outcome: signal.aborted ? "cancelled" : "pre-boundary-rejected",
            });
      } catch {
        return boundaryCrossed
          ? Object.freeze({
              boundaryCrossed: true,
              outcome: "post-boundary-ambiguous",
            })
          : Object.freeze({
              boundaryCrossed: false,
              outcome: signal.aborted ? "cancelled" : "pre-boundary-rejected",
            });
      } finally {
        signal.removeEventListener("abort", revoke);
        revokeIssuer();
      }
    },
    revokeRun: (runId: string) => {
      try {
        issuer.revokeRun(runId);
      } catch {
        // Revocation is best effort and has no raw-error channel.
      }
    },
  });
}

function assertBridgeBinding(
  approval: ImmutableApprovalProposal,
  binding: StudioAgentMutationClaimBinding,
  context: StudioWriteOwnershipContext,
): void {
  const requestInput = binding.request.input;
  if (
    approval.kind !== "studio" ||
    !Object.isFrozen(approval) ||
    !Object.isFrozen(binding) ||
    !isDeepFrozen(binding) ||
    !/^[a-f0-9]{64}$/u.test(approval.bindingHash ?? "") ||
    !/^[a-f0-9]{64}$/u.test(binding.expectedPropertyValueHash) ||
    typeof binding.expectedClassName !== "string" ||
    binding.expectedClassName.length === 0 ||
    approval.bindingHash !== studioAgentBindingHash(binding) ||
    approval.sessionId !== binding.sessionId ||
    approval.generation !== binding.generation ||
    approval.runId !== binding.runId ||
    approval.expiresAt !== binding.expiresAt ||
    binding.request.tool !== "set_property" ||
    typeof requestInput.instancePath !== "string" ||
    requestInput.instancePath !== binding.proposal.target ||
    typeof requestInput.propertyName !== "string" ||
    requestInput.propertyName.length === 0 ||
    binding.proposal.kind !== "studio" ||
    binding.proposal.operation !== "property-write" ||
    context.expectedInstanceId === undefined ||
    binding.proposal.instanceId !== context.expectedInstanceId ||
    binding.proposal.graphRevision !== context.expectedGraphRevision ||
    binding.proposal.ownership !== context.ownership
  ) {
    throw new Error("Agent Studio bridge binding is invalid");
  }
}

function isDeepFrozen(value: unknown): boolean {
  if (value === null || typeof value !== "object") return true;
  if (!Object.isFrozen(value)) return false;
  return Object.values(value).every(isDeepFrozen);
}
