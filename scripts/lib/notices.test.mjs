import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { generateThirdPartyNotices } from "./notices.mjs";

const require = createRequire(new URL("../../apps/desktop/package.json", import.meta.url));
const packageRoots = {
  "@chrrxs/robloxstudio-mcp": dirname(dirname(require.resolve("@chrrxs/robloxstudio-mcp"))),
  "@modelcontextprotocol/sdk": findPackageRoot(require.resolve("@modelcontextprotocol/sdk/client/index.js")),
  "better-sqlite3": findPackageRoot(require.resolve("better-sqlite3")),
  react: findPackageRoot(require.resolve("react")),
  zod: findPackageRoot(require.resolve("zod")),
};

test("desktop notices require the retained desktop dependencies but not OpenAI", async () => {
  const root = await mkdtemp(join(tmpdir(), "rbxforge-notices-"));
  try {
    const mainMetafile = join(root, "main.json");
    const studioMetafile = join(root, "studio.json");
    const rendererInventory = join(root, "renderer.json");
    await writeFile(mainMetafile, JSON.stringify(metafileFor([join(packageRoots.zod, "index.cjs")])));
    await writeFile(
      studioMetafile,
      JSON.stringify(
        metafileFor([
          join(packageRoots["@chrrxs/robloxstudio-mcp"], "dist/index.js"),
          join(packageRoots["@modelcontextprotocol/sdk"], "dist/cjs/client/index.js"),
        ]),
      ),
    );
    await writeFile(rendererInventory, JSON.stringify([join(packageRoots.react, "index.js")]));

    const notices = await generateThirdPartyNotices({
      bundles: [
        { name: "desktop-main", metafilePath: mainMetafile },
        { name: "desktop-renderer", viteInventoryPath: rendererInventory },
        { name: "studio-mcp", metafilePath: studioMetafile },
      ],
      additionalPackageRoots: [packageRoots["better-sqlite3"]],
      requiredPackages: ["@chrrxs/robloxstudio-mcp", "@modelcontextprotocol/sdk", "better-sqlite3", "react", "zod"],
    });
    const names = notices.packages.map(({ package: name }) => name);
    for (const required of [
      "@chrrxs/robloxstudio-mcp@2.22.5",
      "@modelcontextprotocol/sdk@1.29.0",
      "better-sqlite3@13.0.1",
      "react@19.2.8",
      "zod@3.25.76",
    ]) {
      assert.equal(names.includes(required), true, required);
    }
    assert.equal(
      names.some((name) => name.startsWith("openai@")),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("parameterized notices fail when a caller-required dependency is absent", async () => {
  const root = await mkdtemp(join(tmpdir(), "rbxforge-notices-missing-"));
  try {
    const inventoryPath = join(root, "renderer.json");
    await writeFile(inventoryPath, JSON.stringify([join(packageRoots.react, "index.js")]));
    await assert.rejects(
      generateThirdPartyNotices({
        bundles: [{ name: "renderer", viteInventoryPath: inventoryPath }],
        requiredPackages: ["react", "openai"],
      }),
      /Required bundled dependency is absent from notices: openai/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function metafileFor(inputs) {
  return {
    outputs: {
      "out.js": {
        inputs: Object.fromEntries(inputs.map((input) => [input, { bytesInOutput: 1 }])),
      },
    },
  };
}

function findPackageRoot(entry) {
  let current = dirname(entry);
  for (;;) {
    try {
      const descriptor = JSON.parse(readFileSync(join(current, "package.json"), "utf8"));
      if (typeof descriptor.name === "string" && typeof descriptor.version === "string") return current;
    } catch {
      // Continue through nested conditional-export package boundaries.
    }
    const parent = dirname(current);
    if (parent === current) throw new Error(`Could not resolve package root for ${entry}`);
    current = parent;
  }
}
