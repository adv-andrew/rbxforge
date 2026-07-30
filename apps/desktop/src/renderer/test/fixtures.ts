import type { DesktopSnapshot, DraftRecord, MessageRecord, ProjectRecord, ThreadRecord } from "../../shared/domain.js";

export function project(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: "project-a",
    displayName: "Deepwater",
    canonicalRoot: "/projects/deepwater",
    rootDevice: "1",
    rootInode: "10",
    canonicalProjectFile: "/projects/deepwater/default.project.json",
    projectFileDevice: "1",
    projectFileInode: "11",
    configDigest: "digest-a",
    servePlaceIds: [101],
    createdAt: 1,
    updatedAt: 1,
    lastOpenedAt: 1,
    ...overrides,
  };
}

export function thread(overrides: Partial<ThreadRecord> = {}): ThreadRecord {
  return {
    id: "thread-a",
    projectId: "project-a",
    title: "New chat",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

export function message(overrides: Partial<MessageRecord> = {}): MessageRecord {
  return {
    id: "message-a",
    threadId: "thread-a",
    role: "user",
    content: "Make a round-based lobby.",
    createdAt: 1,
    ...overrides,
  };
}

export function draft(overrides: Partial<DraftRecord> = {}): DraftRecord {
  return {
    threadId: "thread-a",
    content: "",
    updatedAt: 1,
    ...overrides,
  };
}

export function snapshot(overrides: Partial<DesktopSnapshot> = {}): DesktopSnapshot {
  return {
    revision: 1,
    projects: [project()],
    threads: [thread()],
    messages: [],
    drafts: [draft()],
    selectedProjectId: "project-a",
    selectedThreadIdByProject: { "project-a": "thread-a" },
    runtimeByProject: {
      "project-a": {
        state: "needs-reconnect",
        detail: "Reconnect this project to verify Rojo and Studio.",
        activeProject: {
          revision: 1,
          canonicalProjectFile: "/projects/deepwater/default.project.json",
          relativeProjectFile: "default.project.json",
          configDigest: "digest-a",
        },
        studioMcp: { serverVersion: "2.22.5" },
        catalog: [],
        samePublishedPlaceLimitation:
          "RbxForge cannot detect or distinguish two Studio edit windows for the same published place. Keep only one such window open before binding.",
      },
    },
    settings: { preferredMcpPort: 58_741, sidebarWidth: 272, mcpPortChangeAllowed: true },
    ...overrides,
  };
}
