import "./styles.css";

import { createElement } from "react";
import { createRoot } from "react-dom/client";

import { ConnectionCenter } from "./connection/ConnectionCenter.js";
import { AgentView } from "./agent/AgentView.js";
import { ActivityView } from "./activity/ActivityView.js";
import { PlaytestView } from "./playtest/PlaytestView.js";
import {
  PROTOCOL_VERSION,
  parseHostMessage,
  parsePersistedUiState,
  type ConnectionAction,
  type HostMessage,
  type PersistedUiState,
  type ActivityEntryMessage,
  type AgentApprovalMessage,
  type AgentSnapshotMessage,
  type AgentToolCardMessage,
  type PlaytestSnapshotMessage,
  type PropertiesSnapshot,
  type PropertyProposal,
  type ViewportCaptureMessage,
  type WebviewMessage,
} from "./protocol.js";
import { PropertiesView } from "./properties/PropertiesView.js";
import { ViewportView } from "./viewport/ViewportView.js";

export * from "./agent/AgentView.js";
export * from "./activity/ActivityView.js";
export * from "./connection/ConnectionCenter.js";
export * from "./playtest/PlaytestView.js";
export * from "./protocol.js";
export * from "./properties/PropertiesView.js";
export * from "./properties/property-codecs.js";
export * from "./viewport/ViewportView.js";

