import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";

import {
  assertDesktopBundleSecurity,
  assertPreloadMetafile,
  createBuildNonce,
  createDesktopBuildOptions,
} from "./build-desktop.mjs";
import { repositoryRoot } from "./lib/repository.mjs";

test("the visual acceptance command rebuilds its Electron fixture and renderer first", async () => {
  const manifest = JSON.parse(await readFile(resolve(repositoryRoot, "apps/desktop/package.json"), "utf8"));
  assert.equal(manifest.scripts["pretest:visual"], "pnpm run build");
  assert.equal(
    manifest.scripts["test:visual"],
    "playwright test --config playwright.config.ts --tsconfig tsconfig.playwright.json",
  );
});

test("desktop build plan bundles only the side-effecting production entry with one CSP nonce", () => {
  const nonce = createBuildNonce();
  const plan = createDesktopBuildOptions(nonce);
  assert.match(nonce, /^[A-Za-z0-9_-]{32,128}$/);
  assert.notEqual(nonce, createBuildNonce());
  assert.deepEqual(plan.main.entryPoints, [resolve(repositoryRoot, "apps/desktop/src/main/production.ts")]);
  assert.equal(plan.main.target, "node24");
  assert.equal(plan.main.format, "cjs");
  assert.equal(plan.main.sourcemap, false);
  assert.deepEqual(plan.main.external, ["electron", "better-sqlite3"]);
  assert.equal(
    plan.main.alias["jsonc-parser"],
    resolve(repositoryRoot, "apps/desktop/node_modules/jsonc-parser/lib/esm/main.js"),
  );
  assert.deepEqual(plan.preload.external, ["electron"]);
  assert.equal(plan.preload.target, "node24");
  assert.equal(plan.viteEnvironment.RBXFORGE_CSP_NONCE, nonce);
  assert.equal(plan.main.define.__RBXFORGE_CSP_NONCE__, JSON.stringify(nonce));
  assert.deepEqual(plan.fixture.entryPoints, [resolve(repositoryRoot, "apps/desktop/tests/electron/fixture-main.ts")]);
  assert.equal(plan.fixture.outfile, resolve(repositoryRoot, "apps/desktop/test-results/electron/fixture-main.cjs"));
  assert.deepEqual(plan.fixture.external, ["electron", "better-sqlite3"]);
  assert.equal(plan.fixture.define.__RBXFORGE_FIXTURE_STYLE_NONCE__, JSON.stringify(nonce));
});

test("preload inventory permits Electron but rejects retained Node builtins", () => {
  assert.doesNotThrow(() =>
    assertPreloadMetafile({
      outputs: {
        "dist/preload/index.cjs": {
          imports: [{ path: "electron", external: true }],
          inputs: { "apps/desktop/src/preload/index.ts": { bytesInOutput: 10 } },
        },
      },
    }),
  );
  assert.throws(
    () =>
      assertPreloadMetafile({
        outputs: {
          "dist/preload/index.cjs": {
            imports: [
              { path: "electron", external: true },
              { path: "node:fs", external: true },
            ],
            inputs: {},
          },
        },
      }),
    /preload.*node:fs/i,
  );
});

