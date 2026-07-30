import { decideMutation, formatDataModelPath, parseDataModelPath } from "@rbxforge/core";
import type {
  LogCursor,
  MutationDecision,
  MutationOperation,
  PlayMode,
  PlaytestStartResult,
  PlaytestStatusResult,
  PlaytestStopResult,
  RuntimeLogBatch,
  RuntimeLogEntry,
  ScreenshotResult,
} from "@rbxforge/core";
import { z } from "zod";

import type {
  McpClientPort,
  McpCallOptions,
  StudioCapability,
  StudioAgentMutationClaim,
  StudioInstance,
  StudioMcpServiceOptions,
  StudioMcpSnapshot,
  StudioMutationAuthorization,
  StudioMutationRequest,
  StudioMutationGate,
  StudioNode,
  StudioProperties,
  StudioPropertyReadOptions,
  StudioPlaytestCommandOptions,
  StudioPlaytestReadOptions,
  StudioRuntimeLogOptions,
  StudioScreenshotOptions,
  StudioTree,
  StudioTreeNode,
  StudioWriteOwnershipContext,
} from "./types.js";

const capabilityCandidates: Readonly<Record<StudioCapability, readonly string[]>> = Object.freeze({
  connectedInstances: ["get_connected_instances"],
  tree: ["get_file_tree"],
  children: ["get_instance_children"],
  properties: ["get_instance_properties"],
  selection: ["get_selection"],
  setProperty: ["set_property"],
  setProperties: ["set_properties"],
  createObject: ["create_object"],
  deleteObject: ["delete_object"],
  soloPlaytest: ["solo_playtest"],
  runtimeLogs: ["get_runtime_logs"],
  screenshot: ["capture_screenshot"],
});

const aliases: Readonly<Record<string, StudioCapability>> = Object.freeze({
  connected_instances: "connectedInstances",
  get_connected_instances: "connectedInstances",
  tree: "tree",
  get_file_tree: "tree",
  children: "children",
  get_instance_children: "children",
  properties: "properties",
  get_instance_properties: "properties",
  selection: "selection",
  get_selection: "selection",
  set_property: "setProperty",
  set_properties: "setProperties",
  create_object: "createObject",
  delete_object: "deleteObject",
  solo_playtest: "soloPlaytest",
  get_runtime_logs: "runtimeLogs",
  capture_screenshot: "screenshot",
});

const readCapabilities: ReadonlySet<StudioCapability> = new Set([
  "connectedInstances",
  "tree",
  "children",
  "properties",
  "selection",
]);

const writeCapabilities: ReadonlySet<StudioCapability> = new Set([
  "setProperty",
  "setProperties",
  "createObject",
  "deleteObject",
]);

type WriteCapability = "setProperty" | "setProperties" | "createObject" | "deleteObject";
type WriteTargetField = "instancePath" | "parent";

const studioValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.unknown()),
  z.record(z.unknown()),
]);

const writeSpecifications = {
  setProperty: {
    operation: "property-write",
    targetField: "instancePath",
    inputSchema: z
      .object({
        instancePath: z.string(),
        propertyName: z.string(),
        propertyValue: studioValueSchema,
      })
      .strict(),
  },
  setProperties: {
    operation: "bulk",
    targetField: "instancePath",
    inputSchema: z
      .object({
        instancePath: z.string(),
        properties: z.record(studioValueSchema),
      })
      .strict(),
  },
  createObject: {
    operation: "create",
    targetField: "parent",
    inputSchema: z
      .object({
        className: z.string(),
        parent: z.string(),
        name: z.string().optional(),
        properties: z.record(studioValueSchema).optional(),
      })
      .strict(),
  },
  deleteObject: {
    operation: "delete",
    targetField: "instancePath",
    inputSchema: z.object({ instancePath: z.string() }).strict(),
  },
} as const satisfies Readonly<
  Record<
    WriteCapability,
    {
      readonly operation: MutationOperation;
      readonly targetField: WriteTargetField;
      readonly inputSchema: z.ZodType;
    }
  >
>;

const instanceSchema = z.object({
  instanceId: z.string(),
  role: z.string(),
  placeId: z.number(),
  placeName: z.string(),
  dataModelName: z.string(),
  isRunning: z.boolean(),
  pluginVersion: z.string(),
  pluginVariant: z.string(),
  serverVersion: z.string(),
  versionMismatch: z.boolean(),
  lastActivity: z.number(),
  connectedAt: z.number(),
});

const instancesSchema = z.object({
  instances: z.array(instanceSchema),
  count: z.number(),
});

const nodeSchema = z.object({
  name: z.string(),
  className: z.string(),
  path: z.string(),
  hasChildren: z.boolean(),
  hasSource: z.boolean(),
  enabled: z.boolean().optional(),
});

const childrenSchema = z.object({
  instancePath: z.string(),
  children: z.array(nodeSchema),
  count: z.number(),
});

const propertiesSchema = z.object({
  instancePath: z.string(),
  className: z.string(),
  properties: z.record(z.unknown()),
});

const selectionSchema = z.object({
  success: z.boolean(),
  selection: z.array(z.string()),
  count: z.number(),
  message: z.string().optional(),
});

const writeSuccessSchema = z.object({ success: z.literal(true) }).passthrough();

const roleSchema = z.string().min(1).max(128);
const playtestStatusSchema = z
  .object({
    success: z.literal(true),
    action: z.literal("status"),
    running: z.boolean(),
    roles: z.array(roleSchema).max(64),
  })
  .passthrough();
const playtestStartSchema = z
  .object({
    success: z.boolean(),
    action: z.literal("start"),
    message: z.string().min(1).max(8_192),
    roles: z.array(roleSchema).max(64).optional(),
  })
  .passthrough();
const playtestStopSchema = z
  .object({
    success: z.boolean(),
    action: z.literal("stop"),
    message: z.string().min(1).max(8_192),
  })
  .passthrough();
const runtimeLogEntrySchema = z
  .object({
    seq: z.number().int().nonnegative(),
    ts: z.number().finite().nonnegative(),
    level: z.enum(["OUT", "WARN", "ERR", "INFO"]),
    message: z.string().max(65_536),
    data: z.record(z.unknown()).optional(),
    capturedBy: roleSchema.optional(),
    peer: roleSchema.optional(),
  })
  .passthrough();
