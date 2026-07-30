import { describe, expect, it } from "vitest";
import type { StudioInstance, StudioMcpService } from "@rbxforge/studio-mcp";
import type { ProjectRef, RojoLease } from "../../shared/domain.js";
import {
  BindingCoordinator,
  SAME_PUBLISHED_PLACE_LIMITATION,
  type BindingCoordinatorOptions,
} from "./binding-coordinator.js";

function projectRef(projectId: string, revision = 1): ProjectRef {
  return Object.freeze({
    projectId,
    canonicalRoot: `/projects/${projectId}`,
    rootDevice: "1",
    rootInode: `root-${projectId}`,
    canonicalProjectFile: `/projects/${projectId}/default.project.json`,
    projectFileDevice: "1",
    projectFileInode: `file-${projectId}`,
    configDigest: `digest-${projectId}-${revision}`,
    revision,
  });
}

function rojoLease(project: ProjectRef, generation = 1, port = 34_815): RojoLease {
  return Object.freeze({
    leaseId: `lease-${project.projectId}-${generation}`,
    projectId: project.projectId,
    projectRevision: project.revision,
    generation,
    port,
    startedAt: 1_000,
  });
}

function studioInstance(instanceId: string, patch: Partial<StudioInstance> = {}): StudioInstance {
  return Object.freeze({
    instanceId,
    role: "edit",
    placeId: 123,
    placeName: "Place",
    dataModelName: "Place",
    isRunning: false,
    pluginVersion: "2.22.5",
    pluginVariant: "main",
    serverVersion: "2.22.5",
    versionMismatch: false,
    lastActivity: 10_000,
    connectedAt: 1_000,
    ...patch,
  });
}

class FakeStudioService {
  instances: readonly StudioInstance[];
  fail: Error | undefined;
  selected: string | undefined;
  readonly selectionHistory: string[] = [];
  listGate: Promise<void> | undefined;
  listCalls = 0;

  constructor(instances: readonly StudioInstance[]) {
    this.instances = instances;
  }

  async listConnectedInstances(): Promise<readonly StudioInstance[]> {
    this.listCalls += 1;
    await this.listGate;
    if (this.fail !== undefined) throw this.fail;
    return this.instances;
  }

  selectInstance(instanceId: string): StudioInstance {
    const instance = this.instances.find((candidate) => candidate.instanceId === instanceId);
    if (instance === undefined) throw new Error("not present");
    this.selected = instanceId;
    this.selectionHistory.push(instanceId);
    return instance;
  }

  clearSelectedInstance(): void {
    this.selected = undefined;
  }
}

interface Harness {
  readonly coordinator: BindingCoordinator;
  readonly service: FakeStudioService;
  readonly projects: Map<string, { project: ProjectRef; servePlaceIds: readonly number[] }>;
  readonly leases: Map<string, RojoLease>;
  readonly broker: {
    state: "ready" | "error";
    epoch: string;
  };
  readonly intervals: Map<number, () => void>;
  now(): number;
  setNow(value: number): void;
  tickPoll(): Promise<void>;
}

