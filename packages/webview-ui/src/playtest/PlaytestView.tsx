import { useMemo, useState, type JSX } from "react";

import type { PlaytestSnapshotMessage } from "../protocol.js";

export interface PlaytestViewProps {
  readonly snapshot?: PlaytestSnapshotMessage;
  readonly onStart: (mode: "play" | "run") => void;
  readonly onStop: () => void;
  readonly onRefresh: () => void;
  readonly onPollLogs: (filter?: string) => void;
}

export function PlaytestView(props: PlaytestViewProps): JSX.Element {
  const [filter, setFilter] = useState("");
  const rows = useMemo(
    () => props.snapshot?.entries.filter((entry) => entry.message.includes(filter)) ?? [],
    [props.snapshot, filter],
  );
  if (props.snapshot === undefined) return <p className="notice loading-state">Loading playtest state…</p>;
  const snapshot = props.snapshot;
  const lifecycleDisabled = !snapshot.capabilities.lifecycle;
  const canStart = !lifecycleDisabled && snapshot.state === "idle";
  const canStop = !lifecycleDisabled && (snapshot.state === "running" || snapshot.state === "unknown");
  return (
    <section className="playtest-view" aria-label="Playtest">
      <header className="view-header">
        <div>
          <h1>Playtest</h1>
          <p>
            {snapshot.instanceId ?? "No Studio instance"} · {snapshot.state}
          </p>
        </div>
        <strong className={`aggregate ${snapshot.state === "running" ? "healthy" : "unknown"}`} role="status">
          {snapshot.state}
        </strong>
      </header>
      {snapshot.capabilities.reason === undefined ? null : (
        <p className="notice warning-state">{snapshot.capabilities.reason}</p>
      )}
      {snapshot.error === undefined ? null : <p className="notice error-state">{snapshot.error}</p>}
      <div className="toolbar" role="toolbar" aria-label="Playtest controls">
        <button type="button" disabled={!canStart} onClick={() => props.onStart("play")}>
          Play
        </button>
        <button type="button" disabled={!canStart} onClick={() => props.onStart("run")}>
          Run
        </button>
        <button type="button" disabled={!canStop} onClick={props.onStop}>
          Stop
        </button>
        <button type="button" disabled={lifecycleDisabled} onClick={props.onRefresh}>
          Status
        </button>
      </div>
      <dl className="metadata">
        <div>
          <dt>Mode</dt>
          <dd>{snapshot.mode ?? "—"}</dd>
        </div>
        <div>
          <dt>Roles</dt>
          <dd>{snapshot.roles.join(", ") || "None observed"}</dd>
        </div>
        <div>
          <dt>Generation</dt>
          <dd>{snapshot.runtimeGeneration}</dd>
        </div>
      </dl>
      <label className="filter-field">
        <span>Filter runtime logs</span>
        <input
          type="search"
          value={filter}
          onChange={(event) => setFilter(event.currentTarget.value)}
          placeholder="Literal substring"
        />
      </label>
      <button
        type="button"
        disabled={!snapshot.capabilities.logs}
        onClick={() => props.onPollLogs(filter === "" ? undefined : filter)}
      >
        Poll logs
      </button>
      {snapshot.totalDropped > 0 ? (
        <p className="notice warning-state">{snapshot.totalDropped} runtime log rows were dropped.</p>
      ) : null}
      {Object.entries(snapshot.perCaptureErrors).map(([role, error]) => (
        <p className="notice error-state" key={role}>
          {role}: {error}
        </p>
      ))}
      <table className="log-table">
        <thead>
          <tr>
            <th>Time</th>
            <th>Level</th>
            <th>Message</th>
            <th>Capture</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((entry) => (
            <tr key={`${entry.capturedBy ?? "unknown"}:${entry.seq}`} className={`log-${entry.level.toLowerCase()}`}>
              <td>{formatTime(entry.ts)}</td>
              <td>{entry.level}</td>
              <td>{entry.message}</td>
              <td>{entry.capturedBy === undefined ? "capture unknown" : `captured by ${entry.capturedBy}`}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function formatTime(value: number): string {
  const milliseconds = value < 10_000_000_000 ? value * 1_000 : value;
  const date = new Date(milliseconds);
  return Number.isNaN(date.valueOf()) ? String(value) : date.toLocaleTimeString();
}
