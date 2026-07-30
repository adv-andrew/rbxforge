import { randomUUID } from "node:crypto";

import type { ConnectionAction, ConnectionSnapshot } from "@rbxforge/webview-ui/protocol";

import type { CheckId, ConnectionStateSnapshot } from "../connection-state.js";
import type { ExtensionServices } from "../service-container.js";
import type { DisposablePort, VsCodeFacade, WebviewViewPort, WebviewViewProviderPort } from "../vscode-facade.js";
import { createWebviewHtml, createWebviewNonce, SecureWebviewHost } from "./webview-host.js";
import { parseWebviewMessage, PROTOCOL_VERSION } from "@rbxforge/webview-ui/protocol";

const labels: Readonly<Record<CheckId, string>> = {
  workspace: "Workspace",
  rojoBinary: "Rojo binary",
  rojoProcess: "Rojo process",
  rojoApi: "Rojo API",
  mcpProcess: "Studio MCP",
  studioPlugin: "Studio plugin",
  studioPlace: "Studio place",
  activeStudioInstance: "Active Studio instance",
  placeRestriction: "Place restriction",
  aiProvider: "AI provider",
};

const commands: Readonly<Record<ConnectionAction, string>> = {
  selectProject: "rbxforge.selectProject",
  startRojo: "rbxforge.startRojo",
  stopRojo: "rbxforge.stopRojo",
  installStudioPlugin: "rbxforge.installStudioPlugin",
  selectStudioInstance: "rbxforge.selectStudioInstance",
  refreshStudio: "rbxforge.refreshStudio",
};

export function createConnectionViewModel(snapshot: ConnectionStateSnapshot): ConnectionSnapshot {
  return {
    aggregate:
      snapshot.checks !== undefined &&
      Object.values(snapshot.checks).every((check) => !check.required || check.health === "healthy")
        ? "Ready"
        : "Not ready",
    simulation: snapshot.simulation,
    observedAt: snapshot.observedAt,
    checks: Object.values(snapshot.checks).map((check) => {
      const action = recoveryAction(check.id, check.health);
      return {
        id: check.id,
        label: labels[check.id],
        required: check.required,
        health: check.health,
        detail: check.detail,
        observedAt: check.observedAt,
        ...(action === undefined ? {} : { action }),
      };
    }),
  };
}

export async function runConnectionAction(
  action: ConnectionAction,
  executeCommand: (command: string) => Promise<unknown>,
): Promise<void> {
  await executeCommand(commands[action]);
}

function recoveryAction(
  id: CheckId,
  health: "unknown" | "checking" | "healthy" | "unhealthy",
): ConnectionAction | undefined {
  if (health === "checking") return undefined;
  if (id === "workspace") return health === "healthy" ? undefined : "selectProject";
  if (id === "rojoProcess") return health === "healthy" ? "stopRojo" : "startRojo";
  if (id === "rojoBinary" || id === "rojoApi") return health === "healthy" ? undefined : "startRojo";
  if (id === "studioPlugin") return health === "healthy" ? undefined : "installStudioPlugin";
  if (id === "activeStudioInstance" || id === "placeRestriction") {
    return health === "healthy" ? undefined : "selectStudioInstance";
  }
  if (id === "mcpProcess" || id === "studioPlace") {
    return health === "healthy" ? undefined : "refreshStudio";
  }
  return undefined;
}

export class ConnectionWebviewProvider implements WebviewViewProviderPort, DisposablePort {
  readonly #services: ExtensionServices;
  readonly #vscode: VsCodeFacade;
  readonly #viewDisposables: DisposablePort[] = [];
  constructor(options: { readonly services: ExtensionServices; readonly vscode: VsCodeFacade }) {
    this.#services = options.services;
    this.#vscode = options.vscode;
  }
  async resolveWebviewView(view: WebviewViewPort): Promise<void> {
    this.#disposeView();
    const sessionId = randomUUID();
    const generation = 1;
    const webview = view.webview;
    webview.options = { enableScripts: true, localResourceRoots: ["media/webview"] };
    const nonce = createWebviewNonce();
    webview.html = createWebviewHtml({
      cspSource: webview.cspSource,
      nonce,
      scriptUri: webview.asWebviewUri("media/webview/webview.js"),
      styleUri: webview.asWebviewUri("media/webview/webview.css"),
      title: "RbxForge Connection",
    });
    const host = new SecureWebviewHost({
      sessionId,
      initialGeneration: generation,
      postMessage: (message) => webview.postMessage(message),
    });
    const publish = async (requestId: string): Promise<void> => {
      await host.publish({
        v: PROTOCOL_VERSION,
        type: "connectionSnapshot",
        sessionId,
        requestId,
        generation,
        snapshot: createConnectionViewModel(this.#services.connection.snapshot()),
      });
    };
    this.#viewDisposables.push(
      webview.onDidReceiveMessage((raw) => {
        void (async () => {
          let message;
          try {
            message = parseWebviewMessage(raw);
          } catch {
            await webview.postMessage({
              v: PROTOCOL_VERSION,
              type: "protocolError",
              sessionId,
              requestId: "protocol-error",
              generation,
              message: "Reload required",
            });
            return;
          }
          if (!(await host.accept(message))) return;
          if (message.type === "ready" || message.type === "refreshConnection") {
            await publish(`snapshot:${message.requestId}`);
          } else if (message.type === "runConnectionAction") {
            await runConnectionAction(message.action, (command) => this.#vscode.executeCommand(command));
            await publish(`action:${message.requestId}`);
          }
        })();
      }),
    );
    this.#viewDisposables.push({
      dispose: this.#services.connection.onDidChange(() => {
        void publish(`connection:${this.#services.connection.snapshot().revision}`);
      }),
    });
    await webview.postMessage({
      v: PROTOCOL_VERSION,
      type: "init",
      sessionId,
      requestId: "init",
      generation,
      view: "connection",
    });
  }
  dispose(): void {
    this.#disposeView();
  }
  #disposeView(): void {
    for (const disposable of this.#viewDisposables.splice(0)) disposable.dispose();
  }
}
