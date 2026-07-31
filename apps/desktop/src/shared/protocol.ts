/// <reference types="node" />

import { formatDataModelPath, parseDataModelPath } from "@rbxforge/core";
import { z } from "zod";
import { MAX_ECMASCRIPT_DATE_TIMESTAMP_MS } from "./domain.js";
import { desktopErrorSchema } from "./errors.js";

const nonnegativeSafeInteger = z.number().int().nonnegative().safe();
const studioTimestampSchema = nonnegativeSafeInteger.max(MAX_ECMASCRIPT_DATE_TIMESTAMP_MS);
const portSchema = z.number().int().min(1_024).max(65_535);
const identifierSchema = z.string().min(1);
const contentSchema = z.string().max(100_000);
const titleSchema = z.string().trim().min(1).max(120);
const inspectorLabelSchema = z.string().min(1).max(256);
const canonicalDataModelPathSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine((path) => {
    try {
      return formatDataModelPath(parseDataModelPath(path)) === path;
    } catch {
      return false;
    }
  }, "Studio inspector paths must be canonical DataModel paths.");

const projectRecordSchema = z
  .object({
    id: identifierSchema,
    displayName: z.string(),
    canonicalRoot: z.string(),
    rootDevice: z.string(),
    rootInode: z.string(),
    canonicalProjectFile: z.string(),
    projectFileDevice: z.string(),
    projectFileInode: z.string(),
    configDigest: z.string(),
    servePlaceIds: z.array(nonnegativeSafeInteger),
    createdAt: nonnegativeSafeInteger,
    updatedAt: nonnegativeSafeInteger,
    lastOpenedAt: nonnegativeSafeInteger,
  })
  .strict();

const threadRecordSchema = z
  .object({
    id: identifierSchema,
    projectId: identifierSchema,
    title: z.string(),
    createdAt: nonnegativeSafeInteger,
    updatedAt: nonnegativeSafeInteger,
  })
  .strict();

const messageRecordSchema = z
  .object({
    id: identifierSchema,
    threadId: identifierSchema,
    role: z.enum(["user", "system"]),
    content: z.string(),
    createdAt: nonnegativeSafeInteger,
  })
  .strict();

const draftRecordSchema = z
  .object({
    threadId: identifierSchema,
    content: z.string(),
    updatedAt: nonnegativeSafeInteger,
  })
  .strict();

const studioEligibilityReasonSchema = z.enum([
  "role",
  "plugin-variant",
  "plugin-version",
  "server-version",
  "version-mismatch",
  "stale",
  "project-mismatch",
  "catalog-ambiguous",
]);
const studioWarningKindSchema = z.enum(["unknown-place", "unpublished-place"]);

const studioCatalogRowSchema = z
  .object({
    instanceId: identifierSchema,
    role: z.string(),
    placeId: nonnegativeSafeInteger,
    placeName: z.string(),
    dataModelName: z.string(),
    pluginVersion: z.string(),
    pluginVariant: z.string(),
    serverVersion: z.string(),
    versionMismatch: z.boolean(),
    connectedAt: studioTimestampSchema,
    lastActivity: studioTimestampSchema,
    eligible: z.boolean(),
    eligibilityReason: studioEligibilityReasonSchema.optional(),
    warningRequired: z.boolean(),
    warningKind: studioWarningKindSchema.optional(),
  })
  .strict()
  .superRefine((row, context) => {
    if (!row.eligible) {
      if (row.eligibilityReason === undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Ineligible Studio rows require a closed eligibility reason.",
          path: ["eligibilityReason"],
        });
      }
      if (row.warningRequired || row.warningKind !== undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Ineligible Studio rows cannot require a warning.",
          path: ["warningRequired"],
        });
      }
      return;
    }
    if (row.eligibilityReason !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Eligible Studio rows cannot have an eligibility reason.",
        path: ["eligibilityReason"],
      });
    }
    if (row.warningRequired !== (row.warningKind !== undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Warning-required Studio rows need one explicit warning kind.",
        path: ["warningKind"],
      });
    }
  });

