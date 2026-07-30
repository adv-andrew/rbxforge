import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";

import { PlaytestView } from "./PlaytestView.js";

test("renders real lifecycle controls and literal-filtered runtime rows", () => {
  const start = vi.fn();
  const stop = vi.fn();
  const refresh = vi.fn();
  const poll = vi.fn();
  render(
    <PlaytestView
      snapshot={{
        instanceId: "place:1",
        state: "running",
        mode: "play",
        roles: ["server", "client-1"],
        runtimeGeneration: 1,
        observedAt: 10,
        capabilities: { lifecycle: true, logs: true, screenshot: true },
        entries: [
          { seq: 1, ts: 1, level: "OUT", message: "plain [value]", capturedBy: "server" },
          { seq: 2, ts: 2, level: "ERR", message: "other", capturedBy: "client-1" },
        ],
        totalDropped: 3,
        perCaptureErrors: {},
      }}
      onStart={start}
      onStop={stop}
      onRefresh={refresh}
      onPollLogs={poll}
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: "Stop" }));
  expect(stop).toHaveBeenCalledTimes(1);
  expect(screen.getByText(/3 runtime log rows were dropped/i)).toBeTruthy();
  expect(screen.getByText("captured by server")).toBeTruthy();
  fireEvent.change(screen.getByRole("searchbox", { name: "Filter runtime logs" }), {
    target: { value: "[value]" },
  });
  expect(screen.getByText("plain [value]")).toBeTruthy();
  expect(screen.queryByText("other")).toBeNull();
});

test("missing canonical lifecycle capability disables controls with a precise reason", () => {
  render(
    <PlaytestView
      snapshot={{
        state: "unknown",
        roles: [],
        runtimeGeneration: 0,
        observedAt: 10,
        capabilities: {
          lifecycle: false,
          logs: false,
          screenshot: false,
          reason: "Studio MCP capability unavailable: soloPlaytest",
        },
        entries: [],
        totalDropped: 0,
        perCaptureErrors: {},
      }}
      onStart={vi.fn()}
      onStop={vi.fn()}
      onRefresh={vi.fn()}
      onPollLogs={vi.fn()}
    />,
  );
  expect((screen.getByRole("button", { name: "Play" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText("Studio MCP capability unavailable: soloPlaytest")).toBeTruthy();
});
