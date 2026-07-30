import { randomUUID } from "node:crypto";

import { PROTOCOL_VERSION, parseWebviewMessage, type HostMessage } from "@rbxforge/webview-ui/protocol";

import type { ExtensionServices } from "./service-container.js";
import type { DisposablePort, VsCodeFacade, WebviewPanelPort } from "./vscode-facade.js";
import { createWebviewHtml, createWebviewNonce, SecureWebviewHost } from "./webviews/webview-host.js";

export type ViewportCaptureOutcome = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export class ViewportPanel implements DisposablePort {
  readonly #services: ExtensionServices;
  readonly #vscode: VsCodeFacade;
  readonly #extensionRoot: string;
  readonly #operations = new Set<AbortController>();
  readonly #panelDisposables: DisposablePort[] = [];
  #panel: WebviewPanelPort | undefined;
  #host: SecureWebviewHost | undefined;
  #sessionId = "";
  #generation = 1;
  #disposed = false;
  #captureId: string | undefined;
  #captureInstanceId: string | undefined;
  #captureFresh = false;

  constructor(options: {
    readonly services: ExtensionServices;
    readonly vscode: VsCodeFacade;
    readonly extensionRoot: string;
  }) {
    this.#services = options.services;
    this.#vscode = options.vscode;
    this.#extensionRoot = options.extensionRoot;
  }

  async capture(): Promise<ViewportCaptureOutcome> {
    if (this.#disposed) return this.#fail("Viewport panel is disposed");
    const availability = this.#services.playtest.availability();
    if (!availability.screenshot) {
      return this.#fail(trustedScreenshotUnavailableReason(availability.reason));
    }
    const before = this.#services.studio.snapshot();
    const connection = this.#services.connection.snapshot();
    if (
      connection.checks.activeStudioInstance.health !== "healthy" ||
      before.activeInstanceId === undefined ||
      before.stale
    ) {
      return this.#fail("Select a fresh Studio instance before capturing the viewport");
    }
    const controller = this.#services.playtest.controller(before.activeInstanceId);
    if (controller === undefined) {
      return this.#fail("Studio MCP screenshot capability is unavailable");
    }
    const host = this.#ensurePanel();
    const operation = new AbortController();
    this.#operations.add(operation);
    await host.publish(
      this.#message("viewportStatus", `loading:${randomUUID()}`, {
        state: "loading",
      }),
    );
    try {
      const capture = await controller.captureScreenshot(operation.signal);
      if (this.#disposed || this.#panel === undefined || operation.signal.aborted) {
        return { ok: false, reason: "Viewport capture was cancelled" };
      }
      const after = this.#services.studio.snapshot();
      const freshness =
        !after.stale && after.activeInstanceId === before.activeInstanceId ? ("fresh" as const) : ("stale" as const);
      const captureId = randomUUID();
      this.#captureId = captureId;
      this.#captureInstanceId = before.activeInstanceId;
      this.#captureFresh = freshness === "fresh";
      await host.publish({
        v: PROTOCOL_VERSION,
        type: "viewportCapture",
        sessionId: this.#sessionId,
        requestId: `capture:${randomUUID()}`,
        generation: this.#generation,
        capture: {
          captureId,
          capturedAt: capture.capturedAt,
          freshness,
          target: capture.target,
          ...(capture.width === undefined ? {} : { width: capture.width }),
          ...(capture.height === undefined ? {} : { height: capture.height }),
          format: capture.format,
          ...(capture.quality === undefined ? {} : { quality: capture.quality }),
          mimeType: capture.mimeType,
          data: capture.data,
        },
      });
      return { ok: true };
    } catch (error: unknown) {
      const reason =
        error instanceof Error && error.name === "AbortError"
          ? "Viewport capture was cancelled"
          : "Viewport capture failed";
      if (!this.#disposed && this.#panel !== undefined) {
        await host.publish(
          this.#message("viewportStatus", `error:${randomUUID()}`, {
            state: "error",
            detail: reason,
          }),
        );
      }
      return { ok: false, reason };
    } finally {
      this.#operations.delete(operation);
    }
  }

  reveal(): void {
    this.#panel?.reveal();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const operation of this.#operations) operation.abort();
    this.#operations.clear();
    const panel = this.#panel;
    this.#clearPanel();
    panel?.dispose();
  }

  #ensurePanel(): SecureWebviewHost {
    if (this.#panel !== undefined && this.#host !== undefined) {
      this.#panel.reveal();
      return this.#host;
    }
    const panel = this.#vscode.createWebviewPanel("rbxforge.viewport", "RbxForge Viewport", {
      extensionRoot: this.#extensionRoot,
    });
    this.#panel = panel;
    this.#sessionId = randomUUID();
    this.#generation = 1;
    panel.webview.options = { enableScripts: true, localResourceRoots: ["media/webview"] };
    panel.webview.html = createWebviewHtml({
      cspSource: panel.webview.cspSource,
      nonce: createWebviewNonce(),
      scriptUri: panel.webview.asWebviewUri("media/webview/webview.js"),
      styleUri: panel.webview.asWebviewUri("media/webview/webview.css"),
      title: "RbxForge Viewport",
      allowBlobImages: true,
    });
    const host = new SecureWebviewHost({
      sessionId: this.#sessionId,
      initialGeneration: this.#generation,
      postMessage: (message) => panel.webview.postMessage(message),
    });
    this.#host = host;
    this.#panelDisposables.push(
      panel.webview.onDidReceiveMessage((raw) => {
        void this.#receive(raw);
      }),
    );
    this.#panelDisposables.push(panel.onDidDispose(() => this.#clearPanel()));
    const disposeConnection = this.#services.connection.onDidChange((snapshot) => {
      const studio = this.#services.studio.snapshot();
      const available =
        snapshot.checks.activeStudioInstance.health === "healthy" &&
        !studio.stale &&
        studio.activeInstanceId !== undefined;
      if (
        !available ||
        (this.#captureInstanceId !== undefined && studio.activeInstanceId !== this.#captureInstanceId)
      ) {
        for (const operation of this.#operations) operation.abort();
        void this.#markCaptureStale();
      }
    });
    this.#panelDisposables.push({ dispose: disposeConnection });
    void panel.webview.postMessage({
      v: PROTOCOL_VERSION,
      type: "init",
      sessionId: this.#sessionId,
      requestId: "init",
      generation: this.#generation,
      view: "viewport",
    } satisfies HostMessage);
    return host;
  }

  async #receive(raw: unknown): Promise<void> {
    const host = this.#host;
    const panel = this.#panel;
    if (host === undefined || panel === undefined) return;
    let message;
    try {
      message = parseWebviewMessage(raw);
    } catch {
      await panel.webview.postMessage({
        v: PROTOCOL_VERSION,
        type: "protocolError",
        sessionId: this.#sessionId,
        requestId: "protocol-error",
        generation: this.#generation,
        message: "Reload required",
      });
      return;
    }
    if (!(await host.accept(message))) return;
    if (message.type === "ready") {
      await host.publish(
        this.#message("viewportStatus", `ready:${message.requestId}`, {
          state: "empty",
        }),
      );
    } else if (message.type === "captureViewport") {
      await this.capture();
    }
  }

  #message(
    type: "viewportStatus",
    requestId: string,
    body: { readonly state: "empty" | "loading" | "error"; readonly detail?: string },
  ): HostMessage {
    return {
      v: PROTOCOL_VERSION,
      type,
      sessionId: this.#sessionId,
      requestId,
      generation: this.#generation,
      state: body.state,
      ...(body.detail === undefined ? {} : { detail: body.detail }),
    };
  }

  async #fail(reason: string): Promise<ViewportCaptureOutcome> {
    if (!this.#disposed && this.#host !== undefined && this.#panel !== undefined) {
      await this.#host.publish(
        this.#message("viewportStatus", `error:${randomUUID()}`, {
          state: "error",
          detail: reason,
        }),
      );
    }
    return { ok: false, reason };
  }

  async #markCaptureStale(): Promise<void> {
    if (!this.#captureFresh || this.#captureId === undefined || this.#host === undefined || this.#panel === undefined)
      return;
    this.#captureFresh = false;
    await this.#host.publish({
      v: PROTOCOL_VERSION,
      type: "viewportStale",
      sessionId: this.#sessionId,
      requestId: `stale:${randomUUID()}`,
      generation: this.#generation,
      captureId: this.#captureId,
    });
  }

  #clearPanel(): void {
    for (const operation of this.#operations) operation.abort();
    this.#operations.clear();
    for (const disposable of this.#panelDisposables.splice(0)) disposable.dispose();
    this.#panel = undefined;
    this.#host = undefined;
    this.#captureId = undefined;
    this.#captureInstanceId = undefined;
    this.#captureFresh = false;
  }
}

function trustedScreenshotUnavailableReason(reason: string | undefined): string {
  switch (reason) {
    case "Studio MCP has not been discovered":
    case "Studio MCP playtest capabilities are unavailable in fixture mode":
    case "Studio MCP capability unavailable: capture_screenshot":
    case "Studio MCP capabilities unavailable: solo_playtest, capture_screenshot":
    case "Studio MCP capabilities unavailable: get_runtime_logs, capture_screenshot":
    case "Studio MCP capabilities unavailable: solo_playtest, get_runtime_logs, capture_screenshot":
      return reason;
    default:
      return "Studio MCP screenshot capability is unavailable";
  }
}