const runtimeLogsSchema = z
  .object({
    entries: z.array(runtimeLogEntrySchema).max(2_000),
    totalDropped: z.number().int().safe().nonnegative().default(0),
    nextSince: z.number().int().safe().nonnegative().optional(),
    capturedBy: roleSchema.optional(),
    perCaptureNextSince: z.record(z.number().int().safe().nonnegative()).optional(),
    perCaptureErrors: z.record(z.string().max(1_024)).optional(),
  })
  .passthrough();

const authorizationSchema = z.discriminatedUnion("approved", [
  z
    .object({
      approved: z.literal(true),
      authorizationId: z.string().regex(/^[A-Za-z0-9_-]{16,256}$/),
    })
    .strict(),
  z.object({ approved: z.literal(false), reason: z.string() }).strict(),
]);

interface ParsedTreeNode {
  readonly name: string;
  readonly className: string;
  readonly children: readonly ParsedTreeNode[];
  readonly path?: string | undefined;
  readonly hasSource?: boolean | undefined;
  readonly scriptType?: string | undefined;
  readonly enabled?: boolean | undefined;
}

const treeNodeSchema: z.ZodType<ParsedTreeNode> = z.lazy(() =>
  z.object({
    name: z.string(),
    className: z.string(),
    path: z.string().optional(),
    children: z.array(treeNodeSchema),
    hasSource: z.boolean().optional(),
    scriptType: z.string().optional(),
    enabled: z.boolean().optional(),
  }),
);

const treeSchema = z.object({
  tree: treeNodeSchema,
  timestamp: z.number(),
});

export class CapabilityUnavailableError extends Error {
  constructor(readonly capability: string) {
    super(`Studio MCP capability unavailable: ${capability}`);
    this.name = "CapabilityUnavailableError";
  }
}

export class McpResponseError extends Error {
  constructor(
    message: string,
    readonly causeValue?: unknown,
    readonly code: string | undefined = undefined,
  ) {
    super(message);
    this.name = "McpResponseError";
  }
}

export class ToolClassificationError extends Error {
  constructor(tool: string, expected: "read" | "write") {
    super(`Studio MCP tool ${tool} is not an allowed ${expected} capability`);
    this.name = "ToolClassificationError";
  }
}

export class MutationBlockedError extends Error {
  constructor(readonly decision: MutationDecision) {
    super(`Mutation blocked: ${decision.reason ?? "the mutation policy rejected this proposal"}`);
    this.name = "MutationBlockedError";
  }
}

export class MutationAuthorizationError extends Error {
  constructor(readonly authorization: Exclude<StudioMutationAuthorization, { readonly approved: true }>) {
    super(`Studio mutation not approved: ${authorization.reason}`);
    this.name = "MutationAuthorizationError";
  }
}

export class MutationAuthorizationBoundaryError extends Error {
  constructor(readonly causeValue: unknown) {
    super("Studio mutation authorization result is invalid");
    this.name = "MutationAuthorizationBoundaryError";
  }
}

interface CapturedMcpInvocation {
  readonly tool: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly instanceId: string | undefined;
  readonly placeName: string | undefined;
  readonly connectedInstanceCount: number;
}

export class StudioMcpService {
  readonly #client: McpClientPort;
  readonly #mutationGate: StudioMutationGate;
  readonly #timeoutMs: number;
  readonly #now: () => number;
  readonly #selectionMode: NonNullable<StudioMcpServiceOptions["selectionMode"]>;
  #available = new Set<string>();
  #selected: Partial<Record<StudioCapability, string>> = {};
  #discovered = false;
  #activeInstanceId: string | undefined;
  #connectedInstanceCount = 0;
  #instances: readonly StudioInstance[] = Object.freeze([]);
  #instancesById = new Map<string, StudioInstance>();
  #catalogEstablished = false;
  #catalogRequestSequence = 0;
  #catalogCommitSequence = 0;
  #stale = false;

  constructor(client: McpClientPort, mutationGate: StudioMutationGate, options: StudioMcpServiceOptions = {}) {
    this.#client = client;
    this.#mutationGate = mutationGate;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    this.#now = options.now ?? Date.now;
    this.#selectionMode = options.selectionMode ?? "explicit";
  }

