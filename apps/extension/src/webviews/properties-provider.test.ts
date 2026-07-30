import { MutationJournal, type Ownership } from "@rbxforge/core";
import type { HostMessage, PropertyProposal } from "@rbxforge/webview-ui/protocol";
import { describe, expect, test, vi } from "vitest";

import {
  PropertiesProvider,
  PropertiesWebviewProvider,
  type PropertiesSelection,
  type StudioPropertiesPort,
} from "./properties-provider.js";
import { createFixtureServices } from "../service-container.js";
import { FakeVsCode, FakeWebview } from "../test/fake-vscode.js";
import type { DisposablePort, EventPort } from "../vscode-facade.js";

const selection: PropertiesSelection = {
  instanceId: "place:123",
  instancePath: "game.Workspace.Part",
  name: "Part",
  placeName: "Forge",
  ownership: "studio",
  freshness: "fresh",
  generation: 4,
  graphRevision: 1,
  simulation: false,
};

const studioProperties = {
  instancePath: selection.instancePath,
  className: "Part",
  properties: {
    Name: "Part",
    Anchored: "false",
    Transparency: "0.25",
    Position: "ambiguous",
    CFrame: "0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1",
    Source: "print('must never cross')",
    apiToken: "must never cross",
    Password: "top-level-password-key-sentinel",
    PASSWD: "top-level-passwd-key-sentinel",
    Description: "password=x",
  },
};

class FakeStudio implements StudioPropertiesPort {
  readonly propertyCalls: Array<{ readonly path: string; readonly expectedInstanceId: string }> = [];
  readonly writes: Array<{
    readonly tool: string;
    readonly input: Readonly<Record<string, unknown>>;
    readonly expectedInstanceId: string | undefined;
    readonly expectedGraphRevision: number;
  }> = [];
  activeInstanceId: string | undefined = selection.instanceId;
  stale = false;
  responses = [
    studioProperties,
    studioProperties,
    { ...studioProperties, properties: { ...studioProperties.properties, Anchored: "true" } },
  ];

  snapshot(): { readonly activeInstanceId: string | undefined; readonly stale: boolean } {
    return { activeInstanceId: this.activeInstanceId, stale: this.stale };
  }

  async properties(path: string, options: { readonly expectedInstanceId: string }): Promise<typeof studioProperties> {
    this.propertyCalls.push({ path, expectedInstanceId: options.expectedInstanceId });
    const response = this.responses.shift();
    if (response === undefined) throw new Error("No response");
    return response;
  }

  async callWrite(
    tool: string,
    input: Readonly<Record<string, unknown>>,
    context: { readonly expectedInstanceId?: string; readonly expectedGraphRevision: number },
  ): Promise<unknown> {
    this.writes.push({
      tool,
      input,
      expectedInstanceId: context.expectedInstanceId,
      expectedGraphRevision: context.expectedGraphRevision,
    });
    return { success: true };
  }
}

function proposal(snapshotId: string): PropertyProposal {
  return {
    instanceId: selection.instanceId,
    instancePath: selection.instancePath,
    propertyName: "Anchored",
    snapshotId,
    value: true,
    displayGeneration: selection.generation,
  };
}

function create(
  studio = new FakeStudio(),
  resolveSelection = vi.fn(async () => selection),
  createId: () => string = () => "journal-1",
) {
  const messages: HostMessage[] = [];
  const journal = new MutationJournal();
  const provider = new PropertiesProvider({
    studio,
    journal,
    sessionId: "panel-session",
    resolveSelection,
    publish: async (message) => {
      messages.push(message);
    },
    now: () => 1_000,
    createId,
  });
  return { provider, studio, journal, messages, resolveSelection };
}

class TestEvent<T> {
  readonly #listeners = new Set<(value: T) => void>();
  readonly event: EventPort<T> = (listener) => {
    this.#listeners.add(listener);
    return { dispose: () => this.#listeners.delete(listener) } satisfies DisposablePort;
  };
  emit(value: T): void {
    for (const listener of this.#listeners) listener(value);
  }
}

async function eventually(assertion: () => void): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      assertion();
      return;
    } catch {
      await Promise.resolve();
    }
  }
  assertion();
}

