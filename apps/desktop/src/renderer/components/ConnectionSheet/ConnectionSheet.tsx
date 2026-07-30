import { useEffect, useRef, useState, type ReactNode } from "react";
import { AppWindow, Cable, CheckCircle2, Copy, FolderOpen, RadioTower, Server, type LucideIcon } from "lucide-react";

import type { DesktopError } from "../../../shared/errors.js";
import {
  MAX_ECMASCRIPT_DATE_TIMESTAMP_MS,
  type ProjectRecord,
  type RuntimeSnapshot,
  type StudioCatalogRow,
} from "../../../shared/domain.js";
import type { PluginInspectionView } from "../../../shared/protocol.js";
import { Button } from "../shared/Button.js";
import { Input } from "../shared/Input.js";
import { Sheet } from "../shared/Sheet.js";
import styles from "./ConnectionSheet.module.css";

export type ConnectionOperation =
  | "acknowledgeStudioRestart"
  | "chooseRojo"
  | "confirmRojoHandoff"
  | "copyMcpUrl"
  | "copyProjectFile"
  | "copyRojoAddress"
  | "disconnect"
  | "inspectPlugin"
  | "installPlugin"
  | "reconnect"
  | "refreshCatalog"
  | "saveMcpPort"
  | "selectStudio"
  | "showPluginFolder";

export interface ConnectionSheetActions {
  acknowledgeStudioRestart(): void;
  chooseRojo(): void;
  confirmRojoHandoff(input: { readonly projectId: string; readonly bindingRevision: number }): Promise<boolean>;
  copyMcpUrl(): void;
  copyProjectFile(): void;
  copyRojoAddress(): void;
  disconnect(): void;
  inspectPlugin(): void;
  installPlugin(confirmReplace: boolean): void;
  reconnect(): void;
  refreshCatalog(): void;
  saveMcpPort(port: number): void;
  selectStudio(input: {
    readonly projectId: string;
    readonly instanceId: string;
    readonly catalogRevision: number;
    readonly warningAccepted: boolean;
  }): Promise<boolean>;
  showPluginFolder(): void;
}

export interface ConnectionSheetProps {
  readonly actions: ConnectionSheetActions;
  readonly busy: Readonly<Partial<Record<ConnectionOperation, boolean>>>;
  readonly error?: DesktopError;
  readonly mcpPortChangeAllowed: boolean;
  readonly onDismiss: () => void;
  readonly open: boolean;
  readonly pluginInspection: PluginInspectionView | undefined;
  readonly preferredMcpPort: number;
  readonly project: ProjectRecord;
  readonly restartRecommended: boolean;
  readonly runtime: RuntimeSnapshot;
}

const UNRECOGNIZED_METADATA = "Unavailable: unrecognized Studio metadata.";

