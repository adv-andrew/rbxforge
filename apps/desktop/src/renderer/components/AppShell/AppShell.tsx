import type { ReactNode } from "react";

import { clampSidebarWidth } from "../../app/app-reducer.js";
import styles from "./AppShell.module.css";

export interface AppShellProps {
  readonly header: ReactNode;
  readonly main: ReactNode;
  readonly sidebar: ReactNode;
  readonly sidebarWidth: number;
}

export function AppShell({ header, main, sidebar, sidebarWidth }: AppShellProps) {
  const nonceMeta = document.querySelector<HTMLMetaElement>("meta[property=csp-nonce]");
  const styleNonce = nonceMeta?.nonce || nonceMeta?.getAttribute("nonce") || undefined;
  return (
    <>
      <style nonce={styleNonce}>{`.${styles.shell} { --sidebar-width: ${clampSidebarWidth(sidebarWidth)}px; }`}</style>
      <div className={styles.shell}>
        <a className={styles.skipLink} href="#conversation">
          Skip to conversation
        </a>
        <div className={styles.sidebarRegion}>{sidebar}</div>
        <header aria-label="Project status" className={[styles.header, "appDragRegion"].join(" ")}>
          {header}
        </header>
        <main aria-label="Conversation" className={styles.main} id="conversation" tabIndex={-1}>
          {main}
        </main>
      </div>
    </>
  );
}
