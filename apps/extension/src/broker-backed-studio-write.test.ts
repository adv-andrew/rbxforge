import { InMemoryApprovalBroker, type ImmutableApprovalProposal, type OpaqueWriteAuthorization } from "@rbxforge/agent";
import { stableValueHash } from "@rbxforge/core";
import { studioAgentBindingHash, type StudioAgentMutationClaimBinding } from "@rbxforge/studio-mcp";
import { describe, expect, test, vi } from "vitest";

import { createBrokerBackedStudioWrites } from "./broker-backed-studio-write.js";
import { createConnectionState } from "./connection-state.js";
import { createProductionAdapters, type StudioRuntimePort } from "./production-adapters.js";
import { createNativeStudioMutationGate } from "./webviews/native-mutation-gate.js";

const proposal = Object.freeze({
  kind: "studio" as const,
  operation: "property-write" as const,
  target: "game.Workspace.Part",
  ownership: "studio" as const,
  instanceId: "place:123",
  placeName: "Forge",
  graphRevision: 7,
});
const request = Object.freeze({
  tool: "set_property",
  input: Object.freeze({
    instancePath: "game.Workspace.Part",
    propertyName: "Anchored",
    propertyValue: true,
  }),
});
const context = Object.freeze({
  ownership: "studio" as const,
  expectedInstanceId: "place:123",
  expectedGraphRevision: 7,
});

