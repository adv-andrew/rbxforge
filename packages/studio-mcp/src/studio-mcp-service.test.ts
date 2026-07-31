import { FakeMcpClient } from "@rbxforge/test-fixtures";
import type { MutationProposal } from "@rbxforge/core";
import type { McpClientPort, StudioAgentMutationClaim, StudioInstance } from "./types.js";
import { describe, expect, test, vi } from "vitest";

import {
  CapabilityUnavailableError,
  McpResponseError,
  MutationAuthorizationBoundaryError,
  StudioMcpService,
  ToolClassificationError,
} from "./studio-mcp-service.js";

const tools = [
  "get_connected_instances",
  "get_file_tree",
  "get_instance_children",
  "get_instance_properties",
  "get_selection",
  "set_property",
  "set_properties",
  "create_object",
  "delete_object",
].map((name) => ({ name, inputSchema: { type: "object" } }));

const instance = {
  instanceId: "place:123",
  role: "edit",
  placeId: 123,
  placeName: "Forge",
  dataModelName: "Forge",
  isRunning: false,
  pluginVersion: "2.22.5",
  pluginVariant: "stable",
  serverVersion: "2.22.5",
  versionMismatch: false,
  lastActivity: 100,
  connectedAt: 10,
};

function textBody(body: object): { content: readonly { type: "text"; text: string }[] } {
  return { content: [{ type: "text", text: JSON.stringify(body) }] };
}

function instancesBody(instances: readonly object[]): { content: readonly { type: "text"; text: string }[] } {
  return textBody({ instances, count: instances.length });
}

const ownership = { ownership: "studio", expectedGraphRevision: 7 } as const;

const allowingGate = {
  async authorize(): Promise<{ readonly approved: true; readonly authorizationId: string }> {
    return { approved: true, authorizationId: "authorization-allowed" };
  },
  consume: () => undefined,
};

function createService(client: FakeMcpClient): StudioMcpService {
  return new StudioMcpService(client, allowingGate);
}

async function selectFromCatalog(service: StudioMcpService, instanceId = instance.instanceId): Promise<StudioInstance> {
  await service.listConnectedInstances();
  return service.selectInstance(instanceId);
}

class DeferredCatalogClient implements McpClientPort {
  readonly calls: Array<{ readonly name: string; readonly arguments: Record<string, unknown> }> = [];
  readonly #catalogResolvers: Array<(value: unknown) => void> = [];

  async listTools(): Promise<{ tools: readonly { name: string; inputSchema: unknown }[] }> {
    return { tools };
  }

  async callTool(input: { readonly name: string; readonly arguments: Record<string, unknown> }): Promise<unknown> {
    this.calls.push(input);
    return new Promise((resolve) => {
      this.#catalogResolvers.push(resolve);
    });
  }

  resolveCatalog(index: number, instances: readonly object[]): void {
    const resolve = this.#catalogResolvers[index];
    if (resolve === undefined) throw new Error(`Catalog request ${index} is not pending`);
    resolve(instancesBody(instances));
  }

  async close(): Promise<void> {}
}

