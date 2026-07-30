import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";

import {
  assertDesktopStageAllowlist,
  auditDarwinArm64Prebuild,
  resolveDesktopHandoffOutputRoot,
  stageCuratedBetterSqlite,
  walkRegularFiles,
} from "./package-desktop.mjs";
import {
  createDesktopRuntimeManifest,
  formatDesktopRuntimeManifest,
  parseDesktopRuntimeManifest,
} from "./lib/desktop-runtime-manifest.mjs";
import { repositoryRoot } from "./lib/repository.mjs";

const sourceRoot = resolve(repositoryRoot, "apps/desktop/node_modules/better-sqlite3");
const expectedNativeSha256 = "b4dae3b865846f5336b83d0b8c1f5755bcc6cfef49d612afe523ea9259d9727e";

test("desktop handoff output stays repository-local outside controller worktrees", () => {
  assert.equal(resolveDesktopHandoffOutputRoot("/repo"), "/repo/outputs");
  assert.equal(resolveDesktopHandoffOutputRoot("/repo/.worktrees/standalone"), "/repo/outputs");
});

test("the shipped Darwin arm64 SQLite prebuild is exact and changed bytes fail closed", async () => {
  const source = resolve(sourceRoot, "prebuilds/darwin-arm64.node");
  const audited = await auditDarwinArm64Prebuild(source);
  assert.deepEqual(audited, {
    bytes: 1_965_360,
    sha256: expectedNativeSha256,
  });

  const temporaryRoot = await mkdtemp(resolve(tmpdir(), "rbxforge-sqlite-audit-"));
  const changed = resolve(temporaryRoot, "darwin-arm64.node");
  const bytes = await readFile(source);
  bytes[0] ^= 1;
  await writeFile(changed, bytes);
  await assert.rejects(auditDarwinArm64Prebuild(changed), /Darwin arm64.*SHA-256/i);
});

