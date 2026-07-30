import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  InMemoryApprovalBroker,
  assertStrictToolSchema,
  type RegisteredReadTool,
  type RegisteredWriteTool,
  type ToolContext,
} from "@rbxforge/agent";
import { MutationJournal, PlaytestController, type PlaytestCapabilityPort } from "@rbxforge/core";
import { describe, expect, test, vi } from "vitest";

import { createAgentToolRegistry } from "./agent-tools.js";
import { FilesystemPatchHost } from "./filesystem-patch-host.js";
import { createFixtureServices, type ExtensionServices } from "./service-container.js";
import { FakeVsCode } from "./test/fake-vscode.js";

describe("Agent tool registry", () => {
  test("exposes only the bounded allowlist with recursive strict schemas and redacted Studio reads", async () => {
    const fixture = createFixtureServices();
    const vscode = new FakeVsCode();
    const root = await mkdtemp(join(tmpdir(), "rbxforge-agent-tools-"));
    const patchHost = new FilesystemPatchHost({
      vscode,
      journal: fixture.journal,
      approvalBroker: fixture.agent.approvalBroker,
      workspaceRoot: async () => root,
      ignorePolicy: fixture.agent.ignorePolicy,
    });
    const registry = createAgentToolRegistry({ services: fixture, patchHost });

    expect(registry.tools.map(({ name }) => name)).toEqual([
      "selected_context",
      "studio_children",
      "studio_properties",
      "rojo_source_mapping",
      "playtest_status",
      "runtime_log_summary",
      "viewport_screenshot_metadata",
      "workspace_patch",
      "set_studio_property",
    ]);
    for (const tool of registry.tools) {
      expect(() => assertStrictToolSchema(tool.parameters)).not.toThrow();
    }
    expect(registry.tools.map(({ name }) => name).join(" ")).not.toMatch(
      /shell|luau|delete|rename|publish|upload|generic|call_write/i,
    );

    const properties = registry.tools.find(({ name }) => name === "studio_properties");
    if (properties?.access !== "read") throw new Error("Expected Studio properties read");
    const receipt = await properties.invoke(
      properties.validate({
        instanceId: "fixture-instance",
        path: "game.Workspace.Mapped",
      }),
      context(),
    );
    expect(receipt.output).toEqual({
      path: "game.Workspace.Mapped",
      className: "Script",
      properties: [],
      truncated: false,
    });
    expect(JSON.stringify(receipt)).not.toMatch(/Source|script code|base64|authorization|credential/i);

    registry.dispose();
    await fixture.dispose();
  });

  test("returns bounded Studio values and filtered log rows while exposing screenshot bytes only through a vision-gated context chip", async () => {
    const fixture = createFixtureServices();
    const root = await mkdtemp(join(tmpdir(), "rbxforge-agent-tools-"));
    const vscode = new FakeVsCode();
    const capability: PlaytestCapabilityPort = {
      start: async () => ({ success: true, action: "start", message: "started" }),
      stop: async () => ({ success: true, action: "stop", message: "stopped" }),
      status: async () => ({ success: true, action: "status", running: true, roles: ["server"] }),
      logs: vi.fn(async () => ({
        entries: Object.freeze([
          Object.freeze({ seq: 1, ts: 10, level: "OUT" as const, message: "keep useful row", capturedBy: "server" }),
          Object.freeze({ seq: 2, ts: 11, level: "WARN" as const, message: "drop other row" }),
          Object.freeze({ seq: 3, ts: 12, level: "ERR" as const, message: "keep sk-log-sentinel" }),
          Object.freeze({ seq: 4, ts: 13, level: "WARN" as const, message: "keep password=x" }),
        ]),
        totalDropped: 4,
        nextSince: 3,
        perCaptureNextSince: Object.freeze({ server: 3 }),
        perCaptureErrors: Object.freeze({}),
      })),
      screenshot: vi.fn(async () => ({
        data: "YWJj",
        mimeType: "image/png" as const,
        format: "png" as const,
        target: "edit" as const,
        capturedAt: 20,
        width: 1,
        height: 1,
      })),
    };
    const controller = new PlaytestController({ instanceId: "place:123", capability });
    const services: ExtensionServices = {
      ...fixture,
      studio: {
        ...fixture.studio,
        snapshot: () => ({ activeInstanceId: "place:123", stale: false }),
        guardedProperties: async () =>
          Object.freeze({
            instancePath: "game.Workspace.Part",
            className: "Part",
            properties: Object.freeze({
              Anchored: true,
              Metadata: {
                visible: "safe",
                nested: {
                  passwd: "nested-password-key-sentinel",
                  detail: "dbPassword=z",
                },
              },
              Name: "Useful Part",
              Note: ["Authorization", "Bearer property-sentinel"].join(": "),
              Password: "property-password-key-sentinel",
              Source: "print('must not escape')",
            }),
          }),
      },
      playtest: {
        availability: () => ({ lifecycle: true, logs: true, screenshot: true }),
        controller: (instanceId) => (instanceId === "place:123" ? controller : undefined),
      },
    };
    const patchHost = new FilesystemPatchHost({
      vscode,
      journal: fixture.journal,
      approvalBroker: fixture.agent.approvalBroker,
      workspaceRoot: async () => root,
      ignorePolicy: fixture.agent.ignorePolicy,
    });
    const chips: { id: string; label: string; kind: string }[] = [];
    const registry = createAgentToolRegistry({
      services,
      patchHost,
      onContextChip: (chip) => {
        chips.push(chip);
        return true;
      },
    });
    const toolContext = context(new AbortController().signal, {
      workspaceRoot: root,
      instanceId: "place:123",
      graphRevision: 0,
    });

    const properties = requiredRead(registry.tools, "studio_properties");
    const propertyReceipt = await properties.invoke(
      properties.validate({
        instanceId: "place:123",
        path: "game.Workspace.Part",
      }),
      toolContext,
    );
    expect(propertyReceipt.output).toEqual({
      path: "game.Workspace.Part",
      className: "Part",
      properties: [
        { name: "Anchored", value: true },
        {
          name: "Metadata",
          value: {
            visible: "safe",
            nested: { detail: "[sensitive value omitted]" },
          },
        },
        { name: "Name", value: "Useful Part" },
        { name: "Note", value: "[sensitive value omitted]" },
      ],
      truncated: false,
    });
    expect(JSON.stringify(propertyReceipt)).not.toMatch(/property-sentinel|must not escape/);

    const logs = requiredRead(registry.tools, "runtime_log_summary");
    const logReceipt = await logs.invoke(
      logs.validate({
        instanceId: "place:123",
        filter: "keep",
      }),
      toolContext,
    );
    expect(logReceipt.output).toMatchObject({
      rows: [
        { seq: 1, ts: 10, level: "OUT", message: "keep useful row", capturedBy: "server" },
        { seq: 3, ts: 12, level: "ERR", message: "[sensitive value omitted]" },
        { seq: 4, ts: 13, level: "WARN", message: "[sensitive value omitted]" },
      ],
      matched: 3,
      totalDropped: 4,
      truncated: false,
    });
    expect(JSON.stringify(logReceipt)).not.toContain("log-sentinel");
    expect(JSON.stringify({ propertyReceipt, logReceipt })).not.toMatch(
      /property-password-key-sentinel|nested-password-key-sentinel|password=x/,
    );

    const screenshot = requiredRead(registry.tools, "viewport_screenshot_metadata");
    const screenshotReceipt = await screenshot.invoke(
      screenshot.validate({
        instanceId: "place:123",
      }),
      toolContext,
    );
    expect(chips).toEqual([expect.objectContaining({ kind: "screenshot" })]);
    expect(JSON.stringify(screenshotReceipt)).not.toContain("YWJj");
    const selection = { ...toolContext.selection, chipIds: [chips[0]!.id] };
    const withoutVision = await services.agent.contextRegistry.build(
      selection,
      { vision: false },
      new AbortController().signal,
    );
    expect(withoutVision.records).toEqual([]);
    expect(withoutVision.receipts[0]).toMatchObject({ reason: "vision-unavailable" });
    const withVision = await services.agent.contextRegistry.build(
      selection,
      { vision: true },
      new AbortController().signal,
    );
    expect(withVision.records[0]).toMatchObject({
      chipId: chips[0]!.id,
      kind: "screenshot",
      content: "YWJj",
      mimeType: "image/png",
    });

    registry.dispose();
    controller.dispose();
    await fixture.dispose();
  });

  test("applies shared property policy in prepare and redeems exactly one Agent approval/claim for one captured Studio write", async () => {
    const fixture = createFixtureServices();
    const vscode = new FakeVsCode();
    const root = await mkdtemp(join(tmpdir(), "rbxforge-agent-tools-"));
    const journal = new MutationJournal();
    const requested: string[] = [];
    const broker = new InMemoryApprovalBroker({
      now: () => 100,
      randomId: ids("authorization-studio"),
      onRequested: ({ approvalId }) => requested.push(approvalId),
    });
    let mutated = false;
    const guardedProperties = vi.fn(async () =>
      Object.freeze({
        instancePath: "game.Workspace.Part",
        className: "Part",
        properties: Object.freeze({
          Anchored: mutated,
          Text: ["Authorization", "Bearer approval-sentinel"].join(": "),
        }),
      }),
    );
    const callWrite = vi.fn();
    const executeStudioWrite = vi.fn(
      async (input: Parameters<NonNullable<ExtensionServices["agent"]["studioWrites"]>["execute"]>[0]) => {
        if (!broker.consumeAuthorization(input.authorization, input.approval)) {
          throw new Error("Expected exact broker authorization");
        }
        mutated = true;
        return { boundaryCrossed: true, outcome: "completed" } as const;
      },
    );
    const assertRevision = vi.fn();
    const resolve = vi.fn(async () =>
      Object.freeze({
        node: Object.freeze({
          path: "game.Workspace.Part",
          name: "Part",
          className: "Part",
          ownership: "studio" as const,
          children: Object.freeze([]),
          unsafeUnknownChildren: false,
          unsafeParent: false,
        }),
        revision: 7,
      }),
    );
    const services: ExtensionServices = {
      ...fixture,
      graph: {
        ...fixture.graph,
        resolve,
        revision: () => 7,
        assertRevision,
      },
      studio: {
        ...fixture.studio,
        instances: async () => [studioInstance()],
        snapshot: () => ({ activeInstanceId: "place:123", stale: false }),
        guardedProperties,
        callWrite,
      },
      agent: Object.freeze({
        contextRegistry: fixture.agent.contextRegistry,
        approvalBroker: broker,
        ignorePolicy: fixture.agent.ignorePolicy,
        studioWrites: Object.freeze({
          execute: executeStudioWrite,
          revokeRun: vi.fn(),
        }),
      }),
      journal,
    };
    const patchHost = new FilesystemPatchHost({
      vscode,
      journal,
      approvalBroker: broker,
      workspaceRoot: async () => root,
      ignorePolicy: fixture.agent.ignorePolicy,
    });
    const registry = createAgentToolRegistry({
      services,
      patchHost,
      now: () => 100,
      randomId: ids("prepared-studio", "prepared-studio", "approval-studio", "journal-studio"),
    });
    const write = requiredWrite(registry.tools, "set_studio_property");

    await expect(
      write.prepare(
        write.validate({
          instanceId: "place:123",
          instancePath: "game.Workspace.Part",
          propertyName: "Source",
          propertyValue: "print('blocked')",
        }),
        context(),
      ),
    ).rejects.toThrow("blocked");
    expect(requested).toEqual([]);
    expect(executeStudioWrite).not.toHaveBeenCalled();
    expect(guardedProperties).toHaveBeenCalledTimes(1);

    const prepared = await write.prepare(
      write.validate({
        instanceId: "place:123",
        instancePath: "game.Workspace.Part",
        propertyName: "Anchored",
        propertyValue: true,
      }),
      context(),
    );
    expect(prepared).toMatchObject({
      id: "prepared-studio",
      proposal: {
        approvalId: "approval-studio",
        preparedId: "prepared-studio",
        sessionId: "session-1",
        generation: 1,
        runId: "run-1",
        kind: "studio",
        bindingHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        change: { before: "false", after: "true" },
      },
    });
    expect(Object.isFrozen(prepared.proposal)).toBe(true);
    const pending = broker.request(prepared.proposal, context().signal);
    expect(
      broker.resolve({
        sessionId: "session-1",
        generation: 1,
        runId: "run-1",
        approvalId: "approval-studio",
        decision: "approve",
      }),
    ).toBe(true);
    const decision = await pending;
    if (!decision.approved) throw new Error("Expected approved Studio proposal");

    await expect(write.execute(prepared.id, decision.authorization, context())).resolves.toMatchObject({
      ok: true,
      code: "applied",
      verification: "verified",
    });
    expect(requested).toEqual(["approval-studio"]);
    expect(executeStudioWrite).toHaveBeenCalledWith(
      expect.objectContaining({
        approval: prepared.proposal,
        authorization: decision.authorization,
        binding: expect.objectContaining({
          sessionId: "session-1",
          generation: 1,
          runId: "run-1",
          expiresAt: prepared.proposal.expiresAt,
          expectedClassName: "Part",
          expectedPropertyValueHash: expect.stringMatching(/^[a-f0-9]{64}$/),
          proposal: expect.objectContaining({
            instanceId: "place:123",
            graphRevision: 7,
            ownership: "studio",
          }),
          request: {
            tool: "set_property",
            input: {
              instancePath: "game.Workspace.Part",
              propertyName: "Anchored",
              propertyValue: true,
            },
          },
        }),
        context: {
          ownership: "studio",
          expectedInstanceId: "place:123",
          expectedGraphRevision: 7,
        },
      }),
    );
    expect(callWrite).not.toHaveBeenCalled();
    expect("callWriteWithClaim" in services.studio).toBe(false);
    expect("studioClaimIssuer" in services.agent).toBe(false);
    expect(assertRevision).toHaveBeenCalledTimes(2);
    expect(guardedProperties).toHaveBeenCalledTimes(4);
    expect(journal.entries()).toEqual([
      expect.objectContaining({
        operation: "property-write",
        target: "game.Workspace.Part.Anchored",
        result: "applied",
        verification: "verified",
        before: { valueHash: expect.stringMatching(/^[a-f0-9]{64}$/) },
        requested: { valueHash: expect.stringMatching(/^[a-f0-9]{64}$/) },
      }),
    ]);
    expect(JSON.stringify(journal.entries())).not.toMatch(/propertyValue|print\\|blocked/);

    const inverse = await write.prepare(
      write.validate({
        instanceId: "place:123",
        instancePath: "game.Workspace.Part",
        propertyName: "Anchored",
        propertyValue: false,
      }),
      context(),
    );
    expect(inverse.proposal.change).toEqual({ before: "true", after: "false" });

    const oversized = "x".repeat(1_000);
    const protectedDisplay = await write.prepare(
      write.validate({
        instanceId: "place:123",
        instancePath: "game.Workspace.Part",
        propertyName: "Text",
        propertyValue: oversized,
      }),
      context(),
    );
    expect(protectedDisplay.proposal.change).toEqual({
      before: "[sensitive value omitted]",
      after: "[string, 1000 bytes]",
    });
    expect(JSON.stringify(protectedDisplay.proposal)).not.toContain("approval-sentinel");
    expect(protectedDisplay.proposal.change?.before.length).toBeLessThanOrEqual(160);
    expect(protectedDisplay.proposal.change?.after.length).toBeLessThanOrEqual(160);

    await expect(write.execute(prepared.id, decision.authorization, context())).rejects.toThrow(
      "unknown or already used",
    );

    registry.dispose();
    broker.dispose();
    await fixture.dispose();
  });

  test("attributes a matching reread only when the Studio bridge crossed the mutation boundary", async () => {
    const fixture = createFixtureServices();
    const vscode = new FakeVsCode();
    const root = await mkdtemp(join(tmpdir(), "rbxforge-agent-attribution-"));
    const journal = new MutationJournal();
    const broker = new InMemoryApprovalBroker({
      now: () => 100,
      randomId: ids("authorization-pre-boundary", "authorization-post-boundary", "authorization-mismatch"),
    });
    let current = false;
    const guardedProperties = vi.fn(async () =>
      Object.freeze({
        instancePath: "game.Workspace.Part",
        className: "Part",
        properties: Object.freeze({ Anchored: current }),
      }),
    );
    const executeStudioWrite = vi.fn<NonNullable<ExtensionServices["agent"]["studioWrites"]>["execute"]>();
    const services: ExtensionServices = {
      ...fixture,
      graph: {
        ...fixture.graph,
        resolve: async () =>
          Object.freeze({
            node: Object.freeze({
              path: "game.Workspace.Part",
              name: "Part",
              className: "Part",
              ownership: "studio" as const,
              children: Object.freeze([]),
              unsafeUnknownChildren: false,
              unsafeParent: false,
            }),
            revision: 7,
          }),
        revision: () => 7,
        assertRevision: () => undefined,
      },
      studio: {
        ...fixture.studio,
        instances: async () => [studioInstance()],
        snapshot: () => ({ activeInstanceId: "place:123", stale: false }),
        guardedProperties,
        callWrite: vi.fn(),
      },
      agent: Object.freeze({
        contextRegistry: fixture.agent.contextRegistry,
        approvalBroker: broker,
        ignorePolicy: fixture.agent.ignorePolicy,
        studioWrites: Object.freeze({
          execute: executeStudioWrite,
          revokeRun: vi.fn(),
        }),
      }),
      journal,
    };
    const patchHost = new FilesystemPatchHost({
      vscode,
      journal,
      approvalBroker: broker,
      workspaceRoot: async () => root,
      ignorePolicy: fixture.agent.ignorePolicy,
    });
    const registry = createAgentToolRegistry({
      services,
      patchHost,
      now: () => 100,
      randomId: ids(
        "prepared-pre-boundary",
        "approval-pre-boundary",
        "journal-pre-boundary",
        "prepared-post-boundary",
        "approval-post-boundary",
        "journal-post-boundary",
        "prepared-mismatch",
        "approval-mismatch",
        "journal-mismatch",
      ),
    });
    const write = requiredWrite(registry.tools, "set_studio_property");
    const args = write.validate({
      instanceId: "place:123",
      instancePath: "game.Workspace.Part",
      propertyName: "Anchored",
      propertyValue: true,
    });

    executeStudioWrite.mockImplementationOnce(async () => {
      current = true; // An unrelated writer wins the race after bridge rejection.
      return { boundaryCrossed: false, outcome: "pre-boundary-rejected" };
    });
    const rejected = await write.prepare(args, context());
    const rejectedAuthorization = await approveTool(broker, rejected.proposal);

    const rejectedReceipt = await write.execute(rejected.id, rejectedAuthorization, context());

    expect(rejectedReceipt).toMatchObject({
      ok: false,
      code: "write-failed",
      verification: "unverified",
    });
    expect(journal.entries()).toEqual([
      expect.objectContaining({
        result: "failed",
        verification: "unverifiable",
      }),
    ]);

    current = false;
    executeStudioWrite.mockImplementationOnce(async () => {
      current = true;
      return { boundaryCrossed: true, outcome: "post-boundary-ambiguous" };
    });
    const ambiguous = await write.prepare(args, context());
    const ambiguousAuthorization = await approveTool(broker, ambiguous.proposal);

    const ambiguousReceipt = await write.execute(ambiguous.id, ambiguousAuthorization, context());

    expect(ambiguousReceipt).toMatchObject({
      ok: true,
      code: "applied",
      verification: "verified",
    });
    expect(journal.entries()).toEqual([
      expect.objectContaining({
        result: "failed",
        verification: "unverifiable",
      }),
      expect.objectContaining({
        result: "applied",
        verification: "verified",
      }),
    ]);

    current = false;
    executeStudioWrite.mockImplementationOnce(async () => ({
      boundaryCrossed: true,
      outcome: "completed",
    }));
    const mismatch = await write.prepare(args, context());
    const mismatchAuthorization = await approveTool(broker, mismatch.proposal);

    const mismatchReceipt = await write.execute(mismatch.id, mismatchAuthorization, context());

    expect(mismatchReceipt).toMatchObject({
      ok: false,
      code: "verification-mismatch",
      verification: "unverified",
    });
    expect(journal.entries()).toEqual([
      expect.objectContaining({
        result: "failed",
        verification: "unverifiable",
      }),
      expect.objectContaining({
        result: "applied",
        verification: "verified",
      }),
      expect.objectContaining({
        result: "failed",
        verification: "mismatch",
      }),
    ]);
    expect(JSON.stringify([rejectedReceipt, ambiguousReceipt, ...journal.entries()])).not.toContain(
      "raw-studio-sentinel",
    );

    registry.dispose();
    broker.dispose();
    await fixture.dispose();
  });

  test("same-revision property races and Stop during final Studio preflight consume no authorization or write", async () => {
    const fixture = createFixtureServices();
    const root = await mkdtemp(join(tmpdir(), "rbxforge-agent-tools-"));
    const vscode = new FakeVsCode();
    const journal = new MutationJournal();
    const broker = new InMemoryApprovalBroker({
      now: () => 100,
      randomId: ids("authorization-race", "authorization-stop"),
    });
    let current = false;
    let blockRead = false;
    let enterRead: (() => void) | undefined;
    let releaseRead: (() => void) | undefined;
    const guardedProperties = vi.fn(async () => {
      if (blockRead) {
        enterRead?.();
        await new Promise<void>((resolve) => {
          releaseRead = resolve;
        });
      }
      return Object.freeze({
        instancePath: "game.Workspace.Part",
        className: "Part",
        properties: Object.freeze({ Anchored: current }),
      });
    });
    const executeStudioWrite = vi.fn(
      async (input: Parameters<NonNullable<ExtensionServices["agent"]["studioWrites"]>["execute"]>[0]) => {
        if (!broker.consumeAuthorization(input.authorization, input.approval)) {
          throw new Error("Expected exact broker authorization");
        }
        current = true;
        return { boundaryCrossed: true, outcome: "completed" } as const;
      },
    );
    const services: ExtensionServices = {
      ...fixture,
      graph: {
        ...fixture.graph,
        resolve: async () =>
          Object.freeze({
            node: Object.freeze({
              path: "game.Workspace.Part",
              name: "Part",
              className: "Part",
              ownership: "studio" as const,
              children: Object.freeze([]),
              unsafeUnknownChildren: false,
              unsafeParent: false,
            }),
            revision: 7,
          }),
        revision: () => 7,
        assertRevision: () => undefined,
      },
      studio: {
        ...fixture.studio,
        instances: async () => [studioInstance()],
        snapshot: () => ({ activeInstanceId: "place:123", stale: false }),
        guardedProperties,
        callWrite: vi.fn(),
      },
      agent: Object.freeze({
        contextRegistry: fixture.agent.contextRegistry,
        approvalBroker: broker,
        ignorePolicy: fixture.agent.ignorePolicy,
        studioWrites: Object.freeze({
          execute: executeStudioWrite,
          revokeRun: vi.fn(),
        }),
      }),
      journal,
    };
    const patchHost = new FilesystemPatchHost({
      vscode,
      journal,
      approvalBroker: broker,
      workspaceRoot: async () => root,
      ignorePolicy: fixture.agent.ignorePolicy,
    });
    const registry = createAgentToolRegistry({
      services,
      patchHost,
      now: () => 100,
      randomId: ids("prepared-race", "approval-race", "prepared-stop", "approval-stop"),
    });
    const write = requiredWrite(registry.tools, "set_studio_property");
    const args = write.validate({
      instanceId: "place:123",
      instancePath: "game.Workspace.Part",
      propertyName: "Anchored",
      propertyValue: true,
    });

    const raced = await write.prepare(args, context());
    const racedAuthorization = await approveTool(broker, raced.proposal);
    current = true;
    await expect(write.execute(raced.id, racedAuthorization, context())).rejects.toThrow("changed after approval");
    expect(executeStudioWrite).not.toHaveBeenCalled();
    expect(broker.consumeAuthorization(racedAuthorization, raced.proposal)).toBe(true);

    current = false;
    const controller = new AbortController();
    const stoppedContext = context(controller.signal);
    const stopped = await write.prepare(args, stoppedContext);
    const stoppedAuthorization = await approveTool(broker, stopped.proposal);
    const reachedRead = new Promise<void>((resolve) => {
      enterRead = resolve;
    });
    blockRead = true;
    const executing = write.execute(stopped.id, stoppedAuthorization, stoppedContext);
    await reachedRead;
    controller.abort(new Error("Stop"));
    releaseRead?.();

    await expect(executing).rejects.toThrow("Stop");
    expect(executeStudioWrite).not.toHaveBeenCalled();
    expect(broker.consumeAuthorization(stoppedAuthorization, stopped.proposal)).toBe(true);
    expect(journal.entries()).toEqual([]);

    registry.dispose();
    broker.dispose();
    await fixture.dispose();
  });
});

