import styles from "./SharedControls.module.css";

export type StatusChipStatus = "idle" | "working" | "ready" | "warning" | "error" | "studio-bound";

type NonEmptyLiteral<Value extends string> = Value extends "" ? never : Value;

export interface StatusChipProps<Label extends string = string> {
  label: NonEmptyLiteral<Label>;
  status: StatusChipStatus;
}

function StatusIcon({ status }: { status: StatusChipStatus }) {
  const complete = status === "ready" || status === "studio-bound";
  return (
    <svg aria-hidden="true" className={styles.statusIcon} viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">
      {complete ? (
        <path d="M3 8.5 6.2 12 13 4.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
      ) : (
        <path d="M8 2.5V8l3.25 2" fill="none" stroke="currentColor" strokeWidth="1.6" />
      )}
    </svg>
  );
}

export function StatusChip<const Label extends string>({ label, status }: StatusChipProps<Label>) {
  const visibleLabel = label.trim();
  if (visibleLabel.length === 0) {
    throw new Error("StatusChip requires a non-empty visible label.");
  }
  const studioBound = status === "studio-bound";
  return (
    <span
      className={[styles.statusChip, styles[`status-${status}`]].join(" ")}
      data-status={status}
      data-studio-bound={String(studioBound)}
    >
      <StatusIcon status={status} />
      <span>{visibleLabel}</span>
    </span>
  );
}
