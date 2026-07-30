import { randomUUID } from "node:crypto";

import { isSecretLikeContent, isSensitiveKey } from "@rbxforge/agent";
import {
  assertSafeStudioPropertyMutation,
  MutationJournal,
  studioPropertyMetadata,
  verifyMutation,
  type Ownership,
} from "@rbxforge/core";
import type { StudioProperties } from "@rbxforge/studio-mcp";
import {
  PROTOCOL_VERSION,
  type HostMessage,
  type PropertiesSnapshot,
  type PropertyProposal,
  type PropertyRow,
  type TypedPropertyValue,
  parseWebviewMessage,
} from "@rbxforge/webview-ui/protocol";
import { createPropertyCodec, type PropertyKind } from "@rbxforge/webview-ui/property-codecs";
import type { PropertiesCommandTarget } from "../commands.js";
import type { ExtensionServices } from "../service-container.js";
import type { DisposablePort, VsCodeFacade, WebviewViewPort, WebviewViewProviderPort } from "../vscode-facade.js";
import { createWebviewHtml, createWebviewNonce, SecureWebviewHost } from "./webview-host.js";

export interface PropertiesSelection {
  readonly instanceId: string;
  readonly instancePath: string;
  readonly name: string;
  readonly placeName: string;
  readonly ownership: Ownership;
  readonly freshness: "fresh" | "stale" | "unknown";
  readonly generation: number;
  readonly graphRevision: number;
  readonly simulation: boolean;
}

export interface StudioPropertiesPort {
  snapshot(): { readonly activeInstanceId: string | undefined; readonly stale: boolean };
  properties(path: string, options: { readonly expectedInstanceId: string }): Promise<StudioProperties>;
  callWrite(
    tool: string,
    input: Readonly<Record<string, unknown>>,
    context: {
      readonly ownership: Ownership;
      readonly expectedInstanceId?: string;
      readonly expectedGraphRevision: number;
    },
  ): Promise<unknown>;
}

export interface PropertiesProviderOptions {
  readonly studio: StudioPropertiesPort;
  readonly journal: MutationJournal;
  readonly sessionId: string;
  readonly resolveSelection: () => Promise<PropertiesSelection>;
  readonly publish: (message: HostMessage) => Promise<void>;
  readonly now?: () => number;
  readonly createId?: () => string;
}

export interface PropertyMutationOutcome {
  readonly verification: "verified" | "mismatch" | "unverifiable";
}

export class PropertiesProvider {
  readonly #studio: StudioPropertiesPort;
  readonly #journal: MutationJournal;
  readonly #sessionId: string;
  readonly #resolveSelection: () => Promise<PropertiesSelection>;
  readonly #publish: (message: HostMessage) => Promise<void>;
  readonly #now: () => number;
  readonly #createId: () => string;
  #snapshot: PropertiesSnapshot | undefined;
  #snapshotGraphRevision: number | undefined;

  constructor(options: PropertiesProviderOptions) {
    this.#studio = options.studio;
    this.#journal = options.journal;
    this.#sessionId = options.sessionId;
    this.#resolveSelection = options.resolveSelection;
    this.#publish = options.publish;
    this.#now = options.now ?? Date.now;
    this.#createId = options.createId ?? (() => crypto.randomUUID());
  }

