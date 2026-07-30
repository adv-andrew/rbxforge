import type { DesktopDatabase } from "./database.js";
import { StorageError } from "./database.js";

const LATEST_MIGRATION_ID = 1;

const INITIAL_SCHEMA = `
CREATE TABLE migrations (
  id INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  canonical_root TEXT NOT NULL UNIQUE,
  root_device TEXT NOT NULL,
  root_inode TEXT NOT NULL,
  canonical_project_file TEXT NOT NULL UNIQUE,
  project_file_device TEXT NOT NULL,
  project_file_inode TEXT NOT NULL,
  config_digest TEXT NOT NULL,
  serve_place_ids_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_opened_at INTEGER NOT NULL
);
CREATE TABLE threads (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX threads_project_updated ON threads(project_id, updated_at DESC);
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'system')),
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX messages_thread_created ON messages(thread_id, created_at ASC);
CREATE TABLE drafts (
  thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE app_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export function runMigrations(database: DesktopDatabase): void {
  database.transaction(() => {
    const migrationsTable = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'migrations'")
      .get() as { readonly name?: string } | undefined;

    if (migrationsTable === undefined) {
      database.raw.exec(INITIAL_SCHEMA);
      database.prepare("INSERT INTO migrations (id, applied_at) VALUES (?, ?)").run(LATEST_MIGRATION_ID, Date.now());
      return;
    }

    const latest = database.prepare("SELECT MAX(id) AS id FROM migrations").get() as { readonly id: number | null };
    if (latest.id !== null && latest.id > LATEST_MIGRATION_ID) {
      throw new StorageError("database-too-new", "This database was created by a newer version of RbxForge.");
    }

    if (latest.id === null) {
      database.raw.exec(INITIAL_SCHEMA.replace("CREATE TABLE migrations", "CREATE TABLE IF NOT EXISTS migrations"));
      database.prepare("INSERT INTO migrations (id, applied_at) VALUES (?, ?)").run(LATEST_MIGRATION_ID, Date.now());
    }
  });
}
