import { describe, expect, it, vi } from "vitest";
import type {
  DesktopSnapshot,
  DraftRecord,
  MessageRecord,
  ProjectRecord,
  ProjectRef,
  RojoLease,
  StudioInspectorChildren,
  StudioInspectorProperties,
  StudioInspectorRequestIdentity,
  ThreadRecord,
} from "../shared/domain.js";
import type { DesktopCommand } from "../shared/protocol.js";
import { AppController, type AppControllerOptions } from "./app-controller.js";
import type { BindingSnapshot, StudioCatalogSnapshot } from "./runtime/binding-coordinator.js";

const projectA: ProjectRecord = Object.freeze({
  id: "project-a",
  displayName: "Arena",
  canonicalRoot: "/projects/arena",
  rootDevice: "1",
  rootInode: "10",
  canonicalProjectFile: "/projects/arena/default.project.json",
  projectFileDevice: "1",
  projectFileInode: "11",
  configDigest: "digest-a",
  servePlaceIds: Object.freeze([101]),
  createdAt: 1,
  updatedAt: 1,
  lastOpenedAt: 1,
});

const threadA: ThreadRecord = Object.freeze({
  id: "thread-a",
  projectId: "project-a",
  title: "New chat",
  createdAt: 1,
  updatedAt: 1,
});

const childrenResult: StudioInspectorChildren = Object.freeze({
  projectId: "project-a",
  instanceId: "studio-a",
  bindingRevision: 1,
  brokerEpoch: "epoch-a",
  observedAt: 12,
  instancePath: "game.Workspace",
  children: Object.freeze([
    Object.freeze({
      name: "Part",
      className: "Part",
      path: "game.Workspace.Part",
      hasChildren: false,
    }),
  ]),
});

const propertiesResult: StudioInspectorProperties = Object.freeze({
  projectId: "project-a",
  instanceId: "studio-a",
  bindingRevision: 1,
  brokerEpoch: "epoch-a",
  observedAt: 13,
  instancePath: "game.Workspace.Part",
  className: "Part",
  properties: Object.freeze([
    Object.freeze({
      name: "Anchored",
      category: "Behavior",
      value: "true",
      valueKind: "boolean",
    }),
  ]),
});

