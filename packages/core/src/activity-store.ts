export type ActivityOperation =
  "playtest.status" | "playtest.start" | "playtest.stop" | "runtime.logs" | "viewport.capture";

export interface ActivityEvent {
  readonly id: string;
  readonly timestamp: string;
  readonly instanceId: string;
  readonly operation: ActivityOperation;
  readonly result: "success" | "failed" | "cancelled" | "unknown";
  readonly detail?: string;
  readonly droppedLogs?: number;
  readonly verification?: "verified" | "mismatch" | "unverifiable";
}

export class ActivityEventStore {
  readonly #limit: number;
  readonly #entries: ActivityEvent[] = [];
  readonly #ids = new Set<string>();
  readonly #listeners = new Set<(entry: ActivityEvent) => void>();

  constructor(options: { readonly limit?: number } = {}) {
    this.#limit = options.limit ?? 500;
    if (!Number.isSafeInteger(this.#limit) || this.#limit < 1 || this.#limit > 5_000) {
      throw new Error("Activity event limit must be an integer from 1 to 5000");
    }
  }

  append(entry: ActivityEvent): void {
    if (this.#ids.has(entry.id)) throw new Error(`Duplicate activity event ID: ${entry.id}`);
    const frozen = freezeActivity(entry);
    this.#entries.push(frozen);
    this.#ids.add(frozen.id);
    while (this.#entries.length > this.#limit) {
      const removed = this.#entries.shift();
      if (removed !== undefined) this.#ids.delete(removed.id);
    }
    for (const listener of this.#listeners) listener(frozen);
  }

  entries(): readonly ActivityEvent[] {
    return Object.freeze([...this.#entries]);
  }

  onDidAppend(listener: (entry: ActivityEvent) => void): { dispose(): void } {
    this.#listeners.add(listener);
    return { dispose: () => this.#listeners.delete(listener) };
  }
}

function freezeActivity(entry: ActivityEvent): ActivityEvent {
  return Object.freeze({
    id: entry.id,
    timestamp: entry.timestamp,
    instanceId: entry.instanceId,
    operation: entry.operation,
    result: entry.result,
    ...(entry.detail === undefined ? {} : { detail: entry.detail }),
    ...(entry.droppedLogs === undefined ? {} : { droppedLogs: entry.droppedLogs }),
    ...(entry.verification === undefined ? {} : { verification: entry.verification }),
  });
}
