import type { JSX } from "react";

import type { ConnectionAction, ConnectionSnapshot } from "../protocol.js";

export interface ConnectionCenterProps {
  readonly snapshot?: ConnectionSnapshot;
  readonly error?: string;
  readonly onAction: (action: ConnectionAction) => void;
  readonly onRefresh?: () => void;
}

const actionLabels: Readonly<Record<ConnectionAction, string>> = {
  selectProject: "Select project",
  startRojo: "Start Rojo",
  stopRojo: "Stop Rojo",
  installStudioPlugin: "Install Studio plugin",
  selectStudioInstance: "Select Studio instance",
  refreshStudio: "Refresh Studio",
};

export function ConnectionCenter(props: ConnectionCenterProps): JSX.Element {
  if (props.error !== undefined) {
    return (
      <section className="notice error-state" aria-live="polite">
        <p>{props.error}</p>
        <button type="button" onClick={props.onRefresh}>
          Retry
        </button>
      </section>
    );
  }
  if (props.snapshot === undefined) {
    return <p className="notice loading-state">Checking connections…</p>;
  }
  const ready = props.snapshot.checks.every((check) => !check.required || check.health === "healthy");
  return (
    <section className="connection-center" aria-label="Connection Center">
      <header className="view-header">
        <div>
          <h1>Connection Center</h1>
          <p>{props.snapshot.simulation ? "Simulation" : "Live services"}</p>
        </div>
        <strong className={`aggregate ${ready ? "healthy" : "unhealthy"}`} role="status">
          {ready ? "Ready" : "Not ready"}
        </strong>
      </header>
      <ol className="status-list">
        {props.snapshot.checks.map((check) => (
          <li className={`status-row ${check.health}`} key={check.id}>
            <span className="status-indicator" aria-label={check.health} />
            <span className="status-copy">
              <strong>{check.label}</strong>
              <span>{check.detail}</span>
              <small>Observed {check.observedAt}</small>
            </span>
            {check.action === undefined ? null : (
              <button type="button" onClick={() => props.onAction(check.action!)}>
                {actionLabels[check.action]}
              </button>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
