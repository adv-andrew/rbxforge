import { createHash } from "node:crypto";

import { normalizeEndpoint, type ProviderCredential } from "@rbxforge/agent";

import type { VsCodeFacade } from "./vscode-facade.js";

export const DEFAULT_OPENAI_ENDPOINT = "https://api.openai.com/v1";
export const DEFAULT_OPENAI_MODEL = "gpt-5.6";

export interface AiProviderSettings {
  readonly endpoint: string;
  readonly model: string;
}

export class AiCredentialStore {
  readonly #vscode: Pick<VsCodeFacade, "inspectConfiguration" | "secretGet" | "secretStore" | "showInputBox">;

  constructor(vscode: Pick<VsCodeFacade, "inspectConfiguration" | "secretGet" | "secretStore" | "showInputBox">) {
    this.#vscode = vscode;
  }

  settings(): AiProviderSettings {
    const endpointInspect = this.#vscode.inspectConfiguration<string>("rbxforge.ai.endpoint");
    if (endpointInspect?.workspaceValue !== undefined || endpointInspect?.workspaceFolderValue !== undefined) {
      throw new Error("Workspace-scoped AI endpoint overrides are disabled");
    }
    const endpoint = normalizeEndpoint(
      endpointInspect?.globalValue ?? endpointInspect?.defaultValue ?? DEFAULT_OPENAI_ENDPOINT,
    );
    const modelInspect = this.#vscode.inspectConfiguration<string>("rbxforge.ai.model");
    const model = boundedModel(
      modelInspect?.workspaceFolderValue ??
        modelInspect?.workspaceValue ??
        modelInspect?.globalValue ??
        modelInspect?.defaultValue ??
        DEFAULT_OPENAI_MODEL,
    );
    return Object.freeze({ endpoint, model });
  }

  async configure(): Promise<boolean> {
    const { endpoint } = this.settings();
    const key = await this.#vscode.showInputBox({
      prompt: `API key for ${new URL(endpoint).origin}`,
      password: true,
      ignoreFocusOut: true,
    });
    if (key === undefined) return false;
    const normalized = key.trim();
    if (normalized.length < 8 || normalized.length > 8_192) {
      throw new Error("AI credential length is invalid");
    }
    await this.#vscode.secretStore(secretKey(endpoint), normalized);
    return true;
  }

  async credential(signal: AbortSignal): Promise<ProviderCredential> {
    if (signal.aborted) throw signal.reason ?? new Error("Credential request aborted");
    const { endpoint } = this.settings();
    const apiKey = await this.#vscode.secretGet(secretKey(endpoint));
    if (signal.aborted) throw signal.reason ?? new Error("Credential request aborted");
    if (apiKey === undefined || apiKey.length === 0) {
      throw new Error("No credential is configured for this endpoint origin");
    }
    return Object.freeze({ apiKey, endpoint });
  }
}

export function secretKey(endpoint: string): string {
  const origin = new URL(normalizeEndpoint(endpoint)).origin;
  return `rbxforge.ai.credential.${createHash("sha256").update(origin).digest("hex")}`;
}

function boundedModel(value: string): string {
  const model = value.trim();
  if (model.length === 0 || model.length > 256 || /[\u0000-\u001f\u007f]/u.test(model)) {
    throw new Error("AI model setting is invalid");
  }
  return model;
}
