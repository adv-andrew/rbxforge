import { relative } from "node:path";
import type {
  DesktopSnapshot,
  DraftRecord,
  MessageRecord,
  ProjectRecord,
  ProjectRef,
  RuntimeSnapshot,
  ThreadRecord,
} from "../shared/domain.js";
import { desktopSnapshotSchema } from "../shared/protocol.js";
import type { DesktopCommand, DesktopResponse, DesktopResult, PluginInspectionView } from "../shared/protocol.js";
import { toDesktopError, type DesktopError, type RecoveryAction } from "../shared/errors.js";
import type { ProjectAddResult } from "./projects/project-service.js";
import type { ProjectWatchLease } from "./projects/project-watcher.js";
import type {
  BindingSnapshot,
  ConfirmRojoHandoffInput,
  PendingBinding,
  SelectStudioInput,
  StudioCatalogSnapshot,
} from "./runtime/binding-coordinator.js";
import type { ProjectRuntimeSnapshot, ResolvedRojoExecutable } from "./runtime/project-runtime-registry.js";
import type { StudioBrokerLease, StudioBrokerSnapshot } from "./runtime/studio-broker-controller.js";
import {
  AUDITED_STUDIO_PLUGIN,
  type PluginInspection,
  type PluginInstallResult,
} from "./runtime/studio-plugin-installer.js";

const DEFAULT_MCP_PORT = 58_741;
const DEFAULT_SIDEBAR_WIDTH = 272;
const LIMITATION = "RbxForge cannot distinguish two Studio edit windows for the same published place.";

interface ProjectRepositoryPort {
  list(): ProjectRecord[];
  findById(id: string): ProjectRecord | undefined;
  selectedProjectId(): string | undefined;
  touchAndSelect(id: string): ProjectRecord | undefined;
  remove(id: string): void;
}

interface ConversationRepositoryPort {
  listThreads(projectId: string): ThreadRecord[];
  createThread(projectId: string, title?: string): ThreadRecord;
  renameThread(threadId: string, title: string): ThreadRecord | undefined;
  deleteThread(threadId: string): void;
  selectThread(projectId: string, threadId: string): ThreadRecord;
  selectedThreadId(projectId: string): string | undefined;
  listMessages(threadId: string): MessageRecord[];
  appendUserMessage(threadId: string, content: string): MessageRecord;
  loadDraft(threadId: string): DraftRecord | undefined;
  saveDraft(threadId: string, content: string): DraftRecord;
}

interface SettingsRepositoryPort {
  getRojoPath(): string | undefined;
  setRojoPath(path: string): void;
  getMcpPort(): number | undefined;
  setMcpPort(port: number): void;
  getSidebarWidth(): number | undefined;
  setSidebarWidth(width: number): void;
}

interface ProjectServicePort {
  inspectRoot(rootPath: string): Promise<ProjectAddResult>;
  commitCandidate(
    selectionId: string,
    candidateId: string,
  ): Promise<Extract<ProjectAddResult, { readonly kind: "created" | "existing" }>>;
  cancelCandidate(selectionId: string): void;
}

interface NativePort {
  pickDirectories(): Promise<readonly string[]>;
  pickFiles(): Promise<readonly string[]>;
  writeClipboard(value: string): void;
  showItemInFolder(path: string): void;
}

interface RuntimeRegistryPort {
  connect(project: ProjectRef, executable: ResolvedRojoExecutable): Promise<import("../shared/domain.js").RojoLease>;
  refresh(projectId: string): Promise<import("../shared/domain.js").RojoLease>;
  disconnect(projectId: string): Promise<void>;
  snapshot(projectId: string): ProjectRuntimeSnapshot | undefined;
  dispose(): Promise<void>;
}

interface BrokerPort {
  retain(): Promise<StudioBrokerLease>;
  snapshot(): StudioBrokerSnapshot;
  stop(): Promise<void>;
}

interface BrokerProviderPort {
  current(): BrokerPort;
  configuredPort(): number;
  prepareReplacement(primaryPort: number): Promise<{
    commit(): Promise<void>;
    rollback(): Promise<void>;
  }>;
  subscribeInvalidation(listener: (reason: "broker-exit") => void): () => void;
}

interface BindingCoordinatorPort {
  acquire(projectId: string): () => void;
  refreshCatalog(): Promise<StudioCatalogSnapshot>;
  selectStudio(input: SelectStudioInput): PendingBinding;
  confirmRojoHandoff(input: ConfirmRojoHandoffInput): import("../shared/domain.js").ProjectBinding;
  release(projectId: string): void;
  invalidateProject(projectId: string, reason: string): void;
  invalidateAll(reason: string): void;
  snapshot(projectId: string): BindingSnapshot;
  subscribeInvalidation(listener: (projectId: string, reason: string) => void): () => void;
  subscribeChange(listener: () => void): () => void;
  updateProjectContext(context: { readonly project: ProjectRef; readonly servePlaceIds: readonly number[] }): void;
  removeProjectContext(projectId: string): void;
  dispose(): Promise<void>;
}

export interface RecapturedProjectContext {
  readonly project: ProjectRef;
  readonly servePlaceIds: readonly number[];
}

interface PluginPort {
  inspect(): Promise<PluginInspection>;
  install(options: { readonly confirmReplace: boolean }): Promise<PluginInstallResult>;
  pluginsDirectory(): string;
}

export interface AppControllerOptions {
  readonly projects: ProjectRepositoryPort;
  readonly conversations: ConversationRepositoryPort;
  readonly settings: SettingsRepositoryPort;
  readonly projectService: ProjectServicePort;
  readonly native: NativePort;
  readonly recaptureProject: (record: ProjectRecord, revision: number) => Promise<RecapturedProjectContext>;
  readonly createWatcher: (
    ref: ProjectRef,
    invalidated: (projectId: string, reason: string) => void,
  ) => ProjectWatchLease;
  readonly resolver: {
    resolve(configuredPath?: string): Promise<ResolvedRojoExecutable>;
  };
  readonly plugin: PluginPort;
  readonly runtimes: RuntimeRegistryPort;
  readonly subscribeRuntimeInvalidation: (listener: (projectId: string, reason: "rojo-exit") => void) => () => void;
  readonly brokerProvider: BrokerProviderPort;
  readonly bindings: BindingCoordinatorPort;
}

interface OperationToken {
  readonly identity: object;
  readonly revision: number;
  readonly projectId?: string;
  cancelled: boolean;
}

class ControllerFault extends Error {
  constructor(
    readonly code: string,
    readonly layer: DesktopError["layer"],
    message: string,
    readonly recoveryAction: RecoveryAction = "none",
    readonly recoveryLabel = "Dismiss",
  ) {
    super(message);
    this.name = "ControllerFault";
  }
}

