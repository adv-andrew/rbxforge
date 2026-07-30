import { isAbsolute } from "node:path";
import type { RojoStatus } from "@rbxforge/rojo";
import type { ProjectRef, RojoLease } from "../../shared/domain.js";
import type { ResolvedRojoExecutable, RojoExecutableSource } from "./rojo-executable.js";

const DIAGNOSTIC_LIMIT = 8_192;

export type { ResolvedRojoExecutable, RojoExecutableSource };

export interface ProjectRuntimeSnapshot {
  readonly projectId: string;
  readonly state: "starting" | "ready" | "failed";
  readonly lease?: RojoLease;
  readonly executablePath?: string;
  readonly version?: string;
  readonly diagnostic?: string;
}

export interface ProjectRojoService {
  start(projectPath: string): Promise<RojoStatus>;
  checkHealth(): Promise<RojoStatus>;
  stop(): Promise<void>;
  onStatus(listener: (status: RojoStatus) => void): () => void;
}

export interface ProjectRojoServiceFactoryOptions {
  readonly command: string;
}

export interface ProjectRuntimeInvalidation {
  readonly projectId: string;
  readonly reason: "rojo-exit";
}

export interface ProjectRuntimeRegistryOptions {
  readonly createService: (options: ProjectRojoServiceFactoryOptions) => ProjectRojoService;
  readonly createId?: () => string;
  readonly now?: () => number;
  readonly healthTimeoutMs?: number;
  readonly assertProjectCurrent: (project: ProjectRef) => void;
  readonly onInvalidated?: (event: ProjectRuntimeInvalidation) => void;
}

type RuntimeEntry = {
  readonly projectId: string;
  readonly generation: number;
  readonly service: ProjectRojoService;
  readonly lease: RojoLease;
  readonly project: ProjectRef;
  readonly executable: ResolvedRojoExecutable;
};

interface ConnectAttempt {
  readonly project: ProjectRef;
  readonly executable: ResolvedRojoExecutable;
  readonly service: ProjectRojoService;
  promise: Promise<RojoLease>;
  cancelled: boolean;
}

export class ProjectRuntimeRegistry {
  readonly #createService: (options: ProjectRojoServiceFactoryOptions) => ProjectRojoService;
  readonly #createId: () => string;
  readonly #now: () => number;
  readonly #assertProjectCurrent: (project: ProjectRef) => void;
  readonly #onInvalidated: (event: ProjectRuntimeInvalidation) => void;
  readonly #healthTimeoutMs: number;
  readonly #entries = new Map<string, RuntimeEntry>();
  readonly #attempts = new Map<string, ConnectAttempt>();
  readonly #generations = new Map<string, number>();
  readonly #snapshots = new Map<string, ProjectRuntimeSnapshot>();
  readonly #snapshotOwners = new Map<string, object>();
  readonly #unsubscribe = new Map<ProjectRojoService, () => void>();
  readonly #stopping = new WeakSet<ProjectRojoService>();
  readonly #stopPromises = new WeakMap<ProjectRojoService, Promise<void>>();
  #disposed = false;
  #disposeComplete = false;
  #disposePromise: Promise<void> | undefined;

  constructor(options: ProjectRuntimeRegistryOptions) {
    this.#createService = options.createService;
    this.#createId = options.createId ?? (() => crypto.randomUUID());
    this.#now = options.now ?? Date.now;
    this.#healthTimeoutMs = options.healthTimeoutMs ?? 2_000;
    this.#assertProjectCurrent = options.assertProjectCurrent;
    this.#onInvalidated = options.onInvalidated ?? (() => undefined);
  }

