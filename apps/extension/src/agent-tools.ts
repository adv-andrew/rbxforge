import { randomUUID } from "node:crypto";

import type {
  ImmutableApprovalProposal,
  OpaqueWriteAuthorization,
  RegisteredAgentTool,
  RegisteredReadTool,
  RegisteredWriteTool,
  StrictToolSchema,
  ToolContext,
  ToolReceipt,
} from "@rbxforge/agent";
import { CONTEXT_LIMITS, isSecretLikeContent, isSensitiveKey } from "@rbxforge/agent";
import {
  assertSafeStudioPropertyMutation,
  decideMutation,
  formatDataModelPath,
  parseDataModelPath,
  stableValue,
  stableValueHash,
  verifyMutation,
  type MutationProposal,
  type Ownership,
} from "@rbxforge/core";
import {
  studioAgentBindingHash,
  type StudioAgentMutationClaimBinding,
  type StudioMutationRequest,
} from "@rbxforge/studio-mcp";
import type { TypedPropertyValue } from "@rbxforge/webview-ui/protocol";

import { FilesystemPatchHost, type FilesystemPatchSpec } from "./filesystem-patch-host.js";
import type { ExtensionServices } from "./service-container.js";

export interface AgentToolRegistry {
  readonly tools: readonly RegisteredAgentTool[];
  readonly patchHost: FilesystemPatchHost;
  dispose(): void;
}

export interface AgentToolRegistryOptions {
  readonly services: ExtensionServices;
  readonly patchHost: FilesystemPatchHost;
  readonly onContextChip?: (
    chip: Readonly<{
      id: string;
      label: string;
      kind: "screenshot";
    }>,
  ) => boolean;
  readonly now?: () => number;
  readonly randomId?: () => string;
}

interface StudioPrepared {
  readonly preparedId: string;
  readonly approval: ImmutableApprovalProposal;
  readonly studioProposal: MutationProposal;
  readonly request: StudioMutationRequest;
  readonly instanceId: string;
  readonly className: string;
  readonly ownership: Ownership;
  readonly graphRevision: number;
  readonly beforeHash: string;
}

