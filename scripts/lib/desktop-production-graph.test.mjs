import assert from "node:assert/strict";
import test from "node:test";

import { assertDesktopProductionGraph } from "./desktop-production-graph.mjs";

const cleanGraph = Object.freeze({
  main: {
    inputs: {
      "apps/desktop/src/main/production.ts": { bytes: 100 },
      "packages/core/src/index.ts": { bytes: 50 },
    },
    outputs: {
      "apps/desktop/dist/main/index.cjs": {
        imports: [{ path: "electron", external: true }],
        inputs: { "apps/desktop/src/main/production.ts": { bytesInOutput: 100 } },
      },
    },
  },
  preload: {
    inputs: { "apps/desktop/src/preload/index.ts": { bytes: 25 } },
    outputs: {},
  },
  renderer: [
    "/workspace/apps/desktop/src/renderer/main.tsx",
    "/workspace/node_modules/.pnpm/react@19.2.8/node_modules/react/index.js",
  ],
});

test("desktop production graph accepts only the standalone local runtime", () => {
  assert.doesNotThrow(() => assertDesktopProductionGraph(cleanGraph));
});

for (const [name, graph, expected] of [
  [
    "@rbxforge/agent",
    {
      ...cleanGraph,
      main: {
        inputs: {
          ...cleanGraph.main.inputs,
          "packages/agent/src/agent-loop.ts": { bytes: 1 },
        },
        outputs: cleanGraph.main.outputs,
      },
    },
    /@rbxforge\/agent.*packages\/agent\/src\/agent-loop\.ts/i,
  ],
  [
    "OpenAI SDK",
    {
      ...cleanGraph,
      main: {
        inputs: {
          ...cleanGraph.main.inputs,
          "node_modules/.pnpm/openai@6.49.0/node_modules/openai/index.mjs": { bytes: 1 },
        },
        outputs: cleanGraph.main.outputs,
      },
    },
    /OpenAI SDK.*node_modules\/openai\/index\.mjs/i,
  ],
  [
    "credential resolver",
    {
      ...cleanGraph,
      renderer: [...cleanGraph.renderer, "/workspace/node_modules/@vendor/credential-resolver/index.js"],
    },
    /credential resolver.*credential-resolver\/index\.js/i,
  ],
]) {
  test(`mutation check: production graph rejects ${name}`, () => {
    assert.throws(() => assertDesktopProductionGraph(graph), expected);
  });
}

for (const [name, path, expected] of [
  ["agent package", "@rbxforge/agent", /@rbxforge\/agent.*@rbxforge\/agent/i],
  ["OpenAI subpath", "openai/resources/responses", /OpenAI SDK.*openai\/resources\/responses/i],
]) {
  test(`mutation check: production graph rejects a forbidden external ${name} import`, () => {
    assert.throws(
      () =>
        assertDesktopProductionGraph({
          ...cleanGraph,
          main: {
            inputs: cleanGraph.main.inputs,
            outputs: {
              "apps/desktop/dist/main/index.cjs": {
                imports: [{ path, external: true }],
                inputs: {},
              },
            },
          },
        }),
      expected,
    );
  });
}
