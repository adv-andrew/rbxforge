import { randomUUID } from "node:crypto";

import type { LogCursor, PlayMode, PlaytestController, RuntimeLogBatch, RuntimeLogEntry } from "@rbxforge/core";
import {
  PROTOCOL_VERSION,
  parseWebviewMessage,
  type HostMessage,
  type PlaytestSnapshotMessage,
} from "@rbxforge/webview-ui/protocol";

import type { ExtensionServices } from "../service-container.js";
import type { DisposablePort, WebviewViewPort, WebviewViewProviderPort } from "../vscode-facade.js";
import { createWebviewHtml, createWebviewNonce, SecureWebviewHost } from "./webview-host.js";

export interface PlaytestProviderOptions {
  readonly controller: PlaytestController | undefined;
  readonly availability: PlaytestSnapshotMessage["capabilities"];
  readonly now?: () => number;
}

export class PlaytestProvider {
  readonly #controller: PlaytestController | undefined;
  readonly #availability: PlaytestSnapshotMessage["capabilities"];
  readonly #now: () => number;
  #entries: readonly RuntimeLogEntry[] = Object.freeze([]);
  #cursor: LogCursor | undefined;
  #localDropped = 0;
  #upstreamDropped = 0;
  #perCaptureErrors: Readonly<Record<string, string>> = Object.freeze({});
  #runtimeGeneration: number | undefined;
  #transientError: string | undefined;

  constructor(options: PlaytestProviderOptions) {
    this.#controller = options.controller;
    this.#availability = Object.freeze({ ...options.availability });
    this.#now = options.now ?? Date.now;
    this.#runtimeGeneration = options.controller?.state().runtimeGeneration;
  }

