import type { DesktopError } from "../../shared/errors.js";
import type { DesktopSnapshot, ProjectRecord, ThreadRecord } from "../../shared/domain.js";
import type { DesktopResponse, DesktopResult, PluginInspectionView } from "../../shared/protocol.js";

export type RequestKey =
  | "bootstrap"
  | "project.add"
  | "project.addCandidate"
  | "project.cancelAdd"
  | "project.copyFile"
  | "project.select"
  | "project.remove"
  | "thread.create"
  | "thread.select"
  | "thread.rename"
  | "thread.delete"
  | "draft.save"
  | "message.create"
  | "runtime.connect"
  | "runtime.selectStudio"
  | "runtime.confirmRojoHandoff"
  | "runtime.disconnect"
  | "runtime.refresh"
  | "runtime.copyMcpUrl"
  | "runtime.copyRojoAddress"
  | "plugin.inspect"
  | "plugin.install"
  | "plugin.showFolder"
  | "settings.chooseRojo"
  | "settings.mcpPort"
  | "ui.sidebarWidth";

export interface ConnectionFlowIdentity {
  readonly projectId: string;
  readonly flowId: number;
}

interface RequestState {
  readonly generation: number;
  readonly inFlight: boolean;
  readonly error?: DesktopError;
  readonly connectionFlow?: ConnectionFlowIdentity;
}

interface DraftSubmission {
  readonly content: string;
  readonly editVersion: number;
  readonly generation: number;
  readonly requestKey: RequestKey;
}

interface LocalDraft {
  readonly acknowledgedContent: string;
  readonly content: string;
  readonly editVersion: number;
  readonly submitted?: DraftSubmission;
  readonly blockedEditVersion?: number;
  readonly failedGeneration?: number;
  readonly saveError?: DesktopError;
}

export interface DraftSaveCandidate {
  readonly projectId: string;
  readonly threadId: string;
  readonly content: string;
  readonly editVersion: number;
}

export interface FailedDraftSaveCandidate extends DraftSaveCandidate {
  readonly error: DesktopError;
  readonly failedGeneration: number;
}

export interface ProjectCandidateState {
  readonly selectionId: string;
  readonly candidates: Extract<DesktopResult, { kind: "project-candidates" }>["candidates"];
}

export interface AppState {
  readonly status: "loading" | "ready" | "error";
  readonly snapshot: DesktopSnapshot | undefined;
  readonly requests: Readonly<Partial<Record<RequestKey, RequestState>>>;
  readonly lastErrorKey: RequestKey | undefined;
  readonly exclusiveMutation: { readonly key: RequestKey; readonly generation: number } | undefined;
  readonly localDrafts: Readonly<Record<string, LocalDraft>>;
  readonly focusedThreadId: string | undefined;
  readonly projectCandidates: ProjectCandidateState | undefined;
  readonly pluginInspection: PluginInspectionView | undefined;
  readonly studioRestartRecommended: boolean;
  readonly sidebarWidth: number;
  readonly durableSidebarWidth: number;
  readonly sidebarWidthCommit: { readonly generation: number; readonly width: number } | undefined;
  readonly failedSidebarWidth: number | undefined;
  readonly toasts: readonly { readonly id: string; readonly message: string; readonly tone: "success" | "error" }[];
}

export const initialAppState: AppState = {
  status: "loading",
  snapshot: undefined,
  requests: {},
  lastErrorKey: undefined,
  exclusiveMutation: undefined,
  localDrafts: {},
  focusedThreadId: undefined,
  projectCandidates: undefined,
  pluginInspection: undefined,
  studioRestartRecommended: false,
  sidebarWidth: 272,
  durableSidebarWidth: 272,
  sidebarWidthCommit: undefined,
  failedSidebarWidth: undefined,
  toasts: [],
};

