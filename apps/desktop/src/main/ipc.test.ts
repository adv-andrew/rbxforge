import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { desktopCommandSchema } from "../shared/protocol.js";
import {
  CLOSE_ACKNOWLEDGEMENT_CHANNEL,
  CLOSE_REQUEST_CHANNEL,
  registerDesktopCloseBarrier,
  registerDesktopIpc,
  REQUEST_CHANNEL,
} from "./ipc.js";

describe("desktop IPC boundary", () => {
  it("rejects malformed commands before controller execution", async () => {
    const handlers = new Map<string, (_event: unknown, input: unknown) => Promise<unknown>>();
    const execute = vi.fn();
    const dispose = registerDesktopIpc({
      ipcMain: {
        handle: (channel, handler) => handlers.set(channel, handler),
        removeHandler: (channel) => handlers.delete(channel),
      },
      controller: {
        initialize: async () => validSnapshot(),
        execute,
      },
    });
    const handler = handlers.get(REQUEST_CHANNEL);
    const response = await handler?.(
      {},
      {
        version: 1,
        requestId: "malformed",
        type: "runtime.selectStudio",
        projectId: "project-a",
        instanceId: "studio-a",
        catalogRevision: 1,
        warningAccepted: false,
        expectedRevision: 0,
        brokerEpoch: "forged",
      },
    );
    expect(execute).not.toHaveBeenCalled();
    expect(response).toMatchObject({ ok: false, requestId: "malformed", error: { code: "invalid-command" } });
    dispose();
    expect(handlers.has(REQUEST_CHANNEL)).toBe(false);
  });

  it("echoes the exact request id and normalizes invalid controller output", async () => {
    const handlers = new Map<string, (_event: unknown, input: unknown) => Promise<unknown>>();
    registerDesktopIpc({
      ipcMain: {
        handle: (channel, handler) => handlers.set(channel, handler),
        removeHandler: vi.fn(),
      },
      controller: {
        initialize: async () => validSnapshot(),
        execute: async () => ({ ok: true, requestId: "wrong", snapshot: {}, result: { kind: "none" } }),
      },
    });
    const handler = handlers.get(REQUEST_CHANNEL);
    const response = await handler?.(
      {},
      {
        version: 1,
        requestId: "exact-id",
        type: "bootstrap",
      },
    );
    expect(response).toMatchObject({
      ok: false,
      requestId: "exact-id",
      error: { code: "invalid-controller-output" },
    });
    expect(JSON.stringify(response)).not.toContain("wrong");
  });

  it("normalizes a thrown controller exception without paths, stacks, or secrets", async () => {
    const handlers = new Map<string, (_event: unknown, input: unknown) => Promise<unknown>>();
    registerDesktopIpc({
      ipcMain: {
        handle: (channel, handler) => handlers.set(channel, handler),
        removeHandler: vi.fn(),
      },
      controller: {
        initialize: async () => validSnapshot(),
        execute: async () => {
          throw new Error("token=super-secret /Users/private\nstack");
        },
      },
    });
    const response = await handlers.get(REQUEST_CHANNEL)?.(
      {},
      {
        version: 1,
        requestId: "exact-id",
        type: "bootstrap",
      },
    );
    expect(response).toMatchObject({ ok: false, requestId: "exact-id", error: { code: "controller-failure" } });
    expect(JSON.stringify(response)).not.toMatch(/super-secret|Users|stack/);
  });

  it.each(["brokerEpoch", "connectedAt", "project", "rojo", "instance_id", "expectedInstanceId"])(
    "strictly rejects renderer-forged runtime identity field %s",
    (field) => {
      const otherwiseValid = {
        version: 1,
        requestId: "select",
        type: "runtime.selectStudio",
        projectId: "project-a",
        instanceId: "studio-a",
        catalogRevision: 2,
        warningAccepted: false,
        expectedRevision: 4,
      };
      expect(desktopCommandSchema.safeParse({ ...otherwiseValid, [field]: "forged" }).success).toBe(false);
    },
  );
});

