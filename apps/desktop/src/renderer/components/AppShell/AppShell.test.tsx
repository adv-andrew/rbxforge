// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { AppShell } from "./AppShell.js";

afterEach(cleanup);

const baseProps = {
  header: <span>Header</span>,
  main: <span>Conversation body</span>,
  sidebar: <span>Projects</span>,
  sidebarWidth: 272,
};

describe("AppShell", () => {
  it("keeps its original landmarks and skip navigation when no inspector is supplied", () => {
    render(<AppShell {...baseProps} />);

    expect(screen.getByRole("main", { name: "Conversation" })).not.toBeNull();
    expect(screen.getByRole("banner", { name: "Project status" })).not.toBeNull();
    expect(screen.queryByRole("complementary", { name: "Studio inspector" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Skip to Studio inspector" })).toBeNull();
  });

  it("places an optional inspector beside the main region with a direct skip link", () => {
    render(<AppShell {...baseProps} inspector={<span>Inspector body</span>} />);

    const inspector = screen.getByRole("complementary", { name: "Studio inspector" });
    expect(inspector.textContent).toContain("Inspector body");
    expect(inspector.getAttribute("id")).toBe("studio-inspector");
    expect(screen.getByRole("link", { name: "Skip to Studio inspector" }).getAttribute("href")).toBe(
      "#studio-inspector",
    );
  });
});
