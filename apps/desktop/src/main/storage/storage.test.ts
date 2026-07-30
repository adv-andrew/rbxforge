import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProjectRecord } from "../../shared/domain.js";
import { openDesktopDatabase } from "./database.js";
import { runMigrations } from "./migrations.js";
import { ConversationRepository } from "./conversation-repository.js";
import { ProjectRepository } from "./project-repository.js";
import { SettingsRepository } from "./settings-repository.js";

const roots: string[] = [];

describe("desktop storage", () => {
  afterEach(() => {
    roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
  });

  it("enables WAL and foreign keys and applies migrations once", () => {
    const harness = createStorageHarness();

    runMigrations(harness.database);

    expect(harness.database.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(harness.database.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(harness.database.prepare("SELECT COUNT(*) AS count FROM migrations").get()).toEqual({ count: 1 });
  });

  it("refuses a database with a migration newer than this application", () => {
    const root = createRoot();
    const database = openDesktopDatabase(join(root, "newer.sqlite3"));
    database.raw.exec("CREATE TABLE migrations (id INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
    database.prepare("INSERT INTO migrations (id, applied_at) VALUES (?, ?)").run(2, 1_700_000_000_000);

    expect(() => runMigrations(database)).toThrow(/newer version/i);
    database.close();
  });

  it("creates a project and New chat atomically, restores its draft, and cascades local rows", () => {
    const harness = createStorageHarness();
    const result = harness.projects.insertWithFirstThread(projectInput("project-1", "/game"));
    expect(result.kind).toBe("created");
    if (result.kind !== "created") throw new Error("expected a new project");

    harness.conversations.saveDraft(result.thread.id, "Make the lobby readable");
    harness.conversations.appendUserMessage(result.thread.id, "Keep the red restrained");

    expect(harness.conversations.loadDraft(result.thread.id)).toBeUndefined();
    expect(harness.conversations.listMessages(result.thread.id)).toEqual([
      expect.objectContaining({ content: "Keep the red restrained", role: "user" }),
    ]);

    harness.projects.remove(result.project.id);

    expect(harness.conversations.listThreads(result.project.id)).toEqual([]);
    expect(harness.database.prepare("SELECT COUNT(*) AS count FROM messages").get()).toEqual({ count: 0 });
    expect(harness.database.prepare("SELECT COUNT(*) AS count FROM drafts").get()).toEqual({ count: 0 });
  });

  it("focuses the existing canonical root instead of inserting a duplicate", () => {
    const harness = createStorageHarness();
    const first = harness.projects.insertWithFirstThread(projectInput("project-1", "/game"));
    expect(first.kind).toBe("created");
    if (first.kind !== "created") throw new Error("expected a new project");

    const second = harness.projects.insertWithFirstThread(projectInput("project-2", "/game"));

    expect(second).toEqual({ kind: "existing", project: first.project });
    expect(harness.projects.list()).toHaveLength(1);
    expect(harness.projects.selectedProjectId()).toBe(first.project.id);
  });

  it("survives closing and reopening without interpolating user-provided SQL punctuation", () => {
    const harness = createStorageHarness();
    const result = harness.projects.insertWithFirstThread(projectInput("project-'1", "/game-'root"));
    expect(result.kind).toBe("created");
    if (result.kind !== "created") throw new Error("expected a new project");

    const title = "Producer's plan; DROP TABLE threads; --";
    const content = "It's safe to say: '); DELETE FROM projects; --";
    harness.conversations.renameThread(result.thread.id, title);
    harness.conversations.saveDraft(result.thread.id, content);
    harness.conversations.appendUserMessage(result.thread.id, content);
    const draftThread = harness.conversations.createThread(result.project.id, "Unsent notes");
    harness.conversations.saveDraft(draftThread.id, "Keep this after reopening");
    harness.settings.setRojoPath("/Applications/Rojo's tools/rojo");
    harness.settings.setMcpPort(30_021);
    harness.settings.setSidebarWidth(356);
    harness.settings.setWindowBounds({ x: 10, y: 20, width: 1_200, height: 800 });
    harness.database.close();

    const reopened = createStorageHarness(harness.path);

    expect(reopened.projects.list()).toEqual([result.project]);
    expect(reopened.projects.selectedProjectId()).toBe(result.project.id);
    expect(reopened.conversations.listThreads(result.project.id)).toContainEqual(
      expect.objectContaining({ id: result.thread.id, title }),
    );
    expect(reopened.conversations.listMessages(result.thread.id)).toEqual([
      expect.objectContaining({ content, role: "user" }),
    ]);
    expect(reopened.conversations.loadDraft(result.thread.id)).toBeUndefined();
    expect(reopened.conversations.loadDraft(draftThread.id)?.content).toBe("Keep this after reopening");
    expect(reopened.conversations.selectedThreadId(result.project.id)).toBe(draftThread.id);
    expect(reopened.settings.getRojoPath()).toBe("/Applications/Rojo's tools/rojo");
    expect(reopened.settings.getMcpPort()).toBe(30_021);
    expect(reopened.settings.getSidebarWidth()).toBe(356);
    expect(reopened.settings.getWindowBounds()).toEqual({ x: 10, y: 20, width: 1_200, height: 800 });
    expect(reopened.database.prepare("SELECT COUNT(*) AS count FROM projects").get()).toEqual({ count: 1 });
    expect(reopened.database.prepare("SELECT COUNT(*) AS count FROM threads").get()).toEqual({ count: 2 });
  });

  it("keeps the active project selected when a different project is removed", () => {
    const harness = createStorageHarness();
    const first = harness.projects.insertWithFirstThread(projectInput("project-1", "/game-one"));
    const second = harness.projects.insertWithFirstThread(projectInput("project-2", "/game-two"));
    expect(first.kind).toBe("created");
    expect(second.kind).toBe("created");
    if (first.kind !== "created" || second.kind !== "created") throw new Error("expected new projects");

    harness.projects.remove(first.project.id);

    expect(harness.projects.selectedProjectId()).toBe(second.project.id);
  });

  it("replaces a final deleted thread and rejects malformed persisted place ids", () => {
    const harness = createStorageHarness();
    const result = harness.projects.insertWithFirstThread(projectInput("project-1", "/game"));
    expect(result.kind).toBe("created");
    if (result.kind !== "created") throw new Error("expected a new project");

    harness.conversations.deleteThread(result.thread.id);

    expect(harness.conversations.listThreads(result.project.id)).toEqual([
      expect.objectContaining({ title: "New chat" }),
    ]);
    harness.database
      .prepare("UPDATE projects SET serve_place_ids_json = ? WHERE id = ?")
      .run('[1, "bad"]', result.project.id);
    expect(() => harness.projects.findById(result.project.id)).toThrow(/serve place ids/i);
  });
});

function createStorageHarness(path = join(createRoot(), "rbxforge.sqlite3")) {
  const database = openDesktopDatabase(path);
  runMigrations(database);
  return {
    path,
    database,
    projects: new ProjectRepository(database),
    conversations: new ConversationRepository(database),
    settings: new SettingsRepository(database),
  };
}

function createRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "rbxforge-db-"));
  roots.push(root);
  return root;
}

function projectInput(id: string, canonicalRoot: string): ProjectRecord {
  return {
    id,
    displayName: "Deepwater",
    canonicalRoot,
    rootDevice: "16777232",
    rootInode: "42",
    canonicalProjectFile: `${canonicalRoot}/default.project.json`,
    projectFileDevice: "16777232",
    projectFileInode: "43",
    configDigest: "a".repeat(64),
    servePlaceIds: [1537690962],
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    lastOpenedAt: 1_700_000_000_000,
  };
}