export function createAgentToolRegistry(options: AgentToolRegistryOptions): AgentToolRegistry {
  const now = options.now ?? Date.now;
  const randomId = options.randomId ?? randomUUID;
  const studioPrepared = new Map<string, StudioPrepared>();
  const studioProposalLimit = 16;
  const services = options.services;

  const read = (
    name: string,
    parameters: StrictToolSchema,
    validate: RegisteredReadTool["validate"],
    invoke: RegisteredReadTool["invoke"],
  ): RegisteredReadTool => Object.freeze({ name, access: "read", parameters, validate, invoke });

  const selectedContext = read("selected_context", strict({}), emptyArgs, async (_args, context) =>
    safeReceipt(
      {
        records: context.context.records.length,
        totalBytes: context.context.totalBytes,
        included: context.context.receipts.filter((receipt) => receipt.outcome !== "omitted").length,
        omitted: context.context.receipts.filter((receipt) => receipt.outcome === "omitted").length,
      },
      context,
    ),
  );

  const studioChildren = read(
    "studio_children",
    strict({
      instanceId: { type: "string", minLength: 1, maxLength: 256 },
      path: { type: "string", minLength: 1, maxLength: 2_048 },
    }),
    (value) => exactStrings(value, ["instanceId", "path"]),
    async (args, context) => {
      const instanceId = stringArg(args, "instanceId");
      assertInstance(services, instanceId);
      const path = canonicalPath(stringArg(args, "path"));
      const nodes = await services.graph.children(path, context.signal);
      return safeReceipt(
        {
          path,
          children: nodes.slice(0, 100).map((node) => ({
            path: node.path,
            name: node.name,
            className: node.className,
            ownership: node.ownership,
          })),
          truncated: nodes.length > 100,
        },
        context,
      );
    },
  );

  const studioProperties = read(
    "studio_properties",
    strict({
      instanceId: { type: "string", minLength: 1, maxLength: 256 },
      path: { type: "string", minLength: 1, maxLength: 2_048 },
    }),
    (value) => exactStrings(value, ["instanceId", "path"]),
    async (args, context) => {
      const instanceId = stringArg(args, "instanceId");
      assertInstance(services, instanceId);
      const path = canonicalPath(stringArg(args, "path"));
      const properties = await services.studio.guardedProperties(path, { expectedInstanceId: instanceId });
      const names = Object.keys(properties.properties)
        .filter((name) => !isSensitiveKey(name))
        .sort();
      return safeReceipt(
        {
          path: properties.instancePath,
          className: properties.className,
          properties: names.slice(0, 200).map((name) =>
            Object.freeze({
              name,
              value: sanitizeReadValue(properties.properties[name]),
            }),
          ),
          truncated: names.length > 200,
        },
        context,
      );
    },
  );

  const rojoMapping = read(
    "rojo_source_mapping",
    strict({ path: { type: "string", minLength: 1, maxLength: 2_048 } }),
    (value) => exactStrings(value, ["path"]),
    async (args, context) => {
      const path = canonicalPath(stringArg(args, "path"));
      return safeReceipt({ mapped: services.source.pathFor(path) !== undefined }, context);
    },
  );

  const playtestStatus = read(
    "playtest_status",
    strict({ instanceId: { type: "string", minLength: 1, maxLength: 256 } }),
    (value) => exactStrings(value, ["instanceId"]),
    async (args, context) => {
      const controller = requiredPlaytest(services, stringArg(args, "instanceId"));
      await controller.refreshStatus(context.signal);
      const state = controller.state();
      return safeReceipt(
        {
          status: state.status,
          mode: state.mode ?? null,
          roles: state.roles.slice(0, 32),
          runtimeGeneration: state.runtimeGeneration,
        },
        context,
      );
    },
  );

  const runtimeLogs = read(
    "runtime_log_summary",
    strict({
      instanceId: { type: "string", minLength: 1, maxLength: 256 },
      filter: { type: ["string", "null"], maxLength: 1_024 },
    }),
    (value) => exactNullableString(value, ["instanceId"], ["filter"]),
    async (args, context) => {
      const controller = requiredPlaytest(services, stringArg(args, "instanceId"));
      const batch = await controller.pollLogs(undefined, context.signal);
      const filter = args.filter;
      const normalizedFilter = typeof filter === "string" ? filter.toLocaleLowerCase() : undefined;
      const matched = batch.entries.filter(
        (entry) => normalizedFilter === undefined || entry.message.toLocaleLowerCase().includes(normalizedFilter),
      );
      return safeReceipt(
        {
          rows: matched.slice(0, CONTEXT_LIMITS.logs).map((entry) =>
            Object.freeze({
              seq: entry.seq,
              ts: entry.ts,
              level: entry.level,
              message: sanitizeReadString(entry.message, 4_096),
              ...(entry.capturedBy === undefined ? {} : { capturedBy: sanitizeReadString(entry.capturedBy, 128) }),
            }),
          ),
          matched: matched.length,
          totalDropped: batch.totalDropped,
          truncated: matched.length > CONTEXT_LIMITS.logs,
        },
        context,
      );
    },
  );

  const screenshot = read(
    "viewport_screenshot_metadata",
    strict({ instanceId: { type: "string", minLength: 1, maxLength: 256 } }),
    (value) => exactStrings(value, ["instanceId"]),
    async (args, context) => {
      const instanceId = stringArg(args, "instanceId");
      const result = await requiredPlaytest(services, instanceId).captureScreenshot(context.signal);
      throwIfAborted(context.signal);
      const label = `Viewport ${new Date(result.capturedAt).toISOString()}`;
      const id = services.agent.contextRegistry.register({
        kind: "screenshot",
        label,
        workspaceRoot: context.selection.workspaceRoot,
        sessionId: context.sessionId,
        generation: context.generation,
        expiresAt: now() + 10 * 60_000,
        instanceId,
        ...(context.selection.graphRevision === undefined ? {} : { graphRevision: context.selection.graphRevision }),
        resolve: async (signal) => {
          throwIfAborted(signal);
          return Object.freeze({ content: result.data, mimeType: result.mimeType });
        },
      });
      const contextAdded = options.onContextChip?.(Object.freeze({ id, label, kind: "screenshot" })) ?? false;
      if (!contextAdded) services.agent.contextRegistry.revoke(id);
      return safeReceipt(
        {
          capturedAt: result.capturedAt,
          target: result.target,
          width: result.width ?? null,
          height: result.height ?? null,
          format: result.format,
          contextAdded,
        },
        context,
      );
    },
  );

  const workspacePatch: RegisteredWriteTool = Object.freeze({
    name: "workspace_patch",
    access: "write",
    parameters: workspacePatchSchema(),
    validate: validatePatch,
    prepare: (args: Readonly<Record<string, unknown>>, context: ToolContext) =>
      options.patchHost.prepare(args as unknown as FilesystemPatchSpec, context),
    execute: (preparedId: string, authorization: OpaqueWriteAuthorization, context: ToolContext) =>
      options.patchHost.execute(preparedId, authorization, context),
  });

  const studioWrite: RegisteredWriteTool = Object.freeze({
    name: "set_studio_property",
    access: "write",
    parameters: studioPropertySchema(),
    validate: validateStudioWrite,
    prepare: async (args: Readonly<Record<string, unknown>>, context: ToolContext) => {
      for (const [id, proposal] of studioPrepared) {
        if (proposal.approval.expiresAt <= now()) studioPrepared.delete(id);
      }
      if (studioPrepared.size >= studioProposalLimit) {
        throw new Error("Studio proposal capacity was reached");
      }
      const instanceId = stringArg(args, "instanceId");
      const instancePath = canonicalPath(stringArg(args, "instancePath"));
      const propertyName = stringArg(args, "propertyName");
      const propertyValue = args.propertyValue as TypedPropertyValue;
      assertInstance(services, instanceId);
      const resolved = await services.graph.resolve(instancePath, context.signal);
      if (resolved.node.unsafeParent) throw new Error("Studio target is stale");
      const properties = await services.studio.guardedProperties(instancePath, { expectedInstanceId: instanceId });
      assertSafeStudioPropertyMutation(properties.className, propertyName, propertyValue);
      const instances = await services.studio.instances();
      const instance = instances.find((candidate) => candidate.instanceId === instanceId);
      if (instance === undefined) throw new Error("Studio instance changed");
      const studioProposal = Object.freeze({
        kind: "studio" as const,
        operation: "property-write" as const,
        target: instancePath,
        ownership: resolved.node.ownership,
        instanceId,
        placeName: instance.placeName,
        graphRevision: resolved.revision,
        connectedInstanceCount: instances.length,
      });
      const mutationDecision = decideMutation(studioProposal);
      if (mutationDecision.disposition === "blocked") throw new Error("Studio property mutation is blocked");
      const request = Object.freeze({
        tool: "set_property",
        input: deepFreeze({
          instancePath,
          propertyName,
          propertyValue,
        }),
      });
      const beforeHash = stableValueHash(properties.properties[propertyName]);
      const preparedId = uniqueId(randomId, studioPrepared);
      const reserved = new Set([preparedId]);
      const approval: ImmutableApprovalProposal = Object.freeze({
        approvalId: uniqueId(randomId, studioPrepared, reserved),
        preparedId,
        sessionId: context.sessionId,
        generation: context.generation,
        runId: context.runId,
        kind: "studio",
        summary: `Set ${propertyName} on ${instancePath} in ${instance.placeName}`,
        bindingHash: studioAgentBindingHash({
          proposal: studioProposal,
          request,
          expectedClassName: properties.className,
          expectedPropertyValueHash: beforeHash,
        }),
        change: Object.freeze({
          before: describeStudioValue(properties.properties[propertyName]),
          after: describeStudioValue(propertyValue),
        }),
        expiresAt: now() + 60_000,
      });
      studioPrepared.set(
        preparedId,
        Object.freeze({
          preparedId,
          approval,
          studioProposal,
          request,
          instanceId,
          className: properties.className,
          ownership: resolved.node.ownership,
          graphRevision: resolved.revision,
          beforeHash,
        }),
      );
      return Object.freeze({ id: preparedId, proposal: approval });
    },
    execute: async (preparedId: string, authorization: OpaqueWriteAuthorization, context: ToolContext) => {
      const stored = studioPrepared.get(preparedId);
      if (stored === undefined) throw new Error("Studio proposal is unknown or already used");
      if (
        stored.approval.sessionId !== context.sessionId ||
        stored.approval.generation !== context.generation ||
        stored.approval.runId !== context.runId ||
        stored.approval.expiresAt <= now()
      ) {
        studioPrepared.delete(preparedId);
        throw new Error("Studio proposal is stale");
      }
      throwIfAborted(context.signal);
      assertInstance(services, stored.instanceId);
      services.graph.assertRevision(stored.graphRevision);
      const resolved = await services.graph.resolve(stored.studioProposal.target, context.signal);
      if (resolved.revision !== stored.graphRevision || resolved.node.ownership !== stored.ownership) {
        throw new Error("Studio ownership or graph changed");
      }
      const beforeWrite = await services.studio.guardedProperties(stored.studioProposal.target, {
        expectedInstanceId: stored.instanceId,
      });
      if (beforeWrite.className !== stored.className) throw new Error("Studio class changed");
      const input = stored.request.input;
      assertSafeStudioPropertyMutation(beforeWrite.className, stringArg(input, "propertyName"), input.propertyValue);
      if (stableValueHash(beforeWrite.properties[stringArg(input, "propertyName")]) !== stored.beforeHash) {
        studioPrepared.delete(preparedId);
        throw new Error("Studio property changed after approval was prepared");
      }
      assertInstance(services, stored.instanceId);
      services.graph.assertRevision(stored.graphRevision);
      const bridge = services.agent.studioWrites;
      if (bridge === undefined) throw new Error("Agent Studio authorization is unavailable");
      const claimBinding: StudioAgentMutationClaimBinding = Object.freeze({
        sessionId: context.sessionId,
        generation: context.generation,
        runId: context.runId,
        expiresAt: stored.approval.expiresAt,
        expectedClassName: stored.className,
        expectedPropertyValueHash: stored.beforeHash,
        proposal: stored.studioProposal,
        request: stored.request,
      });
      // Final cancellation gate: every async preflight and exact-value compare
      // has completed. The bridge consumes the broker authorization and mints
      // the one-use claim synchronously before handing off the write.
      throwIfAborted(context.signal);
      const boundaryOutcome = await bridge.execute({
        approval: stored.approval,
        authorization,
        binding: claimBinding,
        context: Object.freeze({
          ownership: stored.ownership,
          expectedInstanceId: stored.instanceId,
          expectedGraphRevision: stored.graphRevision,
        }),
        signal: context.signal,
      });
      let actual: unknown;
      try {
        const observed = await services.studio.guardedProperties(stored.studioProposal.target, {
          expectedInstanceId: stored.instanceId,
        });
        actual = observed.properties[stringArg(stored.request.input, "propertyName")];
      } catch {
        actual = undefined;
      }
      const expected = stored.request.input.propertyValue;
      const rereadVerification = verifyMutation(expected, actual);
      const applied = boundaryOutcome.boundaryCrossed && rereadVerification === "verified";
      const journalVerification = boundaryOutcome.boundaryCrossed ? rereadVerification : "unverifiable";
      services.journal.append({
        id: randomId(),
        timestamp: new Date(now()).toISOString(),
        instanceId: stored.instanceId,
        kind: "studio",
        operation: "property-write",
        target: `${stored.studioProposal.target}.${stringArg(stored.request.input, "propertyName")}`,
        before: Object.freeze({ valueHash: stored.beforeHash }),
        requested: Object.freeze({ valueHash: stableValueHash(expected) }),
        result: applied ? "applied" : "failed",
        verification: journalVerification,
        detail: "Agent Studio write boundary outcome and reread were evaluated",
      });
      studioPrepared.delete(preparedId);
      return Object.freeze({
        ok: applied,
        code: applied ? "applied" : boundaryOutcome.boundaryCrossed ? "verification-mismatch" : "write-failed",
        summary: applied ? "Studio property was applied and reread." : "Studio property result could not be verified.",
        output: Object.freeze({
          instanceId: stored.instanceId,
          path: stored.studioProposal.target,
          propertyName: stringArg(stored.request.input, "propertyName"),
        }),
        verification: applied ? "verified" : "unverified",
      });
    },
  });

  return Object.freeze({
    tools: Object.freeze([
      selectedContext,
      studioChildren,
      studioProperties,
      rojoMapping,
      playtestStatus,
      runtimeLogs,
      screenshot,
      workspacePatch,
      studioWrite,
    ]),
    patchHost: options.patchHost,
    dispose: () => {
      studioPrepared.clear();
      options.patchHost.dispose();
    },
  });
}