export function ConnectionSheet({
  actions,
  busy,
  error,
  mcpPortChangeAllowed,
  onDismiss,
  open,
  pluginInspection,
  preferredMcpPort,
  project,
  restartRecommended,
  runtime,
}: ConnectionSheetProps) {
  const [portInput, setPortInput] = useState(String(preferredMcpPort));
  const [replacementConfirmed, setReplacementConfirmed] = useState(false);
  const [localWarningInstanceId, setLocalWarningInstanceId] = useState<string>();
  const [submittedSelection, setSubmittedSelection] = useState<string>();
  const [handoffConfirmed, setHandoffConfirmed] = useState(false);
  const [submittedBindingRevision, setSubmittedBindingRevision] = useState<number>();
  const selectionAttempt = useRef(0);
  const bindingAttempt = useRef(0);
  const tuple = runtimeTuple(project.id, runtime);
  const eligibility = eligibilitySignature(runtime.catalog);

  useEffect(() => {
    setPortInput(String(preferredMcpPort));
  }, [preferredMcpPort]);

  useEffect(() => {
    selectionAttempt.current += 1;
    bindingAttempt.current += 1;
    setReplacementConfirmed(false);
    setLocalWarningInstanceId(undefined);
    setSubmittedSelection(undefined);
    setHandoffConfirmed(false);
    setSubmittedBindingRevision(undefined);
    return () => {
      selectionAttempt.current += 1;
      bindingAttempt.current += 1;
    };
  }, [eligibility, open, runtime.state, tuple]);

  const hostSelectedRow = runtime.pending
    ? runtime.catalog.find((candidate) => candidate.instanceId === runtime.pending?.instanceId)
    : undefined;
  const localWarningRow =
    hostSelectedRow === undefined && localWarningInstanceId !== undefined
      ? runtime.catalog.find((candidate) => candidate.instanceId === localWarningInstanceId)
      : undefined;
  const parsedPort = parsePort(portInput);
  const portError =
    portInput.length > 0 && parsedPort === undefined ? "Enter an integer from 1024 to 65535." : undefined;
  const mcpVersion = runtime.studioMcp.serverVersion;

  const selectRow = (catalogRow: StudioCatalogRow): void => {
    if (!rowSelectable(catalogRow) || runtime.catalogRevision === undefined || busy.selectStudio) return;
    setHandoffConfirmed(false);
    setSubmittedBindingRevision(undefined);
    if (catalogRow.warningRequired) {
      setLocalWarningInstanceId(catalogRow.instanceId);
      setSubmittedSelection(undefined);
      return;
    }
    const submissionKey = `${tuple}\0${catalogRow.instanceId}\0false`;
    if (submittedSelection === submissionKey) return;
    setSubmittedSelection(submissionKey);
    submitSelection(submissionKey, {
      projectId: project.id,
      instanceId: catalogRow.instanceId,
      catalogRevision: runtime.catalogRevision,
      warningAccepted: false,
    });
  };

  const acceptWarning = (): void => {
    if (
      localWarningRow === undefined ||
      !localWarningRow.warningRequired ||
      localWarningRow.warningKind === undefined ||
      runtime.catalogRevision === undefined ||
      busy.selectStudio
    ) {
      return;
    }
    const submissionKey = `${tuple}\0${localWarningRow.instanceId}\0true`;
    if (submittedSelection === submissionKey) return;
    setSubmittedSelection(submissionKey);
    submitSelection(submissionKey, {
      projectId: project.id,
      instanceId: localWarningRow.instanceId,
      catalogRevision: runtime.catalogRevision,
      warningAccepted: true,
    });
  };

  const submitSelection = (
    submissionKey: string,
    input: Parameters<ConnectionSheetActions["selectStudio"]>[0],
  ): void => {
    const attempt = ++selectionAttempt.current;
    void actions.selectStudio(input).then(
      (succeeded) => {
        if (!succeeded && selectionAttempt.current === attempt) {
          setSubmittedSelection((current) => (current === submissionKey ? undefined : current));
        }
      },
      () => {
        if (selectionAttempt.current === attempt) {
          setSubmittedSelection((current) => (current === submissionKey ? undefined : current));
        }
      },
    );
  };

  const bindStudio = (): void => {
    const revision = runtime.pending?.bindingRevision;
    if (
      revision === undefined ||
      !handoffConfirmed ||
      busy.confirmRojoHandoff ||
      submittedBindingRevision === revision
    ) {
      return;
    }
    setSubmittedBindingRevision(revision);
    const attempt = ++bindingAttempt.current;
    void actions.confirmRojoHandoff({ projectId: project.id, bindingRevision: revision }).then(
      (succeeded) => {
        if (!succeeded && bindingAttempt.current === attempt) {
          setSubmittedBindingRevision((current) => (current === revision ? undefined : current));
        }
      },
      () => {
        if (bindingAttempt.current === attempt) {
          setSubmittedBindingRevision((current) => (current === revision ? undefined : current));
        }
      },
    );
  };

  const footer = (
    <footer className={styles.footer} data-sticky-action-footer="true">
      {restartRecommended ? (
        <Button
          disabled={busy.acknowledgeStudioRestart}
          onClick={() => actions.acknowledgeStudioRestart()}
          variant="primary"
        >
          Studio restarted
        </Button>
      ) : runtime.state === "disconnected" ? (
        <Button disabled={busy.reconnect} onClick={() => actions.reconnect()} variant="primary">
          Connect
        </Button>
      ) : runtime.state === "needs-reconnect" || runtime.state === "error" || runtime.rojo === undefined ? (
        <Button disabled={busy.reconnect} onClick={() => actions.reconnect()} variant="primary">
          Reconnect
        </Button>
      ) : runtime.state === "studio-bound" ? (
        <span className={styles.boundCopy}>Studio bound after your manual Rojo handoff confirmation.</span>
      ) : (
        <Button
          disabled={
            runtime.pending === undefined ||
            !handoffConfirmed ||
            busy.confirmRojoHandoff ||
            submittedBindingRevision === runtime.pending.bindingRevision
          }
          onClick={bindStudio}
          variant="primary"
        >
          Bind Studio
        </Button>
      )}
      {runtime.state === "disconnected" ? null : (
        <Button disabled={busy.disconnect} onClick={() => actions.disconnect()} variant="secondary">
          Disconnect
        </Button>
      )}
    </footer>
  );

  return (
    <Sheet
      closeLabel="Close connection setup"
      description="Verify each local runtime boundary before binding this project."
      footer={footer}
      onDismiss={onDismiss}
      open={open}
      title="Connection setup"
    >
      <ol className={styles.steps}>
        <ConnectionStep icon={FolderOpen} number={1} title="Project">
          <dl className={styles.facts}>
            <Fact label="Project file" value={runtime.activeProject.canonicalProjectFile} />
            <Fact label="Relative file" value={runtime.activeProject.relativeProjectFile} />
            <Fact label="Configuration digest" value={shortDigest(runtime.activeProject.configDigest)} mono />
          </dl>
          <div className={styles.actions}>
            <Button disabled={busy.copyProjectFile} onClick={() => actions.copyProjectFile()} variant="quiet">
              <Copy aria-hidden="true" size={16} />
              Copy project file
            </Button>
          </div>
          <details className={styles.details}>
            <summary>Project identity details</summary>
            <dl>
              <Fact label="Full digest" value={runtime.activeProject.configDigest} mono />
              <Fact label="Project revision" value={String(runtime.activeProject.revision)} mono />
            </dl>
          </details>
        </ConnectionStep>

        <ConnectionStep icon={Server} number={2} title="Rojo">
          {runtime.rojo === undefined ? (
            <p className={styles.secondary}>Resolved when connecting</p>
          ) : (
            <>
              <dl className={styles.facts}>
                <Fact label="Version" value={reported(runtime.rojo.version)} />
                <Fact label="Server" value={`127.0.0.1:${runtime.rojo.port} ready`} mono />
              </dl>
              <details className={styles.details}>
                <summary>Rojo executable details</summary>
                <dl>
                  <Fact label="Executable" value={runtime.rojo.executablePath} mono />
                </dl>
              </details>
            </>
          )}
          <div className={styles.actions}>
            <Button disabled={busy.chooseRojo} onClick={() => actions.chooseRojo()} variant="secondary">
              Choose Rojo executable
            </Button>
          </div>
          {runtime.rojo === undefined ? (
            <p className={styles.secondary}>
              Install Rojo 7.7 or newer separately, then choose its executable. RbxForge does not download Rojo.
            </p>
          ) : null}
        </ConnectionStep>

        <ConnectionStep icon={RadioTower} number={3} title="Studio MCP">
          <p className={styles.primaryCopy}>{`Studio MCP ${mcpVersion}`}</p>
          <PluginState
            actions={actions}
            busy={busy}
            inspection={pluginInspection}
            replacementConfirmed={replacementConfirmed}
            restartRecommended={restartRecommended}
            setReplacementConfirmed={setReplacementConfirmed}
          />
          {runtime.broker === undefined ? null : (
            <>
              <dl className={styles.facts}>
                <Fact label="Primary port" value={String(runtime.broker.primaryPort)} mono />
                <Fact label="Plugin URL" value={`http://127.0.0.1:${runtime.broker.primaryPort}`} mono />
              </dl>
              <Button disabled={busy.copyMcpUrl} onClick={() => actions.copyMcpUrl()} variant="quiet">
                <Copy aria-hidden="true" size={16} />
                Copy MCP URL
              </Button>
            </>
          )}
          <div className={styles.portEditor}>
            <Input
              disabled={!mcpPortChangeAllowed || busy.saveMcpPort}
              {...(portError === undefined ? {} : { error: portError })}
              {...(mcpPortChangeAllowed ? { help: "Applies to the next broker start." } : {})}
              label="Preferred MCP port"
              max={65_535}
              min={1_024}
              onChange={(event) => setPortInput(event.currentTarget.value)}
              type="number"
              value={portInput}
            />
            <Button
              disabled={
                !mcpPortChangeAllowed || busy.saveMcpPort || parsedPort === undefined || parsedPort === preferredMcpPort
              }
              onClick={() => parsedPort !== undefined && actions.saveMcpPort(parsedPort)}
              variant="secondary"
            >
              Save MCP port
            </Button>
          </div>
          {!mcpPortChangeAllowed ? (
            <p className={styles.secondary}>Disconnect every project using Studio MCP before changing this port.</p>
          ) : null}
          {runtime.broker === undefined ? null : (
            <details className={styles.details}>
              <summary>Broker details</summary>
              <dl>
                <Fact
                  label="Legacy listener"
                  value={
                    runtime.broker.legacyPort === undefined
                      ? `Legacy port 3002 ${runtime.broker.legacyStatus}`
                      : `Legacy port ${runtime.broker.legacyPort} ${runtime.broker.legacyStatus}`
                  }
                  mono
                />
              </dl>
            </details>
          )}
        </ConnectionStep>

        <ConnectionStep icon={AppWindow} number={4} title="Studio place">
          <div aria-label="Studio places" className={styles.catalog} role="radiogroup">
            {runtime.catalog.length === 0 ? (
              <p className={styles.secondary}>No Studio places reported.</p>
            ) : (
              runtime.catalog.map((catalogRow) => {
                const selected =
                  catalogRow.instanceId === runtime.pending?.instanceId ||
                  catalogRow.instanceId === localWarningInstanceId;
                const selectable = rowSelectable(catalogRow);
                const disabled = !selectable || busy.selectStudio;
                return (
                  <label className={styles.catalogRow} data-disabled={String(disabled)} key={catalogRow.instanceId}>
                    <input
                      checked={selected}
                      disabled={disabled}
                      name="studio-place"
                      onChange={() => selectRow(catalogRow)}
                      type="radio"
                    />
                    <span className={styles.catalogCopy}>
                      <strong>
                        {reported(catalogRow.placeName)} · Place {catalogRow.placeId}
                      </strong>
                      <span>
                        DataModel {reported(catalogRow.dataModelName)} · role {reported(catalogRow.role)}
                      </span>
                      <span>
                        Plugin {reported(catalogRow.pluginVariant)} / {reported(catalogRow.pluginVersion)} · server{" "}
                        {reported(catalogRow.serverVersion)}
                      </span>
                      <span>Last activity {formatTimestamp(catalogRow.lastActivity)}</span>
                      {selectable ? null : <span className={styles.blocked}>{eligibilityCopy(catalogRow)}</span>}
                    </span>
                    <details className={styles.details}>
                      <summary>Instance details</summary>
                      <dl>
                        <Fact label="Instance ID" value={catalogRow.instanceId} mono />
                        <Fact label="Connected at" value={formatTimestamp(catalogRow.connectedAt)} mono />
                      </dl>
                    </details>
                  </label>
                );
              })
            )}
          </div>
          <Button disabled={busy.refreshCatalog} onClick={() => actions.refreshCatalog()} variant="secondary">
            Refresh Studio list
          </Button>
        </ConnectionStep>

        <ConnectionStep icon={Cable} number={5} title="Rojo handoff">
          {runtime.rojo === undefined ? (
            <p className={styles.secondary}>Start the Rojo server before completing the manual handoff.</p>
          ) : (
            <>
              <p className={styles.primaryCopy}>
                Connect the Rojo Studio plugin in the selected Studio window to 127.0.0.1:{runtime.rojo.port}
              </p>
              <Button disabled={busy.copyRojoAddress} onClick={() => actions.copyRojoAddress()} variant="quiet">
                <Copy aria-hidden="true" size={16} />
                Copy Rojo address
              </Button>
              <label className={styles.check}>
                <input
                  checked={handoffConfirmed}
                  disabled={runtime.pending === undefined || busy.confirmRojoHandoff}
                  onChange={(event) => {
                    setHandoffConfirmed(event.currentTarget.checked);
                    setSubmittedBindingRevision(undefined);
                  }}
                  type="checkbox"
                />
                I connected this Studio window to the Rojo server above
              </label>
              <p className={styles.secondary}>
                This confirmation records your manual handoff. RbxForge does not observe which Studio window consumed
                the Rojo server.
              </p>
            </>
          )}
        </ConnectionStep>

        <ConnectionStep icon={CheckCircle2} number={6} title="Confirm">
          {localWarningRow?.warningRequired && localWarningRow.warningKind !== undefined ? (
            <label className={styles.check}>
              <input
                checked={submittedSelection !== undefined}
                disabled={submittedSelection !== undefined || busy.selectStudio}
                onChange={(event) => event.currentTarget.checked && acceptWarning()}
                type="checkbox"
              />
              {warningCopy(localWarningRow.warningKind)}
            </label>
          ) : null}
          <p className={styles.limitation}>{runtime.samePublishedPlaceLimitation}</p>
          {error === undefined ? null : <ConnectionError actions={actions} error={error} runtime={runtime} />}
        </ConnectionStep>
      </ol>

      <TechnicalDetails runtime={runtime} />
    </Sheet>
  );
}

