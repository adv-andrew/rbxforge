import { randomUUID } from "node:crypto";
import type { DesktopSnapshot } from "../shared/domain.js";
import { toDesktopError } from "../shared/errors.js";
import {
  desktopCommandSchema,
  desktopCloseAcknowledgementSchema,
  desktopCloseFeedbackSchema,
  desktopCloseRequestSchema,
  desktopResponseSchema,
  type DesktopCommand,
  type DesktopResponse,
} from "../shared/protocol.js";

export const REQUEST_CHANNEL = "rbxforge:request";
export const EVENT_CHANNEL = "rbxforge:event";
export const CLOSE_REQUEST_CHANNEL = "rbxforge:close-request";
export const CLOSE_ACKNOWLEDGEMENT_CHANNEL = "rbxforge:close-acknowledgement";
export const CLOSE_FEEDBACK_CHANNEL = "rbxforge:close-feedback";

export interface DesktopIpcMain {
  handle(channel: string, handler: (event: unknown, input: unknown) => Promise<unknown>): void;
  removeHandler(channel: string): void;
}

export interface CloseBarrierWebContents {
  isDestroyed(): boolean;
  send(channel: string, value: unknown): void;
  on(name: "destroyed" | "render-process-gone", listener: (...args: unknown[]) => void): unknown;
  removeListener(name: "destroyed" | "render-process-gone", listener: (...args: unknown[]) => void): unknown;
}

export type DesktopCloseBarrierOutcome =
  | { readonly kind: "flushed" }
  | { readonly kind: "save-failed" }
  | { readonly kind: "timeout" }
  | { readonly kind: "unavailable" };

export interface DesktopCloseBarrier {
  request(webContents: CloseBarrierWebContents): Promise<DesktopCloseBarrierOutcome>;
  dispose(): void;
}

export function registerDesktopCloseBarrier(options: {
  readonly ipcMain: DesktopIpcMain;
  readonly timeoutMs?: number;
  readonly createRequestId?: () => string;
}): DesktopCloseBarrier {
  const timeoutMs = options.timeoutMs ?? 2_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    throw new Error("Desktop close barrier timeout is invalid.");
  }
  const pending = new Map<
    string,
    {
      readonly webContents: CloseBarrierWebContents;
      readonly finish: (outcome: DesktopCloseBarrierOutcome) => void;
    }
  >();
  let disposed = false;
  options.ipcMain.handle(CLOSE_ACKNOWLEDGEMENT_CHANNEL, async (event, input) => {
    const parsed = desktopCloseAcknowledgementSchema.safeParse(input);
    if (!parsed.success) return false;
    const request = pending.get(parsed.data.requestId);
    if (request === undefined || request.webContents !== (event as { readonly sender?: unknown } | null)?.sender) {
      return false;
    }
    request.finish(parsed.data.ok ? { kind: "flushed" } : { kind: "save-failed" });
    return true;
  });
  return Object.freeze({
    request: (webContents: CloseBarrierWebContents) => {
      if (webContentsUnavailable(webContents)) {
        return Promise.resolve({ kind: "unavailable" } as const);
      }
      if (disposed) return Promise.resolve(reportHealthyCloseFailure(webContents, "save-failed"));
      let requestId: unknown;
      try {
        requestId = (options.createRequestId ?? randomUUID)();
      } catch {
        return Promise.resolve(reportHealthyCloseFailure(webContents, "save-failed"));
      }
      if (typeof requestId !== "string" || !/^[A-Za-z0-9._:-]{1,200}$/.test(requestId) || pending.has(requestId)) {
        return Promise.resolve(reportHealthyCloseFailure(webContents, "save-failed"));
      }
      return new Promise<DesktopCloseBarrierOutcome>((resolve) => {
        let settled = false;
        let timeout: ReturnType<typeof setTimeout> | undefined;
        let destroyedListenerAttached = false;
        let renderGoneListenerAttached = false;
        const unavailable = (): void => finish({ kind: "unavailable" });
        const finish = (requestedOutcome: DesktopCloseBarrierOutcome): void => {
          if (settled) return;
          let outcome = requestedOutcome;
          if (outcome.kind === "save-failed" || outcome.kind === "timeout") {
            if (webContentsUnavailable(webContents)) {
              outcome = { kind: "unavailable" };
            } else {
              try {
                webContents.send(
                  CLOSE_FEEDBACK_CHANNEL,
                  desktopCloseFeedbackSchema.parse({
                    version: 1,
                    type: "close-blocked",
                    reason: outcome.kind,
                  }),
                );
              } catch {
                outcome = { kind: "unavailable" };
              }
              if (settled) return;
              if (webContentsUnavailable(webContents)) outcome = { kind: "unavailable" };
            }
          }
          settled = true;
          if (timeout !== undefined) clearTimeout(timeout);
          pending.delete(requestId);
          if (destroyedListenerAttached) {
            try {
              webContents.removeListener("destroyed", unavailable);
            } catch {
              // The renderer is already unavailable; cleanup is best effort.
            }
          }
          if (renderGoneListenerAttached) {
            try {
              webContents.removeListener("render-process-gone", unavailable);
            } catch {
              // The renderer is already unavailable; cleanup is best effort.
            }
          }
          resolve(outcome);
        };
        pending.set(requestId, { webContents, finish });
        try {
          webContents.on("destroyed", unavailable);
          destroyedListenerAttached = true;
          webContents.on("render-process-gone", unavailable);
          renderGoneListenerAttached = true;
        } catch {
          finish({ kind: "unavailable" });
          return;
        }
        if (webContentsUnavailable(webContents)) {
          finish({ kind: "unavailable" });
          return;
        }
        timeout = setTimeout(() => finish({ kind: "timeout" }), timeoutMs);
        timeout.unref?.();
        try {
          webContents.send(
            CLOSE_REQUEST_CHANNEL,
            desktopCloseRequestSchema.parse({ version: 1, type: "draft-flush", requestId }),
          );
        } catch {
          finish({ kind: "unavailable" });
        }
      });
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      options.ipcMain.removeHandler(CLOSE_ACKNOWLEDGEMENT_CHANNEL);
      for (const request of [...pending.values()]) request.finish({ kind: "unavailable" });
    },
  });
}

