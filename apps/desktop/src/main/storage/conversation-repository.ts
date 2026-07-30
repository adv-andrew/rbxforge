import type { DraftRecord, MessageRecord, ThreadRecord } from "../../shared/domain.js";
import type { DesktopDatabase } from "./database.js";
import { StorageError } from "./database.js";

type ThreadRow = {
  readonly id: string;
  readonly project_id: string;
  readonly title: string;
  readonly created_at: number;
  readonly updated_at: number;
};

type MessageRow = {
  readonly id: string;
  readonly thread_id: string;
  readonly role: "user" | "system";
  readonly content: string;
  readonly created_at: number;
};

type DraftRow = { readonly thread_id: string; readonly content: string; readonly updated_at: number };

export class ConversationRepository {
  constructor(private readonly database: DesktopDatabase) {}

  listThreads(projectId: string): ThreadRecord[] {
    return (
      this.database
        .prepare("SELECT * FROM threads WHERE project_id = ? ORDER BY updated_at DESC, created_at ASC")
        .all(projectId) as ThreadRow[]
    ).map(hydrateThread);
  }

  createThread(projectId: string, title = "New chat"): ThreadRecord {
    return this.database.transaction(() => {
      const now = Date.now();
      const thread: ThreadRecord = { id: crypto.randomUUID(), projectId, title, createdAt: now, updatedAt: now };
      this.database
        .prepare("INSERT INTO threads (id, project_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
        .run(thread.id, thread.projectId, thread.title, thread.createdAt, thread.updatedAt);
      this.writeSelectedThread(projectId, thread.id);
      return thread;
    });
  }

  renameThread(threadId: string, title: string): ThreadRecord | undefined {
    return this.database.transaction(() => {
      const thread = this.findThread(threadId);
      if (thread === undefined) return undefined;
      this.database
        .prepare("UPDATE threads SET title = ?, updated_at = ? WHERE id = ?")
        .run(title, Date.now(), threadId);
      return this.findThread(threadId);
    });
  }

  deleteThread(threadId: string): void {
    this.database.transaction(() => {
      const thread = this.findThread(threadId);
      if (thread === undefined) return;
      const count = this.database
        .prepare("SELECT COUNT(*) AS count FROM threads WHERE project_id = ?")
        .get(thread.projectId) as {
        readonly count: number;
      };
      const selectedThreadId = this.selectedThreadId(thread.projectId);
      if (count.count === 1) {
        const replacement = this.createThread(thread.projectId);
        this.database.prepare("DELETE FROM threads WHERE id = ?").run(threadId);
        this.writeSelectedThread(thread.projectId, replacement.id);
        return;
      }
      this.database.prepare("DELETE FROM threads WHERE id = ?").run(threadId);
      if (selectedThreadId === threadId) {
        const replacement = this.listThreads(thread.projectId)[0];
        if (replacement !== undefined) this.writeSelectedThread(thread.projectId, replacement.id);
      }
    });
  }

  selectThread(projectId: string, threadId: string): ThreadRecord {
    const thread = this.findThread(threadId);
    if (thread === undefined || thread.projectId !== projectId) {
      throw new StorageError("thread-not-found", "The selected conversation does not belong to this project.");
    }
    this.writeSelectedThread(projectId, threadId);
    return thread;
  }

  selectedThreadId(projectId: string): string | undefined {
    const row = this.database.prepare("SELECT value FROM app_state WHERE key = ?").get(selectedThreadKey(projectId)) as
      { readonly value: string } | undefined;
    return row?.value;
  }

  listMessages(threadId: string): MessageRecord[] {
    return (
      this.database
        .prepare("SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at ASC")
        .all(threadId) as MessageRow[]
    ).map(hydrateMessage);
  }

  appendUserMessage(threadId: string, content: string): MessageRecord {
    return this.database.transaction(() => {
      const thread = this.findThread(threadId);
      if (thread === undefined) throw new StorageError("thread-not-found", "The conversation no longer exists.");
      const message: MessageRecord = {
        id: crypto.randomUUID(),
        threadId,
        role: "user",
        content,
        createdAt: Date.now(),
      };
      this.database
        .prepare("INSERT INTO messages (id, thread_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(message.id, message.threadId, message.role, message.content, message.createdAt);
      this.database.prepare("DELETE FROM drafts WHERE thread_id = ?").run(threadId);
      this.database.prepare("UPDATE threads SET updated_at = ? WHERE id = ?").run(message.createdAt, threadId);
      return message;
    });
  }

  loadDraft(threadId: string): DraftRecord | undefined {
    const row = this.database.prepare("SELECT * FROM drafts WHERE thread_id = ?").get(threadId) as DraftRow | undefined;
    return row === undefined ? undefined : hydrateDraft(row);
  }

  saveDraft(threadId: string, content: string): DraftRecord {
    const draft: DraftRecord = { threadId, content, updatedAt: Date.now() };
    this.database
      .prepare(
        "INSERT INTO drafts (thread_id, content, updated_at) VALUES (?, ?, ?) ON CONFLICT(thread_id) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at",
      )
      .run(draft.threadId, draft.content, draft.updatedAt);
    return draft;
  }

  private findThread(threadId: string): ThreadRecord | undefined {
    const row = this.database.prepare("SELECT * FROM threads WHERE id = ?").get(threadId) as ThreadRow | undefined;
    return row === undefined ? undefined : hydrateThread(row);
  }

  private writeSelectedThread(projectId: string, threadId: string): void {
    this.database
      .prepare("INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(selectedThreadKey(projectId), threadId);
  }
}

function selectedThreadKey(projectId: string): string {
  return `selected_thread:${projectId}`;
}

function hydrateThread(row: ThreadRow): ThreadRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function hydrateMessage(row: MessageRow): MessageRecord {
  return { id: row.id, threadId: row.thread_id, role: row.role, content: row.content, createdAt: row.created_at };
}

function hydrateDraft(row: DraftRow): DraftRecord {
  return { threadId: row.thread_id, content: row.content, updatedAt: row.updated_at };
}