function bindingHarness(
  input: {
    readonly instances?: readonly StudioInstance[];
    readonly projects?: readonly string[];
    readonly servePlaceIds?: readonly number[];
  } = {},
): Harness {
  let now = 10_000;
  let nextInterval = 1;
  let nextId = 1;
  const service = new FakeStudioService(input.instances ?? [studioInstance("studio-a")]);
  const broker = { state: "ready" as const, epoch: "broker-1" };
  const projects = new Map(
    (input.projects ?? ["project-a"]).map((projectId) => [
      projectId,
      {
        project: projectRef(projectId),
        servePlaceIds: Object.freeze([...(input.servePlaceIds ?? [123])]),
      },
    ]),
  );
  const leases = new Map(
    [...projects.values()].map(({ project }, index) => [project.projectId, rojoLease(project, 1, 34_815 + index)]),
  );
  const intervals = new Map<number, () => void>();
  const options: BindingCoordinatorOptions = {
    projectContext(projectId) {
      const context = projects.get(projectId);
      if (context === undefined) throw new Error("project missing");
      return context;
    },
    runtimes: {
      snapshot(projectId) {
        const lease = leases.get(projectId);
        return lease === undefined ? undefined : Object.freeze({ projectId, state: "ready" as const, lease });
      },
      assertCurrent(project, lease) {
        if (projects.get(project.projectId)?.project !== project || leases.get(project.projectId) !== lease) {
          throw new Error("Rojo lease is not current");
        }
      },
    },
    broker: () => ({
      snapshot() {
        return broker.state === "ready"
          ? Object.freeze({
              state: "ready" as const,
              referenceCount: 1,
              ready: Object.freeze({
                brokerEpoch: broker.epoch,
                primaryPort: 58_741,
                legacyStatus: "unknown" as const,
                startedAt: 1_000,
              }),
            })
          : Object.freeze({ state: "error" as const, referenceCount: 0 });
      },
      service() {
        if (broker.state !== "ready") throw new Error("broker unavailable");
        return service as unknown as StudioMcpService;
      },
    }),
    now: () => now,
    createId: () => `binding-${nextId++}`,
    setInterval(callback, milliseconds) {
      expect(milliseconds).toBe(2_000);
      const handle = nextInterval++;
      intervals.set(handle, callback);
      return handle;
    },
    clearInterval(handle) {
      intervals.delete(handle as number);
    },
  };
  const coordinator = new BindingCoordinator(options);
  return {
    coordinator,
    service,
    projects,
    leases,
    broker,
    intervals,
    now: () => now,
    setNow(value) {
      now = value;
    },
    async tickPoll() {
      const callback = [...intervals.values()][0];
      if (callback === undefined) throw new Error("poll timer missing");
      callback();
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

async function selectPending(harness: Harness, projectId = "project-a", warningAccepted = false) {
  const catalog = await harness.coordinator.refreshCatalog();
  return harness.coordinator.selectStudio({
    projectId,
    instanceId: harness.service.instances[0]!.instanceId,
    catalogRevision: catalog.revision,
    warningAccepted,
  });
}

async function bind(harness: Harness, projectId = "project-a", warningAccepted = false) {
  const pending = await selectPending(harness, projectId, warningAccepted);
  return harness.coordinator.confirmRojoHandoff({
    projectId,
    bindingRevision: pending.bindingRevision,
  });
}

describe("BindingCoordinator selection", () => {
  it("uses an explicitly refreshed project identity and host place IDs for the next selection", async () => {
    const harness = bindingHarness({ servePlaceIds: [999] });
    const catalog = await harness.coordinator.refreshCatalog();
    expect(() =>
      harness.coordinator.selectStudio({
        projectId: "project-a",
        instanceId: "studio-a",
        catalogRevision: catalog.revision,
        warningAccepted: false,
      }),
    ).toThrow(/eligible/i);

    const refreshed = projectRef("project-a", 2);
    harness.projects.set("project-a", {
      project: refreshed,
      servePlaceIds: Object.freeze([999]),
    });
    harness.leases.set("project-a", rojoLease(refreshed));
    harness.coordinator.updateProjectContext({
      project: refreshed,
      servePlaceIds: Object.freeze([123]),
    });
    expect(
      harness.coordinator.selectStudio({
        projectId: "project-a",
        instanceId: "studio-a",
        catalogRevision: catalog.revision,
        warningAccepted: false,
      }),
    ).toMatchObject({ projectId: "project-a", instanceId: "studio-a" });
  });

  it("keeps a sole Studio instance unselected until an explicit exact-revision call", async () => {
    const harness = bindingHarness();
    const catalog = await harness.coordinator.refreshCatalog();
    expect(harness.service.selected).toBeUndefined();
    expect(harness.coordinator.snapshot("project-a").binding).toBeUndefined();
    expect(() =>
      harness.coordinator.selectStudio({
        projectId: "project-a",
        instanceId: "studio-a",
        catalogRevision: catalog.revision - 1,
        warningAccepted: false,
      }),
    ).toThrow(/catalog changed/i);
    expect(harness.service.selected).toBeUndefined();
  });

  it("requires manual Rojo handoff before becoming bound", async () => {
    const harness = bindingHarness();
    const pending = await selectPending(harness);
    expect(harness.coordinator.snapshot("project-a").state).toBe("rojo-server-ready");
    expect(harness.coordinator.snapshot("project-a").binding).toBeUndefined();
    const binding = harness.coordinator.confirmRojoHandoff({
      projectId: "project-a",
      bindingRevision: pending.bindingRevision,
    });
    expect(binding.rojoHandoffConfirmedAt).toBe(10_000);
    expect(harness.coordinator.snapshot("project-a").state).toBe("studio-bound");
  });

  it("invalidates a pending binding when the service selects a reused ID with changed connectedAt", async () => {
    const harness = bindingHarness();
    const pending = await selectPending(harness);
    harness.service.instances = [studioInstance("studio-a", { connectedAt: 2_000 })];
    expect(() =>
      harness.coordinator.confirmRojoHandoff({
        projectId: "project-a",
        bindingRevision: pending.bindingRevision,
      }),
    ).toThrow(/different connection identity/i);
    expect(harness.coordinator.snapshot("project-a").pending).toBeUndefined();
    expect(harness.service.selected).toBeUndefined();
  });

  it.each(["project-drift", "rojo-replacement", "broker-restart"] as const)(
    "invalidates and releases intrinsic polling when confirmation detects %s",
    async (failure) => {
      const harness = bindingHarness();
      const pending = await selectPending(harness);
      const original = harness.projects.get("project-a")!;
      if (failure === "project-drift") {
        const replacement = projectRef("project-a", 2);
        harness.projects.set("project-a", {
          ...original,
          project: replacement,
        });
        harness.leases.set("project-a", rojoLease(replacement));
      } else if (failure === "rojo-replacement") {
        harness.leases.set("project-a", rojoLease(original.project, 2));
      } else {
        harness.broker.epoch = "broker-2";
      }

      expect(() =>
        harness.coordinator.confirmRojoHandoff({
          projectId: "project-a",
          bindingRevision: pending.bindingRevision,
        }),
      ).toThrow();
      const snapshot = harness.coordinator.snapshot("project-a");
      expect(snapshot.state).toBe("needs-reconnect");
      expect(snapshot.pending).toBeUndefined();
      expect(snapshot.invalidationReason).toBeDefined();
      expect(harness.intervals.size).toBe(0);
    },
  );

  it("frees the exclusive claim for another project after confirmation identity failure", async () => {
    const harness = bindingHarness({ projects: ["project-a", "project-b"] });
    const catalog = await harness.coordinator.refreshCatalog();
    const pending = harness.coordinator.selectStudio({
      projectId: "project-a",
      instanceId: "studio-a",
      catalogRevision: catalog.revision,
      warningAccepted: false,
    });
    const replacement = projectRef("project-a", 2);
    harness.projects.set("project-a", {
      project: replacement,
      servePlaceIds: Object.freeze([123]),
    });
    harness.leases.set("project-a", rojoLease(replacement));
    expect(() =>
      harness.coordinator.confirmRojoHandoff({
        projectId: "project-a",
        bindingRevision: pending.bindingRevision,
      }),
    ).toThrow();

    expect(() =>
      harness.coordinator.selectStudio({
        projectId: "project-b",
        instanceId: "studio-a",
        catalogRevision: catalog.revision,
        warningAccepted: false,
      }),
    ).not.toThrow();
  });

  it("does not preserve an obsolete binding after service identity failure during reselection", async () => {
    const harness = bindingHarness();
    const binding = await bind(harness);
    const catalog = harness.coordinator.snapshot("project-a").catalog!;
    harness.service.instances = [studioInstance("studio-a", { connectedAt: 2_000 })];
    expect(() =>
      harness.coordinator.selectStudio({
        projectId: "project-a",
        instanceId: "studio-a",
        catalogRevision: catalog.revision,
        warningAccepted: false,
      }),
    ).toThrow(/different catalog connection/i);
    const snapshot = harness.coordinator.snapshot("project-a");
    expect(snapshot.state).toBe("needs-reconnect");
    expect(snapshot.binding).toBeUndefined();
    expect(() => harness.coordinator.assertCurrent("project-a", binding.bindingRevision)).toThrow();
  });

  it("failed reselection invalidates only that project and preserves another project's route", async () => {
    const harness = bindingHarness({
      projects: ["project-a", "project-b"],
      instances: [
        studioInstance("studio-a", { placeId: 123 }),
        studioInstance("studio-b", { placeId: 999, connectedAt: 2_000 }),
      ],
    });
    harness.projects.set("project-b", {
      project: harness.projects.get("project-b")!.project,
      servePlaceIds: Object.freeze([999]),
    });
    const catalog = await harness.coordinator.refreshCatalog();
    const pendingA = harness.coordinator.selectStudio({
      projectId: "project-a",
      instanceId: "studio-a",
      catalogRevision: catalog.revision,
      warningAccepted: false,
    });
    harness.coordinator.confirmRojoHandoff({
      projectId: "project-a",
      bindingRevision: pendingA.bindingRevision,
    });
    const pendingB = harness.coordinator.selectStudio({
      projectId: "project-b",
      instanceId: "studio-b",
      catalogRevision: catalog.revision,
      warningAccepted: false,
    });
    const bindingB = harness.coordinator.confirmRojoHandoff({
      projectId: "project-b",
      bindingRevision: pendingB.bindingRevision,
    });

    harness.service.instances = [
      studioInstance("studio-a", { placeId: 123, connectedAt: 3_000 }),
      studioInstance("studio-b", { placeId: 999, connectedAt: 2_000 }),
    ];
    expect(() =>
      harness.coordinator.selectStudio({
        projectId: "project-a",
        instanceId: "studio-a",
        catalogRevision: catalog.revision,
        warningAccepted: false,
      }),
    ).toThrow(/different catalog connection/i);
    expect(harness.coordinator.snapshot("project-a").state).toBe("needs-reconnect");
    await expect(
      harness.coordinator.withBinding(
        "project-b",
        bindingB.bindingRevision,
        async (_service, expectedInstanceId) => expectedInstanceId,
      ),
    ).resolves.toBe("studio-b");
  });

  it("does not clear another project's selection when failed reselection never retargeted the service", async () => {
    const harness = bindingHarness({
      projects: ["project-a", "project-b"],
      instances: [
        studioInstance("studio-a", { placeId: 123 }),
        studioInstance("studio-b", { placeId: 999, connectedAt: 2_000 }),
      ],
    });
    harness.projects.set("project-b", {
      project: harness.projects.get("project-b")!.project,
      servePlaceIds: Object.freeze([999]),
    });
    const catalog = await harness.coordinator.refreshCatalog();
    const pendingA = harness.coordinator.selectStudio({
      projectId: "project-a",
      instanceId: "studio-a",
      catalogRevision: catalog.revision,
      warningAccepted: false,
    });
    harness.coordinator.confirmRojoHandoff({
      projectId: "project-a",
      bindingRevision: pendingA.bindingRevision,
    });
    const pendingB = harness.coordinator.selectStudio({
      projectId: "project-b",
      instanceId: "studio-b",
      catalogRevision: catalog.revision,
      warningAccepted: false,
    });
    const bindingB = harness.coordinator.confirmRojoHandoff({
      projectId: "project-b",
      bindingRevision: pendingB.bindingRevision,
    });
    harness.service.instances = [studioInstance("studio-b", { placeId: 999, connectedAt: 2_000 })];

    expect(() =>
      harness.coordinator.selectStudio({
        projectId: "project-a",
        instanceId: "studio-a",
        catalogRevision: catalog.revision,
        warningAccepted: false,
      }),
    ).toThrow(/not present/i);
    expect(harness.service.selected).toBe("studio-b");
    expect(harness.coordinator.snapshot("project-b").binding).toEqual(bindingB);
  });

  it("fails forged/stale inputs before service selection", async () => {
    const harness = bindingHarness();
    const catalog = await harness.coordinator.refreshCatalog();
    const before = harness.service.selectionHistory.length;
    expect(() =>
      harness.coordinator.selectStudio({
        projectId: "forged",
        instanceId: "studio-a",
        catalogRevision: catalog.revision,
        warningAccepted: false,
      }),
    ).toThrow(/project missing/i);
    harness.leases.set("project-a", rojoLease(harness.projects.get("project-a")!.project, 2));
    expect(() =>
      harness.coordinator.selectStudio({
        projectId: "project-a",
        instanceId: "studio-a",
        catalogRevision: catalog.revision,
        warningAccepted: false,
      }),
    ).not.toThrow();
    expect(harness.service.selectionHistory.length).toBe(before + 1);
  });

  it("reserves a pending connection exclusively and release frees it", async () => {
    const harness = bindingHarness({ projects: ["project-a", "project-b"] });
    const catalog = await harness.coordinator.refreshCatalog();
    harness.coordinator.selectStudio({
      projectId: "project-a",
      instanceId: "studio-a",
      catalogRevision: catalog.revision,
      warningAccepted: false,
    });
    expect(() =>
      harness.coordinator.selectStudio({
        projectId: "project-b",
        instanceId: "studio-a",
        catalogRevision: catalog.revision,
        warningAccepted: false,
      }),
    ).toThrow(/another project/i);
    harness.coordinator.release("project-a");
    expect(() =>
      harness.coordinator.selectStudio({
        projectId: "project-b",
        instanceId: "studio-a",
        catalogRevision: catalog.revision,
        warningAccepted: false,
      }),
    ).not.toThrow();
  });

  it("scopes warning acceptance to project revision and warning kind", async () => {
    const harness = bindingHarness({ servePlaceIds: [] });
    const catalog = await harness.coordinator.refreshCatalog();
    const input = {
      projectId: "project-a",
      instanceId: "studio-a",
      catalogRevision: catalog.revision,
      warningAccepted: false,
    };
    expect(() => harness.coordinator.selectStudio(input)).toThrow(/unknown-place/i);
    const pending = harness.coordinator.selectStudio({ ...input, warningAccepted: true });
    harness.coordinator.release("project-a");
    expect(() =>
      harness.coordinator.selectStudio({
        ...input,
        catalogRevision: pending.catalogRevision,
      }),
    ).not.toThrow();
    harness.coordinator.release("project-a");
    const current = harness.projects.get("project-a")!;
    harness.projects.set("project-a", {
      ...current,
      project: projectRef("project-a", 2),
    });
    harness.leases.set("project-a", rojoLease(harness.projects.get("project-a")!.project));
    expect(() => harness.coordinator.selectStudio(input)).toThrow(/unknown-place/i);
  });

  it.each([
    ["unknown-place", 123, []],
    ["unpublished-place", 0, []],
  ] as const)(
    "projects the host-derived %s warning kind into the renderer catalog",
    async (warningKind, placeId, ids) => {
      const harness = bindingHarness({
        instances: [studioInstance("studio-a", { placeId })],
        servePlaceIds: ids,
      });
      await harness.coordinator.refreshCatalog();
      expect(harness.coordinator.snapshot("project-a").catalog?.instances).toEqual([
        expect.objectContaining({
          instanceId: "studio-a",
          eligible: true,
          warningRequired: true,
          warningKind,
        }),
      ]);
    },
  );

  it("does not record warning acceptance when a later claim check fails", async () => {
    const harness = bindingHarness({ projects: ["project-a", "project-b"], servePlaceIds: [] });
    const catalog = await harness.coordinator.refreshCatalog();
    harness.coordinator.selectStudio({
      projectId: "project-a",
      instanceId: "studio-a",
      catalogRevision: catalog.revision,
      warningAccepted: true,
    });
    expect(() =>
      harness.coordinator.selectStudio({
        projectId: "project-b",
        instanceId: "studio-a",
        catalogRevision: catalog.revision,
        warningAccepted: true,
      }),
    ).toThrow(/another project/i);
    harness.coordinator.release("project-a");
    expect(() =>
      harness.coordinator.selectStudio({
        projectId: "project-b",
        instanceId: "studio-a",
        catalogRevision: catalog.revision,
        warningAccepted: false,
      }),
    ).toThrow(/unknown-place/i);
  });

  it("projects eligibility per project and blocks public same-place ambiguity", async () => {
    const harness = bindingHarness({
      projects: ["project-a", "project-b"],
      instances: [
        studioInstance("a", { placeId: 123 }),
        studioInstance("b", { placeId: 123, connectedAt: 2_000 }),
        studioInstance("c", { placeId: 999, connectedAt: 3_000 }),
      ],
    });
    harness.projects.set("project-b", {
      project: harness.projects.get("project-b")!.project,
      servePlaceIds: Object.freeze([999]),
    });
    const catalog = await harness.coordinator.refreshCatalog();
    expect(harness.coordinator.snapshot("project-a").state).toBe("catalog-ambiguous");
    expect(
      harness.coordinator.snapshot("project-b").catalog?.instances.map((row) => [row.instanceId, row.eligible]),
    ).toEqual([
      ["a", false],
      ["b", false],
      ["c", true],
    ]);
    expect(() =>
      harness.coordinator.selectStudio({
        projectId: "project-a",
        instanceId: "a",
        catalogRevision: catalog.revision,
        warningAccepted: false,
      }),
    ).toThrow(/ambiguous/i);
  });

  it("clears warning fields when ambiguity overrides otherwise selectable unknown-place rows", async () => {
    const harness = bindingHarness({
      servePlaceIds: [],
      instances: [studioInstance("a", { placeId: 123 }), studioInstance("b", { placeId: 123, connectedAt: 2_000 })],
    });
    await harness.coordinator.refreshCatalog();
    expect(harness.coordinator.snapshot("project-a")).toMatchObject({
      state: "catalog-ambiguous",
      catalog: {
        instances: [
          {
            instanceId: "a",
            eligible: false,
            eligibilityReason: "catalog-ambiguous",
            warningRequired: false,
          },
          {
            instanceId: "b",
            eligible: false,
            eligibilityReason: "catalog-ambiguous",
            warningRequired: false,
          },
        ],
      },
    });
    for (const row of harness.coordinator.snapshot("project-a").catalog?.instances ?? []) {
      expect(row.warningKind).toBeUndefined();
    }
  });
});

describe("BindingCoordinator catalog lifecycle", () => {
  it("distinguishes waiting-for-studio and project-mismatch catalog states", async () => {
    const waiting = bindingHarness({ instances: [] });
    await waiting.coordinator.refreshCatalog();
    expect(waiting.coordinator.snapshot("project-a").state).toBe("waiting-for-studio");

    const mismatch = bindingHarness({ instances: [studioInstance("other", { placeId: 999 })] });
    await mismatch.coordinator.refreshCatalog();
    expect(mismatch.coordinator.snapshot("project-a").state).toBe("project-mismatch");
  });

  it("coalesces concurrent refreshes and increments one monotonic revision per success", async () => {
    const harness = bindingHarness();
    let release!: () => void;
    harness.service.listGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = harness.coordinator.refreshCatalog();
    const second = harness.coordinator.refreshCatalog();
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(a.revision).toBe(1);
    expect(b).toBe(a);
    harness.service.listGate = undefined;
    harness.broker.epoch = "broker-2";
    expect((await harness.coordinator.refreshCatalog()).revision).toBe(2);
  });

  it("rejects duplicate raw instance IDs as malformed without advancing revision", async () => {
    const duplicate = studioInstance("duplicate");
    const harness = bindingHarness({ instances: [duplicate, { ...duplicate, connectedAt: 2_000 }] });
    await expect(harness.coordinator.refreshCatalog()).rejects.toThrow(/duplicate.*instance/i);
    expect(harness.coordinator.snapshot("project-a").catalog).toBeUndefined();
  });

  it("uses one global fake-time poll timer with idempotent external and intrinsic references", async () => {
    const harness = bindingHarness();
    const releaseA = harness.coordinator.acquire("project-a");
    const releaseB = harness.coordinator.acquire("project-a");
    expect(harness.intervals.size).toBe(1);
    releaseA();
    releaseA();
    expect(harness.intervals.size).toBe(1);
    releaseB();
    expect(harness.intervals.size).toBe(0);
    await selectPending(harness);
    expect(harness.intervals.size).toBe(1);
    harness.coordinator.release("project-a");
    expect(harness.intervals.size).toBe(0);
  });

  it("emits a detachable change signal after a successful background poll", async () => {
    const harness = bindingHarness();
    const changes: number[] = [];
    const unsubscribe = harness.coordinator.subscribeChange(() => {
      changes.push(harness.coordinator.snapshot("project-a").catalog?.revision ?? -1);
    });
    const release = harness.coordinator.acquire("project-a");
    harness.service.instances = [studioInstance("studio-a"), studioInstance("studio-b", { connectedAt: 2_000 })];

    await harness.tickPoll();
    expect(changes).toEqual([1]);
    expect(harness.coordinator.snapshot("project-a").catalog?.instances).toHaveLength(2);

    unsubscribe();
    await harness.tickPoll();
    expect(changes).toEqual([1]);
    release();
  });

  it("rolls an unchanged binding forward on a benign poll without changing binding revision or handoff", async () => {
    const harness = bindingHarness();
    const binding = await bind(harness);
    harness.setNow(11_000);
    harness.service.instances = [studioInstance("studio-a", { connectedAt: 1_000, lastActivity: 10_900 })];
    const catalog = await harness.coordinator.refreshCatalog();
    const rolled = harness.coordinator.snapshot("project-a").binding!;
    expect(rolled.bindingRevision).toBe(binding.bindingRevision);
    expect(rolled.rojoHandoffConfirmedAt).toBe(binding.rojoHandoffConfirmedAt);
    expect(rolled.studio.catalogRevision).toBe(catalog.revision);
    expect(rolled.studio.lastActivity).toBe(10_900);
  });

  it.each([
    ["missing instance", []],
    ["changed connectedAt", [studioInstance("studio-a", { connectedAt: 2_000 })]],
    ["changed metadata", [studioInstance("studio-a", { pluginVersion: "2.22.4" })]],
    ["stale activity", [studioInstance("studio-a", { lastActivity: 4_999 })]],
  ])("invalidates for %s and never auto-revives", async (_label, instances) => {
    const harness = bindingHarness();
    const binding = await bind(harness);
    harness.service.instances = instances;
    await harness.coordinator.refreshCatalog();
    expect(() => harness.coordinator.assertCurrent("project-a", binding.bindingRevision)).toThrow(/reconnect|current/i);
    harness.service.instances = [studioInstance("studio-a")];
    await harness.coordinator.refreshCatalog();
    expect(harness.coordinator.snapshot("project-a").binding).toBeUndefined();
  });

  it("invalidates the same raw ID across broker restart and retains monotonic catalog revisions", async () => {
    const harness = bindingHarness();
    const binding = await bind(harness);
    harness.broker.epoch = "broker-2";
    const catalog = await harness.coordinator.refreshCatalog();
    expect(catalog.revision).toBe(2);
    expect(() => harness.coordinator.assertCurrent("project-a", binding.bindingRevision)).toThrow();
  });

  it("invalidates immediately when the broker epoch changes during an in-flight refresh", async () => {
    const harness = bindingHarness();
    const binding = await bind(harness);
    let finish!: () => void;
    harness.service.listGate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const refresh = harness.coordinator.refreshCatalog();
    harness.broker.epoch = "broker-2";
    finish();
    await expect(refresh).rejects.toThrow(/broker changed/i);
    expect(harness.coordinator.snapshot("project-a").binding).toBeUndefined();
    expect(() => harness.coordinator.assertCurrent("project-a", binding.bindingRevision)).toThrow();
  });

  it("invalidates at exactly three failures or six seconds without success without changing observation", async () => {
    const harness = bindingHarness();
    const binding = await bind(harness);
    harness.service.fail = new Error("offline");
    await expect(harness.coordinator.refreshCatalog()).rejects.toThrow("offline");
    await expect(harness.coordinator.refreshCatalog()).rejects.toThrow("offline");
    expect(harness.coordinator.snapshot("project-a").binding).toBeDefined();
    await expect(harness.coordinator.refreshCatalog()).rejects.toThrow("offline");
    expect(() => harness.coordinator.assertCurrent("project-a", binding.bindingRevision)).toThrow();

    const byTime = bindingHarness();
    const byTimeBinding = await bind(byTime);
    byTime.service.fail = new Error("offline");
    byTime.setNow(16_000);
    await expect(byTime.coordinator.refreshCatalog()).rejects.toThrow("offline");
    expect(() => byTime.coordinator.assertCurrent("project-a", byTimeBinding.bindingRevision)).toThrow();
  });

  it("invalidates a never-settling refresh at exactly six seconds and rejects its late result", async () => {
    const harness = bindingHarness({ projects: ["project-a", "project-b"] });
    const binding = await bind(harness);
    const catalog = harness.coordinator.snapshot("project-a").catalog!;
    let finishRefresh!: () => void;
    harness.service.listGate = new Promise<void>((resolve) => {
      finishRefresh = resolve;
    });
    const hungRefresh = harness.coordinator.refreshCatalog();

    harness.setNow(14_999);
    expect(() =>
      harness.coordinator.selectStudio({
        projectId: "project-b",
        instanceId: "studio-a",
        catalogRevision: catalog.revision,
        warningAccepted: false,
      }),
    ).toThrow(/another project/i);

    harness.setNow(15_999);
    await harness.tickPoll();
    expect(harness.coordinator.snapshot("project-a").binding).toEqual(binding);

    harness.setNow(16_000);
    await harness.tickPoll();
    const invalidated = harness.coordinator.snapshot("project-a");
    expect(invalidated.state).toBe("needs-reconnect");
    expect(invalidated.binding).toBeUndefined();
    expect(invalidated.invalidationReason).toBe("catalog-refresh-failed");
    harness.service.listGate = undefined;
    harness.service.instances = [studioInstance("studio-a", { lastActivity: 16_000 })];
    const freshCatalog = await harness.coordinator.refreshCatalog();
    expect(() =>
      harness.coordinator.selectStudio({
        projectId: "project-b",
        instanceId: "studio-a",
        catalogRevision: freshCatalog.revision,
        warningAccepted: false,
      }),
    ).not.toThrow();

    finishRefresh();
    await expect(hungRefresh).rejects.toThrow(/superseded/i);
    expect(harness.coordinator.snapshot("project-a").binding).toBeUndefined();
    expect(harness.coordinator.snapshot("project-a").catalog?.revision).toBe(freshCatalog.revision);
  });

  it("supersedes a never-settling initial acquired-flow refresh at its start deadline", async () => {
    const harness = bindingHarness();
    const releaseFlow = harness.coordinator.acquire("project-a");
    let finishOld!: () => void;
    harness.service.listGate = new Promise<void>((resolve) => {
      finishOld = resolve;
    });
    const oldRefresh = harness.coordinator.refreshCatalog();
    expect(harness.service.listCalls).toBe(1);

    harness.setNow(15_999);
    await harness.tickPoll();
    expect(harness.service.listCalls).toBe(1);
    expect(harness.coordinator.snapshot("project-a").catalog).toBeUndefined();

    let finishRecovery!: () => void;
    harness.service.listGate = new Promise<void>((resolve) => {
      finishRecovery = resolve;
    });
    harness.setNow(16_000);
    await harness.tickPoll();
    expect(harness.service.listCalls).toBe(2);
    const recovery = harness.coordinator.refreshCatalog();
    harness.service.instances = [studioInstance("studio-a", { lastActivity: 16_000 })];
    finishRecovery();
    const recovered = await recovery;
    expect(recovered.revision).toBe(1);
    expect(recovered.failures).toBe(0);

    finishOld();
    await expect(oldRefresh).rejects.toThrow(/superseded/i);
    expect(harness.coordinator.snapshot("project-a").catalog?.revision).toBe(1);
    const queuedPoll = [...harness.intervals.values()][0]!;
    releaseFlow();
    expect(harness.intervals.size).toBe(0);
    queuedPoll();
    await Promise.resolve();
    await Promise.resolve();
    expect(harness.service.listCalls).toBe(2);
  });

  it("supersedes an unselected acquired-flow refresh six seconds after the last success", async () => {
    const harness = bindingHarness();
    const releaseFlow = harness.coordinator.acquire("project-a");
    const initial = await harness.coordinator.refreshCatalog();
    expect(initial.revision).toBe(1);
    let finishOld!: () => void;
    harness.service.listGate = new Promise<void>((resolve) => {
      finishOld = resolve;
    });
    harness.setNow(12_000);
    const oldRefresh = harness.coordinator.refreshCatalog();
    expect(harness.service.listCalls).toBe(2);

    harness.setNow(15_999);
    await harness.tickPoll();
    expect(harness.service.listCalls).toBe(2);
    expect(harness.coordinator.snapshot("project-a").catalog?.revision).toBe(1);

    let finishRecovery!: () => void;
    harness.service.listGate = new Promise<void>((resolve) => {
      finishRecovery = resolve;
    });
    harness.setNow(16_000);
    await harness.tickPoll();
    expect(harness.service.listCalls).toBe(3);
    const recovery = harness.coordinator.refreshCatalog();
    harness.service.instances = [studioInstance("studio-a", { lastActivity: 16_000 })];
    finishRecovery();
    const recovered = await recovery;
    expect(recovered.revision).toBe(2);
    expect(recovered.failures).toBe(0);

    harness.service.fail = new Error("late superseded failure");
    finishOld();
    await expect(oldRefresh).rejects.toThrow(/superseded/i);
    harness.service.fail = undefined;
    const finalCatalog = harness.coordinator.snapshot("project-a").catalog;
    expect(finalCatalog?.revision).toBe(2);
    expect(finalCatalog?.failures).toBe(0);
    releaseFlow();
    expect(harness.intervals.size).toBe(0);
  });

  it("assertCurrent independently rejects a catalog or activity older than 5,000ms", async () => {
    const harness = bindingHarness();
    const binding = await bind(harness);
    harness.setNow(15_001);
    expect(() => harness.coordinator.assertCurrent("project-a", binding.bindingRevision)).toThrow(/stale/i);
  });

  it("invalidates project drift, Rojo replacement, broker exit, and resume fail closed", async () => {
    const harness = bindingHarness();
    const project = harness.projects.get("project-a")!;
    const first = await bind(harness);
    harness.projects.set("project-a", { ...project, project: projectRef("project-a", 2) });
    expect(() => harness.coordinator.assertCurrent("project-a", first.bindingRevision)).toThrow();

    harness.projects.set("project-a", project);
    harness.coordinator.release("project-a");
    const second = await bind(harness);
    harness.leases.set("project-a", rojoLease(project.project, 2));
    expect(() => harness.coordinator.assertCurrent("project-a", second.bindingRevision)).toThrow();

    harness.coordinator.invalidateProject("project-a", "rojo-exit");
    expect(harness.coordinator.snapshot("project-a").invalidationReason).toBe("rojo-exit");
    harness.coordinator.invalidateAll("broker-exit");
    harness.coordinator.invalidateAll("resume");
    expect(harness.coordinator.snapshot("project-a").invalidationReason).toBe("resume");
  });

  it("invalidates cleanly after the broker service has already become unavailable", async () => {
    const harness = bindingHarness();
    await bind(harness);
    harness.broker.state = "error";
    expect(() => harness.coordinator.invalidateAll("broker-exit")).not.toThrow();
    expect(harness.coordinator.snapshot("project-a").invalidationReason).toBe("broker-exit");
    await expect(harness.coordinator.dispose()).resolves.toBeUndefined();
  });

  it("offers a detachable invalidation subscription for the host controller", async () => {
    const harness = bindingHarness();
    await bind(harness);
    const events: string[] = [];
    const unsubscribe = harness.coordinator.subscribeInvalidation((projectId, reason) => {
      events.push(`${projectId}:${reason}`);
    });
    harness.coordinator.invalidateProject("project-a", "project-drift");
    unsubscribe();
    harness.coordinator.invalidateProject("project-a", "resume");
    expect(events).toEqual(["project-a:project-drift"]);
  });
});

describe("BindingCoordinator routing and disposal", () => {
  it("serializes two projects and routes each callback to its own selected instance ID", async () => {
    const harness = bindingHarness({
      projects: ["project-a", "project-b"],
      instances: [
        studioInstance("studio-a", { placeId: 123 }),
        studioInstance("studio-b", { placeId: 999, connectedAt: 2_000 }),
      ],
    });
    harness.projects.set("project-b", {
      project: harness.projects.get("project-b")!.project,
      servePlaceIds: Object.freeze([999]),
    });
    const catalog = await harness.coordinator.refreshCatalog();
    const pendingA = harness.coordinator.selectStudio({
      projectId: "project-a",
      instanceId: "studio-a",
      catalogRevision: catalog.revision,
      warningAccepted: false,
    });
    const boundA = harness.coordinator.confirmRojoHandoff({
      projectId: "project-a",
      bindingRevision: pendingA.bindingRevision,
    });
    const pendingB = harness.coordinator.selectStudio({
      projectId: "project-b",
      instanceId: "studio-b",
      catalogRevision: catalog.revision,
      warningAccepted: false,
    });
    const boundB = harness.coordinator.confirmRojoHandoff({
      projectId: "project-b",
      bindingRevision: pendingB.bindingRevision,
    });
    let release!: () => void;
    let markStarted!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const seen: string[] = [];
    const first = harness.coordinator.withBinding(
      "project-a",
      boundA.bindingRevision,
      async (_service, expectedInstanceId) => {
        seen.push(expectedInstanceId);
        markStarted();
        await gate;
        return expectedInstanceId;
      },
    );
    const second = harness.coordinator.withBinding(
      "project-b",
      boundB.bindingRevision,
      async (_service, expectedInstanceId) => {
        seen.push(expectedInstanceId);
        return expectedInstanceId;
      },
    );
    await started;
    expect(seen).toEqual(["studio-a"]);
    release();
    await expect(Promise.all([first, second])).resolves.toEqual(["studio-a", "studio-b"]);
    expect(seen).toEqual(["studio-a", "studio-b"]);
  });

  it("fails synchronous selection as busy rather than retargeting an in-flight route", async () => {
    const harness = bindingHarness();
    const binding = await bind(harness);
    let release!: () => void;
    let markStarted!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const operation = harness.coordinator.withBinding("project-a", binding.bindingRevision, async () => {
      markStarted();
      await gate;
    });
    await started;
    const catalog = harness.coordinator.snapshot("project-a").catalog!;
    expect(() =>
      harness.coordinator.selectStudio({
        projectId: "project-a",
        instanceId: "studio-a",
        catalogRevision: catalog.revision,
        warningAccepted: false,
      }),
    ).toThrow(/busy/i);
    release();
    await operation;
  });

  it("unlocks after callback failure and fails the post-check if invalidated during operation", async () => {
    const harness = bindingHarness();
    const binding = await bind(harness);
    await expect(
      harness.coordinator.withBinding("project-a", binding.bindingRevision, async () => {
        throw new Error("callback failed");
      }),
    ).rejects.toThrow("callback failed");
    await expect(harness.coordinator.withBinding("project-a", binding.bindingRevision, async () => "ok")).resolves.toBe(
      "ok",
    );

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const operation = harness.coordinator.withBinding("project-a", binding.bindingRevision, async () => {
      await gate;
      return "stale";
    });
    await Promise.resolve();
    harness.coordinator.invalidateProject("project-a", "project-drift");
    release();
    await expect(operation).rejects.toThrow(/current|reconnect|invalidated/i);
  });

  it("invalidates before routing when the service returns a changed connectedAt for the frozen ID", async () => {
    const harness = bindingHarness();
    const binding = await bind(harness);
    harness.service.instances = [studioInstance("studio-a", { connectedAt: 2_000 })];
    let invoked = false;
    await expect(
      harness.coordinator.withBinding("project-a", binding.bindingRevision, async () => {
        invoked = true;
      }),
    ).rejects.toThrow(/different connection identity/i);
    expect(invoked).toBe(false);
    expect(harness.coordinator.snapshot("project-a").binding).toBeUndefined();
    expect(harness.service.selected).toBeUndefined();
  });

  it("invalidating A clears selection only when A owns it and never clears B", async () => {
    const harness = bindingHarness({
      projects: ["project-a", "project-b"],
      instances: [
        studioInstance("studio-a", { placeId: 123 }),
        studioInstance("studio-b", { placeId: 999, connectedAt: 2_000 }),
      ],
    });
    harness.projects.set("project-b", {
      project: harness.projects.get("project-b")!.project,
      servePlaceIds: Object.freeze([999]),
    });
    const catalog = await harness.coordinator.refreshCatalog();
    const a = harness.coordinator.selectStudio({
      projectId: "project-a",
      instanceId: "studio-a",
      catalogRevision: catalog.revision,
      warningAccepted: false,
    });
    harness.coordinator.confirmRojoHandoff({ projectId: "project-a", bindingRevision: a.bindingRevision });
    const b = harness.coordinator.selectStudio({
      projectId: "project-b",
      instanceId: "studio-b",
      catalogRevision: catalog.revision,
      warningAccepted: false,
    });
    harness.coordinator.confirmRojoHandoff({ projectId: "project-b", bindingRevision: b.bindingRevision });
    expect(harness.service.selected).toBe("studio-b");
    harness.coordinator.invalidateProject("project-a", "project-drift");
    expect(harness.service.selected).toBe("studio-b");
  });

  it("prevents a late refresh or route completion from committing after dispose", async () => {
    const refreshHarness = bindingHarness();
    let finishRefresh!: () => void;
    refreshHarness.service.listGate = new Promise<void>((resolve) => {
      finishRefresh = resolve;
    });
    const refresh = refreshHarness.coordinator.refreshCatalog();
    const disposingRefresh = refreshHarness.coordinator.dispose();
    finishRefresh();
    await expect(refresh).rejects.toThrow(/disposed/i);
    await disposingRefresh;
    expect(refreshHarness.coordinator.snapshot("project-a").catalog).toBeUndefined();

    const routeHarness = bindingHarness();
    const binding = await bind(routeHarness);
    let finishRoute!: () => void;
    const routeGate = new Promise<void>((resolve) => {
      finishRoute = resolve;
    });
    const route = routeHarness.coordinator.withBinding("project-a", binding.bindingRevision, async () => {
      await routeGate;
      return "late";
    });
    await Promise.resolve();
    const disposingRoute = routeHarness.coordinator.dispose();
    finishRoute();
    await expect(route).rejects.toThrow(/disposed|current|invalidated/i);
    await disposingRoute;
    expect(routeHarness.coordinator.snapshot("project-a").binding).toBeUndefined();
  });

  it("exposes exact immutable same-published-place limitation copy", () => {
    const harness = bindingHarness();
    const snapshot = harness.coordinator.snapshot("project-a");
    expect(snapshot.samePublishedPlaceLimitation).toBe(
      "RbxForge cannot detect or distinguish two Studio edit windows for the same published place. Keep only one such window open before binding.",
    );
    expect(SAME_PUBLISHED_PLACE_LIMITATION).toBe(snapshot.samePublishedPlaceLimitation);
    expect(Object.isFrozen(snapshot)).toBe(true);
  });
});