describe("PropertiesProvider", () => {
  test("reads with the expected instance and excludes Source and secret-like fields from the snapshot", async () => {
    const { provider, studio } = create();
    const snapshot = await provider.refresh(selection);

    expect(studio.propertyCalls).toEqual([
      {
        path: selection.instancePath,
        expectedInstanceId: selection.instanceId,
      },
    ]);
    expect(snapshot.properties.map(({ name }) => name)).not.toContain("Source");
    expect(snapshot.properties.map(({ name }) => name)).not.toContain("apiToken");
    expect(snapshot.properties.map(({ name }) => name)).not.toContain("Password");
    expect(snapshot.properties.map(({ name }) => name)).not.toContain("PASSWD");
    expect(snapshot.properties.map(({ name }) => name)).not.toContain("Description");
    expect(JSON.stringify(snapshot)).not.toMatch(
      /print\\|must never cross|apiToken|Source"|top-level-password-key-sentinel|top-level-passwd-key-sentinel|password=x/,
    );
    expect(snapshot.properties.find(({ name }) => name === "Anchored")).toMatchObject({
      kind: "boolean",
      editable: true,
      liveValue: false,
    });
    expect(snapshot.properties.find(({ name }) => name === "CFrame")).toMatchObject({
      kind: "CFrame",
      editable: false,
    });
    expect(snapshot.properties.find(({ name }) => name === "Position")).toMatchObject({
      kind: "Vector3",
      editable: false,
      blockedReason: "Unsupported or ambiguous live value",
    });
  });

  test("redacts nested secret-like keys from unsupported structured raw values", async () => {
    const studio = new FakeStudio();
    studio.responses[0] = {
      ...studioProperties,
      properties: {
        Mystery: {
          visible: 1,
          nested: {
            apiToken: "nested-secret",
            credentialPath: "/hidden",
            password: "nested-password-key-sentinel",
            passwd: "nested-passwd-key-sentinel",
            detail: "DB_PASSWORD=q",
          },
        },
      },
    };
    const { provider } = create(studio);

    const snapshot = await provider.refresh(selection);

    expect(snapshot.properties[0]?.rawValue).toContain('"visible":1');
    expect(snapshot.properties[0]?.rawValue).toContain("[sensitive value omitted]");
    expect(JSON.stringify(snapshot)).not.toMatch(
      /apiToken|credentialPath|nested-secret|hidden|nested-password-key-sentinel|nested-passwd-key-sentinel|DB_PASSWORD=q/,
    );
  });

  test("bounds deep and cyclic unsupported property values without retaining cyclic content", async () => {
    const studio = new FakeStudio();
    const cyclic: Record<string, unknown> = {
      visible: "safe",
      long: "x".repeat(20_000),
    };
    cyclic.self = cyclic;
    let deep: Record<string, unknown> = { leaf: "deep-property-sentinel" };
    for (let index = 0; index < 20; index += 1) deep = { child: deep };
    studio.responses[0] = {
      ...studioProperties,
      properties: {
        Mystery: { cyclic, deep, wide: Array.from({ length: 200 }, (_, index) => index) },
      },
    };
    const { provider } = create(studio);

    const snapshot = await provider.refresh(selection);
    const rawValue = snapshot.properties[0]?.rawValue ?? "";

    expect(rawValue).toContain("[cyclic value omitted]");
    expect(rawValue).toContain("[nested value omitted]");
    expect(rawValue.length).toBeLessThanOrEqual(8_192);
    expect(rawValue).not.toContain("deep-property-sentinel");
  });

  test("keeps class-ambiguous Value read-only instead of guessing number", async () => {
    const studio = new FakeStudio();
    studio.responses[0] = {
      instancePath: selection.instancePath,
      className: "StringValue",
      properties: { Value: "hello" },
    };
    const { provider } = create(studio);

    const snapshot = await provider.refresh(selection);

    expect(snapshot.properties[0]).toMatchObject({
      name: "Value",
      editable: false,
      kind: "unknown",
      rawValue: "hello",
    });
  });

  test("revalidates, uses the accepted set_property gate once, re-reads, verifies, journals, and publishes status", async () => {
    const { provider, studio, journal, messages, resolveSelection } = create();
    const snapshot = await provider.refresh(selection);

    const outcome = await provider.propose(proposal(snapshot.snapshotId), "webview:1");

    expect(resolveSelection).toHaveBeenCalledTimes(1);
    expect(studio.propertyCalls).toEqual([
      { path: selection.instancePath, expectedInstanceId: selection.instanceId },
      { path: selection.instancePath, expectedInstanceId: selection.instanceId },
      { path: selection.instancePath, expectedInstanceId: selection.instanceId },
    ]);
    expect(studio.writes).toEqual([
      {
        tool: "set_property",
        input: {
          instancePath: selection.instancePath,
          propertyName: "Anchored",
          propertyValue: true,
        },
        expectedInstanceId: selection.instanceId,
        expectedGraphRevision: selection.graphRevision,
      },
    ]);
    expect(outcome).toEqual({ verification: "verified" });
    expect(journal.entries()).toEqual([
      expect.objectContaining({
        instanceId: selection.instanceId,
        target: `${selection.instancePath}.Anchored`,
        before: false,
        requested: true,
        result: "applied",
        verification: "verified",
      }),
    ]);
    expect(messages.map(({ type }) => type)).toEqual(["mutationStatus", "mutationStatus", "mutationStatus"]);
    expect(messages.at(-1)).toMatchObject({
      v: 1,
      sessionId: "panel-session",
      generation: selection.generation,
      state: "complete",
      verification: "verified",
    });
  });

  test("uses the accepted inbound operation ID and a unique sequence for every mutation transition", async () => {
    const studio = new FakeStudio();
    studio.responses.push(
      { ...studioProperties, properties: { ...studioProperties.properties, Anchored: "true" } },
      { ...studioProperties, properties: { ...studioProperties.properties, Anchored: "true" } },
    );
    let journalSequence = 0;
    const { provider, messages } = create(
      studio,
      vi.fn(async () => selection),
      () => `journal-${++journalSequence}`,
    );
    const displayed = await provider.refresh(selection);

    await provider.propose(proposal(displayed.snapshotId), "webview:1");
    await provider.propose(proposal(displayed.snapshotId), "webview:2");

    const requestIds = messages.map(({ requestId }) => requestId);
    expect(requestIds).toEqual([
      "mutation:webview:1:1",
      "mutation:webview:1:2",
      "mutation:webview:1:3",
      "mutation:webview:2:1",
      "mutation:webview:2:2",
      "mutation:webview:2:3",
    ]);
    expect(new Set(requestIds).size).toBe(requestIds.length);
  });

  test("never reports Verified when the re-read resolves to another path", async () => {
    const studio = new FakeStudio();
    studio.responses[2] = { ...studioProperties, instancePath: "game.Workspace.Other" };
    const { provider, messages, journal } = create(studio);
    const snapshot = await provider.refresh(selection);

    const outcome = await provider.propose(proposal(snapshot.snapshotId), "webview:1");

    expect(outcome.verification).not.toBe("verified");
    expect(messages.at(-1)).not.toMatchObject({ verification: "verified" });
    expect(journal.entries()[0]?.verification).not.toBe("verified");
  });

  test.each([
    { change: { snapshotId: "old-snapshot" }, reason: "snapshot" },
    { change: { instanceId: "place:other" }, reason: "instance" },
    { change: { instancePath: "game.Workspace.Other" }, reason: "path" },
    { change: { displayGeneration: 3 }, reason: "generation" },
    { change: { propertyName: "CFrame", value: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1] }, reason: "editable" },
  ])("blocks stale or unsupported proposal before mutation: $reason", async ({ change }) => {
    const { provider, studio } = create();
    const snapshot = await provider.refresh(selection);

    await expect(
      provider.propose({ ...proposal(snapshot.snapshotId), ...change } as PropertyProposal, "webview:1"),
    ).rejects.toThrow();
    expect(studio.writes).toEqual([]);
  });

  test("rejects a same-path cross-place race before mutation", async () => {
    const otherPlace = { ...selection, instanceId: "place:456" };
    const { provider, studio } = create(
      new FakeStudio(),
      vi.fn(async () => otherPlace),
    );
    const snapshot = await provider.refresh(selection);

    await expect(provider.propose(proposal(snapshot.snapshotId), "webview:1")).rejects.toThrow("selection changed");
    expect(studio.writes).toEqual([]);
  });

  test("fails closed when the unified graph is invalidated after the snapshot was displayed", async () => {
    const invalidated = { ...selection, graphRevision: 2 };
    const { provider, studio } = create(
      new FakeStudio(),
      vi.fn(async () => invalidated),
    );
    const displayed = await provider.refresh(selection);

    await expect(provider.propose(proposal(displayed.snapshotId), "webview:1")).rejects.toThrow("graph changed");
    expect(studio.writes).toEqual([]);
  });
});

