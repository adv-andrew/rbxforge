import { z } from "zod";

export const PROTOCOL_VERSION = 1 as const;
export const AGENT_TEXT_DELTA_MAX_BYTES = 16_384;

const idSchema = z.string().min(1).max(256);
const generationSchema = z.number().int().nonnegative();
const envelope = {
  v: z.literal(PROTOCOL_VERSION),
  sessionId: idSchema,
  requestId: idSchema,
  generation: generationSchema,
} as const;

export const connectionActionSchema = z.enum([
  "selectProject",
  "startRojo",
  "stopRojo",
  "installStudioPlugin",
  "selectStudioInstance",
  "refreshStudio",
]);

const color3Schema = z
  .object({
    R: z.number().finite().min(0).max(1),
    G: z.number().finite().min(0).max(1),
    B: z.number().finite().min(0).max(1),
  })
  .strict();
const vector2Schema = z.object({ X: z.number().finite(), Y: z.number().finite() }).strict();
const vector3Schema = z
  .object({
    X: z.number().finite(),
    Y: z.number().finite(),
    Z: z.number().finite(),
  })
  .strict();
const udimSchema = z.object({ Scale: z.number().finite(), Offset: z.number().finite() }).strict();
const udim2Schema = z
  .object({
    _type: z.literal("UDim2"),
    X: udimSchema,
    Y: udimSchema,
  })
  .strict();
const cframeSchema = z.tuple([
  z.number().finite(),
  z.number().finite(),
  z.number().finite(),
  z.number().finite(),
  z.number().finite(),
  z.number().finite(),
  z.number().finite(),
  z.number().finite(),
  z.number().finite(),
  z.number().finite(),
  z.number().finite(),
  z.number().finite(),
]);

export const typedPropertyValueSchema = z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  color3Schema,
  vector2Schema,
  vector3Schema,
  udimSchema,
  udim2Schema,
  cframeSchema,
]);

const propertyProposalSchema = z
  .object({
    instanceId: idSchema,
    instancePath: idSchema,
    propertyName: idSchema,
    snapshotId: idSchema,
    value: typedPropertyValueSchema,
    displayGeneration: generationSchema,
  })
  .strict();

const logCursorSchema = z.union([z.number().int().nonnegative(), z.record(z.number().int().nonnegative())]);

const webviewMessageSchema = z.discriminatedUnion("type", [
  z.object({ ...envelope, type: z.literal("ready") }).strict(),
  z.object({ ...envelope, type: z.literal("refreshConnection") }).strict(),
  z
    .object({
      ...envelope,
      type: z.literal("runConnectionAction"),
      action: connectionActionSchema,
    })
    .strict(),
  z.object({ ...envelope, type: z.literal("refreshProperties") }).strict(),
  z
    .object({
      ...envelope,
      type: z.literal("proposePropertyMutation"),
      proposal: propertyProposalSchema,
    })
    .strict(),
  z
    .object({
      ...envelope,
      type: z.literal("openDefiningFile"),
      instancePath: idSchema,
    })
    .strict(),
  z.object({ ...envelope, type: z.literal("refreshPlaytest") }).strict(),
  z
    .object({
      ...envelope,
      type: z.literal("startPlaytest"),
      mode: z.enum(["play", "run"]),
    })
    .strict(),
  z.object({ ...envelope, type: z.literal("stopPlaytest") }).strict(),
  z
    .object({
      ...envelope,
      type: z.literal("pollRuntimeLogs"),
      cursor: logCursorSchema.optional(),
      filter: z.string().max(1_024).optional(),
    })
    .strict(),
  z.object({ ...envelope, type: z.literal("refreshActivity") }).strict(),
  z
    .object({
      ...envelope,
      type: z.literal("openActivitySource"),
      entryId: idSchema,
    })
    .strict(),
  z.object({ ...envelope, type: z.literal("captureViewport") }).strict(),
  z
    .object({
      ...envelope,
      type: z.literal("startAgentRun"),
      mode: z.enum(["ask", "build", "debug"]),
      prompt: z.string().min(1).max(32_768),
      chipIds: z.array(idSchema).max(24),
    })
    .strict(),
  z
    .object({
      ...envelope,
      type: z.literal("stopAgentRun"),
      runId: idSchema,
    })
    .strict(),
  z
    .object({
      ...envelope,
      type: z.literal("retryAgentRun"),
      previousRunId: idSchema,
    })
    .strict(),
  z
    .object({
      ...envelope,
      type: z.literal("removeAgentContext"),
      chipId: idSchema,
    })
    .strict(),
  z
    .object({
      ...envelope,
      type: z.literal("resolveAgentApproval"),
      runId: idSchema,
      approvalId: idSchema,
      decision: z.enum(["approve", "reject"]),
    })
    .strict(),
  z
    .object({
      ...envelope,
      type: z.literal("openAgentDiff"),
      runId: idSchema,
      approvalId: idSchema,
    })
    .strict(),
]);