function sanitizeReadString(value: string, max: number): string {
  if (isSecretLikeContent(value) || /^\[sensitive .+ omitted\]$/iu.test(value)) {
    return "[sensitive value omitted]";
  }
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "").slice(0, max);
}

function sanitizeReadValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return sanitizeReadString(value, 1_024);
  if (typeof value === "number") return Number.isFinite(value) ? value : "[non-finite number]";
  if (typeof value === "boolean" || value === null) return value;
  if (depth >= 4) return "[nested value omitted]";
  if (Array.isArray(value)) {
    return Object.freeze(value.slice(0, 20).map((entry) => sanitizeReadValue(entry, depth + 1)));
  }
  if (plainRecord(value)) {
    return Object.freeze(
      Object.fromEntries(
        Object.entries(value)
          .filter(([key]) => !isSensitiveKey(key))
          .slice(0, 50)
          .map(([key, entry]) => [key, sanitizeReadValue(entry, depth + 1)]),
      ),
    );
  }
  return "[unsupported value]";
}

function safeReceipt(output: Readonly<Record<string, unknown>>, context: ToolContext): ToolReceipt {
  return Object.freeze({
    ok: true,
    code: "ok",
    summary: "Bounded host read completed.",
    output: deepFreeze(output),
    verification: context.simulation ? "fixture-verified" : "verified",
  });
}