  async discover(): Promise<ReadonlySet<string>> {
    const result = await this.withTimeout(this.#client.listTools());
    this.#available = new Set(result.tools.map((tool) => tool.name));
    this.#selected = Object.fromEntries(
      (Object.keys(capabilityCandidates) as StudioCapability[]).flatMap((capability) => {
        const selected = capabilityCandidates[capability].find((candidate) => this.#available.has(candidate));
        return selected === undefined ? [] : [[capability, selected]];
      }),
    ) as Partial<Record<StudioCapability, string>>;
    this.#discovered = true;
    return new Set(this.#available);
  }

  snapshot(): StudioMcpSnapshot {
    const capabilities = Object.freeze(
      Object.fromEntries(
        (Object.keys(capabilityCandidates) as StudioCapability[]).map((capability) => [
          capability,
          this.#selected[capability],
        ]),
      ),
    ) as Readonly<Record<StudioCapability, string | undefined>>;
    return Object.freeze({
      activeInstanceId: this.#activeInstanceId,
      stale: this.#stale,
      capabilities,
    });
  }

  async listConnectedInstances(): Promise<readonly StudioInstance[]> {
    const requestSequence = ++this.#catalogRequestSequence;
    const body = await this.#invokeCapability("connectedInstances", {}, false);
    const parsed = this.parse(instancesSchema, body, "Connected instances response is invalid");
    const instances = Object.freeze(parsed.instances.map((instance) => Object.freeze({ ...instance })));
    if (requestSequence <= this.#catalogCommitSequence) return this.#instances;

    this.#catalogCommitSequence = requestSequence;
    this.#catalogEstablished = true;
    this.#instances = instances;
    this.#instancesById = new Map(instances.map((instance) => [instance.instanceId, instance]));
    this.#connectedInstanceCount = instances.length;
    const activeExists =
      this.#activeInstanceId !== undefined &&
      instances.some((instance) => instance.instanceId === this.#activeInstanceId);
    if (this.#activeInstanceId !== undefined && !activeExists) {
      this.#activeInstanceId = undefined;
      this.#stale = true;
    } else if (
      this.#selectionMode === "legacy-auto" &&
      this.#activeInstanceId === undefined &&
      instances.length === 1
    ) {
      this.#activeInstanceId = instances[0]?.instanceId;
      this.#stale = false;
    } else if (this.#activeInstanceId !== undefined) {
      this.#stale = false;
    }
    return this.#instances;
  }

  selectInstance(instanceId: string): StudioInstance {
    if (!this.#catalogEstablished) {
      throw new McpResponseError("Studio instance cannot be selected before a successful Studio catalog");
    }
    const instance = this.#instancesById.get(instanceId);
    if (instance === undefined) {
      throw new McpResponseError(`Studio instance ${instanceId} is not present in the latest Studio catalog`);
    }
    this.#activeInstanceId = instanceId;
    this.#stale = false;
    return instance;
  }

  clearSelectedInstance(): void {
    this.#activeInstanceId = undefined;
    this.#stale = false;
  }

  async children(path: string): Promise<readonly StudioNode[]> {
    const instancePath = canonicalPath(path);
    const body = await this.#invokeCapability("children", { instancePath });
    const parsed = this.parse(childrenSchema, body, "Children response is invalid");
    return Object.freeze(parsed.children.map(freezeNode));
  }

  async properties(path: string, options: StudioPropertyReadOptions = {}): Promise<StudioProperties> {
    this.#assertExpectedInstance(options.expectedInstanceId);
    const instancePath = canonicalPath(path);
    const body = await this.#invokeCapability(
      "properties",
      { instancePath, excludeSource: true },
      true,
      options.expectedInstanceId,
    );
    const parsed = this.parse(propertiesSchema, body, "Properties response is invalid");
    return Object.freeze({
      instancePath: canonicalPath(parsed.instancePath),
      className: parsed.className,
      properties: Object.freeze({ ...parsed.properties }),
    });
  }

  async selection(): Promise<readonly string[]> {
    const body = await this.#invokeCapability("selection", {});
    const parsed = this.parse(selectionSchema, body, "Selection response is invalid");
    if (!parsed.success) {
      throw new McpResponseError(parsed.message ?? "Studio selection request failed");
    }
    return Object.freeze(parsed.selection.map(canonicalPath));
  }

  async playtestStatus(options: StudioPlaytestReadOptions): Promise<PlaytestStatusResult> {
    const timeoutMs = boundedMilliseconds(options.timeoutMs ?? 15_000, "Playtest status timeout", 120_000);
    const captured = await this.#captureInvocation(
      "soloPlaytest",
      { action: "status" },
      true,
      options.expectedInstanceId,
    );
    const body = await this.#invokeCaptured(captured, { signal: options.signal, timeoutMs });
    return freezeStatus(this.parse(playtestStatusSchema, body, "Playtest status response is invalid"));
  }

  async startPlaytest(
    mode: PlayMode,
    context: StudioWriteOwnershipContext,
    options: StudioPlaytestCommandOptions,
  ): Promise<PlaytestStartResult> {
    const timeoutSeconds = boundedTimeoutSeconds(options.timeoutSeconds ?? 60, "Playtest start timeout", 120);
    const input = freezeRecordDeep({ action: "start", mode, timeout: timeoutSeconds });
    const captured = await this.#captureInvocation("soloPlaytest", input, true, context.expectedInstanceId);
    const body = await this.#authorizeAndInvokeCommand(
      captured,
      input,
      context,
      `solo_playtest:start:${mode}`,
      {
        signal: options.signal,
        timeoutMs: Math.min(130_000, timeoutSeconds * 1_000 + 5_000),
      },
      options.onIssued,
    );
    const result = this.parse(playtestStartSchema, body, "Playtest start response is invalid");
    if (!result.success) throw new McpResponseError("Playtest start failed", result);
    return Object.freeze({
      success: true,
      action: "start",
      message: result.message,
      ...(result.roles === undefined ? {} : { roles: Object.freeze([...result.roles]) }),
    });
  }

  async stopPlaytest(
    context: StudioWriteOwnershipContext,
    options: StudioPlaytestCommandOptions,
  ): Promise<PlaytestStopResult> {
    const timeoutSeconds = boundedTimeoutSeconds(options.timeoutSeconds ?? 15, "Playtest stop timeout", 60);
    const input = freezeRecordDeep({ action: "stop", timeout: timeoutSeconds });
    const captured = await this.#captureInvocation("soloPlaytest", input, true, context.expectedInstanceId);
    const body = await this.#authorizeAndInvokeCommand(captured, input, context, "solo_playtest:stop", {
      signal: options.signal,
      timeoutMs: Math.min(70_000, timeoutSeconds * 1_000 + 5_000),
    });
    const result = this.parse(playtestStopSchema, body, "Playtest stop response is invalid");
    if (!result.success) throw new McpResponseError("Playtest stop failed", result);
    return Object.freeze({ success: true, action: "stop", message: result.message });
  }

  async runtimeLogs(cursor: LogCursor | undefined, options: StudioRuntimeLogOptions): Promise<RuntimeLogBatch> {
    validateCursor(cursor);
    const timeoutMs = boundedMilliseconds(options.timeoutMs ?? 15_000, "Runtime log timeout", 60_000);
    const tail = options.tail === undefined ? 2_000 : boundedInteger(options.tail, "Runtime log tail", 1, 2_000);
    const filter = options.filter;
    if (filter !== undefined && filter.length > 1_024) throw new McpResponseError("Runtime log filter is too long");
    if (typeof cursor !== "object" || cursor === null) {
      const input = {
        target: "all",
        ...(cursor === undefined ? {} : { since: cursor }),
        tail,
        ...(filter === undefined ? {} : { filter }),
      };
      const captured = await this.#captureInvocation("runtimeLogs", input, true, options.expectedInstanceId);
      const body = await this.#invokeCaptured(
        captured,
        { signal: options.signal, timeoutMs },
        undefined,
        MAX_LOG_ENVELOPE_BYTES,
      );
      return normalizeLogBatches([this.#parseLogBatch(body)], tail);
    }

    const status = await this.playtestStatus({
      expectedInstanceId: options.expectedInstanceId,
      signal: options.signal,
      timeoutMs: Math.min(timeoutMs, 15_000),
    });
    const roles = [...new Set(status.roles)];
    if (roles.length === 0) {
      const captured = await this.#captureInvocation(
        "runtimeLogs",
        { target: "all", tail, ...(filter === undefined ? {} : { filter }) },
        true,
        options.expectedInstanceId,
      );
      return normalizeLogBatches(
        [
          this.#parseLogBatch(
            await this.#invokeCaptured(
              captured,
              { signal: options.signal, timeoutMs },
              undefined,
              MAX_LOG_ENVELOPE_BYTES,
            ),
          ),
        ],
        tail,
      );
    }
    let aggregate = emptyRuntimeLogBatch();
    for (const role of roles) {
      let batch: RuntimeLogBatch;
      try {
        const since = cursor[role];
        const captured = await this.#captureInvocation(
          "runtimeLogs",
          {
            target: role,
            ...(since === undefined ? {} : { since }),
            tail,
            ...(filter === undefined ? {} : { filter }),
          },
          true,
          options.expectedInstanceId,
        );
        batch = this.#parseLogBatch(
          await this.#invokeCaptured(
            captured,
            { signal: options.signal, timeoutMs },
            undefined,
            MAX_LOG_ENVELOPE_BYTES,
          ),
          role,
          tail,
        );
      } catch (error: unknown) {
        if (options.signal.aborted) throw error;
        batch = Object.freeze({
          entries: Object.freeze([]),
          totalDropped: 0,
          perCaptureNextSince: Object.freeze({}),
          perCaptureErrors: Object.freeze({ [role]: "Runtime log capture failed" }),
          capturedBy: role,
        });
      }
      aggregate = normalizeLogBatches([aggregate, batch], tail);
    }
    return aggregate;
  }

  async captureScreenshot(options: StudioScreenshotOptions): Promise<ScreenshotResult> {
    const format = options.format ?? "jpeg";
    const quality =
      options.quality === undefined ? undefined : boundedInteger(options.quality, "Screenshot quality", 1, 100);
    const timeoutMs = boundedMilliseconds(options.timeoutMs ?? 45_000, "Screenshot timeout", 90_000);
    let target: ScreenshotResult["target"] = "auto";
    try {
      const status = await this.playtestStatus({
        expectedInstanceId: options.expectedInstanceId,
        signal: options.signal,
        timeoutMs: Math.min(timeoutMs, 15_000),
      });
      target = status.roles.includes("client-1") ? "client-1" : status.roles.includes("edit") ? "edit" : "auto";
    } catch (error: unknown) {
      if (options.signal.aborted) throw error;
      target = "auto";
    }
    const captured = await this.#captureInvocation(
      "screenshot",
      {
        format,
        ...(quality === undefined || format === "png" ? {} : { quality }),
      },
      true,
      options.expectedInstanceId,
    );
    const raw = await this.#invokeCapturedRaw(captured, { signal: options.signal, timeoutMs });
    return parseScreenshotContent(raw, format, target, this.#now());
  }

  async callRead(tool: string, input: object): Promise<unknown> {
    const capability = this.resolveCapability(tool, "read");
    const body = await this.#invokeCapability(capability, normalizePaths(input), capability !== "connectedInstances");
    return this.validateRead(capability, body);
  }

  async callWrite(tool: string, input: object, context: StudioWriteOwnershipContext): Promise<unknown> {
    return this.#callWrite(tool, input, context);
  }

  async callWriteWithClaim(
    tool: string,
    input: object,
    context: StudioWriteOwnershipContext,
    claim: StudioAgentMutationClaim,
  ): Promise<unknown> {
    return this.#callWrite(tool, input, context, claim);
  }

  async #callWrite(
    tool: string,
    input: object,
    context: StudioWriteOwnershipContext,
    claim?: StudioAgentMutationClaim,
  ): Promise<unknown> {
    const capability = this.resolveWriteCapability(tool);
    const specification = writeSpecifications[capability];
    const validatedInput = normalizePaths(this.parseWriteInput(specification.inputSchema, input));
    const immutableInput = freezeRecordDeep(validatedInput);
    if (!Number.isSafeInteger(context.expectedGraphRevision) || context.expectedGraphRevision < 0) {
      throw new McpResponseError("Expected graph revision is invalid");
    }
    this.#assertExpectedInstance(context.expectedInstanceId);
    const captured = await this.#captureInvocation(capability, immutableInput, true, context.expectedInstanceId);
    if (captured.instanceId === undefined || captured.placeName === undefined) {
      throw new McpResponseError("Active Studio place must be selected");
    }
    const target = immutableInput[specification.targetField];
    if (typeof target !== "string") {
      throw new McpResponseError(`Write input is missing ${specification.targetField}`);
    }
    const proposal = Object.freeze({
      kind: "studio" as const,
      operation: specification.operation,
      target: canonicalPath(target),
      ownership: context.ownership,
      instanceId: captured.instanceId,
      placeName: captured.placeName,
      graphRevision: context.expectedGraphRevision,
      connectedInstanceCount: captured.connectedInstanceCount,
    });
    const decision = decideMutation(proposal);
    if (decision.disposition === "blocked") {
      throw new MutationBlockedError(decision);
    }
    const request = Object.freeze({ tool: captured.tool, input: immutableInput } satisfies StudioMutationRequest);
    const authorization = this.parseAuthorization(
      await (claim === undefined
        ? this.#mutationGate.authorize(proposal, decision, request)
        : this.#mutationGate.authorizeClaim === undefined
          ? Promise.resolve({ approved: false as const, reason: "Agent Studio authorization is unavailable." })
          : this.#mutationGate.authorizeClaim(claim, proposal, decision, request)),
    );
    if (!authorization.approved) {
      throw new MutationAuthorizationError(authorization);
    }
    this.#assertExpectedInstance(captured.instanceId);
    this.#mutationGate.consume(authorization.authorizationId, proposal, request);
    const body = await this.#invokeCaptured(captured);
    return this.parse(writeSuccessSchema, body, "Write response is invalid");
  }

  async close(): Promise<void> {
    await this.#client.close();
  }

  async #authorizeAndInvokeCommand(
    captured: CapturedMcpInvocation,
    input: Readonly<Record<string, unknown>>,
    context: StudioWriteOwnershipContext,
    target: string,
    options: McpCallOptions,
    onIssued?: () => void,
  ): Promise<unknown> {
    if (!Number.isSafeInteger(context.expectedGraphRevision) || context.expectedGraphRevision < 0) {
      throw new McpResponseError("Expected graph revision is invalid");
    }
    if (captured.instanceId === undefined || captured.placeName === undefined) {
      throw new McpResponseError("Active Studio place must be selected");
    }
    const proposal = Object.freeze({
      kind: "command" as const,
      operation: "external-command" as const,
      target,
      ownership: context.ownership,
      instanceId: captured.instanceId,
      placeName: captured.placeName,
      graphRevision: context.expectedGraphRevision,
      connectedInstanceCount: captured.connectedInstanceCount,
    });
    const decision = decideMutation(proposal);
    if (decision.disposition === "blocked") throw new MutationBlockedError(decision);
    const request = Object.freeze({
      tool: captured.tool,
      input,
    } satisfies StudioMutationRequest);
    const authorization = this.parseAuthorization(await this.#mutationGate.authorize(proposal, decision, request));
    if (!authorization.approved) throw new MutationAuthorizationError(authorization);
    this.#assertExpectedInstance(captured.instanceId);
    this.#mutationGate.consume(authorization.authorizationId, proposal, request);
    return this.#invokeCaptured(captured, options, onIssued);
  }

  #parseLogBatch(body: unknown, requestedRole?: string, maxRows = MAX_LOG_ROWS): RuntimeLogBatch {
    assertRuntimeLogPreflight(body, maxRows);
    const parsed = this.parse(runtimeLogsSchema, body, "Runtime logs response is invalid");
    const capturedBy = requestedRole ?? parsed.capturedBy;
    const entries = parsed.entries.map((entry) => freezeLogEntry(entry, capturedBy));
    return Object.freeze({
      entries: Object.freeze(entries),
      totalDropped: parsed.totalDropped ?? 0,
      ...(parsed.nextSince === undefined ? {} : { nextSince: parsed.nextSince }),
      perCaptureNextSince: Object.freeze({
        ...(parsed.perCaptureNextSince ?? {}),
        ...(capturedBy !== undefined && parsed.nextSince !== undefined ? { [capturedBy]: parsed.nextSince } : {}),
      }),
      perCaptureErrors: Object.freeze(
        Object.fromEntries(
          Object.keys(parsed.perCaptureErrors ?? {}).map((role) => [role, "Runtime log capture failed"]),
        ),
      ),
      ...(capturedBy === undefined ? {} : { capturedBy }),
    });
  }

  async #invokeCapability(
    capability: StudioCapability,
    input: object,
    route = true,
    expectedInstanceId?: string,
  ): Promise<unknown> {
    const captured = await this.#captureInvocation(capability, input, route, expectedInstanceId);
    return this.#invokeCaptured(captured);
  }

  async #captureInvocation(
    capability: StudioCapability,
    input: object,
    route = true,
    expectedInstanceId?: string,
  ): Promise<CapturedMcpInvocation> {
    if (!this.#discovered) {
      await this.discover();
    }
    const selected = this.#selected[capability];
    if (selected === undefined) {
      throw new CapabilityUnavailableError(capability);
    }
    this.#assertExpectedInstance(expectedInstanceId);
    if (route && this.#activeInstanceId === undefined) {
      throw new McpResponseError("Active Studio place must be selected");
    }
    const argumentsValue = freezeRecordDeep({
      ...input,
      ...(route ? { instance_id: this.#activeInstanceId } : {}),
    });
    return Object.freeze({
      tool: selected,
      arguments: argumentsValue,
      instanceId: route ? this.#activeInstanceId : undefined,
      placeName:
        route && this.#activeInstanceId !== undefined
          ? this.#instancesById.get(this.#activeInstanceId)?.placeName
          : undefined,
      connectedInstanceCount: this.#connectedInstanceCount,
    });
  }

  async #invokeCaptured(
    captured: CapturedMcpInvocation,
    options?: McpCallOptions,
    onIssued?: () => void,
    maxEnvelopeBytes?: number,
  ): Promise<unknown> {
    try {
      return await this.readEnvelope(await this.#invokeCapturedRaw(captured, options, onIssued), maxEnvelopeBytes);
    } catch (error: unknown) {
      this.#recordInvocationFailure(captured, error);
      throw error;
    }
  }

  async #invokeCapturedRaw(
    captured: CapturedMcpInvocation,
    options?: McpCallOptions,
    onIssued?: () => void,
  ): Promise<unknown> {
    try {
      const input = {
        name: captured.tool,
        arguments: cloneRecord(captured.arguments),
      };
      if (options?.signal?.aborted) throw createAbortError();
      let operation: Promise<unknown>;
      if (options === undefined) {
        onIssued?.();
        operation = this.#client.callTool(input);
      } else {
        operation = this.#callWithCancellation(input, options, onIssued);
      }
      return options?.timeoutMs === undefined ? await this.withTimeout(operation) : await operation;
    } catch (error: unknown) {
      this.#recordInvocationFailure(captured, error);
      throw error;
    }
  }

  async #callWithCancellation(
    input: { readonly name: string; readonly arguments: Record<string, unknown> },
    options: McpCallOptions,
    onIssued?: () => void,
  ): Promise<unknown> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let removeAbort = (): void => undefined;
    const cancellation = new Promise<never>((_, reject) => {
      const abort = (): void => {
        controller.abort();
        reject(createAbortError());
      };
      if (options.signal !== undefined) {
        options.signal.addEventListener("abort", abort, { once: true });
        removeAbort = () => options.signal?.removeEventListener("abort", abort);
        if (options.signal.aborted) abort();
      }
    });
    const timeout =
      options.timeoutMs === undefined
        ? new Promise<never>(() => undefined)
        : new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              controller.abort();
              reject(new McpResponseError(`MCP call timed out after ${options.timeoutMs}ms`));
            }, options.timeoutMs);
          });
    try {
      onIssued?.();
      return await Promise.race([
        this.#client.callTool(input, {
          signal: controller.signal,
          ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        }),
        cancellation,
        timeout,
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      removeAbort();
    }
  }

  #recordInvocationFailure(captured: CapturedMcpInvocation, error: unknown): void {
    if (
      isUnrecognizedInstance(error) &&
      captured.instanceId !== undefined &&
      this.#activeInstanceId === captured.instanceId
    ) {
      this.#activeInstanceId = undefined;
      this.#stale = true;
    }
  }

  #assertExpectedInstance(expectedInstanceId: string | undefined): void {
    if (expectedInstanceId !== undefined && this.#activeInstanceId !== expectedInstanceId) {
      throw new McpResponseError("Active Studio instance changed before the operation");
    }
  }

  resolveCapability(tool: string, expected: "read" | "write"): StudioCapability {
    const capability = aliases[tool];
    const allowed = expected === "read" ? readCapabilities : writeCapabilities;
    if (capability === undefined || !allowed.has(capability)) {
      throw new ToolClassificationError(tool, expected);
    }
    return capability;
  }

  resolveWriteCapability(tool: string): WriteCapability {
    const capability = this.resolveCapability(tool, "write");
    if (!isWriteCapability(capability)) {
      throw new ToolClassificationError(tool, "write");
    }
    return capability;
  }

  parseWriteInput(schema: z.ZodType, input: object): Record<string, unknown> {
    const result = schema.safeParse(input);
    if (!result.success || !isRecord(result.data)) {
      throw new McpResponseError("Write input is invalid", result.success ? result.data : result.error.flatten());
    }
    return copyRecord(result.data);
  }

  parseAuthorization(value: unknown): StudioMutationAuthorization {
    const result = authorizationSchema.safeParse(value);
    if (!result.success) {
      throw new MutationAuthorizationBoundaryError(result.error.flatten());
    }
    return result.data;
  }

  validateRead(capability: StudioCapability, body: unknown): unknown {
    if (capability === "children") {
      const parsed = this.parse(childrenSchema, body, "Children response is invalid");
      return Object.freeze(parsed.children.map(freezeNode));
    }
    if (capability === "properties") {
      const parsed = this.parse(propertiesSchema, body, "Properties response is invalid");
      return Object.freeze({
        instancePath: canonicalPath(parsed.instancePath),
        className: parsed.className,
        properties: Object.freeze({ ...parsed.properties }),
      });
    }
    if (capability === "selection") {
      const parsed = this.parse(selectionSchema, body, "Selection response is invalid");
      return Object.freeze(parsed.selection.map(canonicalPath));
    }
    if (capability === "connectedInstances") {
      return Object.freeze(
        this.parse(instancesSchema, body, "Connected instances response is invalid").instances.map((instance) =>
          Object.freeze({ ...instance }),
        ),
      );
    }
    if (capability === "tree") {
      const parsed = this.parse(treeSchema, body, "Tree response is invalid");
      return Object.freeze({ tree: freezeTreeNode(parsed.tree), timestamp: parsed.timestamp } satisfies StudioTree);
    }
    throw new ToolClassificationError(capability, "read");
  }

  parse<T>(schema: z.ZodType<T>, value: unknown, message: string): T {
    const result = schema.safeParse(value);
    if (!result.success) {
      throw new McpResponseError(message, result.error.flatten());
    }
    return result.data;
  }

  async readEnvelope(response: unknown, maxBytes = MAX_DEFAULT_ENVELOPE_BYTES): Promise<unknown> {
    if (!isRecord(response)) {
      throw new McpResponseError("MCP response is missing");
    }
    const structured = response.structuredContent;
    const body =
      structured === undefined
        ? parseTextContent(response.content, maxBytes)
        : boundedEnvelopeValue(structured, maxBytes);
    if (isRecord(body) && typeof body.error === "string") {
      throw new McpResponseError("MCP tool reported an error", body, body.error);
    }
    if (response.isError === true) {
      throw new McpResponseError("MCP tool returned an error", response);
    }
    return body;
  }

  async withTimeout<T>(operation: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new McpResponseError(`MCP call timed out after ${this.#timeoutMs}ms`)),
        this.#timeoutMs,
      );
    });
    try {
      return await Promise.race([operation, timeout]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }
}