  snapshot(): PlaytestSnapshotMessage {
    this.#syncRuntimeGeneration();
    const state = this.#controller?.state();
    return {
      ...(state?.instanceId === undefined ? {} : { instanceId: state.instanceId }),
      state: state?.status ?? "unknown",
      ...(state?.mode === undefined ? {} : { mode: state.mode }),
      roles: [...(state?.roles ?? [])],
      runtimeGeneration: state?.runtimeGeneration ?? 0,
      observedAt: state?.observedAt ?? this.#now(),
      ...(this.#transientError === undefined && state?.error === undefined
        ? {}
        : { error: this.#transientError ?? state?.error }),
      capabilities: { ...this.#availability },
      entries: this.#entries.map((entry) => ({
        seq: entry.seq,
        ts: entry.ts,
        level: entry.level,
        message: entry.message,
        ...(entry.capturedBy === undefined ? {} : { capturedBy: entry.capturedBy }),
      })),
      totalDropped: this.#localDropped + this.#upstreamDropped,
      ...(this.#cursor === undefined
        ? {}
        : {
            cursor: typeof this.#cursor === "number" ? this.#cursor : { ...this.#cursor },
          }),
      perCaptureErrors: { ...this.#perCaptureErrors },
    };
  }

  async refresh(signal: AbortSignal): Promise<void> {
    const controller = this.#requireController("soloPlaytest");
    await controller.refreshStatus(signal);
  }

  async start(mode: PlayMode, signal: AbortSignal): Promise<void> {
    await this.#requireController("soloPlaytest").start(mode, signal);
  }

  async stop(signal: AbortSignal): Promise<void> {
    await this.#requireController("soloPlaytest").stop(signal);
  }

  async pollLogs(filter: string | undefined, signal: AbortSignal): Promise<void> {
    if (!this.#availability.logs) throw new Error("Studio MCP capability unavailable: runtimeLogs");
    this.#syncRuntimeGeneration();
    try {
      const batch = await this.#requireController("runtimeLogs").pollLogs(this.#cursor, signal);
      this.#syncRuntimeGeneration();
      this.acceptLogs(batch, filter);
      this.#transientError = undefined;
    } catch (error: unknown) {
      this.#transientError =
        error instanceof Error && error.name === "AbortError"
          ? "Runtime log capture cancelled"
          : "Runtime log capture failed";
      throw error;
    }
  }

  acceptLogs(batch: RuntimeLogBatch, _filter?: string): void {
    this.#syncRuntimeGeneration();
    let existing = this.#entries;
    if (typeof this.#cursor === "number" && batch.nextSince !== undefined && batch.nextSince < this.#cursor) {
      existing = Object.freeze([]);
    } else {
      for (const [role, next] of Object.entries(batch.perCaptureNextSince)) {
        const previous = typeof this.#cursor === "number" ? this.#cursor : this.#cursor?.[role];
        if (previous !== undefined && next < previous) {
          existing = Object.freeze(existing.filter((entry) => entry.capturedBy !== role));
        }
      }
    }
    const combined = [...existing, ...batch.entries];
    const retained: RuntimeLogEntry[] = [];
    let bytes = 0;
    let locallyDropped = 0;
    for (const entry of combined.slice().reverse()) {
      const size = Buffer.byteLength(JSON.stringify(entry), "utf8");
      if (retained.length >= 2_000 || bytes + size > 2 * 1_024 * 1_024) {
        locallyDropped += 1;
      } else {
        retained.push(entry);
        bytes += size;
      }
    }
    this.#entries = Object.freeze(retained.reverse());
    this.#localDropped += locallyDropped;
    this.#upstreamDropped = Math.max(this.#upstreamDropped, batch.totalDropped);
    this.#perCaptureErrors = Object.freeze(
      Object.fromEntries(Object.keys(batch.perCaptureErrors).map((role) => [role, "Runtime log capture failed"])),
    );
    this.#cursor =
      Object.keys(batch.perCaptureNextSince).length > 0
        ? Object.freeze({ ...batch.perCaptureNextSince })
        : batch.nextSince;
  }

  #syncRuntimeGeneration(): void {
    const generation = this.#controller?.state().runtimeGeneration;
    if (generation === undefined || generation === this.#runtimeGeneration) return;
    this.#runtimeGeneration = generation;
    this.#entries = Object.freeze([]);
    this.#cursor = undefined;
    this.#localDropped = 0;
    this.#upstreamDropped = 0;
    this.#perCaptureErrors = Object.freeze({});
    this.#transientError = undefined;
  }

  #requireController(capability: string): PlaytestController {
    if (this.#controller === undefined) {
      throw new Error(`Studio MCP capability unavailable: ${capability}`);
    }
    return this.#controller;
  }
}

export class PlaytestWebviewProvider implements WebviewViewProviderPort, DisposablePort {
  readonly #services: ExtensionServices;
  readonly #viewDisposables: DisposablePort[] = [];
  readonly #operations = new Set<AbortController>();
  #sessionId = "";
  #generation = 1;
  #host: SecureWebviewHost | undefined;
  #webview: WebviewViewPort["webview"] | undefined;
  #engine: PlaytestProvider | undefined;
  #controller: PlaytestController | undefined;
  #controllerDisposable: DisposablePort | undefined;
  #publishSequence = 0;