const healthSchema = z.enum(["unknown", "checking", "healthy", "unhealthy"]);
const checkSchema = z
  .object({
    id: z.enum([
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
    ]),
    label: z.string(),
    required: z.boolean(),
    health: healthSchema,
    detail: z.string(),
    observedAt: z.number().finite(),
    action: connectionActionSchema.optional(),
  })
  .strict();

const connectionSnapshotSchema = z
  .object({
    aggregate: z.enum(["Ready", "Not ready"]),
    simulation: z.boolean(),
    observedAt: z.number().finite(),
    checks: z.array(checkSchema).length(10),
  })
  .strict();

const propertyKindSchema = z.enum([
  "boolean",
  "number",
  "string",
  "enum",
  "Color3",
  "Vector2",
  "Vector3",
  "CFrame",
  "UDim",
  "UDim2",
  "unknown",
]);
const ownershipSchema = z.enum(["files", "studio", "shared", "unknown", "drift"]);
const verificationSchema = z.enum(["verified", "mismatch", "unverifiable"]);
const propertyRowSchema = z
  .object({
    name: idSchema,
    category: z.string(),
    kind: propertyKindSchema,
    editable: z.boolean(),
    liveValue: typedPropertyValueSchema.optional(),
    declaredValue: typedPropertyValueSchema.optional(),
    rawValue: z.string().optional(),
    enumOptions: z.array(z.string()).optional(),
    comparable: z.boolean(),
    blockedReason: z.string().optional(),
    mutationState: z.enum(["idle", "approval-pending", "applying", "blocked", "complete"]).optional(),
    verification: verificationSchema.optional(),
  })
  .strict();

const propertiesSnapshotSchema = z
  .object({
    snapshotId: idSchema,
    instanceId: idSchema,
    instancePath: idSchema,
    name: z.string(),
    className: z.string(),
    placeName: z.string(),
    ownership: ownershipSchema,
    freshness: z.enum(["fresh", "stale", "unknown"]),
    simulation: z.boolean(),
    connected: z.boolean(),
    observedAt: z.number().finite(),
    properties: z.array(propertyRowSchema),
  })
  .strict();

const runtimeLogRowSchema = z
  .object({
    seq: z.number().int().nonnegative(),
    ts: z.number().finite().nonnegative(),
    level: z.enum(["OUT", "WARN", "ERR", "INFO"]),
    message: z.string().max(65_536),
    capturedBy: z.string().min(1).max(128).optional(),
  })
  .strict();

const playtestCapabilitiesSchema = z
  .object({
    lifecycle: z.boolean(),
    logs: z.boolean(),
    screenshot: z.boolean(),
    reason: z.string().max(2_048).optional(),
  })
  .strict();

const playtestSnapshotSchema = z
  .object({
    instanceId: idSchema.optional(),
    state: z.enum(["idle", "starting", "running", "stopping", "unknown"]),
    mode: z.enum(["play", "run"]).optional(),
    roles: z.array(z.string().min(1).max(128)).max(64),
    runtimeGeneration: generationSchema,
    observedAt: z.number().finite(),
    error: z.string().max(8_192).optional(),
    capabilities: playtestCapabilitiesSchema,
    entries: z.array(runtimeLogRowSchema).max(2_000),
    totalDropped: z.number().int().nonnegative(),
    cursor: logCursorSchema.optional(),
    perCaptureErrors: z.record(z.string().max(8_192)),
  })
  .strict();