function parseTextContent(content: unknown, maxBytes: number): unknown {
  if (!Array.isArray(content)) {
    throw new McpResponseError("MCP response has no content");
  }
  const block = content.find(
    (candidate) => isRecord(candidate) && candidate.type === "text" && typeof candidate.text === "string",
  );
  if (block === undefined || typeof block.text !== "string") {
    throw new McpResponseError("MCP response has no JSON text content");
  }
  if (Buffer.byteLength(block.text, "utf8") > maxBytes) {
    throw new McpResponseError("MCP response exceeds the allowed size");
  }
  try {
    return JSON.parse(block.text) as unknown;
  } catch (error: unknown) {
    throw new McpResponseError("MCP response contains invalid JSON", error);
  }
}

function canonicalPath(path: string): string {
  return formatDataModelPath(parseDataModelPath(path));
}

function normalizePaths(input: object): Record<string, unknown> {
  const output: Record<string, unknown> = { ...input };
  if (typeof output.instancePath === "string") {
    output.instancePath = canonicalPath(output.instancePath);
  }
  if (typeof output.path === "string" && output.path !== "") {
    output.path = canonicalPath(output.path);
  }
  if (typeof output.parent === "string") {
    output.parent = canonicalPath(output.parent);
  }
  return output;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnrecognizedInstance(error: unknown): boolean {
  return error instanceof McpResponseError && error.code === "unrecognized_instance_id";
}

function isWriteCapability(capability: StudioCapability): capability is WriteCapability {
  return (
    capability === "setProperty" ||
    capability === "setProperties" ||
    capability === "createObject" ||
    capability === "deleteObject"
  );
}

function copyRecord(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value));
}