test("PropertiesWebviewProvider suppresses an older same-generation refresh that completes after a newer one", async () => {
  const fixture = createFixtureServices();
  const pending: Array<(value: typeof studioProperties) => void> = [];
  let propertyCall = 0;
  const services = {
    ...fixture,
    graph: {
      ...fixture.graph,
      resolve: async () => ({
        node: {
          path: selection.instancePath,
          name: selection.name,
          className: "Part",
          ownership: "studio" as const,
          studio: { path: selection.instancePath, name: selection.name, className: "Part" },
          children: [],
          unsafeUnknownChildren: false,
          unsafeParent: false,
        },
        revision: 1,
      }),
      assertRevision: () => undefined,
    },
    studio: {
      ...fixture.studio,
      guardedProperties: async () => {
        propertyCall += 1;
        if (propertyCall === 1) return studioProperties;
        return new Promise<typeof studioProperties>((resolve) => pending.push(resolve));
      },
    },
  };
  const provider = new PropertiesWebviewProvider({ services, vscode: new FakeVsCode() });
  provider.selectTarget({
    path: selection.instancePath,
    name: selection.name,
    className: "Part",
    ownership: "studio",
  });
  const webview = new FakeWebview("/extension");
  await provider.resolveWebviewView({ webview });
  const init = webview.posted[0] as Extract<HostMessage, { readonly type: "init" }>;
  webview.receive({
    v: 1,
    type: "ready",
    sessionId: init.sessionId,
    requestId: "ready",
    generation: init.generation,
  });
  await eventually(() => expect(webview.posted.filter(isPropertiesSnapshot)).toHaveLength(1));

  webview.receive({
    v: 1,
    type: "refreshProperties",
    sessionId: init.sessionId,
    requestId: "refresh-a",
    generation: init.generation,
  });
  webview.receive({
    v: 1,
    type: "refreshProperties",
    sessionId: init.sessionId,
    requestId: "refresh-b",
    generation: init.generation,
  });
  await eventually(() => expect(pending).toHaveLength(2));
  pending[1]?.({ ...studioProperties, properties: { ...studioProperties.properties, Anchored: "true" } });
  await Promise.resolve();
  pending[0]?.({ ...studioProperties, properties: { ...studioProperties.properties, Anchored: "false" } });
  await eventually(() => expect(webview.posted.filter(isPropertiesSnapshot)).toHaveLength(2));

  const snapshots = webview.posted.filter(isPropertiesSnapshot);
  expect(snapshots.at(-1)?.snapshot.properties.find(({ name }) => name === "Anchored")?.liveValue).toBe(true);
  provider.dispose();
  await fixture.dispose();
});

