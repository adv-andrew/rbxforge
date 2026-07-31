import { mkdtemp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { RojoStatus } from "@rbxforge/rojo";
import type { StudioInstance, StudioMcpService } from "@rbxforge/studio-mcp";

import { AppController } from "../../src/main/app-controller.js";
import { recaptureStoredProject } from "../../src/main/production.js";
import { captureProjectIdentity, assertProjectIdentityCurrent } from "../../src/main/projects/project-identity.js";
import { ProjectService } from "../../src/main/projects/project-service.js";
import type { ProjectWatchLease } from "../../src/main/projects/project-watcher.js";
import {
  BindingCoordinator,
  type PendingBinding,
  type StudioCatalogSnapshot,
} from "../../src/main/runtime/binding-coordinator.js";
import {
  ProjectRuntimeRegistry,
  type ProjectRojoService,
  type ProjectRuntimeInvalidation,
} from "../../src/main/runtime/project-runtime-registry.js";
import type { ResolvedRojoExecutable } from "../../src/main/runtime/rojo-executable.js";
import type {
  StudioBrokerInvalidationReason,
  StudioBrokerLease,
  StudioBrokerReady,
  StudioBrokerSnapshot,
} from "../../src/main/runtime/studio-broker-controller.js";
import { StudioInspectorService } from "../../src/main/runtime/studio-inspector-service.js";
import { AUDITED_STUDIO_PLUGIN } from "../../src/main/runtime/studio-plugin-installer.js";
import { ConversationRepository } from "../../src/main/storage/conversation-repository.js";
import { openDesktopDatabase, type DesktopDatabase } from "../../src/main/storage/database.js";
import { runMigrations } from "../../src/main/storage/migrations.js";
import { ProjectRepository } from "../../src/main/storage/project-repository.js";
import { SettingsRepository } from "../../src/main/storage/settings-repository.js";
import type { DesktopSnapshot, ProjectBinding, ProjectRecord, ProjectRef } from "../../src/shared/domain.js";
import { desktopCommandSchema, type DesktopCommand, type DesktopResponse } from "../../src/shared/protocol.js";

const FIXED_NOW = 1_900_000_000_000;
type WithoutCommandEnvelope<T> = T extends unknown ? Omit<T, "version" | "requestId"> : never;
type HarnessCommand = WithoutCommandEnvelope<DesktopCommand>;
const ROJO_EXECUTABLE: ResolvedRojoExecutable = Object.freeze({
  path: "/opt/rbxforge-test/rojo",
  version: "7.7.1",
  source: "configured",
});

export interface IntegrationStudioInput {
  readonly instanceId: string;
  readonly placeId: number;
  readonly placeName: string;
  readonly dataModelName: string;
}

export interface IntegrationHarnessOptions {
  readonly studios?: readonly IntegrationStudioInput[];
}

interface InternalHarnessOptions extends IntegrationHarnessOptions {
  readonly existingRoot?: string;
  readonly reuseStorage?: boolean;
  readonly ownsRoot?: boolean;
}

export class FakeClock {
  #now = FIXED_NOW;

  now = (): number => this.#now;

  advance(milliseconds: number): void {
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
      throw new Error("Fake clock advance must be a nonnegative safe integer.");
    }
    this.#now += milliseconds;
  }
}

export class DeterministicPorts {
  readonly allocatedRojoPorts: number[] = [];
  #nextRojoPort = 34_871;

  allocateRojo(): number {
    const port = this.#nextRojoPort++;
    this.allocatedRojoPorts.push(port);
    return port;
  }
}

class FakeRojoChild implements ProjectRojoService {
  readonly startCalls: string[] = [];
  stopCalls = 0;
  readonly #listeners = new Set<(status: RojoStatus) => void>();

  constructor(readonly port: number) {}

  async start(projectPath: string): Promise<RojoStatus> {
    this.startCalls.push(projectPath);
    const status = this.healthyStatus();
    this.emit(status);
    return status;
  }

  async checkHealth(): Promise<RojoStatus> {
    return this.healthyStatus();
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
    this.emit({
      processRunning: false,
      apiHealthy: false,
      port: this.port,
      state: "stopped",
    });
  }

