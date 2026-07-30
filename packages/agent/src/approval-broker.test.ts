import { describe, expect, test } from "vitest";

import { InMemoryApprovalBroker } from "./approval-broker.js";
import type { ImmutableApprovalProposal } from "./types.js";

describe("InMemoryApprovalBroker", () => {
  test("binds one decision to exact session, generation, run and unexpired approval", async () => {
    const requested: string[] = [];
    const broker = new InMemoryApprovalBroker({
      now: () => 100,
      onRequested: (value) => requested.push(value.approvalId),
    });
    const bound = proposal();
    const request = broker.request(bound, new AbortController().signal);
    expect(requested).toEqual(["approval-1"]);
    expect(
      broker.resolve({
        sessionId: "wrong",
        generation: 1,
        runId: "run-1",
        approvalId: "approval-1",
        decision: "approve",
      }),
    ).toBe(false);
    expect(
      broker.resolve({
        sessionId: "session-1",
        generation: 1,
        runId: "run-1",
        approvalId: "approval-1",
        decision: "approve",
      }),
    ).toBe(true);
    const decision = await request;
    expect(decision).toMatchObject({
      approved: true,
      authorization: { id: expect.any(String) },
    });
    if (!decision.approved) throw new Error("Expected approval");
    expect(broker.consumeAuthorization(decision.authorization, bound)).toBe(true);
    expect(broker.consumeAuthorization(decision.authorization, bound)).toBe(false);
    expect(
      broker.resolve({
        sessionId: "session-1",
        generation: 1,
        runId: "run-1",
        approvalId: "approval-1",
        decision: "approve",
      }),
    ).toBe(false);
  });

  test("rejects expired approvals, cancellation, duplicate IDs and canceled runs", async () => {
    let now = 100;
    const broker = new InMemoryApprovalBroker({ now: () => now });
    const expired = broker.request(proposal(), new AbortController().signal);
    now = 201;
    expect(
      broker.resolve({
        sessionId: "session-1",
        generation: 1,
        runId: "run-1",
        approvalId: "approval-1",
        decision: "approve",
      }),
    ).toBe(false);
    await expect(expired).resolves.toEqual({ approved: false, reason: "expired" });

    const abort = new AbortController();
    const canceled = broker.request(
      Object.freeze({ ...proposal(), approvalId: "approval-2", runId: "run-2", expiresAt: 300 }),
      abort.signal,
    );
    abort.abort();
    await expect(canceled).resolves.toEqual({ approved: false, reason: "cancelled" });

    const run = broker.request(
      Object.freeze({ ...proposal(), approvalId: "approval-3", runId: "run-3", expiresAt: 300 }),
      new AbortController().signal,
    );
    broker.cancelRun("run-3");
    await expect(run).resolves.toEqual({ approved: false, reason: "cancelled" });
  });

  test("freezes and rejects mutable proposals", async () => {
    const broker = new InMemoryApprovalBroker();
    await expect(broker.request({ ...proposal() }, new AbortController().signal)).rejects.toThrow("frozen");
  });
});

function proposal(): ImmutableApprovalProposal {
  return Object.freeze({
    approvalId: "approval-1",
    preparedId: "prepared-1",
    sessionId: "session-1",
    generation: 1,
    runId: "run-1",
    kind: "studio",
    summary: "Set Anchored on one Part",
    expiresAt: 200,
  });
}
