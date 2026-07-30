import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import {
  desktopCommandInputSchema,
  desktopCommandSchema,
  desktopCloseAcknowledgementSchema,
  desktopCloseFeedbackSchema,
  desktopCloseRequestSchema,
  desktopEventSchema,
  desktopResponseSchema,
  type DesktopCommandInput,
  type DesktopCloseFeedback,
  type DesktopEvent,
  type DesktopResponse,
} from "../shared/protocol.js";

const REQUEST_CHANNEL = "rbxforge:request";
const EVENT_CHANNEL = "rbxforge:event";
const CLOSE_REQUEST_CHANNEL = "rbxforge:close-request";
const CLOSE_ACKNOWLEDGEMENT_CHANNEL = "rbxforge:close-acknowledgement";
const CLOSE_FEEDBACK_CHANNEL = "rbxforge:close-feedback";

export interface PreloadIpc {
  invoke(channel: string, command: unknown): Promise<unknown>;
  on(channel: string, handler: (event: unknown, value: unknown) => void): void;
  removeListener(channel: string, handler: (event: unknown, value: unknown) => void): void;
}

export interface RbxForgeApi {
  readonly platform: string;
  request(input: DesktopCommandInput): Promise<DesktopResponse>;
  subscribe(listener: (event: DesktopEvent) => void): () => void;
  onCloseRequest(listener: () => Promise<boolean>): () => void;
  onCloseBlocked(listener: (reason: DesktopCloseFeedback["reason"]) => void): () => void;
}

export function createPreloadApi(options: {
  readonly platform: string;
  readonly crypto?: { randomUUID(): string };
  readonly ipc: PreloadIpc;
}): Readonly<RbxForgeApi> {
  return Object.freeze({
    platform: options.platform,
    request: async (input: DesktopCommandInput) => {
      const parsedInput = desktopCommandInputSchema.safeParse(input);
      if (!parsedInput.success) throw new Error("Desktop command is invalid.");
      if (options.crypto === undefined) throw new Error("Secure request identifiers are unavailable.");
      const commandResult = desktopCommandSchema.safeParse({
        ...parsedInput.data,
        version: 1,
        requestId: options.crypto.randomUUID(),
      });
      if (!commandResult.success) throw new Error("Desktop command is invalid.");
      const response = desktopResponseSchema.safeParse(await options.ipc.invoke(REQUEST_CHANNEL, commandResult.data));
      if (!response.success || response.data.requestId !== commandResult.data.requestId) {
        throw new Error("Desktop host returned invalid data.");
      }
      return response.data;
    },
    subscribe: (listener: (event: DesktopEvent) => void) => {
      const handler = (_event: unknown, value: unknown): void => {
        const event = desktopEventSchema.safeParse(value);
        if (!event.success) throw new Error("Desktop host returned an invalid event.");
        listener(event.data);
      };
      options.ipc.on(EVENT_CHANNEL, handler);
      let removed = false;
      return () => {
        if (removed) return;
        removed = true;
        options.ipc.removeListener(EVENT_CHANNEL, handler);
      };
    },
    onCloseRequest: (listener: () => Promise<boolean>) => {
      const handler = (_event: unknown, value: unknown): void => {
        const request = desktopCloseRequestSchema.safeParse(value);
        if (!request.success) return;
        void Promise.resolve()
          .then(listener)
          .then(
            (ok) => ok === true,
            () => false,
          )
          .then((ok) =>
            options.ipc.invoke(
              CLOSE_ACKNOWLEDGEMENT_CHANNEL,
              desktopCloseAcknowledgementSchema.parse({
                version: 1,
                requestId: request.data.requestId,
                ok,
              }),
            ),
          )
          .catch(() => undefined);
      };
      options.ipc.on(CLOSE_REQUEST_CHANNEL, handler);
      let removed = false;
      return () => {
        if (removed) return;
        removed = true;
        options.ipc.removeListener(CLOSE_REQUEST_CHANNEL, handler);
      };
    },
    onCloseBlocked: (listener: (reason: DesktopCloseFeedback["reason"]) => void) => {
      const handler = (_event: unknown, value: unknown): void => {
        const feedback = desktopCloseFeedbackSchema.safeParse(value);
        if (!feedback.success) return;
        listener(feedback.data.reason);
      };
      options.ipc.on(CLOSE_FEEDBACK_CHANNEL, handler);
      let removed = false;
      return () => {
        if (removed) return;
        removed = true;
        options.ipc.removeListener(CLOSE_FEEDBACK_CHANNEL, handler);
      };
    },
  });
}

if (contextBridge !== undefined && ipcRenderer !== undefined) {
  const api = createPreloadApi({
    platform: process.platform,
    crypto: globalThis.crypto,
    ipc: {
      invoke: (channel, command) => ipcRenderer.invoke(channel, command),
      on: (channel, handler) => {
        ipcRenderer.on(channel, handler as (event: IpcRendererEvent, value: unknown) => void);
      },
      removeListener: (channel, handler) => {
        ipcRenderer.removeListener(channel, handler as (event: IpcRendererEvent, value: unknown) => void);
      },
    },
  });
  contextBridge.exposeInMainWorld("rbxforge", api);
}
