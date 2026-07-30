import { describe, expect, it, vi } from "vitest";

import type { DesktopCommandInput, DesktopEvent, DesktopResponse } from "../../shared/protocol.js";
import { snapshot } from "../test/fixtures.js";
import { createDesktopClient } from "./desktop-client.js";

function response(): DesktopResponse {
  return {
    version: 1,
    requestId: "host-owned",
    ok: true,
    snapshot: snapshot({ revision: 13 }),
    result: { kind: "none" },
  };
}

describe("desktop client", () => {
  it("exposes named methods that centrally inject the current revision", async () => {
    const request = vi.fn(async (_input: DesktopCommandInput) => response());
    const client = createDesktopClient({
      api: { platform: "darwin", request, subscribe: vi.fn() },
      getExpectedRevision: () => 12,
    });
    await client.renameThread("project-a", "thread-a", "Lobby");
    await client.saveDraft("project-a", "thread-a", "local");
    await client.createMessage("project-a", "thread-a", "prompt");
    expect(request.mock.calls.map(([command]) => command)).toEqual([
      {
        type: "thread.rename",
        projectId: "project-a",
        threadId: "thread-a",
        title: "Lobby",
        expectedRevision: 12,
      },
      {
        type: "draft.save",
        projectId: "project-a",
        threadId: "thread-a",
        content: "local",
        expectedRevision: 12,
      },
      {
        type: "message.create",
        projectId: "project-a",
        threadId: "thread-a",
        content: "prompt",
        expectedRevision: 12,
      },
    ]);
  });

  it("sends only opaque candidate identity and invokes cancel once", async () => {
    const request = vi.fn(async (_input: DesktopCommandInput) => response());
    const client = createDesktopClient({
      api: { platform: "darwin", request, subscribe: vi.fn() },
      getExpectedRevision: () => 4,
    });
    await client.addProjectCandidate("selection-opaque", "candidate-opaque");
    const cancel = client.cancelProjectAdd("selection-opaque");
    await Promise.all([cancel(), cancel()]);
    expect(request).toHaveBeenNthCalledWith(1, {
      type: "project.addCandidate",
      selectionId: "selection-opaque",
      candidateId: "candidate-opaque",
      expectedRevision: 4,
    });
    expect(request.mock.calls.filter(([command]) => command.type === "project.cancelAdd")).toHaveLength(1);
  });

  it("delegates one subscription and returns its exact cleanup", () => {
    const cleanup = vi.fn();
    const subscribe = vi.fn((_listener: (event: DesktopEvent) => void) => cleanup);
    const client = createDesktopClient({
      api: { platform: "darwin", request: vi.fn(), subscribe },
      getExpectedRevision: () => 1,
    });
    const listener = vi.fn();
    expect(client.subscribe(listener)).toBe(cleanup);
    expect(subscribe).toHaveBeenCalledWith(listener);
  });

  it("sends exact renderer-safe payloads for every connection command", async () => {
    const request = vi.fn(async (_input: DesktopCommandInput) => response());
    const client = createDesktopClient({
      api: { platform: "darwin", request, subscribe: vi.fn() },
      getExpectedRevision: () => 19,
    });

    await client.copyProjectFile("project-a");
    await client.connectRuntime("project-a");
    await client.selectStudio("project-a", "studio-exact", 7, false);
    await client.confirmRojoHandoff("project-a", 11);
    await client.refreshRuntime("project-a");
    await client.copyMcpUrl("project-a");
    await client.copyRojoAddress("project-a");
    await client.disconnectRuntime("project-a");
    await client.inspectPlugin();
    await client.installPlugin(true);
    await client.showPluginFolder();
    await client.chooseRojo();
    await client.setMcpPort(60_000);

    expect(request.mock.calls.map(([command]) => command)).toEqual([
      { type: "project.copyFile", projectId: "project-a" },
      { type: "runtime.connect", projectId: "project-a", expectedRevision: 19 },
      {
        type: "runtime.selectStudio",
        projectId: "project-a",
        instanceId: "studio-exact",
        catalogRevision: 7,
        warningAccepted: false,
        expectedRevision: 19,
      },
      {
        type: "runtime.confirmRojoHandoff",
        projectId: "project-a",
        bindingRevision: 11,
        expectedRevision: 19,
      },
      { type: "runtime.refresh", projectId: "project-a", expectedRevision: 19 },
      { type: "runtime.copyMcpUrl", projectId: "project-a" },
      { type: "runtime.copyRojoAddress", projectId: "project-a" },
      { type: "runtime.disconnect", projectId: "project-a", expectedRevision: 19 },
      { type: "plugin.inspect" },
      { type: "plugin.install", confirmReplace: true, expectedRevision: 19 },
      { type: "plugin.showFolder" },
      { type: "settings.chooseRojo", expectedRevision: 19 },
      { type: "settings.mcpPort", port: 60_000, expectedRevision: 19 },
    ]);
  });
});
