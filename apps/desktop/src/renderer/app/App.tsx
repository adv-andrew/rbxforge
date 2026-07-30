import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";

import markUrl from "../../../assets/brand/rbxforge-mark.svg";
import type { DesktopError } from "../../shared/errors.js";
import type { ProjectRuntimeState } from "../../shared/domain.js";
import type { DesktopResponse } from "../../shared/protocol.js";
import { AppShell } from "../components/AppShell/AppShell.js";
import { ChatComposer } from "../components/ChatComposer/ChatComposer.js";
import { ChatTimeline } from "../components/ChatTimeline/ChatTimeline.js";
import {
  ConnectionSheet,
  type ConnectionOperation,
  type ConnectionSheetActions,
} from "../components/ConnectionSheet/ConnectionSheet.js";
import { ProjectHeader } from "../components/ProjectHeader/ProjectHeader.js";
import { ProjectSidebar, ProjectSidebarLoading } from "../components/ProjectSidebar/ProjectSidebar.js";
import { Button } from "../components/shared/Button.js";
import { Dialog } from "../components/shared/Dialog.js";
import { EmptyState } from "../components/shared/EmptyState.js";
import { InlineError } from "../components/shared/InlineError.js";
import { Skeleton } from "../components/shared/Skeleton.js";
import { ToastRegion } from "../components/shared/ToastRegion.js";
import {
  initialAppState,
  reduceAppState,
  sameConnectionFlow,
  selectBlockedDraftSaveCandidates,
  selectCurrentView,
  selectDirtyDraftSaveCandidates,
  selectDraftContent,
  selectDraftSaveCandidates,
  type AppAction,
  type AppState,
  type ConnectionFlowIdentity,
  type DraftSaveCandidate,
  type RequestKey,
} from "./app-reducer.js";
import { createDesktopClient, type DesktopClient, type RendererApi } from "./desktop-client.js";
import styles from "./App.module.css";

export interface AppProps {
  readonly api?: RendererApi;
}

