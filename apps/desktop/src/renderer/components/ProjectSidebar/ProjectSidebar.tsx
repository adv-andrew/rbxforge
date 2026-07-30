import { Info, MessageSquarePlus, Plus } from "lucide-react";
import { type KeyboardEvent, type PointerEvent, useRef, useState } from "react";

import type { ProjectRecord, ThreadRecord } from "../../../shared/domain.js";
import markUrl from "../../../../assets/brand/rbxforge-mark.svg";
import wordmarkUrl from "../../../../assets/brand/rbxforge-wordmark.svg";
import { clampSidebarWidth } from "../../app/app-reducer.js";
import { Button } from "../shared/Button.js";
import { Dialog } from "../shared/Dialog.js";
import { IconButton } from "../shared/IconButton.js";
import { Input } from "../shared/Input.js";
import { MenuButton, MenuItem } from "../shared/Menu.js";
import { Skeleton } from "../shared/Skeleton.js";
import { AboutDialog } from "./AboutDialog.js";
import styles from "./ProjectSidebar.module.css";

type DialogState =
  | { readonly type: "rename"; readonly projectId: string; readonly threadId: string; readonly title: string }
  | { readonly type: "delete"; readonly projectId: string; readonly threadId: string; readonly title: string }
  | { readonly type: "remove"; readonly projectId: string; readonly displayName: string };

export interface ProjectSidebarProps {
  readonly projects: readonly ProjectRecord[];
  readonly threads: readonly ThreadRecord[];
  readonly selectedProjectId: string | undefined;
  readonly selectedThreadId: string | undefined;
  readonly sidebarWidth: number;
  readonly disabled?: boolean;
  readonly onAddProject: () => void;
  readonly onSelectProject: (projectId: string) => Promise<boolean>;
  readonly onCreateThread: (projectId: string) => Promise<boolean>;
  readonly onSelectThread: (projectId: string, threadId: string) => Promise<boolean>;
  readonly onRenameThread: (projectId: string, threadId: string, title: string) => Promise<boolean>;
  readonly onDeleteThread: (projectId: string, threadId: string) => Promise<boolean>;
  readonly onRemoveProject: (projectId: string) => Promise<boolean>;
  readonly onSidebarWidthChange: (width: number) => void;
  readonly onSidebarWidthCommit: (width: number) => Promise<boolean>;
}

export function ProjectSidebarLoading({ sidebarWidth }: { readonly sidebarWidth: number }) {
  const fullWordmark = sidebarWidth >= 260;
  return (
    <aside aria-label="RbxForge projects" className={styles.sidebar}>
      <div className={[styles.brandStrip, "appDragRegion"].join(" ")}>
        <img
          alt="RbxForge"
          className={[fullWordmark ? styles.wordmark : styles.mark, "appNoDrag"].join(" ")}
          data-brand={fullWordmark ? "wordmark" : "mark"}
          draggable="false"
          src={fullWordmark ? wordmarkUrl : markUrl}
        />
      </div>
      <div className={styles.loadingBody}>
        <nav aria-label="Projects and conversations" className={styles.loadingList}>
          <Skeleton variant="project-row" />
          <Skeleton variant="project-row" />
          <Skeleton variant="thread-row" />
        </nav>
      </div>
    </aside>
  );
}

