import { type ReactNode } from "react";

import styles from "./SharedControls.module.css";

export interface EmptyStateProps {
  action: ReactNode;
  children: ReactNode;
  title: string;
}

export function EmptyState({ action, children, title }: EmptyStateProps) {
  return (
    <section className={styles.emptyState}>
      <h2>{title}</h2>
      <p>{children}</p>
      <div className={styles.emptyAction}>{action}</div>
    </section>
  );
}
