import type { JSX } from "react";

import type { ActivityEntryMessage } from "../protocol.js";

export interface ActivityViewProps {
  readonly entries: readonly ActivityEntryMessage[];
  readonly onOpenSource?: (entryId: string) => void;
}

export function ActivityView(props: ActivityViewProps): JSX.Element {
  return (
    <section className="activity-view" aria-label="Activity">
      <header className="view-header">
        <div>
          <h1>Activity</h1>
          <p>Verified operations and runtime events</p>
        </div>
      </header>
      {props.entries.length === 0 ? (
        <p className="notice empty-state">No activity yet</p>
      ) : (
        <ol className="activity-list">
          {[...props.entries].reverse().map((entry) => (
            <li key={entry.id} className={`activity-${entry.result}`}>
              <div>
                <strong>{entry.operation}</strong>
                <span>{entry.result}</span>
              </div>
              <small>
                {entry.timestamp} · {entry.instanceId ?? "No instance"}
              </small>
              {entry.detail === undefined ? null : <p>{entry.detail}</p>}
              {entry.verification === undefined ? null : (
                <span className={`verification ${entry.verification}`}>{capitalize(entry.verification)}</span>
              )}
              {entry.droppedLogs === undefined ? null : <span>{entry.droppedLogs} dropped logs</span>}
              {entry.sourcePath === undefined || props.onOpenSource === undefined ? null : (
                <button type="button" onClick={() => props.onOpenSource?.(entry.id)}>
                  Open source
                </button>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function capitalize(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}