function strict(properties: Readonly<Record<string, unknown>>): StrictToolSchema {
  return Object.freeze({
    type: "object" as const,
    properties: deepFreeze(properties),
    required: Object.freeze(Object.keys(properties)),
    additionalProperties: false as const,
  });
}

function workspacePatchSchema(): StrictToolSchema {
  const position = strict({
    line: { type: "integer", minimum: 0 },
    character: { type: "integer", minimum: 0 },
  });
  const range = strict({ start: position, end: position });
  const edit = strict({
    range,
    newText: { type: "string", maxLength: 262_144 },
  });
  const file = strict({
    path: { type: "string", minLength: 1, maxLength: 4_096 },
    expectedVersion: { type: "integer", minimum: 0 },
    expectedSha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
    edits: { type: "array", minItems: 1, maxItems: 64, items: edit },
  });
  return strict({ files: { type: "array", minItems: 1, maxItems: 8, items: file } });
}

function studioPropertySchema(): StrictToolSchema {
  const number = { type: "number" };
  const color3 = strict({ R: number, G: number, B: number });
  const vector3 = strict({ X: number, Y: number, Z: number });
  const udim = strict({ Scale: number, Offset: number });
  const udim2 = strict({ _type: { type: "string", enum: ["UDim2"] }, X: udim, Y: udim });
  return strict({
    instanceId: { type: "string", minLength: 1, maxLength: 256 },
    instancePath: { type: "string", minLength: 1, maxLength: 2_048 },
    propertyName: { type: "string", minLength: 1, maxLength: 256 },
    propertyValue: {
      anyOf: [{ type: "string", maxLength: 65_536 }, { type: "number" }, { type: "boolean" }, color3, vector3, udim2],
    },
  });
}

