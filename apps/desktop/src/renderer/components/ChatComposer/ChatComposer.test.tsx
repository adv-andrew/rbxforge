// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

import { ChatComposer } from "./ChatComposer.js";

afterEach(cleanup);

it("uses exact local-only labels and never shows AI progress", () => {
  render(<ChatComposer content="" onChange={vi.fn()} onSave={vi.fn()} />);
  expect(screen.getByText("AI provider not configured")).not.toBeNull();
  expect(screen.getByRole("button", { name: "Save prompt" })).not.toBeNull();
  expect(screen.queryByText(/send|generate|thinking|model/i)).toBeNull();
});

it("saves once for Cmd/Ctrl+Enter and ignores repeats, composition, whitespace, and in-flight state", async () => {
  const save = vi.fn();
  const view = render(<ChatComposer content="local prompt" onChange={vi.fn()} onSave={save} />);
  const composer = screen.getByRole("textbox", { name: "Local project prompt" });
  fireEvent.keyDown(composer, { key: "Enter", metaKey: true });
  fireEvent.keyDown(composer, { key: "Enter", metaKey: true, repeat: true });
  fireEvent.keyDown(composer, { key: "Enter", ctrlKey: true, isComposing: true });
  expect(save).toHaveBeenCalledTimes(1);

  view.rerender(<ChatComposer content="   " onChange={vi.fn()} onSave={save} />);
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter", ctrlKey: true });
  view.rerender(<ChatComposer content="blocked" disabled onChange={vi.fn()} onSave={save} />);
  await userEvent.click(screen.getByRole("button", { name: "Save prompt" }));
  expect(save).toHaveBeenCalledTimes(1);
});

it("enforces the 100,000-character host bound in the textarea and submit path", () => {
  const save = vi.fn();
  render(<ChatComposer content={"a".repeat(100_001)} onChange={vi.fn()} onSave={save} />);
  const composer = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Local project prompt" });
  expect(composer.maxLength).toBe(100_000);
  fireEvent.keyDown(composer, { key: "Enter", metaKey: true });
  expect(save).not.toHaveBeenCalled();
  expect(screen.getByText(/100,000 characters or fewer/i)).not.toBeNull();
});

it("keeps the textarea editable while only submission is blocked", () => {
  const change = vi.fn();
  render(<ChatComposer content="pending" submitDisabled onChange={change} onSave={vi.fn()} />);
  const composer = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Local project prompt" });
  expect(composer.disabled).toBe(false);
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Save prompt" }).disabled).toBe(true);
  fireEvent.change(composer, { target: { value: "pending plus" } });
  expect(change).toHaveBeenCalledWith("pending plus");
});
