import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";

import { ActivityView } from "./ActivityView.js";

test("renders real mutation and controller activity with exact source links only", () => {
  const open = vi.fn();
  render(
    <ActivityView
      entries={[
        {
          id: "m1",
          timestamp: "2026-07-28T00:00:00.000Z",
          instanceId: "place:1",
          operation: "property-write",
          result: "applied",
          verification: "verified",
          detail: "game.Workspace.Part.Anchored",
          sourcePath: "/project/src/Part.server.lua",
        },
        {
          id: "p1",
          timestamp: "2026-07-28T00:00:01.000Z",
          instanceId: "place:1",
          operation: "runtime.logs",
          result: "success",
          droppedLogs: 2,
        },
      ]}
      onOpenSource={open}
    />,
  );
  expect(screen.getByText("Verified")).toBeTruthy();
  expect(screen.getByText(/2 dropped logs/i)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Open source" }));
  expect(open).toHaveBeenCalledWith("m1");
});
