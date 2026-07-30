import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ModelProvider, ModelSession, ProviderEvent, ProviderRequest, ProviderTurnInput } from "@rbxforge/agent";
import { describe, expect, test, vi } from "vitest";

import { createFixtureServices, type ExtensionServices } from "../service-container.js";
import { FakeVsCode, FakeWebview } from "../test/fake-vscode.js";
import { AgentWebviewProvider } from "./agent-provider.js";

describe("AgentWebviewProvider", () => {
  test("mounts the real Agent view and streams one fixture run with fresh retry IDs", async () => {
    const root = await mkdtemp(join(tmpdir(), "rbxforge-agent-provider-"));
    const project = join(root, "default.project.json");
    await writeFile(project, "{}");
    const vscode = new FakeVsCode();
    vscode.workspaceFolderPaths = [root];
    const services = createFixtureServices();
    await services.project.select(project);
    const model = new RecordingProvider([
      [{ type: "text-delta", delta: "First" }, { type: "text-delta", delta: "Second" }, { type: "completed" }],
      [{ type: "text-delta", delta: "Retry" }, { type: "completed" }],
    ]);
    const ids = values("session-1", "run-1", "run-2");
    const provider = new AgentWebviewProvider({ services, vscode, modelProvider: model, randomId: ids });
    const webview = new FakeWebview("/extension");
    await provider.resolveWebviewView({ webview });
    expect(webview.posted[0]).toMatchObject({ type: "init", view: "agent", sessionId: "session-1" });
    webview.receive(envelope("ready", "ready-1"));
    await vi.waitFor(() => expect(webview.posted.some((message) => isType(message, "agentSnapshot"))).toBe(true));

    webview.receive({
      ...envelope("startAgentRun", "start-1"),
      mode: "ask",
      prompt: "Inspect safely",
      chipIds: [],
    });
    await vi.waitFor(() =>
      expect(webview.posted.some((message) => isType(message, "agentTerminal") && message.state === "completed")).toBe(
        true,
      ),
    );
    const deltas = webview.posted.filter((message): message is Record<string, unknown> =>
      isType(message, "agentTextDelta"),
    );
    expect(deltas.map((message) => message.delta)).toEqual(["First", "Second"]);
    expect(deltas.map((message) => message.sequence)).toEqual([1, 2]);
    expect(JSON.stringify(webview.posted)).not.toContain("Inspect safely");
    expect(model.requests).toHaveLength(1);

    webview.receive({
      ...envelope("retryAgentRun", "retry-1"),
      previousRunId: "run-1",
    });
    await vi.waitFor(() =>
      expect(webview.posted.some((message) => isType(message, "agentTextDelta") && message.runId === "run-2")).toBe(
        true,
      ),
    );
    expect(model.requests).toHaveLength(2);
    expect(model.requests[1]?.input).toBe("Inspect safely");
    provider.dispose();
    await services.dispose();
    expect(model.sessions.every((session) => session.closeCount === 1)).toBe(true);
  });

  test("mints host-resolved Studio chips and rejects unissued IDs", async () => {
    const root = await mkdtemp(join(tmpdir(), "rbxforge-agent-provider-"));
    const project = join(root, "default.project.json");
    await writeFile(project, "{}");
    const services = createFixtureServices();
    await services.project.select(project);
    const vscode = new FakeVsCode();
    const model = new RecordingProvider([[{ type: "completed" }]]);
    const provider = new AgentWebviewProvider({
      services,
      vscode,
      modelProvider: model,
      randomId: values("session-1", "chip-1", "run-1"),
    });
    await provider.addStudioContext({
      path: "game.Workspace.Mapped",
      name: "Mapped",
      className: "Script",
      ownership: "files",
    });
    const webview = new FakeWebview("/extension");
    await provider.resolveWebviewView({ webview });
    webview.receive(envelope("ready", "ready-1"));
    await vi.waitFor(() =>
      expect(
        webview.posted.some((message) => isType(message, "agentSnapshot") && Array.isArray(message.snapshot)),
      ).toBe(false),
    );
    const snapshot = [...webview.posted].reverse().find((message) => isType(message, "agentSnapshot")) as {
      snapshot: { chips: readonly { id: string; label: string }[]; status: string };
    };
    expect(snapshot.snapshot.chips).toEqual([
      {
        id: expect.any(String),
        label: "game.Workspace.Mapped",
        kind: "studio-properties",
      },
    ]);

    webview.receive({
      ...envelope("startAgentRun", "bad-start"),
      mode: "ask",
      prompt: "Use fake chip",
      chipIds: ["attacker-path"],
    });
    await vi.waitFor(() =>
      expect([...webview.posted].reverse().find((message) => isType(message, "agentSnapshot"))).toMatchObject({
        snapshot: { status: "stale" },
      }),
    );
    expect(model.requests).toHaveLength(0);
    provider.dispose();
    await services.dispose();
  });

  test.each(["graph revision", "active Studio instance"] as const)(
    "omits a delayed Studio context resolver when its %s changes during the read",
    async (staleBy) => {
      const root = await realpath(await mkdtemp(join(tmpdir(), "rbxforge-agent-provider-")));
      const project = join(root, "default.project.json");
      await writeFile(project, "{}");
      const fixture = createFixtureServices();
      await fixture.project.select(project);
      let graphRevision = fixture.graph.revision?.() ?? 0;
      let activeInstanceId = "fixture-instance";
      let entered!: () => void;
      let release!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const waiting = new Promise<void>((resolve) => {
        release = resolve;
      });
      const services: ExtensionServices = {
        ...fixture,
        graph: {
          ...fixture.graph,
          resolve: async (path, signal) => {
            const resolved = await fixture.graph.resolve(path, signal);
            return Object.freeze({ ...resolved, revision: graphRevision });
          },
          assertRevision: (expected) => {
            if (expected !== graphRevision) throw new Error("Unified graph changed before context release");
          },
          revision: () => graphRevision,
        },
        studio: {
          ...fixture.studio,
          snapshot: () => ({ activeInstanceId, stale: false }),
          guardedProperties: async () => {
            entered();
            await waiting;
            return Object.freeze({
              instancePath: "game.Workspace.Mapped",
              className: "Script",
              properties: Object.freeze({ Name: "late-studio-property-sentinel" }),
            });
          },
        },
      };
      const vscode = new FakeVsCode();
      const provider = new AgentWebviewProvider({
        services,
        vscode,
        modelProvider: new RecordingProvider([[{ type: "completed" }]]),
        randomId: values("session-1"),
      });
      await provider.addStudioContext({
        path: "game.Workspace.Mapped",
        name: "Mapped",
        className: "Script",
        ownership: "files",
      });
      const webview = new FakeWebview("/extension");
      await provider.resolveWebviewView({ webview });
      webview.receive(envelope("ready", "ready-1"));
      await vi.waitFor(() => expect(latestAgentChips(webview)).toHaveLength(1));
      const chipId = latestAgentChips(webview)[0]!.id;
      const building = services.agent.contextRegistry.build(
        {
          chipIds: [chipId],
          workspaceRoot: root,
          sessionId: "session-1",
          generation: 1,
          instanceId: "fixture-instance",
          graphRevision,
        },
        { vision: false },
        new AbortController().signal,
      );

      await started;
      if (staleBy === "graph revision") graphRevision += 1;
      else activeInstanceId = "other-instance";
      release();
      const context = await building;

      expect(context.records).toEqual([]);
      expect(context.receipts).toEqual([expect.objectContaining({ outcome: "omitted", reason: "stale-capability" })]);
      expect(JSON.stringify(context)).not.toContain("late-studio-property-sentinel");
      provider.dispose();
      await services.dispose();
    },
  );

  test.each(["graph", "connection"] as const)(
    "aborts an active run and suppresses dispatch when selected Studio context has a %s invalidation",
    async (invalidationKind) => {
      const root = await realpath(await mkdtemp(join(tmpdir(), "rbxforge-agent-provider-")));
      const project = join(root, "default.project.json");
      await writeFile(project, "{}");
      const fixture = createFixtureServices();
      await fixture.project.select(project);
      let invalidateGraph: ((event: { readonly path: string }) => void) | undefined;
      let invalidateConnection:
        ((snapshot: ReturnType<ExtensionServices["connection"]["snapshot"]>) => void) | undefined;
      const services: ExtensionServices = {
        ...fixture,
        graph: {
          ...fixture.graph,
          onGraphInvalidated: (listener) => {
            invalidateGraph = listener;
            return {
              dispose: () => {
                invalidateGraph = undefined;
              },
            };
          },
          onConnectionChanged: (listener) => {
            invalidateConnection = listener;
            return {
              dispose: () => {
                invalidateConnection = undefined;
              },
            };
          },
        },
      };
      let release!: () => void;
      const waiting = new Promise<void>((resolve) => {
        release = resolve;
      });
      let runSignal: AbortSignal | undefined;
      const close = vi.fn(async () => undefined);
      const model: ModelProvider = {
        capabilities: { vision: false },
        open: async () => ({
          respond: async function* (_input, signal) {
            runSignal = signal;
            yield { type: "text-delta", delta: "before-invalidation" };
            await waiting;
            yield { type: "text-delta", delta: "late-after-invalidation" };
            yield { type: "completed" };
          },
          close,
        }),
      };
      const vscode = new FakeVsCode();
      const provider = new AgentWebviewProvider({
        services,
        vscode,
        modelProvider: model,
        randomId: values("session-1", "run-1"),
      });
      await provider.addStudioContext({
        path: "game.Workspace.Mapped",
        name: "Mapped",
        className: "Script",
        ownership: "files",
      });
      const webview = new FakeWebview("/extension");
      await provider.resolveWebviewView({ webview });
      webview.receive(envelope("ready", "ready-1"));
      await vi.waitFor(() => expect(latestAgentChips(webview)).toHaveLength(1));
      const chipId = latestAgentChips(webview)[0]!.id;
      webview.receive({
        ...envelope("startAgentRun", "start-1"),
        mode: "debug",
        prompt: "Inspect the selected Studio object",
        chipIds: [chipId],
      });
      await vi.waitFor(() =>
        expect(
          webview.posted.some(
            (message) => isType(message, "agentTextDelta") && message.delta === "before-invalidation",
          ),
        ).toBe(true),
      );

      if (invalidationKind === "graph") {
        invalidateGraph?.({ path: "game.Workspace.Mapped" });
      } else {
        invalidateConnection?.(services.connection.snapshot());
      }
      await Promise.resolve();
      const abortedAtInvalidation = runSignal?.aborted;
      release();
      await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));

      expect(abortedAtInvalidation).toBe(true);
      expect(
        webview.posted.some(
          (message) => isType(message, "agentTextDelta") && message.delta === "late-after-invalidation",
        ),
      ).toBe(false);
      expect(webview.posted.some((message) => isType(message, "agentTerminal") && message.runId === "run-1")).toBe(
        false,
      );
      expect([...webview.posted].reverse().find((message) => isType(message, "agentSnapshot"))).toMatchObject({
        snapshot: { status: "stale" },
      });
      await provider.shutdown();
      await services.dispose();
    },
  );

  test.each([
    { requestedName: "credentials.json", canonicalName: "main.lua" },
    { requestedName: "main.lua", canonicalName: "secrets.json" },
  ])(
    "does not mint an active-file chip for requested $requestedName resolving to $canonicalName",
    async ({ requestedName, canonicalName }) => {
      const root = await realpath(await mkdtemp(join(tmpdir(), "rbxforge-agent-provider-")));
      const project = join(root, "default.project.json");
      const canonicalFile = join(root, canonicalName);
      const requestedFile = join(root, requestedName);
      await writeFile(project, "{}");
      await writeFile(canonicalFile, "return true\n");
      await symlink(canonicalFile, requestedFile);
      const vscode = new FakeVsCode();
      vscode.workspaceFolderPaths = [root];
      vscode.activeSelectionValue = {
        path: requestedFile,
        document: {
          path: requestedFile,
          uri: `file://${requestedFile}`,
          text: "return true\n",
          version: 1,
          isDirty: false,
        },
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 0 },
        },
      };
      vscode.documentSnapshots.set(canonicalFile, {
        path: canonicalFile,
        uri: `file://${canonicalFile}`,
        text: "return true\n",
        version: 1,
        isDirty: false,
      });
      const services = createFixtureServices();
      await services.project.select(project);
      const provider = new AgentWebviewProvider({
        services,
        vscode,
        modelProvider: new RecordingProvider([[{ type: "completed" }]]),
        randomId: values("session-1"),
      });
      const webview = new FakeWebview("/extension");
      await provider.resolveWebviewView({ webview });
      webview.receive(envelope("ready", "ready-1"));
      await vi.waitFor(() => expect(webview.posted.some((message) => isType(message, "agentSnapshot"))).toBe(true));

      expect(latestAgentChips(webview)).toEqual([]);
      provider.dispose();
      await services.dispose();
    },
  );

  test("does not mint an ordinary dirty active file without a clean provenance lease", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "rbxforge-agent-provider-")));
    const project = join(root, "default.project.json");
    const file = join(root, "main.lua");
    await writeFile(project, "{}");
    await writeFile(file, "return 'disk'\n");
    const vscode = new FakeVsCode();
    vscode.workspaceFolderPaths = [root];
    vscode.activeSelectionValue = {
      path: file,
      document: {
        path: file,
        uri: `file://${file}`,
        text: "return 'untrusted dirty buffer'\n",
        version: 4,
        isDirty: true,
      },
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 0 },
      },
    };
    const services = createFixtureServices();
    await services.project.select(project);
    const provider = new AgentWebviewProvider({
      services,
      vscode,
      modelProvider: new RecordingProvider([[{ type: "completed" }]]),
      randomId: values("session-1"),
    });
    const webview = new FakeWebview("/extension");

    await provider.resolveWebviewView({ webview });
    webview.receive(envelope("ready", "ready-1"));
    await vi.waitFor(() => expect(webview.posted.some((message) => isType(message, "agentSnapshot"))).toBe(true));

    expect(latestAgentChips(webview)).toEqual([]);
    await provider.shutdown();
    await services.dispose();
  });

  test("automatically supplies the active existing file with exact buffer version/hash, selection and bounded diagnostics", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "rbxforge-agent-provider-")));
    const project = join(root, "default.project.json");
    const file = join(root, "src", "main.lua");
    await mkdir(join(root, "src"));
    await writeFile(project, "{}");
    await writeFile(file, "return 'stale disk'\n");
    const current = "local value = 1\nreturn value\n";
    const vscode = new FakeVsCode();
    vscode.workspaceFolderPaths = [root];
    vscode.activeSelectionValue = {
      path: file,
      document: {
        path: file,
        uri: `file://${file}`,
        text: current,
        version: 7,
        isDirty: true,
      },
      range: {
        start: { line: 0, character: 6 },
        end: { line: 0, character: 11 },
      },
    };
    vscode.documentSnapshots.set(file, {
      path: file,
      uri: `file://${file}`,
      text: current,
      version: 7,
      isDirty: true,
    });
    vscode.trustActiveSelection();
    vscode.diagnosticEntries.push(
      {
        path: file,
        message: "Unknown global value",
        severity: 1,
        range: {
          start: { line: 0, character: 6 },
          end: { line: 0, character: 11 },
        },
      },
      {
        path: file,
        message: "api_key=diagnostic-sentinel",
        severity: 2,
        range: {
          start: { line: 1, character: 0 },
          end: { line: 1, character: 6 },
        },
      },
    );
    const services = createFixtureServices();
    await services.project.select(project);
    const model = new RecordingProvider([[{ type: "completed" }]]);
    const provider = new AgentWebviewProvider({
      services,
      vscode,
      modelProvider: model,
      randomId: values("session-1", "run-1"),
    });
    const webview = new FakeWebview("/extension");
    await provider.resolveWebviewView({ webview });
    webview.receive(envelope("ready", "ready-1"));
    await vi.waitFor(() =>
      expect(
        webview.posted.some(
          (message) => isType(message, "agentSnapshot") && JSON.stringify(message).includes("src/main.lua"),
        ),
      ).toBe(true),
    );
    const fileChip = [...webview.posted]
      .reverse()
      .find((message) => isType(message, "agentSnapshot") && JSON.stringify(message).includes("src/main.lua")) as {
      snapshot: { chips: readonly { id: string; kind: string }[] };
    };
    const fileChipId = fileChip.snapshot.chips.find((chip) => chip.kind === "file")?.id;
    if (fileChipId === undefined) throw new Error("Expected active file context chip");
    webview.receive({
      ...envelope("startAgentRun", "start-1"),
      mode: "build",
      prompt: "Change the active script",
      chipIds: [fileChipId],
    });

    await vi.waitFor(() => expect(model.requests).toHaveLength(1));
    const record = model.requests[0]!.context.records.find((candidate) => candidate.kind === "file");
    expect(record?.label).toBe("src/main.lua");
    expect(record?.content).toContain("path: src/main.lua");
    expect(record?.content).toContain("version: 7");
    expect(record?.content).toContain(`sha256: ${createHash("sha256").update(current).digest("hex")}`);
    expect(record?.content).toContain("selection: 0:6-0:11");
    expect(record?.content).toContain("Unknown global value");
    expect(record?.content).toContain(current);
    expect(record?.content).not.toContain("diagnostic-sentinel");
    expect(record?.content).not.toContain(root);
    expect(JSON.stringify(webview.posted)).not.toContain(root);

    await provider.shutdown();
    await services.dispose();
  });

  test("uses the immutable active editor snapshot when a later pathname read swaps outside and restores", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "rbxforge-agent-provider-")));
    const outside = await realpath(await mkdtemp(join(tmpdir(), "rbxforge-agent-provider-outside-")));
    const project = join(root, "default.project.json");
    const file = join(root, "main.lua");
    const backup = join(root, "main.backup.lua");
    const outsideFile = join(outside, "outside.lua");
    const discardedLink = join(root, "discarded-link.lua");
    const current = "local unsaved = true\nreturn unsaved\n";
    const sentinel = "LEAKED_ACTIVE_FILE_SENTINEL";
    await writeFile(project, "{}");
    await writeFile(file, "return 'stale disk'\n");
    await writeFile(outsideFile, sentinel);
    const vscode = new FakeVsCode();
    vscode.workspaceFolderPaths = [root];
    vscode.activeSelectionValue = {
      path: file,
      range: {
        start: { line: 0, character: 6 },
        end: { line: 0, character: 13 },
      },
      document: {
        path: file,
        uri: `file://${file}`,
        text: current,
        version: 11,
        isDirty: true,
      },
    };
    vscode.documentSnapshots.set(file, {
      path: file,
      uri: `file://${file}`,
      text: current,
      version: 11,
      isDirty: true,
    });
    vscode.trustActiveSelection();
    let pathnameReads = 0;
    vscode.onDocumentSnapshot = async () => {
      pathnameReads += 1;
      await rename(file, backup);
      await symlink(outsideFile, file);
      vscode.documentSnapshots.set(file, {
        path: file,
        uri: `file://${file}`,
        text: sentinel,
        version: 12,
        isDirty: false,
      });
      await rename(file, discardedLink);
      await rename(backup, file);
    };
    const services = createFixtureServices();
    await services.project.select(project);
    const model = new RecordingProvider([[{ type: "completed" }]]);
    const provider = new AgentWebviewProvider({
      services,
      vscode,
      modelProvider: model,
      randomId: values("session-1", "run-1"),
    });
    const webview = new FakeWebview("/extension");
    await provider.resolveWebviewView({ webview });
    webview.receive(envelope("ready", "ready-1"));
    await vi.waitFor(() => expect(latestAgentChips(webview)).toHaveLength(1));
    const chipId = latestAgentChips(webview)[0]!.id;

    webview.receive({
      ...envelope("startAgentRun", "start-1"),
      mode: "build",
      prompt: "Use the active buffer",
      chipIds: [chipId],
    });

    await vi.waitFor(() => expect(model.requests).toHaveLength(1));
    const record = model.requests[0]!.context.records.find((candidate) => candidate.kind === "file");
    expect(record?.content).toContain(current);
    expect(record?.content).toContain("version: 11");
    expect(record?.content).toContain(createHash("sha256").update(current).digest("hex"));
    expect(record?.content).not.toContain(sentinel);
    expect(pathnameReads).toBe(0);

    await provider.shutdown();
    await services.dispose();
  });

  test("stop/dispose aborts and suppresses late provider events", async () => {
    const root = await mkdtemp(join(tmpdir(), "rbxforge-agent-provider-"));
    const project = join(root, "default.project.json");
    await writeFile(project, "{}");
    const services = createFixtureServices();
    await services.project.select(project);
    const vscode = new FakeVsCode();
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const close = vi.fn(async () => undefined);
    const model: ModelProvider = {
      capabilities: { vision: false },
      open: async () => ({
        respond: async function* () {
          yield { type: "text-delta", delta: "before" };
          await waiting;
          yield { type: "text-delta", delta: "late" };
          yield { type: "completed" };
        },
        close,
      }),
    };
    const provider = new AgentWebviewProvider({
      services,
      vscode,
      modelProvider: model,
      randomId: values("session-1", "run-1"),
    });
    const webview = new FakeWebview("/extension");
    await provider.resolveWebviewView({ webview });
    webview.receive(envelope("ready", "ready-1"));
    webview.receive({
      ...envelope("startAgentRun", "start-1"),
      mode: "debug",
      prompt: "Debug",
      chipIds: [],
    });
    await vi.waitFor(() =>
      expect(webview.posted.some((message) => isType(message, "agentTextDelta") && message.delta === "before")).toBe(
        true,
      ),
    );
    let shutdownSettled = false;
    const shutdown = provider.shutdown().then(() => {
      shutdownSettled = true;
    });
    await Promise.resolve();
    expect(shutdownSettled).toBe(false);
    release();
    await shutdown;
    expect(webview.posted.some((message) => isType(message, "agentTextDelta") && message.delta === "late")).toBe(false);
    expect(close).toHaveBeenCalledTimes(1);
    await services.dispose();
  });

  test("chunks one oversized multibyte model delta into consecutive bounded host messages", async () => {
    const root = await mkdtemp(join(tmpdir(), "rbxforge-agent-provider-"));
    const project = join(root, "default.project.json");
    await writeFile(project, "{}");
    const services = createFixtureServices();
    await services.project.select(project);
    const vscode = new FakeVsCode();
    vscode.workspaceFolderPaths = [root];
    const modelText = `${"a".repeat(16_383)}💎${"界".repeat(4_000)}`;
    const model = new RecordingProvider([[{ type: "text-delta", delta: modelText }, { type: "completed" }]]);
    const provider = new AgentWebviewProvider({
      services,
      vscode,
      modelProvider: model,
      randomId: values("session-1", "run-1"),
    });
    const webview = new FakeWebview("/extension");
    await provider.resolveWebviewView({ webview });
    webview.receive(envelope("ready", "ready-1"));
    webview.receive({
      ...envelope("startAgentRun", "start-1"),
      mode: "ask",
      prompt: "Stream a long response",
      chipIds: [],
    });

    await vi.waitFor(() =>
      expect(webview.posted.some((message) => isType(message, "agentTerminal") && message.state === "completed")).toBe(
        true,
      ),
    );
    const deltas = webview.posted.filter((message): message is Record<string, unknown> =>
      isType(message, "agentTextDelta"),
    );
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.map((message) => message.sequence)).toEqual(
      Array.from({ length: deltas.length }, (_, index) => index + 1),
    );
    expect(
      deltas.every(
        (message) => typeof message.delta === "string" && new TextEncoder().encode(message.delta).byteLength <= 16_384,
      ),
    ).toBe(true);
    expect(deltas.map((message) => message.delta).join("")).toBe(modelText);
    expect(deltas.every((message) => !String(message.delta).includes("\uFFFD"))).toBe(true);
    provider.dispose();
    await services.dispose();
  });

  test("forwards only bounded display descriptors on Studio approval cards", async () => {
    const root = await mkdtemp(join(tmpdir(), "rbxforge-agent-provider-"));
    const project = join(root, "default.project.json");
    await writeFile(project, "{}");
    const services = createFixtureServices();
    await services.project.select(project);
    const vscode = new FakeVsCode();
    vscode.workspaceFolderPaths = [root];
    const model = new RecordingProvider([
      [
        {
          type: "tool-call",
          callId: "call-1",
          name: "set_studio_property",
          arguments: {
            ok: true,
            value: {
              instanceId: "fixture-instance",
              instancePath: "game.Workspace.Mapped",
              propertyName: "Enabled",
              propertyValue: true,
            },
            bytes: 145,
          },
        },
        { type: "completed" },
      ],
    ]);
    const provider = new AgentWebviewProvider({
      services,
      vscode,
      modelProvider: model,
      randomId: values("session-1", "run-1", "prepared-1", "approval-1"),
    });
    const webview = new FakeWebview("/extension");
    await provider.resolveWebviewView({ webview });
    webview.receive(envelope("ready", "ready-1"));
    webview.receive({
      ...envelope("startAgentRun", "start-1"),
      mode: "build",
      prompt: "Enable the mapped script",
      chipIds: [],
    });

    await vi.waitFor(() => expect(webview.posted.some((message) => isType(message, "agentApproval"))).toBe(true));
    expect(webview.posted.find((message) => isType(message, "agentApproval"))).toMatchObject({
      approval: {
        runId: "run-1",
        approvalId: "approval-1",
        kind: "studio",
        change: {
          before: "[unset]",
          after: "true",
        },
      },
    });
    expect(JSON.stringify(webview.posted)).not.toMatch(/propertyValue|instanceId|arguments/i);
    provider.dispose();
    await services.dispose();
  });
});

