import type { ProjectRecord, ThreadRecord } from "../../shared/domain.js";
import type { DesktopDatabase } from "./database.js";
import { StorageError } from "./database.js";

const SELECTED_PROJECT_KEY = "selected_project_id";

type ProjectRow = {
  readonly id: string;
  readonly display_name: string;
  readonly canonical_root: string;
  readonly root_device: string;
  readonly root_inode: string;
  readonly canonical_project_file: string;
  readonly project_file_device: string;
  readonly project_file_inode: string;
  readonly config_digest: string;
  readonly serve_place_ids_json: string;
  readonly created_at: number;
  readonly updated_at: number;
  readonly last_opened_at: number;
};

export type InsertProjectResult =
  | { readonly kind: "created"; readonly project: ProjectRecord; readonly thread: ThreadRecord }
  | { readonly kind: "existing"; readonly project: ProjectRecord };

export class ProjectRepository {
  constructor(private readonly database: DesktopDatabase) {}

  list(): ProjectRecord[] {
    return (
      this.database.prepare("SELECT * FROM projects ORDER BY last_opened_at DESC, created_at ASC").all() as ProjectRow[]
    ).map(hydrateProject);
  }

  findById(id: string): ProjectRecord | undefined {
    const row = this.database.prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | undefined;
    return row === undefined ? undefined : hydrateProject(row);
  }

  findByCanonicalRoot(canonicalRoot: string): ProjectRecord | undefined {
    const row = this.database.prepare("SELECT * FROM projects WHERE canonical_root = ?").get(canonicalRoot) as
      ProjectRow | undefined;
    return row === undefined ? undefined : hydrateProject(row);
  }

  insertWithFirstThread(project: ProjectRecord): InsertProjectResult {
    return this.database.transaction(() => {
      const existing = this.findByCanonicalRoot(project.canonicalRoot);
      if (existing !== undefined) {
        this.setSelectedProject(existing.id);
        return { kind: "existing", project: existing };
      }

      this.database
        .prepare(
          `INSERT INTO projects (
            id, display_name, canonical_root, root_device, root_inode, canonical_project_file, project_file_device,
            project_file_inode, config_digest, serve_place_ids_json, created_at, updated_at, last_opened_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          project.id,
          project.displayName,
          project.canonicalRoot,
          project.rootDevice,
          project.rootInode,
          project.canonicalProjectFile,
          project.projectFileDevice,
          project.projectFileInode,
          project.configDigest,
          JSON.stringify(project.servePlaceIds),
          project.createdAt,
          project.updatedAt,
          project.lastOpenedAt,
        );
      const thread: ThreadRecord = {
        id: crypto.randomUUID(),
        projectId: project.id,
        title: "New chat",
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
      };
      this.database
        .prepare("INSERT INTO threads (id, project_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
        .run(thread.id, thread.projectId, thread.title, thread.createdAt, thread.updatedAt);
      this.setSelectedProject(project.id);
      this.setSelectedThread(project.id, thread.id);
      return { kind: "created", project: hydrateProject(toProjectRow(project)), thread };
    });
  }

  touchAndSelect(id: string): ProjectRecord | undefined {
    return this.database.transaction(() => {
      const existing = this.findById(id);
      if (existing === undefined) return undefined;
      this.database.prepare("UPDATE projects SET last_opened_at = ? WHERE id = ?").run(Date.now(), id);
      this.setSelectedProject(id);
      return this.findById(id);
    });
  }

  remove(id: string): void {
    this.database.transaction(() => {
      this.database.prepare("DELETE FROM projects WHERE id = ?").run(id);
      if (this.selectedProjectId() === id) {
        this.database.prepare("DELETE FROM app_state WHERE key = ?").run(SELECTED_PROJECT_KEY);
      }
      this.database.prepare("DELETE FROM app_state WHERE key = ?").run(selectedThreadKey(id));
    });
  }

  selectedProjectId(): string | undefined {
    return this.readAppState(SELECTED_PROJECT_KEY);
  }

  private setSelectedProject(id: string): void {
    this.writeAppState(SELECTED_PROJECT_KEY, id);
  }

  private setSelectedThread(projectId: string, threadId: string): void {
    this.writeAppState(selectedThreadKey(projectId), threadId);
  }

  private readAppState(key: string): string | undefined {
    const row = this.database.prepare("SELECT value FROM app_state WHERE key = ?").get(key) as
      { readonly value: string } | undefined;
    return row?.value;
  }

  private writeAppState(key: string, value: string): void {
    this.database
      .prepare("INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }
}

function selectedThreadKey(projectId: string): string {
  return `selected_thread:${projectId}`;
}

function toProjectRow(project: ProjectRecord): ProjectRow {
  return {
    id: project.id,
    display_name: project.displayName,
    canonical_root: project.canonicalRoot,
    root_device: project.rootDevice,
    root_inode: project.rootInode,
    canonical_project_file: project.canonicalProjectFile,
    project_file_device: project.projectFileDevice,
    project_file_inode: project.projectFileInode,
    config_digest: project.configDigest,
    serve_place_ids_json: JSON.stringify(project.servePlaceIds),
    created_at: project.createdAt,
    updated_at: project.updatedAt,
    last_opened_at: project.lastOpenedAt,
  };
}

function hydrateProject(row: ProjectRow): ProjectRecord {
  let servePlaceIds: readonly number[];
  try {
    const value: unknown = JSON.parse(row.serve_place_ids_json);
    if (!Array.isArray(value) || !value.every((id) => typeof id === "number" && Number.isSafeInteger(id) && id >= 0)) {
      throw new Error("invalid place ids");
    }
    servePlaceIds = Object.freeze([...value]);
  } catch {
    throw new StorageError("invalid-serve-place-ids", "Stored serve place ids are invalid.");
  }

  return {
    id: row.id,
    displayName: row.display_name,
    canonicalRoot: row.canonical_root,
    rootDevice: row.root_device,
    rootInode: row.root_inode,
    canonicalProjectFile: row.canonical_project_file,
    projectFileDevice: row.project_file_device,
    projectFileInode: row.project_file_inode,
    configDigest: row.config_digest,
    servePlaceIds,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastOpenedAt: row.last_opened_at,
  };
}