test("PropertiesWebviewProvider re-resolves ownership and blocks a target that changed after opening", async () => {
  const fixture = createFixtureServices();
  for (const id of fixture.connection.requiredCheckIds()) {
    fixture.connection.update(id, { health: "healthy", detail: "ready" });
  }
  let ownership: Ownership = "studio";
  let graphRevision = 1;
  const callWrite = vi.fn(async () => ({ success: true }));
  const services = {
    ...fixture,
    graph: {
      ...fixture.graph,
      resolve: async () => ({
        node: {
          path: selection.instancePath,
          name: selection.name,
          className: "Part",
          ownership,
          studio: { path: selection.instancePath, name: selection.name, className: "Part" },
          children: [],
          unsafeUnknownChildren: false,
          unsafeParent: false,
        },
        revision: graphRevision,
      }),
      assertRevision: (expected: number) => {
        if (expected !== graphRevision) throw new Error("Unified graph changed before mutation");
      },
    },
    studio: {
      ...fixture.studio,
      guardedProperties: async () => studioProperties,
      callWrite,
    },
  };
  const provider = new PropertiesWebviewProvider({ services, vscode: new FakeVsCode() });
  provider.selectTarget({
    path: selection.instancePath,
    name: selection.name,
    className: "Part",
    ownership: "studio",
  });
  const webview = new FakeWebview("/extension");
  await provider.resolveWebviewView({ webview });
  const init = webview.posted[0] as Extract<HostMessage, { readonly type: "init" }>;
  webview.receive({
    v: 1,
    type: "ready",
    sessionId: init.sessionId,
    requestId: "ready",
    generation: init.generation,
  });
  await eventually(() => expect(webview.posted.filter(isPropertiesSnapshot)).toHaveLength(1));
  const displayed = webview.posted.filter(isPropertiesSnapshot)[0]!.snapshot;

  ownership = "shared";
  graphRevision += 1;
  webview.receive({
    v: 1,
    type: "proposePropertyMutation",
    sessionId: init.sessionId,
    requestId: "mutation-1",
    generation: init.generation,
    proposal: {
      instanceId: displayed.instanceId,
      instancePath: displayed.instancePath,
      propertyName: "Anchored",
      snapshotId: displayed.snapshotId,
      value: true,
      displayGeneration: init.generation,
    },
  });

  await eventually(() => expect(webview.posted.some((message) => isBlockedMutation(message))).toBe(true));
  expect(callWrite).not.toHaveBeenCalled();
  provider.dispose();
  await fixture.dispose();
});

