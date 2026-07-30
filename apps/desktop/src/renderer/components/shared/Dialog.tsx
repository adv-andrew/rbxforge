import { type MouseEvent, type ReactNode, useEffect, useId, useRef } from "react";

import styles from "./Dialog.module.css";
import { useModalFocus } from "./modal-utils.js";

export interface DialogProps {
  children: ReactNode;
  description?: string;
  onDismiss: () => void;
  open: boolean;
  title: string;
}

export function Dialog({ children, description, onDismiss, open, title }: DialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const nativeModalSupported =
    typeof HTMLDialogElement !== "undefined" && typeof HTMLDialogElement.prototype.showModal === "function";

  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (typeof dialog.showModal === "function") {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.setAttribute("open", "");
    }
    return () => {
      if (dialog.open && typeof dialog.close === "function") dialog.close();
      else dialog.removeAttribute("open");
    };
  }, [open]);
  useModalFocus(open, dialogRef, onDismiss, !nativeModalSupported);

  if (!open) return null;

  const dismissOutside = (event: MouseEvent<HTMLDialogElement>) => {
    if (event.target === event.currentTarget) onDismiss();
  };

  return (
    <dialog
      aria-describedby={description ? descriptionId : undefined}
      aria-labelledby={titleId}
      aria-modal="true"
      className={styles.dialog}
      onCancel={(event) => {
        event.preventDefault();
        onDismiss();
      }}
      onMouseDown={dismissOutside}
      ref={dialogRef}
      tabIndex={-1}
    >
      <section className={styles.dialogPanel}>
        <header className={styles.header}>
          <h2 id={titleId}>{title}</h2>
          {description ? <p id={descriptionId}>{description}</p> : null}
        </header>
        <div className={styles.content}>{children}</div>
      </section>
    </dialog>
  );
}