export function App({ api = window.rbxforge }: AppProps) {
  const [state, reactDispatch] = useReducer(reduceAppState, initialAppState);
  const stateRef = useRef(state);
  stateRef.current = state;
  const generations = useRef<Partial<Record<RequestKey, number>>>({});
  const toastTimers = useRef(new Map<string, number>());
  const nextCloseFeedbackId = useRef(0);
  const bootstrapStarted = useRef(false);
  const closeFlushActive = useRef(false);
  const exclusiveSettlements = useRef(new Set<Promise<void>>());
  const cancelCandidateRef = useRef<{ selectionId: string; run: () => Promise<DesktopResponse> } | undefined>(
    undefined,
  );
  const [connectionFlow, setConnectionFlow] = useState<ConnectionFlowIdentity>();
  const connectionFlowRef = useRef<ConnectionFlowIdentity | undefined>(undefined);
  const nextConnectionFlowId = useRef(0);
  const connectionInspectionGeneration = useRef(0);
  const dispatch = useCallback((action: AppAction) => {
    stateRef.current = reduceAppState(stateRef.current, action);
    reactDispatch(action);
  }, []);
  const client = useMemo(
    () =>
      createDesktopClient({
        api,
        getExpectedRevision: () => stateRef.current.snapshot?.revision ?? 0,
      }),
    [api],
  );

  const run = useCallback(
    async (
      key: RequestKey,
      exclusive: boolean,
      request: () => Promise<DesktopResponse>,
      options: RunOptions = {},
    ): Promise<DesktopResponse | undefined> => {
      if (exclusive && stateRef.current.exclusiveMutation !== undefined) return undefined;
      if (closeFlushActive.current && exclusive && key !== "draft.save") return undefined;
      let settleExclusive: (() => void) | undefined;
      let exclusiveSettlement: Promise<void> | undefined;
      if (exclusive) {
        exclusiveSettlement = new Promise<void>((resolve) => {
          settleExclusive = resolve;
        });
        exclusiveSettlements.current.add(exclusiveSettlement);
      }
      try {
        const generation = (generations.current[key] ?? 0) + 1;
        generations.current[key] = generation;
        dispatch({
          type: "request.started",
          key,
          generation,
          exclusive,
          ...(options.connectionFlow === undefined ? {} : { connectionFlow: options.connectionFlow }),
        });
        options.onGeneration?.(generation);
        let response: DesktopResponse;
        try {
          response = await request();
        } catch {
          const fallback = stateRef.current.snapshot;
          if (fallback === undefined) {
            dispatch({
              type: "request.crashed",
              key,
              generation,
              error: {
                layer: "ipc",
                code: "renderer-request-failed",
                message: "The desktop host could not complete the request.",
                recovery: { action: "retry", label: "Retry" },
              },
            });
            return undefined;
          }
          response = {
            version: 1,
            requestId: "renderer-request",
            ok: false,
            snapshot: fallback as unknown as DesktopResponse["snapshot"],
            error: {
              layer: "ipc",
              code: "renderer-request-failed",
              message: "The desktop host could not complete the request.",
              recovery: { action: "retry", label: "Retry" },
            },
          };
        }
        dispatch({
          type: "request.completed",
          key,
          generation,
          response,
          ...(options.clearConnectionErrorsOnSuccess === undefined
            ? {}
            : { clearConnectionErrorsOnSuccess: options.clearConnectionErrorsOnSuccess }),
        });
        return response;
      } finally {
        settleExclusive?.();
        if (exclusiveSettlement !== undefined) exclusiveSettlements.current.delete(exclusiveSettlement);
      }
    },
    [dispatch],
  );

  useEffect(() => {
    const unsubscribe = client.subscribe((event) => dispatch({ type: "snapshot.received", snapshot: event.snapshot }));
    if (!bootstrapStarted.current) {
      bootstrapStarted.current = true;
      void run("bootstrap", false, () => client.bootstrap());
    }
    return unsubscribe;
  }, [client, dispatch, run]);

  useEffect(() => {
    const active = new Set(state.toasts.map(({ id }) => id));
    for (const [id, timer] of toastTimers.current) {
      if (active.has(id)) continue;
      window.clearTimeout(timer);
      toastTimers.current.delete(id);
    }
    for (const toast of state.toasts) {
      if (toastTimers.current.has(toast.id)) continue;
      const timer = window.setTimeout(() => {
        toastTimers.current.delete(toast.id);
        dispatch({ type: "toast.dismissed", id: toast.id });
      }, 4_000);
      toastTimers.current.set(toast.id, timer);
    }
  }, [dispatch, state.toasts]);

  useEffect(
    () => () => {
      for (const timer of toastTimers.current.values()) window.clearTimeout(timer);
      toastTimers.current.clear();
    },
    [],
  );

  const view = selectCurrentView(state);
  const selectedThreadId = view.thread?.id;
  const draftContent = selectDraftContent(state, selectedThreadId);
  const anyMutation = state.exclusiveMutation !== undefined;
  const draftTimers = useRef(new Map<string, number>());
  const draftJobs = useRef(new Map<string, { readonly editVersion: number; readonly promise: Promise<boolean> }>());
  const draftQueue = useRef<Promise<void>>(Promise.resolve());
  const previousSelection = useRef<{
    projectId: string | undefined;
    threadId: string | undefined;
  }>({ projectId: undefined, threadId: undefined });

  const saveDraftCandidate = useCallback(
    async (candidate: DraftSaveCandidate): Promise<boolean> => {
      const latest = selectDraftSaveCandidates(stateRef.current).find(
        ({ threadId }) => threadId === candidate.threadId,
      );
      if (latest === undefined) return true;
      let submittedGeneration = 0;
      const response = await run(
        "draft.save",
        true,
        () => client.saveDraft(latest.projectId, latest.threadId, latest.content),
        {
          onGeneration: (generation) => {
            submittedGeneration = generation;
            dispatch({
              type: "draft.submitted",
              threadId: latest.threadId,
              requestKey: "draft.save",
              generation,
            });
          },
        },
      );
      if (submittedGeneration === 0) return false;
      if (response?.ok) {
        dispatch({
          type: "draft.acknowledged",
          threadId: latest.threadId,
          requestKey: "draft.save",
          generation: submittedGeneration,
          clear: false,
        });
        dispatch({
          type: "toast.added",
          id: `draft-saved-${latest.threadId}-${submittedGeneration}`,
          message: "Draft saved locally",
          tone: "success",
        });
        return true;
      }
      dispatch({
        type: "draft.failed",
        threadId: latest.threadId,
        requestKey: "draft.save",
        generation: submittedGeneration,
      });
      return false;
    },
    [client, dispatch, run],
  );

  const enqueueDraft = useCallback(
    (candidate: DraftSaveCandidate): Promise<boolean> => {
      const existing = draftJobs.current.get(candidate.threadId);
      if (existing?.editVersion === candidate.editVersion) return existing.promise;
      let resolveJob!: (saved: boolean) => void;
      const promise = new Promise<boolean>((resolve) => {
        resolveJob = resolve;
      });
      const job = { editVersion: candidate.editVersion, promise };
      draftJobs.current.set(candidate.threadId, job);
      draftQueue.current = draftQueue.current
        .catch(() => undefined)
        .then(async () => {
          const saved = await saveDraftCandidate(candidate);
          if (draftJobs.current.get(candidate.threadId) === job) draftJobs.current.delete(candidate.threadId);
          resolveJob(saved);
        });
      return promise;
    },
    [saveDraftCandidate],
  );

  const flushDraft = useCallback(
    async (threadId: string): Promise<boolean> => {
      const running = draftJobs.current.get(threadId);
      const candidate = selectDraftSaveCandidates(stateRef.current).find((item) => item.threadId === threadId);
      const firstJob = running?.promise ?? (candidate === undefined ? undefined : enqueueDraft(candidate));
      const timer = draftTimers.current.get(threadId);
      if (timer !== undefined) {
        window.clearTimeout(timer);
        draftTimers.current.delete(threadId);
      }
      if (firstJob === undefined) return true;
      let saved = await firstJob;
      const newer = selectDraftSaveCandidates(stateRef.current).find((item) => item.threadId === threadId);
      if (newer !== undefined) saved = await enqueueDraft(newer);
      return saved;
    },
    [enqueueDraft],
  );

  const flushAllDraftsForClose = useCallback(async (): Promise<boolean> => {
    if (closeFlushActive.current) return false;
    closeFlushActive.current = true;
    try {
      for (const timer of draftTimers.current.values()) window.clearTimeout(timer);
      draftTimers.current.clear();
      while (exclusiveSettlements.current.size > 0) {
        await Promise.allSettled([...exclusiveSettlements.current]);
      }
      for (const blocked of selectBlockedDraftSaveCandidates(stateRef.current)) {
        dispatch({ type: "draft.retry", threadId: blocked.threadId });
      }
      for (const candidate of selectDirtyDraftSaveCandidates(stateRef.current)) {
        if (!(await flushDraft(candidate.threadId))) return false;
      }
      await draftQueue.current.catch(() => undefined);
      return selectDirtyDraftSaveCandidates(stateRef.current).length === 0;
    } finally {
      closeFlushActive.current = false;
    }
  }, [dispatch, flushDraft]);

  useEffect(() => api.onCloseRequest(flushAllDraftsForClose), [api, flushAllDraftsForClose]);

  useEffect(
    () =>
      api.onCloseBlocked((reason) => {
        nextCloseFeedbackId.current += 1;
        dispatch({
          type: "toast.added",
          id: `close-blocked-${nextCloseFeedbackId.current}`,
          message:
            reason === "save-failed"
              ? "RbxForge stayed open because a local draft could not be saved."
              : "RbxForge stayed open because draft saving did not finish in time.",
          tone: "error",
        });
      }),
    [api, dispatch],
  );

  useEffect(() => {
    const current = { projectId: view.project?.id, threadId: selectedThreadId };
    const previous = previousSelection.current;
    previousSelection.current = current;
    if (
      previous.threadId !== undefined &&
      (previous.projectId !== current.projectId || previous.threadId !== current.threadId)
    ) {
      void flushDraft(previous.threadId);
    }
  }, [flushDraft, selectedThreadId, view.project?.id]);

  useEffect(() => {
    const candidates = selectDraftSaveCandidates(state);
    const candidateIds = new Set(candidates.map(({ threadId }) => threadId));
    for (const [threadId, timer] of draftTimers.current) {
      if (candidateIds.has(threadId)) continue;
      window.clearTimeout(timer);
      draftTimers.current.delete(threadId);
    }
    for (const candidate of candidates) {
      if (draftTimers.current.has(candidate.threadId) || draftJobs.current.has(candidate.threadId)) continue;
      const timer = window.setTimeout(() => {
        draftTimers.current.delete(candidate.threadId);
        void flushDraft(candidate.threadId);
      }, 500);
      draftTimers.current.set(candidate.threadId, timer);
    }
  }, [flushDraft, state]);

  useEffect(() => {
    const timers = draftTimers.current;
    const flushAll = () => {
      const candidates = selectDraftSaveCandidates(stateRef.current);
      for (const candidate of candidates) void flushDraft(candidate.threadId);
    };
    window.addEventListener("beforeunload", flushAll);
    return () => {
      flushAll();
      window.removeEventListener("beforeunload", flushAll);
      for (const timer of timers.values()) window.clearTimeout(timer);
      timers.clear();
    };
  }, [flushDraft]);

  const addProject = () => {
    void run("project.add", true, () => client.addProject());
  };
  const dismissCandidates = () => {
    const candidates = stateRef.current.projectCandidates;
    if (candidates === undefined) return;
    dispatch({ type: "project.candidates.dismissed", selectionId: candidates.selectionId });
    if (cancelCandidateRef.current?.selectionId !== candidates.selectionId) {
      cancelCandidateRef.current = {
        selectionId: candidates.selectionId,
        run: client.cancelProjectAdd(candidates.selectionId),
      };
    }
    void run("project.cancelAdd", false, cancelCandidateRef.current.run);
  };
  const chooseCandidate = (selectionId: string, candidateId: string) => {
    dispatch({ type: "project.candidates.dismissed", selectionId });
    void run("project.addCandidate", true, () => client.addProjectCandidate(selectionId, candidateId));
  };
  const selectProject = async (projectId: string) => {
    const outgoing = selectCurrentView(stateRef.current).thread?.id;
    if (outgoing !== undefined) await flushDraft(outgoing);
    const response = await run("project.select", true, () => client.selectProject(projectId));
    return response?.ok === true;
  };
  const createThread = async (projectId: string) => {
    const response = await run("thread.create", true, () => client.createThread(projectId));
    return response?.ok === true;
  };
  const selectThread = async (projectId: string, threadId: string) => {
    const outgoing = selectCurrentView(stateRef.current).thread?.id;
    if (outgoing !== undefined && outgoing !== threadId) await flushDraft(outgoing);
    const response = await run("thread.select", true, () => client.selectThread(projectId, threadId));
    if (response?.ok) dispatch({ type: "thread.focused", threadId });
    return response?.ok === true;
  };
  const renameThread = async (projectId: string, threadId: string, title: string) => {
    const response = await run("thread.rename", true, () => client.renameThread(projectId, threadId, title));
    if (response?.ok) {
      dispatch({
        type: "toast.added",
        id: `thread-renamed-${response.snapshot.revision}`,
        message: "Conversation renamed",
        tone: "success",
      });
    }
    return response?.ok === true;
  };
  const deleteThread = async (projectId: string, threadId: string) => {
    const response = await run("thread.delete", true, () => client.deleteThread(projectId, threadId));
    return response?.ok === true;
  };
  const removeProject = async (projectId: string) => {
    const response = await run("project.remove", true, () => client.removeProject(projectId));
    return response?.ok === true;
  };
  const commitSidebarWidth = async (width: number) => {
    let generation = 0;
    const response = await run("ui.sidebarWidth", true, () => client.setSidebarWidth(width), {
      onGeneration: (nextGeneration) => {
        generation = nextGeneration;
        dispatch({ type: "sidebar.width.commitStarted", generation: nextGeneration, width });
      },
    });
    if (generation !== 0) {
      dispatch({
        type: "sidebar.width.commitCompleted",
        generation,
        ok: response?.ok === true,
      });
    }
    return response?.ok === true;
  };
  const savePrompt = () => {
    if (view.project === undefined || view.thread === undefined) return;
    const projectId = view.project.id;
    const threadId = view.thread.id;
    const content = selectDraftContent(stateRef.current, threadId);
    if (content.trim().length === 0 || content.length > 100_000 || stateRef.current.exclusiveMutation !== undefined) {
      return;
    }
    let submittedGeneration = 0;
    void run("message.create", true, () => client.createMessage(projectId, threadId, content), {
      onGeneration: (generation) => {
        submittedGeneration = generation;
        dispatch({
          type: "draft.submitted",
          threadId,
          requestKey: "message.create",
          generation,
        });
      },
    }).then((response) => {
      if (submittedGeneration === 0) return;
      if (response?.ok) {
        dispatch({
          type: "draft.acknowledged",
          threadId,
          requestKey: "message.create",
          generation: submittedGeneration,
          clear: true,
        });
        if (selectBlockedDraftSaveCandidates(stateRef.current).length === 0) {
          dispatch({ type: "request.errorCleared", key: "draft.save" });
        }
        dispatch({
          type: "toast.added",
          id: `prompt-saved-${threadId}-${submittedGeneration}`,
          message: "Prompt saved locally",
          tone: "success",
        });
      } else {
        dispatch({
          type: "draft.failed",
          threadId,
          requestKey: "message.create",
          generation: submittedGeneration,
        });
      }
    });
  };

  const connectRuntime = async (flow: ConnectionFlowIdentity) => {
    const latest = stateRef.current.snapshot?.runtimeByProject[flow.projectId];
    if (latest === undefined || !runtimeCanStart(latest.state)) return;
    await run("runtime.connect", true, () => client.connectRuntime(flow.projectId), {
      connectionFlow: flow,
      clearConnectionErrorsOnSuccess: true,
    });
  };
  const inspectBeforeConnect = async (flow: ConnectionFlowIdentity) => {
    const inspectionGeneration = ++connectionInspectionGeneration.current;
    const response = await run("plugin.inspect", false, () => client.inspectPlugin(), {
      connectionFlow: flow,
      clearConnectionErrorsOnSuccess: true,
    });
    if (
      !sameConnectionFlow(connectionFlowRef.current, flow) ||
      connectionInspectionGeneration.current !== inspectionGeneration ||
      !response?.ok ||
      response.result.kind !== "plugin-inspection" ||
      response.result.inspection.state !== "installed" ||
      response.result.inspection.restartRequired ||
      stateRef.current.studioRestartRecommended
    ) {
      return;
    }
    await connectRuntime(flow);
  };
  const acknowledgeStudioRestart = (flow: ConnectionFlowIdentity) => {
    if (!sameConnectionFlow(connectionFlowRef.current, flow)) return;
    dispatch({ type: "studio.restartAcknowledged" });
    void inspectBeforeConnect(flow);
  };
  const openConnection = (projectId: string) => {
    const previous = connectionFlowRef.current;
    if (previous !== undefined) {
      dispatch({ type: "connection.errorsCleared", connectionFlow: previous });
    }
    const next = { projectId, flowId: ++nextConnectionFlowId.current };
    connectionFlowRef.current = next;
    setConnectionFlow(next);
    void inspectBeforeConnect(next);
  };
  const dismissConnection = () => {
    const dismissed = connectionFlowRef.current;
    if (dismissed !== undefined) {
      dispatch({ type: "connection.errorsCleared", connectionFlow: dismissed });
    }
    connectionFlowRef.current = undefined;
    connectionInspectionGeneration.current += 1;
    setConnectionFlow(undefined);
  };
  const chooseRojo = async (flow: ConnectionFlowIdentity) => {
    const response = await run("settings.chooseRojo", true, () => client.chooseRojo(), {
      connectionFlow: flow,
    });
    if (response?.ok && response.result.kind === "rojo-choice" && response.result.changed) {
      dispatch({ type: "connection.errorsCleared", connectionFlow: flow });
      if (
        sameConnectionFlow(connectionFlowRef.current, flow) &&
        runtimeCanStart(stateRef.current.snapshot?.runtimeByProject[flow.projectId]?.state)
      ) {
        await connectRuntime(flow);
      }
    }
  };

  useEffect(() => {
    const active = connectionFlowRef.current;
    if (active === undefined || view.project?.id === active.projectId) return;
    dispatch({ type: "connection.errorsCleared", connectionFlow: active });
    connectionFlowRef.current = undefined;
    connectionInspectionGeneration.current += 1;
    setConnectionFlow(undefined);
  }, [dispatch, view.project?.id]);

  const failedDrafts = selectBlockedDraftSaveCandidates(state);
  const failedDraft = failedDrafts.find(({ threadId }) => threadId === selectedThreadId) ?? failedDrafts.at(0);
  const errorKey = state.lastErrorKey ?? (failedDraft === undefined ? undefined : "draft.save");
  const mainErrorKey = errorKey !== undefined && CONNECTION_REQUEST_KEYS.has(errorKey) ? undefined : errorKey;
  const visibleError =
    mainErrorKey === "draft.save" && failedDraft !== undefined
      ? failedDraft.error
      : mainErrorKey === undefined
        ? undefined
        : state.requests[mainErrorKey]?.error;
  const dismissVisibleError = () => {
    if (mainErrorKey !== undefined) dispatch({ type: "request.errorCleared", key: mainErrorKey });
  };
  const retryVisibleError = () => {
    if (visibleError?.recovery.action !== "retry" || mainErrorKey === undefined) return;
    if (mainErrorKey === "bootstrap") {
      void run("bootstrap", false, () => client.bootstrap());
      return;
    }
    if (mainErrorKey === "draft.save") {
      const currentFailure = selectBlockedDraftSaveCandidates(stateRef.current).find(
        ({ threadId }) => threadId === failedDraft?.threadId,
      );
      if (currentFailure === undefined) return;
      dispatch({ type: "draft.retry", threadId: currentFailure.threadId });
      void flushDraft(currentFailure.threadId);
      return;
    }
    if (mainErrorKey === "message.create") {
      savePrompt();
      return;
    }
    if (mainErrorKey === "ui.sidebarWidth" && stateRef.current.failedSidebarWidth !== undefined) {
      const attemptedWidth = stateRef.current.failedSidebarWidth;
      dispatch({ type: "sidebar.width.changed", width: attemptedWidth });
      void commitSidebarWidth(attemptedWidth);
    }
  };
  const canRetryVisibleError =
    visibleError?.recovery.action === "retry" &&
    (mainErrorKey === "bootstrap" ||
      mainErrorKey === "draft.save" ||
      mainErrorKey === "message.create" ||
      mainErrorKey === "ui.sidebarWidth");

  const selectedRuntime = view.project === undefined ? undefined : state.snapshot?.runtimeByProject[view.project.id];
  const connectionProject =
    connectionFlow === undefined
      ? undefined
      : state.snapshot?.projects.find(({ id }) => id === connectionFlow.projectId);
  const connectionRuntime =
    connectionProject === undefined ? undefined : state.snapshot?.runtimeByProject[connectionProject.id];
  const connectionError =
    connectionRuntime?.state === "studio-bound"
      ? connectionRuntime.error
      : connectionRequestError(state, connectionFlow, connectionRuntime?.error);
  const connectionBusy = connectionBusyState(state, anyMutation);

  const sidebar =
    state.status === "loading" && state.snapshot === undefined ? (
      <ProjectSidebarLoading sidebarWidth={state.sidebarWidth} />
    ) : (
      <ProjectSidebar
        disabled={anyMutation}
        onAddProject={addProject}
        onCreateThread={createThread}
        onDeleteThread={deleteThread}
        onRemoveProject={removeProject}
        onRenameThread={renameThread}
        onSelectProject={selectProject}
        onSelectThread={selectThread}
        onSidebarWidthChange={(width) => dispatch({ type: "sidebar.width.changed", width })}
        onSidebarWidthCommit={commitSidebarWidth}
        projects={state.snapshot?.projects ?? []}
        selectedProjectId={view.project?.id}
        selectedThreadId={selectedThreadId}
        sidebarWidth={state.sidebarWidth}
        threads={state.snapshot?.threads ?? []}
      />
    );

  return (
    <>
      <AppShell
        header={
          view.project !== undefined && selectedRuntime !== undefined ? (
            <ProjectHeader
              connecting={state.requests["runtime.connect"]?.inFlight === true}
              onOpenConnection={() => openConnection(view.project!.id)}
              project={view.project}
              runtime={selectedRuntime}
            />
          ) : (
            <LocalProjectHeader projectName={view.project?.displayName} />
          )
        }
        main={
          <MainContent
            anyMutation={anyMutation}
            draftContent={draftContent}
            error={visibleError}
            messages={state.snapshot?.messages ?? []}
            onAddProject={addProject}
            onCreateThread={() => view.project && void createThread(view.project.id)}
            onDraftChange={(content) =>
              view.thread && dispatch({ type: "draft.changed", threadId: view.thread.id, content })
            }
            onDraftFlush={(relatedTarget) => {
              if (selectedThreadId !== undefined && !isInternalInteractiveTarget(relatedTarget)) {
                void flushDraft(selectedThreadId);
              }
            }}
            onErrorDismiss={dismissVisibleError}
            onErrorRetry={canRetryVisibleError ? retryVisibleError : undefined}
            onSavePrompt={savePrompt}
            projectExists={view.project !== undefined}
            status={state.status}
            threadId={selectedThreadId}
          />
        }
        sidebar={sidebar}
        sidebarWidth={state.sidebarWidth}
      />
      {connectionFlow === undefined ||
      connectionProject === undefined ||
      connectionRuntime === undefined ||
      state.snapshot === undefined ? null : (
        <ConnectionSheet
          actions={connectionActions({
            client,
            connectionFlow,
            run,
            onChooseRojo: () => void chooseRojo(connectionFlow),
            onReconnect: () => void inspectBeforeConnect(connectionFlow),
            onStudioRestarted: () => acknowledgeStudioRestart(connectionFlow),
          })}
          busy={connectionBusy}
          {...(connectionError === undefined ? {} : { error: connectionError })}
          mcpPortChangeAllowed={state.snapshot.settings.mcpPortChangeAllowed}
          onDismiss={dismissConnection}
          open
          pluginInspection={state.pluginInspection}
          preferredMcpPort={state.snapshot.settings.preferredMcpPort}
          project={connectionProject}
          restartRecommended={state.studioRestartRecommended}
          runtime={connectionRuntime}
        />
      )}
      <Dialog
        description="Choose the Rojo project configuration to add."
        onDismiss={dismissCandidates}
        open={state.projectCandidates !== undefined}
        title="Choose project configuration"
      >
        <div className={styles.candidateList}>
          {state.projectCandidates?.candidates.map((candidate) => (
            <button
              className={styles.candidate}
              key={candidate.candidateId}
              onClick={() => chooseCandidate(state.projectCandidates!.selectionId, candidate.candidateId)}
              type="button"
            >
              <span className={styles.candidateName}>{candidate.displayName}</span>
              <span className={styles.candidatePath}>{candidate.relativeProjectFile}</span>
            </button>
          ))}
        </div>
        <div className={styles.candidateActions}>
          <Button onClick={dismissCandidates} variant="quiet">
            Cancel project selection
          </Button>
        </div>
      </Dialog>
      <ToastRegion onDismiss={(id) => dispatch({ type: "toast.dismissed", id })} toasts={state.toasts} />
    </>
  );
}