function freezeRecordDeep(value: Record<string, unknown>): Readonly<Record<string, unknown>> {
  return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, freezeValue(entry)])));
}

function freezeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return Object.freeze(value.map(freezeValue));
  }
  if (isRecord(value)) {
    return freezeRecordDeep(value);
  }
  return value;
}

function cloneRecord(value: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, cloneValue(entry)]));
}

function cloneValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(cloneValue);
  }
  if (isRecord(value)) {
    return cloneRecord(value);
  }
  return value;
}

function freezeNode(node: z.infer<typeof nodeSchema>): StudioNode {
  return Object.freeze({
    name: node.name,
    className: node.className,
    path: canonicalPath(node.path),
    hasChildren: node.hasChildren,
    hasSource: node.hasSource,
    ...(node.enabled === undefined ? {} : { enabled: node.enabled }),
  });
}

function freezeTreeNode(node: ParsedTreeNode): StudioTreeNode {
  return Object.freeze({
    name: node.name,
    className: node.className,
    children: Object.freeze(node.children.map(freezeTreeNode)),
    ...(node.path === undefined ? {} : { path: canonicalPath(node.path) }),
    ...(node.hasSource === undefined ? {} : { hasSource: node.hasSource }),
    ...(node.scriptType === undefined ? {} : { scriptType: node.scriptType }),
    ...(node.enabled === undefined ? {} : { enabled: node.enabled }),
  });
}

