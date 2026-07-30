import { randomBytes } from "node:crypto";

import {
  parseHostMessage,
  parseWebviewMessage,
  sanitizeForWebview,
  type HostMessage,
  type WebviewMessage,
} from "@rbxforge/webview-ui/protocol";

export interface WebviewHtmlOptions {
  readonly cspSource: string;
  readonly nonce: string;
  readonly scriptUri: string;
  readonly styleUri: string;
  readonly title: string;
  readonly allowBlobImages?: boolean;
}

export function createWebviewNonce(): string {
  return randomBytes(32).toString("base64url");
}

export function createWebviewHtml(options: WebviewHtmlOptions): string {
  const csp = [
    "default-src 'none'",
    `img-src ${options.cspSource} data:${options.allowBlobImages === true ? " blob:" : ""}`,
    `style-src ${options.cspSource}`,
    `script-src 'nonce-${options.nonce}'`,
    `font-src ${options.cspSource}`,
    "connect-src 'none'",
  ].join("; ");
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="UTF-8">',
    `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(csp)}">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
    `<link rel="stylesheet" href="${escapeAttribute(options.styleUri)}">`,
    `<title>${escapeText(options.title)}</title>`,
    "</head>",
    "<body>",
    '<main id="root"></main>',
    `<script type="module" nonce="${escapeAttribute(options.nonce)}" src="${escapeAttribute(options.scriptUri)}"></script>`,
    "</body>",
    "</html>",
  ].join("");
}

export interface SecureWebviewHostOptions {
  readonly sessionId: string;
  readonly postMessage: (message: HostMessage) => Promise<boolean>;
  readonly initialGeneration?: number;
}

export class SecureWebviewHost {
  readonly #sessionId: string;
  readonly #postMessage: (message: HostMessage) => Promise<boolean>;
  readonly #queued: HostMessage[] = [];
  readonly #seenRequestIds = new Set<string>();
  #ready = false;
  #generation: number;
  #latestRequestSequence = 0;

  constructor(options: SecureWebviewHostOptions) {
    this.#sessionId = options.sessionId;
    this.#postMessage = options.postMessage;
    this.#generation = options.initialGeneration ?? 1;
  }

  async accept(value: unknown): Promise<boolean> {
    let message: WebviewMessage;
    try {
      message = parseWebviewMessage(value);
    } catch {
      return false;
    }
    if (
      message.sessionId !== this.#sessionId ||
      message.generation !== this.#generation ||
      this.#seenRequestIds.has(message.requestId)
    ) {
      return false;
    }
    this.#seenRequestIds.add(message.requestId);
    if (message.type !== "ready") return true;
    if (this.#ready) return false;
    this.#ready = true;
    while (this.#queued.length > 0) {
      const queued = this.#queued.shift();
      if (queued !== undefined) await this.#postMessage(queued);
    }
    return true;
  }

  async publish(value: HostMessage): Promise<boolean> {
    const parsed = parseHostMessage(sanitizeForWebview(value));
    if (parsed.sessionId !== this.#sessionId || parsed.generation !== this.#generation) {
      return false;
    }
    if (!this.#ready) {
      this.#queued.push(parsed);
      return true;
    }
    return this.#postMessage(parsed);
  }

  async runLatest<T>(
    generation: number,
    requestId: string,
    operation: () => Promise<T>,
    message: (value: T) => HostMessage,
  ): Promise<boolean> {
    if (!Number.isSafeInteger(generation) || generation !== this.#generation || requestId.length === 0) {
      return false;
    }
    const sequence = this.#latestRequestSequence + 1;
    this.#latestRequestSequence = sequence;
    const value = await operation();
    if (sequence !== this.#latestRequestSequence || generation !== this.#generation) return false;
    return this.publish(message(value));
  }

  advanceGeneration(nextGeneration: number): void {
    if (!Number.isSafeInteger(nextGeneration) || nextGeneration !== this.#generation + 1) {
      throw new Error("Webview generation must advance exactly once");
    }
    this.#generation = nextGeneration;
    this.#ready = false;
    this.#seenRequestIds.clear();
    this.#queued.splice(0);
    this.#latestRequestSequence += 1;
  }
}

export function safeLogValue(logger: (value: string) => void, value: unknown): void {
  logger(JSON.stringify(sanitizeForWebview(value)));
}

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function escapeText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
