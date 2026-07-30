import { describe, expect, test } from "vitest";

import { studioAgentBindingHash } from "./agent-claim.js";

const binding = Object.freeze({
  proposal: Object.freeze({
    kind: "studio" as const,
    operation: "property-write" as const,
    target: "game.Workspace.Part",
    ownership: "studio" as const,
    instanceId: "place:123",
    placeName: "Forge",
    graphRevision: 7,
  }),
  request: Object.freeze({
    tool: "set_property",
    input: Object.freeze({
      instancePath: "game.Workspace.Part",
      propertyName: "Anchored",
      propertyValue: true,
    }),
  }),
  expectedClassName: "Part",
  expectedPropertyValueHash: "a".repeat(64),
});

describe("studioAgentBindingHash", () => {
  test("changes when the exact mutation or old-value precondition changes", () => {
    const digest = studioAgentBindingHash(binding);
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(
      studioAgentBindingHash({
        ...binding,
        request: {
          ...binding.request,
          input: { ...binding.request.input, propertyValue: false },
        },
      }),
    ).not.toBe(digest);
    expect(
      studioAgentBindingHash({
        ...binding,
        expectedPropertyValueHash: "b".repeat(64),
      }),
    ).not.toBe(digest);
  });
});