export type AppAction =
  | { readonly type: "snapshot.received"; readonly snapshot: DesktopResponse["snapshot"] }
  | {
      readonly type: "request.started";
      readonly key: RequestKey;
      readonly generation: number;
      readonly exclusive: boolean;
      readonly connectionFlow?: ConnectionFlowIdentity;
    }
  | {
      readonly type: "request.completed";
      readonly key: RequestKey;
      readonly generation: number;
      readonly response: DesktopResponse;
      readonly clearConnectionErrorsOnSuccess?: boolean;
    }
  | {
      readonly type: "request.crashed";
      readonly key: RequestKey;
      readonly generation: number;
      readonly error: DesktopError;
    }
  | { readonly type: "request.errorCleared"; readonly key: RequestKey }
  | { readonly type: "connection.errorsCleared"; readonly connectionFlow: ConnectionFlowIdentity }
  | { readonly type: "studio.restartAcknowledged" }
  | { readonly type: "draft.changed"; readonly threadId: string; readonly content: string }
  | {
      readonly type: "draft.submitted";
      readonly threadId: string;
      readonly requestKey: RequestKey;
      readonly generation: number;
      readonly content?: string;
      readonly editVersion?: number;
    }
  | {
      readonly type: "draft.acknowledged";
      readonly threadId: string;
      readonly requestKey: RequestKey;
      readonly generation: number;
      readonly clear: boolean;
    }
  | {
      readonly type: "draft.failed";
      readonly threadId: string;
      readonly requestKey: RequestKey;
      readonly generation: number;
    }
  | { readonly type: "draft.retry"; readonly threadId: string }
  | { readonly type: "thread.focused"; readonly threadId: string }
  | { readonly type: "project.candidates.dismissed"; readonly selectionId: string }
  | { readonly type: "sidebar.width.changed"; readonly width: number }
  | { readonly type: "sidebar.width.commitStarted"; readonly generation: number; readonly width: number }
  | { readonly type: "sidebar.width.commitCompleted"; readonly generation: number; readonly ok: boolean }
  | { readonly type: "toast.added"; readonly id: string; readonly message: string; readonly tone: "success" | "error" }
  | { readonly type: "toast.dismissed"; readonly id: string };

