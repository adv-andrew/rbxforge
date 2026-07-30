import { describe, expect, test, vi } from "vitest";

import { SecureWebviewHost, createWebviewHtml, createWebviewNonce, safeLogValue } from "./webview-host.js";

const base = { v: 1 as const, sessionId: "session-1", requestId: "request-1", generation: 1 };

describe("secure webview host", () => {
  test("creates a distinct cryptographic nonce for each panel", () => {
    const first = createWebviewNonce();
    const second = createWebviewNonce();
    expect(first).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    expect(second).not.toBe(first);
  });

  test("generates nonce-only local CSP with no inline styles, network, or sensitive values", () => {
    const html = createWebviewHtml({
      cspSource: "vscode-webview://panel",
      nonce: "cryptographic-nonce",
      scriptUri: "vscode-webview://panel/dist/webview.js",
      styleUri: "vscode-webview://panel/dist/styles.css",
      title: "Properties",
    });

    expect(html).toContain("default-src 'none'");
    expect(html).toContain("img-src vscode-webview://panel data:");
    expect(html).toContain("style-src vscode-webview://panel");
    expect(html).toContain("script-src 'nonce-cryptographic-nonce'");
    expect(html).toContain('<script type="module" nonce="cryptographic-nonce"');
    expect(html).toContain("font-src vscode-webview://panel");
    expect(html).toContain("connect-src 'none'");
    expect(html).not.toMatch(/unsafe-inline|unsafe-eval|https?:|<style/i);
    expect(html).not.toMatch(/key|token|secret|authorization|credential/i);
  });

  test("queues snapshots until the matching session is ready and rejects wrong session or generation", async () => {
    const posted: unknown[] = [];
    const host = new SecureWebviewHost({
      sessionId: "session-1",
      postMessage: async (message) => {
        posted.push(message);
        return true;
      },
    });
    await host.publish({
      ...base,
      type: "protocolError",
      message: "Reload",
    });
    expect(posted).toEqual([]);

    expect(await host.accept({ ...base, sessionId: "wrong", type: "ready" })).toBe(false);
    expect(await host.accept({ ...base, generation: 0, type: "ready" })).toBe(false);
    expect(posted).toEqual([]);

    expect(await host.accept({ ...base, type: "ready" })).toBe(true);
    expect(posted).toHaveLength(1);
  });

  test("suppresses a stale async response when request B resolves before request A", async () => {
    const posted: unknown[] = [];
    const host = new SecureWebviewHost({
      sessionId: "session-1",
      postMessage: async (message) => {
        posted.push(message);
        return true;
      },
    });
    await host.accept({ ...base, type: "ready" });
    let resolveA: ((value: string) => void) | undefined;
    const operationA = new Promise<string>((resolve) => {
      resolveA = resolve;
    });

    const pendingA = host.runLatest(
      1,
      "A",
      () => operationA,
      (value) => ({
        ...base,
        requestId: "A",
        type: "protocolError",
        message: value,
      }),
    );
    await host.runLatest(
      1,
      "B",
      async () => "B",
      (value) => ({
        ...base,
        requestId: "B-response",
        type: "protocolError",
        message: value,
      }),
    );
    resolveA?.("A");
    await pendingA;

    expect(posted).toEqual([expect.objectContaining({ generation: 1, requestId: "B-response", message: "B" })]);
  });

  test("rejects replayed request IDs and arbitrary future generations", async () => {
    const host = new SecureWebviewHost({
      sessionId: "session-1",
      postMessage: async () => true,
    });
    expect(await host.accept({ ...base, type: "ready" })).toBe(true);
    expect(await host.accept({ ...base, requestId: "refresh-1", type: "refreshProperties" })).toBe(true);
    expect(await host.accept({ ...base, requestId: "refresh-1", type: "refreshProperties" })).toBe(false);
    expect(await host.accept({ ...base, requestId: "future", generation: 9, type: "refreshProperties" })).toBe(false);
  });

  test("supports a deliberate next generation but rejects old-generation requests", async () => {
    const host = new SecureWebviewHost({
      sessionId: "session-1",
      postMessage: async () => true,
    });
    expect(await host.accept({ ...base, type: "ready" })).toBe(true);
    host.advanceGeneration(2);
    expect(await host.accept({ ...base, requestId: "old", type: "refreshProperties" })).toBe(false);
    expect(await host.accept({ ...base, requestId: "new", generation: 2, type: "refreshProperties" })).toBe(true);
  });

  test("sanitizes secret-like fields before logging", () => {
    const logger = vi.fn();
    safeLogValue(logger, {
      detail: "visible",
      nested: { accessToken: "hidden", apiKey: "hidden", value: 4 },
    });
    expect(logger).toHaveBeenCalledWith(
      JSON.stringify({
        detail: "visible",
        nested: { value: 4 },
      }),
    );
  });
});