const MAX_LOG_ROWS = 2_000;
const MAX_LOG_BYTES = 2 * 1_024 * 1_024;
const MAX_LOG_ENVELOPE_BYTES = 3 * 1_024 * 1_024;
const MAX_DEFAULT_ENVELOPE_BYTES = 16 * 1_024 * 1_024;
const MAX_LOG_MESSAGE_BYTES = 65_536;
const MAX_LOG_DATA_BYTES = 16_384;
const MAX_SCREENSHOT_BYTES = 6_000_000;
const MAX_SCREENSHOT_TRANSFER = 8_000_000;
const MAX_SCREENSHOT_METADATA = 4_096;
const sensitiveLogKey = /key|token|secret|authorization|credential/i;
const sensitiveLogText = /(?:api[_-]?key|token|secret|authorization|credential|bearer)\s*[:=]\s*\S+/i;

function boundedEnvelopeValue(value: unknown, maxBytes: number): unknown {
  assertBoundedValue(value, maxBytes, "MCP response exceeds the allowed size");
  return value;
}

function assertBoundedValue(value: unknown, maxBytes: number, message: string): void {
  let bytes = 0;
  let nodes = 0;
  const seen = new WeakSet<object>();
  const pending: Array<{ readonly value: unknown; readonly depth: number }> = [{ value, depth: 0 }];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    nodes += 1;
    bytes += 8;
    if (current.depth > 64 || nodes > 250_000 || bytes > maxBytes) {
      throw new McpResponseError(message);
    }
    const entry = current.value;
    if (typeof entry === "string") {
      bytes += Buffer.byteLength(entry, "utf8");
    } else if (Array.isArray(entry)) {
      if (seen.has(entry)) throw new McpResponseError(message);
      seen.add(entry);
      for (const child of entry) pending.push({ value: child, depth: current.depth + 1 });
    } else if (isRecord(entry)) {
      if (seen.has(entry)) throw new McpResponseError(message);
      seen.add(entry);
      for (const [key, child] of Object.entries(entry)) {
        bytes += Buffer.byteLength(key, "utf8");
        pending.push({ value: child, depth: current.depth + 1 });
      }
    }
  }
  if (bytes > maxBytes) throw new McpResponseError(message);
}