describe("AppController", () => {
  it("restores local state while every runtime starts needs-reconnect", async () => {
    const harness = controllerHarness();
    const snapshot = await harness.controller.initialize();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.runtimeByProject)).toBe(true);
    expect(snapshot.runtimeByProject["project-a"]).toMatchObject({ state: "needs-reconnect" });
    expect(snapshot.runtimeByProject["project-a"]?.activeProject).toEqual({
      revision: 1,
      canonicalProjectFile: "/projects/arena/default.project.json",
      relativeProjectFile: "default.project.json",
      configDigest: "digest-a",
    });
    expect(snapshot.runtimeByProject["project-a"]?.studioMcp).toEqual({
      serverVersion: "2.22.5",
    });
    expect(snapshot.settings.mcpPortChangeAllowed).toBe(true);
    expect(snapshot.runtimeByProject["project-a"]?.rojo).toBeUndefined();
    expect(snapshot.runtimeByProject["project-a"]?.studio).toBeUndefined();
  });

  it("restores a persisted project as needs-reconnect when its watcher cannot start", async () => {
    const harness = controllerHarness({ watcherStartFailure: true });

    await expect(harness.controller.initialize()).resolves.toMatchObject({
      projects: [expect.objectContaining({ id: "project-a" })],
      runtimeByProject: {
        "project-a": expect.objectContaining({ state: "needs-reconnect" }),
      },
    });
    await nextTurn();
    expect(harness.bindingProjectInvalidations).toEqual(["project-a:project-unreadable"]);
    await expect(harness.controller.dispose()).resolves.toBeUndefined();
  });

  it("stores exactly one local user prompt and clears only its draft", async () => {
    const harness = controllerHarness();
    const before = await harness.controller.initialize();
    const response = await harness.controller.execute(
      command("message.create", {
        projectId: "project-a",
        threadId: "thread-a",
        content: "Make the round loop clearer",
        expectedRevision: before.revision,
      }),
    );
    expect(response.ok).toBe(true);
    expect(Object.isFrozen(response.snapshot)).toBe(true);
    expect(harness.state.messages).toEqual([
      expect.objectContaining({ role: "user", content: "Make the round loop clearer", threadId: "thread-a" }),
    ]);
    expect(harness.state.drafts).toEqual([]);
    expect(harness.networkCalls).toEqual([]);
  });

  it("rejects a stale renderer revision before any side effect", async () => {
    const harness = controllerHarness();
    await harness.controller.initialize();
    const response = await harness.controller.execute(
      command("runtime.disconnect", {
        projectId: "project-a",
        expectedRevision: 99,
      }),
    );
    expect(response).toMatchObject({ ok: false, error: { code: "stale-command" } });
    expect(harness.runtimeDisconnects).toEqual([]);
  });

  it("rejects cross-project thread mutation before repository writes", async () => {
    const harness = controllerHarness({ includeSecondProject: true });
    const before = await harness.controller.initialize();
    const response = await harness.controller.execute(
      command("thread.rename", {
        projectId: "project-b",
        threadId: "thread-a",
        title: "Wrong owner",
        expectedRevision: before.revision,
      }),
    );
    expect(response).toMatchObject({ ok: false, error: { code: "thread-not-owned" } });
    expect(harness.renames).toEqual([]);
  });

  it.each(["draft.save", "message.create"] as const)(
    "rejects forged cross-project ownership for %s before any conversation write",
    async (type) => {
      const harness = controllerHarness({ includeSecondProject: true });
      const before = await harness.controller.initialize();
      const response = await harness.controller.execute(
        command(type, {
          projectId: "project-b",
          threadId: "thread-a",
          content: "forged",
          expectedRevision: before.revision,
        }),
      );
      expect(response).toMatchObject({ ok: false, error: { code: "thread-not-owned" } });
      expect(harness.state.messages).toEqual([]);
      expect(harness.state.drafts).toEqual([{ threadId: "thread-a", content: "draft", updatedAt: 2 }]);
    },
  );

  it("blocks a concurrent same-revision mutation before its native side effect", async () => {
    const picker = deferred<readonly string[]>();
    const harness = controllerHarness({ pickDirectories: () => picker.promise });
    const before = await harness.controller.initialize();
    const first = harness.controller.execute(command("project.add", { expectedRevision: before.revision }));
    await nextTurn();
    const second = await harness.controller.execute(
      command("settings.chooseRojo", {
        expectedRevision: before.revision,
      }),
    );
    expect(second).toMatchObject({ ok: false, error: { code: "operation-in-progress" } });
    expect(harness.pickFileCalls).toBe(0);
    picker.resolve([]);
    await first;
  });

  it("does not hold the transition queue while a native picker is open", async () => {
    const picker = deferred<readonly string[]>();
    const harness = controllerHarness({ pickDirectories: () => picker.promise });
    const before = await harness.controller.initialize();
    const pending = harness.controller.execute(command("project.add", { expectedRevision: before.revision }));
    await nextTurn();
    harness.emitProjectInvalidation("project-a");
    await nextTurn();
    expect(harness.events).toHaveLength(1);
    expect(harness.events[0]?.runtimeByProject["project-a"]?.state).toBe("needs-reconnect");
    picker.resolve([]);
    const response = await pending;
    expect(response).toMatchObject({ ok: false, error: { code: "operation-cancelled" } });
  });

  it("treats cancelAdd as opaque, idempotent, and snapshot-neutral", async () => {
    const harness = controllerHarness();
    const before = await harness.controller.initialize();
    const response = await harness.controller.execute(command("project.cancelAdd", { selectionId: "opaque" }));
    expect(response).toMatchObject({ ok: true, snapshot: { revision: before.revision } });
    expect(harness.events).toEqual([]);
    expect(harness.cancelledSelections).toEqual(["opaque"]);
  });

  it("exposes only opaque project candidates and commits the selected candidate", async () => {
    const addedProject = {
      ...projectA,
      id: "project-c",
      displayName: "Tycoon",
      canonicalRoot: "/projects/tycoon",
      canonicalProjectFile: "/projects/tycoon/game.project.json",
    };
    const harness = controllerHarness({
      pickDirectories: () => Promise.resolve(["/projects/tycoon"]),
      projectCandidates: {
        selectionId: "selection-opaque",
        candidateId: "candidate-opaque",
        project: addedProject,
      },
    });
    const before = await harness.controller.initialize();
    const candidates = await harness.controller.execute(command("project.add", { expectedRevision: before.revision }));
    expect(candidates).toMatchObject({
      ok: true,
      snapshot: { revision: before.revision },
      result: {
        kind: "project-candidates",
        selectionId: "selection-opaque",
        candidates: [{ candidateId: "candidate-opaque", relativeProjectFile: "game.project.json" }],
      },
    });
    expect(JSON.stringify(candidates.result)).not.toContain("/projects/tycoon");
    const committed = await harness.controller.execute(
      command("project.addCandidate", {
        selectionId: "selection-opaque",
        candidateId: "candidate-opaque",
        expectedRevision: before.revision,
      }),
    );
    expect(committed).toMatchObject({
      ok: true,
      snapshot: {
        projects: expect.arrayContaining([expect.objectContaining({ id: "project-c" })]),
        runtimeByProject: {
          "project-c": {
            state: "disconnected",
            activeProject: {
              canonicalProjectFile: "/projects/tycoon/game.project.json",
              relativeProjectFile: "game.project.json",
            },
          },
        },
      },
    });
  });

  it("selects projects and creates, selects, renames, drafts, and deletes owned local threads", async () => {
    const harness = controllerHarness({ includeSecondProject: true });
    let response = await harness.controller.initialize();
    const selected = await harness.controller.execute(
      command("project.select", {
        projectId: "project-b",
        expectedRevision: response.revision,
      }),
    );
    if (!selected.ok) throw new Error("fixture selection failed");
    response = selected.snapshot;
    const created = await harness.controller.execute(
      command("thread.create", {
        projectId: "project-a",
        expectedRevision: response.revision,
      }),
    );
    if (!created.ok) throw new Error("fixture thread create failed");
    const newThread = created.snapshot.threads.find((thread) => thread.id === "thread-2");
    expect(newThread).toBeDefined();
    const focused = await harness.controller.execute(
      command("thread.select", {
        projectId: "project-a",
        threadId: "thread-2",
        expectedRevision: created.snapshot.revision,
      }),
    );
    if (!focused.ok) throw new Error("fixture thread select failed");
    const renamed = await harness.controller.execute(
      command("thread.rename", {
        projectId: "project-a",
        threadId: "thread-2",
        title: "Round loop",
        expectedRevision: focused.snapshot.revision,
      }),
    );
    if (!renamed.ok) throw new Error("fixture thread rename failed");
    const drafted = await harness.controller.execute(
      command("draft.save", {
        projectId: "project-a",
        threadId: "thread-2",
        content: "local only",
        expectedRevision: renamed.snapshot.revision,
      }),
    );
    if (!drafted.ok) throw new Error("fixture draft failed");
    expect(drafted.snapshot.drafts).toEqual(
      expect.arrayContaining([expect.objectContaining({ threadId: "thread-2", content: "local only" })]),
    );
    const deleted = await harness.controller.execute(
      command("thread.delete", {
        projectId: "project-a",
        threadId: "thread-2",
        expectedRevision: drafted.snapshot.revision,
      }),
    );
    expect(deleted).toMatchObject({ ok: true });
    expect(deleted.snapshot.threads.some((thread) => thread.id === "thread-2")).toBe(false);
  });

  it("requires the exact chosen Rojo file to resolve as configured", async () => {
    const harness = controllerHarness({
      pickFiles: () => Promise.resolve(["/chosen/rojo"]),
      resolveRojo: async (configuredPath) => ({
        path: configuredPath === undefined ? "/usr/local/bin/rojo" : "/usr/local/bin/rojo",
        version: "7.7.1",
        source: "usr-local",
      }),
    });
    const before = await harness.controller.initialize();
    const response = await harness.controller.execute(
      command("settings.chooseRojo", {
        expectedRevision: before.revision,
      }),
    );
    expect(response).toMatchObject({ ok: false, error: { code: "rojo-choice-mismatch" } });
    expect(harness.rojoPathWrites).toEqual([]);
  });

  it("returns an explicit neutral result when the Rojo picker is canceled", async () => {
    const harness = controllerHarness({
      pickFiles: () => Promise.resolve([]),
    });
    const before = await harness.controller.initialize();
    const response = await harness.controller.execute(
      command("settings.chooseRojo", {
        expectedRevision: before.revision,
      }),
    );

    expect(response).toMatchObject({
      ok: true,
      snapshot: { revision: before.revision },
      result: { kind: "rojo-choice", changed: false },
    });
    expect(harness.rojoPathWrites).toEqual([]);
  });

  it("connects through plugin, Rojo, broker, polling, and explicit catalog without auto-selection", async () => {
    const harness = controllerHarness({ projectBlindCatalog: true });
    const before = await harness.controller.initialize();
    const response = await harness.controller.execute(
      command("runtime.connect", {
        projectId: "project-a",
        expectedRevision: before.revision,
      }),
    );
    expect(response).toMatchObject({
      ok: true,
      snapshot: {
        runtimeByProject: {
          "project-a": {
            state: "studio-selection-required",
            rojo: { port: 34872, generation: 1 },
            catalog: [expect.objectContaining({ instanceId: "studio-a", eligible: true })],
          },
        },
      },
    });
    expect(harness.sequence).toEqual([
      "recapture",
      "resolve-rojo",
      "inspect-plugin",
      "rojo-connect",
      "broker-retain",
      "poll-acquire",
      "catalog-refresh",
      "watcher-dispose",
    ]);
    expect(harness.projectContextUpdates.at(-1)).toMatchObject({
      project: { projectId: "project-a", revision: 2 },
      servePlaceIds: [101],
    });
    expect(harness.events).toHaveLength(1);
    expect(harness.selectStudioCalls).toEqual([]);
  });

  it("serializes same-place catalog ambiguity without leaking warning metadata into ineligible rows", async () => {
    const harness = controllerHarness({
      bindingStateAfterRefresh: "catalog-ambiguous",
      preserveCatalogProjection: true,
      catalogInstances: [
        catalogRow("studio-a", 101, {
          eligible: false,
          eligibilityReason: "catalog-ambiguous",
          warningRequired: false,
        }),
        catalogRow("studio-b", 101, {
          eligible: false,
          eligibilityReason: "catalog-ambiguous",
          warningRequired: false,
        }),
      ],
    });
    const before = await harness.controller.initialize();
    const response = await harness.controller.execute(
      command("runtime.connect", {
        projectId: "project-a",
        expectedRevision: before.revision,
      }),
    );

    expect(response.ok).toBe(true);
    expect(response.snapshot.runtimeByProject["project-a"]).toMatchObject({
      state: "catalog-ambiguous",
      catalog: [
        {
          instanceId: "studio-a",
          eligible: false,
          eligibilityReason: "catalog-ambiguous",
          warningRequired: false,
        },
        {
          instanceId: "studio-b",
          eligible: false,
          eligibilityReason: "catalog-ambiguous",
          warningRequired: false,
        },
      ],
    });
    expect(
      response.snapshot.runtimeByProject["project-a"]?.catalog.every(
        (catalogEntry) => catalogEntry.warningKind === undefined,
      ),
    ).toBe(true);
  });

  it("projects the recaptured active digest even while the persisted project row still has the old digest", async () => {
    const harness = controllerHarness({ recapturedDigest: "digest-b" });
    const before = await harness.controller.initialize();
    expect(before.projects[0]?.configDigest).toBe("digest-a");

    const response = await harness.controller.execute(
      command("runtime.connect", {
        projectId: "project-a",
        expectedRevision: before.revision,
      }),
    );

    expect(response).toMatchObject({
      ok: true,
      snapshot: {
        projects: [expect.objectContaining({ id: "project-a", configDigest: "digest-a" })],
        runtimeByProject: {
          "project-a": {
            activeProject: {
              revision: 2,
              canonicalProjectFile: "/projects/arena/default.project.json",
              relativeProjectFile: "default.project.json",
              configDigest: "digest-b",
            },
          },
        },
      },
    });
  });

  it("fans one global refresh into distinct project-specific catalog projections", async () => {
    const harness = controllerHarness({
      includeSecondProject: true,
      projectBlindCatalog: true,
      catalogInstances: [catalogRow("studio-a", 101), catalogRow("studio-b", 202)],
    });
    const initial = await harness.controller.initialize();
    const connectedA = await harness.controller.execute(
      command("runtime.connect", { projectId: "project-a", expectedRevision: initial.revision }),
    );
    if (!connectedA.ok) throw new Error("fixture connect A failed");
    const connectedB = await harness.controller.execute(
      command("runtime.connect", { projectId: "project-b", expectedRevision: connectedA.snapshot.revision }),
    );
    if (!connectedB.ok) throw new Error("fixture connect B failed");

    expect(connectedB.snapshot.runtimeByProject["project-a"]?.catalog).toEqual([
      expect.objectContaining({ instanceId: "studio-a", eligible: true }),
      expect.objectContaining({ instanceId: "studio-b", eligible: false, eligibilityReason: "project-mismatch" }),
    ]);
    expect(connectedB.snapshot.runtimeByProject["project-b"]?.catalog).toEqual([
      expect.objectContaining({ instanceId: "studio-a", eligible: false, eligibilityReason: "project-mismatch" }),
      expect.objectContaining({ instanceId: "studio-b", eligible: true }),
    ]);
  });

  it("manual refresh captures a coalesced background change for every polling project exactly once", async () => {
    const harness = controllerHarness({
      includeSecondProject: true,
      projectBlindCatalog: true,
      catalogInstances: [catalogRow("studio-a", 101), catalogRow("studio-b", 202)],
    });
    const initial = await harness.controller.initialize();
    const connectedA = await harness.controller.execute(
      command("runtime.connect", { projectId: "project-a", expectedRevision: initial.revision }),
    );
    if (!connectedA.ok) throw new Error("fixture connect A failed");
    const connectedB = await harness.controller.execute(
      command("runtime.connect", { projectId: "project-b", expectedRevision: connectedA.snapshot.revision }),
    );
    if (!connectedB.ok) throw new Error("fixture connect B failed");
    const barrier = deferred<undefined>();
    harness.setCatalogBarrier(barrier.promise);
    harness.events.length = 0;
    const refreshing = harness.controller.execute(
      command("runtime.refresh", { projectId: "project-a", expectedRevision: connectedB.snapshot.revision }),
    );
    await waitUntil(() => harness.sequence.at(-1) === "catalog-refresh");
    harness.emitBindingChange([
      catalogRow("studio-a", 101, { lastActivity: 12 }),
      catalogRow("studio-b", 202, { lastActivity: 13 }),
    ]);
    barrier.resolve(undefined);

    const refreshed = await refreshing;
    expect(refreshed.ok).toBe(true);
    expect(harness.events).toHaveLength(1);
    expect(harness.events[0]?.runtimeByProject["project-a"]?.catalog[0]).toMatchObject({
      instanceId: "studio-a",
      eligible: true,
      lastActivity: 12,
    });
    expect(harness.events[0]?.runtimeByProject["project-b"]?.catalog[1]).toMatchObject({
      instanceId: "studio-b",
      eligible: true,
      lastActivity: 13,
    });
  });

  it("reconciles other polling projects when the project that suppressed a global refresh is invalidated", async () => {
    const harness = controllerHarness({
      includeSecondProject: true,
      projectBlindCatalog: true,
      catalogInstances: [catalogRow("studio-a", 101), catalogRow("studio-b", 202)],
    });
    const initial = await harness.controller.initialize();
    const connectedA = await harness.controller.execute(
      command("runtime.connect", { projectId: "project-a", expectedRevision: initial.revision }),
    );
    if (!connectedA.ok) throw new Error("fixture connect A failed");
    const connectedB = await harness.controller.execute(
      command("runtime.connect", { projectId: "project-b", expectedRevision: connectedA.snapshot.revision }),
    );
    if (!connectedB.ok) throw new Error("fixture connect B failed");
    const barrier = deferred<undefined>();
    harness.setCatalogBarrier(barrier.promise);
    harness.events.length = 0;
    const refreshing = harness.controller.execute(
      command("runtime.refresh", { projectId: "project-a", expectedRevision: connectedB.snapshot.revision }),
    );
    await waitUntil(() => harness.sequence.at(-1) === "catalog-refresh");
    harness.emitBindingChange([
      catalogRow("studio-a", 101, { lastActivity: 12 }),
      catalogRow("studio-b", 202, { lastActivity: 13 }),
    ]);
    harness.emitBindingInvalidation("project-a", "binding-drift");
    await waitUntil(() => harness.events.length === 1);
    barrier.resolve(undefined);

    const response = await refreshing;
    expect(response.ok).toBe(false);
    expect(harness.events).toHaveLength(2);
    expect(harness.events[1]?.runtimeByProject["project-b"]?.catalog[1]).toMatchObject({
      instanceId: "studio-b",
      eligible: true,
      lastActivity: 13,
    });
  });

  it("reuses an already retained project runtime without double-retaining", async () => {
    const harness = controllerHarness();
    const first = await harness.controller.initialize();
    const connected = await harness.controller.execute(
      command("runtime.connect", {
        projectId: "project-a",
        expectedRevision: first.revision,
      }),
    );
    if (!connected.ok) throw new Error("fixture connect failed");
    const again = await harness.controller.execute(
      command("runtime.connect", {
        projectId: "project-a",
        expectedRevision: connected.snapshot.revision,
      }),
    );
    expect(again.ok).toBe(true);
    expect(harness.brokerRetains).toBe(1);
    expect(harness.pollAcquires).toBe(1);
  });

  it("publishes successful background catalog changes without a renderer refresh command", async () => {
    const harness = controllerHarness();
    const initial = await harness.controller.initialize();
    const connected = await harness.controller.execute(
      command("runtime.connect", { projectId: "project-a", expectedRevision: initial.revision }),
    );
    if (!connected.ok) throw new Error("fixture connect failed");
    harness.events.length = 0;
    harness.emitBindingChange([
      harness.catalog.instances[0]!,
      { ...harness.catalog.instances[0]!, instanceId: "studio-b", dataModelName: "Arena copy" },
    ]);
    await waitUntil(() => harness.events.length === 1);
    expect(harness.events[0]?.runtimeByProject["project-a"]?.catalog.map((row) => row.instanceId)).toEqual([
      "studio-a",
      "studio-b",
    ]);

    harness.events.length = 0;
    harness.emitBindingChange([{ ...harness.catalog.instances[0]!, lastActivity: 11 }]);
    await waitUntil(() => harness.events.length === 1);
    expect(harness.events[0]?.runtimeByProject["project-a"]?.catalog[0]?.lastActivity).toBe(11);

    await harness.controller.dispose();
    const eventCount = harness.events.length;
    harness.emitBindingChange([{ ...harness.catalog.instances[0]!, lastActivity: 12 }]);
    await nextTurn();
    expect(harness.events).toHaveLength(eventCount);
  });

  it.each(["waiting-for-studio", "catalog-ambiguous", "project-mismatch", "needs-reconnect"] as const)(
    "preserves the coordinator %s state in desktop snapshots",
    async (state) => {
      const harness = controllerHarness();
      const initial = await harness.controller.initialize();
      const connected = await harness.controller.execute(
        command("runtime.connect", { projectId: "project-a", expectedRevision: initial.revision }),
      );
      if (!connected.ok) throw new Error("fixture connect failed");
      harness.setBindingState(state);
      harness.emitBindingChange(harness.catalog.instances);
      await waitUntil(() => harness.events.at(-1)?.revision === connected.snapshot.revision + 1);
      expect(harness.events.at(-1)?.runtimeByProject["project-a"]?.state).toBe(state);
    },
  );

  it("rolls back only resources newly acquired by a failed connect", async () => {
    const harness = controllerHarness({ catalogFailure: true });
    const before = await harness.controller.initialize();
    const response = await harness.controller.execute(
      command("runtime.connect", {
        projectId: "project-a",
        expectedRevision: before.revision,
      }),
    );
    expect(response).toMatchObject({
      ok: false,
      snapshot: {
        revision: before.revision + 1,
        runtimeByProject: {
          "project-a": {
            state: "error",
            detail: "The desktop operation could not be completed.",
            error: {
              layer: "app",
              code: "operation-failed",
              message: "The desktop operation could not be completed.",
            },
          },
        },
      },
    });
    expect(harness.sequence.slice(-3)).toEqual(["poll-release", "broker-release", "rojo-disconnect"]);
    expect(harness.events).toEqual([response.snapshot]);
  });

  it("projects a retained failed-cleanup lease as globally blocking MCP port changes", async () => {
    const harness = controllerHarness({
      brokerReleaseFailure: true,
      catalogFailure: true,
    });
    const before = await harness.controller.initialize();
    const response = await harness.controller.execute(
      command("runtime.connect", {
        projectId: "project-a",
        expectedRevision: before.revision,
      }),
    );

    expect(response).toMatchObject({
      ok: false,
      snapshot: {
        settings: { mcpPortChangeAllowed: false },
      },
    });
    expect(response.snapshot.runtimeByProject["project-a"]?.broker).toBeUndefined();
  });

  it("rejects a direct MCP port change while a failed-cleanup broker lease remains retained", async () => {
    const harness = controllerHarness({
      brokerReleaseFailure: true,
      catalogFailure: true,
    });
    const before = await harness.controller.initialize();
    const failedConnect = await harness.controller.execute(
      command("runtime.connect", {
        projectId: "project-a",
        expectedRevision: before.revision,
      }),
    );

    expect(failedConnect).toMatchObject({
      ok: false,
      snapshot: { settings: { mcpPortChangeAllowed: false } },
    });
    const response = await harness.controller.execute(
      command("settings.mcpPort", {
        port: 60000,
        expectedRevision: failedConnect.snapshot.revision,
      }),
    );

    expect(response).toMatchObject({ ok: false, error: { code: "broker-active" } });
    expect(harness.portWrites).toEqual([]);
    expect(harness.brokerSwaps).toEqual([]);
    expect(harness.preferredMcpPort).toBe(58741);
    expect(harness.providerMcpPort).toBe(58741);
  });

  it("late connect cleanup after invalidation releases only resources acquired by that token", async () => {
    const catalog = deferred<undefined>();
    const harness = controllerHarness({ catalogBarrier: catalog.promise });
    const before = await harness.controller.initialize();
    const pending = harness.controller.execute(
      command("runtime.connect", {
        projectId: "project-a",
        expectedRevision: before.revision,
      }),
    );
    await waitUntil(() => harness.sequence.includes("catalog-refresh"));
    harness.emitProjectInvalidation("project-a");
    catalog.resolve(undefined);
    const response = await pending;
    expect(response).toMatchObject({ ok: false, error: { code: "operation-cancelled" } });
    expect(harness.sequence.slice(-3)).toEqual(["poll-release", "broker-release", "rojo-disconnect"]);
  });

  it.each(["project", "binding"] as const)(
    "fully recaptures and replaces stale runtime resources after %s invalidation",
    async (source) => {
      const harness = controllerHarness();
      const initial = await harness.controller.initialize();
      const connected = await harness.controller.execute(
        command("runtime.connect", { projectId: "project-a", expectedRevision: initial.revision }),
      );
      if (!connected.ok) throw new Error("fixture connect failed");
      if (source === "project") harness.emitProjectInvalidation("project-a");
      else harness.emitBindingInvalidation("project-a", "binding-drift");
      await waitUntil(() => harness.events.at(-1)?.revision === connected.snapshot.revision + 1);
      const invalidated = harness.events.at(-1)!;
      harness.sequence.length = 0;

      const reconnected = await harness.controller.execute(
        command("runtime.connect", {
          projectId: "project-a",
          expectedRevision: invalidated.revision,
        }),
      );

      expect(reconnected.ok).toBe(true);
      expect(harness.sequence.filter((item) => item === "recapture")).toHaveLength(1);
      expect(harness.sequence.indexOf("rojo-disconnect")).toBeLessThan(harness.sequence.indexOf("rojo-connect"));
      if (!reconnected.ok) throw new Error("fixture reconnect failed");
      harness.emitProjectInvalidation("project-a");
      await waitUntil(() => harness.events.at(-1)?.revision === reconnected.snapshot.revision + 1);
      expect(harness.events.at(-1)?.runtimeByProject["project-a"]?.state).toBe("needs-reconnect");
    },
  );

  it("drops broker-derived catalogs immediately and replaces the stale Rojo process after broker exit", async () => {
    const harness = controllerHarness();
    const initial = await harness.controller.initialize();
    const connected = await harness.controller.execute(
      command("runtime.connect", { projectId: "project-a", expectedRevision: initial.revision }),
    );
    if (!connected.ok) throw new Error("fixture connect failed");
    harness.emitBrokerExit();
    await waitUntil(() => harness.events.at(-1)?.revision === connected.snapshot.revision + 1);
    const invalidated = harness.events.at(-1)!;
    expect(invalidated.runtimeByProject["project-a"]?.catalog).toEqual([]);
    harness.sequence.length = 0;

    const reconnected = await harness.controller.execute(
      command("runtime.connect", { projectId: "project-a", expectedRevision: invalidated.revision }),
    );

    expect(reconnected.ok).toBe(true);
    expect(harness.sequence.indexOf("rojo-disconnect")).toBeLessThan(harness.sequence.indexOf("rojo-connect"));
  });

  it.each([
    ["recapture", "resolve-rojo"],
    ["resolve-rojo", "inspect-plugin"],
    ["inspect-plugin", "rojo-connect"],
    ["rojo-connect", "context-update"],
    ["context-update", "broker-retain"],
    ["broker-retain", "poll-acquire"],
    ["poll-acquire", "catalog-refresh"],
    ["catalog-refresh", "watcher-create"],
    ["watcher-create", "old-watcher-dispose"],
    ["watcher-dispose", undefined],
  ] as const)("stops connect acquisition after cancellation at %s", async (invalidateAt, forbiddenNext) => {
    const harness = controllerHarness({ invalidateAt });
    const initial = await harness.controller.initialize();

    const response = await harness.controller.execute(
      command("runtime.connect", { projectId: "project-a", expectedRevision: initial.revision }),
    );

    expect(response).toMatchObject({ ok: false, error: { code: "operation-cancelled" } });
    const boundary = harness.sequence.indexOf(invalidateAt);
    expect(boundary).toBeGreaterThanOrEqual(0);
    if (forbiddenNext !== undefined) expect(harness.sequence.slice(boundary + 1)).not.toContain(forbiddenNext);
    if (invalidateAt === "context-update") {
      expect(harness.projectContextUpdates.at(-1)?.project.revision).toBe(1);
    }
    if (invalidateAt === "watcher-dispose") {
      const invalidationEvents = harness.events.length;
      harness.emitProjectInvalidation("project-a");
      await waitUntil(() => harness.events.length === invalidationEvents + 1);
    }
  });

  it("publishes exactly one reconciled recovery revision when cancelled connect rollback fails", async () => {
    const harness = controllerHarness({ invalidateAt: "broker-retain", brokerReleaseFailure: true });
    const initial = await harness.controller.initialize();

    const response = await harness.controller.execute(
      command("runtime.connect", { projectId: "project-a", expectedRevision: initial.revision }),
    );

    expect(response.ok).toBe(false);
    expect(harness.events).toHaveLength(2);
    expect(harness.events[0]?.runtimeByProject["project-a"]?.state).toBe("needs-reconnect");
    expect(harness.events[1]?.runtimeByProject["project-a"]?.state).toBe("needs-reconnect");
    expect(response.snapshot.revision).toBe(harness.events[1]?.revision);
  });

  it.each([
    ["watcher", ["poll-release", "broker-release", "rojo-disconnect"]],
    ["polling", ["broker-release", "rojo-disconnect"]],
    ["broker", ["rojo-disconnect"]],
    ["rojo", []],
  ] as const)("continues cancelled connect cleanup after a synchronous %s throw", async (failure, later) => {
    const harness = controllerHarness({
      invalidateAt: "watcher-create",
      synchronousCommandCleanupFailures: new Set([failure]),
    });
    const initial = await harness.controller.initialize();

    const response = await harness.controller.execute(
      command("runtime.connect", { projectId: "project-a", expectedRevision: initial.revision }),
    );

    expect(response.ok).toBe(false);
    for (const stage of later) expect(harness.sequence).toContain(stage);
    expect(harness.events).toHaveLength(2);
  });

  it("disconnect invalidates binding before final broker release and stops only that project", async () => {
    const harness = controllerHarness();
    const before = await harness.controller.initialize();
    const connected = await harness.controller.execute(
      command("runtime.connect", {
        projectId: "project-a",
        expectedRevision: before.revision,
      }),
    );
    if (!connected.ok) throw new Error("fixture connect failed");
    harness.sequence.length = 0;
    const response = await harness.controller.execute(
      command("runtime.disconnect", {
        projectId: "project-a",
        expectedRevision: connected.snapshot.revision,
      }),
    );
    expect(response.ok).toBe(true);
    expect(harness.sequence).toEqual([
      "binding-release:project-a",
      "poll-release",
      "binding-invalidate-all:disconnect",
      "broker-release",
      "rojo-disconnect",
      "watcher-dispose",
    ]);
    expect(harness.runtimeDisconnects).toEqual(["project-a"]);
  });

  it("publishes one recovery snapshot when disconnect changed state but cleanup failed", async () => {
    const harness = controllerHarness({ brokerReleaseFailure: true });
    const initial = await harness.controller.initialize();
    const connected = await harness.controller.execute(
      command("runtime.connect", {
        projectId: "project-a",
        expectedRevision: initial.revision,
      }),
    );
    if (!connected.ok) throw new Error("fixture connect failed");
    harness.events.length = 0;
    const failed = await harness.controller.execute(
      command("runtime.disconnect", {
        projectId: "project-a",
        expectedRevision: connected.snapshot.revision,
      }),
    );
    expect(failed).toMatchObject({ ok: false, snapshot: { revision: connected.snapshot.revision + 1 } });
    expect(harness.events).toHaveLength(1);
  });

  it.each([
    ["binding", ["poll-release", "broker-release", "rojo-disconnect", "watcher-dispose"]],
    ["polling", ["broker-release", "rojo-disconnect", "watcher-dispose"]],
    ["broker", ["rojo-disconnect", "watcher-dispose"]],
    ["rojo", ["watcher-dispose"]],
    ["watcher", []],
  ] as const)("continues disconnect cleanup after a synchronous %s throw", async (failure, later) => {
    const failures = new Set<"binding" | "polling" | "broker" | "rojo" | "watcher">();
    const harness = controllerHarness({ synchronousCommandCleanupFailures: failures });
    const initial = await harness.controller.initialize();
    const connected = await harness.controller.execute(
      command("runtime.connect", { projectId: "project-a", expectedRevision: initial.revision }),
    );
    if (!connected.ok) throw new Error("fixture connect failed");
    failures.add(failure);
    harness.sequence.length = 0;
    harness.events.length = 0;

    const response = await harness.controller.execute(
      command("runtime.disconnect", { projectId: "project-a", expectedRevision: connected.snapshot.revision }),
    );

    expect(response.ok).toBe(false);
    for (const stage of later) expect(harness.sequence).toContain(stage);
    expect(harness.events).toHaveLength(1);
  });

  it("unexpected broker exit invalidates all bindings once and discards stale leases", async () => {
    const harness = controllerHarness();
    const initial = await harness.controller.initialize();
    const connected = await harness.controller.execute(
      command("runtime.connect", {
        projectId: "project-a",
        expectedRevision: initial.revision,
      }),
    );
    if (!connected.ok) throw new Error("fixture connect failed");
    harness.events.length = 0;
    harness.emitBrokerExit();
    await nextTurn();
    expect(harness.bindingInvalidations).toEqual(["broker-exit"]);
    expect(harness.events).toHaveLength(1);
    expect(harness.brokerReleases).toBe(0);
    expect(harness.events[0]?.runtimeByProject["project-a"]?.state).toBe("needs-reconnect");
  });

  it("project runtime invalidation affects only that project", async () => {
    const harness = controllerHarness({ includeSecondProject: true });
    await harness.controller.initialize();
    harness.emitRuntimeInvalidation("project-a");
    await nextTurn();
    expect(harness.bindingProjectInvalidations).toEqual(["project-a:rojo-exit"]);
    expect(harness.events[0]?.runtimeByProject["project-b"]?.state).toBe("needs-reconnect");
  });

  it("swaps an idle broker port without recreating the coordinator or regressing catalog revisions", async () => {
    const harness = controllerHarness();
    const before = await harness.controller.initialize();
    harness.catalogRevision = 8;
    const response = await harness.controller.execute(
      command("settings.mcpPort", {
        port: 60000,
        expectedRevision: before.revision,
      }),
    );
    expect(response).toMatchObject({ ok: true, snapshot: { settings: { preferredMcpPort: 60000 } } });
    expect(harness.portWrites).toEqual([60000]);
    expect(harness.brokerSwaps).toEqual([60000]);
    expect(harness.coordinatorIdentityReads).toBeGreaterThan(0);
    expect(harness.catalogRevision).toBe(8);
  });

  it("rejects an active broker port change before persistence", async () => {
    const harness = controllerHarness({ brokerReferenceCount: 1 });
    const before = await harness.controller.initialize();
    const response = await harness.controller.execute(
      command("settings.mcpPort", {
        port: 60000,
        expectedRevision: before.revision,
      }),
    );
    expect(response).toMatchObject({ ok: false, error: { code: "broker-active" } });
    expect(harness.portWrites).toEqual([]);
    expect(harness.brokerSwaps).toEqual([]);
  });

  it("rolls back a staged broker replacement when its token is invalidated", async () => {
    const prepare = deferred<undefined>();
    const harness = controllerHarness({ brokerPrepareBarrier: prepare.promise });
    const initial = await harness.controller.initialize();
    const changing = harness.controller.execute(
      command("settings.mcpPort", { port: 62000, expectedRevision: initial.revision }),
    );
    await waitUntil(() => harness.sequence.includes("broker-prepare:62000"));
    harness.emitBrokerExit();
    prepare.resolve(undefined);

    await expect(changing).resolves.toMatchObject({ ok: false, error: { code: "operation-cancelled" } });
    expect(harness.preferredMcpPort).toBe(58741);
    expect(harness.providerMcpPort).toBe(58741);
    expect(harness.sequence).toContain("broker-rollback");
  });

  it("restores the old broker and setting when replacement fails after switching providers", async () => {
    const harness = controllerHarness({ brokerCommitFailureAfterSwitch: true });
    const initial = await harness.controller.initialize();

    const response = await harness.controller.execute(
      command("settings.mcpPort", { port: 62000, expectedRevision: initial.revision }),
    );

    expect(response.ok).toBe(false);
    expect(harness.preferredMcpPort).toBe(58741);
    expect(harness.providerMcpPort).toBe(58741);
    expect(harness.portWrites).not.toContain(62000);
    expect(harness.sequence).toContain("broker-rollback");
  });

  it("rolls the provider back when durable MCP port persistence fails", async () => {
    const harness = controllerHarness({ settingsPortFailure: 62000 });
    const initial = await harness.controller.initialize();

    const response = await harness.controller.execute(
      command("settings.mcpPort", { port: 62000, expectedRevision: initial.revision }),
    );

    expect(response.ok).toBe(false);
    expect(harness.preferredMcpPort).toBe(58741);
    expect(harness.providerMcpPort).toBe(58741);
    expect(harness.sequence).toContain("broker-rollback");
  });

  it("reconciles settings to the live provider with one recovery revision when port rollback fails", async () => {
    const harness = controllerHarness({
      brokerCommitFailureAfterSwitch: true,
      brokerRollbackFailure: true,
    });
    const initial = await harness.controller.initialize();

    const response = await harness.controller.execute(
      command("settings.mcpPort", { port: 62000, expectedRevision: initial.revision }),
    );

    expect(response.ok).toBe(false);
    expect(harness.providerMcpPort).toBe(62000);
    expect(harness.preferredMcpPort).toBe(62000);
    expect(harness.events).toHaveLength(1);
    expect(response.snapshot.revision).toBe(initial.revision + 1);
  });

  it("copies only controller-derived addresses and never the broker token", async () => {
    const harness = controllerHarness();
    const initial = await harness.controller.initialize();
    const connected = await harness.controller.execute(
      command("runtime.connect", {
        projectId: "project-a",
        expectedRevision: initial.revision,
      }),
    );
    if (!connected.ok) throw new Error("fixture connect failed");
    await harness.controller.execute(command("runtime.copyMcpUrl", { projectId: "project-a" }));
    await harness.controller.execute(command("runtime.copyRojoAddress", { projectId: "project-a" }));
    await harness.controller.execute(command("project.copyFile", { projectId: "project-a" }));
    expect(harness.clipboardWrites).toEqual([
      "http://127.0.0.1:58741",
      "127.0.0.1:34872",
      "/projects/arena/default.project.json",
    ]);
    expect(harness.clipboardWrites.join(" ")).not.toContain("super-secret");
  });

  it("selects Studio only from current protocol identities and confirms handoff explicitly", async () => {
    const harness = controllerHarness({ projectBlindCatalog: true });
    const initial = await harness.controller.initialize();
    const connected = await harness.controller.execute(
      command("runtime.connect", {
        projectId: "project-a",
        expectedRevision: initial.revision,
      }),
    );
    if (!connected.ok) throw new Error("fixture connect failed");
    const selected = await harness.controller.execute(
      command("runtime.selectStudio", {
        projectId: "project-a",
        instanceId: "studio-a",
        catalogRevision: 1,
        warningAccepted: false,
        expectedRevision: connected.snapshot.revision,
      }),
    );
    expect(selected).toMatchObject({
      ok: true,
      snapshot: {
        runtimeByProject: {
          "project-a": {
            state: "rojo-server-ready",
            pending: {
              instanceId: "studio-a",
              catalogRevision: 1,
              bindingRevision: 1,
              rojoHandoffRequired: true,
            },
          },
        },
      },
    });
    if (!selected.ok) throw new Error("fixture select failed");
    const bound = await harness.controller.execute(
      command("runtime.confirmRojoHandoff", {
        projectId: "project-a",
        bindingRevision: 1,
        expectedRevision: selected.snapshot.revision,
      }),
    );
    expect(bound).toMatchObject({
      ok: true,
      snapshot: { runtimeByProject: { "project-a": { state: "studio-bound" } } },
    });
  });

  it("returns one exact bound inspector children read without changing or publishing desktop state", async () => {
    const harness = controllerHarness({ projectBlindCatalog: true });
    const before = await bindStudio(harness);
    harness.events.length = 0;

    const response = await harness.controller.execute(
      command("studioInspector.children", {
        projectId: "project-a",
        instanceId: "studio-a",
        bindingRevision: 1,
        instancePath: "game.Workspace",
        expectedRevision: before.revision,
      }),
    );

    expect(response).toEqual({
      version: 1,
      requestId: "request-studioInspector.children",
      ok: true,
      snapshot: before,
      result: { kind: "studio-inspector-children", ...childrenResult },
    });
    expect(harness.inspectorChildren).toHaveBeenCalledOnce();
    expect(harness.inspectorChildren).toHaveBeenCalledWith({
      projectId: "project-a",
      instanceId: "studio-a",
      bindingRevision: 1,
      instancePath: "game.Workspace",
    });
    expect(harness.inspectorProperties).not.toHaveBeenCalled();
    expect(harness.events).toEqual([]);
  });

  it("returns one exact bound inspector properties read", async () => {
    const harness = controllerHarness({ projectBlindCatalog: true });
    const before = await bindStudio(harness);

    const response = await harness.controller.execute(
      command("studioInspector.properties", {
        projectId: "project-a",
        instanceId: "studio-a",
        bindingRevision: 1,
        instancePath: "game.Workspace.Part",
        expectedRevision: before.revision,
      }),
    );

    expect(response).toMatchObject({
      ok: true,
      snapshot: { revision: before.revision },
      result: { kind: "studio-inspector-properties", ...propertiesResult },
    });
    expect(harness.inspectorProperties).toHaveBeenCalledOnce();
    expect(harness.inspectorChildren).not.toHaveBeenCalled();
  });

  it("rejects a stale Studio inspector read before the service", async () => {
    const harness = controllerHarness({ projectBlindCatalog: true });
    await bindStudio(harness);

    const response = await harness.controller.execute(
      command("studioInspector.children", {
        projectId: "project-a",
        instanceId: "studio-a",
        bindingRevision: 1,
        instancePath: "game.Workspace",
        expectedRevision: 99,
      }),
    );

    expect(response).toMatchObject({ ok: false, error: { code: "stale-command" } });
    expect(harness.inspectorChildren).not.toHaveBeenCalled();
  });

  it("rejects a disconnected Studio inspector read before the service", async () => {
    const harness = controllerHarness();
    const before = await harness.controller.initialize();

    const response = await harness.controller.execute(
      command("studioInspector.children", {
        projectId: "project-a",
        instanceId: "studio-a",
        bindingRevision: 1,
        instancePath: "game.Workspace",
        expectedRevision: before.revision,
      }),
    );

    expect(response).toMatchObject({ ok: false, error: { code: "studio-inspector-not-bound" } });
    expect(harness.inspectorChildren).not.toHaveBeenCalled();
  });

  it.each([
    ["project mismatch", { projectId: "project-missing" }, {}],
    ["instance mismatch", { instanceId: "studio-b" }, {}],
    ["missing binding revision", {}, { omitBoundBindingRevision: true }],
    ["missing broker epoch", {}, { omitBrokerEpoch: true }],
  ] as const)("rejects a Studio inspector %s before the service", async (_label, commandPatch, harnessOptions) => {
    const harness = controllerHarness({ projectBlindCatalog: true, ...harnessOptions });
    const before = await bindStudio(harness);

    const response = await harness.controller.execute(
      command("studioInspector.children", {
        projectId: "project-a",
        instanceId: "studio-a",
        bindingRevision: 1,
        instancePath: "game.Workspace",
        expectedRevision: before.revision,
        ...commandPatch,
      }),
    );

    expect(response).toMatchObject({ ok: false });
    expect(harness.inspectorChildren).not.toHaveBeenCalled();
  });

  it("normalizes a Studio inspector service failure without raw payload or secret text", async () => {
    const harness = controllerHarness({
      projectBlindCatalog: true,
      inspectorChildren: async () => {
        throw Object.assign(new Error("token=studio-secret"), {
          rawPayload: { arguments: { instance_id: "studio-a", api_key: "raw-secret" } },
        });
      },
    });
    const before = await bindStudio(harness);

    const response = await harness.controller.execute(
      command("studioInspector.children", {
        projectId: "project-a",
        instanceId: "studio-a",
        bindingRevision: 1,
        instancePath: "game.Workspace",
        expectedRevision: before.revision,
      }),
    );

    expect(response).toMatchObject({
      ok: false,
      error: {
        layer: "studio",
        code: "operation-failed",
        message: "The Studio operation could not be completed.",
      },
    });
    expect(JSON.stringify(response)).not.toMatch(/studio-secret|raw-secret|rawPayload|api_key/);
  });

  it("rejects a Studio inspector result whose host identity does not match the visible runtime", async () => {
    const harness = controllerHarness({
      projectBlindCatalog: true,
      inspectorChildren: async () => ({
        ...childrenResult,
        projectId: "project-b",
        instanceId: "studio-b",
        bindingRevision: 99,
        brokerEpoch: "epoch-b",
      }),
    });
    const before = await bindStudio(harness);

    const response = await harness.controller.execute(
      command("studioInspector.children", {
        projectId: "project-a",
        instanceId: "studio-a",
        bindingRevision: 1,
        instancePath: "game.Workspace",
        expectedRevision: before.revision,
      }),
    );

    expect(response).toMatchObject({ ok: false, error: { code: "studio-inspector-identity-changed" } });
    expect(response).not.toHaveProperty("result");
  });

  it("rejects Studio inspector children returned for a different canonical path", async () => {
    const harness = controllerHarness({
      projectBlindCatalog: true,
      inspectorChildren: async () => ({
        ...childrenResult,
        instancePath: "game.ServerStorage",
      }),
    });
    const before = await bindStudio(harness);

    const response = await harness.controller.execute(
      command("studioInspector.children", {
        projectId: "project-a",
        instanceId: "studio-a",
        bindingRevision: 1,
        instancePath: "game.Workspace",
        expectedRevision: before.revision,
      }),
    );

    expect(response).toMatchObject({ ok: false, error: { code: "studio-inspector-identity-changed" } });
    expect(response).not.toHaveProperty("result");
  });

  it("rejects Studio inspector properties returned for a different canonical path", async () => {
    const harness = controllerHarness({
      projectBlindCatalog: true,
      inspectorProperties: async () => ({
        ...propertiesResult,
        instancePath: "game.ServerStorage.Part",
      }),
    });
    const before = await bindStudio(harness);

    const response = await harness.controller.execute(
      command("studioInspector.properties", {
        projectId: "project-a",
        instanceId: "studio-a",
        bindingRevision: 1,
        instancePath: "game.Workspace.Part",
        expectedRevision: before.revision,
      }),
    );

    expect(response).toMatchObject({ ok: false, error: { code: "studio-inspector-identity-changed" } });
    expect(response).not.toHaveProperty("result");
  });

  it("projects plugin results so internal inspector and backup paths never cross the boundary", async () => {
    const harness = controllerHarness();
    await harness.controller.initialize();
    const response = await harness.controller.execute(command("plugin.inspect", {}));
    expect(response).toMatchObject({ ok: true, result: { kind: "plugin-inspection" } });
    expect(JSON.stringify(response)).not.toContain("inspectorPath");
    expect(JSON.stringify(response)).not.toContain("backupPath");
  });

  it("installs the audited plugin and shows only the controller-derived plugins folder", async () => {
    const harness = controllerHarness();
    const before = await harness.controller.initialize();
    const installed = await harness.controller.execute(
      command("plugin.install", {
        confirmReplace: true,
        expectedRevision: before.revision,
      }),
    );
    expect(installed).toMatchObject({
      ok: true,
      result: { kind: "plugin-inspection", inspection: { state: "installed" } },
    });
    expect(JSON.stringify(installed)).not.toContain("backupPath");
    const shown = await harness.controller.execute(command("plugin.showFolder", {}));
    expect(shown.ok).toBe(true);
    expect(harness.shownFolders).toEqual(["/home/Documents/Roblox/Plugins"]);
  });

  it("persists an exact configured Rojo choice and refreshes retained runtime status", async () => {
    const harness = controllerHarness({
      pickFiles: () => Promise.resolve(["/chosen/rojo"]),
      resolveRojo: async (configuredPath) => ({
        path: configuredPath ?? "/chosen/rojo",
        version: "7.7.1",
        source: configuredPath === undefined ? "path" : "configured",
      }),
    });
    const initial = await harness.controller.initialize();
    const chosen = await harness.controller.execute(
      command("settings.chooseRojo", {
        expectedRevision: initial.revision,
      }),
    );
    expect(chosen.ok).toBe(true);
    expect(chosen).toMatchObject({ result: { kind: "rojo-choice", changed: true } });
    expect(harness.rojoPathWrites).toEqual(["/chosen/rojo"]);
    if (!chosen.ok) throw new Error("fixture choice failed");
    const connected = await harness.controller.execute(
      command("runtime.connect", {
        projectId: "project-a",
        expectedRevision: chosen.snapshot.revision,
      }),
    );
    if (!connected.ok) throw new Error("fixture connect failed");
    const refreshed = await harness.controller.execute(
      command("runtime.refresh", {
        projectId: "project-a",
        expectedRevision: connected.snapshot.revision,
      }),
    );
    expect(refreshed).toMatchObject({
      ok: true,
      snapshot: { runtimeByProject: { "project-a": { rojo: { port: 34872 } } } },
    });
  });

  it("removes local rows only after stopping exactly owned runtime resources", async () => {
    const harness = controllerHarness();
    const initial = await harness.controller.initialize();
    const connected = await harness.controller.execute(
      command("runtime.connect", {
        projectId: "project-a",
        expectedRevision: initial.revision,
      }),
    );
    if (!connected.ok) throw new Error("fixture connect failed");
    harness.sequence.length = 0;
    const removed = await harness.controller.execute(
      command("project.remove", {
        projectId: "project-a",
        expectedRevision: connected.snapshot.revision,
      }),
    );
    expect(removed.ok).toBe(true);
    expect(harness.sequence.at(-1)).toBe("project-row-remove");
    expect(harness.filesystemDeletes).toEqual([]);
  });

  it("never deletes project rows when removal is invalidated during asynchronous cleanup", async () => {
    const brokerRelease = deferred<undefined>();
    const harness = controllerHarness({ brokerReleaseBarrier: brokerRelease.promise });
    const initial = await harness.controller.initialize();
    const connected = await harness.controller.execute(
      command("runtime.connect", { projectId: "project-a", expectedRevision: initial.revision }),
    );
    if (!connected.ok) throw new Error("fixture connect failed");
    harness.sequence.length = 0;
    harness.events.length = 0;

    const removal = harness.controller.execute(
      command("project.remove", { projectId: "project-a", expectedRevision: connected.snapshot.revision }),
    );
    await waitUntil(() => harness.sequence.includes("broker-release"));
    harness.emitProjectInvalidation("project-a");
    await waitUntil(() => harness.events.length === 1);
    brokerRelease.resolve(undefined);

    const response = await removal;
    expect(response).toMatchObject({ ok: false, error: { code: "operation-cancelled" } });
    expect(harness.state.projects.map((project) => project.id)).toContain("project-a");
    expect(harness.state.threads.map((thread) => thread.id)).toContain("thread-a");
    expect(harness.state.drafts.map((draft) => draft.threadId)).toContain("thread-a");
    expect(harness.sequence).not.toContain("project-row-remove");
    expect(harness.events).toHaveLength(1);
  });

  it("preserves stale removal rows and continues cleanup after a synchronous Rojo throw", async () => {
    const brokerRelease = deferred<undefined>();
    const failures = new Set<"binding" | "polling" | "broker" | "rojo" | "watcher">();
    const harness = controllerHarness({
      brokerReleaseBarrier: brokerRelease.promise,
      synchronousCommandCleanupFailures: failures,
    });
    const initial = await harness.controller.initialize();
    const connected = await harness.controller.execute(
      command("runtime.connect", { projectId: "project-a", expectedRevision: initial.revision }),
    );
    if (!connected.ok) throw new Error("fixture connect failed");
    failures.add("rojo");
    harness.sequence.length = 0;
    harness.events.length = 0;
    const removal = harness.controller.execute(
      command("project.remove", { projectId: "project-a", expectedRevision: connected.snapshot.revision }),
    );
    await waitUntil(() => harness.sequence.includes("broker-release"));
    harness.emitProjectInvalidation("project-a");
    await waitUntil(() => harness.events.length === 1);
    brokerRelease.resolve(undefined);

    const response = await removal;
    expect(response.ok).toBe(false);
    expect(harness.sequence).toContain("watcher-dispose");
    expect(harness.sequence).not.toContain("project-row-remove");
    expect(harness.state.projects.map((project) => project.id)).toContain("project-a");
    expect(harness.state.threads.map((thread) => thread.id)).toContain("thread-a");
    expect(harness.events).toHaveLength(1);
  });

  it("disposes in ordered all-settled stages and rejects late publishes", async () => {
    const harness = controllerHarness({ watcherDisposeFailure: true, runtimeDisposeFailure: true });
    await harness.controller.initialize();
    await expect(harness.controller.dispose()).rejects.toBeDefined();
    expect(harness.sequence).toEqual([
      "binding-unsubscribe",
      "binding-change-unsubscribe",
      "runtime-unsubscribe",
      "broker-unsubscribe",
      "watcher-dispose",
      "binding-invalidate-all:dispose",
      "binding-dispose",
      "runtime-dispose",
      "broker-stop",
    ]);
    const count = harness.events.length;
    harness.emitBrokerExit();
    await nextTurn();
    expect(harness.events).toHaveLength(count);
  });

  it("attempts every disposal stage when each resource throws synchronously", async () => {
    const synchronousDisposeFailures = new Set<"watcher" | "binding" | "lease" | "runtime" | "broker">();
    const harness = controllerHarness({
      synchronousDisposeFailures,
    });
    const before = await harness.controller.initialize();
    const connected = await harness.controller.execute(
      command("runtime.connect", { projectId: "project-a", expectedRevision: before.revision }),
    );
    expect(connected.ok).toBe(true);
    for (const stage of ["watcher", "binding", "lease", "runtime", "broker"] as const) {
      synchronousDisposeFailures.add(stage);
    }
    harness.sequence.length = 0;

    await expect(harness.controller.dispose()).rejects.toBeInstanceOf(AggregateError);
    expect(harness.sequence).toEqual([
      "binding-unsubscribe",
      "binding-change-unsubscribe",
      "runtime-unsubscribe",
      "broker-unsubscribe",
      "watcher-dispose",
      "binding-invalidate-all:dispose",
      "binding-dispose",
      "poll-release",
      "broker-release",
      "runtime-dispose",
      "broker-stop",
    ]);
  });

  it("rejects every command after disposal without reaching a native or service side effect", async () => {
    const harness = controllerHarness();
    await harness.controller.initialize();
    await harness.controller.dispose();
    const response = await harness.controller.execute(command("project.cancelAdd", { selectionId: "late" }));
    expect(response).toMatchObject({ ok: false, error: { code: "app-disposed" } });
    expect(harness.cancelledSelections).toEqual([]);
  });

  it("waits for an in-flight split-phase connect to settle before disposing owned runtimes", async () => {
    const catalog = deferred<undefined>();
    const harness = controllerHarness({ catalogBarrier: catalog.promise });
    const before = await harness.controller.initialize();
    const connect = harness.controller.execute(
      command("runtime.connect", {
        projectId: "project-a",
        expectedRevision: before.revision,
      }),
    );
    await waitUntil(() => harness.sequence.includes("catalog-refresh"));
    let disposed = false;
    const disposal = harness.controller.dispose().then(
      () => {
        disposed = true;
      },
      () => {
        disposed = true;
      },
    );
    await nextTurn();
    expect(disposed).toBe(false);
    expect(harness.sequence).not.toContain("runtime-dispose");
    catalog.resolve(undefined);
    await Promise.allSettled([connect, disposal]);
    expect(harness.sequence.indexOf("rojo-disconnect")).toBeLessThan(harness.sequence.indexOf("runtime-dispose"));
  });
});