const runtimeSnapshotSchema = z
  .object({
    state: z.enum([
      "disconnected",
      "starting-rojo",
      "rojo-server-ready",
      "waiting-for-studio",
      "studio-selection-required",
      "studio-bound",
      "needs-reconnect",
      "catalog-ambiguous",
      "project-mismatch",
      "error",
    ]),
    detail: z.string(),
    activeProject: z
      .object({
        revision: nonnegativeSafeInteger,
        canonicalProjectFile: z.string(),
        relativeProjectFile: z.string(),
        configDigest: z.string(),
      })
      .strict(),
    studioMcp: z
      .object({
        serverVersion: z.string().min(1),
      })
      .strict(),
    rojo: z
      .object({
        port: portSchema,
        generation: nonnegativeSafeInteger,
        executablePath: z.string(),
        version: z.string(),
      })
      .strict()
      .optional(),
    broker: z
      .object({
        state: z.enum(["stopped", "starting", "ready", "error"]),
        primaryPort: portSchema,
        legacyPort: z.literal(3_002).optional(),
        legacyStatus: z.enum(["listening", "occupied", "unknown"]),
        brokerEpoch: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    studio: z
      .object({
        instanceId: identifierSchema,
        placeId: nonnegativeSafeInteger,
        placeName: z.string(),
        dataModelName: z.string(),
        role: z.string(),
        pluginVariant: z.string(),
        pluginVersion: z.string(),
        serverVersion: z.string(),
        connectedAt: studioTimestampSchema,
        lastActivity: studioTimestampSchema,
      })
      .strict()
      .optional(),
    pending: z
      .object({
        instanceId: identifierSchema,
        catalogRevision: nonnegativeSafeInteger,
        bindingRevision: nonnegativeSafeInteger,
        rojoHandoffRequired: z.literal(true),
      })
      .strict()
      .optional(),
    catalog: z.array(studioCatalogRowSchema),
    catalogRevision: nonnegativeSafeInteger.optional(),
    bindingRevision: nonnegativeSafeInteger.optional(),
    error: desktopErrorSchema.optional(),
    samePublishedPlaceLimitation: z.string(),
  })
  .strict();

export const desktopSnapshotSchema = z
  .object({
    revision: nonnegativeSafeInteger,
    projects: z.array(projectRecordSchema),
    threads: z.array(threadRecordSchema),
    messages: z.array(messageRecordSchema),
    drafts: z.array(draftRecordSchema),
    selectedProjectId: identifierSchema.optional(),
    selectedThreadIdByProject: z.record(identifierSchema),
    runtimeByProject: z.record(runtimeSnapshotSchema),
    settings: z
      .object({
        preferredMcpPort: portSchema,
        sidebarWidth: z.number().int().min(232).max(360),
        mcpPortChangeAllowed: z.boolean(),
      })
      .strict(),
  })
  .strict();

const bootstrapInputSchema = z.object({ type: z.literal("bootstrap") }).strict();
const projectAddInputSchema = z
  .object({ type: z.literal("project.add"), expectedRevision: nonnegativeSafeInteger })
  .strict();
const projectAddCandidateInputSchema = z
  .object({
    type: z.literal("project.addCandidate"),
    selectionId: identifierSchema,
    candidateId: identifierSchema,
    expectedRevision: nonnegativeSafeInteger,
  })
  .strict();
const projectCancelAddInputSchema = z
  .object({ type: z.literal("project.cancelAdd"), selectionId: identifierSchema })
  .strict();
const projectSelectInputSchema = z
  .object({ type: z.literal("project.select"), projectId: identifierSchema, expectedRevision: nonnegativeSafeInteger })
  .strict();
const projectRemoveInputSchema = z
  .object({ type: z.literal("project.remove"), projectId: identifierSchema, expectedRevision: nonnegativeSafeInteger })
  .strict();
const projectCopyFileInputSchema = z
  .object({ type: z.literal("project.copyFile"), projectId: identifierSchema })
  .strict();
const threadCreateInputSchema = z
  .object({ type: z.literal("thread.create"), projectId: identifierSchema, expectedRevision: nonnegativeSafeInteger })
  .strict();
const threadSelectInputSchema = z
  .object({
    type: z.literal("thread.select"),
    projectId: identifierSchema,
    threadId: identifierSchema,
    expectedRevision: nonnegativeSafeInteger,
  })
  .strict();
const threadRenameInputSchema = z
  .object({
    type: z.literal("thread.rename"),
    projectId: identifierSchema,
    threadId: identifierSchema,
    title: titleSchema,
    expectedRevision: nonnegativeSafeInteger,
  })
  .strict();
const threadDeleteInputSchema = z
  .object({
    type: z.literal("thread.delete"),
    projectId: identifierSchema,
    threadId: identifierSchema,
    expectedRevision: nonnegativeSafeInteger,
  })
  .strict();
const draftSaveInputSchema = z
  .object({
    type: z.literal("draft.save"),
    projectId: identifierSchema,
    threadId: identifierSchema,
    content: contentSchema,
    expectedRevision: nonnegativeSafeInteger,
  })
  .strict();
const messageCreateInputSchema = z
  .object({
    type: z.literal("message.create"),
    projectId: identifierSchema,
    threadId: identifierSchema,
    content: contentSchema,
    expectedRevision: nonnegativeSafeInteger,
  })
  .strict();
const runtimeConnectInputSchema = z
  .object({ type: z.literal("runtime.connect"), projectId: identifierSchema, expectedRevision: nonnegativeSafeInteger })
  .strict();
const runtimeSelectStudioInputSchema = z
  .object({
    type: z.literal("runtime.selectStudio"),
    projectId: identifierSchema,
    instanceId: identifierSchema,
    catalogRevision: nonnegativeSafeInteger,
    warningAccepted: z.boolean(),
    expectedRevision: nonnegativeSafeInteger,
  })
  .strict();
const runtimeConfirmRojoHandoffInputSchema = z
  .object({
    type: z.literal("runtime.confirmRojoHandoff"),
    projectId: identifierSchema,
    bindingRevision: nonnegativeSafeInteger,
    expectedRevision: nonnegativeSafeInteger,
  })
  .strict();
const runtimeDisconnectInputSchema = z
  .object({
    type: z.literal("runtime.disconnect"),
    projectId: identifierSchema,
    expectedRevision: nonnegativeSafeInteger,
  })
  .strict();
const runtimeRefreshInputSchema = z
  .object({ type: z.literal("runtime.refresh"), projectId: identifierSchema, expectedRevision: nonnegativeSafeInteger })
  .strict();
const runtimeCopyMcpUrlInputSchema = z
  .object({ type: z.literal("runtime.copyMcpUrl"), projectId: identifierSchema })
  .strict();
const runtimeCopyRojoAddressInputSchema = z
  .object({ type: z.literal("runtime.copyRojoAddress"), projectId: identifierSchema })
  .strict();
const studioInspectorRequestIdentityShape = {
  projectId: identifierSchema,
  instanceId: identifierSchema,
  bindingRevision: nonnegativeSafeInteger,
  instancePath: canonicalDataModelPathSchema,
} as const;
const studioInspectorChildrenInputSchema = z
  .object({
    type: z.literal("studioInspector.children"),
    ...studioInspectorRequestIdentityShape,
    expectedRevision: nonnegativeSafeInteger,
  })
  .strict();
const studioInspectorPropertiesInputSchema = z
  .object({
    type: z.literal("studioInspector.properties"),
    ...studioInspectorRequestIdentityShape,
    expectedRevision: nonnegativeSafeInteger,
  })
  .strict();
const pluginInspectInputSchema = z.object({ type: z.literal("plugin.inspect") }).strict();
const pluginInstallInputSchema = z
  .object({ type: z.literal("plugin.install"), confirmReplace: z.boolean(), expectedRevision: nonnegativeSafeInteger })
  .strict();
const pluginShowFolderInputSchema = z.object({ type: z.literal("plugin.showFolder") }).strict();
const settingsChooseRojoInputSchema = z
  .object({ type: z.literal("settings.chooseRojo"), expectedRevision: nonnegativeSafeInteger })
  .strict();
const settingsMcpPortInputSchema = z
  .object({ type: z.literal("settings.mcpPort"), port: portSchema, expectedRevision: nonnegativeSafeInteger })
  .strict();
const uiSidebarWidthInputSchema = z
  .object({
    type: z.literal("ui.sidebarWidth"),
    width: z.number().int().min(232).max(360),
    expectedRevision: nonnegativeSafeInteger,
  })
  .strict();

const commandInputSchemas = [
  bootstrapInputSchema,
  projectAddInputSchema,
  projectAddCandidateInputSchema,
  projectCancelAddInputSchema,
  projectSelectInputSchema,
  projectRemoveInputSchema,
  projectCopyFileInputSchema,
  threadCreateInputSchema,
  threadSelectInputSchema,
  threadRenameInputSchema,
  threadDeleteInputSchema,
  draftSaveInputSchema,
  messageCreateInputSchema,
  runtimeConnectInputSchema,
  runtimeSelectStudioInputSchema,
  runtimeConfirmRojoHandoffInputSchema,
  runtimeDisconnectInputSchema,
  runtimeRefreshInputSchema,
  runtimeCopyMcpUrlInputSchema,
  runtimeCopyRojoAddressInputSchema,
  studioInspectorChildrenInputSchema,
  studioInspectorPropertiesInputSchema,
  pluginInspectInputSchema,
  pluginInstallInputSchema,
  pluginShowFolderInputSchema,
  settingsChooseRojoInputSchema,
  settingsMcpPortInputSchema,
  uiSidebarWidthInputSchema,
] as const;

export const desktopCommandInputSchema = z.discriminatedUnion("type", commandInputSchemas);

function withCommandEnvelope<T extends z.ZodRawShape>(schema: z.ZodObject<T, "strict">) {
  return schema.extend({ version: z.literal(1), requestId: identifierSchema }).strict();
}

export const desktopCommandSchema = z.discriminatedUnion("type", [
  withCommandEnvelope(bootstrapInputSchema),
  withCommandEnvelope(projectAddInputSchema),
  withCommandEnvelope(projectAddCandidateInputSchema),
  withCommandEnvelope(projectCancelAddInputSchema),
  withCommandEnvelope(projectSelectInputSchema),
  withCommandEnvelope(projectRemoveInputSchema),
  withCommandEnvelope(projectCopyFileInputSchema),
  withCommandEnvelope(threadCreateInputSchema),
  withCommandEnvelope(threadSelectInputSchema),
  withCommandEnvelope(threadRenameInputSchema),
  withCommandEnvelope(threadDeleteInputSchema),
  withCommandEnvelope(draftSaveInputSchema),
  withCommandEnvelope(messageCreateInputSchema),
  withCommandEnvelope(runtimeConnectInputSchema),
  withCommandEnvelope(runtimeSelectStudioInputSchema),
  withCommandEnvelope(runtimeConfirmRojoHandoffInputSchema),
  withCommandEnvelope(runtimeDisconnectInputSchema),
  withCommandEnvelope(runtimeRefreshInputSchema),
  withCommandEnvelope(runtimeCopyMcpUrlInputSchema),
  withCommandEnvelope(runtimeCopyRojoAddressInputSchema),
  withCommandEnvelope(studioInspectorChildrenInputSchema),
  withCommandEnvelope(studioInspectorPropertiesInputSchema),
  withCommandEnvelope(pluginInspectInputSchema),
  withCommandEnvelope(pluginInstallInputSchema),
  withCommandEnvelope(pluginShowFolderInputSchema),
  withCommandEnvelope(settingsChooseRojoInputSchema),
  withCommandEnvelope(settingsMcpPortInputSchema),
  withCommandEnvelope(uiSidebarWidthInputSchema),
]);

const pluginInspectionViewSchema = z
  .object({
    state: z.enum(["missing", "installed", "replace-required", "inspector-conflict", "error"]),
    sourcePath: z.string(),
    destinationPath: z.string(),
    sourceSha256: z.string().optional(),
    destinationSha256: z.string().optional(),
    restartRequired: z.boolean(),
    detail: z.string(),
  })
  .strict();

const studioInspectorResultIdentityShape = {
  ...studioInspectorRequestIdentityShape,
  brokerEpoch: identifierSchema,
  observedAt: studioTimestampSchema,
} as const;
const studioInspectorNodeSchema = z
  .object({
    name: inspectorLabelSchema,
    className: inspectorLabelSchema,
    path: canonicalDataModelPathSchema,
    hasChildren: z.boolean(),
    enabled: z.boolean().optional(),
  })
  .strict();
const studioInspectorPropertySchema = z
  .object({
    name: inspectorLabelSchema,
    category: z.enum(["Appearance", "Behavior", "Transform", "Layout", "Content", "Data", "Other"]),
    value: z.string().max(8_192),
    valueKind: z.enum(["boolean", "number", "string", "structured", "nil", "unsupported"]),
  })
  .strict();

const desktopResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z
    .object({
      kind: z.literal("project-candidates"),
      selectionId: identifierSchema,
      candidates: z.array(
        z
          .object({
            candidateId: identifierSchema,
            displayName: z.string(),
            relativeProjectFile: z.string(),
          })
          .strict(),
      ),
    })
    .strict(),
  z.object({ kind: z.literal("plugin-inspection"), inspection: pluginInspectionViewSchema }).strict(),
  z.object({ kind: z.literal("rojo-choice"), changed: z.boolean() }).strict(),
  z.object({ kind: z.literal("clipboard"), label: z.string().min(1) }).strict(),
  z
    .object({
      kind: z.literal("studio-inspector-children"),
      ...studioInspectorResultIdentityShape,
      children: z.array(studioInspectorNodeSchema).max(1_000),
    })
    .strict(),
  z
    .object({
      kind: z.literal("studio-inspector-properties"),
      ...studioInspectorResultIdentityShape,
      className: inspectorLabelSchema,
      properties: z.array(studioInspectorPropertySchema).max(512),
    })
    .strict(),
]);

