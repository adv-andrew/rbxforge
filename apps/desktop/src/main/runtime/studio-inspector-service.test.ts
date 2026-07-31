import type { StudioMcpService, StudioNode, StudioProperties } from "@rbxforge/studio-mcp";
import { describe, expect, it, vi } from "vitest";
import type { ProjectBinding } from "../../shared/domain.js";
import { StudioInspectorService, type InspectorBindingPort } from "./studio-inspector-service.js";

const binding = {
  bindingId: "binding-a",
  bindingRevision: 7,
  studio: {
    instanceId: "studio-a",
    brokerEpoch: "epoch-a",
  },
} as ProjectBinding;

function createHarness(
  options: {
    readonly childRows?: readonly StudioNode[];
    readonly propertyResult?: StudioProperties;
  } = {},
) {
  const children = vi.fn(
    async () =>
      options.childRows ?? [
        {
          name: "Workspace",
          className: "Workspace",
          path: "game.Workspace",
          hasChildren: true,
          hasSource: false,
        },
      ],
  );
  const properties = vi.fn(
    async () =>
      options.propertyResult ?? {
        instancePath: "game.Workspace",
        className: "Workspace",
        properties: { Nameplate: "Deepwater" },
      },
  );
  const studio = { children, properties } as unknown as StudioMcpService;
  const assertCurrent = vi.fn(() => binding);
  const withBinding = vi.fn(
    async <T>(
      _projectId: string,
      _bindingRevision: number,
      operation: (service: StudioMcpService, expectedInstanceId: string) => Promise<T>,
    ) => operation(studio, "studio-a"),
  );
  const bindings = { assertCurrent, withBinding } satisfies InspectorBindingPort;
  const inspector = new StudioInspectorService({ bindings, now: () => 1234 });
  return { inspector, children, properties, assertCurrent, withBinding };
}

describe("StudioInspectorService routing", () => {
  it("routes child reads through the exact binding and returns stamped display rows", async () => {
    const { inspector, children } = createHarness();

    const result = await inspector.children({
      projectId: "project-a",
      instanceId: "studio-a",
      bindingRevision: 7,
      instancePath: "game",
    });

    expect(result).toEqual({
      projectId: "project-a",
      instanceId: "studio-a",
      bindingRevision: 7,
      brokerEpoch: "epoch-a",
      observedAt: 1234,
      instancePath: "game",
      children: [
        {
          name: "Workspace",
          className: "Workspace",
          path: "game.Workspace",
          hasChildren: true,
        },
      ],
    });
    expect(children).toHaveBeenCalledWith("game", {
      expectedInstanceId: "studio-a",
    });
  });

  it("routes property reads through the exact binding and returns display-only rows", async () => {
    const { inspector, properties } = createHarness();

    const result = await inspector.properties({
      projectId: "project-a",
      instanceId: "studio-a",
      bindingRevision: 7,
      instancePath: "game.Workspace",
    });

    expect(result).toEqual({
      projectId: "project-a",
      instanceId: "studio-a",
      bindingRevision: 7,
      brokerEpoch: "epoch-a",
      observedAt: 1234,
      instancePath: "game.Workspace",
      className: "Workspace",
      properties: [
        {
          name: "Nameplate",
          category: "Data",
          value: "Deepwater",
          valueKind: "string",
        },
      ],
    });
    expect(properties).toHaveBeenCalledWith("game.Workspace", {
      expectedInstanceId: "studio-a",
    });
  });

  it("rejects a forged instance identity before the bound operation runs", async () => {
    const { inspector, withBinding } = createHarness();

    await expect(
      inspector.children({
        projectId: "project-a",
        instanceId: "studio-forged",
        bindingRevision: 7,
        instancePath: "game",
      }),
    ).rejects.toThrow("Studio inspector identity is not current");
    expect(withBinding).not.toHaveBeenCalled();
  });
});