function assertRuntimeLogPreflight(value: unknown, maxRows: number): void {
  if (!isRecord(value) || !Array.isArray(value.entries) || value.entries.length > maxRows) {
    throw new McpResponseError("Runtime logs response is invalid");
  }
  for (const entry of value.entries) {
    if (!isRecord(entry)) continue;
    if (typeof entry.message === "string" && Buffer.byteLength(entry.message, "utf8") > MAX_LOG_MESSAGE_BYTES) {
      throw new McpResponseError("Runtime logs response is invalid");
    }
    if (entry.data !== undefined) {
      assertBoundedValue(entry.data, MAX_LOG_DATA_BYTES, "Runtime logs response is invalid");
    }
  }
  for (const field of ["perCaptureNextSince", "perCaptureErrors"] as const) {
    const record = value[field];
    if (record === undefined) continue;
    if (!isRecord(record) || Object.keys(record).length > 64) {
      throw new McpResponseError("Runtime logs response is invalid");
    }
  }
  if (isRecord(value.perCaptureErrors)) {
    for (const detail of Object.values(value.perCaptureErrors)) {
      if (typeof detail === "string" && Buffer.byteLength(detail, "utf8") > 1_024) {
        throw new McpResponseError("Runtime logs response is invalid");
      }
    }
  }
}

function safeRuntimeMessage(message: string): string {
  return sensitiveLogText.test(message) ? "[sensitive runtime log omitted]" : message;
}

function freezeSafeLogData(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !sensitiveLogKey.test(key))
        .map(([key, entry]) => [key, safeLogValue(entry)]),
    ),
  );
}

function safeLogValue(value: unknown): unknown {
  if (Array.isArray(value)) return Object.freeze(value.map(safeLogValue));
  if (isRecord(value)) return freezeSafeLogData(value);
  if (typeof value === "string" && sensitiveLogText.test(value)) return "[sensitive value omitted]";
  return value;
}

function emptyRuntimeLogBatch(): RuntimeLogBatch {
  return Object.freeze({
    entries: Object.freeze([]),
    totalDropped: 0,
    perCaptureNextSince: Object.freeze({}),
    perCaptureErrors: Object.freeze({}),
  });
}

function boundedTimeoutSeconds(value: number, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new McpResponseError(`${label} must be an integer from 1 to ${maximum} seconds`);
  }
  return value;
}

function boundedMilliseconds(value: number, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new McpResponseError(`${label} must be an integer from 1 to ${maximum}ms`);
  }
  return value;
}

