import {
  Box,
  Boxes,
  Camera,
  ChevronDown,
  ChevronRight,
  Component,
  Database,
  FileCode,
  Folder,
  FolderCode,
  Image,
  Lightbulb,
  PanelsTopLeft,
  Users,
  Volume2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

import type { StudioInspectorNode } from "../../../shared/domain.js";
import type { ChildLoadState } from "../../app/studio-inspector-model.js";
import styles from "./StudioInspector.module.css";

export interface StudioExplorerProps {
  readonly childrenByPath: Readonly<Record<string, ChildLoadState>>;
  readonly expandedPaths: readonly string[];
  readonly onRetryChildren: (path: string) => void;
  readonly onSelectPath: (path: string) => void;
  readonly onTogglePath: (path: string) => void;
  readonly selectedPath: string | undefined;
}

interface VisibleNode {
  readonly level: number;
  readonly node: StudioInspectorNode;
  readonly parentPath: string;
}

const MAX_VISUAL_TREE_DEPTH = 16;

export function StudioExplorer({
  childrenByPath,
  expandedPaths,
  onRetryChildren,
  onSelectPath,
  onTogglePath,
  selectedPath,
}: StudioExplorerProps) {
  const visibleNodes = useMemo(
    () => flattenVisibleNodes(childrenByPath, new Set(expandedPaths)),
    [childrenByPath, expandedPaths],
  );
  const [focusPath, setFocusPath] = useState<string>();
  const itemRefs = useRef(new Map<string, HTMLDivElement>());
  const activePath =
    (focusPath !== undefined && visibleNodes.some(({ node }) => node.path === focusPath)
      ? focusPath
      : visibleNodes.some(({ node }) => node.path === selectedPath)
        ? selectedPath
        : visibleNodes[0]?.node.path) ?? undefined;

  useEffect(() => {
    if (activePath !== focusPath) setFocusPath(activePath);
  }, [activePath, focusPath]);

  const root = childrenByPath.game;
  if (root === undefined || root.status === "loading") {
    return (
      <div className={styles.centerState} role="status">
        <span className={styles.spinner} />
        Loading Studio objects…
      </div>
    );
  }
  if (root.status === "error") {
    return (
      <div className={styles.branchError} role="alert">
        <span>{root.message}</span>
        <button className={styles.retry} onClick={() => onRetryChildren("game")} type="button">
          Retry
        </button>
      </div>
    );
  }
  if (visibleNodes.length === 0) {
    return (
      <div className={styles.centerState} role="status">
        No objects found in Studio.
      </div>
    );
  }

  const focusItem = (path: string) => {
    setFocusPath(path);
    itemRefs.current.get(path)?.focus();
  };

  const onTreeKeyDown = (event: KeyboardEvent<HTMLDivElement>, current: VisibleNode, index: number) => {
    if (event.target !== event.currentTarget) return;
    const expanded = expandedPaths.includes(current.node.path);
    const next = visibleNodes[index + 1];
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        if (next !== undefined) focusItem(next.node.path);
        break;
      case "ArrowUp":
        event.preventDefault();
        if (index > 0) focusItem(visibleNodes[index - 1]!.node.path);
        break;
      case "Home":
        event.preventDefault();
        focusItem(visibleNodes[0]!.node.path);
        break;
      case "End":
        event.preventDefault();
        focusItem(visibleNodes.at(-1)!.node.path);
        break;
      case "ArrowRight":
        if (!current.node.hasChildren) break;
        event.preventDefault();
        if (!expanded) {
          onTogglePath(current.node.path);
        } else if (next?.level === current.level + 1) {
          focusItem(next.node.path);
        }
        break;
      case "ArrowLeft":
        event.preventDefault();
        if (current.node.hasChildren && expanded) {
          onTogglePath(current.node.path);
        } else if (current.parentPath !== "game") {
          focusItem(current.parentPath);
        }
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        onSelectPath(current.node.path);
        break;
    }
  };

  return (
    <div aria-label="Studio Explorer" className={styles.tree} role="tree">
      {visibleNodes.map((entry, index) => {
        const { node } = entry;
        const expanded = expandedPaths.includes(node.path);
        const childLoad = childrenByPath[node.path];
        return (
          <div key={node.path}>
            <div
              aria-label={`${node.name}, ${node.className}`}
              aria-expanded={node.hasChildren ? expanded : undefined}
              aria-level={entry.level}
              aria-selected={selectedPath === node.path}
              className={styles.treeItem}
              data-selected={selectedPath === node.path || undefined}
              onClick={() => onSelectPath(node.path)}
              onFocus={() => setFocusPath(node.path)}
              onKeyDown={(event) => onTreeKeyDown(event, entry, index)}
              ref={(element) => {
                if (element === null) itemRefs.current.delete(node.path);
                else itemRefs.current.set(node.path, element);
              }}
              role="treeitem"
              tabIndex={activePath === node.path ? 0 : -1}
            >
              <span
                aria-hidden="true"
                className={styles.indent}
                data-level={Math.min(entry.level, MAX_VISUAL_TREE_DEPTH)}
              />
              {node.hasChildren ? (
                <button
                  aria-label={`${expanded ? "Collapse" : "Expand"} ${node.name}`}
                  className={styles.chevron}
                  onClick={(event) => {
                    event.stopPropagation();
                    onTogglePath(node.path);
                  }}
                  tabIndex={-1}
                  type="button"
                >
                  {expanded ? (
                    <ChevronDown aria-hidden="true" size={14} strokeWidth={2} />
                  ) : (
                    <ChevronRight aria-hidden="true" size={14} strokeWidth={2} />
                  )}
                </button>
              ) : (
                <span aria-hidden="true" className={styles.chevronSpacer} />
              )}
              <ClassIcon className={node.className} />
              <span className={styles.nodeName}>{node.name}</span>
              <span aria-hidden="true" className={styles.className}>
                {node.className}
              </span>
            </div>
            {expanded && childLoad?.status === "loading" ? (
              <div className={styles.branchLoading} role="status">
                <span className={styles.spinner} />
                Loading {node.name} children…
              </div>
            ) : null}
            {expanded && childLoad?.status === "error" ? (
              <div className={styles.branchError} role="alert">
                <span>{childLoad.message}</span>
                <button className={styles.retry} onClick={() => onRetryChildren(node.path)} type="button">
                  Retry
                </button>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function ClassIcon({ className }: { readonly className: string }) {
  const Icon = iconForRobloxClass(className);
  return <Icon aria-hidden="true" className={styles.objectIcon} size={14} strokeWidth={1.7} />;
}

function iconForRobloxClass(className: string) {
  if (className === "Camera") return Camera;
  if (className === "Players" || className === "Teams" || className === "Team") return Users;
  if (className === "Lighting" || className.endsWith("Light")) return Lightbulb;
  if (className === "Sound" || className === "SoundGroup" || className === "SoundService") return Volume2;
  if (
    className === "ReplicatedStorage" ||
    className === "ServerStorage" ||
    className === "DataStoreService" ||
    className === "MemoryStoreService"
  ) {
    return Database;
  }
  if (className === "ServerScriptService") return FolderCode;
  if (className.endsWith("Script")) return FileCode;
  if (
    className.startsWith("UI") ||
    className.includes("Gui") ||
    className === "Frame" ||
    className === "ScrollingFrame" ||
    className === "ViewportFrame" ||
    className === "TextLabel" ||
    className === "TextButton" ||
    className === "TextBox" ||
    className === "ImageLabel" ||
    className === "ImageButton"
  ) {
    return PanelsTopLeft;
  }
  if (className === "Decal" || className === "Texture") return Image;
  if (className === "Workspace") return Boxes;
  if (className === "Model" || className === "Folder" || className === "Configuration") return Folder;
  if (
    className === "Part" ||
    className === "MeshPart" ||
    className === "WedgePart" ||
    className === "TrussPart" ||
    className === "UnionOperation"
  ) {
    return Box;
  }
  return Component;
}

function flattenVisibleNodes(
  childrenByPath: Readonly<Record<string, ChildLoadState>>,
  expandedPaths: ReadonlySet<string>,
): readonly VisibleNode[] {
  const visible: VisibleNode[] = [];
  const visit = (parentPath: string, level: number) => {
    const children = childrenByPath[parentPath];
    if (children?.status !== "ready") return;
    for (const node of children.rows) {
      visible.push({ node, level, parentPath });
      if (node.hasChildren && expandedPaths.has(node.path)) visit(node.path, level + 1);
    }
  };
  visit("game", 1);
  return visible;
}