function ConnectionStep({
  children,
  icon: Icon,
  number,
  title,
}: {
  readonly children: ReactNode;
  readonly icon: LucideIcon;
  readonly number: number;
  readonly title: string;
}) {
  return (
    <li className={styles.step}>
      <h3 aria-label={`${number} ${title}`}>
        <span className={styles.marker}>{number}</span>
        <Icon aria-hidden="true" size={16} strokeWidth={1.8} />
        {title}
      </h3>
      <div className={styles.stepContent}>{children}</div>
    </li>
  );
}

function PluginState({
  actions,
  busy,
  inspection,
  replacementConfirmed,
  restartRecommended,
  setReplacementConfirmed,
}: {
  readonly actions: ConnectionSheetActions;
  readonly busy: ConnectionSheetProps["busy"];
  readonly inspection: PluginInspectionView | undefined;
  readonly replacementConfirmed: boolean;
  readonly restartRecommended: boolean;
  readonly setReplacementConfirmed: (confirmed: boolean) => void;
}) {
  if (inspection === undefined) {
    return <p className={styles.secondary}>Inspecting Studio plugin…</p>;
  }
  return (
    <div className={styles.pluginState}>
      <p className={styles.secondary}>{inspection.detail}</p>
      {inspection.state === "missing" ? (
        <Button disabled={busy.installPlugin} onClick={() => actions.installPlugin(false)} variant="secondary">
          Install Studio plugin
        </Button>
      ) : null}
      {inspection.state === "installed" ? <p className={styles.primaryCopy}>Studio plugin installed</p> : null}
      {inspection.state === "replace-required" ? (
        <>
          <label className={styles.check}>
            <input
              checked={replacementConfirmed}
              onChange={(event) => setReplacementConfirmed(event.currentTarget.checked)}
              type="checkbox"
            />
            Back up and replace the existing Studio plugin
          </label>
          <Button
            disabled={!replacementConfirmed || busy.installPlugin}
            onClick={() => actions.installPlugin(true)}
            variant="secondary"
          >
            Replace Studio plugin
          </Button>
        </>
      ) : null}
      {inspection.state === "inspector-conflict" ? (
        <Button disabled={busy.showPluginFolder} onClick={() => actions.showPluginFolder()} variant="secondary">
          Show Plugins folder
        </Button>
      ) : null}
      {inspection.state === "error" ? (
        <Button disabled={busy.inspectPlugin} onClick={() => actions.inspectPlugin()} variant="secondary">
          Inspect Studio plugin
        </Button>
      ) : null}
      {restartRecommended ? <p className={styles.restart}>Restart Studio before continuing.</p> : null}
      <details className={styles.details}>
        <summary>Plugin file details</summary>
        <dl>
          <Fact label="Bundled source" value={inspection.sourcePath} mono />
          <Fact label="Studio destination" value={inspection.destinationPath} mono />
        </dl>
      </details>
    </div>
  );
}