function boundedInteger(value: number, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new McpResponseError(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function validateCursor(cursor: LogCursor | undefined): void {
  if (cursor === undefined) return;
  if (typeof cursor === "number") {
    boundedInteger(cursor, "Runtime log cursor", 0, Number.MAX_SAFE_INTEGER);
    return;
  }
  const entries = Object.entries(cursor);
  if (entries.length > 64) throw new McpResponseError("Runtime log cursor has too many roles");
  for (const [role, value] of entries) {
    if (role.length < 1 || role.length > 128) throw new McpResponseError("Runtime log cursor role is invalid");
    boundedInteger(value, "Runtime log cursor", 0, Number.MAX_SAFE_INTEGER);
  }
}

function freezeStatus(value: z.infer<typeof playtestStatusSchema>): PlaytestStatusResult {
  return Object.freeze({
    success: true,
    action: "status",
    running: value.running,
    roles: Object.freeze([...value.roles]),
  });
}

function freezeLogEntry(
  entry: z.infer<typeof runtimeLogEntrySchema>,
  requestedRole: string | undefined,
): RuntimeLogEntry {
  const data = entry.data === undefined ? undefined : cloneBoundedLogData(entry.data);
  const capturedBy = requestedRole ?? entry.capturedBy;
  return Object.freeze({
    seq: entry.seq,
    ts: entry.ts,
    level: entry.level,
    message: safeRuntimeMessage(entry.message),
    ...(data === undefined ? {} : { data }),
    ...(capturedBy === undefined ? {} : { capturedBy }),
  });
}

function cloneBoundedLogData(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> | undefined {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return undefined;
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_LOG_DATA_BYTES) return undefined;
  const parsed = JSON.parse(serialized) as unknown;
  return isRecord(parsed) ? freezeSafeLogData(parsed) : undefined;
}

function normalizeLogBatches(batches: readonly RuntimeLogBatch[], maxRows = MAX_LOG_ROWS): RuntimeLogBatch {
  const sorted = batches
    .flatMap((batch) => batch.entries)
    .sort((left, right) => (left.ts === right.ts ? left.seq - right.seq : left.ts - right.ts));
  const retained: RuntimeLogEntry[] = [];
  let bytes = 0;
  let locallyDropped = 0;
  for (const entry of sorted.slice().reverse()) {
    const entryBytes = Buffer.byteLength(JSON.stringify(entry), "utf8");
    if (retained.length >= maxRows || bytes + entryBytes > MAX_LOG_BYTES) {
      locallyDropped += 1;
      continue;
    }
    retained.push(entry);
    bytes += entryBytes;
  }
  const nextValues = batches.flatMap((batch) => (batch.nextSince === undefined ? [] : [batch.nextSince]));
  const capturedValues = batches.flatMap((batch) => (batch.capturedBy === undefined ? [] : [batch.capturedBy]));
  return Object.freeze({
    entries: Object.freeze(retained.reverse()),
    totalDropped: batches.reduce((sum, batch) => sum + batch.totalDropped, locallyDropped),
    ...(nextValues.length === 1 ? { nextSince: nextValues[0] } : {}),
    perCaptureNextSince: Object.freeze(
      Object.assign({}, ...batches.map((batch) => batch.perCaptureNextSince)) as Record<string, number>,
    ),
    perCaptureErrors: Object.freeze(
      Object.assign({}, ...batches.map((batch) => batch.perCaptureErrors)) as Record<string, string>,
    ),
    ...(capturedValues.length === 1 ? { capturedBy: capturedValues[0] } : {}),
  });
}

function parseScreenshotContent(
  response: unknown,
  requestedFormat: "jpeg" | "png",
  target: ScreenshotResult["target"],
  capturedAt: number,
): ScreenshotResult {
  if (!isRecord(response) || response.isError === true || !Array.isArray(response.content)) {
    throw new McpResponseError("Screenshot response is invalid", response);
  }
  if (response.content.length !== 2) {
    throw new McpResponseError("Screenshot response must contain exactly one text and one image block", response);
  }
  const textBlocks = response.content.filter(
    (block) => isRecord(block) && block.type === "text" && typeof block.text === "string",
  );
  const imageBlocks = response.content.filter(
    (block) =>
      isRecord(block) && block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string",
  );
  if (textBlocks.length !== 1 || imageBlocks.length !== 1) {
    throw new McpResponseError("Screenshot response block types are invalid", response);
  }
  const text = textBlocks[0]?.text;
  const image = imageBlocks[0];
  if (
    typeof text !== "string" ||
    image === undefined ||
    typeof image.data !== "string" ||
    typeof image.mimeType !== "string"
  ) {
    throw new McpResponseError("Screenshot response content is incomplete", response);
  }
  if (Buffer.byteLength(text, "utf8") > MAX_SCREENSHOT_METADATA) {
    throw new McpResponseError("Screenshot metadata is too large");
  }
  const match = /^Screenshot ([1-9]\d*)x([1-9]\d*)px \((jpeg|png)(?: q(\d{1,3}))?\)/.exec(text);
  if (match === null) throw new McpResponseError("Screenshot metadata is invalid");
  const width = Number(match[1]);
  const height = Number(match[2]);
  const format = match[3] as "jpeg" | "png";
  const quality = match[4] === undefined ? undefined : Number(match[4]);
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width > 100_000 ||
    height > 100_000 ||
    format !== requestedFormat ||
    (format === "jpeg" && (quality === undefined || quality < 1 || quality > 100)) ||
    (format === "png" && quality !== undefined)
  ) {
    throw new McpResponseError("Screenshot metadata does not match the requested format");
  }
  const expectedMime = format === "jpeg" ? "image/jpeg" : "image/png";
  if (image.mimeType !== expectedMime) throw new McpResponseError("Screenshot MIME type does not match metadata");
  validateBase64(image.data);
  const decodedBytes = decodedBase64Length(image.data);
  if (decodedBytes > MAX_SCREENSHOT_BYTES) {
    throw new McpResponseError(`Screenshot exceeds ${MAX_SCREENSHOT_BYTES} decoded bytes`);
  }
  return Object.freeze({
    data: image.data,
    mimeType: expectedMime,
    format,
    target,
    capturedAt,
    width,
    height,
    ...(quality === undefined ? {} : { quality }),
  });
}

function validateBase64(value: string): void {
  if (
    value.length === 0 ||
    value.length > MAX_SCREENSHOT_TRANSFER ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    throw new McpResponseError("Screenshot image data is not valid bounded base64");
  }
}

function decodedBase64Length(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

function createAbortError(): Error {
  const error = new Error("MCP call aborted");
  error.name = "AbortError";
  return error;
}