  async connect(project: ProjectRef, executable: ResolvedRojoExecutable): Promise<RojoLease> {
    if (this.#disposed) return Promise.reject(new Error("Project runtime registry is disposed."));
    if (!isAbsolute(executable.path)) throw new Error("Project runtime requires an absolute Rojo executable path.");

    const current = this.#entries.get(project.projectId);
    if (current !== undefined) {
      if (!sameProject(current.project, project) || !sameExecutable(current.executable, executable)) {
        return Promise.reject(new Error("Project runtime is already connected with different identity."));
      }
      try {
        this.assertCurrent(project, current.lease);
        return Promise.resolve(current.lease);
      } catch (error) {
        return Promise.reject(error);
      }
    }

    const pending = this.#attempts.get(project.projectId);
    if (pending !== undefined) {
      return sameProject(pending.project, project) && sameExecutable(pending.executable, executable)
        ? pending.promise
        : Promise.reject(new Error("Project runtime is already starting with different identity."));
    }

    this.#assertProjectCurrent(project);
    const generation = (this.#generations.get(project.projectId) ?? 0) + 1;
    this.#generations.set(project.projectId, generation);
    const service = this.#createService({ command: executable.path });
    const attempt = {
      project,
      executable,
      service,
      cancelled: false,
    } as ConnectAttempt;
    this.setSnapshot(
      project.projectId,
      freezeSnapshot({
        projectId: project.projectId,
        state: "starting",
        executablePath: executable.path,
        version: executable.version,
      }),
      attempt,
    );
    const promise = this.startAttempt(attempt, generation).finally(() => {
      if (this.#attempts.get(project.projectId) === attempt) this.#attempts.delete(project.projectId);
    });
    attempt.promise = promise;
    this.#attempts.set(project.projectId, attempt);
    return promise;
  }

  assertCurrent(project: ProjectRef, lease: RojoLease): void {
    const entry = this.#entries.get(project.projectId);
    if (entry === undefined || !sameLease(entry.lease, lease)) {
      throw new Error("Rojo lease is not current for this project.");
    }
    if (!sameProject(entry.project, project)) {
      throw new Error("Rojo project is not current for this lease.");
    }
    this.#assertProjectCurrent(project);
  }

  async disconnect(projectId: string): Promise<void> {
    const attempt = this.#attempts.get(projectId);
    const entry = this.#entries.get(projectId);
    const snapshotOwner = this.#snapshotOwners.get(projectId);

    if (attempt !== undefined) {
      attempt.cancelled = true;
      if (this.#attempts.get(projectId) === attempt) this.#attempts.delete(projectId);
    }
    if (entry !== undefined) {
      if (this.#entries.get(projectId) === entry) this.#entries.delete(projectId);
      this.removeSubscription(entry.service);
    }
    if (snapshotOwner !== undefined) this.clearSnapshotIfOwner(projectId, snapshotOwner);

    const services = uniqueServices([attempt?.service, entry?.service]);
    const stopResults = await Promise.allSettled(services.map((service) => this.stopExact(service)));
    if (attempt !== undefined) await Promise.allSettled([attempt.promise]);

    if (attempt !== undefined && this.#attempts.get(projectId) === attempt) this.#attempts.delete(projectId);
    if (entry !== undefined && this.#entries.get(projectId) === entry) this.#entries.delete(projectId);
    if (snapshotOwner !== undefined) this.clearSnapshotIfOwner(projectId, snapshotOwner);
    throwCleanupFailures(stopResults, "Project runtime disconnect failed.");
  }

  snapshot(projectId: string): ProjectRuntimeSnapshot | undefined {
    return this.#snapshots.get(projectId);
  }

  async refresh(projectId: string): Promise<RojoLease> {
    const entry = this.#entries.get(projectId);
    if (entry === undefined) throw new Error("Project runtime is not connected.");
    let status: RojoStatus;
    try {
      status = await withTimeout(entry.service.checkHealth(), this.#healthTimeoutMs);
    } catch (error) {
      await this.invalidateUnhealthy(entry, diagnosticFor(error));
      throw error;
    }
    if (!isHealthy(status) || status.port !== entry.lease.port) {
      const diagnostic = !isHealthy(status)
        ? `Rojo live health check failed: ${diagnosticForStatus(status)}`
        : "Rojo live health check returned a different port.";
      await this.invalidateUnhealthy(entry, diagnostic);
      throw new Error(diagnostic);
    }
    if (this.#entries.get(projectId) !== entry) {
      await this.stopExact(entry.service);
      throw new Error("Project runtime changed during live health validation.");
    }
    this.assertCurrent(entry.project, entry.lease);
    return entry.lease;
  }

  dispose(): Promise<void> {
    if (this.#disposePromise !== undefined) return this.#disposePromise;
    if (this.#disposeComplete) return Promise.resolve();
    this.#disposed = true;
    this.#disposePromise = this.disposeOwned().finally(() => {
      this.#disposeComplete = true;
      this.#disposePromise = undefined;
    });
    return this.#disposePromise;
  }

  private async startAttempt(attempt: ConnectAttempt, generation: number): Promise<RojoLease> {
    const { project, executable, service } = attempt;
    let crashDiagnostic: string | undefined;
    const unsubscribe = service.onStatus((status) => {
      if (isHealthy(status) || this.#stopping.has(service)) return;
      crashDiagnostic = diagnosticForStatus(status);
      const current = this.#entries.get(project.projectId);
      if (current?.service !== service) return;
      this.#entries.delete(project.projectId);
      this.removeSubscription(service);
      this.setSnapshot(
        project.projectId,
        freezeSnapshot({
          projectId: project.projectId,
          state: "failed",
          executablePath: executable.path,
          version: executable.version,
          diagnostic: crashDiagnostic,
        }),
        service,
      );
      this.#onInvalidated(Object.freeze({ projectId: project.projectId, reason: "rojo-exit" }));
    });
    this.#unsubscribe.set(service, unsubscribe);

    try {
      const status = await service.start(project.canonicalProjectFile);
      if (!isHealthy(status)) throw new Error(diagnosticForStatus(status));
      this.#assertProjectCurrent(project);
      if (attempt.cancelled || this.#disposed) throw new Error("Project runtime connection was cancelled.");
      if (crashDiagnostic !== undefined) throw new Error(crashDiagnostic);
      if (
        [...this.#entries.values()].some(
          (entry) => entry.projectId !== project.projectId && entry.lease.port === status.port,
        )
      ) {
        throw new Error(`Rojo port ${status.port} is already held by another project runtime.`);
      }

      const lease: RojoLease = Object.freeze({
        leaseId: this.#createId(),
        projectId: project.projectId,
        projectRevision: project.revision,
        generation,
        port: status.port,
        startedAt: this.#now(),
      });
      const entry: RuntimeEntry = Object.freeze({
        projectId: project.projectId,
        generation,
        service,
        lease,
        project,
        executable,
      });
      this.#entries.set(project.projectId, entry);
      this.setSnapshot(
        project.projectId,
        freezeSnapshot({
          projectId: project.projectId,
          state: "ready",
          lease,
          executablePath: executable.path,
          version: executable.version,
        }),
        entry,
      );
      return lease;
    } catch (error) {
      this.removeSubscription(service);
      const stopResults = await Promise.allSettled([this.stopExact(service)]);
      const diagnostic = diagnosticFor(error);
      if (this.#attempts.get(project.projectId) === attempt && !attempt.cancelled && !this.#disposed) {
        this.setSnapshot(
          project.projectId,
          freezeSnapshot({
            projectId: project.projectId,
            state: "failed",
            executablePath: executable.path,
            version: executable.version,
            diagnostic,
          }),
          attempt,
        );
      }
      const cleanupFailures = cleanupFailuresFrom(stopResults);
      if (cleanupFailures.length > 0) {
        throw new AggregateError([error, ...cleanupFailures], "Rojo runtime start and cleanup failed.");
      }
      throw error;
    }
  }

  private async stopExact(service: ProjectRojoService): Promise<void> {
    const retained = this.#stopPromises.get(service);
    if (retained !== undefined) return retained;
    this.#stopping.add(service);
    const promise = Promise.resolve()
      .then(() => service.stop())
      .finally(() => {
        this.removeSubscription(service);
      });
    this.#stopPromises.set(service, promise);
    return promise;
  }

  private async invalidateUnhealthy(entry: RuntimeEntry, diagnostic: string): Promise<void> {
    const stillCurrent = this.#entries.get(entry.projectId) === entry;
    if (stillCurrent) {
      this.#entries.delete(entry.projectId);
      this.removeSubscription(entry.service);
      this.setSnapshot(
        entry.projectId,
        freezeSnapshot({
          projectId: entry.projectId,
          state: "failed",
          executablePath: entry.executable.path,
          version: entry.executable.version,
          diagnostic: boundDiagnostic(diagnostic),
        }),
        entry,
      );
      this.#onInvalidated(Object.freeze({ projectId: entry.projectId, reason: "rojo-exit" }));
    }
    await this.stopExact(entry.service);
  }

  private removeSubscription(service: ProjectRojoService): void {
    const unsubscribe = this.#unsubscribe.get(service);
    if (unsubscribe === undefined) return;
    this.#unsubscribe.delete(service);
    unsubscribe();
  }

  private async disposeOwned(): Promise<void> {
    const attempts = [...this.#attempts.values()];
    const entries = [...this.#entries.values()];
    for (const attempt of attempts) attempt.cancelled = true;
    this.#attempts.clear();
    this.#entries.clear();
    for (const entry of entries) this.removeSubscription(entry.service);
    this.#snapshots.clear();
    this.#snapshotOwners.clear();

    try {
      const services = uniqueServices([
        ...entries.map((entry) => entry.service),
        ...attempts.map((attempt) => attempt.service),
      ]);
      const stopResults = await Promise.allSettled(services.map((service) => this.stopExact(service)));
      await Promise.allSettled(attempts.map((attempt) => attempt.promise));
      throwCleanupFailures(stopResults, "Project runtime disposal failed.");
    } finally {
      this.#attempts.clear();
      this.#entries.clear();
      this.#snapshots.clear();
      this.#snapshotOwners.clear();
    }
  }

  private setSnapshot(projectId: string, snapshot: ProjectRuntimeSnapshot, owner: object): void {
    this.#snapshots.set(projectId, snapshot);
    this.#snapshotOwners.set(projectId, owner);
  }

  private clearSnapshotIfOwner(projectId: string, owner: object): void {
    if (this.#snapshotOwners.get(projectId) !== owner) return;
    this.#snapshotOwners.delete(projectId);
    this.#snapshots.delete(projectId);
  }
}

function isHealthy(status: RojoStatus): boolean {
  return status.processRunning && status.apiHealthy && status.state === undefined;
}

function diagnosticForStatus(status: RojoStatus): string {
  return boundDiagnostic(
    status.stderr ?? (status.state === "stopped" ? "Rojo service stopped." : "Rojo service exited."),
  );
}

function diagnosticFor(error: unknown): string {
  return boundDiagnostic(error instanceof Error ? error.message : String(error));
}

function boundDiagnostic(value: string): string {
  return value.length <= DIAGNOSTIC_LIMIT ? value : value.slice(-DIAGNOSTIC_LIMIT);
}

function freezeSnapshot(snapshot: ProjectRuntimeSnapshot): ProjectRuntimeSnapshot {
  return Object.freeze(snapshot);
}

function sameExecutable(left: ResolvedRojoExecutable, right: ResolvedRojoExecutable): boolean {
  return left.path === right.path && left.version === right.version && left.source === right.source;
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

function uniqueServices(services: readonly (ProjectRojoService | undefined)[]): readonly ProjectRojoService[] {
  return [...new Set(services.filter((service): service is ProjectRojoService => service !== undefined))];
}

function cleanupFailuresFrom(results: readonly PromiseSettledResult<void>[]): readonly unknown[] {
  return results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
}

function throwCleanupFailures(results: readonly PromiseSettledResult<void>[], message: string): void {
  const failures = cleanupFailuresFrom(results);
  if (failures.length === 0) return;
  if (failures.length === 1) throw failures[0];
  throw new AggregateError(failures, message);
}

async function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error("Rojo live health check timed out.")), timeoutMs);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
