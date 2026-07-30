import { describe, expect, test, vi } from "vitest";

import { PlaytestController, type PlaytestCapabilityPort, type RuntimeLogBatch } from "./playtest-controller.js";

const emptyLogs = (): RuntimeLogBatch => ({
  entries: [],
  totalDropped: 0,
  perCaptureNextSince: {},
  perCaptureErrors: {},
});

function capability(events: string[]): PlaytestCapabilityPort {
  return {
    start: async (mode) => {
      events.push(`start:${mode}`);
      return { success: true, action: "start", message: "ready", roles: ["edit", "server", "client-1"] };
    },
    stop: async () => {
      events.push("stop");
      return { success: true, action: "stop", message: "stopped" };
    },
    status: async () => {
      events.push("status");
      return { success: true, action: "status", running: false, roles: ["edit"] };
    },
    logs: async (cursor) => {
      events.push(`logs:${JSON.stringify(cursor)}`);
      return emptyLogs();
    },
    screenshot: async () => {
      events.push("screenshot");
      return {
        data: "AQID",
        mimeType: "image/jpeg",
        format: "jpeg",
        target: "client-1",
        capturedAt: 10,
      };
    },
  };
}

describe("PlaytestController", () => {
  test("serializes the nominal state lifecycle and preserves cursors", async () => {
    const events: string[] = [];
    const controller = new PlaytestController({ instanceId: "place:1", capability: capability(events) });
    const states: string[] = [];
    const dispose = controller.onDidChange((snapshot) => states.push(snapshot.status));

    await controller.pollLogs({ server: 4, "client-1": 9 }, new AbortController().signal);
    await controller.start("play", new AbortController().signal);
    await controller.pollLogs({ server: 4, "client-1": 9 }, new AbortController().signal);
    await controller.stop(new AbortController().signal);

    expect(states).toEqual(["starting", "running", "stopping", "idle"]);
    expect(events).toEqual(['logs:{"server":4,"client-1":9}', "start:play", "logs:undefined", "stop"]);
    expect(controller.state()).toMatchObject({ status: "idle", instanceId: "place:1" });
    dispose.dispose();
  });

  test("does not poison the queue and aborted queued work never invokes a capability", async () => {
    const events: string[] = [];
    let release: (() => void) | undefined;
    const port = capability(events);
    const start = vi.fn(async () => {
      events.push("start:play");
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { success: true as const, action: "start" as const, message: "ready", roles: ["server"] };
    });
    const controller = new PlaytestController({ instanceId: "place:1", capability: { ...port, start } });
    const first = controller.start("play", new AbortController().signal);
    const queuedAbort = new AbortController();
    const queued = controller.pollLogs(7, queuedAbort.signal);
    queuedAbort.abort();
    while (release === undefined) await Promise.resolve();
    release?.();

    await first;
    await expect(queued).rejects.toMatchObject({ name: "AbortError" });
    await expect(controller.stop(new AbortController().signal)).resolves.toBeUndefined();
    expect(events).not.toContain("logs:7");
  });

  test("marks uncertain lifecycle outcomes unknown", async () => {
    const events: string[] = [];
    const port = capability(events);
    const controller = new PlaytestController({
      instanceId: "place:1",
      capability: {
        ...port,
        start: async () => ({ success: false, action: "start", message: "nope" }),
      },
    });

    await expect(controller.start("run", new AbortController().signal)).rejects.toThrow();
    expect(controller.state().status).toBe("unknown");
    controller.disconnect();
    expect(controller.state().status).toBe("unknown");
  });

  test("inspection never stops a pre-existing session and always cleans up one it starts", async () => {
    const existingEvents: string[] = [];
    const existing = capability(existingEvents);
    const existingController = new PlaytestController({
      instanceId: "place:1",
      capability: {
        ...existing,
        status: async () => ({ success: true, action: "status", running: true, roles: ["server"] }),
      },
    });
    const existingReceipt = await existingController.runInspectCapture(new AbortController().signal);
    expect(existingReceipt.preExisting).toBe(true);
    expect(existingEvents).toEqual(["logs:undefined", "screenshot"]);

    const events: string[] = [];
    const started = capability(events);
    const controller = new PlaytestController({
      instanceId: "place:1",
      capability: {
        ...started,
        logs: async () => {
          events.push("logs");
          throw new Error("log failure");
        },
      },
      cleanupTimeoutMs: 100,
    });
    const receipt = await controller.runInspectCapture(new AbortController().signal);
    expect(events).toEqual(["status", "start:play", "logs", "screenshot", "stop"]);
    expect(receipt.logs.ok).toBe(false);
    expect(receipt.stop.ok).toBe(true);
  });

  test("resets only a newly observed runtime role cursor", async () => {
    const cursors: Array<unknown> = [];
    let roles: readonly string[] = ["server"];
    const port = capability([]);
    const controller = new PlaytestController({
      instanceId: "place:1",
      capability: {
        ...port,
        status: async () => ({ success: true, action: "status", running: true, roles }),
        logs: async (cursor) => {
          cursors.push(cursor);
          return emptyLogs();
        },
      },
    });
    await controller.refreshStatus(new AbortController().signal);
    await controller.pollLogs({ server: 7 }, new AbortController().signal);
    roles = ["server", "client-1"];
    await controller.refreshStatus(new AbortController().signal);
    await controller.pollLogs({ server: 8, "client-1": 4 }, new AbortController().signal);

    expect(cursors).toEqual([undefined, { server: 8 }]);
  });

  test("cleans up an issued start even when its reply throws, while redacting external errors", async () => {
    const events: string[] = [];
    const activity: Array<{ readonly detail?: string }> = [];
    const port = capability(events);
    const controller = new PlaytestController({
      instanceId: "place:1",
      capability: {
        ...port,
        start: async (_mode, _signal, onIssued) => {
          events.push("start-issued");
          onIssued?.();
          throw new Error("SECRET_process_output");
        },
      },
      onActivity: (entry) => activity.push(entry),
    });

    const receipt = await controller.runInspectCapture(new AbortController().signal);

    expect(events).toEqual(["status", "start-issued", "stop"]);
    expect(receipt.playtest).toEqual({ ok: false, error: "Playtest start failed" });
    expect(receipt.stop).toEqual({ ok: true, value: "stopped" });
    expect(JSON.stringify([receipt, activity, controller.state()])).not.toContain("SECRET_process_output");
  });

  test("disconnect epoch-invalidates deferred lifecycle success and queued start", async () => {
    let resolveStatus:
      | ((value: {
          readonly success: true;
          readonly action: "status";
          readonly running: true;
          readonly roles: readonly string[];
        }) => void)
      | undefined;
    const status = new Promise<{
      readonly success: true;
      readonly action: "status";
      readonly running: true;
      readonly roles: readonly string[];
    }>((resolve) => {
      resolveStatus = resolve;
    });
    const changes: string[] = [];
    const activity: string[] = [];
    const port = capability([]);
    const controller = new PlaytestController({
      instanceId: "place:1",
      capability: { ...port, status: async () => status },
      onActivity: (entry) => activity.push(entry.operation),
    });
    controller.onDidChange((snapshot) => changes.push(snapshot.status));

    const refresh = controller.refreshStatus(new AbortController().signal);
    await Promise.resolve();
    controller.disconnect();
    const queuedStart = controller.start("play", new AbortController().signal);
    resolveStatus?.({ success: true, action: "status", running: true, roles: ["server"] });

    await expect(refresh).rejects.toMatchObject({ name: "AbortError" });
    await expect(queuedStart).rejects.toThrow("unknown");
    expect(controller.state().status).toBe("unknown");
    expect(changes.at(-1)).toBe("unknown");
    expect(activity).not.toContain("playtest.status");
  });

  test("reconciles external start and idle transitions with generation, cursor reset, and cleared mode", async () => {
    const cursors: unknown[] = [];
    const statuses = [
      { success: true as const, action: "status" as const, running: true, roles: ["server"] },
      { success: true as const, action: "status" as const, running: false, roles: ["edit"] },
    ];
    const port = capability([]);
    const controller = new PlaytestController({
      instanceId: "place:1",
      capability: {
        ...port,
        status: async () => statuses.shift()!,
        logs: async (cursor) => {
          cursors.push(cursor);
          return emptyLogs();
        },
      },
    });
    await controller.refreshStatus(new AbortController().signal);
    expect(controller.state()).toMatchObject({ status: "running", runtimeGeneration: 1 });
    await controller.pollLogs(9, new AbortController().signal);
    await controller.refreshStatus(new AbortController().signal);
    expect(controller.state().status).toBe("idle");
    expect(controller.state().mode).toBeUndefined();
    expect(cursors).toEqual([undefined]);
  });

  test("disconnect invalidates delayed start and stop success without late lifecycle activity", async () => {
    let resolveStart: (() => void) | undefined;
    const startGate = new Promise<void>((resolve) => {
      resolveStart = resolve;
    });
    const startActivity: string[] = [];
    const startStates: string[] = [];
    const startPort = capability([]);
    const starting = new PlaytestController({
      instanceId: "place:1",
      capability: {
        ...startPort,
        start: async () => {
          await startGate;
          return { success: true, action: "start", message: "ready", roles: ["server"] };
        },
      },
      onActivity: (entry) => startActivity.push(`${entry.operation}:${entry.result}`),
    });
    starting.onDidChange((snapshot) => startStates.push(snapshot.status));
    const start = starting.start("play", new AbortController().signal);
    await Promise.resolve();
    starting.disconnect();
    resolveStart?.();
    await expect(start).rejects.toMatchObject({ name: "AbortError" });
    expect(starting.state().status).toBe("unknown");
    expect(startStates.slice(startStates.indexOf("unknown") + 1)).not.toContain("running");
    expect(startActivity).not.toContain("playtest.start:success");

    let resolveStop: (() => void) | undefined;
    const stopGate = new Promise<void>((resolve) => {
      resolveStop = resolve;
    });
    const stopActivity: string[] = [];
    const stopStates: string[] = [];
    const stopPort = capability([]);
    const stopping = new PlaytestController({
      instanceId: "place:2",
      capability: {
        ...stopPort,
        stop: async () => {
          await stopGate;
          return { success: true, action: "stop", message: "stopped" };
        },
      },
      onActivity: (entry) => stopActivity.push(`${entry.operation}:${entry.result}`),
    });
    await stopping.start("play", new AbortController().signal);
    stopping.onDidChange((snapshot) => stopStates.push(snapshot.status));
    const stop = stopping.stop(new AbortController().signal);
    await Promise.resolve();
    stopping.disconnect();
    resolveStop?.();
    await expect(stop).rejects.toMatchObject({ name: "AbortError" });
    expect(stopping.state().status).toBe("unknown");
    expect(stopStates.slice(stopStates.indexOf("unknown") + 1)).not.toContain("idle");
    expect(stopActivity).not.toContain("playtest.stop:success");
  });

  test("work queued before disconnect never invokes its capability", async () => {
    let resolveStatus: (() => void) | undefined;
    const statusGate = new Promise<void>((resolve) => {
      resolveStatus = resolve;
    });
    const logs = vi.fn(async () => emptyLogs());
    const port = capability([]);
    const controller = new PlaytestController({
      instanceId: "place:1",
      capability: {
        ...port,
        status: async () => {
          await statusGate;
          return { success: true, action: "status", running: false, roles: [] };
        },
        logs,
      },
    });
    const refresh = controller.refreshStatus(new AbortController().signal);
    const queued = controller.pollLogs(3, new AbortController().signal);
    await Promise.resolve();
    controller.disconnect();
    resolveStatus?.();

    await expect(refresh).rejects.toMatchObject({ name: "AbortError" });
    await expect(queued).rejects.toMatchObject({ name: "AbortError" });
    expect(logs).not.toHaveBeenCalled();
  });

  test("clears a local mode when status observes an external stop", async () => {
    const port = capability([]);
    const controller = new PlaytestController({
      instanceId: "place:1",
      capability: {
        ...port,
        status: async () => ({ success: true, action: "status", running: false, roles: ["edit"] }),
      },
    });
    await controller.start("play", new AbortController().signal);
    expect(controller.state().mode).toBe("play");
    await controller.refreshStatus(new AbortController().signal);
    expect(controller.state().mode).toBeUndefined();
  });

  test("inspection reconciles a pre-existing run once without misclassified activity", async () => {
    const activity: string[] = [];
    const port = capability([]);
    const controller = new PlaytestController({
      instanceId: "place:1",
      capability: {
        ...port,
        status: async () => ({ success: true, action: "status", running: true, roles: ["server"] }),
      },
      onActivity: (entry) => activity.push(`${entry.operation}:${entry.result}`),
    });

    const receipt = await controller.runInspectCapture(new AbortController().signal);

    expect(receipt.playtest).toEqual({ ok: true, value: "pre-existing" });
    expect(controller.state()).toMatchObject({ status: "running", runtimeGeneration: 1 });
    expect(activity.filter((entry) => entry.startsWith("playtest.status"))).toEqual(["playtest.status:success"]);
    expect(activity.some((entry) => entry.startsWith("playtest.start"))).toBe(false);
  });

  test("issued malformed starts clean up, while failures before issuance never stop", async () => {
    const issuedEvents: string[] = [];
    const issuedPort = capability(issuedEvents);
    const issued = new PlaytestController({
      instanceId: "place:1",
      capability: {
        ...issuedPort,
        start: async (_mode, _signal, onIssued) => {
          issuedEvents.push("start");
          onIssued?.();
          return { success: true, action: "wrong", message: "SECRET_reply" } as never;
        },
      },
    });
    const malformed = await issued.runInspectCapture(new AbortController().signal);
    expect(issuedEvents).toEqual(["status", "start", "stop"]);
    expect(malformed.playtest).toEqual({ ok: false, error: "Playtest start failed" });
    expect(malformed.stop).toEqual({ ok: true, value: "stopped" });
    expect(JSON.stringify(malformed)).not.toContain("SECRET_reply");

    const rejectedEvents: string[] = [];
    const rejectedPort = capability(rejectedEvents);
    const rejected = new PlaytestController({
      instanceId: "place:2",
      capability: {
        ...rejectedPort,
        start: async () => {
          rejectedEvents.push("rejected");
          throw new Error("Authorization rejected");
        },
      },
    });
    const notIssued = await rejected.runInspectCapture(new AbortController().signal);
    expect(rejectedEvents).toEqual(["status", "rejected"]);
    expect(notIssued.stop).toEqual({ ok: true, value: "not-required" });
  });

  test("caller cancellation and timeout after issuance still run fresh cleanup", async () => {
    const run = async (timeoutMs: number, cancel: boolean): Promise<string[]> => {
      const events: string[] = [];
      const port = capability(events);
      const controller = new PlaytestController({
        instanceId: "place:1",
        capability: {
          ...port,
          start: async (_mode, signal, onIssued) => {
            events.push("start");
            onIssued?.();
            await new Promise<void>((_resolve, reject) => {
              signal.addEventListener(
                "abort",
                () => {
                  const error = new Error("SECRET_abort_output");
                  error.name = "AbortError";
                  reject(error);
                },
                { once: true },
              );
            });
            throw new Error("unreachable");
          },
        },
        operationTimeoutMs: timeoutMs,
        cleanupTimeoutMs: 100,
      });
      const abort = new AbortController();
      const inspection = controller.runInspectCapture(abort.signal);
      while (!events.includes("start")) await Promise.resolve();
      if (cancel) abort.abort();
      await expect(inspection).rejects.toMatchObject({ name: "AbortError" });
      expect(JSON.stringify(controller.state())).not.toContain("SECRET_abort_output");
      return events;
    };

    await expect(run(100, true)).resolves.toEqual(["status", "start", "stop"]);
    await expect(run(5, false)).resolves.toEqual(["status", "start", "stop"]);
  });
});