describe("StudioMcpService", () => {
  test("discovers runtime tools and exposes the selected tool for each capability", async () => {
    const service = new StudioMcpService(new FakeMcpClient({ tools }), allowingGate);

    await expect(service.discover()).resolves.toEqual(new Set(tools.map(({ name }) => name)));
    expect(service.snapshot().capabilities).toMatchObject({
      connectedInstances: "get_connected_instances",
      tree: "get_file_tree",
      children: "get_instance_children",
      properties: "get_instance_properties",
      selection: "get_selection",
    });
  });

  test("reports a typed unavailable capability when children or tree tools are absent", async () => {
    const service = new StudioMcpService(
      new FakeMcpClient({
        tools: [{ name: "get_connected_instances", inputSchema: {} }],
      }),
      allowingGate,
    );
    await service.discover();

    await expect(service.children("game.Workspace")).rejects.toBeInstanceOf(CapabilityUnavailableError);
    await expect(service.callRead("tree", { path: "game" })).rejects.toBeInstanceOf(CapabilityUnavailableError);
  });

  test("does not auto-select the only connected place in explicit mode", async () => {
    const service = new StudioMcpService(
      new FakeMcpClient({
        tools,
        responses: [instancesBody([instance])],
      }),
      allowingGate,
      { selectionMode: "explicit" },
    );

    await expect(service.listConnectedInstances()).resolves.toEqual([instance]);
    expect(service.snapshot()).toMatchObject({ activeInstanceId: undefined, stale: false });
    await expect(service.children("game.Workspace")).rejects.toThrow("Active Studio place must be selected");
  });

  test("selects only a frozen instance from the latest successful catalog", async () => {
    const service = createService(
      new FakeMcpClient({
        tools,
        responses: [instancesBody([instance])],
      }),
    );

    expect(() => service.selectInstance(instance.instanceId)).toThrow("successful Studio catalog");
    const catalog = await service.listConnectedInstances();
    expect(() => service.selectInstance("place:forged")).toThrow("not present in the latest Studio catalog");
    const selected = service.selectInstance(instance.instanceId);

    expect(selected).toBe(catalog[0]);
    expect(Object.isFrozen(selected)).toBe(true);
    expect(service.snapshot()).toMatchObject({ activeInstanceId: instance.instanceId, stale: false });
  });

  test("clearSelectedInstance removes routing and clears stale state", async () => {
    const service = createService(
      new FakeMcpClient({
        tools,
        responses: [instancesBody([instance])],
      }),
    );
    await service.listConnectedInstances();
    service.selectInstance(instance.instanceId);

    service.clearSelectedInstance();

    expect(service.snapshot()).toMatchObject({ activeInstanceId: undefined, stale: false });
    await expect(service.children("game.Workspace")).rejects.toThrow("Active Studio place must be selected");
  });

  test("disappearance clears selection and explicit mode never selects a replacement", async () => {
    const replacement = { ...instance, instanceId: "place:456", placeId: 456 };
    const service = createService(
      new FakeMcpClient({
        tools,
        responses: [instancesBody([instance]), instancesBody([]), instancesBody([replacement])],
      }),
    );
    await service.listConnectedInstances();
    service.selectInstance(instance.instanceId);

    await service.listConnectedInstances();
    expect(service.snapshot()).toMatchObject({ activeInstanceId: undefined, stale: true });

    await service.listConnectedInstances();
    expect(service.snapshot()).toMatchObject({ activeInstanceId: undefined, stale: true });
  });

  test("legacy-auto alone selects a sole connected instance", async () => {
    const explicit = createService(new FakeMcpClient({ tools, responses: [instancesBody([instance])] }));
    const legacy = new StudioMcpService(
      new FakeMcpClient({ tools, responses: [instancesBody([instance])] }),
      allowingGate,
      { selectionMode: "legacy-auto" },
    );

    await explicit.listConnectedInstances();
    await legacy.listConnectedInstances();

    expect(explicit.snapshot().activeInstanceId).toBeUndefined();
    expect(legacy.snapshot().activeInstanceId).toBe(instance.instanceId);
  });

  test("a late older catalog response returns the latest committed catalog without rolling state backward", async () => {
    const older = { ...instance, instanceId: "place:older", placeId: 1 };
    const newer = { ...instance, instanceId: "place:newer", placeId: 2 };
    const client = new DeferredCatalogClient();
    const service = new StudioMcpService(client, allowingGate);
    await service.discover();

    const olderRefresh = service.listConnectedInstances();
    const newerRefresh = service.listConnectedInstances();
    await vi.waitFor(() => expect(client.calls).toHaveLength(2));

    client.resolveCatalog(1, [newer]);
    const latestCatalog = await newerRefresh;
    expect(latestCatalog).toEqual([newer]);
    service.selectInstance(newer.instanceId);

    client.resolveCatalog(0, [older]);
    const obsoleteResult = await olderRefresh;
    expect(obsoleteResult).toBe(latestCatalog);
    expect(obsoleteResult).toEqual([newer]);
    expect(service.snapshot()).toMatchObject({ activeInstanceId: newer.instanceId, stale: false });
    expect(() => service.selectInstance(older.instanceId)).toThrow("not present in the latest Studio catalog");
  });

  test("requires explicit selection when multiple places are connected", async () => {
    const client = new FakeMcpClient({
      tools,
      responses: [instancesBody([instance, { ...instance, instanceId: "place:456", placeId: 456 }])],
    });
    const service = createService(client);
    await service.listConnectedInstances();

    await expect(service.children("game.Workspace")).rejects.toThrow("Active Studio place must be selected");
  });

  test("injects only snake-case instance_id into immutable routed read and write calls", async () => {
    const client = new FakeMcpClient({
      tools,
      responses: [
        instancesBody([instance]),
        textBody({ instancePath: "game.Workspace", children: [], count: 0 }),
        textBody({ success: true }),
      ],
    });
    const service = createService(client);
    const readInput = { instancePath: "game.Workspace", instance_id: "place:forged" };
    const writeInput = { instancePath: "game.Workspace.Part", propertyName: "Anchored", propertyValue: true };
    await service.listConnectedInstances();
    service.selectInstance(instance.instanceId);
    await service.callRead("children", readInput);
    await service.callWrite("set_property", writeInput, ownership);

    expect(client.calls.slice(1)).toEqual([
      { name: "get_instance_children", arguments: { instancePath: "game.Workspace", instance_id: "place:123" } },
      {
        name: "set_property",
        arguments: {
          instancePath: "game.Workspace.Part",
          propertyName: "Anchored",
          propertyValue: true,
          instance_id: "place:123",
        },
      },
    ]);
    expect(readInput).toEqual({ instancePath: "game.Workspace", instance_id: "place:forged" });
    expect(writeInput).toEqual({ instancePath: "game.Workspace.Part", propertyName: "Anchored", propertyValue: true });
  });

  test("property reads always exclude Source and enforce the expected active instance", async () => {
    const client = new FakeMcpClient({
      tools,
      responses: [
        instancesBody([instance]),
        textBody({ instancePath: "game.Workspace.Part", className: "Part", properties: { Anchored: "true" } }),
      ],
    });
    const service = createService(client);
    await selectFromCatalog(service);

    await expect(
      service.properties("game.Workspace.Part", {
        expectedInstanceId: instance.instanceId,
      }),
    ).resolves.toMatchObject({ instancePath: "game.Workspace.Part" });
    expect(client.calls[1]).toEqual({
      name: "get_instance_properties",
      arguments: {
        instancePath: "game.Workspace.Part",
        excludeSource: true,
        instance_id: instance.instanceId,
      },
    });
    await expect(
      service.properties("game.Workspace.Part", {
        expectedInstanceId: "place:other",
      }),
    ).rejects.toThrow("Active Studio instance changed");
    expect(client.calls).toHaveLength(2);
  });

  test("child reads enforce the expected active instance before MCP", async () => {
    const client = new FakeMcpClient({
      tools,
      responses: [instancesBody([instance])],
    });
    const service = createService(client);
    await selectFromCatalog(service);

    await expect(service.children("game.Workspace", { expectedInstanceId: "place:other" })).rejects.toThrow(
      "Active Studio instance changed",
    );
    expect(client.calls).toHaveLength(1);
  });

  test("child reads reject a mismatched response parent", async () => {
    const service = createService(
      new FakeMcpClient({
        tools,
        responses: [
          instancesBody([instance]),
          textBody({ instancePath: "game.ReplicatedStorage", children: [], count: 0 }),
        ],
      }),
    );
    await selectFromCatalog(service);

    await expect(service.children("game.Workspace")).rejects.toThrow(
      "Children response path does not match the request",
    );
  });

  test("child reads reject a declared count that differs from the rows", async () => {
    const service = createService(
      new FakeMcpClient({
        tools,
        responses: [
          instancesBody([instance]),
          textBody({
            instancePath: "game.Workspace",
            children: [
              {
                name: "Part",
                className: "Part",
                path: "game.Workspace.Part",
                hasChildren: false,
                hasSource: false,
              },
            ],
            count: 2,
          }),
        ],
      }),
    );
    await selectFromCatalog(service);

    await expect(service.children("game.Workspace")).rejects.toThrow("Children response count does not match the rows");
  });

  test("property reads reject a mismatched response path", async () => {
    const service = createService(
      new FakeMcpClient({
        tools,
        responses: [
          instancesBody([instance]),
          textBody({ instancePath: "game.Workspace.Other", className: "Part", properties: {} }),
        ],
      }),
    );
    await selectFromCatalog(service);

    await expect(service.properties("game.Workspace.Part")).rejects.toThrow(
      "Properties response path does not match the request",
    );
  });

  test("rejects a write expected-instance race before route capture, gate, or MCP", async () => {
    const alternate = { ...instance, instanceId: "place:456", placeId: 456 };
    const client = new FakeMcpClient({
      tools,
      responses: [instancesBody([instance, alternate])],
    });
    let gateCalls = 0;
    const service = new StudioMcpService(client, {
      authorize: async () => {
        gateCalls += 1;
        return { approved: true as const, authorizationId: "authorization-race" };
      },
      consume: () => undefined,
    });
    await service.listConnectedInstances();
    service.selectInstance(alternate.instanceId);

    await expect(
      service.callWrite(
        "set_property",
        { instancePath: "game.Workspace.Part", propertyName: "Anchored", propertyValue: true },
        { ownership: "studio", expectedInstanceId: instance.instanceId, expectedGraphRevision: 7 },
      ),
    ).rejects.toThrow("Active Studio instance changed");
    expect(gateCalls).toBe(0);
    expect(client.calls).toHaveLength(1);
  });

  test("a failed refresh cannot establish a catalog or fabricate selection", async () => {
    const service = createService(
      new FakeMcpClient({
        tools,
        responses: [textBody({ instances: "invalid", count: 1 })],
      }),
    );

    await expect(service.listConnectedInstances()).rejects.toBeInstanceOf(McpResponseError);
    expect(service.snapshot()).toMatchObject({ activeInstanceId: undefined, stale: false });
    expect(() => service.selectInstance(instance.instanceId)).toThrow("successful Studio catalog");
  });

  test("clears selection and marks data stale when refresh loses the selected place", async () => {
    const service = createService(
      new FakeMcpClient({
        tools,
        responses: [instancesBody([instance]), instancesBody([])],
      }),
    );
    await selectFromCatalog(service);
    await service.listConnectedInstances();

    expect(service.snapshot()).toMatchObject({ activeInstanceId: undefined, stale: true });
  });

  test("clears selection and marks data stale on unrecognized_instance_id", async () => {
    const service = createService(
      new FakeMcpClient({
        tools,
        responses: [instancesBody([instance]), textBody({ error: "unrecognized_instance_id" })],
      }),
    );
    await selectFromCatalog(service);

    await expect(service.selection()).rejects.toBeInstanceOf(McpResponseError);
    expect(service.snapshot()).toMatchObject({ activeInstanceId: undefined, stale: true });
  });

  test("rejects unknown result shapes at the boundary", async () => {
    const service = createService(
      new FakeMcpClient({
        tools,
        responses: [
          instancesBody([instance]),
          textBody({ instancePath: "game.Workspace", children: "not-an-array", count: 1 }),
        ],
      }),
    );
    await selectFromCatalog(service);

    await expect(service.children("game.Workspace")).rejects.toBeInstanceOf(McpResponseError);
  });

  test.each([
    { isError: true, content: [] },
    { content: [] },
    { content: [{ type: "text", text: "not json" }] },
    textBody({ error: "upstream failed" }),
  ])("rejects malformed MCP envelope %#", async (response) => {
    const service = createService(new FakeMcpClient({ tools, responses: [response] }));

    await expect(service.listConnectedInstances()).rejects.toBeInstanceOf(McpResponseError);
  });

  test("normalizes structured content and canonicalizes data-model paths", async () => {
    const service = createService(
      new FakeMcpClient({
        tools,
        responses: [
          { structuredContent: { instances: [instance], count: 1 } },
          {
            structuredContent: {
              instancePath: 'game.Workspace["Door.Hinge"]',
              children: [
                {
                  name: "Leaf",
                  className: "Part",
                  path: 'game.Workspace["Door.Hinge"].Leaf',
                  hasChildren: false,
                  hasSource: false,
                },
              ],
              count: 1,
            },
          },
        ],
      }),
    );
    await selectFromCatalog(service);

    await expect(service.children('game.Workspace["Door.Hinge"]')).resolves.toEqual([
      {
        name: "Leaf",
        className: "Part",
        path: 'game.Workspace["Door.Hinge"].Leaf',
        hasChildren: false,
        hasSource: false,
      },
    ]);
  });

  test.each(["set_property", "set_properties", "create_object", "delete_object"])(
    "callRead rejects classified write tool %s without invoking MCP",
    async (tool) => {
      const client = new FakeMcpClient({ tools });

      await expect(createService(client).callRead(tool, {})).rejects.toBeInstanceOf(ToolClassificationError);
      expect(client.calls).toEqual([]);
    },
  );

  test("callWrite rejects read and unclassified tools before the mutation gate or MCP", async () => {
    const client = new FakeMcpClient({ tools });
    let gateCalls = 0;
    const blockingGate = {
      async authorize(): Promise<unknown> {
        gateCalls += 1;
        return { success: true };
      },
      consume: () => undefined,
    };
    const guarded = new StudioMcpService(client, blockingGate);

    await expect(guarded.callWrite("selection", {}, ownership)).rejects.toBeInstanceOf(ToolClassificationError);
    await expect(guarded.callWrite("unclassified_tool", {}, ownership)).rejects.toBeInstanceOf(ToolClassificationError);
    expect(gateCalls).toBe(0);
    expect(client.calls).toEqual([]);
  });

  test("blocked mutation decisions do not reach the gate or MCP", async () => {
    const client = new FakeMcpClient({ tools, responses: [instancesBody([instance]), textBody({ success: true })] });
    let gateCalls = 0;
    const gate = {
      async authorize(): Promise<unknown> {
        gateCalls += 1;
        return { success: true };
      },
      consume: () => undefined,
    };
    const guarded = new StudioMcpService(client, gate);
    await selectFromCatalog(guarded);

    await expect(
      guarded.callWrite(
        "set_property",
        { instancePath: "game.Workspace.Part", propertyName: "Anchored", propertyValue: true },
        { ownership: "unknown", expectedGraphRevision: 7 },
      ),
    ).rejects.toThrow("Mutation blocked");
    expect(gateCalls).toBe(0);
    expect(client.calls).toHaveLength(1);
  });

  test("a rejected authorization receives proposal and decision without allowing an MCP mutation", async () => {
    const client = new FakeMcpClient({ tools, responses: [instancesBody([instance]), textBody({ success: true })] });
    const seen: { proposal?: MutationProposal; disposition?: string } = {};
    const gate = {
      async authorize(
        receivedProposal: MutationProposal,
        decision: { readonly disposition: string },
        _request: unknown,
      ): Promise<unknown> {
        seen.proposal = receivedProposal;
        seen.disposition = decision.disposition;
        return { approved: false, reason: "Not approved" };
      },
      consume: () => undefined,
    };
    const guarded = new StudioMcpService(client, gate);
    await selectFromCatalog(guarded);

    await expect(
      guarded.callWrite(
        "set_property",
        { instancePath: "game.Workspace.Part", propertyName: "Anchored", propertyValue: true },
        ownership,
      ),
    ).rejects.toThrow("Not approved");
    expect(seen).toEqual({
      proposal: {
        kind: "studio",
        operation: "property-write",
        target: "game.Workspace.Part",
        ownership: "studio",
        instanceId: "place:123",
        placeName: "Forge",
        graphRevision: 7,
        connectedInstanceCount: 1,
      },
      disposition: "preview",
    });
    expect(client.calls).toHaveLength(1);
  });

  test("normalizes the real isError envelope before clearing a disconnected selection", async () => {
    const guarded = createService(
      new FakeMcpClient({
        tools,
        responses: [
          instancesBody([instance]),
          { isError: true, content: [{ type: "text", text: JSON.stringify({ error: "unrecognized_instance_id" }) }] },
        ],
      }),
    );
    await selectFromCatalog(guarded);

    await expect(guarded.selection()).rejects.toMatchObject({ code: "unrecognized_instance_id" });
    expect(guarded.snapshot()).toMatchObject({ activeInstanceId: undefined, stale: true });
  });

  test("validates recursive tree nodes and canonicalizes every returned tree path", async () => {
    const guarded = createService(
      new FakeMcpClient({
        tools,
        responses: [
          instancesBody([instance]),
          textBody({
            tree: {
              name: "game",
              className: "DataModel",
              path: "game",
              children: [{ name: "Door.Hinge", className: "Part", path: 'game.Workspace["Door.Hinge"]', children: [] }],
            },
            timestamp: 1,
          }),
        ],
      }),
    );
    await selectFromCatalog(guarded);

    await expect(guarded.callRead("tree", { path: "game" })).resolves.toEqual({
      tree: {
        name: "game",
        className: "DataModel",
        path: "game",
        children: [{ name: "Door.Hinge", className: "Part", path: 'game.Workspace["Door.Hinge"]', children: [] }],
      },
      timestamp: 1,
    });
  });

  test("rejects malformed recursive tree nodes", async () => {
    const guarded = createService(
      new FakeMcpClient({
        tools,
        responses: [
          instancesBody([instance]),
          textBody({ tree: { name: "game", className: "DataModel", children: [{ name: 3 }] }, timestamp: 1 }),
        ],
      }),
    );
    await selectFromCatalog(guarded);

    await expect(guarded.callRead("tree", { path: "game" })).rejects.toBeInstanceOf(McpResponseError);
  });

  test("derives delete proposals internally despite caller-supplied read fields", async () => {
    const client = new FakeMcpClient({ tools, responses: [instancesBody([instance]), textBody({ success: true })] });
    const seen: { proposal?: MutationProposal; disposition?: string } = {};
    const gate = {
      async authorize(
        receivedProposal: MutationProposal,
        decision: { readonly disposition: string },
        _request: unknown,
      ): Promise<unknown> {
        seen.proposal = receivedProposal;
        seen.disposition = decision.disposition;
        return { approved: true, authorizationId: "authorization-delete" };
      },
      consume: () => undefined,
    };
    const guarded = new StudioMcpService(client, gate);
    await selectFromCatalog(guarded);
    const forgedContext = {
      ownership: "studio" as const,
      kind: "read",
      operation: "read",
      target: "game.ServerStorage.Safe",
      instanceId: "place:forged",
      connectedInstanceCount: 0,
      expectedGraphRevision: 7,
    };

    await expect(
      guarded.callWrite("delete_object", { instancePath: "game.Workspace.Part" }, forgedContext),
    ).resolves.toEqual({ success: true });
    expect(seen).toEqual({
      proposal: {
        kind: "studio",
        operation: "delete",
        target: "game.Workspace.Part",
        ownership: "studio",
        instanceId: "place:123",
        placeName: "Forge",
        graphRevision: 7,
        connectedInstanceCount: 1,
      },
      disposition: "confirm-dangerous",
    });
    expect(client.calls).toHaveLength(2);
  });

  test("authorization receives no callback and an instance switch blocks the captured route", async () => {
    const alternate = { ...instance, instanceId: "place:456", placeId: 456 };
    const client = new FakeMcpClient({
      tools,
      responses: [instancesBody([instance, alternate]), textBody({ success: true })],
    });
    let guarded: StudioMcpService;
    let observedArgumentCount = -1;
    const consume = vi.fn();
    const gate = {
      async authorize(...args: readonly unknown[]): Promise<{
        readonly approved: true;
        readonly authorizationId: string;
      }> {
        observedArgumentCount = args.length;
        guarded.selectInstance(alternate.instanceId);
        return { approved: true, authorizationId: "authorization-switched" };
      },
      consume,
    };
    guarded = new StudioMcpService(client, gate);
    await guarded.listConnectedInstances();
    guarded.selectInstance(instance.instanceId);

    await expect(
      guarded.callWrite(
        "set_property",
        { instancePath: "game.Workspace.Part", propertyName: "Anchored", propertyValue: true },
        ownership,
      ),
    ).rejects.toThrow("Active Studio instance changed");
    expect(observedArgumentCount).toBe(3);
    expect(consume).not.toHaveBeenCalled();
    expect(client.calls).toHaveLength(1);
  });

  test("consumes an opaque authorization after modal approval and immediately before one write", async () => {
    const client = new FakeMcpClient({
      tools,
      responses: [instancesBody([instance]), textBody({ success: true })],
    });
    let release: ((value: unknown) => void) | undefined;
    let consumes = 0;
    const gate = {
      authorize: async () =>
        new Promise<unknown>((resolve) => {
          release = resolve;
        }),
      consume: () => {
        consumes += 1;
      },
    };
    const guarded = new StudioMcpService(client, gate);
    await selectFromCatalog(guarded);

    const writing = guarded.callWrite(
      "set_property",
      { instancePath: "game.Workspace.Part", propertyName: "Anchored", propertyValue: true },
      {
        ownership: "studio",
        expectedInstanceId: instance.instanceId,
        expectedGraphRevision: 7,
      },
    );
    await Promise.resolve();
    expect(client.calls).toHaveLength(1);
    release?.({ approved: true, authorizationId: "authorization-unchanged" });

    await expect(writing).resolves.toEqual({ success: true });
    expect(consumes).toBe(1);
    expect(client.calls).toHaveLength(2);
  });

  test("redeems an Agent claim against the exact service-derived proposal and request without native authorization", async () => {
    const client = new FakeMcpClient({
      tools,
      responses: [instancesBody([instance]), textBody({ success: true })],
    });
    const authorize = vi.fn(async () => ({
      approved: false as const,
      reason: "Native authorization must not run",
    }));
    const authorizeClaim = vi.fn(async () => ({
      approved: true as const,
      authorizationId: "agent-authorization-1",
    }));
    const consume = vi.fn();
    const guarded = new StudioMcpService(client, {
      authorize,
      authorizeClaim,
      consume,
    });
    await selectFromCatalog(guarded);
    const claim = Object.freeze({ id: "opaque-agent-claim" }) as StudioAgentMutationClaim;
    const input = {
      instancePath: "game.Workspace.Part",
      propertyName: "Anchored",
      propertyValue: true,
    };

    await expect(
      guarded.callWriteWithClaim(
        "set_property",
        input,
        {
          ownership: "studio",
          expectedInstanceId: instance.instanceId,
          expectedGraphRevision: 7,
        },
        claim,
      ),
    ).resolves.toEqual({ success: true });

    expect(authorize).not.toHaveBeenCalled();
    expect(authorizeClaim).toHaveBeenCalledTimes(1);
    const [seenClaim, proposal, decision, request] = authorizeClaim.mock.calls[0]!;
    expect(seenClaim).toBe(claim);
    expect(proposal).toEqual({
      kind: "studio",
      operation: "property-write",
      target: "game.Workspace.Part",
      ownership: "studio",
      instanceId: instance.instanceId,
      placeName: instance.placeName,
      graphRevision: 7,
      connectedInstanceCount: 1,
    });
    expect(decision).toMatchObject({ disposition: "preview" });
    expect(request).toEqual({ tool: "set_property", input });
    expect(Object.isFrozen(proposal)).toBe(true);
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(request.input)).toBe(true);
    expect(consume).toHaveBeenCalledWith("agent-authorization-1", proposal, request);
    expect(client.calls[1]).toEqual({
      name: "set_property",
      arguments: { ...input, instance_id: instance.instanceId },
    });
  });

  test("blocks graph invalidation and instance switching while native authorization is pending", async () => {
    const alternate = { ...instance, instanceId: "place:456", placeId: 456, placeName: "Harbor" };
    for (const race of ["graph", "instance"] as const) {
      const client = new FakeMcpClient({
        tools,
        responses: [instancesBody([instance, alternate]), textBody({ success: true })],
      });
      let release: ((value: unknown) => void) | undefined;
      let graphCurrent = true;
      const gate = {
        authorize: async () =>
          new Promise<unknown>((resolve) => {
            release = resolve;
          }),
        consume: () => {
          if (!graphCurrent) throw new Error("Unified graph changed after confirmation");
        },
      };
      const guarded = new StudioMcpService(client, gate);
      await guarded.listConnectedInstances();
      guarded.selectInstance(instance.instanceId);
      const writing = guarded.callWrite(
        "set_property",
        { instancePath: "game.Workspace.Part", propertyName: "Anchored", propertyValue: true },
        {
          ownership: "studio",
          expectedInstanceId: instance.instanceId,
          expectedGraphRevision: 7,
        },
      );
      await Promise.resolve();
      if (race === "graph") graphCurrent = false;
      else guarded.selectInstance(alternate.instanceId);
      release?.({ approved: true, authorizationId: `authorization-${race}` });

      await expect(writing).rejects.toThrow(
        race === "graph" ? "Unified graph changed after confirmation" : "Active Studio instance changed",
      );
      expect(client.calls).toHaveLength(1);
    }
  });

  test("a catalog disappearance during pending authorization invalidates the captured route", async () => {
    const client = new FakeMcpClient({
      tools,
      responses: [instancesBody([instance]), instancesBody([]), textBody({ success: true })],
    });
    let release: ((value: unknown) => void) | undefined;
    const consume = vi.fn();
    const guarded = new StudioMcpService(client, {
      authorize: async () =>
        new Promise<unknown>((resolve) => {
          release = resolve;
        }),
      consume,
    });
    await selectFromCatalog(guarded);
    const writing = guarded.callWrite(
      "set_property",
      { instancePath: "game.Workspace.Part", propertyName: "Anchored", propertyValue: true },
      {
        ownership: "studio",
        expectedInstanceId: instance.instanceId,
        expectedGraphRevision: 7,
      },
    );
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));

    await guarded.listConnectedInstances();
    release?.({ approved: true, authorizationId: "authorization-disconnected" });

    await expect(writing).rejects.toThrow("Active Studio instance changed");
    expect(consume).not.toHaveBeenCalled();
    expect(client.calls).toHaveLength(2);
  });

  test("consumes an opaque authorization only once and blocks replay before MCP", async () => {
    const client = new FakeMcpClient({
      tools,
      responses: [instancesBody([instance]), textBody({ success: true }), textBody({ success: true })],
    });
    const consumed = new Set<string>();
    const gate = {
      authorize: async () => ({ approved: true as const, authorizationId: "authorization-replay" }),
      consume: (authorizationId: string) => {
        if (consumed.has(authorizationId)) throw new Error("Studio authorization was already consumed");
        consumed.add(authorizationId);
      },
    };
    const guarded = new StudioMcpService(client, gate);
    await selectFromCatalog(guarded);
    const context = {
      ownership: "studio" as const,
      expectedInstanceId: instance.instanceId,
      expectedGraphRevision: 7,
    };

    await expect(
      guarded.callWrite(
        "set_property",
        { instancePath: "game.Workspace.Part", propertyName: "Anchored", propertyValue: true },
        context,
      ),
    ).resolves.toEqual({ success: true });
    await expect(
      guarded.callWrite(
        "set_property",
        { instancePath: "game.Workspace.Part", propertyName: "Anchored", propertyValue: false },
        context,
      ),
    ).rejects.toThrow("already consumed");
    expect(client.calls).toHaveLength(2);
  });

  test("keeps nested routed arguments immutable while the gate is deciding", async () => {
    const client = new FakeMcpClient({ tools, responses: [instancesBody([instance]), textBody({ success: true })] });
    const gate = {
      async authorize(
        _proposal: MutationProposal,
        _decision: unknown,
        request: { readonly input: Readonly<Record<string, unknown>> },
      ): Promise<unknown> {
        const propertyValue = request.input.propertyValue;
        if (typeof propertyValue === "object" && propertyValue !== null && !Array.isArray(propertyValue)) {
          try {
            propertyValue.nested = true;
          } catch {
            // Frozen request input is the expected boundary behavior.
          }
        }
        return { approved: true, authorizationId: "authorization-nested" };
      },
      consume: () => undefined,
    };
    const guarded = new StudioMcpService(client, gate);
    await selectFromCatalog(guarded);

    await guarded.callWrite(
      "set_property",
      {
        instancePath: "game.Workspace.Part",
        propertyName: "Attributes",
        propertyValue: { nested: false },
      },
      ownership,
    );
    expect(client.calls[1]?.arguments.propertyValue).toEqual({ nested: false });
  });

  test("does not invoke a stale captured route after a newly selected instance wins", async () => {
    const alternate = { ...instance, instanceId: "place:456", placeId: 456 };
    const client = new FakeMcpClient({
      tools,
      responses: [
        instancesBody([instance, alternate]),
        { isError: true, content: [{ type: "text", text: JSON.stringify({ error: "unrecognized_instance_id" }) }] },
      ],
    });
    let guarded: StudioMcpService;
    const gate = {
      async authorize(): Promise<{ readonly approved: true; readonly authorizationId: string }> {
        guarded.selectInstance(alternate.instanceId);
        return { approved: true, authorizationId: "authorization-new-place" };
      },
      consume: () => undefined,
    };
    guarded = new StudioMcpService(client, gate);
    await guarded.listConnectedInstances();
    guarded.selectInstance(instance.instanceId);

    await expect(
      guarded.callWrite(
        "set_property",
        { instancePath: "game.Workspace.Part", propertyName: "Anchored", propertyValue: true },
        ownership,
      ),
    ).rejects.toThrow("Active Studio instance changed");
    expect(guarded.snapshot()).toMatchObject({ activeInstanceId: alternate.instanceId, stale: false });
    expect(client.calls).toHaveLength(1);
  });

  test("keeps captured instance count and proposal stable while authorization refreshes instances", async () => {
    const alternate = { ...instance, instanceId: "place:456", placeId: 456 };
    const client = new FakeMcpClient({
      tools,
      responses: [instancesBody([instance]), instancesBody([instance, alternate]), textBody({ success: true })],
    });
    let guarded: StudioMcpService;
    let capturedProposal: MutationProposal | undefined;
    const gate = {
      async authorize(proposal: MutationProposal): Promise<{
        readonly approved: true;
        readonly authorizationId: string;
      }> {
        capturedProposal = proposal;
        await guarded.listConnectedInstances();
        return { approved: true, authorizationId: "authorization-refreshed" };
      },
      consume: () => undefined,
    };
    guarded = new StudioMcpService(client, gate);
    await selectFromCatalog(guarded);

    await guarded.callWrite(
      "set_property",
      { instancePath: "game.Workspace.Part", propertyName: "Anchored", propertyValue: true },
      ownership,
    );
    expect(capturedProposal).toMatchObject({ instanceId: instance.instanceId, connectedInstanceCount: 1 });
    expect(client.calls[2]).toEqual({
      name: "set_property",
      arguments: {
        instancePath: "game.Workspace.Part",
        propertyName: "Anchored",
        propertyValue: true,
        instance_id: instance.instanceId,
      },
    });
  });

  test.each([
    { approved: true },
    { approved: "true" },
    { approved: 1 },
    { approved: {} },
    null,
    undefined,
    { approved: false },
    { approved: false, reason: 1 },
    { approved: false, reason: "No", extra: true },
  ])("rejects malformed authorization result %# without invoking MCP", async (result) => {
    const client = new FakeMcpClient({ tools, responses: [instancesBody([instance]), textBody({ success: true })] });
    const gate = {
      async authorize(): Promise<unknown> {
        return result;
      },
      consume: () => undefined,
    };
    const guarded = new StudioMcpService(client, gate);
    await selectFromCatalog(guarded);

    await expect(
      guarded.callWrite(
        "set_property",
        { instancePath: "game.Workspace.Part", propertyName: "Anchored", propertyValue: true },
        ownership,
      ),
    ).rejects.toBeInstanceOf(MutationAuthorizationBoundaryError);
    expect(client.calls).toHaveLength(1);
  });

  test("rejects a write response with success false", async () => {
    const guarded = createService(
      new FakeMcpClient({
        tools,
        responses: [instancesBody([instance]), textBody({ success: false })],
      }),
    );
    await selectFromCatalog(guarded);

    await expect(
      guarded.callWrite(
        "set_property",
        { instancePath: "game.Workspace.Part", propertyName: "Anchored", propertyValue: true },
        ownership,
      ),
    ).rejects.toBeInstanceOf(McpResponseError);
  });
});