export class AppController {
  readonly #options: AppControllerOptions;
  readonly #listeners = new Set<(snapshot: DesktopSnapshot) => void>();
  readonly #projectRefs = new Map<string, ProjectRef>();
  readonly #watchers = new Map<string, ProjectWatchLease>();
  readonly #rojoExecutables = new Map<string, ResolvedRojoExecutable>();
  readonly #brokerLeases = new Map<string, StudioBrokerLease>();
  readonly #unreleasedBrokerLeases = new Set<StudioBrokerLease>();
  readonly #pollingReleases = new Map<string, () => void>();
  readonly #catalogs = new Map<string, StudioCatalogSnapshot>();
  readonly #runtimeStates = new Map<string, "needs-reconnect" | "disconnected" | "error">();
  readonly #runtimeErrors = new Map<string, DesktopError>();
  readonly #inFlightExecutions = new Set<Promise<DesktopResponse>>();
  #transitionTail: Promise<void> = Promise.resolve();
  #snapshot: DesktopSnapshot | undefined;
  #revision = 0;
  #activeToken: OperationToken | undefined;
  #initialization: Promise<DesktopSnapshot> | undefined;
  #disposePromise: Promise<void> | undefined;
  #disposed = false;
  #subscriptionsDetached = false;
  #removeBindingSubscription: (() => void) | undefined;
  #removeBindingChangeSubscription: (() => void) | undefined;
  #removeRuntimeSubscription: (() => void) | undefined;
  #removeBrokerSubscription: (() => void) | undefined;
  #suppressBindingEvents = false;
  #suppressBindingChangeEvents = false;

  constructor(options: AppControllerOptions) {
    this.#options = options;
  }

