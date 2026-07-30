import { randomUUID } from "node:crypto";

import type { ApprovalBroker, ApprovalDecision, ImmutableApprovalProposal, OpaqueWriteAuthorization } from "./types.js";

export interface ApprovalBrokerOptions {
  readonly now?: () => number;
  readonly randomId?: () => string;
  readonly onRequested?: (proposal: ImmutableApprovalProposal) => void;
}

interface Pending {
  readonly proposal: ImmutableApprovalProposal;
  readonly settle: (decision: ApprovalDecision) => void;
  readonly disposeAbort: () => void;
}

export class InMemoryApprovalBroker implements ApprovalBroker {
  readonly #pending = new Map<string, Pending>();
  readonly #issued = new Map<string, ImmutableApprovalProposal>();
  readonly #now: () => number;
  readonly #randomId: () => string;
  readonly #onRequested: (proposal: ImmutableApprovalProposal) => void;

  constructor(options: ApprovalBrokerOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#randomId = options.randomId ?? randomUUID;
    this.#onRequested = options.onRequested ?? (() => undefined);
  }

  request(proposal: ImmutableApprovalProposal, signal: AbortSignal): Promise<ApprovalDecision> {
    if (!Object.isFrozen(proposal)) return Promise.reject(new Error("Approval proposal must be frozen"));
    if (this.#pending.has(proposal.approvalId)) {
      return Promise.reject(new Error("Approval ID is already pending"));
    }
    if (proposal.expiresAt <= this.#now()) return Promise.resolve({ approved: false, reason: "expired" });
    if (signal.aborted) return Promise.resolve({ approved: false, reason: "cancelled" });
    return new Promise<ApprovalDecision>((resolve) => {
      let settled = false;
      const settle = (decision: ApprovalDecision): void => {
        if (settled) return;
        settled = true;
        const pending = this.#pending.get(proposal.approvalId);
        pending?.disposeAbort();
        this.#pending.delete(proposal.approvalId);
        resolve(Object.freeze(decision));
      };
      const abort = (): void => settle({ approved: false, reason: "cancelled" });
      signal.addEventListener("abort", abort, { once: true });
      const expiry = setTimeout(
        () => settle({ approved: false, reason: "expired" }),
        Math.max(0, proposal.expiresAt - this.#now()),
      );
      this.#pending.set(proposal.approvalId, {
        proposal,
        settle,
        disposeAbort: () => {
          signal.removeEventListener("abort", abort);
          clearTimeout(expiry);
        },
      });
      this.#onRequested(proposal);
    });
  }

  resolve(
    resolution: Readonly<{
      sessionId: string;
      generation: number;
      runId: string;
      approvalId: string;
      decision: "approve" | "reject";
    }>,
  ): boolean {
    const pending = this.#pending.get(resolution.approvalId);
    if (pending === undefined) return false;
    const { proposal } = pending;
    if (proposal.expiresAt <= this.#now()) {
      pending.settle({ approved: false, reason: "expired" });
      return false;
    }
    if (
      resolution.sessionId !== proposal.sessionId ||
      resolution.generation !== proposal.generation ||
      resolution.runId !== proposal.runId
    ) {
      return false;
    }
    if (resolution.decision === "reject") {
      pending.settle({ approved: false, reason: "rejected" });
      return true;
    }
    const authorizationId = this.#randomId();
    if (this.#issued.has(authorizationId)) {
      pending.settle({ approved: false, reason: "cancelled" });
      return false;
    }
    this.#issued.set(authorizationId, proposal);
    pending.settle({
      approved: true,
      authorization: Object.freeze({
        id: authorizationId,
      }) as OpaqueWriteAuthorization,
    });
    return true;
  }

  cancelRun(runId: string): void {
    for (const pending of [...this.#pending.values()]) {
      if (pending.proposal.runId === runId) {
        pending.settle({ approved: false, reason: "cancelled" });
      }
    }
    for (const [id, proposal] of this.#issued) {
      if (proposal.runId === runId) this.#issued.delete(id);
    }
  }

  consumeAuthorization(authorization: OpaqueWriteAuthorization, proposal: ImmutableApprovalProposal): boolean {
    const issued = this.#issued.get(authorization.id);
    this.#issued.delete(authorization.id);
    return issued === proposal && proposal.expiresAt > this.#now();
  }

  dispose(): void {
    for (const pending of [...this.#pending.values()]) {
      pending.settle({ approved: false, reason: "cancelled" });
    }
    this.#issued.clear();
  }
}
