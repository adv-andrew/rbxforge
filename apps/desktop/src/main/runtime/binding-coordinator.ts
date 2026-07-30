import type { StudioInstance, StudioMcpService } from "@rbxforge/studio-mcp";
import type {
  ProjectBinding,
  ProjectRef,
  ProjectRuntimeState,
  RojoLease,
  StudioCatalogRow,
  StudioConnectionRef,
  StudioEligibilityReason,
} from "../../shared/domain.js";
import type { ProjectRuntimeRegistry, ProjectRuntimeSnapshot } from "./project-runtime-registry.js";
import type { StudioBrokerController, StudioBrokerReady } from "./studio-broker-controller.js";
import { eligibleStudioInstance, type StudioEligibility } from "./studio-eligibility.js";
import { AUDITED_STUDIO_PLUGIN } from "./studio-plugin-installer.js";

const PINNED_STUDIO_MCP_VERSION = AUDITED_STUDIO_PLUGIN.version;
const POLL_INTERVAL_MS = 2_000;
const MAX_FRESHNESS_MS = 5_000;
const MAX_FUTURE_SKEW_MS = 1_000;
const FAILURE_INVALIDATION_COUNT = 3;
const FAILURE_INVALIDATION_AGE_MS = 6_000;

export const SAME_PUBLISHED_PLACE_LIMITATION =
  "RbxForge cannot detect or distinguish two Studio edit windows for the same published place. Keep only one such window open before binding.";

export interface StudioCatalogSnapshot {
  readonly brokerEpoch: string;
  readonly revision: number;
  readonly observedAt: number;
  readonly failures: number;
  readonly instances: readonly StudioCatalogRow[];
}

export interface PendingBinding {
  readonly projectId: string;
  readonly bindingRevision: number;
  readonly catalogRevision: number;
  readonly instanceId: string;
  readonly rojoHandoffRequired: true;
}

export interface BindingSnapshot {
  readonly state: ProjectRuntimeState;
  readonly catalog?: StudioCatalogSnapshot;
  readonly pending?: PendingBinding;
  readonly binding?: ProjectBinding;
  readonly invalidationReason?: string;
  readonly samePublishedPlaceLimitation: string;
}

export interface BindingProjectContext {
  readonly project: ProjectRef;
  readonly servePlaceIds: readonly number[];
}

export interface BindingCoordinatorOptions {
  readonly projectContext: (projectId: string) => BindingProjectContext;
  readonly runtimes: Pick<ProjectRuntimeRegistry, "snapshot" | "assertCurrent">;
  readonly broker: () => Pick<StudioBrokerController, "snapshot" | "service">;
  readonly now?: () => number;
  readonly createId?: () => string;
  readonly setInterval?: (callback: () => void, milliseconds: number) => unknown;
  readonly clearInterval?: (handle: unknown) => void;
  readonly onInvalidated?: (projectId: string, reason: string) => void;
}

export interface SelectStudioInput {
  readonly projectId: string;
  readonly instanceId: string;
  readonly catalogRevision: number;
  readonly warningAccepted: boolean;
}

export interface ConfirmRojoHandoffInput {
  readonly projectId: string;
  readonly bindingRevision: number;
}

interface RawCatalog {
  readonly brokerEpoch: string;
  readonly revision: number;
  readonly observedAt: number;
  readonly failures: number;
  readonly instances: readonly StudioInstance[];
  readonly byId: ReadonlyMap<string, StudioInstance>;
}

interface ActiveBinding {
  readonly project: ProjectRef;
  readonly servePlaceIds: readonly number[];
  readonly rojo: RojoLease;
  readonly studio: StudioConnectionRef;
  readonly claimKey: string;
  readonly warning?: "unknown-place" | "unpublished-place";
  readonly pending: PendingBinding;
  readonly binding?: ProjectBinding;
}

interface CurrentTuple {
  readonly context: BindingProjectContext;
  readonly rojo: RojoLease;
  readonly catalog: RawCatalog;
  readonly instance: StudioInstance;
  readonly eligibility: Extract<StudioEligibility, { readonly eligible: true }>;
}

interface RefreshAttempt {
  readonly generation: number;
  readonly startedAt: number;
  readonly deadlineBaseAt: number;
  promise?: Promise<StudioCatalogSnapshot>;
}

