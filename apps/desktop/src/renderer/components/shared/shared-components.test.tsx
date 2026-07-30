// @vitest-environment jsdom

import { createElement, StrictMode, useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Button, type ButtonProps } from "./Button";
import { Dialog } from "./Dialog";
import { EmptyState } from "./EmptyState";
import { IconButton, type IconButtonProps } from "./IconButton";
import { Input, type InputProps } from "./Input";
import { MenuButton, MenuItem } from "./Menu";
import { Sheet } from "./Sheet";
import { Skeleton } from "./Skeleton";
import { StatusChip } from "./StatusChip";
import { ToastRegion } from "./ToastRegion";

const icon = <svg data-testid="icon" />;

afterEach(cleanup);

describe("Button", () => {
  it("defaults to type button and disables activation while loading", async () => {
    const onClick = vi.fn();
    const { rerender } = render(<Button onClick={onClick}>Connect</Button>);
    const button = screen.getByRole<HTMLButtonElement>("button", { name: "Connect" });
    expect(button.type).toBe("button");
    expect(button.dataset.buttonVariant).toBe("secondary");
    rerender(
      <Button loading onClick={onClick}>
        Connect
      </Button>,
    );
    const loading = screen.getByRole("button", { name: "Connect" });
    expect(loading.getAttribute("aria-busy")).toBe("true");
    expect((loading as HTMLButtonElement).disabled).toBe(true);
    expect(loading.querySelector('[aria-hidden="true"]')?.textContent).toBe("Connect");
    await userEvent.click(loading);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("drops a runtime style escape hatch", () => {
    render(createElement(Button, { children: "Connect", style: { color: "red" } } as unknown as ButtonProps));
    expect(screen.getByRole("button", { name: "Connect" }).getAttribute("style")).toBeNull();
  });
});

describe("MenuButton", () => {
  function MenuHarness({ onDismiss = vi.fn() }: { onDismiss?: () => void }) {
    return (
      <>
        <button>Before</button>
        <MenuButton ariaLabel="Conversation actions" onDismiss={onDismiss}>
          <MenuItem onSelect={vi.fn()}>Rename</MenuItem>
          <MenuItem onSelect={vi.fn()}>Delete</MenuItem>
        </MenuButton>
        <button>After</button>
      </>
    );
  }

  it("supports Arrow keys, Home/End, Escape, and restores trigger focus", async () => {
    const user = userEvent.setup();
    render(<MenuHarness />);
    const trigger = screen.getByRole("button", { name: "Conversation actions" });
    trigger.focus();
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Rename" }));
    await user.keyboard("{End}");
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Delete" }));
    await user.keyboard("{Home}");
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Rename" }));
    await user.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Delete" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("dismisses outside exactly once and removes document listeners in StrictMode", async () => {
    const dismiss = vi.fn();
    const { unmount } = render(
      <StrictMode>
        <MenuHarness onDismiss={dismiss} />
      </StrictMode>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Conversation actions" }));
    fireEvent.pointerDown(document.body);
    expect(dismiss).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
    unmount();
    fireEvent.pointerDown(document.body);
    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it("keeps menu items as sibling controls rather than nesting buttons", async () => {
    render(<MenuHarness />);
    await userEvent.click(screen.getByRole("button", { name: "Conversation actions" }));
    expect(document.querySelector("button button")).toBeNull();
    expect(screen.getByRole("menu").querySelectorAll(":scope > button")).toHaveLength(2);
  });

  it("uses the browser top layer and one roving tab stop across nested and disabled items", async () => {
    render(
      <MenuButton ariaLabel="Layered actions">
        <MenuItem disabled onSelect={vi.fn()}>
          Disabled
        </MenuItem>
        <>
          <MenuItem onSelect={vi.fn()}>First</MenuItem>
          <MenuItem onSelect={vi.fn()}>Second</MenuItem>
        </>
      </MenuButton>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Layered actions" }));
    const menu = screen.getByRole("menu");
    expect(menu.dataset.topLayer).toBe("popover");
    const disabled = screen.getByRole<HTMLButtonElement>("menuitem", { name: "Disabled" });
    const first = screen.getByRole<HTMLButtonElement>("menuitem", { name: "First" });
    const second = screen.getByRole<HTMLButtonElement>("menuitem", { name: "Second" });
    expect(disabled.tabIndex).toBe(-1);
    expect(first.tabIndex).toBe(0);
    expect(second.tabIndex).toBe(-1);
    expect(document.activeElement).toBe(first);
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(second);
    expect(first.tabIndex).toBe(-1);
    expect(second.tabIndex).toBe(0);
  });

  it("opens and cleans up a native popover top layer when the browser provides it", async () => {
    const prototype = HTMLElement.prototype as HTMLElement & {
      showPopover?: () => void;
      hidePopover?: () => void;
    };
    const originalShow = Object.getOwnPropertyDescriptor(prototype, "showPopover");
    const originalHide = Object.getOwnPropertyDescriptor(prototype, "hidePopover");
    const showPopover = vi.fn();
    const hidePopover = vi.fn();
    Object.defineProperty(prototype, "showPopover", { configurable: true, value: showPopover });
    Object.defineProperty(prototype, "hidePopover", { configurable: true, value: hidePopover });
    try {
      const view = render(<MenuHarness />);
      await userEvent.click(screen.getByRole("button", { name: "Conversation actions" }));
      const menu = document.querySelector<HTMLElement>('[role="menu"]');
      expect(menu?.getAttribute("popover")).toBe("manual");
      expect(showPopover).toHaveBeenCalledTimes(1);
      view.unmount();
      expect(hidePopover).toHaveBeenCalledTimes(1);
    } finally {
      if (originalShow) Object.defineProperty(prototype, "showPopover", originalShow);
      else Reflect.deleteProperty(prototype, "showPopover");
      if (originalHide) Object.defineProperty(prototype, "hidePopover", originalHide);
      else Reflect.deleteProperty(prototype, "hidePopover");
    }
  });

  it("dismisses on Tab in either direction and moves focus relative to the trigger", async () => {
    const user = userEvent.setup();
    render(<MenuHarness />);
    const trigger = screen.getByRole("button", { name: "Conversation actions" });
    await user.click(trigger);
    await user.keyboard("{Tab}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "After" }));

    trigger.focus();
    await user.keyboard("{ArrowDown}");
    await user.tab({ shift: true });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Before" }));
  });
});

describe("IconButton", () => {
  it("uses a non-empty accessible label and hides its icon", () => {
    render(<IconButton ariaLabel="Close" icon={icon} />);
    expect(screen.getByRole("button", { name: "Close" })).not.toBeNull();
    expect(screen.getByTestId("icon").parentElement?.getAttribute("aria-hidden")).toBe("true");
  });

  it("rejects an empty runtime label", () => {
    expect(() => render(<IconButton ariaLabel={""} icon={icon} />)).toThrow(/non-empty/i);
  });

  it("drops a runtime style escape hatch", () => {
    render(
      createElement(IconButton, {
        ariaLabel: "Close",
        icon,
        style: { color: "red" },
      } as unknown as IconButtonProps<"Close">),
    );
    expect(screen.getByRole("button", { name: "Close" }).getAttribute("style")).toBeNull();
  });
});

describe("Input", () => {
  it("associates its label, help text, and error text", () => {
    const { rerender } = render(<Input label="Project name" help="Shown in the sidebar" />);
    const input = screen.getByRole("textbox", { name: "Project name" });
    expect(document.getElementById(input.getAttribute("aria-describedby")!)?.textContent).toBe("Shown in the sidebar");
    rerender(<Input label="Project name" error="A name is required" />);
    expect(document.getElementById(input.getAttribute("aria-describedby")!)?.textContent).toBe("A name is required");
    expect(input.getAttribute("aria-invalid")).toBe("true");
  });

  it("drops a runtime style escape hatch", () => {
    render(
      createElement(Input, {
        label: "Project name",
        style: { color: "red" },
      } as unknown as InputProps),
    );
    expect(screen.getByRole("textbox", { name: "Project name" }).getAttribute("style")).toBeNull();
  });
});

function DialogHarness({ zeroFocusable = false }: { zeroFocusable?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Open dialog</button>
      <Dialog
        open={open}
        title="Delete project?"
        description="The folder remains on disk."
        onDismiss={() => setOpen(false)}
      >
        {zeroFocusable ? <p>Nothing to focus</p> : <button>Cancel</button>}
      </Dialog>
    </>
  );
}

describe("Dialog", () => {
  it("names, initially focuses, traps both directions, dismisses once, and restores focus", async () => {
    const user = userEvent.setup();
    render(<DialogHarness />);
    const opener = screen.getByRole("button", { name: "Open dialog" });
    await user.click(opener);
    const dialog = screen.getByRole("dialog", { name: "Delete project?" });
    const cancel = screen.getByRole("button", { name: "Cancel" });
    expect(document.getElementById(dialog.getAttribute("aria-describedby")!)?.textContent).toBe(
      "The folder remains on disk.",
    );
    expect(document.activeElement).toBe(cancel);
    await user.tab();
    expect(document.activeElement).toBe(cancel);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(cancel);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("falls back to focusing the dialog when there are no focusable descendants", async () => {
    const user = userEvent.setup();
    render(<DialogHarness zeroFocusable />);
    await user.click(screen.getByRole("button", { name: "Open dialog" }));
    expect(document.activeElement).toBe(screen.getByRole("dialog"));
  });

  it("ignores focus candidates hidden by any ancestor state", () => {
    render(
      <Dialog open title="Hidden controls" onDismiss={vi.fn()}>
        <div hidden>
          <button>Hidden attribute</button>
        </div>
        <div aria-hidden="true">
          <button>Aria hidden</button>
        </div>
        <div inert>
          <button>Inert control</button>
        </div>
        <div style={{ display: "none" }}>
          <button>Display none</button>
        </div>
        <div style={{ visibility: "hidden" }}>
          <button>Visibility hidden</button>
        </div>
        <button>Visible control</button>
      </Dialog>,
    );
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Visible control" }));
  });

  it("recovers forward and reverse tab focus when focus escapes the modal", () => {
    render(
      <>
        <button data-testid="outside-focus">Outside</button>
        <Dialog open title="Focus recovery" onDismiss={vi.fn()}>
          <button>First action</button>
          <button>Last action</button>
        </Dialog>
      </>,
    );
    const outside = screen.getByTestId("outside-focus");
    outside.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "First action" }));
    outside.focus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Last action" }));
  });

  it("handles cancel and outside click exactly once with listener cleanup in StrictMode", () => {
    const dismiss = vi.fn();
    const { rerender, unmount } = render(
      <StrictMode>
        <Dialog open title="Settings" onDismiss={dismiss}>
          <button>Save</button>
        </Dialog>
      </StrictMode>,
    );
    const dialog = screen.getByRole("dialog");
    fireEvent(dialog, new Event("cancel", { bubbles: true, cancelable: true }));
    expect(dismiss).toHaveBeenCalledTimes(1);
    dismiss.mockClear();
    fireEvent.mouseDown(dialog);
    expect(dismiss).toHaveBeenCalledTimes(1);
    rerender(
      <StrictMode>
        <Dialog open={false} title="Settings" onDismiss={dismiss}>
          <button>Save</button>
        </Dialog>
      </StrictMode>,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(dismiss).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("feature-detects native dialog methods and cleans up both native and fallback modes", () => {
    const prototype = HTMLDialogElement.prototype;
    const originalShowModal = Object.getOwnPropertyDescriptor(prototype, "showModal");
    const originalClose = Object.getOwnPropertyDescriptor(prototype, "close");
    const showModal = vi.fn(function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    });
    const close = vi.fn(function (this: HTMLDialogElement) {
      this.removeAttribute("open");
    });
    Object.defineProperty(prototype, "showModal", { configurable: true, value: showModal });
    Object.defineProperty(prototype, "close", { configurable: true, value: close });
    const native = render(
      <>
        <main data-testid="native-background">Background</main>
        <Dialog open title="Native dialog" onDismiss={vi.fn()}>
          <button>Done</button>
        </Dialog>
      </>,
    );
    const nativeElement = screen.getByRole("dialog");
    expect(showModal).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("native-background").hasAttribute("inert")).toBe(false);
    native.unmount();
    expect(close).toHaveBeenCalledTimes(1);
    expect(nativeElement.hasAttribute("open")).toBe(false);

    Object.defineProperty(prototype, "showModal", { configurable: true, value: undefined });
    Object.defineProperty(prototype, "close", { configurable: true, value: undefined });
    const fallback = render(
      <>
        <main aria-hidden="false" data-testid="fallback-background">
          Background
        </main>
        <Dialog open title="Fallback dialog" onDismiss={vi.fn()}>
          <button>Done</button>
        </Dialog>
      </>,
    );
    const fallbackElement = screen.getByRole("dialog");
    const fallbackBackground = screen.getByTestId("fallback-background");
    expect(fallbackElement.hasAttribute("open")).toBe(true);
    expect(fallbackBackground.hasAttribute("inert")).toBe(true);
    expect(fallbackBackground.getAttribute("aria-hidden")).toBe("true");
    fallback.unmount();
    expect(fallbackElement.hasAttribute("open")).toBe(false);
    expect(fallbackBackground.hasAttribute("inert")).toBe(false);
    expect(fallbackBackground.getAttribute("aria-hidden")).toBe("false");

    if (originalShowModal) Object.defineProperty(prototype, "showModal", originalShowModal);
    else Reflect.deleteProperty(prototype, "showModal");
    if (originalClose) Object.defineProperty(prototype, "close", originalClose);
    else Reflect.deleteProperty(prototype, "close");
  });
});

describe("Sheet", () => {
  it("has modal semantics and supports Escape, outside dismissal, and focus restoration", async () => {
    const user = userEvent.setup();
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>Connect</button>
          <Sheet open={open} title="Connection setup" onDismiss={() => setOpen(false)}>
            <button>Continue</button>
          </Sheet>
        </>
      );
    }
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Connect" });
    await user.click(opener);
    const sheet = screen.getByRole("dialog", { name: "Connection setup" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Continue" }));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Continue" }));
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Continue" }));
    fireEvent.mouseDown(sheet.parentElement!);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("traverses visible native summary controls in both directions without jumping to the close control", () => {
    render(
      <Sheet closeLabel="Close connection" open title="Connection setup" onDismiss={vi.fn()}>
        <details hidden>
          <summary>Hidden details</summary>
        </details>
        <details>
          <summary tabIndex={-1}>Skipped details</summary>
        </details>
        <details>
          <summary>Project identity details</summary>
        </details>
        <button>Final action</button>
      </Sheet>,
    );
    const close = screen.getByRole("button", { name: "Close connection" });
    const summary = screen.getByText("Project identity details");
    const finalAction = screen.getByRole("button", { name: "Final action" });
    const traverse = (from: HTMLElement, to: HTMLElement, shiftKey = false) => {
      from.focus();
      const defaultAllowed = fireEvent.keyDown(document, { key: "Tab", shiftKey });
      if (defaultAllowed) to.focus();
      expect(document.activeElement).toBe(to);
    };

    expect(document.activeElement).toBe(close);
    traverse(close, summary);
    traverse(summary, finalAction);
    traverse(finalAction, summary, true);
    traverse(summary, close, true);
  });

  it("focuses a zero-control sheet fallback and dismisses with Escape", async () => {
    const user = userEvent.setup();
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>Open details</button>
          <Sheet open={open} title="Details" onDismiss={() => setOpen(false)}>
            <p>No actions required.</p>
          </Sheet>
        </>
      );
    }
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Open details" });
    await user.click(opener);
    const sheet = screen.getByRole("dialog", { name: "Details" });
    expect(document.activeElement).toBe(sheet);
    opener.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(sheet);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("inerts outside branches while open and restores their exact prior state", async () => {
    const user = userEvent.setup();
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <main aria-hidden="false" data-testid="background">
            <button onClick={() => setOpen(true)}>Open sheet</button>
          </main>
          <aside aria-hidden="true" data-testid="already-hidden" inert />
          <Sheet open={open} title="Modal sheet" onDismiss={() => setOpen(false)}>
            <button>Done</button>
          </Sheet>
        </>
      );
    }
    render(
      <StrictMode>
        <Harness />
      </StrictMode>,
    );
    const background = screen.getByTestId("background");
    const alreadyHidden = screen.getByTestId("already-hidden");
    await user.click(screen.getByRole("button", { name: "Open sheet" }));
    expect(background.hasAttribute("inert")).toBe(true);
    expect(background.getAttribute("aria-hidden")).toBe("true");
    expect(alreadyHidden.hasAttribute("inert")).toBe(true);
    expect(alreadyHidden.getAttribute("aria-hidden")).toBe("true");
    await user.keyboard("{Escape}");
    expect(background.hasAttribute("inert")).toBe(false);
    expect(background.getAttribute("aria-hidden")).toBe("false");
    expect(alreadyHidden.hasAttribute("inert")).toBe(true);
    expect(alreadyHidden.getAttribute("aria-hidden")).toBe("true");
  });
});

it("communicates status with text and icon and reserves the keyline for Studio bound", () => {
  const { rerender } = render(<StatusChip status="ready" label="Rojo ready" />);
  expect(screen.getByText("Rojo ready").closest("[data-status]")?.getAttribute("data-studio-bound")).toBe("false");
  expect(screen.getByText("Rojo ready").parentElement?.querySelector('[aria-hidden="true"]')).not.toBeNull();
  rerender(<StatusChip status="studio-bound" label="Studio bound" />);
  expect(screen.getByText("Studio bound").closest("[data-status]")?.getAttribute("data-studio-bound")).toBe("true");
});

it.each(["", "   ", "\n\t"])("rejects an empty visible status label %#", (label) => {
  expect(() => render(<StatusChip status="ready" label={label} />)).toThrow(/non-empty/i);
});

it("uses concise semantic empty, skeleton, and dismissible toast states", async () => {
  const dismiss = vi.fn();
  render(
    <>
      <EmptyState title="No projects yet" action={<Button>Add project</Button>}>
        Add a Roblox project to begin.
      </EmptyState>
      <Skeleton variant="project-row" />
      <ToastRegion
        onDismiss={dismiss}
        toasts={[
          { id: "1", tone: "success", message: "Port copied" },
          { id: "2", tone: "error", message: "Copy failed" },
        ]}
      />
    </>,
  );
  expect(screen.getByRole("heading", { name: "No projects yet" })).not.toBeNull();
  expect(screen.getByTestId("skeleton").getAttribute("aria-hidden")).toBe("true");
  expect(screen.getByRole("status").textContent).toContain("Port copied");
  expect(screen.getByRole("alert").textContent).toContain("Copy failed");
  expect(screen.getAllByText("Port copied")).toHaveLength(1);
  expect(screen.getAllByText("Copy failed")).toHaveLength(1);
  await userEvent.click(screen.getByRole("button", { name: "Dismiss Port copied" }));
  expect(dismiss).toHaveBeenCalledWith("1");
});