function validatePatch(value: unknown): Readonly<Record<string, unknown>> {
  const root = exactRecord(value, ["files"]);
  if (!Array.isArray(root.files) || root.files.length === 0 || root.files.length > 8) throw new Error("Invalid files");
  const files = root.files.map((entry) => {
    const file = exactRecord(entry, ["path", "expectedVersion", "expectedSha256", "edits"]);
    if (
      typeof file.path !== "string" ||
      !Number.isSafeInteger(file.expectedVersion) ||
      typeof file.expectedSha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(file.expectedSha256) ||
      !Array.isArray(file.edits) ||
      file.edits.length === 0 ||
      file.edits.length > 64
    )
      throw new Error("Invalid file patch");
    const edits = file.edits.map((entryValue) => {
      const edit = exactRecord(entryValue, ["range", "newText"]);
      if (typeof edit.newText !== "string") throw new Error("Invalid replacement");
      const range = exactRecord(edit.range, ["start", "end"]);
      return Object.freeze({
        range: Object.freeze({
          start: validatePosition(range.start),
          end: validatePosition(range.end),
        }),
        newText: edit.newText,
      });
    });
    return Object.freeze({
      path: file.path,
      expectedVersion: file.expectedVersion as number,
      expectedSha256: file.expectedSha256,
      edits: Object.freeze(edits),
    });
  });
  return Object.freeze({ files: Object.freeze(files) });
}

function validateStudioWrite(value: unknown): Readonly<Record<string, unknown>> {
  const args = exactRecord(value, ["instanceId", "instancePath", "propertyName", "propertyValue"]);
  for (const key of ["instanceId", "instancePath", "propertyName"] as const) {
    if (typeof args[key] !== "string" || args[key].length === 0) throw new Error("Invalid Studio write");
  }
  if (!validPropertyValue(args.propertyValue)) throw new Error("Invalid Studio property value");
  return deepFreeze({
    instanceId: args.instanceId,
    instancePath: args.instancePath,
    propertyName: args.propertyName,
    propertyValue: args.propertyValue,
  });
}

