import { Cable, CircleAlert, Server, Unplug } from "lucide-react";

import type { ProjectRecord, ProjectRuntimeState, RuntimeSnapshot } from "../../../shared/domain.js";
import { Button } from "../shared/Button.js";
import { StatusChip, type StatusChipStatus } from "../shared/StatusChip.js";
import styles from "./ProjectHeader.module.css";

export interface ProjectHeaderProps {
  readonly connecting?: boolean;
  readonly onOpenConnection?: () => void;
  readonly project: ProjectRecord;
  readonly runtime: RuntimeSnapshot;
}

interface HeaderState {
  readonly action: "Connect" | "Connecting…" | "Continue setup" | "Reconnect" | "Connection details";
  readonly actionDisabled: boolean;
  readonly chip: string;
  readonly chipStatus: StatusChipStatus;
  readonly icon: typeof Cable;
}

const HEADER_STATES: Readonly<Record<ProjectRuntimeState, HeaderState>> = {
  disconnected: {
    action: "Connect",
    actionDisabled: false,
    chip: "Disconnected",
    chipStatus: "idle",
    icon: Unplug,
  },
  "starting-rojo": {
    action: "Connecting…",
    actionDisabled: true,
    chip: "Starting Rojo",
    chipStatus: "working",
    icon: Server,
  },
  "rojo-server-ready": {
    action: "Continue setup",
    actionDisabled: false,
    chip: "Rojo ready",
    chipStatus: "ready",
    icon: Server,
  },
  "waiting-for-studio": {
    action: "Continue setup",
    actionDisabled: false,
    chip: "Waiting for Studio",
    chipStatus: "working",
    icon: Cable,
  },
  "studio-selection-required": {
    action: "Continue setup",
    actionDisabled: false,
    chip: "Choose Studio",
    chipStatus: "warning",
    icon: Cable,
  },
  "studio-bound": {
    action: "Connection details",
    actionDisabled: false,
    chip: "Studio bound",
    chipStatus: "studio-bound",
    icon: Cable,
  },
  "needs-reconnect": {
    action: "Reconnect",
    actionDisabled: false,
    chip: "Reconnect needed",
    chipStatus: "warning",
    icon: CircleAlert,
  },
  "catalog-ambiguous": {
    action: "Continue setup",
    actionDisabled: false,
    chip: "Catalog ambiguous",
    chipStatus: "warning",
    icon: CircleAlert,
  },
  "project-mismatch": {
    action: "Continue setup",
    actionDisabled: false,
    chip: "Project mismatch",
    chipStatus: "warning",
    icon: CircleAlert,
  },
  error: {
    action: "Reconnect",
    actionDisabled: false,
    chip: "Connection error",
    chipStatus: "error",
    icon: CircleAlert,
  },
};

export function ProjectHeader({
  connecting = false,
  onOpenConnection = () => undefined,
  project,
  runtime,
}: ProjectHeaderProps) {
  const configured = HEADER_STATES[runtime.state];
  const action = connecting ? "Connecting…" : configured.action;
  const actionDisabled = connecting || configured.actionDisabled;
  const summary = connectionSummary(project, runtime);
  const StateIcon = configured.icon;

  return (
    <div className={styles.root}>
      <div className={styles.identity}>
        <div className={styles.titleRow}>
          <StateIcon aria-hidden="true" className={styles.stateIcon} size={16} strokeWidth={1.8} />
          <span className={styles.projectName}>{project.displayName}</span>
          <StatusChip label={configured.chip} status={configured.chipStatus} />
        </div>
        <span className={styles.summary} data-ellipsized="true" title={summary}>
          {summary}
        </span>
      </div>
      <TechnicalIdentity runtime={runtime} />
      <Button
        aria-disabled={actionDisabled || undefined}
        data-main-connection-action="true"
        onClick={() => {
          if (!actionDisabled) onOpenConnection();
        }}
        variant="primary"
      >
        {action}
      </Button>
    </div>
  );
}

function connectionSummary(project: ProjectRecord, runtime: RuntimeSnapshot): string {
  if (
    runtime.state === "studio-bound" &&
    runtime.studio !== undefined &&
    runtime.broker !== undefined &&
    runtime.rojo !== undefined
  ) {
    return `${project.displayName} · Studio: ${runtime.studio.placeName} (${runtime.studio.placeId}) · MCP ${runtime.broker.primaryPort} · Rojo server :${runtime.rojo.port} ready`;
  }
  if (runtime.rojo !== undefined) {
    return `${project.displayName} · Rojo server :${runtime.rojo.port} ready`;
  }
  return `${project.displayName} · ${runtime.detail}`;
}

function TechnicalIdentity({ runtime }: { readonly runtime: RuntimeSnapshot }) {
  const values: Array<readonly [string, string]> = [];
  if (runtime.studio !== undefined) {
    values.push(["Studio instance ID", runtime.studio.instanceId]);
  }
  if (runtime.broker?.brokerEpoch !== undefined) {
    values.push(["Broker epoch", runtime.broker.brokerEpoch]);
  }
  if (runtime.rojo !== undefined) {
    values.push(["Rojo generation", String(runtime.rojo.generation)]);
  }
  if (runtime.bindingRevision !== undefined) {
    values.push(["Binding revision", String(runtime.bindingRevision)]);
  }
  if (values.length === 0) return null;
  return (
    <details className={styles.technical}>
      <summary>Details</summary>
      <dl>
        {values.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}
