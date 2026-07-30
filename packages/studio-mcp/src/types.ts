export interface McpClientPort {
  listTools(): Promise<{
    tools: readonly { name: string; inputSchema: unknown }[];
  }>;
  callTool(
    input: {
      name: string;
      arguments: Record<string, unknown>;
    },
    options?: McpCallOptions,
  ): Promise<unknown>;
  close(): Promise<void>;
}

export interface McpCallOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface StudioInstance {
  readonly instanceId: string;
  readonly role: string;
  readonly placeId: number;
  readonly placeName: string;
  readonly dataModelName: string;
  readonly isRunning: boolean;
  readonly pluginVersion: string;
  readonly pluginVariant: string;
  readonly serverVersion: string;
  readonly versionMismatch: boolean;
  readonly lastActivity: number;
  readonly connectedAt: number;
}

export interface StudioMcpServiceOptions {
  readonly timeoutMs?: number;
  readonly now?: () => number;
  readonly selectionMode?: "explicit" | "legacy-auto";
}

export interface StudioNode {
  readonly name: string;
  readonly className: string;
  readonly path: string;
  readonly hasChildren: boolean;
  readonly hasSource: boolean;
  readonly enabled?: boolean;
}

export interface StudioProperties {
  readonly instancePath: string;
  readonly className: string;
  readonly properties: Readonly<Record<string, unknown>>;
}

export interface StudioTreeNode {
  readonly name: string;
  readonly className: string;
  readonly children: readonly StudioTreeNode[];
  readonly path?: string;
  readonly hasSource?: boolean;
  readonly scriptType?: string;
  readonly enabled?: boolean;
}

export interface StudioTree {
  readonly tree: StudioTreeNode;
  readonly timestamp: number;
}

export interface StudioMutationGate {
  authorize(
    proposal: MutationProposal,
    decision: MutationDecision,
    request: StudioMutationRequest,
  ): Promise<StudioMutationAuthorization>;
  consume(authorizationId: string, proposal: MutationProposal, request: StudioMutationRequest): void;
  authorizeClaim?(
    claim: StudioAgentMutationClaim,
    proposal: MutationProposal,
    decision: MutationDecision,
    request: StudioMutationRequest,
  ): Promise<StudioMutationAuthorization>;
}

declare const studioAgentClaimBrand: unique symbol;
export interface StudioAgentMutationClaim {
  readonly id: string;
  readonly [studioAgentClaimBrand]: true;
}

export interface StudioAgentMutationClaimBinding {
  readonly sessionId: string;
  readonly generation: number;
  readonly runId: string;
  readonly expiresAt: number;
  readonly expectedClassName: string;
  readonly expectedPropertyValueHash: string;
  readonly proposal: MutationProposal;
  readonly request: StudioMutationRequest;
}

export interface StudioAgentClaimRedemptionHooks {
  /** Performs the bridge-owned final old-value read while authorization is still recoverable. */
  validatePrecondition(): Promise<boolean>;
  /** Synchronously consumes the exact broker authorization at the local write boundary. */
  consumeAuthorization(): boolean;
}

export type StudioMutationAuthorization =
  { readonly approved: true; readonly authorizationId: string } | { readonly approved: false; readonly reason: string };

export interface StudioMutationRequest {
  readonly tool: string;
  readonly input: Readonly<Record<string, unknown>>;
}

export interface StudioWriteOwnershipContext {
  readonly ownership: Ownership;
  readonly expectedInstanceId?: string;
  readonly expectedGraphRevision: number;
}

export interface StudioAuthorizationBinding {
  readonly instanceId: string;
  readonly placeName: string;
  readonly graphRevision: number;
}

export interface StudioAuthorizationState {
  assertCurrent(binding: StudioAuthorizationBinding): void;
}

export interface StudioPropertyReadOptions {
  readonly expectedInstanceId?: string;
}

export type StudioCapability =
  | "connectedInstances"
  | "tree"
  | "children"
  | "properties"
  | "selection"
  | "setProperty"
  | "setProperties"
  | "createObject"
  | "deleteObject"
  | "soloPlaytest"
  | "runtimeLogs"
  | "screenshot";

export interface StudioPlaytestReadOptions {
  readonly expectedInstanceId: string;
  readonly signal: AbortSignal;
  readonly timeoutMs?: number;
}

export interface StudioPlaytestCommandOptions {
  readonly signal: AbortSignal;
  readonly timeoutSeconds?: number;
  /**
   * Trusted lifecycle boundary invoked synchronously immediately before the
   * authorized MCP command is handed to the client transport.
   */
  readonly onIssued?: () => void;
}

export interface StudioRuntimeLogOptions extends StudioPlaytestReadOptions {
  readonly tail?: number;
  readonly filter?: string;
}

export interface StudioScreenshotOptions extends StudioPlaytestReadOptions {
  readonly format?: "jpeg" | "png";
  readonly quality?: number;
}

export interface StudioMcpSnapshot {
  readonly activeInstanceId: string | undefined;
  readonly stale: boolean;
  readonly capabilities: Readonly<Record<StudioCapability, string | undefined>>;
}
import type { MutationDecision, MutationProposal, Ownership } from "@rbxforge/core";