function command<T extends DesktopCommand["type"]>(
  type: T,
  body: Omit<Extract<DesktopCommand, { type: T }>, "type" | "version" | "requestId">,
): Extract<DesktopCommand, { type: T }> {
  return { version: 1, requestId: `request-${type}`, type, ...body } as Extract<DesktopCommand, { type: T }>;
}

interface HarnessOptions {
  readonly includeSecondProject?: boolean;
  readonly pickDirectories?: () => Promise<readonly string[]>;
  readonly pickFiles?: () => Promise<readonly string[]>;
  readonly resolveRojo?: (configuredPath?: string) => Promise<{ path: string; version: string; source: string }>;
  readonly catalogFailure?: boolean;
  readonly catalogBarrier?: Promise<void>;
  readonly catalogInstances?: readonly StudioCatalogSnapshot["instances"][number][];
  readonly bindingStateAfterRefresh?: "catalog-ambiguous";
  readonly preserveCatalogProjection?: boolean;
  readonly projectBlindCatalog?: boolean;
  readonly brokerReleaseFailure?: boolean;
  readonly brokerReleaseBarrier?: Promise<void>;
  readonly brokerReferenceCount?: number;
  readonly brokerPrepareBarrier?: Promise<void>;
  readonly brokerCommitFailureAfterSwitch?: boolean;
  readonly brokerRollbackFailure?: boolean;
  readonly settingsPortFailure?: number;
  readonly recapturedDigest?: string;
  readonly watcherStartFailure?: boolean;
  readonly watcherDisposeFailure?: boolean;
  readonly runtimeDisposeFailure?: boolean;
  readonly omitBoundBindingRevision?: boolean;
  readonly omitBrokerEpoch?: boolean;
  readonly inspectorChildren?: (
    input: StudioInspectorRequestIdentity & { readonly instancePath: string },
  ) => Promise<StudioInspectorChildren>;
  readonly inspectorProperties?: (
    input: StudioInspectorRequestIdentity & { readonly instancePath: string },
  ) => Promise<StudioInspectorProperties>;
  readonly synchronousDisposeFailures?: ReadonlySet<"watcher" | "binding" | "lease" | "runtime" | "broker">;
  readonly synchronousCommandCleanupFailures?: ReadonlySet<"binding" | "polling" | "broker" | "rojo" | "watcher">;
  readonly projectCandidates?: {
    readonly selectionId: string;
    readonly candidateId: string;
    readonly project: ProjectRecord;
  };
  readonly invalidateAt?:
    | "recapture"
    | "resolve-rojo"
    | "inspect-plugin"
    | "rojo-connect"
    | "context-update"
    | "broker-retain"
    | "poll-acquire"
    | "catalog-refresh"
    | "watcher-create"
    | "watcher-dispose";
}

