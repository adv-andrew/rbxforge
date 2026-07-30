import { createHash, randomUUID } from "node:crypto";
import { dirname, isAbsolute, relative, sep } from "node:path";
import { realpath } from "node:fs/promises";

import {
  AgentLoop,
  CONTEXT_LIMITS,
  OpenAIResponsesProvider,
  isSecretLikeContent,
  isSensitivePath,
  type AgentEvent,
  type AgentMode,
  type ContextSourceKind,
  type ModelProvider,
  type ModelSession,
  type ProviderEvent,
  type ProviderRequest,
  type ProviderTurnInput,
} from "@rbxforge/agent";
import {
  AGENT_TEXT_DELTA_MAX_BYTES,
  PROTOCOL_VERSION,
  parseWebviewMessage,
  type AgentSnapshotMessage,
  type HostMessage,
} from "@rbxforge/webview-ui/protocol";

import { AiCredentialStore, DEFAULT_OPENAI_MODEL } from "../ai-credentials.js";
import { createAgentToolRegistry } from "../agent-tools.js";
import type { PropertiesCommandTarget } from "../commands.js";
import { FilesystemPatchHost } from "../filesystem-patch-host.js";
import type { ExtensionServices } from "../service-container.js";
import type { DisposablePort, VsCodeFacade, WebviewViewPort, WebviewViewProviderPort } from "../vscode-facade.js";
import { createWebviewHtml, createWebviewNonce, SecureWebviewHost } from "./webview-host.js";

interface Chip {
  readonly id: string;
  readonly label: string;
  readonly kind: ContextSourceKind;
}

interface LastRun {
  readonly runId: string;
  readonly mode: AgentMode;
  readonly prompt: string;
  readonly chipIds: readonly string[];
}

interface ActiveRun {
  readonly runId: string;
  readonly abort: AbortController;
  readonly completion: Promise<void>;
}

type HostPayload = HostMessage extends infer Message
  ? Message extends HostMessage
    ? Omit<Message, "v" | "sessionId" | "requestId" | "generation">
    : never
  : never;

export interface AgentWebviewProviderOptions {
  readonly services: ExtensionServices;
  readonly vscode: VsCodeFacade;
  readonly modelProvider?: ModelProvider;
  readonly now?: () => number;
  readonly randomId?: () => string;
}

export class AgentWebviewProvider implements WebviewViewProviderPort, DisposablePort {
  readonly #services: ExtensionServices;
  readonly #vscode: VsCodeFacade;
  readonly #now: () => number;
  readonly #randomId: () => string;
  readonly #credentials: AiCredentialStore;
  readonly #loop: AgentLoop;
  readonly #tools: ReturnType<typeof createAgentToolRegistry>;
  readonly #lifetime: DisposablePort[] = [];
  readonly #targets = new Map<string, PropertiesCommandTarget>();
  readonly #chips = new Map<string, Chip>();
  readonly #viewDisposables: DisposablePort[] = [];
  #sessionId: string;
  #generation = 1;
  #webview: WebviewViewPort["webview"] | undefined;
  #host: SecureWebviewHost | undefined;
  #active: ActiveRun | undefined;
  #last: LastRun | undefined;
  #status: AgentSnapshotMessage["status"] = "empty";
  #detail: string | undefined;
  #mode: AgentMode = "ask";
  #disposed = false;
  #shutdownPromise: Promise<void> | undefined;
  #activeFileChipId: string | undefined;
  #hostSequence = 0;
  #textSequence = 0;