function ConnectionError({
  actions,
  error,
  runtime,
}: {
  readonly actions: ConnectionSheetActions;
  readonly error: DesktopError;
  readonly runtime: RuntimeSnapshot;
}) {
  const studioFlowCanRefresh =
    runtime.pending !== undefined ||
    runtime.state === "studio-selection-required" ||
    runtime.state === "rojo-server-ready" ||
    runtime.state === "waiting-for-studio" ||
    runtime.state === "catalog-ambiguous" ||
    runtime.state === "project-mismatch";
  const recovery =
    error.layer === "plugin"
      ? { label: "Inspect Studio plugin", run: actions.inspectPlugin }
      : error.layer === "rojo"
        ? { label: "Choose Rojo executable", run: actions.chooseRojo }
        : error.layer === "studio"
          ? { label: "Refresh Studio list", run: actions.refreshCatalog }
          : studioFlowCanRefresh
            ? { label: "Refresh Studio list", run: actions.refreshCatalog }
            : { label: "Reconnect", run: actions.reconnect };
  return (
    <section className={styles.error} role="alert">
      <p>{error.message}</p>
      <Button onClick={() => recovery.run()} variant="secondary">
        {recovery.label}
      </Button>
    </section>
  );
}

function TechnicalDetails({ runtime }: { readonly runtime: RuntimeSnapshot }) {
  const values: Array<readonly [string, string]> = [];
  if (runtime.broker?.brokerEpoch !== undefined) {
    values.push(["Broker epoch", runtime.broker.brokerEpoch]);
  }
  if (runtime.rojo !== undefined) {
    values.push(["Rojo generation", `Generation ${runtime.rojo.generation}`]);
  }
  if (runtime.pending !== undefined) {
    values.push(["Pending binding revision", `Revision ${runtime.pending.bindingRevision}`]);
  }
  if (values.length === 0) return null;
  return (
    <details className={styles.technical}>
      <summary>Technical connection details</summary>
      <dl>
        {values.map(([label, value]) => (
          <Fact key={label} label={label} value={value} mono />
        ))}
      </dl>
    </details>
  );
}

