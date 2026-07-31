import { RefreshCw, X } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";

import type { StudioInspectorController } from "../../app/useStudioInspector.js";
import { StudioExplorer } from "./StudioExplorer.js";
import { StudioProperties } from "./StudioProperties.js";
import styles from "./StudioInspector.module.css";

export interface StudioInspectorProps {
  readonly controller: StudioInspectorController;
}

type InspectorTab = "explorer" | "properties";

export function StudioInspector({ controller }: StudioInspectorProps) {
  const mediaCompact = useCompactInspector();
  const isCompact = mediaCompact;
  const [activeTab, setActiveTab] = useState<InspectorTab>("explorer");
  const explorerTabRef = useRef<HTMLButtonElement>(null);
  const propertiesTabRef = useRef<HTMLButtonElement>(null);
  const filterInputRef = useRef<HTMLInputElement>(null);
  const pendingFilterFocus = useRef(false);
  const { state } = controller;

  const selectPath = (path: string) => {
    controller.selectPath(path);
    if (isCompact) setActiveTab("properties");
  };
  const selectTab = (tab: InspectorTab, focus = false) => {
    setActiveTab(tab);
    if (focus) {
      (tab === "explorer" ? explorerTabRef : propertiesTabRef).current?.focus();
    }
  };
  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    selectTab(event.key === "ArrowLeft" || event.key === "Home" ? "explorer" : "properties", true);
  };

  useEffect(() => {
    if (!state.isOpen) return;
    const focusFilter = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey || isEditable(event.target)) return;
      event.preventDefault();
      if (isCompact && activeTab !== "properties") {
        pendingFilterFocus.current = true;
        setActiveTab("properties");
        return;
      }
      filterInputRef.current?.focus();
    };
    document.addEventListener("keydown", focusFilter);
    return () => document.removeEventListener("keydown", focusFilter);
  }, [activeTab, isCompact, state.isOpen]);

  useEffect(() => {
    if (!pendingFilterFocus.current || (isCompact && activeTab !== "properties")) return;
    pendingFilterFocus.current = false;
    filterInputRef.current?.focus();
  }, [activeTab, isCompact]);

  if (!state.isOpen) return null;

  return (
    <section
      aria-labelledby="studio-inspector-title"
      className={[styles.root, isCompact && styles.compact].filter(Boolean).join(" ")}
    >
      <header className={styles.header}>
        <span aria-hidden="true" className={styles.brandMark} />
        <div className={styles.heading}>
          <h2 id="studio-inspector-title">Studio Inspector</h2>
          <span className={styles.status}>Studio · read-only</span>
        </div>
        <div className={styles.headerActions}>
          <button
            aria-label="Refresh Studio inspector"
            className={styles.iconButton}
            onClick={controller.refresh}
            title="Refresh Studio inspector"
            type="button"
          >
            <RefreshCw aria-hidden="true" size={16} strokeWidth={1.8} />
          </button>
          <button
            aria-label="Close Studio inspector"
            className={styles.iconButton}
            onClick={controller.close}
            title="Close Studio inspector"
            type="button"
          >
            <X aria-hidden="true" size={17} strokeWidth={1.8} />
          </button>
        </div>
      </header>

      {state.identity === undefined ? (
        <div className={styles.connectionChanged} role="status">
          Studio connection changed. Reconnect to inspect.
        </div>
      ) : (
        <>
          {isCompact ? (
            <div aria-label="Studio inspector views" className={styles.tabs} role="tablist">
              <button
                aria-controls="studio-explorer-panel"
                aria-selected={activeTab === "explorer"}
                className={styles.tab}
                id="studio-explorer-tab"
                onClick={() => selectTab("explorer")}
                onKeyDown={onTabKeyDown}
                ref={explorerTabRef}
                role="tab"
                tabIndex={activeTab === "explorer" ? 0 : -1}
                type="button"
              >
                Explorer
              </button>
              <button
                aria-controls="studio-properties-panel"
                aria-selected={activeTab === "properties"}
                className={styles.tab}
                id="studio-properties-tab"
                onClick={() => selectTab("properties")}
                onKeyDown={onTabKeyDown}
                ref={propertiesTabRef}
                role="tab"
                tabIndex={activeTab === "properties" ? 0 : -1}
                type="button"
              >
                Properties
              </button>
            </div>
          ) : null}

          <div className={styles.body}>
            <section
              aria-label="Explorer"
              aria-labelledby={isCompact ? "studio-explorer-tab" : undefined}
              className={styles.pane}
              hidden={isCompact && activeTab !== "explorer"}
              id="studio-explorer-panel"
              role={isCompact ? "tabpanel" : undefined}
            >
              {!isCompact ? <PaneHeading>Explorer</PaneHeading> : null}
              <StudioExplorer
                childrenByPath={state.childrenByPath}
                expandedPaths={state.expandedPaths}
                onRetryChildren={controller.retryChildren}
                onSelectPath={selectPath}
                onTogglePath={controller.togglePath}
                selectedPath={state.selectedPath}
              />
            </section>
            <section
              aria-label="Properties"
              aria-labelledby={isCompact ? "studio-properties-tab" : undefined}
              className={styles.pane}
              hidden={isCompact && activeTab !== "properties"}
              id="studio-properties-panel"
              role={isCompact ? "tabpanel" : undefined}
            >
              {!isCompact ? <PaneHeading>Properties</PaneHeading> : null}
              <StudioProperties
                filterInputRef={filterInputRef}
                onRetry={controller.retryProperties}
                properties={state.properties}
                selectedPath={state.selectedPath}
              />
            </section>
          </div>
        </>
      )}
    </section>
  );
}

function isEditable(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

function PaneHeading({ children }: { readonly children: string }) {
  return <h3 className={styles.paneHeading}>{children}</h3>;
}

function useCompactInspector(): boolean {
  const query = "(max-width: 1100px)";
  const [compact, setCompact] = useState(() =>
    typeof window.matchMedia === "function" ? window.matchMedia(query).matches : false,
  );

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(query);
    const update = () => setCompact(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  return compact;
}