  async refresh(selection: PropertiesSelection, retain = true): Promise<PropertiesSnapshot> {
    this.#assertStudioInstance(selection.instanceId);
    const observed = await this.#studio.properties(selection.instancePath, {
      expectedInstanceId: selection.instanceId,
    });
    if (observed.instancePath !== selection.instancePath) {
      throw new Error("Studio properties path changed during refresh");
    }
    const observedAt = this.#now();
    const snapshot: PropertiesSnapshot = {
      snapshotId: `${selection.instanceId}:${selection.generation}:${observedAt}`,
      instanceId: selection.instanceId,
      instancePath: selection.instancePath,
      name: selection.name,
      className: observed.className,
      placeName: selection.placeName,
      ownership: selection.ownership,
      freshness: selection.freshness,
      simulation: selection.simulation,
      connected: true,
      observedAt,
      properties: Object.entries(observed.properties).flatMap(([name, value]) => {
        if (isSensitiveKey(name) || (typeof value === "string" && isSecretLikeContent(value))) return [];
        return [makePropertyRow(observed.className, name, value)];
      }),
    };
    if (retain) {
      this.#snapshot = snapshot;
      this.#snapshotGraphRevision = selection.graphRevision;
    }
    return snapshot;
  }

  acceptSnapshot(snapshot: PropertiesSnapshot, graphRevision: number): void {
    this.#snapshot = snapshot;
    this.#snapshotGraphRevision = graphRevision;
  }

  async propose(proposal: PropertyProposal, operationId: string): Promise<PropertyMutationOutcome> {
    const displayed = this.#snapshot;
    if (displayed === undefined) throw new Error("No current Properties snapshot");
    validateProposalIdentity(displayed, proposal);
    const row = displayed.properties.find((property) => property.name === proposal.propertyName);
    if (row === undefined || !row.editable) throw new Error("Property is not editable");
    if (
      displayed.freshness !== "fresh" ||
      displayed.ownership === "unknown" ||
      displayed.ownership === "drift" ||
      displayed.ownership === "shared" ||
      !displayed.connected
    ) {
      throw new Error("Property mutation is blocked by ownership or freshness");
    }
    const requested = validateRequestedValue(row, proposal.value);
    assertSafeStudioPropertyMutation(displayed.className, proposal.propertyName, requested);
    const current = await this.#resolveSelection();
    if (current.graphRevision !== this.#snapshotGraphRevision) {
      throw new Error("Unified graph changed after the Properties snapshot was displayed");
    }
    if (!sameSelection(current, displayed, proposal.displayGeneration)) {
      throw new Error("Active Properties selection changed before mutation");
    }
    this.#assertStudioInstance(proposal.instanceId);
    const beforeProperties = await this.#studio.properties(proposal.instancePath, {
      expectedInstanceId: proposal.instanceId,
    });
    if (beforeProperties.instancePath !== proposal.instancePath) {
      throw new Error("Property path changed before mutation");
    }
    const beforeRaw = beforeProperties.properties[proposal.propertyName];
    const before = parseObservedValue(row, beforeRaw);
    if (before === undefined) throw new Error("Live property type is unsupported or ambiguous");
    await this.#status(proposal, operationId, 1, "approval-pending");
    await this.#studio.callWrite(
      "set_property",
      {
        instancePath: proposal.instancePath,
        propertyName: proposal.propertyName,
        propertyValue: requested,
      },
      {
        ownership: current.ownership,
        expectedInstanceId: proposal.instanceId,
        expectedGraphRevision: current.graphRevision,
      },
    );
    await this.#status(proposal, operationId, 2, "applying");

    let verification: PropertyMutationOutcome["verification"] = "unverifiable";
    try {
      this.#assertStudioInstance(proposal.instanceId);
      const afterProperties = await this.#studio.properties(proposal.instancePath, {
        expectedInstanceId: proposal.instanceId,
      });
      if (afterProperties.instancePath === proposal.instancePath) {
        const actual = parseObservedValue(row, afterProperties.properties[proposal.propertyName]);
        verification = verifyMutation(requested, actual);
      }
    } catch {
      verification = "unverifiable";
    }
    this.#journal.append({
      id: this.#createId(),
      timestamp: new Date(this.#now()).toISOString(),
      instanceId: proposal.instanceId,
      kind: "studio",
      operation: "property-write",
      target: `${proposal.instancePath}.${proposal.propertyName}`,
      before,
      requested,
      result: "applied",
      verification,
    });
    await this.#status(proposal, operationId, 3, "complete", verification);
    return { verification };
  }

  #assertStudioInstance(expectedInstanceId: string): void {
    const studio = this.#studio.snapshot();
    if (studio.stale || studio.activeInstanceId !== expectedInstanceId) {
      throw new Error("Active Studio instance changed");
    }
  }

  async #status(
    proposal: PropertyProposal,
    operationId: string,
    sequence: number,
    state: "approval-pending" | "applying" | "complete",
    verification?: PropertyMutationOutcome["verification"],
  ): Promise<void> {
    await this.#publish({
      v: PROTOCOL_VERSION,
      type: "mutationStatus",
      sessionId: this.#sessionId,
      requestId: `mutation:${operationId}:${sequence}`,
      generation: proposal.displayGeneration,
      instanceId: proposal.instanceId,
      instancePath: proposal.instancePath,
      propertyName: proposal.propertyName,
      state,
      ...(verification === undefined ? {} : { verification }),
    });
  }
}