const INTERNAL_INTERACTIVE_SELECTOR =
  "a[href], area[href], button, input, select, textarea, summary, [contenteditable]:not([contenteditable='false']), [tabindex]";

function isInternalInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const interactive = target.closest(INTERNAL_INTERACTIVE_SELECTOR);
  return (
    interactive !== null &&
    interactive.ownerDocument === document &&
    interactive.isConnected &&
    document.documentElement.contains(interactive)
  );
}

interface RunOptions {
  readonly onGeneration?: (generation: number) => void;
  readonly connectionFlow?: ConnectionFlowIdentity;
  readonly clearConnectionErrorsOnSuccess?: boolean;
}

type ConnectionRun = (
  key: RequestKey,
  exclusive: boolean,
  request: () => Promise<DesktopResponse>,
  options?: RunOptions,
) => Promise<DesktopResponse | undefined>;

function connectionActions(options: {
  readonly client: DesktopClient;
  readonly connectionFlow: ConnectionFlowIdentity;
  readonly onChooseRojo: () => void;
  readonly onReconnect: () => void;
  readonly onStudioRestarted: () => void;
  readonly run: ConnectionRun;
}): ConnectionSheetActions {
  const { client, connectionFlow, run } = options;
  const { projectId } = connectionFlow;
  const recoveryOptions = { connectionFlow, clearConnectionErrorsOnSuccess: true } as const;
  return {
    acknowledgeStudioRestart: options.onStudioRestarted,
    chooseRojo: options.onChooseRojo,
    confirmRojoHandoff: async (input) =>
      (
        await run(
          "runtime.confirmRojoHandoff",
          true,
          () => client.confirmRojoHandoff(projectId, input.bindingRevision),
          recoveryOptions,
        )
      )?.ok === true,
    copyMcpUrl: () => {
      void run("runtime.copyMcpUrl", false, () => client.copyMcpUrl(projectId), { connectionFlow });
    },
    copyProjectFile: () => {
      void run("project.copyFile", false, () => client.copyProjectFile(projectId), { connectionFlow });
    },
    copyRojoAddress: () => {
      void run("runtime.copyRojoAddress", false, () => client.copyRojoAddress(projectId), { connectionFlow });
    },
    disconnect: () => {
      void run("runtime.disconnect", true, () => client.disconnectRuntime(projectId), recoveryOptions);
    },
    inspectPlugin: () => {
      void run("plugin.inspect", false, () => client.inspectPlugin(), recoveryOptions);
    },
    installPlugin: (confirmReplace) => {
      void run("plugin.install", true, () => client.installPlugin(confirmReplace), recoveryOptions);
    },
    reconnect: options.onReconnect,
    refreshCatalog: () => {
      void run("runtime.refresh", true, () => client.refreshRuntime(projectId), recoveryOptions);
    },
    saveMcpPort: (port) => {
      void run("settings.mcpPort", true, () => client.setMcpPort(port), recoveryOptions);
    },
    selectStudio: async (input) =>
      (
        await run(
          "runtime.selectStudio",
          true,
          () => client.selectStudio(projectId, input.instanceId, input.catalogRevision, input.warningAccepted),
          recoveryOptions,
        )
      )?.ok === true,
    showPluginFolder: () => {
      void run("plugin.showFolder", false, () => client.showPluginFolder(), { connectionFlow });
    },
  };
}

