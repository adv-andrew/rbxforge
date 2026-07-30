import { type MouseEvent, type ReactNode, useId, useRef } from "react";
import { X } from "lucide-react";

import { IconButton } from "./IconButton.js";
import styles from "./Sheet.module.css";
import { useModalFocus } from "./modal-utils.js";

export interface SheetProps {
  children: ReactNode;
  closeLabel?: string;
  description?: string;
  footer?: ReactNode;
  onDismiss: () => void;
  open: boolean;
  title: string;
}

export function Sheet({ children, closeLabel, description, footer, onDismiss, open, title }: SheetProps) {
  const sheetRef = useRef<HTMLElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  useModalFocus(open, sheetRef, onDismiss, true);
  if (!open) return null;

  const dismissOutside = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) onDismiss();
  };

  return (
    <div className={styles.overlay} onMouseDown={dismissOutside}>
      <section
        aria-describedby={description ? descriptionId : undefined}
        aria-labelledby={titleId}
        aria-modal="true"
        className={styles.sheet}
        ref={sheetRef}
        role="dialog"
        tabIndex={-1}
      >
        {closeLabel === undefined ? null : (
          <IconButton
            ariaLabel={closeLabel}
            className={styles.close}
            icon={<X aria-hidden="true" size={16} strokeWidth={1.8} />}
            onClick={onDismiss}
          />
        )}
        <header className={styles.header}>
          <h2 id={titleId}>{title}</h2>
          {description ? <p id={descriptionId}>{description}</p> : null}
        </header>
        <div className={styles.content} data-sheet-scroll-region="true">
          {children}
        </div>
        {footer}
      </section>
    </div>
  );
}