function controllerHarness(options: HarnessOptions = {}) {
  const projectB: ProjectRecord = {
    ...projectA,
    id: "project-b",
    displayName: "Obby",
    canonicalRoot: "/projects/obby",
    canonicalProjectFile: "/projects/obby/default.project.json",
    servePlaceIds: [202],
  };
  const state = {
    projects: options.includeSecondProject ? [projectA, projectB] : [projectA],
    threads: [threadA] as ThreadRecord[],
    messages: [] as MessageRecord[],
    drafts: [{ threadId: "thread-a", content: "draft", updatedAt: 2 }] as DraftRecord[],
    selectedProjectId: "project-a" as string | undefined,
    selectedThread: { "project-a": "thread-a" } as Record<string, string>,
  };
  const events: DesktopSnapshot[] = [];
  const sequence: string[] = [];
  const renames: string[] = [];
  const runtimeDisconnects: string[] = [];
  const clipboardWrites: string[] = [];
  const filesystemDeletes: string[] = [];
  const cancelledSelections: string[] = [];
  const rojoPathWrites: string[] = [];
  const portWrites: number[] = [];
  const brokerSwaps: number[] = [];
  const bindingInvalidations: string[] = [];
  const bindingProjectInvalidations: string[] = [];
  const selectStudioCalls: string[] = [];
  const networkCalls: string[] = [];
  const shownFolders: string[] = [];
  const projectContextUpdates: { project: ProjectRef; servePlaceIds: readonly number[] }[] = [];
  let pickFileCalls = 0;
  let brokerRetains = 0;
  let brokerReleases = 0;
  let pollAcquires = 0;
  let catalogRevision = 0;
  let catalogBarrier = options.catalogBarrier;
  let coordinatorIdentityReads = 0;
  let projectInvalidation: ((projectId: string) => void) | undefined;
  let runtimeInvalidation: ((projectId: string) => void) | undefined;
  let brokerExit: (() => void) | undefined;
  let bindingInvalidation: ((projectId: string, reason: string) => void) | undefined;
  let bindingChange: (() => void) | undefined;
  let invalidationInjected = false;
  let watcherCreates = 0;
  const maybeInvalidate = (stage: HarnessOptions["invalidateAt"]): void => {
    if (options.invalidateAt !== stage || invalidationInjected) return;
    invalidationInjected = true;
    projectInvalidation?.("project-a");
  };
  const runtimeSnapshots = new Map<
    string,
    {
      projectId: string;
      state: "ready";
      lease: RojoLease;
      executablePath: string;
      version: string;
    }
  >();
  let brokerRefCount = options.brokerReferenceCount ?? 0;
  let preferredMcpPort = 58741;
  let providerMcpPort = 58741;
  let bindingState:
    | "disconnected"
    | "studio-selection-required"
    | "rojo-server-ready"
    | "waiting-for-studio"
    | "studio-bound"
    | "needs-reconnect"
    | "catalog-ambiguous"
    | "project-mismatch" = "disconnected";
  const inspectorChildren = vi.fn(async (input: StudioInspectorRequestIdentity & { readonly instancePath: string }) =>
    options.inspectorChildren === undefined ? childrenResult : options.inspectorChildren(input),
  );
  const inspectorProperties = vi.fn(
    async (input: StudioInspectorRequestIdentity & { readonly instancePath: string }) =>
      options.inspectorProperties === undefined ? propertiesResult : options.inspectorProperties(input),
  );
  const brokerReady = () =>
    ({
      ...(options.omitBrokerEpoch ? {} : { brokerEpoch: "epoch-a" }),
      primaryPort: 58741,
      legacyStatus: "unknown" as const,
      startedAt: 4,
    }) as StudioBrokerLease["ready"];
  const lease: RojoLease = Object.freeze({
    leaseId: "lease-a",
    projectId: "project-a",
    projectRevision: 2,
    generation: 1,
    port: 34872,
    startedAt: 5,
  });
  const catalog = Object.freeze({
    brokerEpoch: "epoch-a",
    revision: 1,
    observedAt: 10,
    failures: 0,
    instances: Object.freeze(
      options.catalogInstances ?? [
        Object.freeze({
          instanceId: "studio-a",
          role: "edit",
          placeId: 101,
          placeName: "Arena",
          dataModelName: "Arena",
          pluginVersion: "2.22.5",
          pluginVariant: "main",
          serverVersion: "2.22.5",
          versionMismatch: false,
          connectedAt: 3,
          lastActivity: 10,
          eligible: true,
          warningRequired: false,
        }),
      ],
    ),
  });
  let currentCatalog: StudioCatalogSnapshot = catalog;
  const projectCatalog = (projectId: string): StudioCatalogSnapshot => {
    if (options.preserveCatalogProjection) return currentCatalog;
    const placeIds =
      [...projectContextUpdates].reverse().find((context) => context.project.projectId === projectId)?.servePlaceIds ??
      state.projects.find((project) => project.id === projectId)?.servePlaceIds ??
      [];
    return {
      ...currentCatalog,
      instances: currentCatalog.instances.map((row) => {
        const eligible = placeIds.includes(row.placeId);
        if (!eligible) {
          return { ...row, eligible: false, eligibilityReason: "project-mismatch", warningRequired: false };
        }
        const eligibleRow = { ...row, eligible: true, warningRequired: false };
        delete eligibleRow.eligibilityReason;
        return eligibleRow;
      }),
    };
  };

  const ports: AppControllerOptions = {
    projects: {
      list: () => [...state.projects],
      findById: (id) => state.projects.find((project) => project.id === id),
      selectedProjectId: () => state.selectedProjectId,
      touchAndSelect: (id) => {
        const project = state.projects.find((item) => item.id === id);
        if (project !== undefined) state.selectedProjectId = id;
        return project;
      },
      remove: (id) => {
        sequence.push("project-row-remove");
        state.projects = state.projects.filter((project) => project.id !== id);
      },
    },
    conversations: {
      listThreads: (projectId) => state.threads.filter((thread) => thread.projectId === projectId),
      createThread: (projectId) => {
        const created = {
          id: `thread-${state.threads.length + 1}`,
          projectId,
          title: "New chat",
          createdAt: 4,
          updatedAt: 4,
        };
        state.threads.push(created);
        state.selectedThread[projectId] = created.id;
        return created;
      },
      renameThread: (threadId, title) => {
        renames.push(threadId);
        const index = state.threads.findIndex((thread) => thread.id === threadId);
        if (index < 0) return undefined;
        const renamed = { ...state.threads[index]!, title };
        state.threads[index] = renamed;
        return renamed;
      },
      deleteThread: (threadId) => {
        state.threads = state.threads.filter((thread) => thread.id !== threadId);
      },
      selectThread: (projectId, threadId) => {
        const thread = state.threads.find((item) => item.id === threadId && item.projectId === projectId);
        if (thread === undefined) throw new Error("missing");
        state.selectedThread[projectId] = threadId;
        return thread;
      },
      selectedThreadId: (projectId) => state.selectedThread[projectId],
      listMessages: (threadId) => state.messages.filter((message) => message.threadId === threadId),
      appendUserMessage: (threadId, content) => {
        const message = {
          id: `message-${state.messages.length + 1}`,
          threadId,
          role: "user" as const,
          content,
          createdAt: 5,
        };
        state.messages.push(message);
        state.drafts = state.drafts.filter((draft) => draft.threadId !== threadId);
        return message;
      },
      loadDraft: (threadId) => state.drafts.find((draft) => draft.threadId === threadId),
      saveDraft: (threadId, content) => {
        const draft = { threadId, content, updatedAt: 5 };
        state.drafts = [...state.drafts.filter((item) => item.threadId !== threadId), draft];
        return draft;
      },
    },
    settings: {
      getRojoPath: () => undefined,
      setRojoPath: (path) => rojoPathWrites.push(path),
      getMcpPort: () => preferredMcpPort,
      setMcpPort: (port) => {
        if (options.settingsPortFailure === port) throw new Error("settings write failed");
        preferredMcpPort = port;
        portWrites.push(port);
      },
      getSidebarWidth: () => 272,
      setSidebarWidth: vi.fn(),
    },
    projectService: {
      inspectRoot: async () =>
        options.projectCandidates === undefined
          ? { kind: "existing" as const, project: projectA }
          : {
              kind: "candidates" as const,
              selectionId: options.projectCandidates.selectionId,
              candidates: [
                {
                  candidateId: options.projectCandidates.candidateId,
                  displayName: options.projectCandidates.project.displayName,
                  relativeProjectFile: "game.project.json",
                },
              ],
            },
      commitCandidate: async () => {
        if (options.projectCandidates === undefined) return { kind: "existing" as const, project: projectA };
        state.projects.push(options.projectCandidates.project);
        state.threads.push({
          id: `thread-${state.threads.length + 1}`,
          projectId: options.projectCandidates.project.id,
          title: "New chat",
          createdAt: 5,
          updatedAt: 5,
        });
        return { kind: "created" as const, project: options.projectCandidates.project, thread: state.threads.at(-1)! };
      },
      cancelCandidate: (selectionId) => cancelledSelections.push(selectionId),
    },
    native: {
      pickDirectories: options.pickDirectories ?? (() => Promise.resolve([])),
      pickFiles: () => {
        pickFileCalls += 1;
        return (options.pickFiles ?? (() => Promise.resolve([])))();
      },
      writeClipboard: (value) => clipboardWrites.push(value),
      showItemInFolder: (path) => shownFolders.push(path),
    },
    recaptureProject: async (record, revision) => {
      sequence.push("recapture");
      maybeInvalidate("recapture");
      return Object.freeze({
        project: Object.freeze({
          projectId: record.id,
          canonicalRoot: record.canonicalRoot,
          rootDevice: record.rootDevice,
          rootInode: record.rootInode,
          canonicalProjectFile: record.canonicalProjectFile,
          projectFileDevice: record.projectFileDevice,
          projectFileInode: record.projectFileInode,
          configDigest: options.recapturedDigest ?? record.configDigest,
          revision,
        }),
        servePlaceIds: Object.freeze([...record.servePlaceIds]),
      });
    },
    createWatcher: (ref, invalidated) => {
      watcherCreates += 1;
      if (options.watcherStartFailure) throw new Error("ENOENT: persisted project directory is missing");
      const watcherIndex = watcherCreates;
      if (watcherCreates > 1 && options.invalidateAt === "watcher-create") {
        sequence.push("watcher-create");
        maybeInvalidate("watcher-create");
      }
      projectInvalidation = (projectId) => {
        if (projectId === ref.projectId) invalidated(projectId, "project-drift");
      };
      return {
        checkNow: async () => undefined,
        dispose: () => {
          sequence.push("watcher-dispose");
          if (options.invalidateAt === "watcher-create" && watcherIndex === 1) {
            sequence.push("old-watcher-dispose");
          }
          maybeInvalidate("watcher-dispose");
          if (options.synchronousCommandCleanupFailures?.has("watcher")) throw new Error("sync command watcher");
          if (options.synchronousDisposeFailures?.has("watcher")) throw new Error("sync watcher");
          return options.watcherDisposeFailure ? Promise.reject(new Error("watcher path /secret")) : Promise.resolve();
        },
      };
    },
    resolver: {
      resolve:
        options.resolveRojo ??
        (async () => {
          sequence.push("resolve-rojo");
          maybeInvalidate("resolve-rojo");
          return { path: "/usr/local/bin/rojo", version: "7.7.1", source: "usr-local" as const };
        }),
    },
    plugin: {
      inspect: async () => {
        sequence.push("inspect-plugin");
        maybeInvalidate("inspect-plugin");
        return {
          state: "installed" as const,
          sourcePath: "/app/plugin",
          destinationPath: "/home/Plugins/MCPPlugin.rbxmx",
          sourceSha256: "source",
          destinationSha256: "destination",
          inspectorPath: "/secret/inspector",
          restartRequired: false,
          detail: "Installed",
        };
      },
      install: async () => ({
        state: "installed" as const,
        changed: true,
        backupPath: "/secret/backup",
        sourcePath: "/app/plugin",
        destinationPath: "/home/Plugins/MCPPlugin.rbxmx",
        restartRequired: true,
        detail: "Installed",
      }),
      pluginsDirectory: () => "/home/Documents/Roblox/Plugins",
    },
    runtimes: {
      connect: async (project, executable) => {
        sequence.push("rojo-connect");
        maybeInvalidate("rojo-connect");
        const connected = {
          projectId: project.projectId,
          state: "ready" as const,
          lease,
          executablePath: executable.path,
          version: executable.version,
        };
        runtimeSnapshots.set(project.projectId, connected);
        return lease;
      },
      disconnect: (projectId) => {
        sequence.push("rojo-disconnect");
        runtimeDisconnects.push(projectId);
        runtimeSnapshots.delete(projectId);
        if (options.synchronousCommandCleanupFailures?.has("rojo")) throw new Error("sync command Rojo");
        return Promise.resolve();
      },
      refresh: async (projectId) => {
        sequence.push("rojo-health-refresh");
        const runtime = runtimeSnapshots.get(projectId);
        if (runtime === undefined) throw new Error("not connected");
        return runtime.lease;
      },
      snapshot: (projectId) => runtimeSnapshots.get(projectId),
      dispose: () => {
        sequence.push("runtime-dispose");
        if (options.synchronousDisposeFailures?.has("runtime")) throw new Error("sync runtime");
        return options.runtimeDisposeFailure
          ? Promise.reject(new Error("runtime token=super-secret"))
          : Promise.resolve();
      },
    },
    subscribeRuntimeInvalidation: (listener) => {
      runtimeInvalidation = (projectId) => listener(projectId, "rojo-exit");
      return () => sequence.push("runtime-unsubscribe");
    },
    brokerProvider: {
      configuredPort: () => providerMcpPort,
      current: () => {
        coordinatorIdentityReads += 1;
        return {
          retain: async () => {
            sequence.push("broker-retain");
            maybeInvalidate("broker-retain");
            brokerRetains += 1;
            brokerRefCount += 1;
            let released = false;
            return {
              ready: brokerReady(),
              release: () => {
                if (released) return Promise.resolve();
                released = true;
                sequence.push("broker-release");
                brokerReleases += 1;
                if (options.synchronousCommandCleanupFailures?.has("broker")) throw new Error("sync command broker");
                const finish = (): Promise<void> => {
                  brokerRefCount -= 1;
                  if (options.synchronousDisposeFailures?.has("lease")) throw new Error("sync lease");
                  return options.brokerReleaseFailure
                    ? Promise.reject(new Error("token=super-secret /private/path"))
                    : Promise.resolve();
                };
                return options.brokerReleaseBarrier === undefined
                  ? finish()
                  : options.brokerReleaseBarrier.then(finish);
              },
            };
          },
          snapshot: () => ({
            state: brokerRefCount > 0 ? ("ready" as const) : ("stopped" as const),
            ...(brokerRefCount > 0
              ? {
                  ready: brokerReady(),
                }
              : {}),
            referenceCount: brokerRefCount,
          }),
          stop: () => {
            sequence.push("broker-stop");
            if (options.synchronousDisposeFailures?.has("broker")) throw new Error("sync broker");
            return Promise.resolve();
          },
        };
      },
      prepareReplacement: async (port) => {
        sequence.push(`broker-prepare:${port}`);
        if (options.brokerPrepareBarrier !== undefined) await options.brokerPrepareBarrier;
        brokerSwaps.push(port);
        const oldPort = providerMcpPort;
        let rolledBack = false;
        return {
          commit: async () => {
            sequence.push("broker-commit");
            providerMcpPort = port;
            if (options.brokerCommitFailureAfterSwitch) throw new Error("replacement failed after old stop");
          },
          rollback: async () => {
            if (rolledBack) return;
            rolledBack = true;
            sequence.push("broker-rollback");
            if (options.brokerRollbackFailure) throw new Error("broker rollback failed");
            providerMcpPort = oldPort;
          },
        };
      },
      subscribeInvalidation: (listener) => {
        brokerExit = () => listener("broker-exit");
        return () => sequence.push("broker-unsubscribe");
      },
    },
    bindings: {
      acquire: () => {
        sequence.push("poll-acquire");
        maybeInvalidate("poll-acquire");
        pollAcquires += 1;
        let released = false;
        return () => {
          if (released) return;
          released = true;
          sequence.push("poll-release");
          if (options.synchronousCommandCleanupFailures?.has("polling")) throw new Error("sync command polling");
        };
      },
      refreshCatalog: async () => {
        sequence.push("catalog-refresh");
        maybeInvalidate("catalog-refresh");
        if (catalogBarrier !== undefined) await catalogBarrier;
        if (options.catalogFailure) throw new Error("catalog unavailable /secret");
        catalogRevision = Math.max(catalogRevision + 1, 1);
        currentCatalog = { ...currentCatalog, revision: catalogRevision };
        if (options.bindingStateAfterRefresh !== undefined) {
          bindingState = options.bindingStateAfterRefresh;
        }
        return options.projectBlindCatalog
          ? {
              ...currentCatalog,
              instances: currentCatalog.instances.map((row) => ({
                ...row,
                eligible: false,
                eligibilityReason: "project-mismatch",
              })),
            }
          : currentCatalog;
      },
      selectStudio: (input) => {
        selectStudioCalls.push(input.instanceId);
        bindingState = "rojo-server-ready";
        return {
          projectId: input.projectId,
          bindingRevision: 1,
          catalogRevision: input.catalogRevision,
          instanceId: input.instanceId,
          rojoHandoffRequired: true as const,
        };
      },
      confirmRojoHandoff: () => {
        bindingState = "studio-bound";
        return {
          bindingId: "binding-a",
          bindingRevision: 1,
          project: {} as ProjectRef,
          rojo: lease,
          studio: {
            brokerEpoch: "epoch-a",
            instanceId: "studio-a",
            connectedAt: 3,
            placeId: 101,
            role: "edit",
            pluginVariant: "main",
            pluginVersion: "2.22.5",
            serverVersion: "2.22.5",
            lastActivity: 10,
            catalogObservedAt: 10,
            catalogRevision: 1,
          },
          rojoHandoffConfirmedAt: 11,
        };
      },
      release: (projectId) => {
        sequence.push(`binding-release:${projectId}`);
        if (options.synchronousCommandCleanupFailures?.has("binding")) throw new Error("sync command binding");
        bindingState = "disconnected";
      },
      invalidateProject: (projectId, reason) => {
        bindingProjectInvalidations.push(`${projectId}:${reason}`);
        bindingState = "needs-reconnect";
        bindingInvalidation?.(projectId, reason);
      },
      invalidateAll: (reason) => {
        sequence.push(`binding-invalidate-all:${reason}`);
        bindingInvalidations.push(reason);
        bindingState = "needs-reconnect";
      },
      snapshot: (projectId) =>
        ({
          state: bindingState,
          ...(catalogRevision === 0 ? {} : { catalog: projectCatalog(projectId) }),
          ...(bindingState === "rojo-server-ready"
            ? {
                pending: {
                  projectId: "project-a",
                  bindingRevision: 1,
                  catalogRevision: 1,
                  instanceId: "studio-a",
                  rojoHandoffRequired: true as const,
                },
              }
            : {}),
          ...(bindingState === "studio-bound"
            ? {
                binding: {
                  bindingId: "binding-a",
                  ...(options.omitBoundBindingRevision ? {} : { bindingRevision: 1 }),
                  project: {} as ProjectRef,
                  rojo: lease,
                  studio: {
                    brokerEpoch: "epoch-a",
                    instanceId: "studio-a",
                    connectedAt: 3,
                    placeId: 101,
                    role: "edit",
                    pluginVariant: "main",
                    pluginVersion: "2.22.5",
                    serverVersion: "2.22.5",
                    lastActivity: 10,
                    catalogObservedAt: 10,
                    catalogRevision: 1,
                  },
                  rojoHandoffConfirmedAt: 11,
                },
              }
            : {}),
          samePublishedPlaceLimitation: "Only one Studio edit window per published place.",
        }) as BindingSnapshot,
      subscribeInvalidation: (listener) => {
        bindingInvalidation = listener;
        return () => sequence.push("binding-unsubscribe");
      },
      subscribeChange: (listener) => {
        bindingChange = listener;
        return () => sequence.push("binding-change-unsubscribe");
      },
      dispose: () => {
        sequence.push("binding-dispose");
        if (options.synchronousDisposeFailures?.has("binding")) throw new Error("sync binding");
        return Promise.resolve();
      },
      updateProjectContext: (context) => {
        if (projectContextUpdates.length > 0 && options.invalidateAt === "context-update") {
          sequence.push("context-update");
          maybeInvalidate("context-update");
        }
        projectContextUpdates.push(context);
      },
      removeProjectContext: vi.fn(),
    },
    inspector: {
      children: inspectorChildren,
      properties: inspectorProperties,
    },
  };

  const controller = new AppController(ports);
  controller.subscribe((snapshot) => events.push(snapshot));
  return {
    controller,
    state,
    events,
    sequence,
    renames,
    runtimeDisconnects,
    clipboardWrites,
    filesystemDeletes,
    cancelledSelections,
    rojoPathWrites,
    portWrites,
    brokerSwaps,
    bindingInvalidations,
    bindingProjectInvalidations,
    selectStudioCalls,
    networkCalls,
    shownFolders,
    projectContextUpdates,
    inspectorChildren,
    inspectorProperties,
    catalog,
    get pickFileCalls() {
      return pickFileCalls;
    },
    get brokerRetains() {
      return brokerRetains;
    },
    get brokerReleases() {
      return brokerReleases;
    },
    get pollAcquires() {
      return pollAcquires;
    },
    get catalogRevision() {
      return catalogRevision;
    },
    set catalogRevision(value: number) {
      catalogRevision = value;
    },
    setCatalogBarrier(barrier: Promise<void> | undefined) {
      catalogBarrier = barrier;
    },
    get coordinatorIdentityReads() {
      return coordinatorIdentityReads;
    },
    get preferredMcpPort() {
      return preferredMcpPort;
    },
    get providerMcpPort() {
      return providerMcpPort;
    },
    emitProjectInvalidation(projectId: string) {
      projectInvalidation?.(projectId);
    },
    emitRuntimeInvalidation(projectId: string) {
      runtimeInvalidation?.(projectId);
    },
    emitBindingInvalidation(projectId: string, reason: string) {
      bindingInvalidation?.(projectId, reason);
    },
    emitBindingChange(instances: StudioCatalogSnapshot["instances"]) {
      catalogRevision += 1;
      currentCatalog = { ...currentCatalog, revision: catalogRevision, instances };
      bindingChange?.();
    },
    setBindingState(state: "waiting-for-studio" | "catalog-ambiguous" | "project-mismatch" | "needs-reconnect") {
      bindingState = state;
    },
    emitBrokerExit() {
      brokerExit?.();
    },
  };
}

