import type { MutationKind, MutationOperation } from "./mutation-policy.js";

export interface MutationJournalEntry {
  readonly id: string;
  readonly timestamp: string;
  readonly instanceId?: string;
  readonly kind: MutationKind;
  readonly operation: MutationOperation;
  readonly target: string;
  readonly before?: unknown;
  readonly requested?: unknown;
  readonly result: "approved" | "rejected" | "applied" | "failed";
  readonly verification?: "verified" | "mismatch" | "unverifiable";
  readonly detail?: string;
}

/** An append-only, immutable history of proposed and applied mutations. */
export class MutationJournal {
  readonly #entries: MutationJournalEntry[] = [];
  readonly #ids = new Set<string>();
  readonly #listeners = new Set<(entry: MutationJournalEntry) => void>();

  append(entry: MutationJournalEntry): void {
    if (this.#ids.has(entry.id)) {
      throw new Error(`Duplicate mutation journal entry ID: ${entry.id}`);
    }

    const frozen = freezeEntry(entry);
    this.#entries.push(frozen);
    this.#ids.add(entry.id);
    for (const listener of this.#listeners) listener(frozen);
  }

  entries(): readonly MutationJournalEntry[] {
    return Object.freeze(this.#entries.map((entry) => freezeEntry(entry)));
  }

  onDidAppend(listener: (entry: MutationJournalEntry) => void): { dispose(): void } {
    this.#listeners.add(listener);
    return { dispose: () => this.#listeners.delete(listener) };
  }
}

function freezeEntry(entry: MutationJournalEntry): MutationJournalEntry {
  return Object.freeze({
    id: entry.id,
    timestamp: entry.timestamp,
    ...(entry.instanceId === undefined ? {} : { instanceId: entry.instanceId }),
    kind: entry.kind,
    operation: entry.operation,
    target: entry.target,
    ...(entry.before === undefined ? {} : { before: cloneAndFreeze(entry.before) }),
    ...(entry.requested === undefined ? {} : { requested: cloneAndFreeze(entry.requested) }),
    result: entry.result,
    ...(entry.verification === undefined ? {} : { verification: entry.verification }),
    ...(entry.detail === undefined ? {} : { detail: entry.detail }),
  });
}

function cloneAndFreeze(value: unknown): unknown {
  return deepFreeze(structuredClone(value));
}

function deepFreeze(value: unknown): unknown {
  if (Array.isArray(value)) {
    value.forEach(deepFreeze);
  } else if (isPlainObject(value)) {
    Object.values(value).forEach(deepFreeze);
  }
  if (value !== null && (typeof value === "object" || typeof value === "function")) {
    Object.freeze(value);
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
