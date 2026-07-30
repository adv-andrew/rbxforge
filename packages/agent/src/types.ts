export interface ProviderCapabilities {
  readonly vision: boolean;
}

export interface ContextSelection {
  readonly chipIds: readonly string[];
  readonly workspaceRoot: string;
  readonly sessionId: string;
  readonly generation: number;
  readonly instanceId?: string;
  readonly graphRevision?: number;
}

export type ContextSourceKind =
  "file" | "selection" | "studio-children" | "studio-properties" | "rojo-mapping" | "diagnostic" | "log" | "screenshot";

export interface ContextRecord {
  readonly content: string;
  readonly mimeType?: string;
}

export interface AgentContextRecord extends ContextRecord {
  readonly chipId: string;
  readonly kind: ContextSourceKind;
  readonly label: string;
  readonly truncated: boolean;
}

export interface ContextReceipt {
  readonly chipId: string;
  readonly outcome: "included" | "truncated" | "omitted";
  readonly bytes: number;
  readonly reason?: string;
}

export interface AgentContext {
  readonly records: readonly AgentContextRecord[];
  readonly receipts: readonly ContextReceipt[];
  readonly instructions: string;
  readonly totalBytes: number;
}

export interface AgentContextAssembler {
  build(selection: ContextSelection, capabilities: ProviderCapabilities, signal: AbortSignal): Promise<AgentContext>;
}

export type JsonSchema = Readonly<Record<string, unknown>>;
export type StrictToolSchema = JsonSchema & {
  readonly type: "object";
  readonly additionalProperties: false;
  readonly required: readonly string[];
};

export interface ToolContext {
  readonly sessionId: string;
  readonly generation: number;
  readonly runId: string;
  readonly signal: AbortSignal;
  readonly context: AgentContext;
  readonly selection: ContextSelection;
  readonly simulation: boolean;
}

export type Verification = "verified" | "fixture-verified" | "unverified";

export interface ToolReceipt {
  readonly ok: boolean;
  readonly code: string;
  readonly summary: string;
  readonly output?: Readonly<Record<string, unknown>>;
  readonly verification: Verification;
}

declare const authorizationBrand: unique symbol;
export interface OpaqueWriteAuthorization {
  readonly id: string;
  readonly [authorizationBrand]: true;
}

export interface ImmutableApprovalProposal {
  readonly approvalId: string;
  readonly preparedId: string;
  readonly sessionId: string;
  readonly generation: number;
  readonly runId: string;
  readonly kind: "filesystem" | "studio";
  readonly summary: string;
  /** Host-only digest binding a Studio approval to its exact mutation and precondition. */
  readonly bindingHash?: string;
  readonly change?: Readonly<{
    readonly before: string;
    readonly after: string;
  }>;
  readonly expiresAt: number;
}

export interface PreparedWrite {
  readonly id: string;
  readonly proposal: ImmutableApprovalProposal;
}

export type ApprovalDecision =
  | { readonly approved: true; readonly authorization: OpaqueWriteAuthorization }
  | { readonly approved: false; readonly reason: "rejected" | "cancelled" | "expired" };

export interface ApprovalBroker {
  request(proposal: ImmutableApprovalProposal, signal: AbortSignal): Promise<ApprovalDecision>;
  resolve(
    resolution: Readonly<{
      sessionId: string;
      generation: number;
      runId: string;
      approvalId: string;
      decision: "approve" | "reject";
    }>,
  ): boolean;
  cancelRun(runId: string): void;
}

interface RegisteredToolBase {
  readonly name: string;
  readonly parameters: StrictToolSchema;
  validate(value: unknown): Readonly<Record<string, unknown>>;
}

export interface RegisteredReadTool extends RegisteredToolBase {
  readonly access: "read";
  invoke(args: Readonly<Record<string, unknown>>, context: ToolContext): Promise<ToolReceipt>;
}

export interface RegisteredWriteTool extends RegisteredToolBase {
  readonly access: "write";
  prepare(args: Readonly<Record<string, unknown>>, context: ToolContext): Promise<PreparedWrite>;
  execute(preparedId: string, authorization: OpaqueWriteAuthorization, context: ToolContext): Promise<ToolReceipt>;
}

export type RegisteredAgentTool = RegisteredReadTool | RegisteredWriteTool;

export interface ProviderTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: StrictToolSchema;
}

export interface ProviderRequest {
  readonly model: string;
  readonly instructions: string;
  readonly input: string;
  readonly context: AgentContext;
  readonly tools: readonly ProviderTool[];
}

export interface ProviderToolOutput {
  readonly callId: string;
  readonly output: string;
}

export interface ProviderTurnInput {
  readonly request?: ProviderRequest;
  readonly toolOutputs?: readonly ProviderToolOutput[];
}

export type ProviderEvent =
  | { readonly type: "text-delta"; readonly delta: string }
  | {
      readonly type: "tool-call";
      readonly callId: string;
      readonly name: string;
      readonly arguments:
        | { readonly ok: true; readonly value: unknown; readonly bytes: number }
        | {
            readonly ok: false;
            readonly code: "malformed" | "oversized";
            readonly bytes: number;
          };
    }
  | { readonly type: "completed" }
  | { readonly type: "error"; readonly code: string; readonly message: string };

export interface ModelSession {
  respond(input: ProviderTurnInput, signal: AbortSignal): AsyncIterable<ProviderEvent>;
  close(): Promise<void>;
}

export interface ModelProvider {
  readonly capabilities: ProviderCapabilities;
  open(request: ProviderRequest, signal: AbortSignal): Promise<ModelSession>;
}

export type AgentMode = "ask" | "build" | "debug";

export interface AgentRequest {
  readonly sessionId: string;
  readonly generation: number;
  readonly runId: string;
  readonly mode: AgentMode;
  readonly prompt: string;
  readonly model: string;
  readonly context: ContextSelection;
  readonly simulation: boolean;
}

export type AgentEvent =
  | { readonly type: "started"; readonly runId: string; readonly simulation: boolean }
  | { readonly type: "context"; readonly receipts: readonly ContextReceipt[] }
  | { readonly type: "text-delta"; readonly delta: string }
  | {
      readonly type: "tool-call";
      readonly callId: string;
      readonly name: string;
      readonly access: "read" | "write" | "blocked";
      readonly state: "running" | "blocked" | "complete";
      readonly code?: string;
    }
  | {
      readonly type: "approval-required";
      readonly approvalId: string;
      readonly kind: "filesystem" | "studio";
      readonly summary: string;
      readonly change?: Readonly<{
        readonly before: string;
        readonly after: string;
      }>;
      readonly expiresAt: number;
    }
  | { readonly type: "completed"; readonly verification: Verification }
  | { readonly type: "error"; readonly code: string; readonly message: string };