describe("StudioInspectorService child bounds", () => {
  const childError = "Studio child response exceeds the inspector bounds";

  it("rejects more than 1,000 children", async () => {
    const childRows = Array.from({ length: 1_001 }, (_, index) =>
      node(`Child${index}`, "Folder", `game.Child${index}`),
    );
    const { inspector } = createHarness({ childRows });

    await expect(
      inspector.children({
        projectId: "project-a",
        instanceId: "studio-a",
        bindingRevision: 7,
        instancePath: "game",
      }),
    ).rejects.toThrow(childError);
  });

  it("rejects a child whose canonical parent is not the requested path", async () => {
    const { inspector } = createHarness({
      childRows: [node("Part", "Part", "game.ReplicatedStorage.Part")],
    });

    await expect(
      inspector.children({
        projectId: "project-a",
        instanceId: "studio-a",
        bindingRevision: 7,
        instancePath: "game.Workspace",
      }),
    ).rejects.toThrow(childError);
  });

  it("rejects duplicate canonical child paths", async () => {
    const { inspector } = createHarness({
      childRows: [
        node("Door.Hinge", "Part", 'game.Workspace["Door.Hinge"]'),
        node("Door.Hinge", "Part", 'game.Workspace["Door.Hinge"]'),
      ],
    });

    await expect(
      inspector.children({
        projectId: "project-a",
        instanceId: "studio-a",
        bindingRevision: 7,
        instancePath: "game.Workspace",
      }),
    ).rejects.toThrow(childError);
  });

  it("rejects a child whose display name differs from its canonical path identity", async () => {
    const { inspector } = createHarness({
      childRows: [node("Safe", "Part", "game.Workspace.DifferentObject")],
    });

    await expect(
      inspector.children({
        projectId: "project-a",
        instanceId: "studio-a",
        bindingRevision: 7,
        instancePath: "game.Workspace",
      }),
    ).rejects.toThrow(childError);
  });

  it.each([
    ["name", "x".repeat(257), "Part"],
    ["class", "Part", "x".repeat(257)],
  ])("rejects a child whose %s label is above 256 characters", async (_label, name, className) => {
    const { inspector } = createHarness({
      childRows: [node(name, className, "game.Workspace.Part")],
    });

    await expect(
      inspector.children({
        projectId: "project-a",
        instanceId: "studio-a",
        bindingRevision: 7,
        instancePath: "game.Workspace",
      }),
    ).rejects.toThrow(childError);
  });

  it("rejects a child path above 4,096 characters", async () => {
    const parentPath = `game.${Array.from({ length: 17 }, (_, index) => `N${index}${"x".repeat(247)}`).join(".")}`;
    const { inspector } = createHarness({
      childRows: [node("Child", "Folder", `${parentPath}.Child`)],
    });

    await expect(
      inspector.children({
        projectId: "project-a",
        instanceId: "studio-a",
        bindingRevision: 7,
        instancePath: parentPath,
      }),
    ).rejects.toThrow(childError);
  });

  it("sorts copied children deterministically by name and class", async () => {
    const childRows = [
      node("Zeta", "Folder", "game.Zeta"),
      node("AlphaPart", "Part", "game.AlphaPart"),
      node("AlphaFolder", "Folder", "game.AlphaFolder"),
    ];
    const { inspector } = createHarness({ childRows });

    const result = await inspector.children({
      projectId: "project-a",
      instanceId: "studio-a",
      bindingRevision: 7,
      instancePath: "game",
    });

    expect(result.children.map(({ name, className }) => [name, className])).toEqual([
      ["AlphaFolder", "Folder"],
      ["AlphaPart", "Part"],
      ["Zeta", "Folder"],
    ]);
    expect(childRows.map(({ name }) => name)).toEqual(["Zeta", "AlphaPart", "AlphaFolder"]);
  });

  it("omits hasSource and freezes each delivered child row", async () => {
    const { inspector } = createHarness({
      childRows: [
        {
          ...node("Script", "Script", "game.Script"),
          hasSource: true,
          enabled: false,
        },
      ],
    });

    const result = await inspector.children({
      projectId: "project-a",
      instanceId: "studio-a",
      bindingRevision: 7,
      instancePath: "game",
    });

    expect(result.children).toEqual([
      {
        name: "Script",
        className: "Script",
        path: "game.Script",
        hasChildren: false,
        enabled: false,
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("hasSource");
    expect(Object.isFrozen(result.children[0])).toBe(true);
  });
});

describe("StudioInspectorService property sanitization", () => {
  it("omits sensitive properties and returns bounded display-only property values", async () => {
    const cyclicObject: Record<string, unknown> = { safe: "visible" };
    cyclicObject.self = cyclicObject;
    const rawProperties = {
      Anchored: true,
      Transparency: 0.5,
      Nameplate: "Deepwater",
      Transform: { X: 1, Y: 2, Z: 3 },
      ApiKey: "sk-secret-value",
      Source: "print('never deliver')",
      Description: "api_key=secret-value",
      Cyclic: cyclicObject,
      NonFinite: Number.POSITIVE_INFINITY,
    };
    const { inspector } = createHarness({
      propertyResult: {
        instancePath: "game.Workspace",
        className: "Part",
        properties: rawProperties,
      },
    });

    const result = await inspector.properties({
      projectId: "project-a",
      instanceId: "studio-a",
      bindingRevision: 7,
      instancePath: "game.Workspace",
    });

    expect(result.properties).toEqual([
      {
        name: "Transparency",
        category: "Appearance",
        value: "0.5",
        valueKind: "number",
      },
      {
        name: "Anchored",
        category: "Behavior",
        value: "true",
        valueKind: "boolean",
      },
      {
        name: "Description",
        category: "Data",
        value: "[sensitive value omitted]",
        valueKind: "string",
      },
      {
        name: "Nameplate",
        category: "Data",
        value: "Deepwater",
        valueKind: "string",
      },
      {
        name: "NonFinite",
        category: "Data",
        value: "[non-finite number]",
        valueKind: "number",
      },
      {
        name: "Cyclic",
        category: "Other",
        value: '{"safe":"visible","self":"[cyclic value]"}',
        valueKind: "structured",
      },
      {
        name: "Transform",
        category: "Other",
        value: '{"X":1,"Y":2,"Z":3}',
        valueKind: "structured",
      },
    ]);
    expect(result.properties.every(({ value }) => typeof value === "string")).toBe(true);
    expect(result.properties.every((row) => Object.isFrozen(row))).toBe(true);
    expect(result.properties).not.toContain(rawProperties.Transform);
    expect(JSON.stringify(result)).not.toContain("sk-secret-value");
    expect(JSON.stringify(result)).not.toContain("never deliver");
  });

  it("omits nested sensitive keys and redacts private-key content", async () => {
    const privateKeyEnvelope = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");
    const { inspector } = createHarness({
      propertyResult: {
        instancePath: "game.Workspace",
        className: "Part",
        properties: {
          apikey: "compact-secret",
          Certificate: `${privateKeyEnvelope}\nnever deliver`,
          Connection: "sk-abcdef",
          Details: "password=x",
          Nested: {
            Safe: "visible",
            token: "nested-secret",
            Arguments: "also-secret",
          },
        },
      },
    });

    const result = await inspector.properties({
      projectId: "project-a",
      instanceId: "studio-a",
      bindingRevision: 7,
      instancePath: "game.Workspace",
    });

    expect(result.properties).toEqual([
      {
        name: "Certificate",
        category: "Data",
        value: "[sensitive value omitted]",
        valueKind: "string",
      },
      {
        name: "Connection",
        category: "Data",
        value: "[sensitive value omitted]",
        valueKind: "string",
      },
      {
        name: "Details",
        category: "Data",
        value: "[sensitive value omitted]",
        valueKind: "string",
      },
      {
        name: "Nested",
        category: "Other",
        value: '{"Safe":"visible"}',
        valueKind: "structured",
      },
    ]);
  });

  it("redacts generic sensitive assignments and standalone credential formats", async () => {
    const slackToken = ["xoxb", "123456789012", "123456789012", "abcdefghijklmnopqrstuvwx"].join("-");
    const awsAccessKey = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
    const gitLabToken = ["glpat", "abcdefghijklmnopqrst"].join("-");
    const gitHubToken = ["ghp", "1234567890abcdefghijklmnopqrstuv"].join("_");
    const { inspector } = createHarness({
      propertyResult: {
        instancePath: "game.Workspace",
        className: "Part",
        properties: {
          Chat: slackToken,
          Cloud: awsAccessKey,
          Configuration: "auth=auth-sentinel",
          Description: "token=token-sentinel",
          Notes: "secret=secret-sentinel",
          Pipeline: gitLabToken,
          Repository: gitHubToken,
        },
      },
    });

    const result = await inspector.properties({
      projectId: "project-a",
      instanceId: "studio-a",
      bindingRevision: 7,
      instancePath: "game.Workspace",
    });

    expect(Object.fromEntries(result.properties.map(({ name, value }) => [name, value]))).toEqual({
      Chat: "[sensitive value omitted]",
      Cloud: "[sensitive value omitted]",
      Configuration: "[sensitive value omitted]",
      Description: "[sensitive value omitted]",
      Notes: "[sensitive value omitted]",
      Pipeline: "[sensitive value omitted]",
      Repository: "[sensitive value omitted]",
    });
    expect(JSON.stringify(result)).not.toMatch(/token-sentinel|secret-sentinel|auth-sentinel|ghp_|glpat-|xoxb-|AKIA/);
  });

  it("limits output to 512 sorted property rows and omits overlong names", async () => {
    const properties = Object.fromEntries(
      Array.from({ length: 520 }, (_, index) => [`Property${String(index).padStart(3, "0")}`, index]),
    );
    properties["x".repeat(257)] = "not delivered";
    const { inspector } = createHarness({
      propertyResult: {
        instancePath: "game.Workspace",
        className: "Part",
        properties,
      },
    });

    const result = await inspector.properties({
      projectId: "project-a",
      instanceId: "studio-a",
      bindingRevision: 7,
      instancePath: "game.Workspace",
    });

    expect(result.properties).toHaveLength(512);
    expect(result.properties[0]?.name).toBe("Property000");
    expect(result.properties[511]?.name).toBe("Property511");
    expect(result.properties.every(({ name }) => name.length <= 256)).toBe(true);
  });

  it("caps aggregate formatted values at 8,192 characters", async () => {
    const huge = Object.fromEntries(
      Array.from({ length: 50 }, (_, index) => [`Field${String(index).padStart(2, "0")}`, "x".repeat(2_000)]),
    );
    const { inspector } = createHarness({
      propertyResult: {
        instancePath: "game.Workspace",
        className: "Part",
        properties: { Huge: huge },
      },
    });

    const result = await inspector.properties({
      projectId: "project-a",
      instanceId: "studio-a",
      bindingRevision: 7,
      instancePath: "game.Workspace",
    });

    expect(result.properties[0]?.value.length).toBeLessThanOrEqual(8_192);
  });

  it("uses bounded placeholders for unsupported values and traversal budgets", async () => {
    const { inspector } = createHarness({
      propertyResult: {
        instancePath: "game.Workspace",
        className: "Part",
        properties: {
          ArrayBudget: Array.from({ length: 21 }, (_, index) => index),
          BigIntValue: 1n,
          DateValue: new Date(0),
          Deep: { a: { b: { c: { d: { e: "too deep" } } } } },
          FunctionValue: () => "never invoke",
          NodeBudget: Array.from({ length: 20 }, () => ({
            a: 1,
            b: 2,
            c: 3,
            d: 4,
            e: 5,
            f: 6,
            g: 7,
          })),
          SymbolValue: Symbol("secret-description"),
        },
      },
    });

    const result = await inspector.properties({
      projectId: "project-a",
      instanceId: "studio-a",
      bindingRevision: 7,
      instancePath: "game.Workspace",
    });
    const byName = Object.fromEntries(result.properties.map((row) => [row.name, row]));

    expect(byName.BigIntValue).toMatchObject({ valueKind: "unsupported", value: "[unsupported bigint]" });
    expect(byName.DateValue).toMatchObject({ valueKind: "unsupported", value: "[unsupported object]" });
    expect(byName.FunctionValue).toMatchObject({ valueKind: "unsupported", value: "[unsupported function]" });
    expect(byName.SymbolValue).toMatchObject({ valueKind: "unsupported", value: "[unsupported symbol]" });
    expect(byName.ArrayBudget?.value).toContain("[array items omitted]");
    expect(byName.Deep?.value).toContain("[maximum depth reached]");
    expect(byName.NodeBudget?.value).toContain("[node budget reached]");
  });

  it("rejects a property response whose canonical path differs from the request", async () => {
    const { inspector } = createHarness({
      propertyResult: {
        instancePath: "game.ReplicatedStorage",
        className: "Folder",
        properties: {},
      },
    });

    await expect(
      inspector.properties({
        projectId: "project-a",
        instanceId: "studio-a",
        bindingRevision: 7,
        instancePath: "game.Workspace",
      }),
    ).rejects.toThrow("Studio property response exceeds the inspector bounds");
  });
});

function node(name: string, className: string, path: string): StudioNode {
  return {
    name,
    className,
    path,
    hasChildren: false,
    hasSource: false,
  };
}
