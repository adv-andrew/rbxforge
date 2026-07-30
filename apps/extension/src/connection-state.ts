export type CheckId =
  | "workspace"
  | "rojoBinary"
  | "rojoProcess"
  | "rojoApi"
  | "mcpProcess"
  | "studioPlugin"
  | "studioPlace"
  | "activeStudioInstance"
  | "placeRestriction"
  | "aiProvider";

export type Health = "unknown" | "checking" | "healthy" | "unhealthy";

export interface ConnectionCheck {
  readonly id: CheckId;
  readonly required: boolean;
  readonly health: Health;
  readonly detail: string;
  readonly observedAt: number;
}

export interface ConnectionStateSnapshot {
  readonly revision: number;
  readonly checks: Readonly<Record<CheckId, ConnectionCheck>>;
  readonly aggregate: { readonly label: "Ready" | "Not ready"; readonly failing: readonly CheckId[] };
  readonly simulation: boolean;
  readonly observedAt: number;
}

export interface ConnectionStateOptions {
  readonly simulation?: boolean;
  readonly now?: () => number;
}
export interface CheckUpdate {
  readonly health: Health;
  readonly detail: string;
  readonly required?: boolean;
}
export type CheckUpdates = Readonly<Partial<Record<CheckId, CheckUpdate>>>;
export type Dispose = () => void;

const checkIds = [
  "workspace",
  "rojoBinary",
  "rojoProcess",
  "rojoApi",
  "mcpProcess",
  "studioPlugin",
  "studioPlace",
  "activeStudioInstance",
  "placeRestriction",
  "aiProvider",
] as const satisfies readonly CheckId[];

const dependentChecks = new Set<CheckId>([
  "rojoProcess",
  "rojoApi",
  "mcpProcess",
  "studioPlugin",
  "studioPlace",
  "activeStudioInstance",
  "placeRestriction",
]);

export class ConnectionStateStore {
  readonly #now: () => number;
  readonly #simulation: boolean;
  readonly #listeners = new Set<(snapshot: ConnectionStateSnapshot) => void>();
  #snapshot: ConnectionStateSnapshot;

  constructor(options: ConnectionStateOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#simulation = options.simulation ?? false;
    this.#snapshot = this.makeSnapshot(0, this.createChecks(), this.#now());
  }

  snapshot(): ConnectionStateSnapshot {
    return this.#snapshot;
  }
  requiredCheckIds(): readonly CheckId[] {
    return checkIds.filter((id) => this.#snapshot.checks[id].required);
  }
  onDidChange(listener: (snapshot: ConnectionStateSnapshot) => void): Dispose {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  update(id: CheckId, update: CheckUpdate): void {
    this.updateMany({ [id]: update });
  }

  updateMany(updates: CheckUpdates): void {
    const observedAt = this.#now();
    const checks: Record<CheckId, ConnectionCheck> = { ...this.#snapshot.checks };
    let changed = false;
    for (const id of checkIds) {
      const update = updates[id];
      if (update === undefined) continue;
      const current = checks[id];
      const required = update.required ?? current.required;
      if (current.health === update.health && current.detail === update.detail && current.required === required) {
        continue;
      }
      changed = true;
      checks[id] = freezeCheck({
        id,
        health: update.health,
        detail: update.detail,
        required,
        observedAt,
      });
    }
    if (!changed) return;
    this.replace(checks, observedAt);
  }

  disconnect(detail: string): void {
    const timestamp = this.#now();
    const checks: Record<CheckId, ConnectionCheck> = { ...this.#snapshot.checks };
    let changed = false;
    for (const id of dependentChecks) {
      const current = checks[id];
      if (current.health === "healthy" || current.health === "checking") {
        changed = true;
        checks[id] = freezeCheck({ ...current, health: "unhealthy", detail, observedAt: timestamp });
      }
    }
    if (!changed) return;
    this.replace(checks, timestamp);
  }

  private createChecks(): Record<CheckId, ConnectionCheck> {
    const timestamp = this.#now();
    return Object.fromEntries(
      checkIds.map((id) => [
        id,
        freezeCheck({
          id,
          required: id !== "aiProvider",
          health: "unknown",
          detail: "Not checked",
          observedAt: timestamp,
        }),
      ]),
    ) as Record<CheckId, ConnectionCheck>;
  }

  private replace(checks: Record<CheckId, ConnectionCheck>, observedAt = this.#now()): void {
    this.#snapshot = this.makeSnapshot(this.#snapshot.revision + 1, checks, observedAt);
    for (const listener of this.#listeners) listener(this.#snapshot);
  }

  private makeSnapshot(
    revision: number,
    checks: Record<CheckId, ConnectionCheck>,
    observedAt: number,
  ): ConnectionStateSnapshot {
    const frozenChecks = Object.freeze({ ...checks });
    const failing = Object.freeze(
      checkIds.filter((id) => frozenChecks[id].required && frozenChecks[id].health !== "healthy"),
    );
    return Object.freeze({
      revision,
      checks: frozenChecks,
      aggregate: Object.freeze({ label: failing.length === 0 ? "Ready" : "Not ready", failing }),
      simulation: this.#simulation,
      observedAt,
    });
  }
}

export function createConnectionState(options: ConnectionStateOptions = {}): ConnectionStateStore {
  return new ConnectionStateStore(options);
}

function freezeCheck(check: ConnectionCheck): ConnectionCheck {
  return Object.freeze(check);
}
