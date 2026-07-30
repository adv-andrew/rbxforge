import { useEffect, useRef, useState, type KeyboardEvent } from "react";

import type { AgentApprovalMessage, AgentSnapshotMessage, AgentToolCardMessage } from "../protocol.js";

export interface AgentViewProps {
  readonly snapshot?: AgentSnapshotMessage;
  readonly text: string;
  readonly cards: readonly AgentToolCardMessage[];
  readonly approvals: readonly AgentApprovalMessage[];
  readonly initialMode?: "ask" | "build" | "debug";
  readonly onModeChange?: (mode: "ask" | "build" | "debug") => void;
  readonly onStart: (mode: "ask" | "build" | "debug", prompt: string, chipIds: readonly string[]) => void;
  readonly onStop: (runId: string) => void;
  readonly onRetry: (runId: string) => void;
  readonly onRemoveChip: (chipId: string) => void;
  readonly onDecision: (runId: string, approvalId: string, decision: "approve" | "reject") => void;
  readonly onOpenDiff: (runId: string, approvalId: string) => void;
}

export function AgentView(props: AgentViewProps) {
  const [mode, setMode] = useState<"ask" | "build" | "debug">(props.initialMode ?? "ask");
  const [prompt, setPrompt] = useState("");
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const running = props.snapshot?.status === "running" || props.snapshot?.status === "stopping";
  const connected = props.snapshot?.connected ?? false;

  useEffect(() => {
    if (!running) promptRef.current?.focus();
  }, [running]);

  const selectMode = (value: "ask" | "build" | "debug"): void => {
    setMode(value);
    props.onModeChange?.(value);
  };
  const start = (): void => {
    const value = prompt.trim();
    if (!connected || running || value.length === 0) return;
    props.onStart(mode, value, props.snapshot?.chips.map((chip) => chip.id) ?? []);
  };
  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      start();
    }
  };

  if (props.snapshot === undefined) {
    return (
      <section className="agent-view">
        <p className="notice loading-state">Loading Agent…</p>
      </section>
    );
  }

  return (
    <section className="agent-view" aria-label="RbxForge Agent">
      <header className="agent-header">
        <div>
          <h1>Build with Agent</h1>
          <p>Describe the Roblox change. Host policy controls every tool and write.</p>
        </div>
        <span className={`connection-pill ${connected ? "healthy" : "unhealthy"}`}>
          {connected ? "Ready" : "Disconnected"}
        </span>
      </header>

      {props.snapshot.simulation ? (
        <div className="simulation-banner" role="status">
          SIMULATION — fixture results only
        </div>
      ) : null}
      {props.snapshot.status === "stale" ? (
        <p className="notice error-state">Context is stale. Re-select context before running.</p>
      ) : null}
      {props.snapshot.detail !== undefined ? (
        <p className={props.snapshot.status === "error" ? "notice error-state" : "notice"}>{props.snapshot.detail}</p>
      ) : null}

      <div className="agent-modes" role="tablist" aria-label="Agent mode">
        {(["ask", "build", "debug"] as const).map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={mode === value}
            className={mode === value ? "selected" : ""}
            disabled={running}
            onClick={() => selectMode(value)}
          >
            {capitalize(value)}
          </button>
        ))}
      </div>

      <div className="context-chips" aria-label="Selected context">
        {props.snapshot.chips.length === 0 ? (
          <span className="muted">No context selected</span>
        ) : (
          props.snapshot.chips.map((chip) => (
            <span className="context-chip" key={chip.id}>
              <span>{chip.label}</span>
              <small>{chip.kind}</small>
              <button
                type="button"
                aria-label={`Remove ${chip.label}`}
                disabled={running}
                onClick={() => props.onRemoveChip(chip.id)}
              >
                ×
              </button>
            </span>
          ))
        )}
      </div>

      <label className="agent-prompt">
        <span>Prompt</span>
        <textarea
          ref={promptRef}
          value={prompt}
          maxLength={32_768}
          rows={6}
          disabled={!connected || running}
          placeholder={
            mode === "ask"
              ? "Ask about the selected Roblox context…"
              : mode === "build"
                ? "Describe the feature you want built…"
                : "Describe the bug and expected behavior…"
          }
          onChange={(event) => setPrompt(event.currentTarget.value)}
          onKeyDown={keyDown}
        />
      </label>
      <div className="agent-actions">
        <button type="button" disabled={!connected || running || prompt.trim().length === 0} onClick={start}>
          {mode === "ask" ? "Ask Agent" : mode === "build" ? "Build" : "Debug"}
        </button>
        {running && props.snapshot.runId !== undefined ? (
          <button type="button" className="secondary" onClick={() => props.onStop(props.snapshot!.runId!)}>
            Stop
          </button>
        ) : null}
        {!running && props.snapshot.canRetry && props.snapshot.runId !== undefined ? (
          <button type="button" className="secondary" onClick={() => props.onRetry(props.snapshot!.runId!)}>
            Retry
          </button>
        ) : null}
      </div>

      <section className="agent-output" aria-live="polite" aria-label="Agent response">
        {props.text.length === 0 ? <p className="muted">Agent responses will stream here.</p> : <pre>{props.text}</pre>}
      </section>

      {props.cards.length > 0 ? (
        <section className="agent-tools" aria-label="Tool activity">
          <h2>Tool activity</h2>
          {props.cards.map((card) => (
            <article className={`tool-card ${card.state}`} key={`${card.runId}:${card.callId}`}>
              <strong>{readableTool(card.name)}</strong>
              <span>
                {card.access} · {card.state}
              </span>
              {card.code === undefined ? null : <small>{card.code}</small>}
            </article>
          ))}
        </section>
      ) : null}

      {props.approvals.map((approval) => (
        <article className={`approval-card ${approval.kind}`} key={approval.approvalId}>
          <strong>{approval.kind === "filesystem" ? "Filesystem proposal" : "Studio proposal"}</strong>
          <p>{approval.summary}</p>
          {approval.kind !== "studio" || approval.change === undefined ? null : (
            <dl className="approval-change" aria-label="Proposed value change">
              <div>
                <dt>Old</dt>
                <dd>{approval.change.before}</dd>
              </div>
              <div>
                <dt>New</dt>
                <dd>{approval.change.after}</dd>
              </div>
            </dl>
          )}
          <div>
            {approval.kind === "filesystem" ? (
              <button
                type="button"
                className="secondary"
                onClick={() => props.onOpenDiff(approval.runId, approval.approvalId)}
              >
                Open Diff
              </button>
            ) : null}
            <button type="button" onClick={() => props.onDecision(approval.runId, approval.approvalId, "approve")}>
              Approve
            </button>
            <button
              type="button"
              className="danger"
              onClick={() => props.onDecision(approval.runId, approval.approvalId, "reject")}
            >
              Reject
            </button>
          </div>
        </article>
      ))}
    </section>
  );
}

function capitalize(value: string): string {
  return `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`;
}

function readableTool(value: string): string {
  return value.replaceAll("_", " ");
}
