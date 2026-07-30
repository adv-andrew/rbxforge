import { randomUUID } from "node:crypto";

import {
  PROTOCOL_VERSION,
  parseWebviewMessage,
  type ActivityEntryMessage,
  type HostMessage,
} from "@rbxforge/webview-ui/protocol";

import type { ExtensionServices } from "../service-container.js";
import type { DisposablePort, WebviewViewPort, WebviewViewProviderPort } from "../vscode-facade.js";
import { createWebviewHtml, createWebviewNonce, SecureWebviewHost } from "./webview-host.js";

export function createActivityEntries(services: ExtensionServices): readonly ActivityEntryMessage[] {
  const mutations: ActivityEntryMessage[] = services.journal.entries().map((entry) => {
    const sourcePath = services.source.pathFor(entry.target);
    return {
      id: entry.id,
      timestamp: entry.timestamp,
      ...(entry.instanceId === undefined ? {} : { instanceId: entry.instanceId }),
      operation: entry.operation,
      result: entry.result,
      ...(entry.verification === undefined ? {} : { verification: entry.verification }),
      detail: entry.target,
      ...(sourcePath === undefined ? {} : { sourcePath }),
    };
  });
  const runtime: ActivityEntryMessage[] = services.activity.entries().map((entry) => ({
    id: entry.id,
    timestamp: entry.timestamp,
    instanceId: entry.instanceId,
    operation: entry.operation,
    result: entry.result,
    ...(entry.verification === undefined ? {} : { verification: entry.verification }),
    ...(entry.droppedLogs === undefined ? {} : { droppedLogs: entry.droppedLogs }),
    ...(entry.detail === undefined ? {} : { detail: entry.detail }),
  }));
  return Object.freeze(
    [...mutations, ...runtime]
      .sort((left, right) => left.timestamp.localeCompare(right.timestamp))
      .slice(-1_000)
      .map((entry) => Object.freeze(entry)),
  );
}

export class ActivityWebviewProvider implements WebviewViewProviderPort, DisposablePort {
  readonly #services: ExtensionServices;
  readonly #vscode: { openTextDocument(path: string): Promise<void> };
  readonly #viewDisposables: DisposablePort[] = [];
  #sessionId = "";
  #generation = 1;
  #host: SecureWebviewHost | undefined;
  #webview: WebviewViewPort["webview"] | undefined;

  constructor(options: {
    readonly services: ExtensionServices;
    readonly vscode: { openTextDocument(path: string): Promise<void> };
  }) {
    this.#services = options.services;
    this.#vscode = options.vscode;
  }

  async resolveWebviewView(view: WebviewViewPort): Promise<void> {
    this.#disposeView();
    this.#sessionId = randomUUID();
    this.#generation = 1;
    this.#webview = view.webview;
    const webview = view.webview;
    webview.options = { enableScripts: true, localResourceRoots: ["media/webview"] };
    webview.html = createWebviewHtml({
      cspSource: webview.cspSource,
      nonce: createWebviewNonce(),
      scriptUri: webview.asWebviewUri("media/webview/webview.js"),
      styleUri: webview.asWebviewUri("media/webview/webview.css"),
      title: "RbxForge Activity",
    });
    this.#host = new SecureWebviewHost({
      sessionId: this.#sessionId,
      initialGeneration: this.#generation,
      postMessage: (message) => webview.postMessage(message),
    });
    this.#viewDisposables.push(
      webview.onDidReceiveMessage((raw) => {
        void this.#receive(raw);
      }),
    );
    this.#viewDisposables.push(
      this.#services.journal.onDidAppend((entry) => {
        void this.#publish(`mutation:${entry.id}`);
      }),
    );
    this.#viewDisposables.push(
      this.#services.activity.onDidAppend((entry) => {
        void this.#publish(`activity:${entry.id}`);
      }),
    );
    await webview.postMessage(this.#init());
  }

  dispose(): void {
    this.#disposeView();
    this.#host = undefined;
    this.#webview = undefined;
  }

  async #receive(raw: unknown): Promise<void> {
    const host = this.#host;
    const webview = this.#webview;
    if (host === undefined || webview === undefined) return;
    let message;
    try {
      message = parseWebviewMessage(raw);
    } catch {
      await webview.postMessage({
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
    if (message.type === "ready" || message.type === "refreshActivity") {
      await this.#publish(`refresh:${message.requestId}`);
    } else if (message.type === "openActivitySource") {
      const entry = createActivityEntries(this.#services).find((candidate) => candidate.id === message.entryId);
      if (entry?.sourcePath !== undefined) {
        const current = this.#services.source.pathFor(entry.detail ?? "");
        if (current === entry.sourcePath) await this.#vscode.openTextDocument(entry.sourcePath);
      }
    }
  }

  async #publish(requestId: string): Promise<void> {
    await this.#host?.publish({
      v: PROTOCOL_VERSION,
      type: "activitySnapshot",
      sessionId: this.#sessionId,
      requestId,
      generation: this.#generation,
      entries: [...createActivityEntries(this.#services)],
    });
  }

  #init(): HostMessage {
    return {
      v: PROTOCOL_VERSION,
      type: "init",
      sessionId: this.#sessionId,
      requestId: "init",
      generation: this.#generation,
      view: "activity",
    };
  }

  #disposeView(): void {
    for (const disposable of this.#viewDisposables.splice(0)) disposable.dispose();
  }
}
