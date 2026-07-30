import styles from "./SharedControls.module.css";

export type SkeletonVariant = "project-row" | "thread-row" | "message-line" | "connection-step";

export interface SkeletonProps {
  variant: SkeletonVariant;
}

export function Skeleton({ variant }: SkeletonProps) {
  return (
    <span
      aria-hidden="true"
      className={[styles.skeleton, styles[`skeleton-${variant}`]].join(" ")}
      data-testid="skeleton"
    />
  );
}