function webContentsUnavailable(webContents: CloseBarrierWebContents): boolean {
  try {
    return webContents.isDestroyed();
  } catch {
    return true;
  }
}

function reportHealthyCloseFailure(
  webContents: CloseBarrierWebContents,
  reason: "save-failed" | "timeout",
): DesktopCloseBarrierOutcome {
  let unavailable = false;
  let destroyedListenerAttached = false;
  let renderGoneListenerAttached = false;
  const markUnavailable = (): void => {
    unavailable = true;
  };
  try {
    webContents.on("destroyed", markUnavailable);
    destroyedListenerAttached = true;
    webContents.on("render-process-gone", markUnavailable);
    renderGoneListenerAttached = true;
    if (webContentsUnavailable(webContents)) unavailable = true;
    if (!unavailable) {
      webContents.send(
        CLOSE_FEEDBACK_CHANNEL,
        desktopCloseFeedbackSchema.parse({ version: 1, type: "close-blocked", reason }),
      );
      if (webContentsUnavailable(webContents)) unavailable = true;
    }
  } catch {
    unavailable = true;
  } finally {
    if (destroyedListenerAttached) {
      try {
        webContents.removeListener("destroyed", markUnavailable);
      } catch {
        unavailable = true;
      }
    }
    if (renderGoneListenerAttached) {
      try {
        webContents.removeListener("render-process-gone", markUnavailable);
      } catch {
        unavailable = true;
      }
    }
  }
  return unavailable ? { kind: "unavailable" } : { kind: reason };
}

export interface DesktopIpcController {
  initialize(): Promise<DesktopSnapshot>;
  execute(command: DesktopCommand): Promise<DesktopResponse | unknown>;
}

export function registerDesktopIpc(options: {
  readonly ipcMain: DesktopIpcMain;
  readonly controller: DesktopIpcController;
}): () => void {
  let removed = false;
  options.ipcMain.handle(REQUEST_CHANNEL, async (_event, input) => {
    const parsed = desktopCommandSchema.safeParse(input);
    if (!parsed.success) {
      const snapshot = await options.controller.initialize();
      const requestId = safeRequestId(input);
      return desktopResponseSchema.parse({
        version: 1,
        requestId,
        ok: false,
        snapshot,
        error: toDesktopError({
          layer: "ipc",
          code: "invalid-command",
          message: "The desktop command was invalid.",
          recovery: { action: "none", label: "Dismiss" },
        }),
      });
    }

    try {
      const output = await options.controller.execute(parsed.data);
      const response = desktopResponseSchema.safeParse(output);
      if (!response.success || response.data.requestId !== parsed.data.requestId) {
        return await safeControllerFailure(
          options.controller,
          parsed.data.requestId,
          "invalid-controller-output",
          "The desktop host returned invalid data.",
        );
      }
      return response.data;
    } catch {
      return await safeControllerFailure(
        options.controller,
        parsed.data.requestId,
        "controller-failure",
        "The desktop host could not complete the request.",
      );
    }
  });
  return () => {
    if (removed) return;
    removed = true;
    options.ipcMain.removeHandler(REQUEST_CHANNEL);
  };
}

async function safeControllerFailure(
  controller: DesktopIpcController,
  requestId: string,
  code: string,
  message: string,
): Promise<DesktopResponse> {
  const snapshot = await controller.initialize();
  return desktopResponseSchema.parse({
    version: 1,
    requestId,
    ok: false,
    snapshot,
    error: toDesktopError({
      layer: "ipc",
      code,
      message,
      recovery: { action: "retry", label: "Retry" },
    }),
  });
}

function safeRequestId(input: unknown): string {
  if (
    typeof input === "object" &&
    input !== null &&
    "requestId" in input &&
    typeof input.requestId === "string" &&
    input.requestId.length > 0
  ) {
    return input.requestId.slice(0, 200);
  }
  return "invalid-request";
}