  constructor(options: AgentWebviewProviderOptions) {
    this.#services = options.services;
    this.#vscode = options.vscode;
    this.#now = options.now ?? Date.now;
    this.#randomId = options.randomId ?? randomUUID;
    this.#sessionId = this.#randomId();
    this.#credentials = new AiCredentialStore(options.vscode);
    const patchHost = new FilesystemPatchHost({
      vscode: options.vscode,
      journal: options.services.journal,
      approvalBroker: options.services.agent.approvalBroker,
      workspaceRoot: () => this.#workspaceRoot(),
      ignorePolicy: options.services.agent.ignorePolicy,
      now: this.#now,
      randomId: this.#randomId,
    });
    this.#tools = createAgentToolRegistry({
      services: options.services,
      patchHost,
      onContextChip: (chip) => this.#acceptContextChip(chip),
      now: this.#now,
      randomId: this.#randomId,
    });
    const provider =
      options.modelProvider ??
      (options.services.connection.snapshot().simulation
        ? new FixtureAgentModelProvider()
        : new OpenAIResponsesProvider({
            getCredential: (signal) => this.#credentials.credential(signal),
          }));
    this.#loop = new AgentLoop({
      contextAssembler: options.services.agent.contextRegistry,
      provider,
      tools: this.#tools.tools,
      approvalBroker: options.services.agent.approvalBroker,
      now: this.#now,
    });
    this.#lifetime.push(
      options.services.graph.onGraphInvalidated(({ path }) => {
        if (
          [...this.#targets.keys()].some(
            (target) => target === path || target.startsWith(`${path}.`) || path.startsWith(`${target}.`),
          )
        ) {
          this.#invalidateStudioContext("Selected Studio context changed. Re-add it before running.", "graph-stale");
        }
      }),
    );
    this.#lifetime.push(
      options.services.graph.onConnectionChanged(() => {
        if (this.#targets.size === 0) return;
        this.#invalidateStudioContext(
          "The Studio connection changed. Re-add selected context before running.",
          "connection-stale",
        );
      }),
    );
  }

  async resolveWebviewView(view: WebviewViewPort): Promise<void> {
    this.#disposeView();
    if (this.#webview !== undefined) {
      const activeRunId = this.#active?.runId;
      this.#active?.abort.abort(new Error("Agent webview session replaced"));
      if (activeRunId !== undefined) {
        this.#services.agent.approvalBroker.cancelRun(activeRunId);
        this.#services.agent.studioWrites?.revokeRun(activeRunId);
      }
      this.#active = undefined;
      this.#last = undefined;
      this.#services.agent.contextRegistry.revokeSession(this.#sessionId);
      this.#chips.clear();
      this.#activeFileChipId = undefined;
      this.#sessionId = this.#randomId();
    }
    this.#webview = view.webview;
    this.#generation = 1;
    this.#hostSequence = 0;
    const webview = view.webview;
    webview.options = { enableScripts: true, localResourceRoots: ["media/webview"] };
    webview.html = createWebviewHtml({
      cspSource: webview.cspSource,
      nonce: createWebviewNonce(),
      scriptUri: webview.asWebviewUri("media/webview/webview.js"),
      styleUri: webview.asWebviewUri("media/webview/webview.css"),
      title: "RbxForge Agent",
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
    for (const target of this.#targets.values()) await this.#mintStudioChip(target);
    const root = await this.#workspaceRoot();
    if (root !== undefined) await this.#mintActiveFileChip(root);
    this.#status = this.#connected() ? "ready" : "empty";
    await webview.postMessage(
      this.#message({
        type: "init",
        view: "agent",
      }),
    );
  }

  async addStudioContext(target: PropertiesCommandTarget): Promise<void> {
    if (this.#disposed) return;
    this.#revokeTargetChips(target.path);
    this.#targets.set(target.path, Object.freeze({ ...target }));
    if (this.#webview !== undefined) await this.#mintStudioChip(target);
    this.#status = this.#connected() ? "ready" : "empty";
    this.#detail = undefined;
    await this.#publishSnapshot("context-added");
  }

  async configureCredential(): Promise<boolean> {
    return this.#credentials.configure();
  }

  dispose(): void {
    void this.shutdown().catch(() => undefined);
  }

  async shutdown(): Promise<void> {
    this.#shutdownPromise ??= (async () => {
      if (this.#disposed) return;
      this.#disposed = true;
      const activeRunId = this.#active?.runId;
      this.#active?.abort.abort(new Error("Agent provider disposed"));
      if (activeRunId !== undefined) {
        this.#services.agent.approvalBroker.cancelRun(activeRunId);
        this.#services.agent.studioWrites?.revokeRun(activeRunId);
      }
      this.#disposeView();
      for (const disposable of this.#lifetime.splice(0)) disposable.dispose();
      await this.#loop.dispose();
      this.#tools.dispose();
      this.#services.agent.contextRegistry.revokeSession(this.#sessionId);
      this.#chips.clear();
      this.#activeFileChipId = undefined;
      this.#host = undefined;
      this.#webview = undefined;
    })();
    return this.#shutdownPromise;
  }

  async #receive(raw: unknown): Promise<void> {
    const host = this.#host;
    const webview = this.#webview;
    if (host === undefined || webview === undefined || this.#disposed) return;
    let message;
    try {
      message = parseWebviewMessage(raw);
    } catch {
      await webview.postMessage(
        this.#message({
          type: "protocolError",
          message: "Invalid Agent message.",
        }),
      );
      return;
    }
    if (!(await host.accept(message))) return;
    if (message.type === "ready") {
      await this.#publishSnapshot("ready");
      return;
    }
    if (message.type === "startAgentRun") {
      if (this.#active !== undefined) return;
      if (this.#status === "stale") {
        this.#detail = "Re-add stale context before running.";
        await this.#publishSnapshot("stale-run");
        return;
      }
      const allowed = message.chipIds.filter((chipId) => this.#chips.has(chipId));
      if (allowed.length !== message.chipIds.length) {
        this.#status = "stale";
        this.#detail = "One or more context chips are stale.";
        await this.#publishSnapshot("stale-selection");
        return;
      }
      await this.#start(message.mode, message.prompt, allowed);
      return;
    }
    if (message.type === "stopAgentRun") {
      if (this.#active?.runId !== message.runId) return;
      this.#status = "stopping";
      await this.#publishSnapshot("stopping");
      this.#active.abort.abort(new Error("User stopped Agent"));
      this.#services.agent.approvalBroker.cancelRun(message.runId);
      this.#services.agent.studioWrites?.revokeRun(message.runId);
      return;
    }
    if (message.type === "retryAgentRun") {
      if (this.#active !== undefined || this.#last?.runId !== message.previousRunId) return;
      if (this.#status === "stale") return;
      await this.#start(this.#last.mode, this.#last.prompt, this.#last.chipIds);
      return;
    }
    if (message.type === "removeAgentContext") {
      if (this.#active !== undefined) return;
      this.#chips.delete(message.chipId);
      this.#services.agent.contextRegistry.revoke(message.chipId);
      if (this.#activeFileChipId === message.chipId) this.#activeFileChipId = undefined;
      for (const [path, target] of this.#targets) {
        if (![...this.#chips.values()].some((chip) => chip.label === target.path)) this.#targets.delete(path);
      }
      await this.#publishSnapshot("context-removed");
      return;
    }
    if (message.type === "resolveAgentApproval") {
      this.#services.agent.approvalBroker.resolve({
        sessionId: message.sessionId,
        generation: message.generation,
        runId: message.runId,
        approvalId: message.approvalId,
        decision: message.decision,
      });
      return;
    }
    if (message.type === "openAgentDiff") {
      if (this.#active?.runId !== message.runId && this.#last?.runId !== message.runId) return;
      await this.#tools.patchHost.previewApproval(message.approvalId);
    }
  }

  async #start(mode: AgentMode, prompt: string, chipIds: readonly string[]): Promise<void> {
    const root = await this.#workspaceRoot();
    if (root === undefined) {
      this.#status = "error";
      this.#detail = "Select one Rojo project or open exactly one workspace folder.";
      await this.#publishSnapshot("missing-root");
      return;
    }
    let model = DEFAULT_OPENAI_MODEL;
    if (!this.#services.connection.snapshot().simulation) {
      try {
        model = this.#credentials.settings().model;
      } catch {
        this.#status = "error";
        this.#detail = "AI provider settings are invalid.";
        await this.#publishSnapshot("invalid-settings");
        return;
      }
    }
    const runId = this.#randomId();
    const abort = new AbortController();
    const refreshActiveFile = this.#activeFileChipId !== undefined && chipIds.includes(this.#activeFileChipId);
    const activeFileChipId = refreshActiveFile ? await this.#mintActiveFileChip(root) : undefined;
    const effectiveChipIds = Object.freeze([
      ...new Set([
        ...chipIds.filter((chipId) => this.#chips.has(chipId)),
        ...(activeFileChipId === undefined ? [] : [activeFileChipId]),
      ]),
    ]);
    this.#mode = mode;
    this.#status = "running";
    this.#detail = undefined;
    this.#textSequence = 0;
    this.#last = Object.freeze({ runId, mode, prompt, chipIds: effectiveChipIds });
    const completion = this.#consumeRun(runId, mode, prompt, effectiveChipIds, root, model, abort);
    this.#active = { runId, abort, completion };
    await this.#publishSnapshot("run-start");
    void completion;
  }

  async #consumeRun(
    runId: string,
    mode: AgentMode,
    prompt: string,
    chipIds: readonly string[],
    root: string,
    model: string,
    abort: AbortController,
  ): Promise<void> {
    try {
      for await (const event of this.#loop.run(
        {
          sessionId: this.#sessionId,
          generation: this.#generation,
          runId,
          mode,
          prompt,
          model,
          context: {
            chipIds,
            workspaceRoot: root,
            sessionId: this.#sessionId,
            generation: this.#generation,
            ...studioBinding(this.#services),
          },
          simulation: this.#services.connection.snapshot().simulation,
        },
        abort.signal,
      )) {
        if (!this.#current(runId)) return;
        await this.#publishAgentEvent(runId, event);
      }
    } finally {
      if (this.#active?.runId === runId) this.#active = undefined;
    }
  }

  async #publishAgentEvent(runId: string, event: AgentEvent): Promise<void> {
    if (event.type === "started" || event.type === "context") return;
    if (event.type === "text-delta") {
      for (const delta of chunkUtf8(event.delta, AGENT_TEXT_DELTA_MAX_BYTES)) {
        this.#textSequence += 1;
        await this.#publish(
          this.#message({
            type: "agentTextDelta",
            runId,
            sequence: this.#textSequence,
            delta,
          }),
        );
      }
      return;
    }
    if (event.type === "tool-call") {
      await this.#publish(
        this.#message({
          type: "agentToolCard",
          card: {
            runId,
            callId: event.callId,
            name: event.name,
            access: event.access,
            state: event.state,
            ...(event.code === undefined ? {} : { code: event.code }),
          },
        }),
      );
      return;
    }
    if (event.type === "approval-required") {
      await this.#publish(
        this.#message({
          type: "agentApproval",
          approval: {
            runId,
            approvalId: event.approvalId,
            kind: event.kind,
            summary: event.summary,
            expiresAt: event.expiresAt,
            ...(event.change === undefined ? {} : { change: event.change }),
          },
        }),
      );
      return;
    }
    if (event.type === "completed") {
      this.#status = "completed";
      await this.#publish(
        this.#message({
          type: "agentTerminal",
          runId,
          state: "completed",
          verification: event.verification,
        }),
      );
      return;
    }
    const stopped = event.code === "cancelled";
    this.#status = stopped ? "ready" : "error";
    this.#detail = event.message;
    await this.#publish(
      this.#message({
        type: "agentTerminal",
        runId,
        state: stopped ? "stopped" : "error",
        code: event.code,
        message: event.message,
      }),
    );
  }

  async #mintStudioChip(target: PropertiesCommandTarget): Promise<void> {
    const root = await this.#workspaceRoot();
    if (root === undefined) throw new Error("A workspace boundary is required for Agent context");
    const studio = this.#services.studio.snapshot();
    if (studio.stale || studio.activeInstanceId === undefined) throw new Error("Select a live Studio instance");
    const resolved = await this.#services.graph.resolve(target.path, new AbortController().signal);
    const instanceId = studio.activeInstanceId;
    const id = this.#services.agent.contextRegistry.register({
      kind: "studio-properties",
      label: target.path,
      workspaceRoot: root,
      sessionId: this.#sessionId,
      generation: this.#generation,
      expiresAt: this.#now() + 30 * 60_000,
      instanceId,
      graphRevision: resolved.revision,
      isCurrent: () => {
        const current = this.#services.studio.snapshot();
        if (current.stale || current.activeInstanceId !== instanceId) return false;
        this.#services.graph.assertRevision(resolved.revision);
        return true;
      },
      resolve: async (signal) => {
        if (signal.aborted) throw signal.reason ?? new Error("Context read aborted");
        const properties = await this.#services.studio.guardedProperties(target.path, {
          expectedInstanceId: instanceId,
        });
        return Object.freeze({
          content: JSON.stringify({
            path: properties.instancePath,
            className: properties.className,
            properties: properties.properties,
          }),
        });
      },
    });
    this.#chips.set(id, Object.freeze({ id, label: target.path, kind: "studio-properties" }));
  }

  async #mintActiveFileChip(root: string): Promise<string | undefined> {
    if (this.#activeFileChipId !== undefined) {
      this.#chips.delete(this.#activeFileChipId);
      this.#services.agent.contextRegistry.revoke(this.#activeFileChipId);
      this.#activeFileChipId = undefined;
    }
    const selection = this.#vscode.activeSelection();
    if (selection === undefined || selection.provenance === undefined || this.#chips.size >= CONTEXT_LIMITS.itemCount) {
      return undefined;
    }
    const capturedDocument = Object.freeze({ ...selection.document });
    if (
      isSensitivePath(selection.path) ||
      capturedDocument.path !== selection.path ||
      !Number.isSafeInteger(capturedDocument.version) ||
      capturedDocument.version < 0
    ) {
      return undefined;
    }
    let canonical: string;
    try {
      canonical = await realpath(selection.path);
    } catch {
      return undefined;
    }
    if (canonical !== selection.path) return undefined;
    const relativePath = relative(root, canonical);
    if (
      relativePath.length === 0 ||
      relativePath === ".." ||
      relativePath.startsWith(`..${sep}`) ||
      isAbsolute(relativePath) ||
      isSensitivePath(relativePath) ||
      isSecretLikeContent(relativePath)
    ) {
      return undefined;
    }
    try {
      const policy = await this.#services.agent.ignorePolicy.evaluate([canonical], new AbortController().signal);
      if (
        policy.results.length !== 1 ||
        policy.results[0]?.path !== canonical ||
        policy.results[0].ignored ||
        !this.#services.agent.ignorePolicy.isCurrent(policy.attestation)
      ) {
        return undefined;
      }
    } catch {
      return undefined;
    }
    const capturedRange = Object.freeze({
      start: Object.freeze({ ...selection.range.start }),
      end: Object.freeze({ ...selection.range.end }),
    });
    const displayLabel = safeChipLabel(relativePath);
    const diagnostics = this.#vscode
      .diagnostics(selection.path)
      .slice(0, CONTEXT_LIMITS.diagnostics)
      .map((diagnostic) =>
        Object.freeze({
          severity: diagnostic.severity,
          message: safeContextText(diagnostic.message, 1_024),
          range: diagnostic.range,
        }),
      );
    const hash = createHash("sha256").update(capturedDocument.text).digest("hex");
    const content = [
      "RbxForge active file context (untrusted)",
      `path: ${relativePath}`,
      `version: ${capturedDocument.version}`,
      `sha256: ${hash}`,
      `dirty: ${capturedDocument.isDirty}`,
      `selection: ${capturedRange.start.line}:${capturedRange.start.character}-${capturedRange.end.line}:${capturedRange.end.character}`,
      `diagnostics: ${JSON.stringify(diagnostics)}`,
      "--- existing text ---",
      capturedDocument.text,
    ].join("\n");
    let id: string;
    try {
      id = await this.#services.agent.contextRegistry.registerFileSnapshot(
        {
          kind: "file",
          label: displayLabel,
          relativePath,
          workspaceRoot: root,
          sessionId: this.#sessionId,
          generation: this.#generation,
          expiresAt: this.#now() + 30 * 60_000,
          isCurrent: () => {
            const active = this.#vscode.activeSelection();
            return (
              active !== undefined &&
              active.path === selection.path &&
              active.document.path === capturedDocument.path &&
              active.document.uri === capturedDocument.uri &&
              active.document.version === capturedDocument.version &&
              createHash("sha256").update(active.document.text).digest("hex") === hash
            );
          },
        },
        Object.freeze({ content }),
        Object.freeze({
          attestation: selection.provenance,
          uri: capturedDocument.uri,
          version: capturedDocument.version,
          sha256: hash,
        }),
      );
    } catch {
      return undefined;
    }
    this.#activeFileChipId = id;
    this.#chips.set(id, Object.freeze({ id, label: displayLabel, kind: "file" }));
    return id;
  }

  #acceptContextChip(chip: Chip): boolean {
    if (this.#disposed) {
      this.#services.agent.contextRegistry.revoke(chip.id);
      return false;
    }
    if (this.#chips.size >= CONTEXT_LIMITS.itemCount) {
      this.#services.agent.contextRegistry.revoke(chip.id);
      return false;
    }
    this.#chips.set(chip.id, Object.freeze({ ...chip }));
    if (this.#last !== undefined && !this.#last.chipIds.includes(chip.id)) {
      this.#last = Object.freeze({
        ...this.#last,
        chipIds: Object.freeze([...this.#last.chipIds, chip.id]),
      });
    }
    void this.#publishSnapshot("context-added");
    return true;
  }

  #revokeTargetChips(path: string): void {
    for (const [id, chip] of this.#chips) {
      if (chip.label !== path) continue;
      this.#chips.delete(id);
      this.#services.agent.contextRegistry.revoke(id);
    }
  }

  async #workspaceRoot(): Promise<string | undefined> {
    const project = this.#services.project.currentPath();
    if (project !== undefined) {
      try {
        return await realpath(dirname(project));
      } catch {
        return undefined;
      }
    }
    const folders = this.#vscode.workspaceFolders();
    if (folders.length !== 1 || folders[0] === undefined) return undefined;
    try {
      return await realpath(folders[0]);
    } catch {
      return undefined;
    }
  }

  #snapshot(): AgentSnapshotMessage {
    return {
      simulation: this.#services.connection.snapshot().simulation,
      connected: this.#connected(),
      status: this.#status,
      mode: this.#mode,
      ...(this.#active?.runId === undefined && this.#last?.runId === undefined
        ? {}
        : { runId: this.#active?.runId ?? this.#last?.runId }),
      chips: [...this.#chips.values()].map((chip) => ({ ...chip })),
      canRetry: this.#active === undefined && this.#last !== undefined,
      ...(this.#detail === undefined ? {} : { detail: this.#detail }),
    };
  }

  #connected(): boolean {
    return (
      this.#services.connection.snapshot().simulation ||
      this.#services.project.currentPath() !== undefined ||
      this.#vscode.workspaceFolders().length === 1
    );
  }

  async #publishSnapshot(reason: string): Promise<void> {
    await this.#publish(
      this.#message(
        {
          type: "agentSnapshot",
          snapshot: this.#snapshot(),
        },
        reason,
      ),
    );
  }

  async #publish(message: HostMessage): Promise<void> {
    if (this.#disposed) return;
    await this.#host?.publish(message);
  }

  #message<T extends HostPayload>(value: T, reason: string = value.type): HostMessage {
    this.#hostSequence += 1;
    return {
      ...value,
      v: PROTOCOL_VERSION,
      sessionId: this.#sessionId,
      requestId: `agent:${reason}:${this.#hostSequence}`,
      generation: this.#generation,
    } as unknown as HostMessage;
  }

  #current(runId: string): boolean {
    return !this.#disposed && this.#active?.runId === runId;
  }

  #invalidateStudioContext(detail: string, reason: string): void {
    this.#status = "stale";
    this.#detail = detail;
    const active = this.#active;
    if (active !== undefined) {
      // Clear host currentness before abort dispatch can resume the AgentLoop,
      // so cancellation and any misbehaving late provider events stay private.
      this.#active = undefined;
      active.abort.abort(new Error("Selected Studio context became stale"));
      this.#services.agent.approvalBroker.cancelRun(active.runId);
      this.#services.agent.studioWrites?.revokeRun(active.runId);
    }
    void this.#publishSnapshot(reason);
  }

  #disposeView(): void {
    for (const disposable of this.#viewDisposables.splice(0)) disposable.dispose();
  }
}