function makePropertyRow(className: string, name: string, value: unknown): PropertyRow {
  const metadata = metadataFor(className, name);
  if (metadata === undefined) {
    return {
      name,
      category: "Other",
      kind: "unknown",
      editable: false,
      rawValue: safeDisplay(value),
      comparable: false,
      blockedReason: "Unsupported property type",
    };
  }
  const codec = createPropertyCodec(metadata.kind, metadata.enumOptions);
  const input = typeof value === "string" ? value : JSON.stringify(value);
  const parsed = codec.parse(input);
  if (!parsed.ok) {
    return {
      name,
      category: metadata.category,
      kind: metadata.kind,
      editable: false,
      rawValue: safeDisplay(value),
      comparable: false,
      blockedReason: "Unsupported or ambiguous live value",
      ...(metadata.enumOptions === undefined ? {} : { enumOptions: [...metadata.enumOptions] }),
    };
  }
  return {
    name,
    category: metadata.category,
    kind: metadata.kind,
    editable: metadata.editable && codec.editable,
    liveValue: parsed.value,
    comparable: true,
    ...(metadata.enumOptions === undefined ? {} : { enumOptions: [...metadata.enumOptions] }),
    ...(!metadata.editable || !codec.editable ? { blockedReason: "Display-only" } : {}),
  };
}

interface PropertyMetadata {
  readonly kind: PropertyKind;
  readonly category: string;
  readonly editable: boolean;
  readonly enumOptions?: readonly string[];
}

function metadataFor(className: string, name: string): PropertyMetadata | undefined {
  return studioPropertyMetadata(className, name);
}

function validateProposalIdentity(snapshot: PropertiesSnapshot, proposal: PropertyProposal): void {
  if (proposal.snapshotId !== snapshot.snapshotId) throw new Error("Property snapshot is stale");
  if (proposal.instanceId !== snapshot.instanceId) throw new Error("Property instance changed");
  if (proposal.instancePath !== snapshot.instancePath) throw new Error("Property path changed");
  if (proposal.displayGeneration < 0 || !Number.isSafeInteger(proposal.displayGeneration)) {
    throw new Error("Property display generation is invalid");
  }
}

function validateRequestedValue(row: PropertyRow, value: TypedPropertyValue): TypedPropertyValue {
  const codec = createPropertyCodec(row.kind, row.enumOptions);
  const result = codec.parse(codec.format(value));
  if (!codec.editable || !result.ok || !sameValue(result.value, value)) {
    throw new Error("Requested property value does not match verified metadata");
  }
  return result.value;
}

function parseObservedValue(row: PropertyRow, value: unknown): TypedPropertyValue | undefined {
  if (value === undefined) return undefined;
  const codec = createPropertyCodec(row.kind, row.enumOptions);
  const result = codec.parse(typeof value === "string" ? value : JSON.stringify(value));
  return result.ok ? result.value : undefined;
}

function sameSelection(selection: PropertiesSelection, snapshot: PropertiesSnapshot, generation: number): boolean {
  return (
    selection.instanceId === snapshot.instanceId &&
    selection.instancePath === snapshot.instancePath &&
    selection.ownership === snapshot.ownership &&
    selection.freshness === snapshot.freshness &&
    selection.generation === generation
  );
}

function sameValue(left: TypedPropertyValue, right: TypedPropertyValue): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function safeDisplay(value: unknown): string {
  const sanitized = sanitizeDisplayValue(value);
  if (typeof sanitized === "string") return sanitized;
  if (sanitized === null || typeof sanitized === "number" || typeof sanitized === "boolean") return String(sanitized);
  try {
    const serialized = JSON.stringify(sanitized);
    if (typeof serialized !== "string") return "[unsupported value]";
    if (serialized.length <= DISPLAY_VALUE_LIMITS.outputCharacters) return serialized;
    const suffix = "…[truncated]";
    return `${serialized.slice(0, DISPLAY_VALUE_LIMITS.outputCharacters - suffix.length)}${suffix}`;
  } catch {
    return "[unsupported value]";
  }
}

const DISPLAY_VALUE_LIMITS = Object.freeze({
  depth: 4,
  nodes: 128,
  arrayItems: 20,
  objectEntries: 50,
  stringCharacters: 1_024,
  outputCharacters: 8_192,
});

interface DisplaySanitizerState {
  remainingNodes: number;
  readonly ancestors: WeakSet<object>;
}