  initialize(): Promise<DesktopSnapshot> {
    this.#initialization ??= this.#enqueue(async () => {
      if (this.#snapshot !== undefined) return this.#snapshot;
      this.#assertAlive();
      for (const project of this.#options.projects.list()) {
        const ref = refFromRecord(project, 1);
        this.#projectRefs.set(project.id, ref);
        this.#options.bindings.updateProjectContext({
          project: ref,
          servePlaceIds: project.servePlaceIds,
        });
        this.#runtimeStates.set(project.id, "needs-reconnect");
        this.#watchers.set(project.id, this.#startWatcher(ref));
      }
      this.#removeBindingSubscription = this.#options.bindings.subscribeInvalidation((projectId, reason) => {
        if (this.#suppressBindingEvents || this.#disposed) return;
        void this.#enqueueInvalidation(projectId, reason);
      });
      this.#removeBindingChangeSubscription = this.#options.bindings.subscribeChange(() => {
        if (this.#suppressBindingChangeEvents || this.#disposed) return;
        void this.#enqueue(async () => {
          if (this.#disposed) return;
          for (const projectId of this.#pollingReleases.keys()) {
            const catalog = this.#options.bindings.snapshot(projectId).catalog;
            if (catalog === undefined) this.#catalogs.delete(projectId);
            else this.#catalogs.set(projectId, catalog);
          }
          this.#publishCommit();
        });
      });
      this.#removeRuntimeSubscription = this.#options.subscribeRuntimeInvalidation((projectId, reason) => {
        if (this.#disposed) return;
        void this.#enqueue(async () => {
          if (this.#disposed) return;
          this.#cancelActive(projectId);
          this.#suppressBindingEvents = true;
          try {
            this.#options.bindings.invalidateProject(projectId, reason);
          } finally {
            this.#suppressBindingEvents = false;
          }
          this.#runtimeStates.set(projectId, "needs-reconnect");
          this.#publishCommit();
        });
      });
      this.#removeBrokerSubscription = this.#options.brokerProvider.subscribeInvalidation(() => {
        if (this.#disposed) return;
        void this.#enqueue(async () => {
          if (this.#disposed) return;
          this.#cancelActive();
          this.#suppressBindingEvents = true;
          try {
            this.#options.bindings.invalidateAll("broker-exit");
          } finally {
            this.#suppressBindingEvents = false;
          }
          this.#brokerLeases.clear();
          this.#unreleasedBrokerLeases.clear();
          for (const release of this.#pollingReleases.values()) release();
          this.#pollingReleases.clear();
          for (const projectId of this.#projectRefs.keys()) {
            this.#runtimeStates.set(projectId, "needs-reconnect");
            this.#catalogs.delete(projectId);
          }
          this.#publishCommit();
        });
      });
      this.#snapshot = this.#buildSnapshot();
      return this.#snapshot;
    });
    return this.#initialization;
  }

  subscribe(listener: (snapshot: DesktopSnapshot) => void): () => void {
    this.#listeners.add(listener);
    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      this.#listeners.delete(listener);
    };
  }

  execute(untrusted: DesktopCommand): Promise<DesktopResponse> {
    const execution = this.#executeCommand(untrusted);
    this.#inFlightExecutions.add(execution);
    void execution.then(
      () => this.#inFlightExecutions.delete(execution),
      () => this.#inFlightExecutions.delete(execution),
    );
    return execution;
  }

  async #executeCommand(untrusted: DesktopCommand): Promise<DesktopResponse> {
    const requestId =
      typeof untrusted === "object" &&
      untrusted !== null &&
      "requestId" in untrusted &&
      typeof untrusted.requestId === "string" &&
      untrusted.requestId.length > 0
        ? untrusted.requestId
        : "invalid-request";
    try {
      await this.initialize();
      this.#assertAlive();
      const command = untrusted;
      switch (command.type) {
        case "bootstrap":
          return this.#success(requestId);
        case "project.cancelAdd":
          return this.#cancelAdd(command);
        case "project.copyFile":
          return await this.#copyProjectFile(command);
        case "runtime.copyMcpUrl":
          return await this.#copyMcpUrl(command);
        case "runtime.copyRojoAddress":
          return await this.#copyRojoAddress(command);
        case "plugin.inspect":
          return await this.#inspectPlugin(command.requestId);
        case "plugin.showFolder":
          return await this.#showPluginFolder(command.requestId);
        case "project.add":
          return await this.#addProject(command);
        case "project.addCandidate":
          return await this.#addProjectCandidate(command);
        case "project.select":
          return await this.#simpleMutation(command, () => {
            if (this.#options.projects.touchAndSelect(command.projectId) === undefined) {
              throw fault("project-not-found", "project", "The project no longer exists.");
            }
          });
        case "project.remove":
          return await this.#removeProject(command);
        case "thread.create":
          return await this.#simpleMutation(command, () => {
            this.#requireProject(command.projectId);
            this.#options.conversations.createThread(command.projectId);
          });
        case "thread.select":
          return await this.#simpleMutation(command, () => {
            this.#requireOwnedThread(command.projectId, command.threadId);
            this.#options.conversations.selectThread(command.projectId, command.threadId);
          });
        case "thread.rename":
          return await this.#simpleMutation(command, () => {
            this.#requireOwnedThread(command.projectId, command.threadId);
            if (this.#options.conversations.renameThread(command.threadId, command.title) === undefined) {
              throw fault("thread-not-found", "storage", "The conversation no longer exists.");
            }
          });
        case "thread.delete":
          return await this.#simpleMutation(command, () => {
            this.#requireOwnedThread(command.projectId, command.threadId);
            this.#options.conversations.deleteThread(command.threadId);
          });
        case "draft.save":
          return await this.#simpleMutation(command, () => {
            this.#requireOwnedThread(command.projectId, command.threadId);
            this.#options.conversations.saveDraft(command.threadId, command.content);
          });
        case "message.create":
          return await this.#simpleMutation(command, () => {
            this.#requireOwnedThread(command.projectId, command.threadId);
            this.#options.conversations.appendUserMessage(command.threadId, command.content);
          });
        case "runtime.connect":
          return await this.#connect(command);
        case "runtime.selectStudio":
          return await this.#simpleMutation(command, () => {
            this.#requireProject(command.projectId);
            this.#options.bindings.selectStudio(command);
            this.#runtimeStates.delete(command.projectId);
          });
        case "runtime.confirmRojoHandoff":
          return await this.#simpleMutation(command, () => {
            this.#requireProject(command.projectId);
            this.#options.bindings.confirmRojoHandoff(command);
            this.#runtimeStates.delete(command.projectId);
          });
        case "runtime.disconnect":
          return await this.#disconnect(command);
        case "runtime.refresh":
          return await this.#refresh(command);
        case "plugin.install":
          return await this.#installPlugin(command);
        case "settings.chooseRojo":
          return await this.#chooseRojo(command);
        case "settings.mcpPort":
          return await this.#changeMcpPort(command);
        case "ui.sidebarWidth":
          return await this.#simpleMutation(command, () => {
            this.#options.settings.setSidebarWidth(command.width);
          });
      }
    } catch (error) {
      return this.#failure(requestId, error);
    }
  }

  dispose(): Promise<void> {
    if (this.#disposePromise !== undefined) return this.#disposePromise;
    this.#disposed = true;
    this.#cancelActive();
    const detachFailures = this.#detachSubscriptions();
    this.#listeners.clear();
    this.#disposePromise = (async () => {
      const failures: unknown[] = [...detachFailures];
      const settleStage = async (work: readonly (() => unknown | Promise<unknown>)[]): Promise<void> => {
        const results = await Promise.allSettled(work.map((run) => Promise.resolve().then(run)));
        for (const result of results) if (result.status === "rejected") failures.push(result.reason);
      };

      await settleStage([...this.#inFlightExecutions].map((execution) => () => execution));
      const watchers = [...this.#watchers.values()];
      this.#watchers.clear();
      await settleStage(watchers.map((watcher) => () => watcher.dispose()));

      this.#suppressBindingEvents = true;
      try {
        this.#options.bindings.invalidateAll("dispose");
      } catch (error) {
        failures.push(error);
      } finally {
        this.#suppressBindingEvents = false;
      }
      await settleStage([() => this.#options.bindings.dispose()]);

      const leases = [...new Set([...this.#brokerLeases.values(), ...this.#unreleasedBrokerLeases])];
      this.#brokerLeases.clear();
      this.#unreleasedBrokerLeases.clear();
      for (const release of this.#pollingReleases.values()) {
        try {
          release();
        } catch (error) {
          failures.push(error);
        }
      }
      this.#pollingReleases.clear();
      await settleStage(leases.map((lease) => () => lease.release()));
      await settleStage([() => this.#options.runtimes.dispose()]);
      await settleStage([() => this.#options.brokerProvider.current().stop()]);
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, "Desktop controller disposal failed.");
    })();
    return this.#disposePromise;
  }

  #cancelAdd(command: Extract<DesktopCommand, { type: "project.cancelAdd" }>): DesktopResponse {
    this.#options.projectService.cancelCandidate(command.selectionId);
    return this.#success(command.requestId);
  }

  async #copyProjectFile(command: Extract<DesktopCommand, { type: "project.copyFile" }>): Promise<DesktopResponse> {
    return this.#enqueue(async () => {
      const project = this.#requireProject(command.projectId);
      this.#options.native.writeClipboard(project.canonicalProjectFile);
      return this.#success(command.requestId, { kind: "clipboard", label: "Rojo project file copied" });
    });
  }

  async #copyMcpUrl(command: Extract<DesktopCommand, { type: "runtime.copyMcpUrl" }>): Promise<DesktopResponse> {
    return this.#enqueue(async () => {
      this.#requireProject(command.projectId);
      const lease = this.#brokerLeases.get(command.projectId);
      if (lease === undefined)
        throw fault("broker-not-connected", "mcp", "Studio MCP is not connected.", "reconnect", "Reconnect");
      this.#options.native.writeClipboard(`http://127.0.0.1:${lease.ready.primaryPort}`);
      return this.#success(command.requestId, { kind: "clipboard", label: "MCP URL copied" });
    });
  }

  async #copyRojoAddress(
    command: Extract<DesktopCommand, { type: "runtime.copyRojoAddress" }>,
  ): Promise<DesktopResponse> {
    return this.#enqueue(async () => {
      this.#requireProject(command.projectId);
      const runtime = this.#options.runtimes.snapshot(command.projectId);
      if (runtime?.state !== "ready" || runtime.lease === undefined) {
        throw fault("rojo-not-connected", "rojo", "Rojo is not connected.", "reconnect", "Reconnect");
      }
      this.#options.native.writeClipboard(`127.0.0.1:${runtime.lease.port}`);
      return this.#success(command.requestId, { kind: "clipboard", label: "Rojo address copied" });
    });
  }

  async #inspectPlugin(requestId: string): Promise<DesktopResponse> {
    try {
      const inspection = await this.#options.plugin.inspect();
      return this.#success(requestId, { kind: "plugin-inspection", inspection: projectPluginInspection(inspection) });
    } catch (error) {
      return this.#failure(requestId, error, "plugin");
    }
  }

  async #showPluginFolder(requestId: string): Promise<DesktopResponse> {
    try {
      this.#options.native.showItemInFolder(this.#options.plugin.pluginsDirectory());
      return this.#success(requestId);
    } catch (error) {
      return this.#failure(requestId, error, "plugin");
    }
  }

  async #addProject(command: Extract<DesktopCommand, { type: "project.add" }>): Promise<DesktopResponse> {
    let token: OperationToken | undefined;
    try {
      token = await this.#reserve(command.expectedRevision);
      const roots = await this.#options.native.pickDirectories();
      this.#assertTokenCurrent(token);
      if (roots.length === 0) {
        await this.#releaseToken(token);
        return this.#success(command.requestId);
      }
      if (roots.length !== 1)
        throw fault("invalid-picker-result", "app", "The directory picker returned an invalid result.");
      const result = await this.#options.projectService.inspectRoot(roots[0]!);
      if (result.kind === "candidates") {
        await this.#releaseToken(token);
        return this.#success(command.requestId, {
          kind: "project-candidates",
          selectionId: result.selectionId,
          candidates: [...result.candidates],
        });
      }
      const snapshot = await this.#commitExternalResult(token, true, () => {
        this.#adoptProject(result.project);
      });
      return this.#success(command.requestId, { kind: "none" }, snapshot);
    } catch (error) {
      if (token !== undefined) await this.#releaseToken(token);
      return this.#failure(command.requestId, error, "project");
    }
  }

  async #addProjectCandidate(
    command: Extract<DesktopCommand, { type: "project.addCandidate" }>,
  ): Promise<DesktopResponse> {
    let token: OperationToken | undefined;
    try {
      token = await this.#reserve(command.expectedRevision);
      this.#assertTokenCurrent(token);
      const result = await this.#options.projectService.commitCandidate(command.selectionId, command.candidateId);
      const snapshot = await this.#commitExternalResult(token, true, () => {
        this.#adoptProject(result.project);
      });
      return this.#success(command.requestId, { kind: "none" }, snapshot);
    } catch (error) {
      if (token !== undefined) await this.#releaseToken(token);
      return this.#failure(command.requestId, error, "project");
    }
  }

  async #connect(command: Extract<DesktopCommand, { type: "runtime.connect" }>): Promise<DesktopResponse> {
    let token: OperationToken | undefined;
    let acquiredRojo = false;
    let acquiredLease: StudioBrokerLease | undefined;
    let acquiredPolling: (() => void) | undefined;
    let replacementWatcher: ProjectWatchLease | undefined;
    let contextUpdated = false;
    let oldWatcherDisposed = false;
    let previousRef: ProjectRef | undefined;
    let previousWatcher: ProjectWatchLease | undefined;
    let previousServePlaceIds: readonly number[] | undefined;
    try {
      token = await this.#reserve(command.expectedRevision, command.projectId);
      const record = this.#requireProject(command.projectId);
      const existingRuntime = this.#options.runtimes.snapshot(command.projectId);
      if (
        this.#runtimeStates.get(command.projectId) === undefined &&
        existingRuntime?.state === "ready" &&
        this.#brokerLeases.has(command.projectId) &&
        this.#pollingReleases.has(command.projectId)
      ) {
        await this.#options.runtimes.refresh(command.projectId);
        await this.#revalidateToken(token);
        const catalogs = await this.#refreshBindingCatalog([command.projectId]);
        const snapshot = await this.#commitCatalogResult(token, catalogs, () => {
          this.#runtimeStates.delete(command.projectId);
        });
        return this.#success(command.requestId, { kind: "none" }, snapshot);
      }

      previousRef = this.#projectRefs.get(command.projectId);
      previousWatcher = this.#watchers.get(command.projectId);
      previousServePlaceIds = record.servePlaceIds;
      if (
        existingRuntime !== undefined ||
        this.#brokerLeases.has(command.projectId) ||
        this.#pollingReleases.has(command.projectId)
      ) {
        const failures = await this.#disconnectOwned(command.projectId, "reconnect", false);
        if (failures.length > 0) throw new AggregateError(failures, "Stale runtime cleanup failed.");
        await this.#revalidateToken(token);
      }
      const projectRevision = (previousRef?.revision ?? 0) + 1;
      const context = await this.#options.recaptureProject(record, projectRevision);
      await this.#revalidateToken(token);
      const ref = context.project;
      const executable = await this.#options.resolver.resolve(this.#options.settings.getRojoPath());
      await this.#revalidateToken(token);
      const inspection = await this.#options.plugin.inspect();
      await this.#revalidateToken(token);
      if (inspection.state !== "installed") {
        throw fault(
          "plugin-not-ready",
          "plugin",
          "The audited Studio plugin must be installed before connecting.",
          inspection.state === "missing" ? "install-plugin" : "show-plugins-folder",
          inspection.state === "missing" ? "Install plugin" : "Show Plugins folder",
        );
      }

      acquiredRojo = true;
      await this.#options.runtimes.connect(ref, executable);
      await this.#revalidateToken(token);
      this.#options.bindings.updateProjectContext(context);
      contextUpdated = true;
      await this.#revalidateToken(token);
      let brokerLease = this.#brokerLeases.get(command.projectId);
      if (brokerLease === undefined) {
        brokerLease = await this.#options.brokerProvider.current().retain();
        acquiredLease = brokerLease;
        await this.#revalidateToken(token);
      }
      let polling = this.#pollingReleases.get(command.projectId);
      if (polling === undefined) {
        polling = this.#options.bindings.acquire(command.projectId);
        acquiredPolling = polling;
        await this.#revalidateToken(token);
      }
      const catalogs = await this.#refreshBindingCatalog([command.projectId]);
      await this.#revalidateCatalogToken(token, catalogs);
      replacementWatcher = this.#startWatcher(ref);
      await this.#revalidateToken(token);
      if (previousWatcher !== undefined) {
        oldWatcherDisposed = true;
        await previousWatcher.dispose();
        await this.#revalidateToken(token);
      }
      const snapshot = await this.#commitCatalogResult(token, catalogs, () => {
        this.#projectRefs.set(command.projectId, ref);
        this.#rojoExecutables.set(command.projectId, executable);
        if (acquiredLease !== undefined) this.#brokerLeases.set(command.projectId, acquiredLease);
        if (acquiredPolling !== undefined) this.#pollingReleases.set(command.projectId, acquiredPolling);
        if (replacementWatcher !== undefined) this.#watchers.set(command.projectId, replacementWatcher);
        this.#runtimeStates.delete(command.projectId);
        this.#runtimeErrors.delete(command.projectId);
      });
      acquiredLease = undefined;
      acquiredPolling = undefined;
      replacementWatcher = undefined;
      acquiredRojo = false;
      contextUpdated = false;
      oldWatcherDisposed = false;
      return this.#success(command.requestId, { kind: "none" }, snapshot);
    } catch (error) {
      const cleanup = await this.#cleanupConnect(command.projectId, {
        acquiredRojo,
        ...(acquiredLease === undefined ? {} : { acquiredLease }),
        ...(acquiredPolling === undefined ? {} : { acquiredPolling }),
        ...(replacementWatcher === undefined ? {} : { replacementWatcher }),
        ...(contextUpdated && previousRef !== undefined && previousServePlaceIds !== undefined
          ? { previousContext: { project: previousRef, servePlaceIds: previousServePlaceIds } }
          : {}),
        ...(oldWatcherDisposed && previousRef !== undefined ? { restoreWatcherFor: previousRef } : {}),
      });
      const failure = cleanup.length === 0 ? error : new AggregateError([error, ...cleanup]);
      let recoverySnapshot =
        token === undefined ? undefined : await this.#publishConnectFailure(token, command.projectId, failure);
      if (recoverySnapshot === undefined && token !== undefined) await this.#releaseToken(token);
      if (recoverySnapshot === undefined && cleanup.length > 0) {
        recoverySnapshot = await this.#publishConnectRecovery(command.projectId);
      }
      return this.#failure(command.requestId, failure, "app", recoverySnapshot);
    }
  }

  async #disconnect(command: Extract<DesktopCommand, { type: "runtime.disconnect" }>): Promise<DesktopResponse> {
    let token: OperationToken | undefined;
    try {
      token = await this.#reserve(command.expectedRevision, command.projectId);
      this.#requireProject(command.projectId);
      const failures = await this.#disconnectOwned(command.projectId, "disconnect", true);
      const snapshot = await this.#commitExternalResult(token, true, () => {
        this.#runtimeStates.set(command.projectId, "disconnected");
        this.#runtimeErrors.delete(command.projectId);
        this.#catalogs.delete(command.projectId);
      });
      if (failures.length > 0) {
        return this.#failure(
          command.requestId,
          new AggregateError(failures, "Runtime cleanup failed."),
          "app",
          snapshot,
        );
      }
      return this.#success(command.requestId, { kind: "none" }, snapshot);
    } catch (error) {
      if (token !== undefined) await this.#releaseToken(token);
      return this.#failure(command.requestId, error);
    }
  }

  async #removeProject(command: Extract<DesktopCommand, { type: "project.remove" }>): Promise<DesktopResponse> {
    let token: OperationToken | undefined;
    try {
      token = await this.#reserve(command.expectedRevision, command.projectId);
      this.#requireProject(command.projectId);
      const failures = await this.#disconnectOwned(command.projectId, "remove", true);
      if (failures.length > 0) {
        const snapshot = await this.#commitExternalResult(token, false, () => {
          this.#runtimeStates.set(command.projectId, "disconnected");
        });
        return this.#failure(
          command.requestId,
          new AggregateError(failures, "Project cleanup failed."),
          "app",
          snapshot,
        );
      }
      const snapshot = await this.#commitExternalResult(token, false, () => {
        this.#options.projects.remove(command.projectId);
        this.#options.bindings.removeProjectContext(command.projectId);
        this.#projectRefs.delete(command.projectId);
        this.#runtimeStates.delete(command.projectId);
        this.#runtimeErrors.delete(command.projectId);
        this.#catalogs.delete(command.projectId);
      });
      return this.#success(command.requestId, { kind: "none" }, snapshot);
    } catch (error) {
      if (token !== undefined) await this.#releaseToken(token);
      return this.#failure(command.requestId, error, "project");
    }
  }

  async #refresh(command: Extract<DesktopCommand, { type: "runtime.refresh" }>): Promise<DesktopResponse> {
    let token: OperationToken | undefined;
    try {
      token = await this.#reserve(command.expectedRevision, command.projectId);
      this.#requireProject(command.projectId);
      const runtime = this.#options.runtimes.snapshot(command.projectId);
      if (runtime?.state !== "ready")
        throw fault("rojo-not-connected", "rojo", "Rojo is not connected.", "reconnect", "Reconnect");
      await this.#options.runtimes.refresh(command.projectId);
      this.#assertTokenCurrent(token);
      const catalogs = await this.#refreshBindingCatalog([command.projectId]);
      const snapshot = await this.#commitCatalogResult(token, catalogs, () => undefined);
      return this.#success(command.requestId, { kind: "none" }, snapshot);
    } catch (error) {
      if (token !== undefined) await this.#releaseToken(token);
      return this.#failure(command.requestId, error);
    }
  }

  async #installPlugin(command: Extract<DesktopCommand, { type: "plugin.install" }>): Promise<DesktopResponse> {
    let token: OperationToken | undefined;
    try {
      token = await this.#reserve(command.expectedRevision);
      const result = await this.#options.plugin.install({ confirmReplace: command.confirmReplace });
      const snapshot = await this.#commitExternalResult(token, result.changed, () => undefined);
      return this.#success(
        command.requestId,
        {
          kind: "plugin-inspection",
          inspection: projectPluginInspection(result),
        },
        snapshot,
      );
    } catch (error) {
      if (token !== undefined) await this.#releaseToken(token);
      return this.#failure(command.requestId, error, "plugin");
    }
  }

  async #chooseRojo(command: Extract<DesktopCommand, { type: "settings.chooseRojo" }>): Promise<DesktopResponse> {
    let token: OperationToken | undefined;
    try {
      token = await this.#reserve(command.expectedRevision);
      const files = await this.#options.native.pickFiles();
      this.#assertTokenCurrent(token);
      if (files.length === 0) {
        await this.#releaseToken(token);
        return this.#success(command.requestId, { kind: "rojo-choice", changed: false });
      }
      if (files.length !== 1)
        throw fault("invalid-picker-result", "app", "The file picker returned an invalid result.");
      const selected = files[0]!;
      const resolved = await this.#options.resolver.resolve(selected);
      if (resolved.source !== "configured" || resolved.path !== selected) {
        throw fault(
          "rojo-choice-mismatch",
          "rojo",
          "The selected file is not the resolved Rojo executable.",
          "choose-rojo",
          "Choose Rojo executable",
        );
      }
      const snapshot = await this.#commitExternalResult(token, false, () => {
        this.#options.settings.setRojoPath(resolved.path);
      });
      return this.#success(command.requestId, { kind: "rojo-choice", changed: true }, snapshot);
    } catch (error) {
      if (token !== undefined) await this.#releaseToken(token);
      return this.#failure(command.requestId, error, "rojo");
    }
  }

  async #changeMcpPort(command: Extract<DesktopCommand, { type: "settings.mcpPort" }>): Promise<DesktopResponse> {
    let token: OperationToken | undefined;
    let replacement:
      | {
          commit(): Promise<void>;
          rollback(): Promise<void>;
        }
      | undefined;
    let recoverySnapshot: DesktopSnapshot | undefined;
    const previousPort = this.#options.settings.getMcpPort() ?? DEFAULT_MCP_PORT;
    try {
      token = await this.#reserve(command.expectedRevision);
      if (
        this.#brokerLeases.size > 0 ||
        this.#unreleasedBrokerLeases.size > 0 ||
        this.#options.brokerProvider.current().snapshot().referenceCount > 0
      ) {
        throw fault("broker-active", "mcp", "Disconnect projects before changing the Studio MCP port.");
      }
      this.#suppressBindingEvents = true;
      try {
        this.#options.bindings.invalidateAll("broker-port-change");
        await this.#revalidateToken(token);
        replacement = await this.#options.brokerProvider.prepareReplacement(command.port);
        await this.#revalidateToken(token);
        await replacement.commit();
        await this.#revalidateToken(token);
      } finally {
        this.#suppressBindingEvents = false;
      }
      const snapshot = await this.#commitExternalResult(token, false, () => {
        this.#options.settings.setMcpPort(command.port);
      });
      return this.#success(command.requestId, { kind: "none" }, snapshot);
    } catch (error) {
      if (replacement !== undefined) {
        try {
          await replacement.rollback();
          this.#options.settings.setMcpPort(previousPort);
        } catch (rollbackError) {
          try {
            this.#options.settings.setMcpPort(this.#options.brokerProvider.configuredPort());
          } catch {
            // The recovery snapshot still exposes the repository's durable value.
          }
          recoverySnapshot = await this.#enqueue(async () => {
            if (this.#disposed) return undefined;
            return this.#publishCommit();
          });
          error = new AggregateError([error, rollbackError], "Studio MCP port replacement rollback failed.");
        }
      }
      if (token !== undefined) await this.#releaseToken(token);
      return this.#failure(command.requestId, error, "mcp", recoverySnapshot);
    }
  }

  async #simpleMutation(
    command: Extract<DesktopCommand, { readonly expectedRevision: number }>,
    mutate: () => void,
  ): Promise<DesktopResponse> {
    try {
      return await this.#enqueue(async () => {
        this.#assertAlive();
        this.#assertRevision(command.expectedRevision);
        if (this.#activeToken !== undefined)
          throw fault("operation-in-progress", "app", "Another desktop operation is still in progress.");
        mutate();
        const snapshot = this.#publishCommit();
        return this.#success(command.requestId, { kind: "none" }, snapshot);
      });
    } catch (error) {
      return this.#failure(command.requestId, error);
    }
  }

  async #reserve(expectedRevision: number, projectId?: string): Promise<OperationToken> {
    return this.#enqueue(async () => {
      this.#assertAlive();
      this.#assertRevision(expectedRevision);
      if (this.#activeToken !== undefined) {
        throw fault("operation-in-progress", "app", "Another desktop operation is still in progress.");
      }
      const token: OperationToken = {
        identity: {},
        revision: this.#revision,
        ...(projectId === undefined ? {} : { projectId }),
        cancelled: false,
      };
      this.#activeToken = token;
      return token;
    });
  }

  async #commitExternalResult(
    token: OperationToken,
    changedObservableState: boolean,
    commit: () => void,
  ): Promise<DesktopSnapshot> {
    return this.#enqueue(async () => {
      if (!this.#tokenCurrent(token)) {
        if (changedObservableState) {
          commit();
          const recovered = this.#publishCommit();
          throw new RecoveryFault(recovered);
        }
        throw fault(
          "operation-cancelled",
          "app",
          "The operation was cancelled because desktop state changed.",
          "retry",
          "Retry",
        );
      }
      commit();
      this.#activeToken = undefined;
      return this.#publishCommit();
    });
  }

  async #commitCatalogResult(
    token: OperationToken,
    catalogs: ReadonlyMap<string, StudioCatalogSnapshot | undefined>,
    commitCurrent: () => void,
  ): Promise<DesktopSnapshot> {
    return this.#enqueue(async () => {
      if (!this.#tokenCurrent(token)) {
        const recovered = this.#recoverRetainedCatalogs(catalogs);
        if (recovered !== undefined) throw new RecoveryFault(recovered);
        throw fault(
          "operation-cancelled",
          "app",
          "The operation was cancelled because desktop state changed.",
          "retry",
          "Retry",
        );
      }
      this.#applyCatalogProjections(catalogs);
      commitCurrent();
      this.#activeToken = undefined;
      return this.#publishCommit();
    });
  }

  async #revalidateCatalogToken(
    token: OperationToken,
    catalogs: ReadonlyMap<string, StudioCatalogSnapshot | undefined>,
  ): Promise<void> {
    await this.#enqueue(async () => {
      if (this.#tokenCurrent(token)) return;
      const recovered = this.#recoverRetainedCatalogs(catalogs);
      if (recovered !== undefined) throw new RecoveryFault(recovered);
      this.#assertTokenCurrent(token);
    });
  }

  #recoverRetainedCatalogs(
    catalogs: ReadonlyMap<string, StudioCatalogSnapshot | undefined>,
  ): DesktopSnapshot | undefined {
    const retained = new Map([...catalogs].filter(([projectId]) => this.#pollingReleases.has(projectId)));
    if (retained.size === 0) return undefined;
    this.#applyCatalogProjections(retained);
    return this.#publishCommit();
  }

  async #releaseToken(token: OperationToken): Promise<void> {
    await this.#enqueue(async () => {
      if (this.#activeToken === token) this.#activeToken = undefined;
    });
  }

  #assertTokenCurrent(token: OperationToken): void {
    if (!this.#tokenCurrent(token)) {
      throw fault(
        "operation-cancelled",
        "app",
        "The operation was cancelled because desktop state changed.",
        "retry",
        "Retry",
      );
    }
  }

  async #revalidateToken(token: OperationToken): Promise<void> {
    await this.#enqueue(async () => this.#assertTokenCurrent(token));
  }

  #tokenCurrent(token: OperationToken): boolean {
    return !this.#disposed && !token.cancelled && this.#activeToken === token && token.revision === this.#revision;
  }

  #cancelActive(projectId?: string): void {
    const active = this.#activeToken;
    if (active === undefined) return;
    if (projectId === undefined || active.projectId === undefined || active.projectId === projectId)
      active.cancelled = true;
  }

  async #enqueueInvalidation(projectId: string, reason: string): Promise<void> {
    await this.#enqueue(async () => {
      if (this.#disposed) return;
      this.#cancelActive(projectId);
      this.#runtimeStates.set(projectId, "needs-reconnect");
      this.#publishCommit();
      void reason;
    });
  }

  async #disconnectOwned(projectId: string, reason: string, disposeWatcher: boolean): Promise<unknown[]> {
    const failures: unknown[] = [];
    this.#suppressBindingEvents = true;
    failures.push(...(await settleCleanupStage([() => this.#options.bindings.release(projectId)])));
    this.#suppressBindingEvents = false;
    const polling = this.#pollingReleases.get(projectId);
    if (polling !== undefined) {
      this.#pollingReleases.delete(projectId);
      failures.push(...(await settleCleanupStage([polling])));
    }
    const lease = this.#brokerLeases.get(projectId);
    if (lease !== undefined) {
      this.#brokerLeases.delete(projectId);
      let finalLease = true;
      try {
        finalLease = this.#options.brokerProvider.current().snapshot().referenceCount <= 1;
      } catch (error) {
        failures.push(error);
      }
      if (finalLease) {
        this.#suppressBindingEvents = true;
        failures.push(...(await settleCleanupStage([() => this.#options.bindings.invalidateAll(reason)])));
        this.#suppressBindingEvents = false;
      }
      const releaseFailures = await settleCleanupStage([() => lease.release()]);
      if (releaseFailures.length > 0) {
        this.#unreleasedBrokerLeases.add(lease);
        failures.push(...releaseFailures);
      }
    }
    failures.push(...(await settleCleanupStage([() => this.#options.runtimes.disconnect(projectId)])));
    if (disposeWatcher) {
      const watcher = this.#watchers.get(projectId);
      this.#watchers.delete(projectId);
      if (watcher !== undefined) {
        failures.push(...(await settleCleanupStage([() => watcher.dispose()])));
      }
    }
    this.#rojoExecutables.delete(projectId);
    this.#catalogs.delete(projectId);
    return failures;
  }

  async #cleanupConnect(
    projectId: string,
    acquired: {
      readonly acquiredRojo: boolean;
      readonly acquiredLease?: StudioBrokerLease;
      readonly acquiredPolling?: () => void;
      readonly replacementWatcher?: ProjectWatchLease;
      readonly previousContext?: RecapturedProjectContext;
      readonly restoreWatcherFor?: ProjectRef;
    },
  ): Promise<unknown[]> {
    const failures: unknown[] = [];
    if (acquired.replacementWatcher !== undefined) {
      failures.push(...(await settleCleanupStage([() => acquired.replacementWatcher?.dispose()])));
    }
    if (acquired.acquiredPolling !== undefined) {
      failures.push(...(await settleCleanupStage([acquired.acquiredPolling])));
    }
    if (acquired.acquiredLease !== undefined) {
      const releaseFailures = await settleCleanupStage([() => acquired.acquiredLease?.release()]);
      if (releaseFailures.length > 0) {
        this.#unreleasedBrokerLeases.add(acquired.acquiredLease);
        failures.push(...releaseFailures);
      }
    }
    if (acquired.acquiredRojo) {
      failures.push(...(await settleCleanupStage([() => this.#options.runtimes.disconnect(projectId)])));
    }
    if (acquired.previousContext !== undefined) {
      failures.push(
        ...(await settleCleanupStage([() => this.#options.bindings.updateProjectContext(acquired.previousContext!)])),
      );
    }
    if (acquired.restoreWatcherFor !== undefined) {
      try {
        this.#watchers.set(projectId, this.#startWatcher(acquired.restoreWatcherFor));
      } catch (error) {
        failures.push(error);
      }
    }
    return failures;
  }

  async #publishConnectRecovery(projectId: string): Promise<DesktopSnapshot | undefined> {
    return this.#enqueue(async () => {
      if (this.#disposed || this.#options.projects.findById(projectId) === undefined) return undefined;
      this.#runtimeStates.set(projectId, "needs-reconnect");
      this.#catalogs.delete(projectId);
      return this.#publishCommit();
    });
  }

  async #publishConnectFailure(
    token: OperationToken,
    projectId: string,
    error: unknown,
  ): Promise<DesktopSnapshot | undefined> {
    return this.#enqueue(async () => {
      if (this.#disposed || this.#options.projects.findById(projectId) === undefined || !this.#tokenCurrent(token)) {
        return undefined;
      }
      this.#activeToken = undefined;
      this.#runtimeStates.set(projectId, "error");
      this.#runtimeErrors.set(projectId, normalizeError(error, "app"));
      this.#catalogs.delete(projectId);
      return this.#publishCommit();
    });
  }

  async #refreshBindingCatalog(
    additionalProjectIds: readonly string[],
  ): Promise<ReadonlyMap<string, StudioCatalogSnapshot | undefined>> {
    this.#suppressBindingChangeEvents = true;
    try {
      await this.#options.bindings.refreshCatalog();
      const projectIds = new Set([...this.#pollingReleases.keys(), ...additionalProjectIds]);
      return new Map(
        [...projectIds].map((projectId) => [projectId, this.#options.bindings.snapshot(projectId).catalog]),
      );
    } finally {
      this.#suppressBindingChangeEvents = false;
    }
  }

  #applyCatalogProjections(catalogs: ReadonlyMap<string, StudioCatalogSnapshot | undefined>): void {
    for (const [projectId, catalog] of catalogs) {
      if (catalog === undefined) this.#catalogs.delete(projectId);
      else this.#catalogs.set(projectId, catalog);
    }
  }

  #adoptProject(project: ProjectRecord): void {
    if (!this.#projectRefs.has(project.id)) {
      const ref = refFromRecord(project, 1);
      this.#projectRefs.set(project.id, ref);
      this.#options.bindings.updateProjectContext({
        project: ref,
        servePlaceIds: project.servePlaceIds,
      });
      this.#runtimeStates.set(project.id, "disconnected");
      this.#watchers.set(project.id, this.#startWatcher(ref));
    }
  }

  #startWatcher(ref: ProjectRef): ProjectWatchLease {
    const invalidate = (projectId: string, reason: string): void => {
      if (this.#disposed) return;
      void this.#enqueue(async () => {
        if (this.#disposed) return;
        this.#cancelActive(projectId);
        this.#suppressBindingEvents = true;
        try {
          this.#options.bindings.invalidateProject(projectId, reason);
        } finally {
          this.#suppressBindingEvents = false;
        }
        this.#runtimeStates.set(projectId, "needs-reconnect");
        this.#publishCommit();
      });
    };
    try {
      return this.#options.createWatcher(ref, invalidate);
    } catch {
      invalidate(ref.projectId, "project-unreadable");
      return INERT_PROJECT_WATCH_LEASE;
    }
  }

  #requireProject(projectId: string): ProjectRecord {
    const project = this.#options.projects.findById(projectId);
    if (project === undefined) throw fault("project-not-found", "project", "The project no longer exists.");
    return project;
  }

  #requireOwnedThread(projectId: string, threadId: string): ThreadRecord {
    this.#requireProject(projectId);
    const thread = this.#options.conversations.listThreads(projectId).find((item) => item.id === threadId);
    if (thread === undefined)
      throw fault("thread-not-owned", "storage", "The conversation does not belong to this project.");
    return thread;
  }

  #assertRevision(expectedRevision: number): void {
    if (expectedRevision !== this.#revision) {
      throw fault("stale-command", "app", "The desktop state changed. Refresh and try again.", "retry", "Retry");
    }
  }

  #assertAlive(): void {
    if (this.#disposed) throw fault("app-disposed", "app", "The desktop host is shutting down.");
  }

  #publishCommit(): DesktopSnapshot {
    this.#revision += 1;
    const snapshot = this.#buildSnapshot();
    this.#snapshot = snapshot;
    if (!this.#disposed) {
      for (const listener of [...this.#listeners]) {
        try {
          listener(snapshot);
        } catch {
          // Listener failures cannot roll back committed application state.
        }
      }
    }
    return snapshot;
  }

  #buildSnapshot(): DesktopSnapshot {
    const projects = this.#options.projects.list();
    const threads = projects.flatMap((project) => this.#options.conversations.listThreads(project.id));
    const messages = threads.flatMap((thread) => this.#options.conversations.listMessages(thread.id));
    const drafts = threads.flatMap((thread) => {
      const draft = this.#options.conversations.loadDraft(thread.id);
      return draft === undefined ? [] : [draft];
    });
    const selectedThreadIdByProject = Object.fromEntries(
      projects.flatMap((project) => {
        const selected = this.#options.conversations.selectedThreadId(project.id);
        return selected === undefined ? [] : [[project.id, selected]];
      }),
    );
    const runtimeByProject = Object.fromEntries(
      projects.map((project) => [project.id, this.#runtimeSnapshot(project.id)]),
    );
    const raw = {
      revision: this.#revision,
      projects,
      threads,
      messages,
      drafts,
      ...(this.#options.projects.selectedProjectId() === undefined
        ? {}
        : { selectedProjectId: this.#options.projects.selectedProjectId() }),
      selectedThreadIdByProject,
      runtimeByProject,
      settings: {
        preferredMcpPort: this.#options.settings.getMcpPort() ?? DEFAULT_MCP_PORT,
        sidebarWidth: this.#options.settings.getSidebarWidth() ?? DEFAULT_SIDEBAR_WIDTH,
        mcpPortChangeAllowed:
          this.#brokerLeases.size === 0 &&
          this.#unreleasedBrokerLeases.size === 0 &&
          this.#options.brokerProvider.current().snapshot().referenceCount === 0,
      },
    };
    return deepFreeze(desktopSnapshotSchema.parse(raw)) as unknown as DesktopSnapshot;
  }

  #runtimeSnapshot(projectId: string): RuntimeSnapshot {
    const activeProject = this.#projectRefs.get(projectId);
    if (activeProject === undefined) {
      throw fault("project-identity-missing", "project", "The active project identity is unavailable.");
    }
    const override = this.#runtimeStates.get(projectId);
    const runtime = this.#options.runtimes.snapshot(projectId);
    const binding = this.#options.bindings.snapshot(projectId);
    const catalog = this.#catalogs.get(projectId);
    const brokerLease = this.#brokerLeases.get(projectId);
    const brokerSnapshot = this.#options.brokerProvider.current().snapshot();
    const state =
      override ??
      (binding.state !== "disconnected"
        ? binding.state
        : runtime?.state === "starting"
          ? "starting-rojo"
          : runtime?.state === "ready" && catalog !== undefined
            ? "studio-selection-required"
            : runtime?.state === "ready"
              ? "rojo-server-ready"
              : "needs-reconnect");
    const executable = this.#rojoExecutables.get(projectId);
    const studio =
      binding.binding === undefined
        ? undefined
        : catalog?.instances.find((row) => row.instanceId === binding.binding?.studio.instanceId);
    const bindingRevision = binding.pending?.bindingRevision ?? binding.binding?.bindingRevision;
    const runtimeError = this.#runtimeErrors.get(projectId);
    return {
      state,
      detail: state === "error" && runtimeError !== undefined ? runtimeError.message : runtimeDetail(state),
      activeProject: {
        revision: activeProject.revision,
        canonicalProjectFile: activeProject.canonicalProjectFile,
        relativeProjectFile: relative(activeProject.canonicalRoot, activeProject.canonicalProjectFile),
        configDigest: activeProject.configDigest,
      },
      studioMcp: {
        serverVersion: AUDITED_STUDIO_PLUGIN.version,
      },
      ...(runtime?.state === "ready" && runtime.lease !== undefined && executable !== undefined
        ? {
            rojo: {
              port: runtime.lease.port,
              generation: runtime.lease.generation,
              executablePath: executable.path,
              version: executable.version,
            },
          }
        : {}),
      ...(brokerLease === undefined
        ? {}
        : {
            broker: {
              state: brokerSnapshot.state,
              primaryPort: brokerLease.ready.primaryPort,
              ...(brokerLease.ready.legacyPort === undefined ? {} : { legacyPort: brokerLease.ready.legacyPort }),
              legacyStatus: brokerLease.ready.legacyStatus,
              brokerEpoch: brokerLease.ready.brokerEpoch,
            },
          }),
      ...(studio === undefined
        ? {}
        : {
            studio: {
              instanceId: studio.instanceId,
              placeId: studio.placeId,
              placeName: studio.placeName,
              dataModelName: studio.dataModelName,
              role: studio.role,
              pluginVariant: studio.pluginVariant,
              pluginVersion: studio.pluginVersion,
              serverVersion: studio.serverVersion,
              connectedAt: studio.connectedAt,
              lastActivity: studio.lastActivity,
            },
          }),
      ...(binding.pending === undefined
        ? {}
        : {
            pending: {
              instanceId: binding.pending.instanceId,
              catalogRevision: binding.pending.catalogRevision,
              bindingRevision: binding.pending.bindingRevision,
              rojoHandoffRequired: true as const,
            },
          }),
      catalog: catalog?.instances ?? [],
      ...(catalog === undefined ? {} : { catalogRevision: catalog.revision }),
      ...(bindingRevision === undefined ? {} : { bindingRevision }),
      ...(runtimeError === undefined ? {} : { error: runtimeError }),
      samePublishedPlaceLimitation: binding.samePublishedPlaceLimitation || LIMITATION,
    };
  }

  #success(
    requestId: string,
    result: DesktopResult = { kind: "none" },
    snapshot: DesktopSnapshot = this.#currentSnapshot(),
  ): DesktopResponse {
    return {
      version: 1,
      requestId,
      ok: true,
      snapshot,
      result,
    } as DesktopResponse;
  }

  #failure(
    requestId: string,
    error: unknown,
    fallbackLayer: DesktopError["layer"] = "app",
    snapshot?: DesktopSnapshot,
  ): DesktopResponse {
    const recovery = error instanceof RecoveryFault ? error.snapshot : snapshot;
    return {
      version: 1,
      requestId,
      ok: false,
      snapshot: recovery ?? this.#currentSnapshot(),
      error: normalizeError(error, fallbackLayer),
    } as DesktopResponse;
  }

  #currentSnapshot(): DesktopSnapshot {
    if (this.#snapshot === undefined) throw new Error("Desktop controller is not initialized.");
    return this.#snapshot;
  }

  #detachSubscriptions(): unknown[] {
    if (this.#subscriptionsDetached) return [];
    this.#subscriptionsDetached = true;
    const failures: unknown[] = [];
    for (const remove of [
      this.#removeBindingSubscription,
      this.#removeBindingChangeSubscription,
      this.#removeRuntimeSubscription,
      this.#removeBrokerSubscription,
    ]) {
      try {
        remove?.();
      } catch (error) {
        failures.push(error);
      }
    }
    this.#removeBindingSubscription = undefined;
    this.#removeBindingChangeSubscription = undefined;
    this.#removeRuntimeSubscription = undefined;
    this.#removeBrokerSubscription = undefined;
    return failures;
  }

  #enqueue<T>(work: () => T | Promise<T>): Promise<T> {
    const result = this.#transitionTail.then(work, work);
    this.#transitionTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

const INERT_PROJECT_WATCH_LEASE: ProjectWatchLease = Object.freeze({
  checkNow: () => Promise.resolve(),
  dispose: () => Promise.resolve(),
});

class RecoveryFault extends ControllerFault {
  constructor(readonly snapshot: DesktopSnapshot) {
    super(
      "operation-cancelled",
      "app",
      "The operation was cancelled after runtime state changed.",
      "reconnect",
      "Reconnect",
    );
  }
}

function refFromRecord(project: ProjectRecord, revision: number): ProjectRef {
  return Object.freeze({
    projectId: project.id,
    canonicalRoot: project.canonicalRoot,
    rootDevice: project.rootDevice,
    rootInode: project.rootInode,
    canonicalProjectFile: project.canonicalProjectFile,
    projectFileDevice: project.projectFileDevice,
    projectFileInode: project.projectFileInode,
    configDigest: project.configDigest,
    revision,
  });
}

function projectPluginInspection(inspection: PluginInspection | PluginInstallResult): PluginInspectionView {
  return {
    state: inspection.state,
    sourcePath: inspection.sourcePath,
    destinationPath: inspection.destinationPath,
    ...(inspection.sourceSha256 === undefined ? {} : { sourceSha256: inspection.sourceSha256 }),
    ...(inspection.destinationSha256 === undefined ? {} : { destinationSha256: inspection.destinationSha256 }),
    restartRequired: inspection.restartRequired,
    detail: inspection.detail,
  };
}

function runtimeDetail(state: RuntimeSnapshot["state"]): string {
  switch (state) {
    case "needs-reconnect":
      return "Reconnect this project to verify Rojo and Studio.";
    case "disconnected":
      return "Project runtime is disconnected.";
    case "studio-selection-required":
      return "Choose the exact open Studio instance.";
    case "rojo-server-ready":
      return "Rojo is ready; confirm the Studio handoff.";
    case "studio-bound":
      return "Rojo and the selected Studio instance are bound.";
    case "error":
      return "The runtime needs attention.";
    default:
      return "Runtime state updated.";
  }
}

function fault(
  code: string,
  layer: DesktopError["layer"],
  message: string,
  recoveryAction: RecoveryAction = "none",
  recoveryLabel = "Dismiss",
): ControllerFault {
  return new ControllerFault(code, layer, message, recoveryAction, recoveryLabel);
}

function normalizeError(error: unknown, fallbackLayer: DesktopError["layer"]): DesktopError {
  if (error instanceof ControllerFault) {
    return toDesktopError({
      layer: error.layer,
      code: error.code,
      message: error.message,
      recovery: { action: error.recoveryAction, label: error.recoveryLabel },
    });
  }
  const coded =
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[a-z0-9-]{1,80}$/.test(error.code)
      ? error.code
      : "operation-failed";
  return toDesktopError({
    layer: fallbackLayer,
    code: coded,
    message: safeErrorMessage(fallbackLayer),
    recovery: { action: "retry", label: "Retry" },
  });
}

async function settleCleanupStage(work: readonly (() => unknown | Promise<unknown>)[]): Promise<readonly unknown[]> {
  const results = await Promise.allSettled(work.map((run) => Promise.resolve().then(run)));
  return results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
}

function safeErrorMessage(layer: DesktopError["layer"]): string {
  switch (layer) {
    case "project":
      return "The project operation could not be completed.";
    case "storage":
      return "Local desktop data could not be updated.";
    case "rojo":
      return "The Rojo operation could not be completed.";
    case "mcp":
      return "The Studio MCP operation could not be completed.";
    case "studio":
      return "The Studio operation could not be completed.";
    case "plugin":
      return "The Studio plugin operation could not be completed.";
    case "ipc":
      return "The desktop request could not be completed.";
    case "app":
      return "The desktop operation could not be completed.";
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value)) deepFreeze(nested);
  return value;
}