export interface VsCodeWebviewApi {
  postMessage(message: WebviewMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
}

type WebviewRequest = WebviewMessage extends infer Message
  ? Message extends WebviewMessage
    ? Omit<Message, "v" | "sessionId" | "requestId" | "generation">
    : never
  : never;

export function mountWebview(
  element: Element,
  api: VsCodeWebviewApi,
  eventTarget: Window,
  reload: () => void = () => eventTarget.location.reload(),
): () => void {
  const root = createRoot(element);
  let active:
    | {
        readonly sessionId: string;
        readonly generation: number;
        readonly view: "connection" | "properties" | "playtest" | "activity" | "viewport" | "agent";
      }
    | undefined;
  let sequence = 0;
  let persistedState: PersistedUiState = {};
  let propertiesSnapshot: PropertiesSnapshot | undefined;
  let playtestSnapshot: PlaytestSnapshotMessage | undefined;
  let activityEntries: readonly ActivityEntryMessage[] = [];
  let viewportCapture: ViewportCaptureMessage | undefined;
  let viewportState: { readonly state: "empty" | "loading" | "error"; readonly detail?: string } = { state: "empty" };
  let agentSnapshot: AgentSnapshotMessage | undefined;
  let agentText = "";
  let agentCards: readonly AgentToolCardMessage[] = [];
  let agentApprovals: readonly AgentApprovalMessage[] = [];
  let agentSequence = 0;
  const seenHostRequestIds = new Set<string>();
  const request = (message: WebviewRequest): void => {
    if (active === undefined) return;
    sequence += 1;
    api.postMessage({
      ...message,
      v: PROTOCOL_VERSION,
      sessionId: active.sessionId,
      requestId: `webview:${sequence}`,
      generation: active.generation,
    } as WebviewMessage);
  };
  const renderReload = (): void => {
    active = undefined;
    root.render(
      createElement(
        "section",
        { className: "notice error-state" },
        createElement("h1", null, "Reload required"),
        createElement("p", null, "The host and webview protocol no longer match."),
        createElement("button", { type: "button", onClick: reload }, "Reload"),
      ),
    );
  };
  const persistQuery = (query: string): void => {
    persistedState = { ...persistedState, query };
    api.setState(persistedState);
  };
  const renderProperties = (): void => {
    root.render(
      createElement(PropertiesView, {
        ...(propertiesSnapshot === undefined ? {} : { snapshot: propertiesSnapshot }),
        ...(active === undefined ? {} : { displayGeneration: active.generation }),
        ...(persistedState.query === undefined ? {} : { initialQuery: persistedState.query }),
        onQueryChange: persistQuery,
        onPropose: (proposal: PropertyProposal) => {
          if (propertiesSnapshot !== undefined) {
            propertiesSnapshot = updateProperty(propertiesSnapshot, proposal.propertyName, {
              mutationState: "approval-pending",
            });
            renderProperties();
          }
          request({ type: "proposePropertyMutation", proposal });
        },
        onOpenDefiningFile: (instancePath: string) => request({ type: "openDefiningFile", instancePath }),
      }),
    );
  };
  const renderPlaytest = (): void => {
    root.render(
      createElement(PlaytestView, {
        ...(playtestSnapshot === undefined ? {} : { snapshot: playtestSnapshot }),
        onStart: (mode: "play" | "run") => request({ type: "startPlaytest", mode }),
        onStop: () => request({ type: "stopPlaytest" }),
        onRefresh: () => request({ type: "refreshPlaytest" }),
        onPollLogs: (filter?: string) =>
          request({
            type: "pollRuntimeLogs",
            ...(playtestSnapshot?.cursor === undefined ? {} : { cursor: playtestSnapshot.cursor }),
            ...(filter === undefined ? {} : { filter }),
          }),
      }),
    );
  };
  const renderActivity = (): void => {
    root.render(
      createElement(ActivityView, {
        entries: activityEntries,
        onOpenSource: (entryId: string) => request({ type: "openActivitySource", entryId }),
      }),
    );
  };
  const renderViewport = (): void => {
    root.render(
      createElement(ViewportView, {
        ...(viewportCapture === undefined ? {} : { capture: viewportCapture }),
        state: viewportState.state,
        ...(viewportState.detail === undefined ? {} : { detail: viewportState.detail }),
        onCapture: () => request({ type: "captureViewport" }),
      }),
    );
  };
  const renderAgent = (): void => {
    root.render(
      createElement(AgentView, {
        ...(agentSnapshot === undefined ? {} : { snapshot: agentSnapshot }),
        text: agentText,
        cards: agentCards,
        approvals: agentApprovals,
        ...(persistedState.agentMode === undefined ? {} : { initialMode: persistedState.agentMode }),
        onModeChange: (mode: "ask" | "build" | "debug") => {
          persistedState = { ...persistedState, agentMode: mode };
          api.setState(persistedState);
        },
        onStart: (mode: "ask" | "build" | "debug", prompt: string, chipIds: readonly string[]) => {
          request({ type: "startAgentRun", mode, prompt, chipIds: [...chipIds] });
        },
        onStop: (runId: string) => request({ type: "stopAgentRun", runId }),
        onRetry: (previousRunId: string) => request({ type: "retryAgentRun", previousRunId }),
        onRemoveChip: (chipId: string) => request({ type: "removeAgentContext", chipId }),
        onDecision: (runId: string, approvalId: string, decision: "approve" | "reject") => {
          agentApprovals = agentApprovals.filter((approval) => approval.approvalId !== approvalId);
          renderAgent();
          request({ type: "resolveAgentApproval", runId, approvalId, decision });
        },
        onOpenDiff: (runId: string, approvalId: string) => request({ type: "openAgentDiff", runId, approvalId }),
      }),
    );
  };
  const renderMessage = (message: HostMessage): void => {
    if (message.type === "init") {
      active = { sessionId: message.sessionId, generation: message.generation, view: message.view };
      propertiesSnapshot = undefined;
      playtestSnapshot = undefined;
      activityEntries = [];
      viewportCapture = undefined;
      viewportState = { state: "empty" };
      agentSnapshot = undefined;
      agentText = "";
      agentCards = [];
      agentApprovals = [];
      agentSequence = 0;
      persistedState = parsePersistedUiState(api.getState());
      api.setState(persistedState);
      api.postMessage({
        v: PROTOCOL_VERSION,
        type: "ready",
        sessionId: message.sessionId,
        requestId: `ready:${message.requestId}`,
        generation: message.generation,
      });
      const loading =
        message.view === "connection"
          ? "Checking connections…"
          : message.view === "properties"
            ? "Loading properties…"
            : message.view === "playtest"
              ? "Loading playtest state…"
              : message.view === "activity"
                ? "Loading activity…"
                : message.view === "viewport"
                  ? "Waiting for viewport capture…"
                  : "Loading Agent…";
      root.render(createElement("p", { className: "notice loading-state" }, loading));
      return;
    }
    if (
      active === undefined ||
      message.sessionId !== active.sessionId ||
      message.generation !== active.generation ||
      message.type === "protocolError"
    ) {
      renderReload();
      return;
    }
    if (message.type === "connectionSnapshot") {
      root.render(
        createElement(ConnectionCenter, {
          snapshot: message.snapshot,
          onAction: (action: ConnectionAction) => request({ type: "runConnectionAction", action }),
          onRefresh: () => request({ type: "refreshConnection" }),
        }),
      );
      return;
    }
    if (message.type === "propertiesSnapshot") {
      propertiesSnapshot = message.snapshot;
      renderProperties();
      return;
    }
    if (message.type === "mutationStatus") {
      if (
        propertiesSnapshot === undefined ||
        message.instanceId !== propertiesSnapshot.instanceId ||
        message.instancePath !== propertiesSnapshot.instancePath ||
        !propertiesSnapshot.properties.some(({ name }) => name === message.propertyName)
      ) {
        renderReload();
        return;
      }
      propertiesSnapshot = updateProperty(
        propertiesSnapshot,
        message.propertyName,
        message.state === "blocked"
          ? {
              editable: false,
              mutationState: "blocked",
              blockedReason: `Blocked: ${message.detail ?? "Mutation rejected"}`,
              ...(message.verification === undefined ? {} : { verification: message.verification }),
            }
          : {
              mutationState: message.state,
              ...(message.state === "complete" ? { editable: false } : {}),
              ...(message.verification === undefined ? {} : { verification: message.verification }),
            },
      );
      renderProperties();
      if (message.state === "complete") request({ type: "refreshProperties" });
      return;
    }
    if (message.type === "playtestSnapshot") {
      playtestSnapshot = message.snapshot;
      renderPlaytest();
      return;
    }
    if (message.type === "activitySnapshot") {
      activityEntries = message.entries;
      renderActivity();
      return;
    }
    if (message.type === "viewportStatus") {
      viewportState = {
        state: message.state,
        ...(message.detail === undefined ? {} : { detail: message.detail }),
      };
      renderViewport();
      return;
    }
    if (message.type === "viewportCapture") {
      viewportCapture = message.capture;
      viewportState = { state: "empty" };
      renderViewport();
      return;
    }
    if (message.type === "viewportStale") {
      if (viewportCapture?.captureId === message.captureId) {
        viewportCapture = { ...viewportCapture, freshness: "stale" };
        renderViewport();
      }
      return;
    }
    if (message.type === "agentSnapshot") {
      if (agentSnapshot?.runId !== message.snapshot.runId) {
        agentText = "";
        agentCards = [];
        agentApprovals = [];
        agentSequence = 0;
      }
      agentSnapshot = message.snapshot;
      renderAgent();
      return;
    }
    if (message.type === "agentTextDelta") {
      if (agentSnapshot?.runId !== message.runId) return;
      if (message.sequence <= agentSequence) return;
      if (message.sequence !== agentSequence + 1) {
        renderReload();
        return;
      }
      agentSequence = message.sequence;
      agentText += message.delta;
      renderAgent();
      return;
    }
    if (message.type === "agentToolCard") {
      if (agentSnapshot?.runId !== message.card.runId) return;
      agentCards = [...agentCards.filter((card) => card.callId !== message.card.callId), message.card];
      renderAgent();
      return;
    }
    if (message.type === "agentApproval") {
      if (agentSnapshot?.runId !== message.approval.runId) return;
      agentApprovals = [
        ...agentApprovals.filter((approval) => approval.approvalId !== message.approval.approvalId),
        message.approval,
      ];
      renderAgent();
      return;
    }
    if (message.type === "agentTerminal") {
      if (agentSnapshot?.runId !== message.runId) return;
      agentApprovals = [];
      agentSnapshot = {
        ...agentSnapshot,
        status: message.state === "completed" ? "completed" : message.state === "stopped" ? "ready" : "error",
        canRetry: true,
        ...(message.message === undefined ? {} : { detail: message.message }),
      };
      renderAgent();
    }
  };
  root.render(createElement("p", { className: "notice loading-state" }, "Waiting for host…"));
  const listener = (event: MessageEvent): void => {
    try {
      const message = parseHostMessage(event.data);
      if (message.type === "init" && active !== undefined) {
        if (message.sessionId !== active.sessionId || message.generation !== active.generation + 1) {
          renderReload();
          return;
        }
        seenHostRequestIds.clear();
      } else if (
        message.type !== "init" &&
        (active === undefined || message.sessionId !== active.sessionId || message.generation !== active.generation)
      ) {
        renderReload();
        return;
      }
      if (seenHostRequestIds.has(message.requestId)) {
        renderReload();
        return;
      }
      seenHostRequestIds.add(message.requestId);
      renderMessage(message);
    } catch {
      renderReload();
    }
  };
  eventTarget.addEventListener("message", listener);
  return () => {
    eventTarget.removeEventListener("message", listener);
    root.unmount();
  };
}

function updateProperty(
  snapshot: PropertiesSnapshot,
  propertyName: string,
  update: Partial<PropertiesSnapshot["properties"][number]>,
): PropertiesSnapshot {
  return {
    ...snapshot,
    properties: snapshot.properties.map((property) =>
      property.name === propertyName ? { ...property, ...update } : property,
    ),
  };
}

interface WebviewGlobal {
  readonly acquireVsCodeApi?: () => VsCodeWebviewApi;
}

const globalWebview = globalThis as typeof globalThis & WebviewGlobal;
const rootElement = typeof document === "undefined" ? null : document.querySelector("#root");
if (rootElement !== null && globalWebview.acquireVsCodeApi !== undefined) {
  mountWebview(rootElement, globalWebview.acquireVsCodeApi(), window);
}