function sanitizeDisplayValue(
  value: unknown,
  depth = 0,
  state: DisplaySanitizerState = {
    remainingNodes: DISPLAY_VALUE_LIMITS.nodes,
    ancestors: new WeakSet<object>(),
  },
): unknown {
  if (state.remainingNodes <= 0) return "[value budget omitted]";
  state.remainingNodes -= 1;
  if (typeof value === "string") {
    return isSecretLikeContent(value)
      ? "[sensitive value omitted]"
      : value.slice(0, DISPLAY_VALUE_LIMITS.stringCharacters);
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (depth >= DISPLAY_VALUE_LIMITS.depth) return "[nested value omitted]";
  if (Array.isArray(value)) {
    if (state.ancestors.has(value)) return "[cyclic value omitted]";
    state.ancestors.add(value);
    try {
      return value
        .slice(0, DISPLAY_VALUE_LIMITS.arrayItems)
        .map((entry) => sanitizeDisplayValue(entry, depth + 1, state));
    } finally {
      state.ancestors.delete(value);
    }
  }
  if (plainRecord(value)) {
    if (state.ancestors.has(value)) return "[cyclic value omitted]";
    state.ancestors.add(value);
    try {
      return Object.fromEntries(
        Object.entries(value)
          .filter(([key]) => !isSensitiveKey(key))
          .slice(0, DISPLAY_VALUE_LIMITS.objectEntries)
          .map(([key, entry]) => [key, sanitizeDisplayValue(entry, depth + 1, state)]),
      );
    } finally {
      state.ancestors.delete(value);
    }
  }
  return undefined;
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export class PropertiesWebviewProvider implements WebviewViewProviderPort, DisposablePort {
  readonly #services: ExtensionServices;
  readonly #vscode: VsCodeFacade;
  readonly #viewDisposables: DisposablePort[] = [];
  readonly #lifetimeDisposables: DisposablePort[] = [];
  #target: PropertiesCommandTarget | undefined;
  #targetInstanceId: string | undefined;
  #webview: WebviewViewPort["webview"] | undefined;
  #host: SecureWebviewHost | undefined;
  #engine: PropertiesProvider | undefined;
  #sessionId = "";
  #generation = 1;
  #ready = false;

  constructor(options: { readonly services: ExtensionServices; readonly vscode: VsCodeFacade }) {
    this.#services = options.services;
    this.#vscode = options.vscode;
    this.#lifetimeDisposables.push(
      this.#services.graph.onGraphInvalidated(({ path }) => {
        this.#invalidateTarget(path);
      }),
    );
  }

  async resolveWebviewView(view: WebviewViewPort): Promise<void> {
    this.#disposeView();
    this.#webview = view.webview;
    this.#sessionId = randomUUID();
    this.#generation = 1;
    this.#ready = false;
    const webview = view.webview;
    webview.options = { enableScripts: true, localResourceRoots: ["media/webview"] };
    const nonce = createWebviewNonce();
    webview.html = createWebviewHtml({
      cspSource: webview.cspSource,
      nonce,
      scriptUri: webview.asWebviewUri("media/webview/webview.js"),
      styleUri: webview.asWebviewUri("media/webview/webview.css"),
      title: "RbxForge Properties",
    });
    this.#host = new SecureWebviewHost({
      sessionId: this.#sessionId,
      initialGeneration: this.#generation,
      postMessage: (message) => webview.postMessage(message),
    });
    this.#engine = this.#createEngine();
    this.#viewDisposables.push(
      webview.onDidReceiveMessage((raw) => {
        void this.#receive(raw);
      }),
    );
    await this.#sendInit();
  }

  selectTarget(target: PropertiesCommandTarget): void {
    this.#target = target;
    this.#targetInstanceId = this.#services.studio.snapshot().activeInstanceId;
    if (this.#host !== undefined && this.#webview !== undefined) {
      this.#generation += 1;
      this.#host.advanceGeneration(this.#generation);
      this.#ready = false;
      this.#engine = this.#createEngine();
      void this.#sendInit();
    }
  }

  dispose(): void {
    this.#disposeView();
    for (const disposable of this.#lifetimeDisposables.splice(0)) disposable.dispose();
    this.#webview = undefined;
    this.#host = undefined;
    this.#engine = undefined;
  }

  #disposeView(): void {
    for (const disposable of this.#viewDisposables.splice(0)) disposable.dispose();
  }

  #invalidateTarget(path: string): void {
    const target = this.#target;
    if (
      target === undefined ||
      this.#host === undefined ||
      this.#webview === undefined ||
      !this.#ready ||
      !(target.path === path || target.path.startsWith(`${path}.`) || path.startsWith(`${target.path}.`))
    ) {
      return;
    }
    this.#generation += 1;
    this.#host.advanceGeneration(this.#generation);
    this.#ready = false;
    this.#engine = this.#createEngine();
    void this.#sendInit();
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
    if (message.type === "ready") {
      this.#ready = true;
      await this.#refresh(`ready:${message.requestId}`);
    } else if (message.type === "refreshProperties") {
      await this.#refresh(`refresh:${message.requestId}`);
    } else if (message.type === "proposePropertyMutation") {
      try {
        await this.#engine?.propose(message.proposal, message.requestId);
      } catch (error: unknown) {
        await host.publish({
          v: PROTOCOL_VERSION,
          type: "mutationStatus",
          sessionId: this.#sessionId,
          requestId: `mutation:${message.requestId}:blocked`,
          generation: this.#generation,
          instanceId: message.proposal.instanceId,
          instancePath: message.proposal.instancePath,
          propertyName: message.proposal.propertyName,
          state: "blocked",
          detail: error instanceof Error ? error.message : "Mutation blocked",
        });
      }
    } else if (message.type === "openDefiningFile") {
      await this.#vscode.executeCommand("rbxforge.revealSource", message.instancePath);
    }
  }

  #createEngine(): PropertiesProvider {
    return new PropertiesProvider({
      studio: {
        snapshot: () => this.#services.studio.snapshot(),
        properties: (path, options) => this.#services.studio.guardedProperties(path, options),
        callWrite: (tool, input, context) => {
          this.#services.graph.assertRevision(context.expectedGraphRevision);
          return this.#services.studio.callWrite(tool, input, context);
        },
      },
      journal: this.#services.journal,
      sessionId: this.#sessionId,
      resolveSelection: () => this.#selection(),
      publish: async (message) => {
        await this.#host?.publish(message);
      },
    });
  }

  async #selection(): Promise<PropertiesSelection> {
    const target = this.#target;
    const active = this.#services.studio.snapshot();
    if (
      target === undefined ||
      active.activeInstanceId === undefined ||
      active.activeInstanceId !== this.#targetInstanceId
    ) {
      throw new Error("Select a Studio instance and Properties target");
    }
    const resolved = await this.#services.graph.resolve(target.path, new AbortController().signal);
    if (resolved.node.name !== target.name || resolved.node.className !== target.className) {
      throw new Error("Properties target identity changed in the unified graph");
    }
    const instance = (await this.#services.studio.instances()).find(
      (candidate) => candidate.instanceId === active.activeInstanceId,
    );
    if (instance === undefined) throw new Error("Active Studio instance is disconnected");
    const connection = this.#services.connection.snapshot();
    const fresh =
      !active.stale &&
      connection.checks.activeStudioInstance.health === "healthy" &&
      connection.checks.studioPlace.health === "healthy";
    return {
      instanceId: active.activeInstanceId,
      instancePath: target.path,
      name: target.name,
      placeName: instance.placeName,
      ownership: resolved.node.ownership,
      freshness: fresh ? "fresh" : "stale",
      generation: this.#generation,
      graphRevision: resolved.revision,
      simulation: connection.simulation,
    };
  }

  async #refresh(requestId: string): Promise<void> {
    if (!this.#ready || this.#target === undefined || this.#host === undefined) return;
    try {
      const engine = this.#engine;
      const host = this.#host;
      const generation = this.#generation;
      if (engine === undefined) return;
      await host.runLatest(
        generation,
        requestId,
        async () => {
          const selection = await this.#selection();
          return {
            snapshot: await engine.refresh(selection, false),
            graphRevision: selection.graphRevision,
          };
        },
        ({ snapshot, graphRevision }) => {
          engine.acceptSnapshot(snapshot, graphRevision);
          return {
            v: PROTOCOL_VERSION,
            type: "propertiesSnapshot",
            sessionId: this.#sessionId,
            requestId,
            generation,
            snapshot,
          };
        },
      );
    } catch {
      // Keep the last view read-only; connection state exposes recovery actions.
    }
  }

  async #sendInit(): Promise<void> {
    await this.#webview?.postMessage({
      v: PROTOCOL_VERSION,
      type: "init",
      sessionId: this.#sessionId,
      requestId: `init:${this.#generation}`,
      generation: this.#generation,
      view: "properties",
    });
  }
}