  constructor(options: { readonly services: ExtensionServices }) {
    this.#services = options.services;
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
      title: "RbxForge Playtest",
    });
    this.#bindEngine(true);
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
    this.#viewDisposables.push({
      dispose: this.#services.connection.onDidChange((snapshot) => {
        if (snapshot.checks.activeStudioInstance.health !== "healthy") {
          this.#abortOperations();
          this.#controller?.disconnect();
        }
        const nextInstanceId = this.#services.studio.snapshot().activeInstanceId;
        const currentInstanceId = this.#controller?.state().instanceId;
        if (nextInstanceId !== currentInstanceId) {
          this.#abortOperations();
          this.#controller?.disconnect();
          this.#generation += 1;
          this.#host?.advanceGeneration(this.#generation);
          this.#bindEngine();
          void this.#webview?.postMessage(this.#init());
        } else {
          this.#bindEngine();
          void this.#publish(`connection:${snapshot.revision}`);
        }
      }),
    });
    await webview.postMessage(this.#init());
  }

  dispose(): void {
    this.#disposeView();
    this.#webview = undefined;
    this.#host = undefined;
    this.#engine = undefined;
    this.#controller = undefined;
    this.#controllerDisposable?.dispose();
    this.#controllerDisposable = undefined;
  }

  async #receive(raw: unknown): Promise<void> {
    const host = this.#host;
    const webview = this.#webview;
    if (host === undefined || webview === undefined) return;
    let message;
    try {
      message = parseWebviewMessage(raw);
    } catch {
      await webview.postMessage(this.#protocolError());
      return;
    }
    if (!(await host.accept(message))) return;
    if (message.type === "ready") {
      await this.#publish(`ready:${message.requestId}`);
      return;
    }
    const operation = new AbortController();
    const operationGeneration = this.#generation;
    const engine = this.#engine;
    this.#operations.add(operation);
    try {
      if (message.type === "refreshPlaytest") {
        await engine?.refresh(operation.signal);
      } else if (message.type === "startPlaytest") {
        await engine?.start(message.mode, operation.signal);
      } else if (message.type === "stopPlaytest") {
        await engine?.stop(operation.signal);
      } else if (message.type === "pollRuntimeLogs") {
        await engine?.pollLogs(message.filter, operation.signal);
      } else {
        return;
      }
    } catch {
      // The controller snapshot carries lifecycle uncertainty; unavailable
      // capabilities remain explicit in the view model.
    } finally {
      this.#operations.delete(operation);
      if (!operation.signal.aborted && operationGeneration === this.#generation && engine === this.#engine) {
        await this.#publish(`operation:${message.requestId}`);
      }
    }
  }

  #bindEngine(forceSubscribe = false): void {
    const active = this.#services.studio.snapshot().activeInstanceId;
    const nextController = active === undefined ? undefined : this.#services.playtest.controller(active);
    if (nextController === this.#controller && this.#engine !== undefined) {
      if (forceSubscribe && this.#controllerDisposable === undefined && this.#controller !== undefined) {
        this.#subscribeController();
      }
      return;
    }
    this.#controllerDisposable?.dispose();
    this.#controllerDisposable = undefined;
    this.#controller = nextController;
    this.#engine = new PlaytestProvider({
      controller: this.#controller,
      availability: this.#services.playtest.availability(),
    });
    this.#subscribeController();
  }

  #subscribeController(): void {
    if (this.#controller === undefined || this.#controllerDisposable !== undefined) return;
    this.#controllerDisposable = this.#controller.onDidChange(() => {
      void this.#publish(`state:${this.#controller?.state().observedAt ?? 0}`);
    });
  }

  #abortOperations(): void {
    for (const operation of this.#operations) operation.abort();
    this.#operations.clear();
  }

  async #publish(requestId: string): Promise<void> {
    const host = this.#host;
    const engine = this.#engine;
    if (host === undefined || engine === undefined) return;
    this.#publishSequence += 1;
    await host.publish({
      v: PROTOCOL_VERSION,
      type: "playtestSnapshot",
      sessionId: this.#sessionId,
      requestId: `${requestId}:${this.#publishSequence}`,
      generation: this.#generation,
      snapshot: engine.snapshot(),
    });
  }

  #init(): HostMessage {
    return {
      v: PROTOCOL_VERSION,
      type: "init",
      sessionId: this.#sessionId,
      requestId: "init",
      generation: this.#generation,
      view: "playtest",
    };
  }

  #protocolError(): HostMessage {
    return {
      v: PROTOCOL_VERSION,
      type: "protocolError",
      sessionId: this.#sessionId,
      requestId: "protocol-error",
      generation: this.#generation,
      message: "Reload required",
    };
  }

  #disposeView(): void {
    this.#abortOperations();
    this.#controllerDisposable?.dispose();
    this.#controllerDisposable = undefined;
    for (const disposable of this.#viewDisposables.splice(0)) disposable.dispose();
  }
}