export class BindingCoordinator {
  readonly #options: BindingCoordinatorOptions;
  readonly #now: () => number;
  readonly #createId: () => string;
  readonly #setInterval: (callback: () => void, milliseconds: number) => unknown;
  readonly #clearInterval: (handle: unknown) => void;
  readonly #active = new Map<string, ActiveBinding>();
  readonly #claims = new Map<string, string>();
  #bindingRevision = 0;
  readonly #invalidationReasons = new Map<string, string>();
  readonly #warningAcceptances = new Set<string>();
  readonly #projectContextOverrides = new Map<string, BindingProjectContext>();
  readonly #externalReferences = new Set<object>();
  readonly #invalidationListeners = new Set<(projectId: string, reason: string) => void>();
  readonly #changeListeners = new Set<() => void>();
  readonly #mutex = new AsyncMutex();
  #catalog: RawCatalog | undefined;
  #catalogRevision = 0;
  #failures = 0;
  #refreshAttempt: RefreshAttempt | undefined;
  #refreshGeneration = 0;
  #pollHandle: unknown;
  #routeActive = false;
  #selectedOwner: string | undefined;
  #deferredClearOwner: string | undefined;
  #disposed = false;
  #disposePromise: Promise<void> | undefined;
  #lifecycleRevision = 0;

  constructor(options: BindingCoordinatorOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#createId = options.createId ?? (() => crypto.randomUUID());
    this.#setInterval =
      options.setInterval ?? ((callback, milliseconds) => globalThis.setInterval(callback, milliseconds));
    this.#clearInterval =
      options.clearInterval ??
      ((handle) => globalThis.clearInterval(handle as ReturnType<typeof globalThis.setInterval>));
    if (options.onInvalidated !== undefined) {
      this.#invalidationListeners.add(options.onInvalidated);
    }
  }