async function bindStudio(harness: ReturnType<typeof controllerHarness>): Promise<DesktopSnapshot> {
  const initial = await harness.controller.initialize();
  const connected = await harness.controller.execute(
    command("runtime.connect", {
      projectId: "project-a",
      expectedRevision: initial.revision,
    }),
  );
  if (!connected.ok) throw new Error("fixture connect failed");
  const selected = await harness.controller.execute(
    command("runtime.selectStudio", {
      projectId: "project-a",
      instanceId: "studio-a",
      catalogRevision: 1,
      warningAccepted: false,
      expectedRevision: connected.snapshot.revision,
    }),
  );
  if (!selected.ok) throw new Error("fixture Studio selection failed");
  const bound = await harness.controller.execute(
    command("runtime.confirmRojoHandoff", {
      projectId: "project-a",
      bindingRevision: 1,
      expectedRevision: selected.snapshot.revision,
    }),
  );
  if (!bound.ok) throw new Error("fixture Studio binding failed");
  return bound.snapshot;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function catalogRow(
  instanceId: string,
  placeId: number,
  patch: Partial<StudioCatalogSnapshot["instances"][number]> = {},
): StudioCatalogSnapshot["instances"][number] {
  return {
    instanceId,
    role: "edit",
    placeId,
    placeName: instanceId,
    dataModelName: instanceId,
    pluginVersion: "2.22.5",
    pluginVariant: "main",
    serverVersion: "2.22.5",
    versionMismatch: false,
    connectedAt: 3,
    lastActivity: 10,
    eligible: true,
    warningRequired: false,
    ...patch,
  };
}

async function nextTurn(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await nextTurn();
  }
  throw new Error("condition not reached");
}
