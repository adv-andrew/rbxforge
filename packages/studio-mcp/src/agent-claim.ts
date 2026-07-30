import { stableValueHash } from "@rbxforge/core";

import type { MutationProposal } from "@rbxforge/core";

import type { StudioMutationRequest } from "./types.js";

export interface StudioAgentBindingDigestInput {
  readonly proposal: MutationProposal;
  readonly request: StudioMutationRequest;
  readonly expectedClassName: string;
  readonly expectedPropertyValueHash: string;
}

/** Binds a user-visible approval to one exact Studio request and old-value precondition. */
export function studioAgentBindingHash(input: StudioAgentBindingDigestInput): string {
  return stableValueHash({
    proposal: input.proposal,
    request: input.request,
    expectedClassName: input.expectedClassName,
    expectedPropertyValueHash: input.expectedPropertyValueHash,
  });
}
