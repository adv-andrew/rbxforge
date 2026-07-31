import type {
  DesktopSnapshot,
  DraftRecord,
  ProjectRecord,
  RuntimeSnapshot,
  StudioCatalogRow,
  ThreadRecord,
} from "../../src/shared/domain.js";
import {
  desktopResponseSchema,
  desktopSnapshotSchema,
  type DesktopCommand,
  type DesktopResponse,
} from "../../src/shared/protocol.js";

export const VISUAL_STATES = [
  "onboarding",
  "empty-chat",
  "populated-chat",
  "studio-selection",
  "studio-bound",
  "mismatch-error",
] as const;

export const INSPECTOR_VISUAL_STATES = ["studio-inspector", "studio-inspector-error"] as const;

export type VisualState = (typeof VISUAL_STATES)[number];
export type InspectorVisualState = (typeof INSPECTOR_VISUAL_STATES)[number];
export type VisualFixtureState = VisualState | InspectorVisualState;

export interface VisualFixtureController {
  initialize(): Promise<DesktopSnapshot>;
  execute(command: DesktopCommand): Promise<DesktopResponse>;
  subscribe(listener: (snapshot: DesktopSnapshot) => void): () => void;
  dispose(): Promise<void>;
}

export interface VisualFixtureControllerOptions {
  readonly beforeExecute?: (command: DesktopCommand) => Promise<void>;
  readonly draftStore?: {
    loadDraft(threadId: string): DraftRecord | undefined;
    saveDraft(threadId: string, content: string): DraftRecord;
  };
}

const FIXED_TIME = Date.UTC(2026, 6, 28, 18, 30, 0);
const PROJECT_ID = "fixture-project";
const THREAD_ID = "fixture-thread";
const SAME_PLACE_LIMITATION =
  "RbxForge cannot detect or distinguish two Studio edit windows for the same published place. Keep only one such window open before binding.";
const INSPECTOR_BROKER_EPOCH = "fixture-broker-epoch-7";
const INSPECTOR_ROOT_CHILDREN = Object.freeze([
  { name: "Workspace", className: "Workspace", path: "game.Workspace", hasChildren: true },
  { name: "Players", className: "Players", path: "game.Players", hasChildren: true },
  {
    name: "ReplicatedStorage",
    className: "ReplicatedStorage",
    path: "game.ReplicatedStorage",
    hasChildren: true,
  },
  {
    name: "ServerScriptService",
    className: "ServerScriptService",
    path: "game.ServerScriptService",
    hasChildren: true,
  },
  { name: "Lighting", className: "Lighting", path: "game.Lighting", hasChildren: true },
]);
const INSPECTOR_WORKSPACE_CHILDREN = Object.freeze([
  { name: "Map", className: "Model", path: "game.Workspace.Map", hasChildren: true },
  {
    name: "SpawnLocation",
    className: "SpawnLocation",
    path: "game.Workspace.SpawnLocation",
    hasChildren: false,
  },
  { name: "MainPart", className: "Part", path: "game.Workspace.MainPart", hasChildren: false },
]);
const INSPECTOR_MAIN_PART_PROPERTIES = Object.freeze([
  { name: "BrickColor", category: "Appearance", value: "Really red", valueKind: "string" },
  { name: "Material", category: "Appearance", value: "SmoothPlastic", valueKind: "string" },
  { name: "Transparency", category: "Appearance", value: "0", valueKind: "number" },
  { name: "Anchored", category: "Behavior", value: "true", valueKind: "boolean" },
  { name: "CanCollide", category: "Behavior", value: "true", valueKind: "boolean" },
  { name: "Orientation", category: "Transform", value: "0, 0, 0", valueKind: "structured" },
  { name: "Position", category: "Transform", value: "0, 4, 0", valueKind: "structured" },
  { name: "Size", category: "Transform", value: "24, 1, 24", valueKind: "structured" },
  { name: "Archivable", category: "Data", value: "true", valueKind: "boolean" },
  { name: "Name", category: "Data", value: "MainPart", valueKind: "string" },
] as const);

