import { type RefObject, useEffect, useRef } from "react";

const focusableSelector = [
  "button:not(:disabled)",
  "a[href]",
  "input:not(:disabled)",
  "select:not(:disabled)",
  "textarea:not(:disabled)",
  'details > summary:first-of-type:not([tabindex^="-"])',
  '[tabindex]:not([tabindex^="-"])',
].join(",");

function isHiddenByAncestor(element: HTMLElement, container: HTMLElement): boolean {
  let current: HTMLElement | null = element;
  while (current) {
    const computed = getComputedStyle(current);
    if (
      current.hidden ||
      current.hasAttribute("inert") ||
      current.getAttribute("aria-hidden") === "true" ||
      computed.display === "none" ||
      computed.visibility === "hidden" ||
      computed.visibility === "collapse"
    ) {
      return true;
    }
    if (current === container) return false;
    current = current.parentElement;
  }
  return true;
}

function focusableElements(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(focusableSelector)].filter(
    (element) => !isHiddenByAncestor(element, container),
  );
}

interface OutsideBranchState {
  ariaHidden: string | null;
  element: HTMLElement;
  inert: string | null;
}

function modalizeOutsideBranches(container: HTMLElement): () => void {
  const states: OutsideBranchState[] = [];
  let branch: HTMLElement = container;
  while (branch.parentElement) {
    const parent = branch.parentElement;
    for (const sibling of parent.children) {
      if (sibling === branch || !(sibling instanceof HTMLElement)) continue;
      states.push({
        ariaHidden: sibling.getAttribute("aria-hidden"),
        element: sibling,
        inert: sibling.getAttribute("inert"),
      });
      sibling.setAttribute("aria-hidden", "true");
      sibling.setAttribute("inert", "");
    }
    if (parent === document.body) break;
    branch = parent;
  }
  return () => {
    for (const { ariaHidden, element, inert } of states.reverse()) {
      if (ariaHidden === null) element.removeAttribute("aria-hidden");
      else element.setAttribute("aria-hidden", ariaHidden);
      if (inert === null) element.removeAttribute("inert");
      else element.setAttribute("inert", inert);
    }
  };
}

export function useModalFocus(
  open: boolean,
  containerRef: RefObject<HTMLElement | null>,
  onDismiss: () => void,
  modalizeOutside: boolean,
): void {
  const dismissRef = useRef(onDismiss);
  const openerRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);
  dismissRef.current = onDismiss;
  if (open !== wasOpenRef.current) {
    wasOpenRef.current = open;
    if (open) {
      openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    }
  }

  useEffect(() => {
    if (!open) return;
    const container = containerRef.current;
    if (!container) return;
    const opener = openerRef.current;
    const restoreOutside = modalizeOutside ? modalizeOutsideBranches(container) : () => undefined;
    const initial = focusableElements(container)[0] ?? container;
    initial.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        const nativeDialog = container instanceof HTMLDialogElement;
        const nativeModalSupported = nativeDialog && typeof container.showModal === "function" && container.open;
        if (!nativeModalSupported) {
          event.preventDefault();
          dismissRef.current();
        }
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = focusableElements(container);
      if (focusable.length === 0) {
        event.preventDefault();
        container.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const active = document.activeElement;
      const activeIsTrapped = active === container || (active instanceof HTMLElement && focusable.includes(active));
      if (!activeIsTrapped) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && (document.activeElement === first || document.activeElement === container)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === container)) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      restoreOutside();
      if (opener?.isConnected) {
        opener.focus();
        queueMicrotask(() => {
          if (opener.isConnected) opener.focus();
        });
      }
    };
  }, [containerRef, modalizeOutside, open]);
}