function runtimeCanStart(state: ProjectRuntimeState | undefined): boolean {
  return state === "disconnected" || state === "needs-reconnect" || state === "error";
}

const CONNECTION_REQUEST_KEYS = new Set<RequestKey>([
  "project.copyFile",
  "runtime.connect",
  "runtime.selectStudio",
  "runtime.confirmRojoHandoff",
  "runtime.disconnect",
  "runtime.refresh",
  "runtime.copyMcpUrl",
  "runtime.copyRojoAddress",
  "plugin.inspect",
  "plugin.install",
  "plugin.showFolder",
  "settings.chooseRojo",
  "settings.mcpPort",
]);

function connectionRequestError(
  state: AppState,
  connectionFlow: ConnectionFlowIdentity | undefined,
  fallback: DesktopError | undefined,
): DesktopError | undefined {
  const key = state.lastErrorKey;
  if (key === undefined || !CONNECTION_REQUEST_KEYS.has(key)) return fallback;
  const request = state.requests[key];
  return request?.error !== undefined && sameConnectionFlow(request.connectionFlow, connectionFlow)
    ? request.error
    : fallback;
}

function connectionBusyState(
  state: AppState,
  anyMutation: boolean,
): Readonly<Partial<Record<ConnectionOperation, boolean>>> {
  const inFlight = (key: RequestKey) => state.requests[key]?.inFlight === true;
  return {
    acknowledgeStudioRestart: anyMutation || inFlight("plugin.inspect") || inFlight("runtime.connect"),
    chooseRojo: anyMutation || inFlight("settings.chooseRojo"),
    confirmRojoHandoff: anyMutation || inFlight("runtime.confirmRojoHandoff"),
    copyMcpUrl: inFlight("runtime.copyMcpUrl"),
    copyProjectFile: inFlight("project.copyFile"),
    copyRojoAddress: inFlight("runtime.copyRojoAddress"),
    disconnect: anyMutation || inFlight("runtime.disconnect"),
    inspectPlugin: anyMutation || inFlight("plugin.inspect"),
    installPlugin: anyMutation || inFlight("plugin.install"),
    reconnect: anyMutation || inFlight("plugin.inspect") || inFlight("runtime.connect"),
    refreshCatalog: anyMutation || inFlight("runtime.refresh"),
    saveMcpPort: anyMutation || inFlight("settings.mcpPort"),
    selectStudio: anyMutation || inFlight("runtime.selectStudio"),
    showPluginFolder: inFlight("plugin.showFolder"),
  };
}