export function ProjectSidebar({
  projects,
  threads,
  selectedProjectId,
  selectedThreadId,
  sidebarWidth,
  disabled = false,
  onAddProject,
  onSelectProject,
  onCreateThread,
  onSelectThread,
  onRenameThread,
  onDeleteThread,
  onRemoveProject,
  onSidebarWidthChange,
  onSidebarWidthCommit,
}: ProjectSidebarProps) {
  const [dialog, setDialog] = useState<DialogState>();
  const [renameValue, setRenameValue] = useState("");
  const [renameError, setRenameError] = useState<string>();
  const [aboutOpen, setAboutOpen] = useState(false);
  const [dialogBusy, setDialogBusy] = useState(false);
  const dragRef = useRef<{ pointerId: number; startX: number; startWidth: number; latestWidth: number } | undefined>(
    undefined,
  );
  const selectedProject = projects.find(({ id }) => id === selectedProjectId);
  const visibleThreads =
    selectedProject === undefined ? [] : threads.filter(({ projectId }) => projectId === selectedProject.id);
  const fullWordmark = sidebarWidth >= 260;

  const resizeWithKeyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    let next: number | undefined;
    const step = event.shiftKey ? 16 : 4;
    if (event.key === "ArrowLeft") next = sidebarWidth - step;
    if (event.key === "ArrowRight") next = sidebarWidth + step;
    if (event.key === "Home") next = 232;
    if (event.key === "End") next = 360;
    if (next === undefined) return;
    event.preventDefault();
    const clamped = clampSidebarWidth(next);
    onSidebarWidthChange(clamped);
    void onSidebarWidthCommit(clamped);
  };
  const beginResize = (event: PointerEvent<HTMLDivElement>) => {
    if (disabled || event.button !== 0) return;
    const element = event.currentTarget;
    element.setPointerCapture?.(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: sidebarWidth,
      latestWidth: sidebarWidth,
    };
  };
  const continueResize = (event: PointerEvent<HTMLDivElement>) => {
    if (disabled) return;
    const drag = dragRef.current;
    if (drag === undefined || drag.pointerId !== event.pointerId) return;
    const next = clampSidebarWidth(drag.startWidth + event.clientX - drag.startX);
    drag.latestWidth = next;
    onSidebarWidthChange(next);
  };
  const endResize = (event: PointerEvent<HTMLDivElement>) => {
    if (disabled) {
      dragRef.current = undefined;
      return;
    }
    const drag = dragRef.current;
    if (drag === undefined || drag.pointerId !== event.pointerId) return;
    dragRef.current = undefined;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    void onSidebarWidthCommit(drag.latestWidth);
  };

  const openRename = (projectId: string, item: ThreadRecord) => {
    setRenameValue(item.title);
    setRenameError(undefined);
    setDialog({ type: "rename", projectId, threadId: item.id, title: item.title });
  };
  const createAndFocus = async (projectId: string) => {
    if (!(await onCreateThread(projectId))) return;
    queueMicrotask(() => document.querySelector<HTMLElement>(`[data-thread-id][aria-current="page"]`)?.focus());
  };
  const confirmRename = async () => {
    if (dialog?.type !== "rename") return;
    const title = renameValue.trim();
    if (title.length === 0 || title.length > 120) {
      setRenameError("Use a name between 1 and 120 characters.");
      return;
    }
    setDialogBusy(true);
    const saved = await onRenameThread(dialog.projectId, dialog.threadId, title);
    setDialogBusy(false);
    if (saved) setDialog(undefined);
    else setRenameError("RbxForge could not rename this local conversation. Try again.");
  };
  const confirmDelete = async () => {
    if (dialog?.type !== "delete") return;
    setDialogBusy(true);
    const removed = await onDeleteThread(dialog.projectId, dialog.threadId);
    setDialogBusy(false);
    if (removed) {
      setDialog(undefined);
      queueMicrotask(() => document.querySelector<HTMLElement>(`[data-project-id="${dialog.projectId}"]`)?.focus());
    }
  };
  const confirmRemove = async () => {
    if (dialog?.type !== "remove") return;
    setDialogBusy(true);
    const removed = await onRemoveProject(dialog.projectId);
    setDialogBusy(false);
    if (removed) {
      setDialog(undefined);
      queueMicrotask(() => {
        const nextTarget =
          document.querySelector<HTMLElement>("[data-project-id]") ??
          document.querySelector<HTMLElement>("[data-add-project]");
        nextTarget?.focus();
      });
    }
  };

  return (
    <aside aria-label="RbxForge projects" className={styles.sidebar}>
      <div className={[styles.brandStrip, "appDragRegion"].join(" ")}>
        <img
          alt="RbxForge"
          className={[fullWordmark ? styles.wordmark : styles.mark, "appNoDrag"].join(" ")}
          data-brand={fullWordmark ? "wordmark" : "mark"}
          draggable="false"
          src={fullWordmark ? wordmarkUrl : markUrl}
        />
      </div>
      <div className={styles.sidebarBody}>
        <div className={styles.sidebarActions}>
          <Button
            className={styles.addProject}
            data-add-project
            disabled={disabled}
            onClick={onAddProject}
            variant="secondary"
          >
            <Plus aria-hidden="true" size={16} />
            Add project
          </Button>
        </div>
        <nav aria-label="Projects and conversations" className={styles.navigation}>
          <div className={styles.projectList}>
            {projects.map((item) => {
              const selected = item.id === selectedProjectId;
              return (
                <div
                  className={[styles.projectGroup, selected && styles.selectedGroup].filter(Boolean).join(" ")}
                  key={item.id}
                >
                  <div className={styles.row}>
                    <button
                      aria-current={selected ? "page" : undefined}
                      className={styles.projectButton}
                      data-project-id={item.id}
                      disabled={disabled}
                      onClick={() => void onSelectProject(item.id)}
                      type="button"
                    >
                      <span className={styles.projectGlyph} aria-hidden="true">
                        {item.displayName.slice(0, 1).toUpperCase()}
                      </span>
                      <span className={styles.rowLabel}>{item.displayName}</span>
                      <span className={styles.connectionDot} aria-hidden="true" />
                    </button>
                    <MenuButton ariaLabel={`Actions for ${item.displayName}`}>
                      {selected ? <MenuItem onSelect={() => void createAndFocus(item.id)}>New chat</MenuItem> : null}
                      <MenuItem
                        onSelect={() =>
                          setDialog({ type: "remove", projectId: item.id, displayName: item.displayName })
                        }
                      >
                        Remove project
                      </MenuItem>
                    </MenuButton>
                  </div>
                  {selected ? (
                    <div className={styles.threadList}>
                      {visibleThreads.map((itemThread) => (
                        <div className={styles.row} key={itemThread.id}>
                          <button
                            aria-current={itemThread.id === selectedThreadId ? "page" : undefined}
                            className={styles.threadButton}
                            data-thread-id={itemThread.id}
                            disabled={disabled}
                            onClick={() => void onSelectThread(item.id, itemThread.id)}
                            type="button"
                          >
                            <span className={styles.threadLine} aria-hidden="true" />
                            <span className={styles.rowLabel}>{itemThread.title}</span>
                          </button>
                          <MenuButton ariaLabel={`Actions for ${itemThread.title}`}>
                            <MenuItem onSelect={() => openRename(item.id, itemThread)}>Rename</MenuItem>
                            <MenuItem
                              onSelect={() =>
                                setDialog({
                                  type: "delete",
                                  projectId: item.id,
                                  threadId: itemThread.id,
                                  title: itemThread.title,
                                })
                              }
                            >
                              Delete
                            </MenuItem>
                          </MenuButton>
                        </div>
                      ))}
                      {visibleThreads.length > 0 ? (
                        <button
                          aria-label="Create new chat"
                          className={styles.newThread}
                          disabled={disabled}
                          onClick={() => void createAndFocus(item.id)}
                          type="button"
                        >
                          <MessageSquarePlus aria-hidden="true" size={16} />
                          New chat
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </nav>
        <IconButton
          ariaLabel="About RbxForge"
          className={styles.aboutButton}
          icon={<Info />}
          onClick={() => setAboutOpen(true)}
        />
      </div>
      <div
        aria-label="Resize sidebar"
        aria-disabled={disabled || undefined}
        aria-orientation="vertical"
        aria-valuemax={360}
        aria-valuemin={232}
        aria-valuenow={sidebarWidth}
        className={[styles.resizeHandle, "appNoDrag"].join(" ")}
        onKeyDown={resizeWithKeyboard}
        onPointerCancel={endResize}
        onPointerDown={beginResize}
        onPointerMove={continueResize}
        onPointerUp={endResize}
        role="separator"
        tabIndex={disabled ? -1 : 0}
      />

      <Dialog
        description="Choose a clear local conversation name."
        onDismiss={() => setDialog(undefined)}
        open={dialog?.type === "rename"}
        title="Rename conversation"
      >
        <div className={styles.dialogForm}>
          <Input
            autoFocus
            {...(renameError === undefined ? {} : { error: renameError })}
            label="Conversation name"
            maxLength={120}
            onChange={(event) => {
              setRenameValue(event.currentTarget.value);
              setRenameError(undefined);
            }}
            value={renameValue}
          />
          <div className={styles.dialogActions}>
            <Button disabled={dialogBusy} onClick={() => setDialog(undefined)} variant="quiet">
              Cancel
            </Button>
            <Button loading={dialogBusy} onClick={() => void confirmRename()} variant="primary">
              Rename conversation
            </Button>
          </div>
        </div>
      </Dialog>
      <Dialog
        description="Project files are not changed."
        onDismiss={() => setDialog(undefined)}
        open={dialog?.type === "delete"}
        title="Delete conversation?"
      >
        <p className={styles.confirmCopy}>
          Delete <strong>{dialog?.type === "delete" ? dialog.title : ""}</strong>? This removes only this local
          conversation.
        </p>
        <div className={styles.dialogActions}>
          <Button disabled={dialogBusy} onClick={() => setDialog(undefined)} variant="quiet">
            Cancel
          </Button>
          <Button loading={dialogBusy} onClick={() => void confirmDelete()} variant="danger">
            Delete conversation
          </Button>
        </div>
      </Dialog>
      <Dialog
        description="Only RbxForge local data is removed."
        onDismiss={() => setDialog(undefined)}
        open={dialog?.type === "remove"}
        title="Remove project?"
      >
        <p className={styles.confirmCopy}>
          RbxForge removes local chats and settings for{" "}
          <strong>{dialog?.type === "remove" ? dialog.displayName : ""}</strong>. Your project files remain untouched.
        </p>
        <div className={styles.dialogActions}>
          <Button disabled={dialogBusy} onClick={() => setDialog(undefined)} variant="quiet">
            Cancel
          </Button>
          <Button loading={dialogBusy} onClick={() => void confirmRemove()} variant="danger">
            Remove from RbxForge
          </Button>
        </div>
      </Dialog>
      <AboutDialog onDismiss={() => setAboutOpen(false)} open={aboutOpen} />
    </aside>
  );
}