describe("desktop close barrier", () => {
  it("accepts only the exact renderer sender and request before releasing the close", async () => {
    const handlers = new Map<string, (event: unknown, input: unknown) => Promise<unknown>>();
    const removals: string[] = [];
    const sent: unknown[][] = [];
    const webContents = closeWebContentsHarness({ sent }).port;
    const barrier = registerDesktopCloseBarrier({
      ipcMain: {
        handle: (channel, handler) => handlers.set(channel, handler),
        removeHandler: (channel) => removals.push(channel),
      },
      createRequestId: () => "close-1",
      timeoutMs: 1_000,
    });
    const closing = barrier.request(webContents);
    expect(sent).toEqual([[CLOSE_REQUEST_CHANNEL, { version: 1, type: "draft-flush", requestId: "close-1" }]]);
    const acknowledge = handlers.get(CLOSE_ACKNOWLEDGEMENT_CHANNEL);
    await expect(acknowledge?.({ sender: {} }, { version: 1, requestId: "close-1", ok: true })).resolves.toBe(false);
    await expect(
      acknowledge?.({ sender: webContents }, { version: 1, requestId: "close-1", ok: true, extra: "forged" }),
    ).resolves.toBe(false);
    await expect(acknowledge?.({ sender: webContents }, { version: 1, requestId: "close-1", ok: true })).resolves.toBe(
      true,
    );
    await expect(closing).resolves.toEqual({ kind: "flushed" });
    barrier.dispose();
    barrier.dispose();
    expect(removals).toEqual([CLOSE_ACKNOWLEDGEMENT_CHANNEL]);
  });

  it("classifies destroyed contents and send failures as unavailable without waiting", async () => {
    const handlers = new Map<string, (event: unknown, input: unknown) => Promise<unknown>>();
    const send = vi.fn();
    const barrier = registerDesktopCloseBarrier({
      ipcMain: {
        handle: (channel, handler) => handlers.set(channel, handler),
        removeHandler: vi.fn(),
      },
      createRequestId: () => "close-timeout",
      timeoutMs: 1_000,
    });
    const destroyed = closeWebContentsHarness({ destroyed: true, send });
    await expect(barrier.request(destroyed.port)).resolves.toEqual({ kind: "unavailable" });
    expect(send).not.toHaveBeenCalled();

    const cannotSend = closeWebContentsHarness({
      send: () => {
        throw new Error("renderer unavailable");
      },
    });
    await expect(barrier.request(cannotSend.port)).resolves.toEqual({ kind: "unavailable" });
    barrier.dispose();
  });

  it.each(["destroyed", "render-process-gone"] as const)(
    "classifies %s while a close request is pending as unavailable",
    async (eventName) => {
      const handlers = new Map<string, (event: unknown, input: unknown) => Promise<unknown>>();
      const contents = closeWebContentsHarness();
      const barrier = registerDesktopCloseBarrier({
        ipcMain: {
          handle: (channel, handler) => handlers.set(channel, handler),
          removeHandler: vi.fn(),
        },
        createRequestId: () => `close-${eventName}`,
        timeoutMs: 1_000,
      });

      const closing = barrier.request(contents.port);
      if (eventName === "destroyed") contents.destroy();
      contents.emit(eventName);

      await expect(closing).resolves.toEqual({ kind: "unavailable" });
      barrier.dispose();
    },
  );

  it("keeps explicit save failure and timeout fail-closed with distinct visible feedback", async () => {
    const handlers = new Map<string, (event: unknown, input: unknown) => Promise<unknown>>();
    const first = closeWebContentsHarness();
    const second = closeWebContentsHarness();
    let requestId = 0;
    const barrier = registerDesktopCloseBarrier({
      ipcMain: {
        handle: (channel, handler) => handlers.set(channel, handler),
        removeHandler: vi.fn(),
      },
      createRequestId: () => `close-${++requestId}`,
      timeoutMs: 5,
    });

    const saveFailed = barrier.request(first.port);
    await handlers.get(CLOSE_ACKNOWLEDGEMENT_CHANNEL)?.(
      { sender: first.port },
      { version: 1, requestId: "close-1", ok: false },
    );
    await expect(saveFailed).resolves.toEqual({ kind: "save-failed" });
    expect(first.sent.at(-1)).toEqual([
      "rbxforge:close-feedback",
      { version: 1, type: "close-blocked", reason: "save-failed" },
    ]);

    await expect(barrier.request(second.port)).resolves.toEqual({ kind: "timeout" });
    expect(second.sent.at(-1)).toEqual([
      "rbxforge:close-feedback",
      { version: 1, type: "close-blocked", reason: "timeout" },
    ]);
    barrier.dispose();
  });

  it.each([
    ["invalid", () => "not valid"],
    ["non-string", () => undefined as never],
    [
      "throwing",
      () => {
        throw new Error("request id generation failed");
      },
    ],
  ] as const)(
    "keeps a healthy renderer fail-closed when request-id generation is %s",
    async (_label, createRequestId) => {
      const contents = closeWebContentsHarness();
      const barrier = registerDesktopCloseBarrier({
        ipcMain: {
          handle: vi.fn(),
          removeHandler: vi.fn(),
        },
        createRequestId,
        timeoutMs: 1_000,
      });

      await expect(Promise.resolve().then(() => barrier.request(contents.port))).resolves.toEqual({
        kind: "save-failed",
      });
      expect(contents.sent).toEqual([
        ["rbxforge:close-feedback", { version: 1, type: "close-blocked", reason: "save-failed" }],
      ]);
      barrier.dispose();
    },
  );

  it("keeps a healthy renderer fail-closed when a close request id collides", async () => {
    const handlers = new Map<string, (event: unknown, input: unknown) => Promise<unknown>>();
    const first = closeWebContentsHarness();
    const second = closeWebContentsHarness();
    const barrier = registerDesktopCloseBarrier({
      ipcMain: {
        handle: (channel, handler) => handlers.set(channel, handler),
        removeHandler: vi.fn(),
      },
      createRequestId: () => "close-collision",
      timeoutMs: 1_000,
    });

    const firstClosing = barrier.request(first.port);
    await expect(barrier.request(second.port)).resolves.toEqual({ kind: "save-failed" });
    expect(second.sent).toEqual([
      ["rbxforge:close-feedback", { version: 1, type: "close-blocked", reason: "save-failed" }],
    ]);
    await handlers.get(CLOSE_ACKNOWLEDGEMENT_CHANNEL)?.(
      { sender: first.port },
      { version: 1, requestId: "close-collision", ok: true },
    );
    await expect(firstClosing).resolves.toEqual({ kind: "flushed" });
    barrier.dispose();
  });
});

function closeWebContentsHarness(
  options: {
    readonly destroyed?: boolean;
    readonly send?: (channel: string, value: unknown) => void;
    readonly sent?: unknown[][];
  } = {},
) {
  const emitter = new EventEmitter();
  const sent = options.sent ?? [];
  let destroyed = options.destroyed ?? false;
  const port = {
    isDestroyed: () => destroyed,
    send: (channel: string, value: unknown) => {
      sent.push([channel, value]);
      options.send?.(channel, value);
    },
    on: (name: string, listener: (...args: unknown[]) => void) => {
      emitter.on(name, listener);
    },
    removeListener: (name: string, listener: (...args: unknown[]) => void) => {
      emitter.removeListener(name, listener);
    },
  };
  return {
    port,
    sent,
    destroy: () => {
      destroyed = true;
    },
    emit: (name: "destroyed" | "render-process-gone") => emitter.emit(name),
  };
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