const PROJECT: ProjectRecord = Object.freeze({
  id: PROJECT_ID,
  displayName: "Deepwater",
  canonicalRoot: "/fixture/projects/deepwater",
  rootDevice: "fixture-device",
  rootInode: "fixture-root-inode",
  canonicalProjectFile: "/fixture/projects/deepwater/default.project.json",
  projectFileDevice: "fixture-device",
  projectFileInode: "fixture-project-inode",
  configDigest: "4cae9364fa716c2294760bfed47a19ec20488af9b9af70a38d03d7367ee98f74",
  servePlaceIds: [101],
  createdAt: FIXED_TIME - 86_400_000,
  updatedAt: FIXED_TIME - 3_600_000,
  lastOpenedAt: FIXED_TIME,
});

const THREAD: ThreadRecord = Object.freeze({
  id: THREAD_ID,
  projectId: PROJECT_ID,
  title: "Round-based lobby",
  createdAt: FIXED_TIME - 7_200_000,
  updatedAt: FIXED_TIME - 1_800_000,
});

const ELIGIBLE_STUDIO: StudioCatalogRow = Object.freeze({
  instanceId: "studio-instance-101",
  role: "edit",
  placeId: 101,
  placeName: "Deepwater Lobby",
  dataModelName: "Deepwater Lobby",
  pluginVersion: "2.22.5",
  pluginVariant: "main",
  serverVersion: "2.22.5",
  versionMismatch: false,
  connectedAt: FIXED_TIME - 90_000,
  lastActivity: FIXED_TIME - 5_000,
  eligible: true,
  warningRequired: false,
});

const OTHER_STUDIO: StudioCatalogRow = Object.freeze({
  instanceId: "studio-instance-202",
  role: "edit",
  placeId: 202,
  placeName: "Deepwater Arena",
  dataModelName: "Deepwater Arena",
  pluginVersion: "2.22.5",
  pluginVariant: "main",
  serverVersion: "2.22.5",
  versionMismatch: false,
  connectedAt: FIXED_TIME - 75_000,
  lastActivity: FIXED_TIME - 8_000,
  eligible: false,
  eligibilityReason: "project-mismatch",
  warningRequired: false,
});

export function parseVisualStateArgument(argv: readonly string[]): VisualFixtureState {
  const prefix = "--rbxforge-visual-state=";
  const argumentsForFixture = argv.filter((argument) => argument.startsWith("--rbxforge-visual-state"));
  const candidate = argumentsForFixture.length === 1 ? argumentsForFixture[0] : undefined;
  const value = candidate?.startsWith(prefix) ? candidate.slice(prefix.length) : undefined;
  const supportedStates: readonly string[] = [...VISUAL_STATES, ...INSPECTOR_VISUAL_STATES];
  if (value === undefined || !supportedStates.includes(value)) {
    throw new Error("The Electron fixture requires exactly one supported RbxForge visual state argument.");
  }
  return value as VisualFixtureState;
}

export function createVisualFixtureSnapshot(state: VisualFixtureState): DesktopSnapshot {
  const snapshot = state === "onboarding" ? onboardingSnapshot() : projectSnapshot(state, runtimeForState(state));
  return desktopSnapshotSchema.parse(snapshot) as unknown as DesktopSnapshot;
}

export function createVisualFixtureController(
  state: VisualFixtureState,
  options: VisualFixtureControllerOptions = {},
): VisualFixtureController {
  let snapshot = createVisualFixtureSnapshot(state);
  if (options.draftStore !== undefined) {
    snapshot = {
      ...snapshot,
      drafts: snapshot.drafts.map((draft) => options.draftStore?.loadDraft(draft.threadId) ?? draft),
    };
  }
  let disposed = false;
  return Object.freeze({
    async initialize() {
      if (disposed) throw new Error("The visual fixture controller is disposed.");
      return snapshot;
    },
    async execute(command: DesktopCommand) {
      if (disposed) throw new Error("The visual fixture controller is disposed.");
      await options.beforeExecute?.(command);
      if (command.type === "thread.rename") {
        snapshot = {
          ...snapshot,
          revision: snapshot.revision + 1,
          threads: snapshot.threads.map((thread) =>
            thread.id === command.threadId
              ? { ...thread, title: command.title, updatedAt: FIXED_TIME + snapshot.revision + 1 }
              : thread,
          ),
        };
      }
      if (command.type === "draft.save") {
        const draft =
          options.draftStore?.saveDraft(command.threadId, command.content) ??
          ({
            threadId: command.threadId,
            content: command.content,
            updatedAt: FIXED_TIME + snapshot.revision + 1,
          } satisfies DraftRecord);
        snapshot = {
          ...snapshot,
          revision: snapshot.revision + 1,
          drafts: [...snapshot.drafts.filter((draft) => draft.threadId !== command.threadId), draft],
        };
      }
      const inspectorResponse = responseForInspectorCommand(state, command, snapshot);
      if (inspectorResponse !== undefined) return inspectorResponse;
      const result =
        command.type === "plugin.inspect"
          ? {
              kind: "plugin-inspection" as const,
              inspection: {
                state: "installed" as const,
                sourcePath: "/fixture/vendor/studio-plugin/MCPPlugin.rbxmx",
                destinationPath: "/fixture/Roblox/Plugins/RbxForgeMCP.rbxmx",
                sourceSha256: "b".repeat(64),
                destinationSha256: "b".repeat(64),
                restartRequired: false,
                detail: "The audited RbxForge Studio plugin is installed.",
              },
            }
          : command.type === "settings.chooseRojo"
            ? { kind: "rojo-choice" as const, changed: false }
            : { kind: "none" as const };
      return desktopResponseSchema.parse({
        version: 1,
        requestId: command.requestId,
        ok: true,
        snapshot,
        result,
      }) as DesktopResponse;
    },
    subscribe(_listener: (snapshot: DesktopSnapshot) => void) {
      return () => undefined;
    },
    async dispose() {
      disposed = true;
    },
  });
}

