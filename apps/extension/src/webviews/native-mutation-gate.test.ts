import type { MutationDecision, MutationProposal } from "@rbxforge/core";
import { describe, expect, test, vi } from "vitest";

import { createNativeStudioMutationGate } from "./native-mutation-gate.js";

const proposal: MutationProposal = Object.freeze({
  kind: "studio",
  operation: "property-write",
  target: "game.Workspace.Part",
  ownership: "studio",
  instanceId: "place:123",
  placeName: "Forge",
  graphRevision: 7,
});
const decision: MutationDecision = { disposition: "preview" };
const request = Object.freeze({
  tool: "set_property",
  input: Object.freeze({
    instancePath: "game.Workspace.Part",
    propertyName: "Anchored",
    propertyValue: true,
    metadata: Object.freeze({ authToken: "raw-token" }),
  }),
});

describe("native Studio mutation gate", () => {
  test("approves only an explicit native confirmation", async () => {
    const confirm = vi.fn(async () => true);
    const assertCurrent = vi.fn();
    const gate = createNativeStudioMutationGate(confirm, { assertCurrent });
    const authorization = await gate.authorize(proposal, decision, request);
    expect(authorization).toEqual({
      approved: true,
      authorizationId: expect.any(String),
    });
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("set_property → game.Workspace.Part"));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Place: Forge"));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Instance: place:123"));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('"propertyName":"Anchored"'));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('"propertyValue":true'));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('"metadata":{}'));
    expect(confirm).not.toHaveBeenCalledWith(expect.stringContaining("raw-token"));
    if (!authorization.approved) throw new Error("Expected approval");
    gate.consume(authorization.authorizationId, proposal, request);
    expect(assertCurrent).toHaveBeenCalledWith({
      instanceId: "place:123",
      placeName: "Forge",
      graphRevision: 7,
    });
  });

  test("distinguishes identical paths in two Studio places", async () => {
    const previews: string[] = [];
    const gate = createNativeStudioMutationGate(
      async (preview) => {
        previews.push(preview);
        return false;
      },
      { assertCurrent: () => undefined },
    );

    await gate.authorize(proposal, decision, request);
    await gate.authorize(
      Object.freeze({
        ...proposal,
        instanceId: "place:456",
        placeName: "Harbor\n\tBay\u0000",
      }),
      decision,
      request,
    );

    expect(previews[0]).toContain("Place: Forge");
    expect(previews[1]).toContain("Place: Harbor Bay");
    expect(previews[1]).toContain("Place: Harbor Bay\nInstance: place:456");
    expect(previews[1]).not.toContain("\u0000");
    expect(previews[0]).toContain("Instance: place:123");
    expect(previews[1]).toContain("Instance: place:456");
    expect(previews[0]).not.toBe(previews[1]);
  });

  test("rejects cancellation without exposing an executable authorization callback", async () => {
    const gate = createNativeStudioMutationGate(async () => false, {
      assertCurrent: () => undefined,
    });
    await expect(gate.authorize(proposal, decision, request)).resolves.toEqual({
      approved: false,
      reason: "User cancelled the native Studio mutation preview.",
    });
  });

  test("consumes an opaque authorization once and cannot cross-authorize another place", async () => {
    const assertCurrent = vi.fn();
    const gate = createNativeStudioMutationGate(async () => true, { assertCurrent });
    const authorization = await gate.authorize(proposal, decision, request);
    if (!authorization.approved) throw new Error("Expected approval");

    expect(() =>
      gate.consume(
        authorization.authorizationId,
        {
          ...proposal,
          instanceId: "place:456",
          placeName: "Harbor",
        },
        request,
      ),
    ).toThrow("authorization binding");
    expect(assertCurrent).not.toHaveBeenCalled();
    expect(() => gate.consume(authorization.authorizationId, proposal, request)).toThrow("authorization");
  });

  test("redeems one exact unexpired Agent claim without showing a second modal", async () => {
    const confirm = vi.fn(async () => true);
    const assertCurrent = vi.fn();
    const validatePrecondition = vi.fn(async () => true);
    const consumeAuthorization = vi.fn(() => true);
    const gate = createNativeStudioMutationGate(confirm, { assertCurrent }, { now: () => 100 });
    const claim = gate.issueAgentClaim(
      Object.freeze({
        sessionId: "session-1",
        generation: 2,
        runId: "run-1",
        expiresAt: 200,
        proposal,
        request,
        expectedClassName: "Part",
        expectedPropertyValueHash: "a".repeat(64),
      }),
      Object.freeze({ validatePrecondition, consumeAuthorization }),
    );
    const authorization = await gate.authorizeClaim?.(claim, proposal, decision, request);
    expect(authorization).toEqual({ approved: true, authorizationId: expect.any(String) });
    expect(confirm).not.toHaveBeenCalled();
    expect(validatePrecondition).toHaveBeenCalledTimes(1);
    expect(consumeAuthorization).not.toHaveBeenCalled();
    if (authorization === undefined || !authorization.approved) throw new Error("Expected claim approval");
    gate.consume(authorization.authorizationId, proposal, request);
    expect(consumeAuthorization).toHaveBeenCalledTimes(1);
    expect(assertCurrent).toHaveBeenCalledTimes(2);
    await expect(gate.authorizeClaim?.(claim, proposal, decision, request)).resolves.toEqual({
      approved: false,
      reason: "Agent Studio authorization is stale or does not match.",
    });
  });

  test("fails closed for expired or mismatched Agent claims", async () => {
    let now = 100;
    const gate = createNativeStudioMutationGate(
      async () => true,
      {
        assertCurrent: () => undefined,
      },
      { now: () => now },
    );
    const claim = gate.issueAgentClaim(
      Object.freeze({
        sessionId: "session-1",
        generation: 1,
        runId: "run-1",
        expiresAt: 101,
        proposal,
        request,
        expectedClassName: "Part",
        expectedPropertyValueHash: "a".repeat(64),
      }),
      Object.freeze({
        validatePrecondition: async () => true,
        consumeAuthorization: () => true,
      }),
    );
    await expect(
      gate.authorizeClaim?.(
        claim,
        {
          ...proposal,
          graphRevision: 8,
        },
        decision,
        request,
      ),
    ).resolves.toEqual({
      approved: false,
      reason: "Agent Studio authorization is stale or does not match.",
    });
    const expiring = gate.issueAgentClaim(
      Object.freeze({
        sessionId: "session-1",
        generation: 1,
        runId: "run-2",
        expiresAt: 101,
        proposal,
        request,
        expectedClassName: "Part",
        expectedPropertyValueHash: "a".repeat(64),
      }),
      Object.freeze({
        validatePrecondition: async () => true,
        consumeAuthorization: () => true,
      }),
    );
    now = 101;
    await expect(gate.authorizeClaim?.(expiring, proposal, decision, request)).resolves.toEqual({
      approved: false,
      reason: "Agent Studio authorization is stale or does not match.",
    });
  });

  test("revocation during the final async precondition leaves broker authorization unconsumed", async () => {
    let releaseValidation: ((valid: boolean) => void) | undefined;
    const validation = new Promise<boolean>((resolve) => {
      releaseValidation = resolve;
    });
    const consumeAuthorization = vi.fn(() => true);
    const gate = createNativeStudioMutationGate(
      async () => true,
      {
        assertCurrent: () => undefined,
      },
      { now: () => 100 },
    );
    const claim = gate.issueAgentClaim(
      Object.freeze({
        sessionId: "session-1",
        generation: 1,
        runId: "run-cancelled",
        expiresAt: 200,
        proposal,
        request,
        expectedClassName: "Part",
        expectedPropertyValueHash: "a".repeat(64),
      }),
      Object.freeze({
        validatePrecondition: () => validation,
        consumeAuthorization,
      }),
    );

    const authorization = gate.authorizeClaim?.(claim, proposal, decision, request);
    await Promise.resolve();
    gate.revokeRun("run-cancelled");
    releaseValidation?.(true);

    await expect(authorization).resolves.toEqual({
      approved: false,
      reason: "Agent Studio authorization is stale or does not match.",
    });
    expect(consumeAuthorization).not.toHaveBeenCalled();
  });

  test("a failed true-boundary value precondition does not consume broker authorization", async () => {
    const consumeAuthorization = vi.fn(() => true);
    const gate = createNativeStudioMutationGate(
      async () => true,
      {
        assertCurrent: () => undefined,
      },
      { now: () => 100 },
    );
    const claim = gate.issueAgentClaim(
      Object.freeze({
        sessionId: "session-1",
        generation: 1,
        runId: "run-stale",
        expiresAt: 200,
        proposal,
        request,
        expectedClassName: "Part",
        expectedPropertyValueHash: "a".repeat(64),
      }),
      Object.freeze({
        validatePrecondition: async () => false,
        consumeAuthorization,
      }),
    );

    await expect(gate.authorizeClaim?.(claim, proposal, decision, request)).resolves.toEqual({
      approved: false,
      reason: "Agent Studio authorization is stale or does not match.",
    });
    expect(consumeAuthorization).not.toHaveBeenCalled();
    await expect(gate.authorizeClaim?.(claim, proposal, decision, request)).resolves.toEqual({
      approved: false,
      reason: "Agent Studio authorization is stale or does not match.",
    });
  });

  test("fails closed when the broker authorization expires during final validation", async () => {
    const gate = createNativeStudioMutationGate(
      async () => true,
      {
        assertCurrent: () => undefined,
      },
      { now: () => 100 },
    );
    const claim = gate.issueAgentClaim(
      Object.freeze({
        sessionId: "session-1",
        generation: 1,
        runId: "run-expired-broker",
        expiresAt: 200,
        proposal,
        request,
        expectedClassName: "Part",
        expectedPropertyValueHash: "a".repeat(64),
      }),
      Object.freeze({
        validatePrecondition: async () => true,
        consumeAuthorization: () => false,
      }),
    );

    const authorization = await gate.authorizeClaim?.(claim, proposal, decision, request);
    expect(authorization).toEqual({ approved: true, authorizationId: expect.any(String) });
    if (authorization === undefined || !authorization.approved) throw new Error("Expected claim approval");
    expect(() => gate.consume(authorization.authorizationId, proposal, request)).toThrow("stale or already used");
    await expect(gate.authorizeClaim?.(claim, proposal, decision, request)).resolves.toEqual({
      approved: false,
      reason: "Agent Studio authorization is stale or does not match.",
    });
  });

  test("concurrent redemption of one claim consumes exactly one broker authorization", async () => {
    const release: Array<() => void> = [];
    const consumeAuthorization = vi.fn(() => true);
    const gate = createNativeStudioMutationGate(
      async () => true,
      {
        assertCurrent: () => undefined,
      },
      { now: () => 100 },
    );
    const claim = gate.issueAgentClaim(
      Object.freeze({
        sessionId: "session-1",
        generation: 1,
        runId: "run-concurrent",
        expiresAt: 200,
        proposal,
        request,
        expectedClassName: "Part",
        expectedPropertyValueHash: "a".repeat(64),
      }),
      Object.freeze({
        validatePrecondition: () =>
          new Promise<boolean>((resolve) => {
            release.push(() => resolve(true));
          }),
        consumeAuthorization,
      }),
    );

    const first = gate.authorizeClaim?.(claim, proposal, decision, request);
    const second = gate.authorizeClaim?.(claim, proposal, decision, request);
    await vi.waitFor(() => expect(release).toHaveLength(2));
    release.forEach((resolve) => resolve());
    const results = await Promise.all([first, second]);

    expect(results.filter((result) => result?.approved)).toHaveLength(1);
    expect(consumeAuthorization).not.toHaveBeenCalled();
    const approved = results.find((result) => result?.approved);
    if (approved === undefined || !approved.approved) throw new Error("Expected one claim approval");
    gate.consume(approved.authorizationId, proposal, request);
    expect(consumeAuthorization).toHaveBeenCalledTimes(1);
  });

  test("revocation after validation but before native consume leaves broker approval unconsumed", async () => {
    const consumeAuthorization = vi.fn(() => true);
    const gate = createNativeStudioMutationGate(
      async () => true,
      {
        assertCurrent: () => undefined,
      },
      { now: () => 100 },
    );
    const claim = gate.issueAgentClaim(
      Object.freeze({
        sessionId: "session-1",
        generation: 1,
        runId: "run-resume-gap",
        expiresAt: 200,
        proposal,
        request,
        expectedClassName: "Part",
        expectedPropertyValueHash: "a".repeat(64),
      }),
      Object.freeze({
        validatePrecondition: async () => true,
        consumeAuthorization,
      }),
    );

    const authorization = await gate.authorizeClaim?.(claim, proposal, decision, request);
    if (authorization === undefined || !authorization.approved) throw new Error("Expected claim approval");
    gate.revokeRun("run-resume-gap");

    expect(() => gate.consume(authorization.authorizationId, proposal, request)).toThrow(
      "already consumed or is unknown",
    );
    expect(consumeAuthorization).not.toHaveBeenCalled();
  });
});