function Fact({
  label,
  mono = false,
  value,
}: {
  readonly label: string;
  readonly mono?: boolean;
  readonly value: string;
}) {
  return (
    <div>
      <dt>{label}</dt>
      <dd className={mono ? styles.mono : undefined}>{value}</dd>
    </div>
  );
}

function rowSelectable(catalogRow: StudioCatalogRow): boolean {
  if (!catalogRow.eligible || catalogRow.eligibilityReason !== undefined || !metadataRecognized(catalogRow)) {
    return false;
  }
  if (catalogRow.warningRequired) {
    return catalogRow.warningKind === "unknown-place" || catalogRow.warningKind === "unpublished-place";
  }
  return catalogRow.warningKind === undefined;
}

function metadataRecognized(catalogRow: StudioCatalogRow): boolean {
  return [
    catalogRow.role,
    catalogRow.dataModelName,
    catalogRow.pluginVariant,
    catalogRow.pluginVersion,
    catalogRow.serverVersion,
  ].every((value) => value.trim().length > 0);
}

function eligibilityCopy(catalogRow: StudioCatalogRow): string {
  if (!metadataRecognized(catalogRow)) return UNRECOGNIZED_METADATA;
  switch (catalogRow.eligibilityReason) {
    case "role":
      return "Unavailable: Studio role must be Edit.";
    case "plugin-variant":
      return "Unavailable: use the main Studio MCP plugin.";
    case "plugin-version":
      return "Unavailable: Studio plugin version does not match.";
    case "server-version":
      return "Unavailable: Studio MCP server version does not match.";
    case "version-mismatch":
      return "Unavailable: Studio reported a plugin/server version mismatch.";
    case "stale":
      return "Unavailable: Studio metadata is stale. Refresh the list.";
    case "project-mismatch":
      return "Unavailable: place ID does not match this project.";
    case "catalog-ambiguous":
      return "Unavailable: multiple Studio instances report the same published place.";
    default:
      return UNRECOGNIZED_METADATA;
  }
}

