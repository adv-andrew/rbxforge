import Database from "better-sqlite3";

export interface DesktopDatabase {
  readonly raw: import("better-sqlite3").Database;
  transaction<T>(work: () => T): T;
  pragma(source: string, options?: { readonly simple?: boolean }): unknown;
  prepare(source: string): import("better-sqlite3").Statement;
  close(): void;
}

export class StorageError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "StorageError";
  }
}

export function openDesktopDatabase(path: string): DesktopDatabase {
  const raw = new Database(path);
  raw.pragma("foreign_keys = ON");
  raw.pragma("journal_mode = WAL");
  raw.pragma("busy_timeout = 5000");

  return {
    raw,
    transaction<T>(work: () => T): T {
      return raw.transaction(work)();
    },
    pragma(source, options) {
      return raw.pragma(source, options);
    },
    prepare(source) {
      return raw.prepare(source);
    },
    close() {
      raw.close();
    },
  };
}
