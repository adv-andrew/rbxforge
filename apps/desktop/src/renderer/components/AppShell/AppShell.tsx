import type { ReactNode } from "react";

import { clampSidebarWidth } from "../../app/app-reducer.js";
import styles from "./AppShell.module.css";

export interface AppShellProps {
  readonly header: ReactNode;
  readonly inspector?: ReactNode;
  readonly main: ReactNode;
  readonly sidebar: ReactNode;
  readonly sidebarWidth: number;
}

export function AppShell({ header, inspector, main, sidebar, sidebarWidth }: AppShellProps) {
  const nonceMeta = document.querySelector<HTMLMetaElement>("meta[property=csp-nonce]");
  const styleNonce = nonceMeta?.nonce || nonceMeta?.getAttribute("nonce") || undefined;
  return (
    <>
      <style nonce={styleNonce}>{`.${styles.shell} { --sidebar-width: ${clampSidebarWidth(sidebarWidth)}px; }`}</style>
      <div className={[styles.shell, inspector !== undefined && styles.withInspector].filter(Boolean).join(" ")}>
        <a className={styles.skipLink} href="#conversation">
          Skip to conversation
        </a>
        {inspector === undefined ? null : (
          <a className={styles.skipLink} href="#studio-inspector">
            Skip to Studio inspector
          </a>
        )}
        <div className={styles.sidebarRegion}>{sidebar}</div>
        <header aria-label="Project status" className={[styles.header, "appDragRegion"].join(" ")}>
          {header}
        </header>
        <main aria-label="Conversation" className={styles.main} id="conversation" tabIndex={-1}>
          {main}
        </main>
        {inspector === undefined ? null : (
          <>
            <div aria-hidden="true" className={styles.inspectorOverlay} />
            <aside aria-label="Studio inspector" className={styles.inspector} id="studio-inspector" tabIndex={-1}>
              {inspector}
            </aside>
          </>
        )}
      </div>
    </>
  );
}