function warningCopy(kind: NonNullable<StudioCatalogRow["warningKind"]>): string {
  return kind === "unknown-place"
    ? "I understand this project does not declare a published place ID."
    : "I understand this Studio place is unpublished.";
}

function runtimeTuple(projectId: string, runtime: RuntimeSnapshot): string {
  return [
    projectId,
    runtime.activeProject.revision,
    runtime.activeProject.canonicalProjectFile,
    runtime.activeProject.relativeProjectFile,
    runtime.activeProject.configDigest,
    runtime.rojo?.generation ?? "",
    runtime.rojo?.port ?? "",
    runtime.broker?.brokerEpoch ?? "",
    runtime.catalogRevision ?? "",
    runtime.pending?.instanceId ?? runtime.studio?.instanceId ?? "",
    runtime.pending?.bindingRevision ?? "",
  ].join("\0");
}

function eligibilitySignature(catalog: RuntimeSnapshot["catalog"]): string {
  return catalog
    .map((catalogRow) =>
      [
        catalogRow.instanceId,
        catalogRow.eligible,
        catalogRow.eligibilityReason ?? "",
        catalogRow.warningRequired,
        catalogRow.warningKind ?? "",
      ].join(":"),
    )
    .join("|");
}

function parsePort(value: string): number | undefined {
  if (!/^\d+$/.test(value)) return undefined;
  const port = Number(value);
  return Number.isSafeInteger(port) && port >= 1_024 && port <= 65_535 ? port : undefined;
}

function shortDigest(value: string): string {
  return value.length <= 16 ? value : `${value.slice(0, 8)}…${value.slice(-8)}`;
}

function reported(value: string): string {
  return value.trim().length === 0 ? "Not reported" : value;
}

function formatTimestamp(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_ECMASCRIPT_DATE_TIMESTAMP_MS) {
    return "Not reported";
  }
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? "Not reported" : timestamp.toISOString();
}