class FixtureAgentModelProvider implements ModelProvider {
  readonly capabilities = Object.freeze({ vision: false });
  async open(_request: ProviderRequest, signal: AbortSignal): Promise<ModelSession> {
    if (signal.aborted) throw signal.reason ?? new Error("Fixture Agent aborted");
    return new FixtureSession();
  }
}

class FixtureSession implements ModelSession {
  #closed = false;
  async *respond(_input: ProviderTurnInput, signal: AbortSignal): AsyncIterable<ProviderEvent> {
    if (this.#closed || signal.aborted) return;
    yield {
      type: "text-delta",
      delta: "Fixture Agent completed a bounded simulation. No live API or Studio write ran.",
    };
    yield { type: "completed" };
  }
  async close(): Promise<void> {
    this.#closed = true;
  }
}

function studioBinding(services: ExtensionServices): Readonly<{
  instanceId?: string;
  graphRevision?: number;
}> {
  const instanceId = services.studio.snapshot().activeInstanceId;
  return {
    ...(instanceId === undefined ? {} : { instanceId }),
    graphRevision: services.graph.revision?.() ?? 0,
  };
}

function chunkUtf8(value: string, maxBytes: number): readonly string[] {
  const encoder = new TextEncoder();
  if (encoder.encode(value).byteLength <= maxBytes) return [value];
  const chunks: string[] = [];
  let current = "";
  let currentBytes = 0;
  for (const codePoint of value) {
    const codePointBytes = encoder.encode(codePoint).byteLength;
    if (currentBytes + codePointBytes > maxBytes && current.length > 0) {
      chunks.push(current);
      current = "";
      currentBytes = 0;
    }
    current += codePoint;
    currentBytes += codePointBytes;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function safeContextText(value: string, max: number): string {
  if (isSecretLikeContent(value)) return "[sensitive value omitted]";
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "").slice(0, max);
}

function safeChipLabel(value: string): string {
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return normalized.length === 0 ? "Current file" : normalized.slice(0, 256);
}