export function reduceAppState(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case "snapshot.received":
      return adoptSnapshot(state, action.snapshot);
    case "request.started":
      return {
        ...state,
        requests: {
          ...state.requests,
          [action.key]: {
            generation: action.generation,
            inFlight: true,
            ...(action.connectionFlow === undefined ? {} : { connectionFlow: action.connectionFlow }),
          },
        },
        lastErrorKey: state.lastErrorKey === action.key ? undefined : state.lastErrorKey,
        exclusiveMutation: action.exclusive
          ? { key: action.key, generation: action.generation }
          : state.exclusiveMutation,
      };
    case "request.completed": {
      const wasReady = state.status === "ready";
      const withSnapshot = adoptSnapshot(state, action.response.snapshot);
      const current = withSnapshot.requests[action.key];
      if (current?.generation !== action.generation) return withSnapshot;
      const request: RequestState = action.response.ok
        ? {
            generation: action.generation,
            inFlight: false,
            ...(current.connectionFlow === undefined ? {} : { connectionFlow: current.connectionFlow }),
          }
        : {
            generation: action.generation,
            inFlight: false,
            error: boundedError(action.response.error),
            ...(current.connectionFlow === undefined ? {} : { connectionFlow: current.connectionFlow }),
          };
      const shouldRelease =
        withSnapshot.exclusiveMutation?.key === action.key &&
        withSnapshot.exclusiveMutation.generation === action.generation;
      const candidates =
        action.response.ok && action.response.result.kind === "project-candidates"
          ? {
              selectionId: action.response.result.selectionId,
              candidates: action.response.result.candidates,
            }
          : withSnapshot.projectCandidates;
      const pluginInspection =
        action.response.ok &&
        action.response.result.kind === "plugin-inspection" &&
        (action.key === "plugin.inspect" || action.key === "plugin.install")
          ? action.response.result.inspection
          : withSnapshot.pluginInspection;
      const nextState: AppState = {
        ...withSnapshot,
        status: action.key === "bootstrap" && !action.response.ok && !wasReady ? "error" : withSnapshot.status,
        requests: { ...withSnapshot.requests, [action.key]: request },
        lastErrorKey: action.response.ok
          ? withSnapshot.lastErrorKey === action.key
            ? undefined
            : withSnapshot.lastErrorKey
          : action.key,
        exclusiveMutation: shouldRelease ? undefined : withSnapshot.exclusiveMutation,
        projectCandidates: candidates,
        pluginInspection,
        studioRestartRecommended: withSnapshot.studioRestartRecommended || pluginInspection?.restartRequired === true,
      };
      return action.response.ok &&
        action.clearConnectionErrorsOnSuccess === true &&
        current.connectionFlow !== undefined
        ? clearConnectionErrors(nextState, current.connectionFlow)
        : nextState;
    }
    case "request.crashed": {
      const current = state.requests[action.key];
      if (current?.generation !== action.generation) return state;
      const shouldRelease =
        state.exclusiveMutation?.key === action.key && state.exclusiveMutation.generation === action.generation;
      return {
        ...state,
        status: action.key === "bootstrap" && state.status !== "ready" ? "error" : state.status,
        requests: {
          ...state.requests,
          [action.key]: {
            generation: action.generation,
            inFlight: false,
            error: boundedError(action.error),
            ...(current.connectionFlow === undefined ? {} : { connectionFlow: current.connectionFlow }),
          },
        },
        lastErrorKey: action.key,
        exclusiveMutation: shouldRelease ? undefined : state.exclusiveMutation,
      };
    }
    case "request.errorCleared": {
      const request = state.requests[action.key];
      if (request?.error === undefined) return state;
      return {
        ...state,
        requests: {
          ...state.requests,
          [action.key]: requestWithoutError(request),
        },
        lastErrorKey: state.lastErrorKey === action.key ? undefined : state.lastErrorKey,
      };
    }
    case "connection.errorsCleared":
      return clearConnectionErrors(state, action.connectionFlow);
    case "studio.restartAcknowledged":
      return { ...state, studioRestartRecommended: false };
    case "draft.changed": {
      const previous = localDraft(state, action.threadId);
      return {
        ...state,
        localDrafts: {
          ...state.localDrafts,
          [action.threadId]: {
            acknowledgedContent: previous.acknowledgedContent,
            content: action.content,
            editVersion: previous.editVersion + 1,
            ...(previous.submitted === undefined ? {} : { submitted: previous.submitted }),
          },
        },
      };
    }
    case "draft.submitted": {
      const previous = localDraft(state, action.threadId);
      const preserveFailure =
        action.requestKey !== "draft.save" && previous.blockedEditVersion !== undefined
          ? {
              blockedEditVersion: previous.blockedEditVersion,
              ...(previous.failedGeneration === undefined ? {} : { failedGeneration: previous.failedGeneration }),
              ...(previous.saveError === undefined ? {} : { saveError: previous.saveError }),
            }
          : {};
      return {
        ...state,
        localDrafts: {
          ...state.localDrafts,
          [action.threadId]: {
            acknowledgedContent: previous.acknowledgedContent,
            content: previous.content,
            editVersion: previous.editVersion,
            ...preserveFailure,
            submitted: {
              content: action.content ?? previous.content,
              editVersion: action.editVersion ?? previous.editVersion,
              generation: action.generation,
              requestKey: action.requestKey,
            },
          },
        },
      };
    }
    case "draft.acknowledged": {
      const previous = state.localDrafts[action.threadId];
      if (
        previous?.submitted?.generation !== action.generation ||
        previous.submitted.requestKey !== action.requestKey
      ) {
        return state;
      }
      const noNewerEdit = previous.editVersion === previous.submitted.editVersion;
      const acknowledgedContent = action.clear ? "" : previous.submitted.content;
      return {
        ...state,
        localDrafts: {
          ...state.localDrafts,
          [action.threadId]: {
            acknowledgedContent,
            content: noNewerEdit ? acknowledgedContent : previous.content,
            editVersion: previous.editVersion,
          },
        },
      };
    }
    case "draft.failed": {
      const previous = state.localDrafts[action.threadId];
      if (
        previous?.submitted?.generation !== action.generation ||
        previous.submitted.requestKey !== action.requestKey
      ) {
        return state;
      }
      const retained: LocalDraft = {
        acknowledgedContent: previous.acknowledgedContent,
        content: previous.content,
        editVersion: previous.editVersion,
        ...(action.requestKey === "draft.save"
          ? {
              blockedEditVersion: previous.submitted.editVersion,
              failedGeneration: action.generation,
              ...(state.requests["draft.save"]?.error === undefined
                ? {}
                : { saveError: state.requests["draft.save"].error }),
            }
          : previous.blockedEditVersion === undefined
            ? {}
            : {
                blockedEditVersion: previous.blockedEditVersion,
                ...(previous.failedGeneration === undefined ? {} : { failedGeneration: previous.failedGeneration }),
                ...(previous.saveError === undefined ? {} : { saveError: previous.saveError }),
              }),
      };
      return { ...state, localDrafts: { ...state.localDrafts, [action.threadId]: retained } };
    }
    case "draft.retry": {
      const previous = state.localDrafts[action.threadId];
      if (previous === undefined || previous.blockedEditVersion === undefined) return state;
      const retryable: LocalDraft = {
        acknowledgedContent: previous.acknowledgedContent,
        content: previous.content,
        editVersion: previous.editVersion,
        ...(previous.submitted === undefined ? {} : { submitted: previous.submitted }),
      };
      return { ...state, localDrafts: { ...state.localDrafts, [action.threadId]: retryable } };
    }
    case "thread.focused":
      return { ...state, focusedThreadId: action.threadId };
    case "project.candidates.dismissed":
      return state.projectCandidates?.selectionId === action.selectionId
        ? { ...state, projectCandidates: undefined }
        : state;
    case "sidebar.width.changed":
      return { ...state, sidebarWidth: clampSidebarWidth(action.width) };
    case "sidebar.width.commitStarted":
      return {
        ...state,
        sidebarWidth: clampSidebarWidth(action.width),
        sidebarWidthCommit: { generation: action.generation, width: clampSidebarWidth(action.width) },
        failedSidebarWidth: undefined,
      };
    case "sidebar.width.commitCompleted":
      if (state.sidebarWidthCommit?.generation !== action.generation) return state;
      return {
        ...state,
        sidebarWidth: state.durableSidebarWidth,
        sidebarWidthCommit: undefined,
        failedSidebarWidth: action.ok ? undefined : state.sidebarWidthCommit.width,
      };
    case "toast.added":
      return {
        ...state,
        toasts: [
          ...state.toasts.filter((toast) => toast.id !== action.id),
          { id: action.id, message: action.message, tone: action.tone },
        ],
      };
    case "toast.dismissed":
      return { ...state, toasts: state.toasts.filter((toast) => toast.id !== action.id) };
  }
}