  subscribeInvalidation(listener: (projectId: string, reason: string) => void): () => void {
    this.assertNotDisposed();
    this.#invalidationListeners.add(listener);
    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      this.#invalidationListeners.delete(listener);
    };
  }

  subscribeChange(listener: () => void): () => void {
    this.assertNotDisposed();
    this.#changeListeners.add(listener);
    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      this.#changeListeners.delete(listener);
    };
  }

  updateProjectContext(context: BindingProjectContext): void {
    this.assertNotDisposed();
    const projectId = context.project.projectId;
    const frozen = Object.freeze({
      project: context.project,
      servePlaceIds: Object.freeze([...context.servePlaceIds]),
    });
    const active = this.#active.get(projectId);
    this.#projectContextOverrides.set(projectId, frozen);
    if (
      active !== undefined &&
      (!sameProject(active.project, frozen.project) || !sameNumberSet(active.servePlaceIds, frozen.servePlaceIds))
    ) {
      this.invalidateProject(projectId, "project-context-changed");
    }
  }

  removeProjectContext(projectId: string): void {
    this.#projectContextOverrides.delete(projectId);
  }

  acquire(_projectId: string): () => void {
    this.assertNotDisposed();
    const token = {};
    this.#externalReferences.add(token);
    this.syncPolling();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#externalReferences.delete(token);
      this.syncPolling();
    };
  }

  refreshCatalog(): Promise<StudioCatalogSnapshot> {
    this.assertNotDisposed();
    const current = this.#refreshAttempt;
    if (current?.promise !== undefined) return current.promise;
    const lifecycleRevision = this.#lifecycleRevision;
    const refreshGeneration = ++this.#refreshGeneration;
    const startedAt = this.#now();
    const attempt: RefreshAttempt = {
      generation: refreshGeneration,
      startedAt,
      deadlineBaseAt: this.#catalog?.observedAt ?? startedAt,
    };
    const refresh = this.performRefresh(lifecycleRevision, attempt.generation).finally(() => {
      if (this.#refreshAttempt === attempt) this.#refreshAttempt = undefined;
    });
    attempt.promise = refresh;
    this.#refreshAttempt = attempt;
    return refresh;
  }

  selectStudio(input: SelectStudioInput): PendingBinding {
    this.assertNotDisposed();
    if (this.#routeActive) throw new Error("Studio route is busy; wait for the current operation to finish.");
    const tuple = this.currentTuple(input.projectId, input.instanceId, input.catalogRevision);
    if (this.isAmbiguous(tuple.instance, tuple.context.servePlaceIds, tuple.catalog)) {
      throw new Error("Studio catalog is ambiguous for this published place.");
    }
    const warning = tuple.eligibility.warning;
    const warningKey =
      warning === undefined ? undefined : this.warningKey(input.projectId, tuple.context.project.revision, warning);
    if (warningKey !== undefined && !input.warningAccepted && !this.#warningAcceptances.has(warningKey)) {
      throw new Error(`Studio selection requires ${warning} warning acceptance.`);
    }

    const claimKey = connectionClaimKey(
      tuple.catalog.brokerEpoch,
      tuple.instance.instanceId,
      tuple.instance.connectedAt,
    );
    const claimedBy = this.#claims.get(claimKey);
    if (claimedBy !== undefined && claimedBy !== input.projectId) {
      throw new Error("This Studio connection is already claimed by another project.");
    }

    let service: StudioMcpService | undefined;
    let retargeted = false;
    try {
      service = this.broker().service();
      const selected = service.selectInstance(tuple.instance.instanceId);
      retargeted = true;
      assertSameSelectedInstance(tuple.instance, selected);
    } catch (error) {
      if (retargeted) {
        try {
          service?.clearSelectedInstance();
        } catch {
          // A failed or stopped service already has no trustworthy selection.
        }
        this.#selectedOwner = undefined;
      }
      this.invalidateProject(input.projectId, invalidationReasonFor(error));
      throw error;
    }

    const previous = this.#active.get(input.projectId);
    if (previous !== undefined && previous.claimKey !== claimKey) {
      this.#claims.delete(previous.claimKey);
    }
    const bindingRevision = this.nextBindingRevision(input.projectId);
    const pending = freezePending({
      projectId: input.projectId,
      bindingRevision,
      catalogRevision: tuple.catalog.revision,
      instanceId: tuple.instance.instanceId,
      rojoHandoffRequired: true,
    });
    const active = freezeActive({
      project: tuple.context.project,
      servePlaceIds: tuple.context.servePlaceIds,
      rojo: tuple.rojo,
      studio: connectionRef(tuple.catalog, tuple.instance),
      claimKey,
      ...(warning === undefined ? {} : { warning }),
      pending,
    });
    this.#claims.set(claimKey, input.projectId);
    this.#active.set(input.projectId, active);
    this.#selectedOwner = input.projectId;
    this.#invalidationReasons.delete(input.projectId);
    if (warningKey !== undefined && input.warningAccepted) {
      this.#warningAcceptances.add(warningKey);
    }
    this.syncPolling();
    return pending;
  }

  confirmRojoHandoff(input: ConfirmRojoHandoffInput): ProjectBinding {
    this.assertNotDisposed();
    if (this.#routeActive) throw new Error("Studio route is busy; wait for the current operation to finish.");
    const active = this.#active.get(input.projectId);
    if (active === undefined || active.pending.bindingRevision !== input.bindingRevision) {
      throw new Error("Pending Studio binding is not current.");
    }
    try {
      this.assertActiveCurrent(input.projectId, active, input.bindingRevision);
      const selected = this.broker().service().selectInstance(active.studio.instanceId);
      assertSameConnection(active.studio, selected);
    } catch (error) {
      this.invalidateProject(input.projectId, invalidationReasonFor(error));
      throw error;
    }
    this.#selectedOwner = input.projectId;
    const binding: ProjectBinding = Object.freeze({
      bindingId: this.#createId(),
      bindingRevision: active.pending.bindingRevision,
      project: active.project,
      rojo: active.rojo,
      studio: active.studio,
      rojoHandoffConfirmedAt: this.#now(),
    });
    const bound = freezeActive({ ...active, binding });
    this.#active.set(input.projectId, bound);
    return binding;
  }

  assertCurrent(projectId: string, bindingRevision: number): ProjectBinding {
    this.assertNotDisposed();
    const active = this.#active.get(projectId);
    if (active === undefined || active.binding === undefined || active.binding.bindingRevision !== bindingRevision) {
      throw new Error("Studio binding is not current; reconnect the project.");
    }
    try {
      this.assertActiveCurrent(projectId, active, bindingRevision);
      return active.binding;
    } catch (error) {
      this.invalidateProject(projectId, invalidationReasonFor(error));
      throw error;
    }
  }

  async withBinding<T>(
    projectId: string,
    bindingRevision: number,
    operation: (service: StudioMcpService, expectedInstanceId: string) => Promise<T>,
  ): Promise<T> {
    this.assertNotDisposed();
    const release = await this.#mutex.acquire();
    this.#routeActive = true;
    try {
      this.assertNotDisposed();
      const binding = this.assertCurrent(projectId, bindingRevision);
      const service = this.broker().service();
      try {
        const selected = service.selectInstance(binding.studio.instanceId);
        assertSameConnection(binding.studio, selected);
      } catch (error) {
        this.invalidateProject(projectId, "studio-identity-changed");
        throw error;
      }
      this.#selectedOwner = projectId;
      const result = await operation(service, binding.studio.instanceId);
      this.assertNotDisposed();
      const after = this.assertCurrent(projectId, bindingRevision);
      if (after.bindingId !== binding.bindingId) {
        throw new Error("Studio binding changed while the operation was in flight.");
      }
      return result;
    } finally {
      this.#routeActive = false;
      this.flushDeferredClear();
      release();
    }
  }

  release(projectId: string): void {
    const active = this.#active.get(projectId);
    if (active !== undefined) {
      this.#active.delete(projectId);
      this.#claims.delete(active.claimKey);
      this.nextBindingRevision(projectId);
      this.clearSelectionIfOwned(projectId);
    }
    this.#invalidationReasons.delete(projectId);
    this.syncPolling();
  }

  invalidateProject(projectId: string, reason: string): void {
    const active = this.#active.get(projectId);
    if (active !== undefined) {
      this.#active.delete(projectId);
      this.#claims.delete(active.claimKey);
    }
    this.nextBindingRevision(projectId);
    this.#invalidationReasons.set(projectId, reason);
    this.clearSelectionIfOwned(projectId);
    this.syncPolling();
    for (const listener of [...this.#invalidationListeners]) {
      try {
        listener(projectId, reason);
      } catch {
        // An observer cannot preserve or revive an invalidated binding.
      }
    }
  }

  invalidateAll(reason: string): void {
    const projectIds = new Set([...this.#active.keys(), ...this.#invalidationReasons.keys()]);
    for (const projectId of projectIds) this.invalidateProject(projectId, reason);
  }

  snapshot(projectId: string): BindingSnapshot {
    const active = this.#active.get(projectId);
    const invalidationReason = this.#invalidationReasons.get(projectId);
    const catalog = this.projectCatalog(projectId);
    const catalogState =
      catalog === undefined
        ? "disconnected"
        : catalog.instances.length === 0
          ? "waiting-for-studio"
          : catalog.instances.some((row) => row.eligibilityReason === "catalog-ambiguous")
            ? "catalog-ambiguous"
            : catalog.instances.every((row) => !row.eligible && row.eligibilityReason === "project-mismatch")
              ? "project-mismatch"
              : "studio-selection-required";
    const state: ProjectRuntimeState =
      invalidationReason !== undefined
        ? "needs-reconnect"
        : active?.binding !== undefined
          ? "studio-bound"
          : active !== undefined
            ? "rojo-server-ready"
            : catalogState;
    return Object.freeze({
      state,
      ...(catalog === undefined ? {} : { catalog }),
      ...(active === undefined ? {} : { pending: active.pending }),
      ...(active?.binding === undefined ? {} : { binding: active.binding }),
      ...(invalidationReason === undefined ? {} : { invalidationReason }),
      samePublishedPlaceLimitation: SAME_PUBLISHED_PLACE_LIMITATION,
    });
  }

  dispose(): Promise<void> {
    if (this.#disposePromise !== undefined) return this.#disposePromise;
    this.#disposed = true;
    this.#lifecycleRevision += 1;
    this.stopPolling();
    this.#invalidationListeners.clear();
    this.#changeListeners.clear();
    this.invalidateAll("disposed");
    const refresh = this.#refreshAttempt?.promise;
    this.#catalog = undefined;
    this.#failures = 0;
    this.#externalReferences.clear();
    this.#projectContextOverrides.clear();
    this.#warningAcceptances.clear();
    this.#disposePromise = (async () => {
      if (refresh !== undefined) await Promise.allSettled([refresh]);
      await this.#mutex.waitForIdle();
      this.flushDeferredClear();
      this.#claims.clear();
      this.#active.clear();
    })();
    return this.#disposePromise;
  }

  private async performRefresh(lifecycleRevision: number, refreshGeneration: number): Promise<StudioCatalogSnapshot> {
    try {
      const before = this.readyBroker();
      const service = this.broker().service();
      const instances = freezeCatalogInstances(await service.listConnectedInstances());
      if (this.#disposed || lifecycleRevision !== this.#lifecycleRevision) {
        throw new Error("Binding coordinator is disposed.");
      }
      if (refreshGeneration !== this.#refreshGeneration) {
        throw new RefreshSupersededError();
      }
      const after = this.readyBroker();
      if (after.brokerEpoch !== before.brokerEpoch) {
        throw new BrokerChangedDuringRefreshError();
      }
      const brokerEpoch = after.brokerEpoch;
      const revision = ++this.#catalogRevision;
      const observedAt = this.#now();
      const byId = new Map(instances.map((instance) => [instance.instanceId, instance]));
      const previousEpoch = this.#catalog?.brokerEpoch;
      const catalog: RawCatalog = Object.freeze({
        brokerEpoch,
        revision,
        observedAt,
        failures: 0,
        instances,
        byId,
      });
      this.#catalog = catalog;
      this.#failures = 0;
      if (previousEpoch !== undefined && previousEpoch !== brokerEpoch) {
        this.invalidateAll("broker-restart");
      } else {
        this.reevaluateActive(catalog);
      }
      for (const listener of [...this.#changeListeners]) {
        try {
          listener();
        } catch {
          // Change observers cannot affect the coordinator's committed catalog.
        }
      }
      return this.publicCatalog(catalog);
    } catch (error) {
      if (this.#disposed || lifecycleRevision !== this.#lifecycleRevision) {
        throw new Error("Binding coordinator is disposed.");
      }
      if (refreshGeneration !== this.#refreshGeneration) {
        throw new RefreshSupersededError();
      }
      if (error instanceof RefreshSupersededError) throw error;
      if (error instanceof BrokerChangedDuringRefreshError) {
        this.invalidateAll("broker-restart");
      }
      this.#failures += 1;
      if (this.#catalog !== undefined) {
        this.#catalog = Object.freeze({ ...this.#catalog, failures: this.#failures });
      }
      const observedAt = this.#catalog?.observedAt;
      if (
        this.#failures >= FAILURE_INVALIDATION_COUNT ||
        (observedAt !== undefined && this.#now() - observedAt >= FAILURE_INVALIDATION_AGE_MS)
      ) {
        this.invalidateAll("catalog-refresh-failed");
      }
      throw error;
    }
  }

  private reevaluateActive(catalog: RawCatalog): void {
    for (const [projectId, active] of [...this.#active]) {
      try {
        const context = this.projectContext(projectId);
        const runtime = this.currentRojo(context.project);
        if (!sameProject(context.project, active.project) || !sameLease(runtime, active.rojo)) {
          throw new Error("Project or Rojo identity changed.");
        }
        const instance = catalog.byId.get(active.studio.instanceId);
        if (instance === undefined) throw new Error("Selected Studio instance is missing.");
        if (!sameStableStudioIdentity(active.studio, instance)) {
          throw new Error("Selected Studio instance identity changed.");
        }
        const eligibility = eligibleStudioInstance(instance, {
          now: this.#now(),
          catalogObservedAt: catalog.observedAt,
          pinnedVersion: PINNED_STUDIO_MCP_VERSION,
          servePlaceIds: context.servePlaceIds,
        });
        if (!eligibility.eligible) throw new Error(`Selected Studio instance is ${eligibility.reason}.`);
        if (this.isAmbiguous(instance, context.servePlaceIds, catalog)) {
          throw new Error("Selected Studio instance became catalog-ambiguous.");
        }
        if (eligibility.warning !== active.warning) {
          throw new Error("Selected Studio warning identity changed.");
        }
        const studio = connectionRef(catalog, instance);
        const pending = freezePending({
          ...active.pending,
          catalogRevision: catalog.revision,
        });
        const binding =
          active.binding === undefined
            ? undefined
            : Object.freeze({
                ...active.binding,
                studio,
              });
        this.#active.set(
          projectId,
          freezeActive({
            ...active,
            project: context.project,
            servePlaceIds: context.servePlaceIds,
            rojo: runtime,
            studio,
            pending,
            ...(binding === undefined ? {} : { binding }),
          }),
        );
      } catch (error) {
        this.invalidateProject(projectId, invalidationReasonFor(error));
      }
    }
  }

  private currentTuple(projectId: string, instanceId: string, catalogRevision: number): CurrentTuple {
    const context = this.projectContext(projectId);
    const rojo = this.currentRojo(context.project);
    const broker = this.readyBroker();
    const catalog = this.#catalog;
    if (catalog === undefined || catalog.revision !== catalogRevision || catalog.brokerEpoch !== broker.brokerEpoch) {
      throw new Error("Studio catalog changed; refresh and select again.");
    }
    assertFresh(catalog.observedAt, this.#now(), "Studio catalog is stale.");
    const instance = catalog.byId.get(instanceId);
    if (instance === undefined) throw new Error("Studio instance is missing from the current catalog.");
    const eligibility = eligibleStudioInstance(instance, {
      now: this.#now(),
      catalogObservedAt: catalog.observedAt,
      pinnedVersion: PINNED_STUDIO_MCP_VERSION,
      servePlaceIds: context.servePlaceIds,
    });
    if (!eligibility.eligible) {
      throw new Error(`Studio instance is not eligible: ${eligibility.reason}.`);
    }
    return { context, rojo, catalog, instance, eligibility };
  }

  private assertActiveCurrent(projectId: string, active: ActiveBinding, bindingRevision: number): void {
    if (active.pending.bindingRevision !== bindingRevision) {
      throw new Error("Studio binding revision is not current.");
    }
    const tuple = this.currentTuple(projectId, active.studio.instanceId, active.studio.catalogRevision);
    if (
      !sameProject(tuple.context.project, active.project) ||
      !sameLease(tuple.rojo, active.rojo) ||
      tuple.catalog.brokerEpoch !== active.studio.brokerEpoch ||
      !sameConnection(active.studio, tuple.instance)
    ) {
      throw new Error("Studio binding identity is not current.");
    }
    if (this.isAmbiguous(tuple.instance, tuple.context.servePlaceIds, tuple.catalog)) {
      throw new Error("Studio binding is catalog-ambiguous.");
    }
    if (tuple.eligibility.warning !== active.warning) {
      throw new Error("Studio binding warning identity is not current.");
    }
    if (
      active.warning !== undefined &&
      !this.#warningAcceptances.has(this.warningKey(projectId, active.project.revision, active.warning))
    ) {
      throw new Error("Studio binding warning acceptance is not current.");
    }
  }

  private currentRojo(project: ProjectRef): RojoLease {
    const snapshot: ProjectRuntimeSnapshot | undefined = this.#options.runtimes.snapshot(project.projectId);
    if (snapshot?.state !== "ready" || snapshot.lease === undefined) {
      throw new Error("Rojo server is not ready for this project.");
    }
    this.#options.runtimes.assertCurrent(project, snapshot.lease);
    return snapshot.lease;
  }

  private readyBroker(): StudioBrokerReady {
    const snapshot = this.broker().snapshot();
    if (snapshot.state !== "ready" || snapshot.ready === undefined) {
      throw new Error("Studio MCP broker is not ready.");
    }
    return snapshot.ready;
  }

  private projectCatalog(projectId: string): StudioCatalogSnapshot | undefined {
    const catalog = this.#catalog;
    if (catalog === undefined || this.#disposed) return undefined;
    let context: BindingProjectContext;
    try {
      context = this.projectContext(projectId);
    } catch {
      return this.publicCatalog(catalog);
    }
    const evaluations = catalog.instances.map((instance) => ({
      instance,
      eligibility: eligibleStudioInstance(instance, {
        now: this.#now(),
        catalogObservedAt: catalog.observedAt,
        pinnedVersion: PINNED_STUDIO_MCP_VERSION,
        servePlaceIds: context.servePlaceIds,
      }),
    }));
    const ambiguous = ambiguousInstanceIds(evaluations);
    const instances = Object.freeze(
      evaluations.map(({ instance, eligibility }) =>
        catalogRow(instance, eligibility, ambiguous.has(instance.instanceId) ? "catalog-ambiguous" : undefined),
      ),
    );
    return freezeCatalogSnapshot(catalog, instances);
  }

  private publicCatalog(catalog: RawCatalog): StudioCatalogSnapshot {
    const instances = Object.freeze(
      catalog.instances.map((instance) => catalogRow(instance, { eligible: false, reason: "project-mismatch" })),
    );
    return freezeCatalogSnapshot(catalog, instances);
  }

  private isAmbiguous(instance: StudioInstance, servePlaceIds: readonly number[], catalog: RawCatalog): boolean {
    if (instance.placeId === 0) return false;
    const evaluations = catalog.instances.map((candidate) => ({
      instance: candidate,
      eligibility: eligibleStudioInstance(candidate, {
        now: this.#now(),
        catalogObservedAt: catalog.observedAt,
        pinnedVersion: PINNED_STUDIO_MCP_VERSION,
        servePlaceIds,
      }),
    }));
    return ambiguousInstanceIds(evaluations).has(instance.instanceId);
  }

  private warningKey(
    projectId: string,
    projectRevision: number,
    warning: "unknown-place" | "unpublished-place",
  ): string {
    return `${projectId}\0${projectRevision}\0${warning}`;
  }

  private nextBindingRevision(_projectId: string): number {
    this.#bindingRevision += 1;
    return this.#bindingRevision;
  }

  private syncPolling(): void {
    if (this.#disposed) {
      this.stopPolling();
      return;
    }
    const required = this.#externalReferences.size > 0 || this.#active.size > 0;
    if (required && this.#pollHandle === undefined) {
      this.#pollHandle = this.#setInterval(() => {
        if (this.#disposed || !this.pollingRequired()) return;
        const expired = this.expireHungRefresh();
        if (expired && !this.pollingRequired()) return;
        void this.refreshCatalog().catch(() => undefined);
      }, POLL_INTERVAL_MS);
    } else if (!required) {
      this.stopPolling();
    }
  }

  private stopPolling(): void {
    if (this.#pollHandle === undefined) return;
    this.#clearInterval(this.#pollHandle);
    this.#pollHandle = undefined;
  }

  private pollingRequired(): boolean {
    return this.#externalReferences.size > 0 || this.#active.size > 0;
  }

  private expireHungRefresh(): boolean {
    const attempt = this.#refreshAttempt;
    if (
      attempt === undefined ||
      !this.pollingRequired() ||
      this.#now() - attempt.deadlineBaseAt < FAILURE_INVALIDATION_AGE_MS
    ) {
      return false;
    }
    this.#refreshGeneration += 1;
    if (this.#refreshAttempt === attempt) this.#refreshAttempt = undefined;
    this.invalidateAll("catalog-refresh-failed");
    return true;
  }

  private clearSelectionIfOwned(projectId: string): void {
    if (this.#selectedOwner !== projectId) return;
    if (this.#routeActive) {
      this.#deferredClearOwner = projectId;
      return;
    }
    try {
      this.broker().service().clearSelectedInstance();
    } catch {
      // A stopped broker already has no usable selected instance.
    }
    this.#selectedOwner = undefined;
  }

  private flushDeferredClear(): void {
    const owner = this.#deferredClearOwner;
    this.#deferredClearOwner = undefined;
    if (owner === undefined || this.#selectedOwner !== owner) return;
    try {
      this.broker().service().clearSelectedInstance();
    } catch {
      // A stopped broker already has no usable selected instance.
    }
    this.#selectedOwner = undefined;
  }

  private assertNotDisposed(): void {
    if (this.#disposed) throw new Error("Binding coordinator is disposed.");
  }

  private projectContext(projectId: string): BindingProjectContext {
    return this.#projectContextOverrides.get(projectId) ?? this.#options.projectContext(projectId);
  }

  private broker(): Pick<StudioBrokerController, "snapshot" | "service"> {
    return this.#options.broker();
  }
}

class AsyncMutex {
  #tail = Promise.resolve();
  #pending = 0;
  readonly #idleWaiters = new Set<() => void>();

  async acquire(): Promise<() => void> {
    this.#pending += 1;
    let unlockNext!: () => void;
    const next = new Promise<void>((resolve) => {
      unlockNext = resolve;
    });
    const previous = this.#tail;
    this.#tail = previous.then(() => next);
    await previous;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#pending -= 1;
      unlockNext();
      if (this.#pending === 0) {
        for (const waiter of [...this.#idleWaiters]) waiter();
        this.#idleWaiters.clear();
      }
    };
  }

  async waitForIdle(): Promise<void> {
    if (this.#pending === 0) return;
    await new Promise<void>((resolve) => this.#idleWaiters.add(resolve));
  }
}

class BrokerChangedDuringRefreshError extends Error {
  constructor() {
    super("Studio MCP broker changed during catalog refresh.");
    this.name = "BrokerChangedDuringRefreshError";
  }
}

class RefreshSupersededError extends Error {
  constructor() {
    super("Studio catalog refresh was superseded after its freshness deadline.");
    this.name = "RefreshSupersededError";
  }
}

function freezeCatalogInstances(instances: readonly StudioInstance[]): readonly StudioInstance[] {
  const ids = new Set<string>();
  return Object.freeze(
    instances.map((instance) => {
      if (typeof instance.instanceId !== "string" || instance.instanceId.length === 0) {
        throw new Error("Studio catalog contains a malformed instance ID.");
      }
      if (ids.has(instance.instanceId)) {
        throw new Error(`Studio catalog contains duplicate instance ID ${instance.instanceId}.`);
      }
      ids.add(instance.instanceId);
      return Object.freeze({ ...instance });
    }),
  );
}

function connectionClaimKey(brokerEpoch: string, instanceId: string, connectedAt: number): string {
  return `${brokerEpoch}\0${instanceId}\0${connectedAt}`;
}

function connectionRef(catalog: RawCatalog, instance: StudioInstance): StudioConnectionRef {
  return Object.freeze({
    brokerEpoch: catalog.brokerEpoch,
    instanceId: instance.instanceId,
    connectedAt: instance.connectedAt,
    placeId: instance.placeId,
    role: instance.role,
    pluginVariant: instance.pluginVariant,
    pluginVersion: instance.pluginVersion,
    serverVersion: instance.serverVersion,
    lastActivity: instance.lastActivity,
    catalogObservedAt: catalog.observedAt,
    catalogRevision: catalog.revision,
  });
}

function catalogRow(
  instance: StudioInstance,
  eligibility: StudioEligibility,
  overrideReason?: StudioEligibilityReason,
): StudioCatalogRow {
  const eligible = eligibility.eligible && overrideReason === undefined;
  return Object.freeze({
    instanceId: instance.instanceId,
    role: instance.role,
    placeId: instance.placeId,
    placeName: instance.placeName,
    dataModelName: instance.dataModelName,
    pluginVersion: instance.pluginVersion,
    pluginVariant: instance.pluginVariant,
    serverVersion: instance.serverVersion,
    versionMismatch: instance.versionMismatch,
    connectedAt: instance.connectedAt,
    lastActivity: instance.lastActivity,
    eligible,
    ...(!eligible
      ? {
          eligibilityReason: overrideReason ?? (eligibility.eligible ? "project-mismatch" : eligibility.reason),
        }
      : {}),
    warningRequired: eligible ? eligibility.warningRequired : false,
    ...(eligible && eligibility.warningRequired && eligibility.warning !== undefined
      ? { warningKind: eligibility.warning }
      : {}),
  });
}

function ambiguousInstanceIds(
  evaluations: readonly {
    readonly instance: StudioInstance;
    readonly eligibility: StudioEligibility;
  }[],
): ReadonlySet<string> {
  const byPlace = new Map<number, string[]>();
  for (const { instance, eligibility } of evaluations) {
    if (!eligibility.eligible || instance.placeId === 0) continue;
    const ids = byPlace.get(instance.placeId) ?? [];
    ids.push(instance.instanceId);
    byPlace.set(instance.placeId, ids);
  }
  return new Set(
    [...byPlace.values()].filter((instanceIds) => instanceIds.length > 1).flatMap((instanceIds) => instanceIds),
  );
}

function freezeCatalogSnapshot(catalog: RawCatalog, instances: readonly StudioCatalogRow[]): StudioCatalogSnapshot {
  return Object.freeze({
    brokerEpoch: catalog.brokerEpoch,
    revision: catalog.revision,
    observedAt: catalog.observedAt,
    failures: catalog.failures,
    instances,
  });
}

function freezePending(pending: PendingBinding): PendingBinding {
  return Object.freeze(pending);
}

function freezeActive(active: ActiveBinding): ActiveBinding {
  return Object.freeze({
    ...active,
    servePlaceIds: Object.freeze([...active.servePlaceIds]),
  });
}

function sameProject(left: ProjectRef, right: ProjectRef): boolean {
  return (
    left.projectId === right.projectId &&
    left.canonicalRoot === right.canonicalRoot &&
    left.rootDevice === right.rootDevice &&
    left.rootInode === right.rootInode &&
    left.canonicalProjectFile === right.canonicalProjectFile &&
    left.projectFileDevice === right.projectFileDevice &&
    left.projectFileInode === right.projectFileInode &&
    left.configDigest === right.configDigest &&
    left.revision === right.revision
  );
}

function sameNumberSet(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameLease(left: RojoLease, right: RojoLease): boolean {
  return (
    left.leaseId === right.leaseId &&
    left.projectId === right.projectId &&
    left.projectRevision === right.projectRevision &&
    left.generation === right.generation &&
    left.port === right.port &&
    left.startedAt === right.startedAt
  );
}

function sameStableStudioIdentity(connection: StudioConnectionRef, instance: StudioInstance): boolean {
  return (
    connection.instanceId === instance.instanceId &&
    connection.connectedAt === instance.connectedAt &&
    connection.placeId === instance.placeId &&
    connection.role === instance.role &&
    connection.pluginVariant === instance.pluginVariant &&
    connection.pluginVersion === instance.pluginVersion &&
    connection.serverVersion === instance.serverVersion
  );
}

function sameConnection(connection: StudioConnectionRef, instance: StudioInstance): boolean {
  return sameStableStudioIdentity(connection, instance) && connection.lastActivity === instance.lastActivity;
}

function assertSameConnection(connection: StudioConnectionRef, instance: StudioInstance): void {
  if (!sameConnection(connection, instance)) {
    throw new Error("Studio service selected a different connection identity.");
  }
}

function assertSameSelectedInstance(expected: StudioInstance, selected: StudioInstance): void {
  if (
    expected.instanceId !== selected.instanceId ||
    expected.connectedAt !== selected.connectedAt ||
    expected.placeId !== selected.placeId ||
    expected.role !== selected.role ||
    expected.pluginVariant !== selected.pluginVariant ||
    expected.pluginVersion !== selected.pluginVersion ||
    expected.serverVersion !== selected.serverVersion ||
    expected.lastActivity !== selected.lastActivity
  ) {
    throw new Error("Studio service selected a different catalog connection.");
  }
}

function assertFresh(timestamp: number, now: number, message: string): void {
  if (!Number.isFinite(timestamp) || !Number.isFinite(now)) throw new Error(message);
  const age = now - timestamp;
  if (age > MAX_FRESHNESS_MS || age < -MAX_FUTURE_SKEW_MS) throw new Error(message);
}

function invalidationReasonFor(error: unknown): string {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.includes("rojo")) return "rojo-replaced";
  if (message.includes("project")) return "project-drift";
  if (message.includes("broker")) return "broker-restart";
  if (message.includes("missing")) return "studio-missing";
  if (message.includes("stale")) return "catalog-stale";
  if (message.includes("ambiguous")) return "catalog-ambiguous";
  return "studio-identity-changed";
}
