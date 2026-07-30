import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";

import type { PropertiesSnapshot } from "../protocol.js";
import { PropertiesView } from "./PropertiesView.js";

const snapshot: PropertiesSnapshot = {
  snapshotId: "snap-1",
  instanceId: "place:123",
  instancePath: "game.Workspace.Part",
  name: "Part",
  className: "Part",
  placeName: "Forge",
  ownership: "studio",
  freshness: "fresh",
  simulation: false,
  connected: true,
  observedAt: 100,
  properties: [
    {
      name: "Anchored",
      category: "Behavior",
      kind: "boolean",
      editable: true,
      liveValue: false,
      comparable: true,
    },
    {
      name: "Transparency",
      category: "Appearance",
      kind: "number",
      editable: true,
      liveValue: 0.25,
      declaredValue: 0.5,
      comparable: true,
      verification: "mismatch",
    },
    {
      name: "CFrame",
      category: "Transform",
      kind: "CFrame",
      editable: false,
      rawValue: "0,0,0,1,0,0,0,1,0,0,0,1",
      comparable: false,
      blockedReason: "Display-only",
    },
  ],
};

describe("PropertiesView", () => {
  test("renders instance identity, place, ownership, freshness, and simulation metadata", () => {
    render(<PropertiesView snapshot={snapshot} onPropose={vi.fn()} />);
    const header = screen.getByRole("banner");
    expect(header.textContent).toContain("Part");
    expect(header.textContent).toContain("Part");
    expect(header.textContent).toContain("game.Workspace.Part");
    expect(header.textContent).toContain("Forge");
    expect(header.textContent).toContain("studio");
    expect(header.textContent).toContain("fresh");
    expect(header.textContent).toContain("Live");
  });

  test("filters with slash and supports keyboard row focus", async () => {
    const user = userEvent.setup();
    render(<PropertiesView snapshot={snapshot} onPropose={vi.fn()} />);
    await user.keyboard("/");
    const filter = screen.getByRole("searchbox");
    expect(document.activeElement).toBe(filter);
    await user.type(filter, "Anchor");
    expect(screen.getByRole("row", { name: /Anchored/ })).toBeTruthy();
    expect(screen.queryByRole("row", { name: /Transparency/ })).toBeNull();
    await user.clear(filter);
    fireEvent.keyDown(filter, { key: "ArrowDown" });
    expect(document.activeElement?.getAttribute("data-property")).toBe("Anchored");
  });

  test("keeps typing local, applies once as a typed proposal, and Escape reverts", async () => {
    const user = userEvent.setup();
    const onPropose = vi.fn();
    render(
      <PropertiesView
        snapshot={{
          ...snapshot,
          properties: snapshot.properties.map((row) =>
            row.name === "Transparency" ? { ...row, declaredValue: row.liveValue } : row,
          ),
        }}
        onPropose={onPropose}
      />,
    );
    const row = screen.getByRole("row", { name: /Transparency/ });
    const input = within(row).getByRole("textbox");
    await user.clear(input);
    await user.type(input, "0.75");
    expect(onPropose).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
    expect(onPropose).toHaveBeenCalledTimes(1);
    expect(onPropose).toHaveBeenCalledWith({
      instanceId: "place:123",
      instancePath: "game.Workspace.Part",
      propertyName: "Transparency",
      snapshotId: "snap-1",
      value: 0.75,
      displayGeneration: 1,
    });
    await user.clear(input);
    await user.type(input, "0.9");
    fireEvent.keyDown(input, { key: "Escape" });
    expect((input as HTMLInputElement).value).toBe("0.25");
  });

  test("shows drift side by side and verification without optimistic green", () => {
    render(<PropertiesView snapshot={snapshot} onPropose={vi.fn()} />);
    const row = screen.getByRole("row", { name: /Transparency/ });
    expect(row.textContent).toContain("Drift");
    expect(row.textContent).toContain("Declared 0.5");
    expect(row.textContent).toContain("Live 0.25");
    expect(row.textContent).toContain("Mismatch");
    expect(row.textContent).not.toContain("Verified");
    expect((within(row).getByRole("button", { name: "Apply" }) as HTMLButtonElement).disabled).toBe(true);
  });

  test.each([
    { freshness: "stale" as const, ownership: "studio" as const, connected: true },
    { freshness: "unknown" as const, ownership: "studio" as const, connected: true },
    { freshness: "fresh" as const, ownership: "unknown" as const, connected: true },
    { freshness: "fresh" as const, ownership: "drift" as const, connected: true },
    { freshness: "fresh" as const, ownership: "studio" as const, connected: false },
  ])("disables Apply for blocked snapshot %#", (state) => {
    render(<PropertiesView snapshot={{ ...snapshot, ...state }} onPropose={vi.fn()} />);
    expect((screen.getAllByRole("button", { name: "Apply" })[0] as HTMLButtonElement).disabled).toBe(true);
  });

  test("shows the exact files-owned live-write warning and unsupported reason", () => {
    render(<PropertiesView snapshot={{ ...snapshot, ownership: "files" }} onPropose={vi.fn()} />);
    expect(screen.getByText("Session-only; Rojo may overwrite this")).toBeTruthy();
    expect(screen.getByRole("row", { name: /CFrame/ }).textContent).toContain("Display-only");
  });

  test("renders loading, disconnected, empty, approval, applying, and verification states", () => {
    const { rerender } = render(<PropertiesView onPropose={vi.fn()} />);
    expect(screen.getByText("Loading properties…")).toBeTruthy();
    rerender(<PropertiesView snapshot={{ ...snapshot, connected: false }} onPropose={vi.fn()} />);
    expect(screen.getByText("Studio disconnected")).toBeTruthy();
    rerender(<PropertiesView snapshot={{ ...snapshot, properties: [] }} onPropose={vi.fn()} />);
    expect(screen.getByText("No properties available")).toBeTruthy();
    rerender(
      <PropertiesView
        snapshot={{
          ...snapshot,
          properties: [
            { ...snapshot.properties[0]!, mutationState: "approval-pending", verification: "unverifiable" },
            { ...snapshot.properties[1]!, mutationState: "applying", verification: "verified" },
          ],
        }}
        onPropose={vi.fn()}
      />,
    );
    expect(screen.getByText("Approval pending")).toBeTruthy();
    expect(screen.getByText("Applying…")).toBeTruthy();
    expect(screen.getByText("Unverifiable")).toBeTruthy();
    expect(screen.getByText("Verified")).toBeTruthy();
  });
});