const activityEntrySchema = z
  .object({
    id: idSchema,
    timestamp: z.string().max(128),
    instanceId: idSchema.optional(),
    operation: z.string().min(1).max(256),
    result: z.string().min(1).max(128),
    verification: verificationSchema.optional(),
    droppedLogs: z.number().int().nonnegative().optional(),
    detail: z.string().max(8_192).optional(),
    sourcePath: z.string().min(1).max(8_192).optional(),
  })
  .strict();

const viewportCaptureSchema = z
  .object({
    captureId: idSchema,
    capturedAt: z.number().finite(),
    freshness: z.enum(["fresh", "stale"]),
    target: z.enum(["client-1", "edit", "auto"]),
    width: z.number().int().positive().max(100_000).optional(),
    height: z.number().int().positive().max(100_000).optional(),
    format: z.enum(["jpeg", "png"]),
    quality: z.number().int().min(1).max(100).optional(),
    mimeType: z.enum(["image/jpeg", "image/png"]),
    data: z
      .string()
      .min(4)
      .max(8_000_000)
      .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  })
  .strict();

const agentChipSchema = z
  .object({
    id: idSchema,
    label: z.string().min(1).max(256),
    kind: z.enum([
      "file",
      "selection",
      "studio-children",
      "studio-properties",
      "rojo-mapping",
      "diagnostic",
      "log",
      "screenshot",
    ]),
  })
  .strict();

const agentSnapshotSchema = z
  .object({
    simulation: z.boolean(),
    connected: z.boolean(),
    status: z.enum(["empty", "ready", "running", "stopping", "completed", "error", "stale"]),
    mode: z.enum(["ask", "build", "debug"]),
    runId: idSchema.optional(),
    chips: z.array(agentChipSchema).max(24),
    canRetry: z.boolean(),
    detail: z.string().max(1_024).optional(),
  })
  .strict();

const agentToolCardSchema = z
  .object({
    runId: idSchema,
    callId: idSchema,
    name: z.string().min(1).max(128),
    access: z.enum(["read", "write", "blocked"]),
    state: z.enum(["running", "blocked", "complete"]),
    code: z.string().min(1).max(64).optional(),
  })
  .strict();

const agentApprovalChangeSchema = z
  .object({
    before: z.string().min(1).max(160),
    after: z.string().min(1).max(160),
  })
  .strict();

const agentApprovalEnvelope = {
  runId: idSchema,
  approvalId: idSchema,
  summary: z.string().min(1).max(512),
  expiresAt: z.number().finite(),
} as const;

const agentApprovalSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...agentApprovalEnvelope,
      kind: z.literal("filesystem"),
    })
    .strict(),
  z
    .object({
      ...agentApprovalEnvelope,
      kind: z.literal("studio"),
      change: agentApprovalChangeSchema.optional(),
    })
    .strict(),
]);

const agentVerificationSchema = z.enum(["verified", "fixture-verified", "unverified"]);

const agentTextDeltaSchema = z
  .string()
  .max(AGENT_TEXT_DELTA_MAX_BYTES)
  .refine(
    (value) => new TextEncoder().encode(value).byteLength <= AGENT_TEXT_DELTA_MAX_BYTES,
    `Agent text delta must be at most ${AGENT_TEXT_DELTA_MAX_BYTES} UTF-8 bytes`,
  );

const hostMessageSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...envelope,
      type: z.literal("init"),
      view: z.enum(["connection", "properties", "playtest", "activity", "viewport", "agent"]),
    })
    .strict(),
  z
    .object({
      ...envelope,
      type: z.literal("connectionSnapshot"),
      snapshot: connectionSnapshotSchema,
    })
    .strict(),
  z
    .object({
      ...envelope,
      type: z.literal("propertiesSnapshot"),
      snapshot: propertiesSnapshotSchema,
    })
    .strict(),
  z
    .object({
      ...envelope,
      type: z.literal("mutationStatus"),
      instanceId: idSchema,
      instancePath: idSchema,
      propertyName: idSchema,
      state: z.enum(["approval-pending", "applying", "complete", "blocked"]),
      verification: verificationSchema.optional(),
      detail: z.string().optional(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      type: z.literal("protocolError"),
      message: z.string(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      type: z.literal("playtestSnapshot"),
      snapshot: playtestSnapshotSchema,
    })
    .strict(),
  z
    .object({
      ...envelope,
      type: z.literal("activitySnapshot"),
      entries: z.array(activityEntrySchema).max(1_000),
    })
    .strict(),
  z
    .object({
      ...envelope,
      type: z.literal("viewportStatus"),
      state: z.enum(["empty", "loading", "error"]),
      detail: z.string().max(8_192).optional(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      type: z.literal("viewportCapture"),
      capture: viewportCaptureSchema,
    })
    .strict(),
  z
    .object({
      ...envelope,
      type: z.literal("viewportStale"),
      captureId: idSchema,
    })
    .strict(),
  z
    .object({
      ...envelope,
      type: z.literal("agentSnapshot"),
      snapshot: agentSnapshotSchema,
    })
    .strict(),
  z
    .object({
      ...envelope,
      type: z.literal("agentTextDelta"),
      runId: idSchema,
      sequence: z.number().int().positive(),
      delta: agentTextDeltaSchema,
    })
    .strict(),
  z
    .object({
      ...envelope,
      type: z.literal("agentToolCard"),
      card: agentToolCardSchema,
    })
    .strict(),
  z
    .object({
      ...envelope,
      type: z.literal("agentApproval"),
      approval: agentApprovalSchema,
    })
    .strict(),
  z
    .object({
      ...envelope,
      type: z.literal("agentTerminal"),
      runId: idSchema,
      state: z.enum(["completed", "stopped", "error"]),
      verification: agentVerificationSchema.optional(),
      code: z.string().min(1).max(64).optional(),
      message: z.string().min(1).max(512).optional(),
    })
    .strict(),
]);

const persistedUiStateSchema = z
  .object({
    query: z.string().max(512).optional(),
    collapsedCategories: z.array(z.string().max(256)).max(128).optional(),
    selectedPath: z.string().max(2048).optional(),
    scrollAnchor: z.string().max(512).optional(),
    agentMode: z.enum(["ask", "build", "debug"]).optional(),
  })
  .strict();

export type ConnectionAction = z.infer<typeof connectionActionSchema>;
export type TypedPropertyValue = z.infer<typeof typedPropertyValueSchema>;
export type PropertyProposal = z.infer<typeof propertyProposalSchema>;
export type WebviewMessage = z.infer<typeof webviewMessageSchema>;
export type HostMessage = z.infer<typeof hostMessageSchema>;
export type ConnectionSnapshot = z.infer<typeof connectionSnapshotSchema>;
export type PropertiesSnapshot = z.infer<typeof propertiesSnapshotSchema>;
export type PropertyRow = z.infer<typeof propertyRowSchema>;
export type PersistedUiState = z.infer<typeof persistedUiStateSchema>;
export type RuntimeLogRow = z.infer<typeof runtimeLogRowSchema>;
export type PlaytestSnapshotMessage = z.infer<typeof playtestSnapshotSchema>;
export type ActivityEntryMessage = z.infer<typeof activityEntrySchema>;
export type ViewportCaptureMessage = z.infer<typeof viewportCaptureSchema>;
export type LogCursorMessage = z.infer<typeof logCursorSchema>;
export type AgentSnapshotMessage = z.infer<typeof agentSnapshotSchema>;
export type AgentToolCardMessage = z.infer<typeof agentToolCardSchema>;
export type AgentApprovalMessage = z.infer<typeof agentApprovalSchema>;

export function parseWebviewMessage(value: unknown): WebviewMessage {
  return webviewMessageSchema.parse(value);
}

export function parseHostMessage(value: unknown): HostMessage {
  return hostMessageSchema.parse(value);
}

export function parsePersistedUiState(value: unknown): PersistedUiState {
  const result = persistedUiStateSchema.safeParse(value);
  return result.success ? result.data : {};
}

const sensitiveKey = /key|token|secret|authorization|credential/i;

export function sanitizeForWebview(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitizeForWebview);
  }
  if (isPlainRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !sensitiveKey.test(key))
        .map(([key, entry]) => [key, sanitizeForWebview(entry)]),
    );
  }
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  return undefined;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
