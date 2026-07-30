import { describe, expect, test } from "vitest";

import {
  PROTOCOL_VERSION,
  parseHostMessage,
  parsePersistedUiState,
  parseWebviewMessage,
  sanitizeForWebview,
} from "./protocol.js";

const base = { v: PROTOCOL_VERSION, sessionId: "opaque-session", requestId: "request-1", generation: 3 } as const;

describe("strict webview protocol", () => {
  test("parses a known ready envelope", () => {
    expect(parseWebviewMessage({ ...base, type: "ready" })).toEqual({ ...base, type: "ready" });
  });

  test.each([
    { ...base, v: 2, type: "ready" },
    { ...base, type: "unknown" },
    { ...base, type: "runConnectionAction", action: "shell.exec" },
    {
      ...base,
      type: "proposePropertyMutation",
      proposal: {
        instanceId: "place:1",
        instancePath: "game.Workspace.Part",
        propertyName: "Anchored",
        snapshotId: "snap-1",
        value: true,
        displayGeneration: 3,
        approved: true,
      },
    },
    { ...base, type: "ready", extra: true },
  ])("rejects unknown version, type, action, approval, or extra fields %#", (message) => {
    expect(() => parseWebviewMessage(message)).toThrow();
  });

  test("parses a readonly host snapshot but rejects extra sensitive fields", () => {
    const checks = [
      "workspace",
      "rojoBinary",
      "rojoProcess",
      "rojoApi",
      "mcpProcess",
      "studioPlugin",
      "studioPlace",
      "activeStudioInstance",
      "placeRestriction",
      "aiProvider",
    ].map((id) => ({
      id,
      label: id,
      required: id !== "aiProvider",
      health: "unknown",
      detail: "Not checked",
      observedAt: 10,
    }));
    expect(
      parseHostMessage({
        ...base,
        type: "connectionSnapshot",
        snapshot: {
          aggregate: "Not ready",
          simulation: false,
          observedAt: 10,
          checks,
        },
      }),
    ).toMatchObject({ type: "connectionSnapshot" });
    expect(() =>
      parseHostMessage({
        ...base,
        type: "protocolError",
        message: "Reload",
        authorization: "Bearer secret",
      }),
    ).toThrow();
  });

  test("accepts only opaque IDs and a decision in an approval response", () => {
    const response = {
      ...base,
      type: "resolveAgentApproval",
      runId: "run-opaque-1",
      approvalId: "approval-opaque-1",
      decision: "approve",
    } as const;
    expect(parseWebviewMessage(response)).toEqual(response);

    for (const extra of [
      { args: { propertyName: "Source" } },
      { source: "print('hidden')" },
      { secret: "must-not-cross-boundary" },
      { change: { before: "false", after: "true" } },
    ]) {
      expect(() => parseWebviewMessage({ ...response, ...extra })).toThrow();
    }
  });

  test("accepts bounded display-only before/after descriptors on host approval cards", () => {
    const message = {
      ...base,
      type: "agentApproval",
      approval: {
        runId: "run-opaque-1",
        approvalId: "approval-opaque-1",
        kind: "studio",
        summary: "Set one allowed property",
        expiresAt: 1_000,
        change: {
          before: "false",
          after: "true",
        },
      },
    } as const;
    expect(parseHostMessage(message)).toEqual(message);
  });

  test.each([
    { change: { before: "", after: "true" } },
    { change: { before: "false", after: "" } },
    { change: { before: "x".repeat(161), after: "true" } },
    { change: { before: "false", after: "x".repeat(161) } },
    { change: { before: "false", after: "true", source: "print('hidden')" } },
    { change: { before: "false", after: "true", secret: "hidden" } },
  ])("rejects malformed, oversized, or sensitive approval descriptors %#", (extra) => {
    const message = {
      ...base,
      type: "agentApproval",
      approval: {
        runId: "run-opaque-1",
        approvalId: "approval-opaque-1",
        kind: "studio",
        summary: "Set one allowed property",
        expiresAt: 1_000,
      },
    } as const;
    expect(() =>
      parseHostMessage({
        ...message,
        approval: { ...message.approval, ...extra },
      }),
    ).toThrow();
  });

  test("rejects value descriptors on filesystem approval cards", () => {
    expect(() =>
      parseHostMessage({
        ...base,
        type: "agentApproval",
        approval: {
          runId: "run-opaque-1",
          approvalId: "approval-opaque-1",
          kind: "filesystem",
          summary: "Edit one existing file",
          expiresAt: 1_000,
          change: {
            before: "old",
            after: "new",
          },
        },
      }),
    ).toThrow();
  });

  test("rejects executable fields on host approval cards", () => {
    const message = {
      ...base,
      type: "agentApproval",
      approval: {
        runId: "run-opaque-1",
        approvalId: "approval-opaque-1",
        kind: "studio",
        summary: "Set one allowed property",
        expiresAt: 1_000,
      },
    } as const;
    for (const extra of [
      { args: { propertyName: "Source" } },
      { source: "print('hidden')" },
      { secret: "must-not-cross-boundary" },
    ]) {
      expect(() =>
        parseHostMessage({
          ...message,
          approval: { ...message.approval, ...extra },
        }),
      ).toThrow();
    }
  });

  test("bounds Agent text deltas by UTF-8 bytes", () => {
    const message = {
      ...base,
      type: "agentTextDelta",
      runId: "run-opaque-1",
      sequence: 1,
    } as const;
    expect(parseHostMessage({ ...message, delta: "💎".repeat(4_096) })).toMatchObject({
      type: "agentTextDelta",
    });
    expect(() => parseHostMessage({ ...message, delta: `${"💎".repeat(4_096)}a` })).toThrow();
  });
});

describe("webview serialization boundary", () => {
  test("deeply removes secret-like keys while preserving harmless readonly values", () => {
    expect(
      sanitizeForWebview({
        label: "safe",
        nested: {
          apiToken: "hidden",
          children: [{ credentialPath: "/secret", detail: "visible" }],
        },
      }),
    ).toEqual({ label: "safe", nested: { children: [{ detail: "visible" }] } });
  });

  test("clears malformed or sensitive persisted state", () => {
    expect(
      parsePersistedUiState({
        query: "Position",
        collapsedCategories: ["Transform"],
        selectedPath: "game.Workspace.Part",
        scrollAnchor: "Position",
      }),
    ).toEqual({
      query: "Position",
      collapsedCategories: ["Transform"],
      selectedPath: "game.Workspace.Part",
      scrollAnchor: "Position",
    });
    expect(parsePersistedUiState({ query: "x", token: "secret" })).toEqual({});
    expect(parsePersistedUiState({ query: 4 })).toEqual({});
  });
});
