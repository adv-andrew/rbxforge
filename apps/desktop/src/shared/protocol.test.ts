import { describe, expect, it } from "vitest";
import { desktopCommandSchema, desktopEventSchema } from "./protocol.js";

describe("desktop protocol", () => {
  it("requires host-owned pinned Studio MCP identity and global port-change eligibility", () => {
    const runtime = {
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
      samePublishedPlaceLimitation: "Keep one edit window open per published place.",
    };
    const snapshot = {
      revision: 1,
      projects: [],
      threads: [],
      messages: [],
      drafts: [],
      selectedThreadIdByProject: {},
      runtimeByProject: { "project-1": runtime },
      settings: {
        preferredMcpPort: 58_741,
        sidebarWidth: 272,
        mcpPortChangeAllowed: true,
      },
    };

    expect(
      desktopEventSchema.safeParse({
        version: 1,
        type: "snapshot",
        snapshot,
      }).success,
    ).toBe(true);
    expect(
      desktopEventSchema.safeParse({
        version: 1,
        type: "snapshot",
        snapshot: {
          ...snapshot,
          runtimeByProject: {
            "project-1": {
              ...runtime,
              studioMcp: undefined,
            },
          },
        },
      }).success,
    ).toBe(false);
    expect(
      desktopEventSchema.safeParse({
        version: 1,
        type: "snapshot",
        snapshot: {
          ...snapshot,
          settings: {
            preferredMcpPort: 58_741,
            sidebarWidth: 272,
          },
        },
      }).success,
    ).toBe(false);
  });

  it("accepts only versioned, closed commands", () => {
    expect(
      desktopCommandSchema.parse({
        version: 1,
        requestId: "req-1",
        type: "thread.rename",
        projectId: "project-1",
        threadId: "thread-1",
        title: "Gameplay loop",
        expectedRevision: 8,
      }),
    ).toMatchObject({ type: "thread.rename", expectedRevision: 8 });
    expect(() =>
      desktopCommandSchema.parse({
        version: 1,
        requestId: "req-2",
        type: "runtime.selectStudio",
        projectId: "project-1",
        instanceId: "place:123",
        catalogRevision: 4,
        injectedInstanceId: "place:attacker",
      }),
    ).toThrow();
  });

  it("does not allow runtime identity in a persisted bootstrap event", () => {
    expect(() =>
      desktopEventSchema.parse({
        version: 1,
        type: "snapshot",
        snapshot: {
          revision: 1,
          projects: [],
          threads: [],
          messages: [],
          drafts: [],
          runtimeByProject: {},
          persistedBrokerEpoch: "must-not-exist",
        },
      }),
    ).toThrow();
  });

  it.each(["draft.save", "message.create"] as const)(
    "requires an exact project scope for %s and rejects extra forged ownership",
    (type) => {
      const base = {
        version: 1,
        requestId: "scoped-write",
        type,
        projectId: "project-a",
        threadId: "thread-a",
        content: "local",
        expectedRevision: 4,
      };
      expect(desktopCommandSchema.parse(base)).toMatchObject({
        type,
        projectId: "project-a",
        threadId: "thread-a",
      });
      const unscoped: Record<string, unknown> = { ...base };
      delete unscoped.projectId;
      expect(desktopCommandSchema.safeParse(unscoped).success).toBe(false);
      expect(desktopCommandSchema.safeParse({ ...base, ownerProjectId: "project-b" }).success).toBe(false);
    },
  );

  it("redacts secret-like diagnostics while parsing snapshots for renderer delivery", () => {
    const event = desktopEventSchema.parse({
      version: 1,
      type: "snapshot",
      snapshot: {
        revision: 1,
        projects: [],
        threads: [],
        messages: [],
        drafts: [],
        selectedThreadIdByProject: {},
        runtimeByProject: {
          "project-1": {
            state: "error",
            detail: "Studio connection failed",
            activeProject: {
              revision: 1,
              canonicalProjectFile: "/projects/deepwater/default.project.json",
              relativeProjectFile: "default.project.json",
              configDigest: "digest-a",
            },
            studioMcp: { serverVersion: "2.22.5" },
            catalog: [],
            error: {
              layer: "studio",
              code: "STUDIO_CONNECTION_FAILED",
              message: "Could not connect to Studio",
              diagnostic: "api_key=renderer-must-not-see-this",
              recovery: { action: "reconnect", label: "Reconnect" },
            },
            samePublishedPlaceLimitation: "Keep one edit window open per published place.",
          },
        },
        settings: { preferredMcpPort: 58_741, sidebarWidth: 272, mcpPortChangeAllowed: true },
      },
    });

    expect(event.snapshot.runtimeByProject["project-1"]?.error?.diagnostic).toBe("api_key=[REDACTED]");
  });

  it.each([
    ["unknown-place", 1_537_690_962],
    ["unpublished-place", 0],
  ] as const)("parses renderer-safe active identity and the explicit %s warning kind", (warningKind, placeId) => {
    const event = desktopEventSchema.parse({
      version: 1,
      type: "snapshot",
      snapshot: {
        revision: 2,
        projects: [],
        threads: [],
        messages: [],
        drafts: [],
        selectedThreadIdByProject: {},
        runtimeByProject: {
          "project-1": {
            state: "studio-selection-required",
            detail: "Choose the exact open Studio instance.",
            activeProject: {
              revision: 4,
              canonicalProjectFile: "/projects/deepwater/default.project.json",
              relativeProjectFile: "default.project.json",
              configDigest: "a".repeat(64),
            },
            studioMcp: { serverVersion: "2.22.5" },
            catalog: [
              {
                instanceId: "studio-a",
                role: "edit",
                placeId,
                placeName: "Deepwater",
                dataModelName: "Deepwater",
                pluginVersion: "2.22.5",
                pluginVariant: "main",
                serverVersion: "2.22.5",
                versionMismatch: false,
                connectedAt: 1,
                lastActivity: 2,
                eligible: true,
                warningRequired: true,
                warningKind,
              },
            ],
            samePublishedPlaceLimitation: "Keep one edit window open per published place.",
          },
        },
        settings: { preferredMcpPort: 58_741, sidebarWidth: 272, mcpPortChangeAllowed: true },
      },
    });

    expect(event.snapshot.runtimeByProject["project-1"]?.activeProject).toEqual({
      revision: 4,
      canonicalProjectFile: "/projects/deepwater/default.project.json",
      relativeProjectFile: "default.project.json",
      configDigest: "a".repeat(64),
    });
    expect(event.snapshot.runtimeByProject["project-1"]?.catalog[0]?.warningKind).toBe(warningKind);
  });

  it("accepts the ECMAScript Date boundary and rejects oversized Studio timestamps", () => {
    const maxDateTimestamp = 8_640_000_000_000_000;
    const runtime = {
      state: "studio-bound",
      detail: "Studio is bound.",
      activeProject: {
        revision: 1,
        canonicalProjectFile: "/projects/deepwater/default.project.json",
        relativeProjectFile: "default.project.json",
        configDigest: "digest-a",
      },
      studioMcp: { serverVersion: "2.22.5" },
      studio: {
        instanceId: "studio-a",
        placeId: 101,
        placeName: "Deepwater",
        dataModelName: "Deepwater",
        role: "edit",
        pluginVariant: "main",
        pluginVersion: "2.22.5",
        serverVersion: "2.22.5",
        connectedAt: maxDateTimestamp,
        lastActivity: maxDateTimestamp,
      },
      catalog: [
        {
          instanceId: "studio-a",
          role: "edit",
          placeId: 101,
          placeName: "Deepwater",
          dataModelName: "Deepwater",
          pluginVersion: "2.22.5",
          pluginVariant: "main",
          serverVersion: "2.22.5",
          versionMismatch: false,
          connectedAt: maxDateTimestamp,
          lastActivity: maxDateTimestamp,
          eligible: true,
          warningRequired: false,
        },
      ],
      samePublishedPlaceLimitation: "Keep one edit window open per published place.",
    };
    const eventFor = (runtimeOverride: typeof runtime) => ({
      version: 1,
      type: "snapshot",
      snapshot: {
        revision: 2,
        projects: [],
        threads: [],
        messages: [],
        drafts: [],
        selectedThreadIdByProject: {},
        runtimeByProject: { "project-1": runtimeOverride },
        settings: { preferredMcpPort: 58_741, sidebarWidth: 272, mcpPortChangeAllowed: true },
      },
    });

    expect(desktopEventSchema.safeParse(eventFor(runtime)).success).toBe(true);
    for (const oversizedRuntime of [
      {
        ...runtime,
        catalog: [{ ...runtime.catalog[0]!, connectedAt: maxDateTimestamp + 1 }],
      },
      {
        ...runtime,
        catalog: [{ ...runtime.catalog[0]!, lastActivity: maxDateTimestamp + 1 }],
      },
      {
        ...runtime,
        studio: { ...runtime.studio, connectedAt: maxDateTimestamp + 1 },
      },
      {
        ...runtime,
        studio: { ...runtime.studio, lastActivity: maxDateTimestamp + 1 },
      },
    ]) {
      expect(desktopEventSchema.safeParse(eventFor(oversizedRuntime)).success).toBe(false);
    }
  });

  it("rejects open-ended eligibility reasons and warning-required rows without a host warning kind", () => {
    const runtime = {
      state: "studio-selection-required",
      detail: "Choose the exact open Studio instance.",
      activeProject: {
        revision: 1,
        canonicalProjectFile: "/projects/deepwater/default.project.json",
        relativeProjectFile: "default.project.json",
        configDigest: "digest-a",
      },
      studioMcp: { serverVersion: "2.22.5" },
      catalog: [
        {
          instanceId: "studio-a",
          role: "edit",
          placeId: 101,
          placeName: "Deepwater",
          dataModelName: "Deepwater",
          pluginVersion: "",
          pluginVariant: "main",
          serverVersion: "2.22.5",
          versionMismatch: false,
          connectedAt: 1,
          lastActivity: 2,
          eligible: false,
          eligibilityReason: "made-up-reason",
          warningRequired: false,
        },
      ],
      samePublishedPlaceLimitation: "Keep one edit window open per published place.",
    };
    const snapshot = {
      revision: 2,
      projects: [],
      threads: [],
      messages: [],
      drafts: [],
      selectedThreadIdByProject: {},
      runtimeByProject: { "project-1": runtime },
      settings: { preferredMcpPort: 58_741, sidebarWidth: 272, mcpPortChangeAllowed: true },
    };
    expect(desktopEventSchema.safeParse({ version: 1, type: "snapshot", snapshot }).success).toBe(false);
    expect(
      desktopEventSchema.safeParse({
        version: 1,
        type: "snapshot",
        snapshot: {
          ...snapshot,
          runtimeByProject: {
            "project-1": {
              ...runtime,
              catalog: [
                {
                  ...runtime.catalog[0],
                  eligible: true,
                  eligibilityReason: undefined,
                  warningRequired: true,
                },
              ],
            },
          },
        },
      }).success,
    ).toBe(false);
  });
});