function LocalProjectHeader({ projectName }: { readonly projectName: string | undefined }) {
  return (
    <div className={styles.headerContent}>
      <div className={styles.projectIdentity}>
        <span className={styles.projectName}>{projectName ?? "RbxForge"}</span>
        <span className={styles.projectMeta}>{projectName ? "Local project conversations" : "Local workspace"}</span>
      </div>
    </div>
  );
}

function MainContent({
  anyMutation,
  draftContent,
  error,
  messages,
  onAddProject,
  onCreateThread,
  onDraftChange,
  onDraftFlush,
  onErrorDismiss,
  onErrorRetry,
  onSavePrompt,
  projectExists,
  status,
  threadId,
}: {
  readonly anyMutation: boolean;
  readonly draftContent: string;
  readonly error: DesktopError | undefined;
  readonly messages: Parameters<typeof ChatTimeline>[0]["messages"];
  readonly onAddProject: () => void;
  readonly onCreateThread: () => void;
  readonly onDraftChange: (content: string) => void;
  readonly onDraftFlush: (relatedTarget: EventTarget | null) => void;
  readonly onErrorDismiss: () => void;
  readonly onErrorRetry: (() => void) | undefined;
  readonly onSavePrompt: () => void;
  readonly projectExists: boolean;
  readonly status: "loading" | "ready" | "error";
  readonly threadId: string | undefined;
}) {
  if (status === "loading") {
    return (
      <>
        <div className={styles.loadingTimeline}>
          <Skeleton variant="message-line" />
          <Skeleton variant="message-line" />
        </div>
        <div className={styles.loadingComposer} />
      </>
    );
  }
  if (status === "error" && error !== undefined) {
    return (
      <div className={styles.errorState}>
        <h2>RbxForge could not load local data</h2>
        <InlineError
          error={error}
          onDismiss={onErrorDismiss}
          {...(onErrorRetry === undefined ? {} : { onRecovery: onErrorRetry })}
        />
      </div>
    );
  }
  const inlineError =
    error === undefined ? null : (
      <InlineError
        error={error}
        onDismiss={onErrorDismiss}
        {...(onErrorRetry === undefined ? {} : { onRecovery: onErrorRetry })}
      />
    );
  if (!projectExists) {
    return (
      <div className={styles.mainState}>
        <div className={styles.stateStack}>
          {inlineError}
          <section className={styles.onboardingState} data-onboarding-state="true">
            <img
              alt=""
              aria-hidden="true"
              className={styles.onboardingMark}
              data-testid="onboarding-mark"
              draggable="false"
              src={markUrl}
            />
            <h2>Build locally with RbxForge</h2>
            <p>Add a Roblox project, save prompts locally, then connect Studio when you are ready.</p>
            <Button onClick={onAddProject}>Add project</Button>
          </section>
        </div>
      </div>
    );
  }
  if (threadId === undefined) {
    return (
      <div className={styles.mainState}>
        <div className={styles.stateStack}>
          {inlineError}
          <EmptyState action={<Button onClick={onCreateThread}>New chat</Button>} title="No conversation selected">
            Create a local conversation for this project.
          </EmptyState>
        </div>
      </div>
    );
  }
  return (
    <>
      <ChatTimeline messages={messages} threadId={threadId} />
      <div className={styles.composerStack}>
        {inlineError}
        <ChatComposer
          content={draftContent}
          onBlur={onDraftFlush}
          onChange={onDraftChange}
          onSave={onSavePrompt}
          submitDisabled={anyMutation}
        />
      </div>
    </>
  );
}