class RecordingProvider implements ModelProvider {
  readonly capabilities = { vision: false };
  readonly requests: ProviderRequest[] = [];
  readonly sessions: RecordingSession[] = [];
  readonly #turns: readonly (readonly ProviderEvent[])[];
  constructor(turns: readonly (readonly ProviderEvent[])[]) {
    this.#turns = turns;
  }
  async open(request: ProviderRequest): Promise<ModelSession> {
    this.requests.push(request);
    const session = new RecordingSession(this.#turns[this.sessions.length] ?? [{ type: "completed" }]);
    this.sessions.push(session);
    return session;
  }
}

class RecordingSession implements ModelSession {
  closeCount = 0;
  constructor(readonly events: readonly ProviderEvent[]) {}
  async *respond(_input: ProviderTurnInput): AsyncIterable<ProviderEvent> {
    for (const event of this.events) yield event;
  }
  async close(): Promise<void> {
    this.closeCount += 1;
  }
}

function envelope(type: string, requestId: string) {
  return { v: 1, type, sessionId: "session-1", requestId, generation: 1 };
}

function isType(value: unknown, type: string): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && (value as Record<string, unknown>).type === type;
}

function latestAgentChips(webview: FakeWebview): readonly {
  readonly id: string;
  readonly label: string;
  readonly kind: string;
}[] {
  const message = [...webview.posted].reverse().find((value) => isType(value, "agentSnapshot")) as
    | {
        readonly snapshot?: {
          readonly chips?: readonly { readonly id: string; readonly label: string; readonly kind: string }[];
        };
      }
    | undefined;
  return message?.snapshot?.chips ?? [];
}

function values(...ids: string[]): () => string {
  let index = 0;
  return () => ids[index++] ?? `id-${index}`;
}
