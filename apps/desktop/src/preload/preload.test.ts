import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { CLOSE_ACKNOWLEDGEMENT_CHANNEL, CLOSE_REQUEST_CHANNEL, EVENT_CHANNEL, REQUEST_CHANNEL } from "../main/ipc.js";
import { createPreloadApi } from "./index.js";

describe("preload bridge", () => {
  it("exposes only the frozen request, subscription, and close-barrier API", () => {
    const exposed = createHarness().api;
    expect(Object.keys(exposed).sort()).toEqual([
      "onCloseBlocked",
      "onCloseRequest",
      "platform",
      "request",
      "subscribe",
    ]);
    expect(Object.isFrozen(exposed)).toBe(true);
    expect("ipcRenderer" in exposed).toBe(false);
    expect("send" in exposed).toBe(false);
    expect("env" in exposed).toBe(false);
    expect("token" in exposed).toBe(false);
  });

  it("generates the request id, uses one fixed channel, and validates the response", async () => {
    const harness = createHarness();
    const response = await harness.api.request({ type: "bootstrap" });
    expect(response).toMatchObject({ ok: true, requestId: "generated-id" });
    expect(harness.invocations).toEqual([
      [REQUEST_CHANNEL, { version: 1, requestId: "generated-id", type: "bootstrap" }],
    ]);
  });

  it("does not import Node builtins into the sandboxed preload bundle", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/from ["']node:/);
    expect(source).not.toContain("node:crypto");
  });

  it("fails closed before IPC when secure request identifiers are unavailable", async () => {
    const harness = createHarness(undefined, false);
    await expect(harness.api.request({ type: "bootstrap" })).rejects.toThrow(
      "Secure request identifiers are unavailable.",
    );
    expect(harness.invocations).toEqual([]);
  });

  it("rejects malformed outbound commands before IPC", async () => {
    const harness = createHarness();
    await expect(harness.api.request({ type: "bootstrap", token: "forged" } as never)).rejects.toBeDefined();
    expect(harness.invocations).toEqual([]);
  });

  it("turns malformed host responses into a bounded generic error instead of a Zod dump", async () => {
    const harness = createHarness(async () => ({ requestId: "generated-id", token: "super-secret" }));
    await expect(harness.api.request({ type: "bootstrap" })).rejects.toThrow("invalid data");
    await expect(harness.api.request({ type: "bootstrap" })).rejects.not.toThrow(/token|Zod|snapshot/);
  });

  it("rejects stale or unknown event shapes before listeners and removes the exact handler idempotently", () => {
    const harness = createHarness();
    const listener = vi.fn();
    const unsubscribe = harness.api.subscribe(listener);
    const handler = harness.handlers.get(EVENT_CHANNEL);
    expect(() => handler?.({}, { version: 1, type: "snapshot", snapshot: {}, extra: true })).toThrow();
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
    unsubscribe();
    expect(harness.removals).toEqual([[EVENT_CHANNEL, handler]]);
  });

  it("acknowledges a valid main close request only after the renderer flush settles", async () => {
    const harness = createHarness();
    let finish!: (ok: boolean) => void;
    const flush = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    const unsubscribe = harness.api.onCloseRequest(flush);
    const handler = harness.handlers.get(CLOSE_REQUEST_CHANNEL);
    handler?.({}, { version: 1, type: "draft-flush", requestId: "close-1" });
    await Promise.resolve();
    expect(flush).toHaveBeenCalledOnce();
    expect(harness.invocations).toEqual([]);

    finish(true);
    await vi.waitFor(() =>
      expect(harness.invocations).toEqual([
        [CLOSE_ACKNOWLEDGEMENT_CHANNEL, { version: 1, requestId: "close-1", ok: true }],
      ]),
    );
    unsubscribe();
    unsubscribe();
    expect(harness.removals).toEqual([[CLOSE_REQUEST_CHANNEL, handler]]);
  });

  it("delivers only strict healthy close-failure feedback and removes the exact listener", () => {
    const harness = createHarness();
    const listener = vi.fn();
    const onCloseBlocked = (
      harness.api as unknown as {
        readonly onCloseBlocked?: (listener: (reason: "save-failed" | "timeout") => void) => () => void;
      }
    ).onCloseBlocked;
    expect(onCloseBlocked).toBeTypeOf("function");
    if (onCloseBlocked === undefined) return;

    const unsubscribe = onCloseBlocked(listener);
    const handler = harness.handlers.get("rbxforge:close-feedback");
    handler?.({}, { version: 1, type: "close-blocked", reason: "save-failed", extra: true });
    handler?.({}, { version: 1, type: "close-blocked", reason: "save-failed" });
    handler?.({}, { version: 1, type: "close-blocked", reason: "timeout" });

    expect(listener.mock.calls).toEqual([["save-failed"], ["timeout"]]);
    unsubscribe();
    unsubscribe();
    expect(harness.removals).toEqual([["rbxforge:close-feedback", handler]]);
  });
});

function createHarness(
  invokeResult: (() => Promise<unknown>) | undefined = async () => ({
    version: 1,
    requestId: "generated-id",
    ok: true,
    snapshot: validSnapshot(),
    result: { kind: "none" },
  }),
  includeCrypto = true,
) {
  const invocations: unknown[][] = [];
  const handlers = new Map<string, (event: unknown, value: unknown) => void>();
  const removals: unknown[][] = [];
  const api = createPreloadApi({
    platform: "darwin",
    crypto: includeCrypto
      ? { randomUUID: () => "generated-id" as `${string}-${string}-${string}-${string}-${string}` }
      : undefined,
    ipc: {
      invoke: async (channel, command) => {
        invocations.push([channel, command]);
        return invokeResult?.();
      },
      on: (channel, handler) => {
        handlers.set(channel, handler);
      },
      removeListener: (channel, handler) => {
        removals.push([channel, handler]);
        handlers.delete(channel);
      },
    },
  });
  return { api, invocations, handlers, removals };
}

function validSnapshot() {
  return {
    revision: 0,
    projects: [],
    threads: [],
    messages: [],
    drafts: [],
    selectedThreadIdByProject: {},
    runtimeByProject: {},
    settings: { preferredMcpPort: 58741, sidebarWidth: 272, mcpPortChangeAllowed: true },
  };
}