function adoptSnapshot(state: AppState, incomingProtocol: DesktopResponse["snapshot"]): AppState {
  const incoming = incomingProtocol as unknown as DesktopSnapshot;
  if (state.snapshot !== undefined && incoming.revision < state.snapshot.revision) return state;
  return {
    ...state,
    snapshot: incoming,
    status: "ready",
    durableSidebarWidth: clampSidebarWidth(incoming.settings.sidebarWidth),
    sidebarWidth:
      state.snapshot === undefined ||
      (state.sidebarWidthCommit === undefined && state.sidebarWidth === state.durableSidebarWidth)
        ? clampSidebarWidth(incoming.settings.sidebarWidth)
        : state.sidebarWidth,
  };
}

function boundedError(error: DesktopError): DesktopError {
  return {
    ...error,
    message: error.message.slice(0, 500),
    ...(error.diagnostic === undefined ? {} : { diagnostic: error.diagnostic.slice(0, 2_000) }),
  };
}

function clearConnectionErrors(state: AppState, connectionFlow: ConnectionFlowIdentity): AppState {
  let changed = false;
  const requests = { ...state.requests };
  for (const [key, request] of Object.entries(requests) as [RequestKey, RequestState | undefined][]) {
    if (
      request?.error === undefined ||
      request.connectionFlow === undefined ||
      !sameConnectionFlow(request.connectionFlow, connectionFlow)
    ) {
      continue;
    }
    requests[key] = requestWithoutError(request);
    changed = true;
  }
  if (!changed) return state;
  const lastErrorRequest = state.lastErrorKey === undefined ? undefined : state.requests[state.lastErrorKey];
  const clearedLastError =
    lastErrorRequest?.error !== undefined &&
    lastErrorRequest.connectionFlow !== undefined &&
    sameConnectionFlow(lastErrorRequest.connectionFlow, connectionFlow);
  return {
    ...state,
    requests,
    lastErrorKey: clearedLastError ? undefined : state.lastErrorKey,
  };
}