test("curated SQLite staging retains only package, license, JS loader, and one native prebuild", async () => {
  const temporaryRoot = await mkdtemp(resolve(tmpdir(), "rbxforge-sqlite-stage-"));
  const destination = resolve(temporaryRoot, "node_modules/better-sqlite3");
  const result = await stageCuratedBetterSqlite({ sourceRoot, destination });
  const files = await walkRegularFiles(destination);
  const sourceFiles = await walkRegularFiles(sourceRoot);
  const expected = [
    "LICENSE",
    ...sourceFiles.filter((path) => path.startsWith("lib/")),
    "package.json",
    "prebuilds/darwin-arm64.node",
  ].sort((left, right) => left.localeCompare(right));

  assert.deepEqual(files, expected);
  assert.equal(result.native.bytes, 1_965_360);
  assert.equal(result.native.sha256, expectedNativeSha256);
  assert.ok(!files.some((path) => /^prebuilds\/(?!darwin-arm64\.node$)|binding\.gyp|^src\//.test(path)));
});

test("SQLite staging rejects symlinks instead of dereferencing them", async () => {
  const temporaryRoot = await mkdtemp(resolve(tmpdir(), "rbxforge-sqlite-symlink-"));
  await copyAuditedSqliteSource(sourceRoot, temporaryRoot);
  await symlink(resolve(temporaryRoot, "lib/index.js"), resolve(temporaryRoot, "lib/alias.js"));
  await assert.rejects(
    stageCuratedBetterSqlite({
      sourceRoot: temporaryRoot,
      destination: resolve(temporaryRoot, "stage"),
      auditNative: false,
    }),
    /symlink/i,
  );
});

test("SQLite staging rejects changed, unexpected, native, WASM, and executable-mode library entries", async () => {
  for (const [label, mutate, pattern] of [
    [
      "unexpected-js",
      (root) => writeFile(resolve(root, "lib/unexpected.js"), "unexpected"),
      /unexpected.*lib\/unexpected\.js/i,
    ],
    ["native", (root) => writeFile(resolve(root, "lib/addon.node"), "native"), /addon\.node/i],
    ["wasm", (root) => writeFile(resolve(root, "lib/payload.wasm"), "wasm"), /payload\.wasm/i],
    ["executable", (root) => chmod(resolve(root, "lib/index.js"), 0o755), /executable.*lib\/index\.js/i],
    ["changed", (root) => writeFile(resolve(root, "lib/index.js"), "changed"), /lib\/index\.js.*SHA-256/i],
  ]) {
    const temporaryRoot = await mkdtemp(resolve(tmpdir(), `rbxforge-sqlite-${label}-`));
    await copyAuditedSqliteSource(sourceRoot, temporaryRoot);
    await mutate(temporaryRoot);
    await assert.rejects(
      stageCuratedBetterSqlite({
        sourceRoot: temporaryRoot,
        destination: resolve(temporaryRoot, "stage"),
      }),
      pattern,
    );
  }
});

test("desktop staging requires the exact retained runtime inventory and rejects executable payloads", async () => {
  const temporaryRoot = await mkdtemp(resolve(tmpdir(), "rbxforge-app-stage-"));
  for (const path of [
    "dist/main/index.cjs",
    "dist/preload/index.cjs",
    "dist/renderer/index.html",
    "dist/renderer/assets/index.js",
    "dist/vendor/robloxstudio-mcp/index.mjs",
    "dist/vendor/robloxstudio-mcp/assets/Baseplate.rbxl",
    "dist/vendor/studio-plugin/MCPPlugin.rbxmx",
    "build/rbxforge.icns",
    "node_modules/better-sqlite3/package.json",
    "node_modules/better-sqlite3/LICENSE",
    "node_modules/better-sqlite3/lib/index.js",
    "node_modules/better-sqlite3/prebuilds/darwin-arm64.node",
    "package.json",
    "LICENSE",
    "THIRD_PARTY_NOTICES",
  ]) {
    await mkdir(dirname(resolve(temporaryRoot, path)), { recursive: true });
    await writeFile(resolve(temporaryRoot, path), path);
  }
  const runtimeManifest = await createDesktopRuntimeManifest(resolve(temporaryRoot, "dist"));
  assert.match(formatDesktopRuntimeManifest(runtimeManifest), /"dist\/main\/index\.cjs"/);
  assert.throws(
    () =>
      parseDesktopRuntimeManifest({
        ...runtimeManifest,
        files: runtimeManifest.files.map((entry, index) =>
          index === 0 ? { ...entry, path: entry.path.replace(/^dist\//, "") } : entry,
        ),
      }),
    /manifest entry/i,
  );
  await assertDesktopStageAllowlist(temporaryRoot, runtimeManifest);

  await mkdir(resolve(temporaryRoot, "test-results/electron"), { recursive: true });
  await writeFile(resolve(temporaryRoot, "test-results/electron/fixture-main.cjs"), "test-only fixture");
  await assert.rejects(assertDesktopStageAllowlist(temporaryRoot, runtimeManifest), /test-only|unexpected/i);
  await rm(resolve(temporaryRoot, "test-results"), { recursive: true });

  for (const path of [
    "dist/renderer/assets/fixture-main.js",
    "dist/renderer/assets/visual-fixtures.js",
    "dist/renderer/assets/electron-fixture.js",
  ]) {
    await writeFile(resolve(temporaryRoot, path), "test-only fixture");
    await assert.rejects(createDesktopRuntimeManifest(resolve(temporaryRoot, "dist")), /test-only|renderer inventory/i);
    await rm(resolve(temporaryRoot, path));
  }

  await mkdir(resolve(temporaryRoot, "dist/renderer/test-results"), { recursive: true });
  await assert.rejects(
    createDesktopRuntimeManifest(resolve(temporaryRoot, "dist")),
    /test-only.*renderer\/test-results/i,
  );
  await rm(resolve(temporaryRoot, "dist/renderer/test-results"), { recursive: true });

  await writeFile(resolve(temporaryRoot, "dist/main/index.test.cjs"), "test");
  await assert.rejects(
    assertDesktopStageAllowlist(temporaryRoot, runtimeManifest),
    /main inventory.*index\.test\.cjs/i,
  );
  await rm(resolve(temporaryRoot, "dist/main/index.test.cjs"));

  for (const [path, pattern] of [
    ["dist/main/extra.cjs", /runtime main inventory/i],
    ["dist/main/addon.node", /executable\/native.*addon\.node/i],
    ["dist/renderer/payload.wasm", /executable\/native.*payload\.wasm/i],
  ]) {
    await writeFile(resolve(temporaryRoot, path), "unexpected");
    await assert.rejects(assertDesktopStageAllowlist(temporaryRoot, runtimeManifest), pattern);
    await rm(resolve(temporaryRoot, path));
  }

  await writeFile(resolve(temporaryRoot, "dist/main/index.cjs"), "changed after retained build inventory");
  await assert.rejects(
    assertDesktopStageAllowlist(temporaryRoot, runtimeManifest),
    /changed=.*dist\/main\/index\.cjs/i,
  );

  await writeFile(resolve(temporaryRoot, "dist/main/index.cjs"), "--rbxforge-visual-state=onboarding");
  const markerManifest = await createDesktopRuntimeManifest(resolve(temporaryRoot, "dist"));
  await assert.rejects(
    assertDesktopStageAllowlist(temporaryRoot, markerManifest),
    /fixture launch content.*dist\/main\/index\.cjs/i,
  );
});

async function copyAuditedSqliteSource(source, destination) {
  const libraryFiles = (await walkRegularFiles(resolve(source, "lib"))).map((path) => `lib/${path}`);
  for (const path of ["package.json", "LICENSE", ...libraryFiles, "prebuilds/darwin-arm64.node"]) {
    await mkdir(dirname(resolve(destination, path)), { recursive: true });
    await writeFile(resolve(destination, path), await readFile(resolve(source, path)));
  }
}