function validPropertyValue(value: unknown): value is TypedPropertyValue {
  if (typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (!plainRecord(value)) return false;
  if (value._type === "UDim2") {
    return exactNumeric(value.X, ["Scale", "Offset"]) && exactNumeric(value.Y, ["Scale", "Offset"]);
  }
  return exactNumeric(value, ["R", "G", "B"]) || exactNumeric(value, ["X", "Y", "Z"]);
}

function exactNumeric(value: unknown, keys: readonly string[]): boolean {
  if (!plainRecord(value) || Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) return false;
  return keys.every((key) => typeof value[key] === "number" && Number.isFinite(value[key]));
}

function exactStrings(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  const record = exactRecord(value, keys);
  if (keys.some((key) => typeof record[key] !== "string" || (record[key] as string).length === 0)) {
    throw new Error("Invalid tool arguments");
  }
  return Object.freeze({ ...record });
}

function exactNullableString(
  value: unknown,
  stringKeys: readonly string[],
  nullableKeys: readonly string[],
): Readonly<Record<string, unknown>> {
  const keys = [...stringKeys, ...nullableKeys];
  const record = exactRecord(value, keys);
  if (
    stringKeys.some((key) => typeof record[key] !== "string") ||
    nullableKeys.some((key) => record[key] !== null && typeof record[key] !== "string")
  ) {
    throw new Error("Invalid tool arguments");
  }
  return Object.freeze({ ...record });
}

function emptyArgs(value: unknown): Readonly<Record<string, unknown>> {
  return exactRecord(value, []);
}

function exactRecord(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  if (!plainRecord(value) || Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) {
    throw new Error("Tool arguments have unexpected fields");
  }
  return value;
}

function validatePosition(value: unknown): Readonly<{ line: number; character: number }> {
  const position = exactRecord(value, ["line", "character"]);
  if (
    !Number.isSafeInteger(position.line) ||
    (position.line as number) < 0 ||
    !Number.isSafeInteger(position.character) ||
    (position.character as number) < 0
  ) {
    throw new Error("Invalid edit position");
  }
  return Object.freeze({ line: position.line as number, character: position.character as number });
}

function stringArg(args: Readonly<Record<string, unknown>>, key: string): string {
  const value = args[key];
  if (typeof value !== "string") throw new Error("Invalid tool string");
  return value;
}

function canonicalPath(value: string): string {
  return formatDataModelPath(parseDataModelPath(value));
}

function assertInstance(services: ExtensionServices, instanceId: string): void {
  const snapshot = services.studio.snapshot();
  if (snapshot.stale || snapshot.activeInstanceId !== instanceId) throw new Error("Studio instance is stale");
}

function requiredPlaytest(services: ExtensionServices, instanceId: string) {
  assertInstance(services, instanceId);
  const controller = services.playtest.controller(instanceId);
  if (controller === undefined) throw new Error("Playtest capability is unavailable");
  return controller;
}

function uniqueId(
  randomId: () => string,
  map: ReadonlyMap<string, unknown>,
  reserved: ReadonlySet<string> = new Set(),
): string {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const id = randomId();
    if (id.length > 0 && !map.has(id) && !reserved.has(id)) return id;
  }
  throw new Error("Unable to allocate Agent capability");
}

function describeStudioValue(value: unknown): string {
  if (typeof value === "string") {
    const bytes = Buffer.byteLength(value);
    if (isSecretLikeContent(value)) return "[sensitive value omitted]";
    if (bytes > 120) return `[string, ${bytes} bytes]`;
    return JSON.stringify(value).slice(0, 160);
  }
  if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) {
    return String(value);
  }
  if (value === undefined) return "[unset]";
  if (value === null) return "null";
  const encoded = stableValue(value);
  if (isSecretLikeContent(encoded)) return "[sensitive value omitted]";
  if (Buffer.byteLength(encoded) > 140) {
    return `[${Array.isArray(value) ? "array" : "object"}, ${Buffer.byteLength(encoded)} bytes]`;
  }
  return encoded.slice(0, 160);
}

function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    value.forEach(deepFreeze);
  } else if (plainRecord(value)) {
    Object.values(value).forEach(deepFreeze);
  }
  if (value !== null && typeof value === "object") Object.freeze(value);
  return value;
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new Error("Operation aborted");
}