export const desktopResponseSchema = z.discriminatedUnion("ok", [
  z
    .object({
      version: z.literal(1),
      requestId: identifierSchema,
      ok: z.literal(true),
      snapshot: desktopSnapshotSchema,
      result: desktopResultSchema,
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      requestId: identifierSchema,
      ok: z.literal(false),
      snapshot: desktopSnapshotSchema,
      error: desktopErrorSchema,
    })
    .strict(),
]);

export const desktopEventSchema = z
  .object({ version: z.literal(1), type: z.literal("snapshot"), snapshot: desktopSnapshotSchema })
  .strict();

export const desktopCloseRequestSchema = z
  .object({ version: z.literal(1), type: z.literal("draft-flush"), requestId: identifierSchema })
  .strict();

export const desktopCloseAcknowledgementSchema = z
  .object({ version: z.literal(1), requestId: identifierSchema, ok: z.boolean() })
  .strict();

export const desktopCloseFeedbackSchema = z
  .object({
    version: z.literal(1),
    type: z.literal("close-blocked"),
    reason: z.enum(["save-failed", "timeout"]),
  })
  .strict();

export type DesktopCommandInput = z.infer<typeof desktopCommandInputSchema>;
export type DesktopCommand = z.infer<typeof desktopCommandSchema>;
export type PluginInspectionView = z.infer<typeof pluginInspectionViewSchema>;
export type DesktopResult = z.infer<typeof desktopResultSchema>;
export type DesktopResponse = z.infer<typeof desktopResponseSchema>;
export type DesktopEvent = z.infer<typeof desktopEventSchema>;
export type DesktopCloseRequest = z.infer<typeof desktopCloseRequestSchema>;
export type DesktopCloseFeedback = z.infer<typeof desktopCloseFeedbackSchema>;