function requiredWrite(
  tools: readonly { readonly name: string; readonly access: "read" | "write" }[],
  name: string,
): RegisteredWriteTool {
  const tool = tools.find((candidate) => candidate.name === name);
  if (tool?.access !== "write") throw new Error(`Expected write tool: ${name}`);
  return tool as RegisteredWriteTool;
}

function requiredRead(
  tools: readonly { readonly name: string; readonly access: "read" | "write" }[],
  name: string,
): RegisteredReadTool {
  const tool = tools.find((candidate) => candidate.name === name);
  if (tool?.access !== "read") throw new Error(`Expected read tool: ${name}`);
  return tool as RegisteredReadTool;
}

function context(
  signal: AbortSignal = new AbortController().signal,
  selection: Partial<ToolContext["selection"]> = {},
): ToolContext {
  return Object.freeze({
    sessionId: "session-1",
    generation: 1,
    runId: "run-1",
    signal,
    context: Object.freeze({
      records: Object.freeze([]),
      receipts: Object.freeze([]),
      instructions: "untrusted",
      totalBytes: 0,
    }),
    selection: Object.freeze({
      chipIds: Object.freeze([]),
      workspaceRoot: "/workspace",
      sessionId: "session-1",
      generation: 1,
      ...selection,
    }),
    simulation: false,
  });
}

async function approveTool(broker: InMemoryApprovalBroker, proposal: Parameters<InMemoryApprovalBroker["request"]>[0]) {
  const pending = broker.request(proposal, new AbortController().signal);
  broker.resolve({
    sessionId: proposal.sessionId,
    generation: proposal.generation,
    runId: proposal.runId,
    approvalId: proposal.approvalId,
    decision: "approve",
  });
  const decision = await pending;
  if (!decision.approved) throw new Error("Expected approval");
  return decision.authorization;
}

function studioInstance() {
  return Object.freeze({
    instanceId: "place:123",
    role: "edit",
    placeId: 123,
    placeName: "Forge",
    dataModelName: "Forge",
    isRunning: false,
    pluginVersion: "2.22.5",
    pluginVariant: "stable",
    serverVersion: "2.22.5",
    versionMismatch: false,
    lastActivity: 100,
    connectedAt: 10,
  });
}

function ids(...values: string[]): () => string {
  let index = 0;
  return () => values[index++] ?? `id-${index}`;
}
