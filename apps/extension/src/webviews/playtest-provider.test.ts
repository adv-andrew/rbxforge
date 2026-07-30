import { PlaytestController } from "@rbxforge/core";
import { expect, test, vi } from "vitest";

import { PlaytestProvider } from "./playtest-provider.js";

test("preserves role cursors and exposes bounded real log rows", async () => {
  const cursors: unknown[] = [];
  const controller = new PlaytestController({
    instanceId: "place:1",
    capability: {
      start: async () => ({ success: true, action: "start", message: "ready", roles: ["server"] }),
      stop: async () => ({ success: true, action: "stop", message: "stopped" }),
      status: async () => ({ success: true, action: "status", running: true, roles: ["server"] }),
      logs: async (cursor) => {
        cursors.push(cursor);
        return {
          entries: [{ seq: 8, ts: 10, level: "INFO", message: "literal [ok]", capturedBy: "server" }],
          totalDropped: 1,
          perCaptureNextSince: { server: 8 },
          perCaptureErrors: {},
        };
      },
      screenshot: async () => {
        throw new Error("not used");
      },
    },
  });
  const provider = new PlaytestProvider({
    controller,
    availability: { lifecycle: true, logs: true, screenshot: false },
    now: () => 10,
  });

  await provider.pollLogs("[ok]", new AbortController().signal);
  await provider.pollLogs(undefined, new AbortController().signal);

  expect(cursors).toEqual([undefined, { server: 8 }]);
  expect(provider.snapshot()).toMatchObject({
    instanceId: "place:1",
    cursor: { server: 8 },
    totalDropped: 1,
    entries: [
      { message: "literal [ok]", capturedBy: "server" },
      { message: "literal [ok]", capturedBy: "server" },
    ],
  });
});

test("never invokes a missing controller and reports a precise capability error", async () => {
  const provider = new PlaytestProvider({
    controller: undefined,
    availability: {
      lifecycle: false,
      logs: false,
      screenshot: false,
      reason: "Studio MCP capability unavailable: soloPlaytest",
    },
  });
  await expect(provider.start("play", new AbortController().signal)).rejects.toThrow("soloPlaytest");
  expect(provider.snapshot().capabilities.reason).toContain("soloPlaytest");
  expect(vi.isMockFunction(provider.snapshot)).toBe(false);
});

test("filter changes never discard fetched rows while advancing the cursor", () => {
  const provider = new PlaytestProvider({
    controller: undefined,
    availability: { lifecycle: false, logs: true, screenshot: false },
  });
  provider.acceptLogs(
    {
      entries: [
        { seq: 1, ts: 1, level: "INFO", message: "alpha", capturedBy: "server" },
        { seq: 2, ts: 2, level: "INFO", message: "beta", capturedBy: "server" },
      ],
      totalDropped: 0,
      perCaptureNextSince: { server: 2 },
      perCaptureErrors: {},
    },
    "alpha",
  );

  expect(provider.snapshot().entries.map(({ message }) => message)).toEqual(["alpha", "beta"]);
  expect(provider.snapshot().cursor).toEqual({ server: 2 });
});

test("accumulates local ring drops across repeated overflow and retains newest rows", () => {
  const provider = new PlaytestProvider({
    controller: undefined,
    availability: { lifecycle: false, logs: true, screenshot: false },
  });
  const batch = (offset: number) => ({
    entries: Array.from({ length: 2_001 }, (_, index) => ({
      seq: offset + index,
      ts: offset + index,
      level: "INFO" as const,
      message: `row-${offset + index}`,
      capturedBy: "server",
    })),
    totalDropped: 0,
    perCaptureNextSince: { server: offset + 2_000 },
    perCaptureErrors: {},
  });
  provider.acceptLogs(batch(0));
  provider.acceptLogs(batch(2_001));

  const snapshot = provider.snapshot();
  expect(snapshot.entries).toHaveLength(2_000);
  expect(snapshot.entries[0]?.message).toBe("row-2002");
  expect(snapshot.entries.at(-1)?.message).toBe("row-4001");
  expect(snapshot.totalDropped).toBe(2_002);
});

test("clears rows and cursors when the runtime generation advances", async () => {
  const controller = new PlaytestController({
    instanceId: "place:1",
    capability: {
      start: async () => ({ success: true, action: "start", message: "ready", roles: ["server"] }),
      stop: async () => ({ success: true, action: "stop", message: "stopped" }),
      status: async () => ({ success: true, action: "status", running: false, roles: [] }),
      logs: async () => ({
        entries: [],
        totalDropped: 0,
        perCaptureNextSince: {},
        perCaptureErrors: {},
      }),
      screenshot: async () => {
        throw new Error("not used");
      },
    },
  });
  const provider = new PlaytestProvider({
    controller,
    availability: { lifecycle: true, logs: true, screenshot: false },
  });
  provider.acceptLogs({
    entries: [{ seq: 1, ts: 1, level: "INFO", message: "old", capturedBy: "server" }],
    totalDropped: 0,
    perCaptureNextSince: { server: 1 },
    perCaptureErrors: {},
  });

  await controller.start("play", new AbortController().signal);
  expect(provider.snapshot().entries).toEqual([]);
  expect(provider.snapshot().cursor).toBeUndefined();

  provider.acceptLogs({
    entries: [{ seq: 1, ts: 2, level: "INFO", message: "new", capturedBy: "server" }],
    totalDropped: 0,
    perCaptureNextSince: { server: 1 },
    perCaptureErrors: {},
  });
  expect(provider.snapshot().entries.map(({ message }) => message)).toEqual(["new"]);
});

test("surfaces a fixed poll failure without exposing the external error", async () => {
  const controller = new PlaytestController({
    instanceId: "place:1",
    capability: {
      start: async () => ({ success: true, action: "start", message: "ready" }),
      stop: async () => ({ success: true, action: "stop", message: "stopped" }),
      status: async () => ({ success: true, action: "status", running: true, roles: ["server"] }),
      logs: async () => {
        throw new Error("SECRET_process_output");
      },
      screenshot: async () => {
        throw new Error("not used");
      },
    },
  });
  const provider = new PlaytestProvider({
    controller,
    availability: { lifecycle: true, logs: true, screenshot: false },
  });

  await expect(provider.pollLogs(undefined, new AbortController().signal)).rejects.toThrow();
  expect(provider.snapshot().error).toBe("Runtime log capture failed");
  expect(JSON.stringify(provider.snapshot())).not.toContain("SECRET_process_output");
});

test("evicts only a restarted role before appending regressed sequence rows", () => {
  const provider = new PlaytestProvider({
    controller: undefined,
    availability: { lifecycle: false, logs: true, screenshot: false },
  });
  provider.acceptLogs({
    entries: [
      { seq: 1, ts: 1, level: "INFO", message: "old-server", capturedBy: "server" },
      { seq: 1, ts: 1, level: "INFO", message: "client", capturedBy: "client-1" },
    ],
    totalDropped: 0,
    perCaptureNextSince: { server: 10, "client-1": 8 },
    perCaptureErrors: {},
  });
  provider.acceptLogs({
    entries: [{ seq: 1, ts: 20, level: "INFO", message: "new-server", capturedBy: "server" }],
    totalDropped: 0,
    perCaptureNextSince: { server: 2, "client-1": 8 },
    perCaptureErrors: {},
  });

  expect(provider.snapshot().entries.map(({ message }) => message)).toEqual(["client", "new-server"]);
});
