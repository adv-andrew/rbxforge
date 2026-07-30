import {
  createContext,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import styles from "./Menu.module.css";

interface MenuContextValue {
  activate(item: HTMLButtonElement): void;
  register(item: HTMLButtonElement): () => void;
  select(run: () => void): void;
}

const MenuContext = createContext<MenuContextValue | undefined>(undefined);

export interface MenuButtonProps {
  readonly ariaLabel: string;
  readonly children: ReactNode;
  readonly onDismiss?: () => void;
}

export function MenuButton({ ariaLabel, children, onDismiss }: MenuButtonProps) {
  const supportsPopover = typeof HTMLElement !== "undefined" && typeof HTMLElement.prototype.showPopover === "function";
  const [open, setOpen] = useState(false);
  const openRef = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemsRef = useRef<HTMLButtonElement[]>([]);
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;

  const dismiss = useCallback((restoreFocus: boolean) => {
    if (!openRef.current) return;
    openRef.current = false;
    setOpen(false);
    dismissRef.current?.();
    if (restoreFocus) queueMicrotask(() => triggerRef.current?.focus());
  }, []);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) dismiss(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [dismiss, open]);

  useLayoutEffect(() => {
    if (!open) return;
    const menu = menuRef.current as (HTMLDivElement & { showPopover?: () => void; hidePopover?: () => void }) | null;
    if (menu === null || typeof menu.showPopover !== "function") return;
    try {
      menu.showPopover();
    } catch {
      // A detached or already-open popover is harmless during StrictMode replay.
    }
    return () => {
      try {
        menu.hidePopover?.();
      } catch {
        // The browser may already have removed the element from the top layer.
      }
    };
  }, [open]);

  const enabledItems = useCallback(() => itemsRef.current.filter((item) => item.isConnected && !item.disabled), []);
  const activate = useCallback((item: HTMLButtonElement) => {
    for (const candidate of itemsRef.current) candidate.tabIndex = candidate === item && !item.disabled ? 0 : -1;
  }, []);
  const focusAt = useCallback(
    (index: number) => {
      const items = enabledItems();
      const target = items.at(index);
      if (target === undefined) return;
      activate(target);
      target.focus();
    },
    [activate, enabledItems],
  );
  const openAndFocus = (last: boolean) => {
    itemsRef.current = [];
    openRef.current = true;
    setOpen(true);
    queueMicrotask(() => focusAt(last ? -1 : 0));
  };
  const focusOutsideTrigger = (reverse: boolean) => {
    const trigger = triggerRef.current;
    if (trigger === null) return;
    const focusable = [
      ...document.querySelectorAll<HTMLElement>(
        'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])',
      ),
    ].filter(
      (element) =>
        element.isConnected &&
        !element.hasAttribute("disabled") &&
        !element.closest('[inert], [aria-hidden="true"]') &&
        !menuRef.current?.contains(element),
    );
    const index = focusable.indexOf(trigger);
    focusable[index + (reverse ? -1 : 1)]?.focus();
  };
  const onTriggerKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    openAndFocus(event.key === "ArrowUp");
  };
  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = enabledItems();
    const current = items.findIndex((item) => item === document.activeElement);
    let next: number | undefined;
    if (event.key === "ArrowDown") next = current < 0 || current === items.length - 1 ? 0 : current + 1;
    if (event.key === "ArrowUp") next = current <= 0 ? items.length - 1 : current - 1;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = items.length - 1;
    if (event.key === "Escape") {
      event.preventDefault();
      dismiss(true);
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      const reverse = event.shiftKey;
      dismiss(false);
      queueMicrotask(() => focusOutsideTrigger(reverse));
      return;
    }
    if (next === undefined) return;
    event.preventDefault();
    const target = items[next];
    if (target !== undefined) {
      activate(target);
      target.focus();
    }
  };
  const context = useMemo<MenuContextValue>(
    () => ({
      activate,
      register(item) {
        if (!itemsRef.current.includes(item)) itemsRef.current.push(item);
        item.tabIndex = -1;
        return () => {
          itemsRef.current = itemsRef.current.filter((candidate) => candidate !== item);
        };
      },
      select(run) {
        dismiss(false);
        queueMicrotask(() => {
          triggerRef.current?.focus();
          run();
        });
      },
    }),
    [activate, dismiss],
  );

  return (
    <div className={[styles.root, "appNoDrag"].join(" ")} ref={rootRef}>
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={ariaLabel}
        className={styles.trigger}
        onClick={() => (open ? dismiss(false) : openAndFocus(false))}
        onKeyDown={onTriggerKeyDown}
        ref={triggerRef}
        type="button"
      >
        <svg aria-hidden="true" viewBox="0 0 16 16">
          <circle cx="3" cy="8" r="1.2" />
          <circle cx="8" cy="8" r="1.2" />
          <circle cx="13" cy="8" r="1.2" />
        </svg>
      </button>
      {open ? (
        <MenuContext.Provider value={context}>
          <div
            aria-label={ariaLabel}
            className={styles.menu}
            data-top-layer="popover"
            onKeyDown={onMenuKeyDown}
            {...(supportsPopover ? { popover: "manual" as const } : {})}
            ref={menuRef}
            role="menu"
          >
            {children}
          </div>
        </MenuContext.Provider>
      ) : null}
    </div>
  );
}

export interface MenuItemProps {
  readonly children: ReactNode;
  readonly disabled?: boolean;
  readonly onSelect: () => void;
}

export function MenuItem({ children, disabled = false, onSelect }: MenuItemProps) {
  const menu = useContext(MenuContext);
  const itemRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const item = itemRef.current;
    return item === null ? undefined : menu?.register(item);
  }, [menu]);
  if (menu === undefined) throw new Error("MenuItem must be rendered inside MenuButton.");
  return (
    <button
      className={styles.item}
      disabled={disabled}
      onClick={() => menu.select(onSelect)}
      onFocus={(event) => menu.activate(event.currentTarget)}
      ref={itemRef}
      role="menuitem"
      tabIndex={-1}
      type="button"
    >
      {children}
    </button>
  );
}
