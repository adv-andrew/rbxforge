import type { DesktopError, RecoveryAction } from "../../../shared/errors.js";
import { Button } from "./Button.js";
import styles from "./InlineError.module.css";

const KNOWN_RECOVERY_ACTIONS = new Set<RecoveryAction>([
  "none",
  "retry",
  "reconnect",
  "choose-rojo",
  "install-plugin",
  "show-plugins-folder",
  "choose-place",
  "copy-mcp-url",
]);

const LAYER_LABELS: Readonly<Record<DesktopError["layer"], string>> = {
  storage: "Storage",
  project: "Project",
  rojo: "Rojo",
  mcp: "MCP",
  studio: "Studio",
  plugin: "Plugin",
  ipc: "IPC",
  app: "Application",
};

export interface InlineErrorProps {
  readonly error: DesktopError;
  readonly onDismiss?: () => void;
  readonly onRecovery?: (action: RecoveryAction) => void;
}

export function InlineError({ error, onDismiss, onRecovery }: InlineErrorProps) {
  const runtimeAction = error.recovery.action as string;
  const action = KNOWN_RECOVERY_ACTIONS.has(runtimeAction as RecoveryAction)
    ? (runtimeAction as RecoveryAction)
    : undefined;
  const recover =
    action === "none"
      ? onDismiss
      : action !== undefined && onRecovery !== undefined
        ? () => onRecovery(action)
        : undefined;
  return (
    <section aria-label={`${LAYER_LABELS[error.layer]} error`} className={styles.error} role="alert">
      <div className={styles.copy}>
        <strong>{LAYER_LABELS[error.layer]}</strong>
        <span>{error.message}</span>
      </div>
      {recover === undefined ? null : (
        <Button onClick={recover} variant="quiet">
          {error.recovery.label}
        </Button>
      )}
    </section>
  );
}