function requestWithoutError(request: RequestState): RequestState {
  return {
    generation: request.generation,
    inFlight: request.inFlight,
    ...(request.connectionFlow === undefined ? {} : { connectionFlow: request.connectionFlow }),
  };
}

export function sameConnectionFlow(
  left: ConnectionFlowIdentity | undefined,
  right: ConnectionFlowIdentity | undefined,
): boolean {
  return (
    left !== undefined && right !== undefined && left.projectId === right.projectId && left.flowId === right.flowId
  );
}

function localDraft(state: AppState, threadId: string): LocalDraft {
  const existing = state.localDrafts[threadId];
  if (existing !== undefined) return existing;
  const hostContent = state.snapshot?.drafts.find((draft) => draft.threadId === threadId)?.content ?? "";
  return { content: hostContent, acknowledgedContent: hostContent, editVersion: 0 };
}

export function selectDraftContent(state: AppState, threadId: string | undefined): string {
  if (threadId === undefined) return "";
  return localDraft(state, threadId).content;
}

export function selectDraftSaveCandidates(state: AppState): readonly DraftSaveCandidate[] {
  if (state.snapshot === undefined) return [];
  const projects = new Set(state.snapshot.projects.map(({ id }) => id));
  const candidates: DraftSaveCandidate[] = [];
  for (const [threadId, draft] of Object.entries(state.localDrafts)) {
    if (
      draft.content === draft.acknowledgedContent ||
      draft.submitted !== undefined ||
      draft.blockedEditVersion === draft.editVersion
    ) {
      continue;
    }
    const ownedThread = state.snapshot.threads.find(({ id }) => id === threadId);
    if (ownedThread === undefined || !projects.has(ownedThread.projectId)) continue;
    candidates.push({
      projectId: ownedThread.projectId,
      threadId,
      content: draft.content,
      editVersion: draft.editVersion,
    });
  }
  return candidates;
}

export function selectDirtyDraftSaveCandidates(state: AppState): readonly DraftSaveCandidate[] {
  if (state.snapshot === undefined) return [];
  const projects = new Set(state.snapshot.projects.map(({ id }) => id));
  const candidates: DraftSaveCandidate[] = [];
  for (const [threadId, draft] of Object.entries(state.localDrafts)) {
    if (draft.content === draft.acknowledgedContent) continue;
    const ownedThread = state.snapshot.threads.find(({ id }) => id === threadId);
    if (ownedThread === undefined || !projects.has(ownedThread.projectId)) continue;
    candidates.push({
      projectId: ownedThread.projectId,
      threadId,
      content: draft.content,
      editVersion: draft.editVersion,
    });
  }
  return candidates;
}

export function selectBlockedDraftSaveCandidates(state: AppState): readonly FailedDraftSaveCandidate[] {
  if (state.snapshot === undefined) return [];
  const projects = new Set(state.snapshot.projects.map(({ id }) => id));
  const candidates: FailedDraftSaveCandidate[] = [];
  for (const [threadId, draft] of Object.entries(state.localDrafts)) {
    if (
      draft.blockedEditVersion !== draft.editVersion ||
      draft.failedGeneration === undefined ||
      draft.saveError === undefined
    ) {
      continue;
    }
    const ownedThread = state.snapshot.threads.find(({ id }) => id === threadId);
    if (ownedThread === undefined || !projects.has(ownedThread.projectId)) continue;
    candidates.push({
      projectId: ownedThread.projectId,
      threadId,
      content: draft.content,
      editVersion: draft.editVersion,
      error: draft.saveError,
      failedGeneration: draft.failedGeneration,
    });
  }
  return candidates.sort((left, right) => right.failedGeneration - left.failedGeneration);
}

export function selectCurrentView(state: AppState): {
  readonly project?: ProjectRecord;
  readonly thread?: ThreadRecord;
} {
  const project = state.snapshot?.projects.find(({ id }) => id === state.snapshot?.selectedProjectId);
  if (project === undefined) return {};
  const selectedThreadId = state.snapshot?.selectedThreadIdByProject[project.id];
  const thread = state.snapshot?.threads.find(
    (candidate) => candidate.id === selectedThreadId && candidate.projectId === project.id,
  );
  return { project, ...(thread === undefined ? {} : { thread }) };
}

export function clampSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) return 272;
  return Math.min(360, Math.max(232, Math.round(width)));
}