  onStatus(listener: (status: RojoStatus) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  emitExit(): void {
    this.emit({
      processRunning: false,
      apiHealthy: false,
      port: this.port,
      state: "failed",
      stderr: "deterministic Rojo fixture exit",
    });
  }

  private healthyStatus(): RojoStatus {
    return {
      processRunning: true,
      apiHealthy: true,
      port: this.port,
    };
  }

  private emit(status: RojoStatus): void {
    for (const listener of [...this.#listeners]) listener(status);
  }
}

export class FakeIntegrationBroker {
  startCalls = 0;
  stopCalls = 0;
  releaseCalls = 0;
  unownedHandleStopCalls = 0;
  selectedInstanceId: string | undefined;
  readonly routeSelections: string[] = [];
  #referenceCount = 0;
  #state: StudioBrokerSnapshot["state"] = "stopped";
  #epoch = 1;
  #primaryPort = 58_741;
  #failCatalogs = 0;
  #instances: StudioInstance[];

  constructor(
    private readonly clock: FakeClock,
    studios: readonly IntegrationStudioInput[],
  ) {
    this.#instances = studios.map((studio) => this.completeStudio(studio));
  }

  snapshot(): StudioBrokerSnapshot {
    return Object.freeze({
      state: this.#state,
      ...(this.#state === "ready" ? { ready: this.ready() } : {}),
      referenceCount: this.#referenceCount,
    });
  }

  async retain(): Promise<StudioBrokerLease> {
    if (this.#state !== "ready") {
      this.#state = "ready";
      this.startCalls += 1;
    }
    this.#referenceCount += 1;
    const ready = this.ready();
    let released = false;
    return Object.freeze({
      ready,
      release: async () => {
        if (released) return;
        released = true;
        this.releaseCalls += 1;
        this.#referenceCount -= 1;
        if (this.#referenceCount === 0) await this.stop();
      },
    });
  }

  service(): StudioMcpService {
    return this as unknown as StudioMcpService;
  }

  async listConnectedInstances(): Promise<readonly StudioInstance[]> {
    if (this.#failCatalogs > 0) {
      this.#failCatalogs -= 1;
      throw new Error("catalog fixture failure");
    }
    return Object.freeze(this.#instances.map((instance) => Object.freeze({ ...instance })));
  }

  selectInstance(instanceId: string): StudioInstance {
    const instance = this.#instances.find((candidate) => candidate.instanceId === instanceId);
    if (instance === undefined) throw new Error("Studio fixture instance does not exist.");
    this.selectedInstanceId = instanceId;
    this.routeSelections.push(instanceId);
    return Object.freeze({ ...instance });
  }

  clearSelectedInstance(): void {
    this.selectedInstanceId = undefined;
  }

  failNextCatalogs(count: number): void {
    this.#failCatalogs = count;
  }

  restart(options: { readonly preserveRawInstanceIds: boolean }): void {
    this.clock.advance(1);
    this.#epoch += 1;
    this.startCalls += 1;
    this.#state = "ready";
    this.selectedInstanceId = undefined;
    this.#instances = this.#instances.map((instance, index) =>
      Object.freeze({
        ...instance,
        instanceId: options.preserveRawInstanceIds ? instance.instanceId : `${instance.instanceId}-restart-${index}`,
        connectedAt: this.clock.now(),
        lastActivity: this.clock.now(),
      }),
    );
  }

  async stop(): Promise<void> {
    if (this.#state === "stopped") return;
    this.#state = "stopped";
    this.stopCalls += 1;
    this.selectedInstanceId = undefined;
    this.#referenceCount = 0;
  }

  setPrimaryPort(port: number): void {
    this.#primaryPort = port;
  }

  private ready(): StudioBrokerReady {
    return Object.freeze({
      brokerEpoch: `broker-epoch-${this.#epoch}`,
      primaryPort: this.#primaryPort,
      legacyPort: 3_002,
      legacyStatus: "listening",
      startedAt: this.clock.now(),
    });
  }

  private completeStudio(studio: IntegrationStudioInput): StudioInstance {
    return Object.freeze({
      ...studio,
      role: "edit",
      isRunning: false,
      pluginVersion: AUDITED_STUDIO_PLUGIN.version,
      pluginVariant: AUDITED_STUDIO_PLUGIN.variant,
      serverVersion: AUDITED_STUDIO_PLUGIN.version,
      versionMismatch: false,
      connectedAt: this.clock.now(),
      lastActivity: this.clock.now(),
    });
  }
}

class FakeBrokerProvider {
  readonly #listeners = new Set<(reason: StudioBrokerInvalidationReason) => void>();
  #configuredPort = 58_741;

  constructor(readonly broker: FakeIntegrationBroker) {}

  current(): FakeIntegrationBroker {
    return this.broker;
  }

  configuredPort(): number {
    return this.#configuredPort;
  }

  async prepareReplacement(primaryPort: number): Promise<{
    commit(): Promise<void>;
    rollback(): Promise<void>;
  }> {
    const previous = this.#configuredPort;
    return Object.freeze({
      commit: async () => {
        this.#configuredPort = primaryPort;
        this.broker.setPrimaryPort(primaryPort);
      },
      rollback: async () => {
        this.#configuredPort = previous;
        this.broker.setPrimaryPort(previous);
      },
    });
  }

  subscribeInvalidation(listener: (reason: StudioBrokerInvalidationReason) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}

class ManualProjectWatcher implements ProjectWatchLease {
  #disposed = false;
  #invalidated = false;

  constructor(
    private readonly ref: ProjectRef,
    private readonly onInvalidated: (projectId: string, reason: string) => void,
  ) {}

  async checkNow(): Promise<void> {
    if (this.#disposed) return;
    try {
      assertProjectIdentityCurrent(this.ref);
    } catch (error) {
      if (!this.#invalidated) {
        this.#invalidated = true;
        this.onInvalidated(this.ref.projectId, error instanceof Error ? error.message : "project-unreadable");
      }
      throw error;
    }
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
  }
}

interface HarnessRepositories {
  readonly projects: ProjectRepository;
  readonly conversations: ConversationRepository;
  readonly settings: SettingsRepository;
}

export class IntegrationHarness {
  readonly clock: FakeClock;
  readonly ports: DeterministicPorts;
  readonly broker: FakeIntegrationBroker;
  readonly repositories: HarnessRepositories;
  readonly runtimes: ProjectRuntimeRegistry;
  readonly bindings: BindingCoordinator;
  readonly unownedRojoChild = new FakeRojoChild(49_999);
  readonly #database: DesktopDatabase;
  readonly #databasePath: string;
  readonly #root: string;
  readonly #controller: AppController;
  readonly #projectFiles: ReadonlyMap<string, string>;
  readonly #rojoChildren: FakeRojoChild[];
  #snapshot: DesktopSnapshot;
  #storageCloseCalls = 0;
  #shutdownPromise: Promise<void> | undefined;
  #ownsRoot: boolean;
  #requestSequence = 0;

  constructor(options: {
    readonly clock: FakeClock;
    readonly ports: DeterministicPorts;
    readonly broker: FakeIntegrationBroker;
    readonly repositories: HarnessRepositories;
    readonly runtimes: ProjectRuntimeRegistry;
    readonly bindings: BindingCoordinator;
    readonly database: DesktopDatabase;
    readonly databasePath: string;
    readonly root: string;
    readonly controller: AppController;
    readonly projectFiles: ReadonlyMap<string, string>;
    readonly rojoChildren: FakeRojoChild[];
    readonly snapshot: DesktopSnapshot;
    readonly ownsRoot: boolean;
  }) {
    this.clock = options.clock;
    this.ports = options.ports;
    this.broker = options.broker;
    this.repositories = options.repositories;
    this.runtimes = options.runtimes;
    this.bindings = options.bindings;
    this.#database = options.database;
    this.#databasePath = options.databasePath;
    this.#root = options.root;
    this.#controller = options.controller;
    this.#projectFiles = options.projectFiles;
    this.#rojoChildren = options.rojoChildren;
    this.#snapshot = options.snapshot;
    this.#ownsRoot = options.ownsRoot;
  }

  get snapshot(): DesktopSnapshot {
    return this.#snapshot;
  }

  get rojoChildren(): readonly FakeRojoChild[] {
    return this.#rojoChildren;
  }

  get storageCloseCalls(): number {
    return this.#storageCloseCalls;
  }

  async connectProject(projectId: string): Promise<StudioCatalogSnapshot> {
    const response = await this.execute({
      type: "runtime.connect",
      projectId,
      expectedRevision: this.#snapshot.revision,
    });
    this.requireOk(response);
    const catalog = this.bindings.snapshot(projectId).catalog;
    if (catalog === undefined) throw new Error("Integration catalog did not initialize.");
    return catalog;
  }

  selectStudio(projectId: string, instanceId: string, catalogRevision: number): PendingBinding {
    return this.bindings.selectStudio({
      projectId,
      instanceId,
      catalogRevision,
      warningAccepted: false,
    });
  }

  async connectAndBind(projectId: string, instanceId: string): Promise<ProjectBinding> {
    const catalog = await this.connectProject(projectId);
    return this.bindFromCatalog(projectId, instanceId, catalog.revision);
  }

  async bindFromCurrentCatalog(projectId: string, instanceId: string): Promise<ProjectBinding> {
    await this.settleInvalidations();
    const bootstrap = await this.execute({ type: "bootstrap" });
    this.requireOk(bootstrap);
    const catalog = this.bindings.snapshot(projectId).catalog;
    if (catalog === undefined) throw new Error("Integration catalog is unavailable.");
    return this.bindFromCatalog(projectId, instanceId, catalog.revision);
  }

  async selectProject(projectId: string): Promise<boolean> {
    const response = await this.execute({
      type: "project.select",
      projectId,
      expectedRevision: this.#snapshot.revision,
    });
    return response.ok;
  }

  refreshCatalog(): Promise<StudioCatalogSnapshot> {
    return this.bindings.refreshCatalog();
  }

  simulateResume(): void {
    this.bindings.invalidateAll("resume");
  }

  emitRojoExit(projectId: string): void {
    const canonicalProjectFile = this.repositories.projects.findById(projectId)?.canonicalProjectFile;
    const child = this.#rojoChildren.find((candidate) =>
      candidate.startCalls.some((projectFile) => projectFile === canonicalProjectFile),
    );
    if (child === undefined) throw new Error("Project has no retained Rojo fixture child.");
    child.emitExit();
  }

  async settleInvalidations(): Promise<void> {
    await Promise.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  async replaceProjectFileAtomically(projectId: string): Promise<void> {
    const projectFile = this.#projectFiles.get(projectId);
    if (projectFile === undefined) throw new Error("Project fixture file does not exist.");
    const replacement = join(dirname(projectFile), `.replacement-${projectId}.project.json`);
    await writeFile(
      replacement,
      `${JSON.stringify({ name: `${projectId} replacement`, servePlaceIds: [], tree: {} }, undefined, 2)}\n`,
      "utf8",
    );
    await rename(replacement, projectFile);
  }

  async persistConversationState(): Promise<void> {
    const thread = this.repositories.conversations.listThreads("project-a")[0];
    if (thread === undefined) throw new Error("Project A fixture thread is missing.");
    this.repositories.conversations.appendUserMessage(thread.id, "Keep the round lobby local and deterministic.");
    this.repositories.conversations.saveDraft(thread.id, "Draft survives relaunch.");
  }

  async relaunch(): Promise<IntegrationHarness> {
    this.#ownsRoot = false;
    await this.shutdown();
    return createIntegrationHarness({
      existingRoot: this.#root,
      reuseStorage: true,
      ownsRoot: true,
    });
  }

  shutdown(): Promise<void> {
    if (this.#shutdownPromise !== undefined) return this.#shutdownPromise;
    this.#shutdownPromise = (async () => {
      try {
        await this.#controller.dispose();
      } finally {
        this.#database.close();
        this.#storageCloseCalls += 1;
        if (this.#ownsRoot) await rm(this.#root, { recursive: true, force: true });
      }
    })();
    return this.#shutdownPromise;
  }

  private async bindFromCatalog(
    projectId: string,
    instanceId: string,
    catalogRevision: number,
  ): Promise<ProjectBinding> {
    const selected = await this.execute({
      type: "runtime.selectStudio",
      projectId,
      instanceId,
      catalogRevision,
      warningAccepted: false,
      expectedRevision: this.#snapshot.revision,
    });
    this.requireOk(selected);
    const pending = this.bindings.snapshot(projectId).pending;
    if (pending === undefined) throw new Error("Integration binding did not enter pending state.");
    const confirmed = await this.execute({
      type: "runtime.confirmRojoHandoff",
      projectId,
      bindingRevision: pending.bindingRevision,
      expectedRevision: this.#snapshot.revision,
    });
    this.requireOk(confirmed);
    const binding = this.bindings.snapshot(projectId).binding;
    if (binding === undefined) throw new Error("Integration binding was not confirmed.");
    return binding;
  }

  private async execute(input: HarnessCommand): Promise<DesktopResponse> {
    const command = desktopCommandSchema.parse({
      ...input,
      version: 1,
      requestId: `integration-request-${++this.#requestSequence}`,
    });
    const response = await this.#controller.execute(command);
    this.#snapshot = response.snapshot as unknown as DesktopSnapshot;
    return response;
  }

  private requireOk(response: DesktopResponse): asserts response is Extract<DesktopResponse, { readonly ok: true }> {
    if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`);
  }
}

export async function integrationHarness(options: IntegrationHarnessOptions = {}): Promise<IntegrationHarness> {
  return createIntegrationHarness(options);
}

async function createIntegrationHarness(options: InternalHarnessOptions): Promise<IntegrationHarness> {
  const root = options.existingRoot ?? (await mkdtemp(join(tmpdir(), "rbxforge-desktop-integration-")));
  const databasePath = join(root, "rbxforge.sqlite");
  const clock = new FakeClock();
  const ports = new DeterministicPorts();
  const projectFiles = await ensureProjectFiles(root);
  const database = openDesktopDatabase(databasePath);
  runMigrations(database);
  if (!options.reuseStorage) seedStorage(database, projectFiles, clock.now());

  const projects = new ProjectRepository(database);
  const conversations = new ConversationRepository(database);
  const settings = new SettingsRepository(database);
  const contexts = new Map(
    projects.list().map((project) => [
      project.id,
      Object.freeze({
        project: projectRef(project),
        servePlaceIds: project.servePlaceIds,
      }),
    ]),
  );
  const studios =
    options.studios ??
    Object.freeze([
      {
        instanceId: "studio-a",
        placeId: 101,
        placeName: "Project A",
        dataModelName: "Project A",
      },
      {
        instanceId: "studio-b",
        placeId: 202,
        placeName: "Project B",
        dataModelName: "Project B",
      },
    ]);
  const broker = new FakeIntegrationBroker(clock, studios);
  const brokerProvider = new FakeBrokerProvider(broker);
  const rojoChildren: FakeRojoChild[] = [];
  const runtimeListeners = new Set<(projectId: string, reason: "rojo-exit") => void>();
  let idSequence = 0;
  const runtimes = new ProjectRuntimeRegistry({
    createService: () => {
      const child = new FakeRojoChild(ports.allocateRojo());
      rojoChildren.push(child);
      return child;
    },
    createId: () => `rojo-lease-${++idSequence}`,
    now: clock.now,
    assertProjectCurrent: assertProjectIdentityCurrent,
    onInvalidated: (event: ProjectRuntimeInvalidation) => {
      for (const listener of [...runtimeListeners]) listener(event.projectId, event.reason);
    },
  });
  let bindingId = 0;
  const intervals = new Set<object>();
  const bindings = new BindingCoordinator({
    projectContext: (projectId) => {
      const context = contexts.get(projectId);
      if (context === undefined) throw new Error("Integration project context is unavailable.");
      return context;
    },
    runtimes,
    broker: () => broker,
    now: clock.now,
    createId: () => `binding-${++bindingId}`,
    setInterval: () => {
      const handle = {};
      intervals.add(handle);
      return handle;
    },
    clearInterval: (handle) => {
      if (typeof handle === "object" && handle !== null) intervals.delete(handle);
    },
  });
  const watchers = new Map<string, ManualProjectWatcher>();
  const inspector = new StudioInspectorService({ bindings, now: clock.now });
  const controller = new AppController({
    projects,
    conversations,
    settings,
    projectService: new ProjectService({ projects, now: clock.now }),
    native: {
      pickDirectories: async () => Object.freeze([]),
      pickFiles: async () => Object.freeze([]),
      writeClipboard: () => undefined,
      showItemInFolder: () => undefined,
    },
    recaptureProject: recaptureStoredProject,
    createWatcher: (ref, invalidated) => {
      const watcher = new ManualProjectWatcher(ref, invalidated);
      watchers.set(ref.projectId, watcher);
      return watcher;
    },
    resolver: {
      resolve: async () => ROJO_EXECUTABLE,
    },
    plugin: {
      inspect: async () => ({
        state: "installed",
        sourcePath: join(root, "MCPPlugin.rbxmx"),
        destinationPath: join(root, "Roblox", "Plugins", "MCPPlugin.rbxmx"),
        sourceSha256: AUDITED_STUDIO_PLUGIN.sha256,
        destinationSha256: AUDITED_STUDIO_PLUGIN.sha256,
        restartRequired: false,
        detail: "Audited fixture plugin is installed.",
      }),
      install: async () => ({
        state: "installed",
        sourcePath: join(root, "MCPPlugin.rbxmx"),
        destinationPath: join(root, "Roblox", "Plugins", "MCPPlugin.rbxmx"),
        sourceSha256: AUDITED_STUDIO_PLUGIN.sha256,
        destinationSha256: AUDITED_STUDIO_PLUGIN.sha256,
        restartRequired: false,
        detail: "Audited fixture plugin is installed.",
        changed: false,
      }),
      pluginsDirectory: () => join(root, "Roblox", "Plugins"),
    },
    runtimes,
    subscribeRuntimeInvalidation: (listener) => {
      runtimeListeners.add(listener);
      return () => runtimeListeners.delete(listener);
    },
    brokerProvider,
    bindings,
    inspector,
  });
  const snapshot = await controller.initialize();
  return new IntegrationHarness({
    clock,
    ports,
    broker,
    repositories: { projects, conversations, settings },
    runtimes,
    bindings,
    database,
    databasePath,
    root,
    controller,
    projectFiles,
    rojoChildren,
    snapshot,
    ownsRoot: options.ownsRoot ?? true,
  });
}

async function ensureProjectFiles(root: string): Promise<ReadonlyMap<string, string>> {
  const entries = [
    ["project-a", "Project A", 101],
    ["project-b", "Project B", 202],
  ] as const;
  const result = new Map<string, string>();
  for (const [projectId, name, placeId] of entries) {
    const directory = join(root, projectId);
    const projectFile = join(directory, "default.project.json");
    await mkdir(directory, { recursive: true });
    await writeFile(
      projectFile,
      `${JSON.stringify({ name, servePlaceIds: [placeId], tree: {} }, undefined, 2)}\n`,
      "utf8",
    );
    result.set(projectId, projectFile);
  }
  return result;
}

function seedStorage(database: DesktopDatabase, projectFiles: ReadonlyMap<string, string>, now: number): void {
  const records = [
    projectRecord("project-a", "Project A", 101, projectFiles, now, 100),
    projectRecord("project-b", "Project B", 202, projectFiles, now, 200),
  ];
  const insertProject = database.prepare(
    `INSERT INTO projects (
      id, display_name, canonical_root, root_device, root_inode, canonical_project_file,
      project_file_device, project_file_inode, config_digest, serve_place_ids_json,
      created_at, updated_at, last_opened_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertThread = database.prepare(
    "INSERT INTO threads (id, project_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  );
  const setState = database.prepare("INSERT INTO app_state (key, value) VALUES (?, ?)");
  database.transaction(() => {
    records.forEach((record, index) => {
      insertProject.run(
        record.id,
        record.displayName,
        record.canonicalRoot,
        record.rootDevice,
        record.rootInode,
        record.canonicalProjectFile,
        record.projectFileDevice,
        record.projectFileInode,
        record.configDigest,
        JSON.stringify(record.servePlaceIds),
        record.createdAt,
        record.updatedAt,
        record.lastOpenedAt,
      );
      const threadId = `thread-${record.id.slice(-1)}`;
      insertThread.run(threadId, record.id, "New chat", now + index, now + index);
      setState.run(`selected_thread:${record.id}`, threadId);
    });
    setState.run("selected_project_id", "project-a");
  });
}

function projectRecord(
  projectId: string,
  displayName: string,
  placeId: number,
  projectFiles: ReadonlyMap<string, string>,
  now: number,
  lastOpenedOffset: number,
): ProjectRecord {
  const projectFile = projectFiles.get(projectId);
  if (projectFile === undefined) throw new Error("Project fixture path is unavailable.");
  const identity = captureProjectIdentity({
    projectId,
    rootPath: dirname(projectFile),
    projectFilePath: projectFile,
    revision: 1,
  });
  return {
    id: projectId,
    displayName,
    canonicalRoot: identity.canonicalRoot,
    rootDevice: identity.rootDevice,
    rootInode: identity.rootInode,
    canonicalProjectFile: identity.canonicalProjectFile,
    projectFileDevice: identity.projectFileDevice,
    projectFileInode: identity.projectFileInode,
    configDigest: identity.configDigest,
    servePlaceIds: [placeId],
    createdAt: now,
    updatedAt: now,
    lastOpenedAt: now + lastOpenedOffset,
  };
}

function projectRef(project: ProjectRecord): ProjectRef {
  return Object.freeze({
    projectId: project.id,
    canonicalRoot: project.canonicalRoot,
    rootDevice: project.rootDevice,
    rootInode: project.rootInode,
    canonicalProjectFile: project.canonicalProjectFile,
    projectFileDevice: project.projectFileDevice,
    projectFileInode: project.projectFileInode,
    configDigest: project.configDigest,
    revision: 1,
  });
}
