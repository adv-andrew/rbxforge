import type { DesktopCloseFeedback, DesktopCommandInput, DesktopEvent, DesktopResponse } from "../shared/protocol.js";

interface RendererRbxForgeApi {
  readonly platform: string;
  request(input: DesktopCommandInput): Promise<DesktopResponse>;
  subscribe(listener: (event: DesktopEvent) => void): () => void;
  onCloseRequest(listener: () => Promise<boolean>): () => void;
  onCloseBlocked(listener: (reason: DesktopCloseFeedback["reason"]) => void): () => void;
}

declare global {
  interface Window {
    readonly rbxforge: Readonly<RendererRbxForgeApi>;
  }
}

export {};