describe("broker-backed Studio write boundary", () => {
  test("Stop or timeout during production adapter readiness revokes without consuming approval", async () => {
    const broker = createBroker();
    const consumeAuthorization = vi.spyOn(broker, "consumeAuthorization");
    const binding = createBinding();
    const approval = createApproval(binding);
    const authorization = await approve(broker, approval);
    const gate = createNativeStudioMutationGate(
      async () => true,
      {
        assertCurrent: () => undefined,
      },
      { now: () => 100 },
    );
    const runtime: StudioRuntimePort = {
      discover: async () => new Set(),
      listConnectedInstances: async () => [],
      snapshot: () => ({ activeInstanceId: "place:123" }),
      selectInstance: () => undefined,
      children: async () => [],
      properties: matchingProperties,
      callWriteWithClaim: async (_tool, _input, _context, claim) => {
        const native = await gate.authorizeClaim?.(
          claim,
          binding.proposal,
          { disposition: "preview" },
          binding.request,
        );
        if (native === undefined || !native.approved) throw new Error("claim denied");
        gate.consume(native.authorizationId, binding.proposal, binding.request);
        return { success: true };
      },
      close: async () => undefined,
    };
    let releaseStudio: ((studio: StudioRuntimePort) => void) | undefined;
    const studioReady = new Promise<StudioRuntimePort>((resolve) => {
      releaseStudio = resolve;
    });
    let enteredReadiness: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      enteredReadiness = resolve;
    });
    const adapters = createProductionAdapters({
      connection: createConnectionState(),
      createStudio: () => {
        enteredReadiness?.();
        return studioReady;
      },
    });
    const bridge = requiredBridge({
      broker,
      issuer: gate,
      guardedProperties: adapters.guardedProperties,
      writeWithClaim: adapters.callWriteWithClaim,
    });
    const abort = new AbortController();

    const executing = bridge.execute({
      approval,
      authorization,
      binding,
      context,
      signal: abort.signal,
    });
    await entered;
    abort.abort(new Error("Run timeout"));
    releaseStudio?.(runtime);

    await expect(executing).resolves.toEqual({
      boundaryCrossed: false,
      outcome: "cancelled",
    });
    expect(consumeAuthorization).not.toHaveBeenCalled();
    await adapters.dispose();
  });

  test("pre-aborted execution returns a fixed cancellation without issuing a claim", async () => {
    const broker = createBroker();
    const binding = createBinding();
    const approval = createApproval(binding);
    const authorization = await approve(broker, approval);
    const issueAgentClaim = vi.fn();
    const bridge = requiredBridge({
      broker,
      issuer: {
        issueAgentClaim,
        revokeRun: vi.fn(),
      },
      guardedProperties: matchingProperties,
      writeWithClaim: vi.fn(),
    });
    const abort = new AbortController();
    abort.abort(new Error("raw-cancellation-sentinel"));

    const outcome = await bridge.execute({
      approval,
      authorization,
      binding,
      context,
      signal: abort.signal,
    });

    expect(outcome).toEqual({
      boundaryCrossed: false,
      outcome: "cancelled",
    });
    expect(JSON.stringify(outcome)).not.toContain("raw-cancellation-sentinel");
    expect(issueAgentClaim).not.toHaveBeenCalled();
  });

  test("rejects a same-envelope request substitution before claim issuance", async () => {
    const broker = createBroker();
    const approvedBinding = createBinding();
    const approval = createApproval(approvedBinding);
    const authorization = await approve(broker, approval);
    const substitutedBinding = createBinding({
      request: Object.freeze({
        ...request,
        input: Object.freeze({ ...request.input, propertyValue: false }),
      }),
    });
    const issueAgentClaim = vi.fn();
    const bridge = requiredBridge({
      broker,
      issuer: {
        issueAgentClaim,
        revokeRun: vi.fn(),
      },
      guardedProperties: matchingProperties,
      writeWithClaim: vi.fn(),
    });

    await expect(
      bridge.execute({
        approval,
        authorization,
        binding: substitutedBinding,
        context,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("bridge binding is invalid");
    expect(issueAgentClaim).not.toHaveBeenCalled();
    expect(broker.consumeAuthorization(authorization, approval)).toBe(true);
  });

  test("changed old value at claim redemption denies the write without consuming approval", async () => {
    const broker = createBroker();
    const binding = createBinding();
    const approval = createApproval(binding);
    const authorization = await approve(broker, approval);
    const gate = createNativeStudioMutationGate(
      async () => true,
      {
        assertCurrent: () => undefined,
      },
      { now: () => 100 },
    );
    const guardedProperties = vi.fn(async () =>
      Object.freeze({
        instancePath: proposal.target,
        className: "Part",
        properties: Object.freeze({ Anchored: true }),
      }),
    );
    const wrote = vi.fn();
    const bridge = requiredBridge({
      broker,
      issuer: gate,
      guardedProperties,
      writeWithClaim: async (_tool, _input, _context, claim) => {
        const native = await gate.authorizeClaim?.(
          claim,
          binding.proposal,
          { disposition: "preview" },
          binding.request,
        );
        if (native === undefined || !native.approved) throw new Error("claim denied");
        gate.consume(native.authorizationId, binding.proposal, binding.request);
        wrote();
      },
    });

    const outcome = await bridge.execute({
      approval,
      authorization,
      binding,
      context,
      signal: new AbortController().signal,
    });
    expect(outcome).toEqual({
      boundaryCrossed: false,
      outcome: "pre-boundary-rejected",
    });
    expect(JSON.stringify(outcome)).not.toContain("claim denied");
    expect(guardedProperties).toHaveBeenCalledWith("game.Workspace.Part", {
      expectedInstanceId: "place:123",
    });
    expect(wrote).not.toHaveBeenCalled();
    expect(broker.consumeAuthorization(authorization, approval)).toBe(true);
  });

  test("matching final read consumes broker and native authorizations exactly once", async () => {
    const broker = createBroker();
    const binding = createBinding();
    const approval = createApproval(binding);
    const authorization = await approve(broker, approval);
    const gate = createNativeStudioMutationGate(
      async () => true,
      {
        assertCurrent: () => undefined,
      },
      { now: () => 100 },
    );
    const wrote = vi.fn();
    const bridge = requiredBridge({
      broker,
      issuer: gate,
      guardedProperties: matchingProperties,
      writeWithClaim: async (_tool, _input, _context, claim) => {
        const native = await gate.authorizeClaim?.(
          claim,
          binding.proposal,
          { disposition: "preview" },
          binding.request,
        );
        if (native === undefined || !native.approved) throw new Error("claim denied");
        gate.consume(native.authorizationId, binding.proposal, binding.request);
        wrote();
        return { success: true, rawValue: "raw-studio-result-sentinel" };
      },
    });

    const outcome = await bridge.execute({
      approval,
      authorization,
      binding,
      context,
      signal: new AbortController().signal,
    });
    expect(outcome).toEqual({
      boundaryCrossed: true,
      outcome: "completed",
    });
    expect(JSON.stringify(outcome)).not.toContain("raw-studio-result-sentinel");
    expect(wrote).toHaveBeenCalledTimes(1);
    expect(broker.consumeAuthorization(authorization, approval)).toBe(false);
  });

  test("adapter resolution without hook consumption remains pre-boundary rejected", async () => {
    const broker = createBroker();
    const binding = createBinding();
    const approval = createApproval(binding);
    const authorization = await approve(broker, approval);
    const bridge = requiredBridge({
      broker,
      issuer: {
        issueAgentClaim: vi.fn(() => Object.freeze({ id: "unused-claim" }) as never),
        revokeRun: vi.fn(),
      },
      guardedProperties: matchingProperties,
      writeWithClaim: async () => ({ success: true, rawValue: "raw-resolved-sentinel" }),
    });

    const outcome = await bridge.execute({
      approval,
      authorization,
      binding,
      context,
      signal: new AbortController().signal,
    });

    expect(outcome).toEqual({
      boundaryCrossed: false,
      outcome: "pre-boundary-rejected",
    });
    expect(JSON.stringify(outcome)).not.toContain("raw-resolved-sentinel");
    expect(broker.consumeAuthorization(authorization, approval)).toBe(true);
  });

  test("post-consume adapter failure returns fixed ambiguity without leaking its error", async () => {
    const broker = createBroker();
    const binding = createBinding();
    const approval = createApproval(binding);
    const authorization = await approve(broker, approval);
    const gate = createNativeStudioMutationGate(
      async () => true,
      {
        assertCurrent: () => undefined,
      },
      { now: () => 100 },
    );
    const bridge = requiredBridge({
      broker,
      issuer: gate,
      guardedProperties: matchingProperties,
      writeWithClaim: async (_tool, _input, _context, claim) => {
        const native = await gate.authorizeClaim?.(
          claim,
          binding.proposal,
          { disposition: "preview" },
          binding.request,
        );
        if (native === undefined || !native.approved) throw new Error("claim denied");
        gate.consume(native.authorizationId, binding.proposal, binding.request);
        throw new Error("raw-post-consume-sentinel");
      },
    });

    const outcome = await bridge.execute({
      approval,
      authorization,
      binding,
      context,
      signal: new AbortController().signal,
    });

    expect(outcome).toEqual({
      boundaryCrossed: true,
      outcome: "post-boundary-ambiguous",
    });
    expect(JSON.stringify(outcome)).not.toContain("raw-post-consume-sentinel");
    expect(broker.consumeAuthorization(authorization, approval)).toBe(false);
  });

  test("cleanup failure cannot replace a completed fixed outcome or leak its error", async () => {
    const broker = createBroker();
    const binding = createBinding();
    const approval = createApproval(binding);
    const authorization = await approve(broker, approval);
    const gate = createNativeStudioMutationGate(
      async () => true,
      {
        assertCurrent: () => undefined,
      },
      { now: () => 100 },
    );
    const bridge = requiredBridge({
      broker,
      issuer: {
        issueAgentClaim: (claimBinding, hooks) => gate.issueAgentClaim(claimBinding, hooks),
        revokeRun: (runId) => {
          gate.revokeRun(runId);
          throw new Error("raw-cleanup-sentinel");
        },
      },
      guardedProperties: matchingProperties,
      writeWithClaim: async (_tool, _input, _context, claim) => {
        const native = await gate.authorizeClaim?.(
          claim,
          binding.proposal,
          { disposition: "preview" },
          binding.request,
        );
        if (native === undefined || !native.approved) throw new Error("claim denied");
        gate.consume(native.authorizationId, binding.proposal, binding.request);
      },
    });

    const outcome = await bridge.execute({
      approval,
      authorization,
      binding,
      context,
      signal: new AbortController().signal,
    });

    expect(outcome).toEqual({
      boundaryCrossed: true,
      outcome: "completed",
    });
    expect(JSON.stringify(outcome)).not.toContain("raw-cleanup-sentinel");
  });
});

function createBroker(): InMemoryApprovalBroker {
  return new InMemoryApprovalBroker({
    now: () => 100,
    randomId: () => "broker-authorization",
  });
}

function createBinding(changes: Partial<StudioAgentMutationClaimBinding> = {}): StudioAgentMutationClaimBinding {
  return Object.freeze({
    sessionId: "session-1",
    generation: 1,
    runId: "run-1",
    expiresAt: 200,
    expectedClassName: "Part",
    expectedPropertyValueHash: stableValueHash(false),
    proposal,
    request,
    ...changes,
  });
}

function createApproval(binding: StudioAgentMutationClaimBinding): ImmutableApprovalProposal {
  return Object.freeze({
    approvalId: "approval-1",
    preparedId: "prepared-1",
    sessionId: binding.sessionId,
    generation: binding.generation,
    runId: binding.runId,
    kind: "studio",
    summary: "Set Anchored on game.Workspace.Part in Forge",
    bindingHash: studioAgentBindingHash(binding),
    expiresAt: binding.expiresAt,
  });
}

async function approve(
  broker: InMemoryApprovalBroker,
  approval: ImmutableApprovalProposal,
): Promise<OpaqueWriteAuthorization> {
  const pending = broker.request(approval, new AbortController().signal);
  expect(
    broker.resolve({
      sessionId: approval.sessionId,
      generation: approval.generation,
      runId: approval.runId,
      approvalId: approval.approvalId,
      decision: "approve",
    }),
  ).toBe(true);
  const decision = await pending;
  if (!decision.approved) throw new Error("Expected approved broker decision");
  return decision.authorization;
}

async function matchingProperties() {
  return Object.freeze({
    instancePath: proposal.target,
    className: "Part",
    properties: Object.freeze({ Anchored: false }),
  });
}

function requiredBridge(options: Parameters<typeof createBrokerBackedStudioWrites>[0]) {
  const bridge = createBrokerBackedStudioWrites(options);
  if (bridge === undefined) throw new Error("Expected bridge");
  return bridge;
}