test("desktop bundle security scan fails on fixture branches, maps, paths, tokens, and endpoints", async () => {
  const temporaryRoot = await mkdtemp(resolve(tmpdir(), "rbxforge-build-scan-"));
  const clean = resolve(temporaryRoot, "clean");
  await write(clean, "main/index.cjs", "const origin='http://127.0.0.1';");
  await write(clean, "preload/index.cjs", "require('electron');");
  await write(clean, "renderer/index.html", "<title>RbxForge</title>");
  await assertDesktopBundleSecurity({ distRoot: clean, repositoryRoot });

  for (const [name, content] of [
    ["fixture", "if (fixtureMode) {}"],
    ["fixture-argument", "--rbxforge-visual-state=empty-chat"],
    ["fixture-argument-svg", "<svg><text>--rbxforge-visual-state=empty-chat</text></svg>"],
    ["vscode", "require('vscode')"],
    ["openai", "import 'openai'"],
    ["token", "ROBLOX_STUDIO_AUTH_TOKEN='secret-value'"],
    ["endpoint", "fetch('https://unexpected.example')"],
    ["workspace", repositoryRoot],
  ]) {
    const candidate = resolve(temporaryRoot, name);
    await write(candidate, name.endsWith("-svg") ? "renderer/assets/mark.svg" : "main/index.cjs", content);
    if (name.endsWith("-svg")) await write(candidate, "main/index.cjs", "ok");
    await write(candidate, "preload/index.cjs", "require('electron');");
    await write(candidate, "renderer/index.html", "<title>RbxForge</title>");
    await assert.rejects(
      assertDesktopBundleSecurity({ distRoot: candidate, repositoryRoot }),
      new RegExp(name.replace(/-svg$/, ""), "i"),
    );
  }

  const mapped = resolve(temporaryRoot, "map");
  await write(mapped, "main/index.cjs", "ok");
  await write(mapped, "preload/index.cjs", "ok");
  await write(mapped, "renderer/index.html", "ok");
  await write(mapped, "renderer/index.js.map", "{}");
  await assert.rejects(assertDesktopBundleSecurity({ distRoot: mapped, repositoryRoot }), /source map/i);

  for (const path of [
    "test-results/electron/index.cjs",
    "main/fixture-main.cjs",
    "renderer/assets/visual-fixtures.js",
    "renderer/assets/electron-fixture.js",
  ]) {
    const candidate = resolve(temporaryRoot, path.replaceAll("/", "-"));
    await write(candidate, "main/index.cjs", "ok");
    await write(candidate, "preload/index.cjs", "ok");
    await write(candidate, "renderer/index.html", "ok");
    await write(candidate, path, "ok");
    await assert.rejects(assertDesktopBundleSecurity({ distRoot: candidate, repositoryRoot }), /test fixture path/i);
  }

  const emptyFixtureDirectory = resolve(temporaryRoot, "empty-test-results");
  await write(emptyFixtureDirectory, "main/index.cjs", "ok");
  await write(emptyFixtureDirectory, "preload/index.cjs", "ok");
  await write(emptyFixtureDirectory, "renderer/index.html", "ok");
  await mkdir(resolve(emptyFixtureDirectory, "renderer/test-results"), { recursive: true });
  await assert.rejects(
    assertDesktopBundleSecurity({ distRoot: emptyFixtureDirectory, repositoryRoot }),
    /test fixture path.*renderer\/test-results/i,
  );
});

test("desktop bundle security rejects renderer declarations under generic test and fixture directories", async () => {
  const temporaryRoot = await mkdtemp(resolve(tmpdir(), "rbxforge-declaration-scan-"));
  const legitimate = resolve(temporaryRoot, "legitimate");
  await write(legitimate, "main/index.cjs", "ok");
  await write(legitimate, "preload/index.cjs", "ok");
  await write(legitimate, "renderer/index.html", "ok");
  await write(legitimate, "types/renderer/components/FixtureManager.d.ts", "export {};");
  await write(legitimate, "types/renderer/components/Testimonial.d.ts", "export {};");
  await assertDesktopBundleSecurity({ distRoot: legitimate, repositoryRoot });

  for (const path of [
    "types/renderer/test/fixtures.d.ts",
    "types/renderer/tests/render-helper.d.ts",
    "types/renderer/fixture/catalog.d.ts",
    "types/renderer/fixtures/catalog.d.ts",
  ]) {
    const candidate = resolve(temporaryRoot, path.replaceAll("/", "-"));
    await write(candidate, "main/index.cjs", "ok");
    await write(candidate, "preload/index.cjs", "ok");
    await write(candidate, "renderer/index.html", "ok");
    await write(candidate, path, "export {};");
    await assert.rejects(
      assertDesktopBundleSecurity({ distRoot: candidate, repositoryRoot }),
      /test fixture path.*types\/renderer\/(?:test|tests|fixture|fixtures)/i,
    );
  }
});

async function write(root, path, contents) {
  const target = resolve(root, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, contents);
}