function onboardingSnapshot(): DesktopSnapshot {
  return {
    revision: 1,
    projects: [],
    threads: [],
    messages: [],
    drafts: [],
    selectedThreadIdByProject: {},
    runtimeByProject: {},
    settings: {
      preferredMcpPort: 58_741,
      sidebarWidth: 272,
      mcpPortChangeAllowed: true,
    },
  };
}

function projectSnapshot(state: Exclude<VisualFixtureState, "onboarding">, runtime: RuntimeSnapshot): DesktopSnapshot {
  return {
    revision: 7,
    projects: [PROJECT],
    threads: [THREAD],
    messages:
      state === "populated-chat"
        ? [
            {
              id: "fixture-message-user",
              threadId: THREAD_ID,
              role: "user",
              content: "Create a round-based lobby with a clear intermission state and local match timer.",
              createdAt: FIXED_TIME - 1_200_000,
            },
            {
              id: "fixture-message-system",
              threadId: THREAD_ID,
              role: "system",
              content: "Prompt saved locally. RbxForge did not generate or send an assistant response.",
              createdAt: FIXED_TIME - 1_199_000,
            },
          ]
        : [],
    drafts: [{ threadId: THREAD_ID, content: "", updatedAt: FIXED_TIME }],
    selectedProjectId: PROJECT_ID,
    selectedThreadIdByProject: { [PROJECT_ID]: THREAD_ID },
    runtimeByProject: { [PROJECT_ID]: runtime },
    settings: {
      preferredMcpPort: 58_741,
      sidebarWidth: 272,
      mcpPortChangeAllowed: !isStudioBoundFixture(state),
    },
  };
}

function runtimeForState(state: Exclude<VisualFixtureState, "onboarding">): RuntimeSnapshot {
  const base = {
    detail: "Reconnect this project to verify Rojo and Studio.",
    activeProject: {
      revision: 1,
      canonicalProjectFile: PROJECT.canonicalProjectFile,
      relativeProjectFile: "default.project.json",
      configDigest: PROJECT.configDigest,
    },
    studioMcp: { serverVersion: "2.22.5" },
    catalog: [] as readonly StudioCatalogRow[],
    samePublishedPlaceLimitation: SAME_PLACE_LIMITATION,
  };
  if (state === "empty-chat" || state === "populated-chat") {
    return { ...base, state: "needs-reconnect" };
  }
  const connected = {
    ...base,
    rojo: {
      port: 34_871,
      generation: 3,
      executablePath: "/fixture/bin/rojo",
      version: "7.7.1",
    },
    broker: {
      state: "ready" as const,
      primaryPort: 58_741,
      legacyPort: 3_002 as const,
      legacyStatus: "listening" as const,
      brokerEpoch: INSPECTOR_BROKER_EPOCH,
    },
    catalogRevision: 11,
  };
  if (state === "studio-selection") {
    return {
      ...connected,
      state: "studio-selection-required",
      detail: "Choose the exact Studio place before the manual Rojo handoff.",
      catalog: [ELIGIBLE_STUDIO, OTHER_STUDIO],
    };
  }
  if (isStudioBoundFixture(state)) {
    return {
      ...connected,
      state: "studio-bound",
      detail: "Studio is bound after the confirmed manual Rojo handoff.",
      catalog: [ELIGIBLE_STUDIO],
      bindingRevision: 19,
      studio: {
        instanceId: ELIGIBLE_STUDIO.instanceId,
        placeId: ELIGIBLE_STUDIO.placeId,
        placeName: ELIGIBLE_STUDIO.placeName,
        dataModelName: ELIGIBLE_STUDIO.dataModelName,
        role: ELIGIBLE_STUDIO.role,
        pluginVariant: ELIGIBLE_STUDIO.pluginVariant,
        pluginVersion: ELIGIBLE_STUDIO.pluginVersion,
        serverVersion: ELIGIBLE_STUDIO.serverVersion,
        connectedAt: ELIGIBLE_STUDIO.connectedAt,
        lastActivity: ELIGIBLE_STUDIO.lastActivity,
      },
    };
  }
  return {
    ...connected,
    state: "project-mismatch",
    detail: "The open Studio place does not match this project's declared place IDs.",
    catalog: [OTHER_STUDIO],
    error: {
      layer: "studio",
      code: "project-place-mismatch",
      message: "The reported Studio place belongs to a different project. Choose the matching place and refresh.",
      recovery: { action: "choose-place", label: "Choose Studio place" },
    },
  };
}