test("PropertiesWebviewProvider replaces an editable snapshot with a new generation when the graph invalidates", async () => {
  const fixture = createFixtureServices();
  const invalidated = new TestEvent<{ readonly path: string }>();
  const services = {
    ...fixture,
    graph: {
      ...fixture.graph,
      onGraphInvalidated: invalidated.event,
      resolve: async () => ({
        node: {
          path: selection.instancePath,
          name: selection.name,
          className: "Part",
          ownership: "studio" as const,
          studio: { path: selection.instancePath, name: selection.name, className: "Part" },
          children: [],
          unsafeUnknownChildren: false,
          unsafeParent: false,
        },
        revision: 1,
      }),
      assertRevision: () => undefined,
    },
    studio: {
      ...fixture.studio,
      guardedProperties: async () => studioProperties,
    },
  };
  const provider = new PropertiesWebviewProvider({ services, vscode: new FakeVsCode() });
  provider.selectTarget({
    path: selection.instancePath,
    name: selection.name,
    className: "Part",
    ownership: "studio",
  });
  const webview = new FakeWebview("/extension");
  await provider.resolveWebviewView({ webview });
  const init = webview.posted[0] as Extract<HostMessage, { readonly type: "init" }>;
  webview.receive({
    v: 1,
    type: "ready",
    sessionId: init.sessionId,
    requestId: "ready",
    generation: init.generation,
  });
  await eventually(() => expect(webview.posted.filter(isPropertiesSnapshot)).toHaveLength(1));

  invalidated.emit({ path: "game.Workspace" });

  await eventually(() => expect(webview.posted.filter(isInit)).toHaveLength(2));
  expect(webview.posted.filter(isInit)[1]).toMatchObject({
    sessionId: init.sessionId,
    generation: init.generation + 1,
    view: "properties",
  });
  provider.dispose();
  await fixture.dispose();
});

function isPropertiesSnapshot(value: unknown): value is Extract<HostMessage, { readonly type: "propertiesSnapshot" }> {
  return (
    value !== null &&
    typeof value === "object" &&
    (value as Readonly<Record<string, unknown>>).type === "propertiesSnapshot"
  );
}

function isBlockedMutation(value: unknown): value is Extract<HostMessage, { readonly type: "mutationStatus" }> {
  return (
    value !== null &&
    typeof value === "object" &&
    (value as Readonly<Record<string, unknown>>).type === "mutationStatus" &&
    (value as Readonly<Record<string, unknown>>).state === "blocked"
  );
}

function isInit(value: unknown): value is Extract<HostMessage, { readonly type: "init" }> {
  return value !== null && typeof value === "object" && (value as Readonly<Record<string, unknown>>).type === "init";
}
