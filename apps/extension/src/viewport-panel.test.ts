import { PlaytestController } from "@rbxforge/core";
import { describe, expect, test } from "vitest";

import { createFixtureServices, type ExtensionServices } from "./service-container.js";
import { FakeVsCode } from "./test/fake-vscode.js";
import { ViewportPanel } from "./viewport-panel.js";

function servicesWithScreenshot(): ExtensionServices {
  const fixture = createFixtureServices();
  fixture.connection.update("activeStudioInstance", {
    health: "healthy",
    detail: "Fixture Studio selected",
  });
  const controller = new PlaytestController({
    instanceId: "fixture-instance",
    capability: {
      start: async () => ({ success: true, action: "start", message: "ready" }),
      stop: async () => ({ success: true, action: "stop", message: "stopped" }),
      status: async () => ({ success: true, action: "status", running: false, roles: ["edit"] }),
      logs: async () => ({ entries: [], totalDropped: 0, perCaptureNextSince: {}, perCaptureErrors: {} }),
      screenshot: async () => ({
        data: "AQID",
        mimeType: "image/jpeg",
        format: "jpeg",
        target: "edit",
        capturedAt: 20,
        width: 2,
        height: 3,
        quality: 92,
      }),
    },
  });
  return {
    ...fixture,
    playtest: {
      availability: () => ({ lifecycle: true, logs: true, screenshot: true }),
      controller: () => controller,
    },
  };
}

describe("ViewportPanel", () => {
  test("creates one blob-enabled secure panel and publishes a bounded capture after readiness", async () => {
    const vscode = new FakeVsCode();
    const panel = new ViewportPanel({ services: servicesWithScreenshot(), vscode, extensionRoot: "/extension" });

    await expect(panel.capture()).resolves.toEqual({ ok: true });
    expect(vscode.panels).toHaveLength(1);
    const webview = vscode.panels[0]!.webview;
    expect(webview.html).toContain("img-src vscode-webview://fake data: blob:");
    const init = webview.posted[0] as { sessionId: string; generation: number };
    webview.receive({
      v: 1,
      type: "ready",
      sessionId: init.sessionId,
      requestId: "ready",
      generation: init.generation,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(webview.posted).toContainEqual(
      expect.objectContaining({
        type: "viewportCapture",
        capture: expect.objectContaining({ data: "AQID", target: "edit" }),
      }),
    );
    panel.dispose();
    expect(vscode.panels[0]?.disposed).toBe(true);
  });

  test("does not create a no-op panel when capability is unavailable", async () => {
    const vscode = new FakeVsCode();
    const panel = new ViewportPanel({ services: createFixtureServices(), vscode, extensionRoot: "/extension" });
    await expect(panel.capture()).resolves.toMatchObject({
      ok: false,
      reason: "Studio MCP playtest capabilities are unavailable in fixture mode",
    });
    expect(vscode.panels).toHaveLength(0);
  });

  test("returns the exact trusted reason when only capture_screenshot is missing", async () => {
    const vscode = new FakeVsCode();
    const fixture = servicesWithScreenshot();
    const services: ExtensionServices = {
      ...fixture,
      playtest: {
        ...fixture.playtest,
        availability: () => ({
          lifecycle: true,
          logs: true,
          screenshot: false,
          reason: "Studio MCP capability unavailable: capture_screenshot",
        }),
      },
    };
    const panel = new ViewportPanel({ services, vscode, extensionRoot: "/extension" });

    await expect(panel.capture()).resolves.toEqual({
      ok: false,
      reason: "Studio MCP capability unavailable: capture_screenshot",
    });
    expect(vscode.panels).toHaveLength(0);
  });

  test("marks an existing capture stale without retransmitting image data and shows later precondition errors", async () => {
    const vscode = new FakeVsCode();
    const services = servicesWithScreenshot();
    const panel = new ViewportPanel({ services, vscode, extensionRoot: "/extension" });
    await panel.capture();
    const webview = vscode.panels[0]!.webview;
    const init = webview.posted[0] as { readonly sessionId: string; readonly generation: number };
    webview.receive({
      v: 1,
      type: "ready",
      sessionId: init.sessionId,
      requestId: "ready",
      generation: init.generation,
    });
    await Promise.resolve();
    await Promise.resolve();
    const capture = webview.posted.find(
      (message) => (message as { readonly type?: string }).type === "viewportCapture",
    ) as {
      readonly capture: { readonly captureId: string; readonly data: string };
    };

    services.connection.update("activeStudioInstance", {
      health: "unhealthy",
      detail: "SECRET_process_output",
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(webview.posted).toContainEqual(
      expect.objectContaining({
        type: "viewportStale",
        captureId: capture.capture.captureId,
      }),
    );
    const stale = webview.posted.find((message) => (message as { readonly type?: string }).type === "viewportStale");
    expect(stale).not.toHaveProperty("data");
    await expect(panel.capture()).resolves.toEqual({
      ok: false,
      reason: "Select a fresh Studio instance before capturing the viewport",
    });
    expect(webview.posted).toContainEqual(
      expect.objectContaining({
        type: "viewportStatus",
        state: "error",
        detail: "Select a fresh Studio instance before capturing the viewport",
      }),
    );
    expect(JSON.stringify(webview.posted)).not.toContain("SECRET_process_output");
  });
});