function isStudioBoundFixture(state: Exclude<VisualFixtureState, "onboarding">): boolean {
  return state === "studio-bound" || state === "studio-inspector" || state === "studio-inspector-error";
}

function responseForInspectorCommand(
  state: VisualFixtureState,
  command: DesktopCommand,
  snapshot: DesktopSnapshot,
): DesktopResponse | undefined {
  if (command.type !== "studioInspector.children" && command.type !== "studioInspector.properties") {
    return undefined;
  }
  const fail = (code: string, message: string): DesktopResponse =>
    desktopResponseSchema.parse({
      version: 1,
      requestId: command.requestId,
      ok: false,
      snapshot,
      error: {
        layer: "studio",
        code,
        message,
        recovery: { action: "retry", label: "Retry Studio inspection" },
      },
    }) as DesktopResponse;

  if (state === "studio-inspector-error") {
    return fail("studio-inspector-fixture-unavailable", "Studio inspection is temporarily unavailable.");
  }
  if (state !== "studio-inspector") {
    return fail("studio-inspector-fixture-disabled", "Studio inspection is unavailable in this visual state.");
  }
  if (
    command.projectId !== PROJECT_ID ||
    command.instanceId !== ELIGIBLE_STUDIO.instanceId ||
    command.bindingRevision !== 19
  ) {
    return fail("studio-inspector-fixture-identity", "The Studio inspection identity changed.");
  }

  if (command.type === "studioInspector.children") {
    const children =
      command.instancePath === "game"
        ? INSPECTOR_ROOT_CHILDREN
        : command.instancePath === "game.Workspace"
          ? INSPECTOR_WORKSPACE_CHILDREN
          : undefined;
    if (children === undefined) {
      return fail("studio-inspector-fixture-path", "The Studio fixture does not recognize this object path.");
    }
    return desktopResponseSchema.parse({
      version: 1,
      requestId: command.requestId,
      ok: true,
      snapshot,
      result: {
        kind: "studio-inspector-children",
        projectId: command.projectId,
        instanceId: command.instanceId,
        bindingRevision: command.bindingRevision,
        brokerEpoch: INSPECTOR_BROKER_EPOCH,
        instancePath: command.instancePath,
        observedAt: FIXED_TIME,
        children,
      },
    }) as DesktopResponse;
  }

  if (command.instancePath !== "game.Workspace.MainPart") {
    return fail("studio-inspector-fixture-path", "The Studio fixture does not recognize this object path.");
  }
  return desktopResponseSchema.parse({
    version: 1,
    requestId: command.requestId,
    ok: true,
    snapshot,
    result: {
      kind: "studio-inspector-properties",
      projectId: command.projectId,
      instanceId: command.instanceId,
      bindingRevision: command.bindingRevision,
      brokerEpoch: INSPECTOR_BROKER_EPOCH,
      instancePath: command.instancePath,
      observedAt: FIXED_TIME,
      className: "Part",
      properties: INSPECTOR_MAIN_PART_PROPERTIES,
    },
  }) as DesktopResponse;
}
