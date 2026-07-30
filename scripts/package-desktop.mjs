import { createRequire } from "node:module";
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { buildDesktop } from "./build-desktop.mjs";
import { generateDesktopBrand } from "./generate-desktop-brand.mjs";
import {
  DESKTOP_PACKAGE_MANIFEST_FILE,
  assertDesktopBundlesByteIdentical,
  createDesktopPackageManifest,
  formatDesktopPackageManifest,
} from "./lib/desktop-package-manifest.mjs";
import { AUDITED_ELECTRON_FUSE_WIRE } from "./lib/macho-code-digest.mjs";
import {
  DESKTOP_RUNTIME_MANIFEST_FILE,
  assertDesktopRuntimeMatchesManifest,
  parseDesktopRuntimeManifest,
} from "./lib/desktop-runtime-manifest.mjs";
import { containsDesktopFixtureLaunchArgument, isTestOnlyDesktopPath } from "./lib/desktop-fixture-boundary.mjs";
import { artifactsRoot, repositoryRoot, runChecked, sha256, sha256File, writeJson } from "./lib/repository.mjs";

const desktopRoot = resolve(repositoryRoot, "apps/desktop");
const desktopPackageJson = resolve(desktopRoot, "package.json");
const desktopDist = resolve(desktopRoot, "dist");
const desktopPackageRoot = resolve(repositoryRoot, ".rbxforge-package/desktop");
const desktopStageRoot = resolve(desktopPackageRoot, "app");
const desktopArtifactRoot = resolve(artifactsRoot, "desktop");
const appPath = resolve(desktopArtifactRoot, "mac-arm64/RbxForge.app");
const dmgPath = resolve(desktopArtifactRoot, "RbxForge-0.1.0-arm64.dmg");
const dmgBlockmapPath = `${dmgPath}.blockmap`;
const handoffOutputRoot = resolveDesktopHandoffOutputRoot(repositoryRoot);
const handoffDmgPath = resolve(handoffOutputRoot, basename(dmgPath));

export function resolveDesktopHandoffOutputRoot(root) {
  const parent = dirname(root);
  return basename(parent) === ".worktrees" ? resolve(parent, "..", "outputs") : resolve(root, "outputs");
}

export const AUDITED_BETTER_SQLITE = Object.freeze({
  version: "13.0.1",
  native: Object.freeze({
    relative: "prebuilds/darwin-arm64.node",
    bytes: 1_965_360,
    sha256: "b4dae3b865846f5336b83d0b8c1f5755bcc6cfef49d612afe523ea9259d9727e",
  }),
  library: Object.freeze([
    Object.freeze({
      relative: "lib/binding.js",
      bytes: 2_123,
      sha256: "4fe0f892facc02af7db0a1770150565d2e944e7da3c6493116d8e2a01a0f9b19",
    }),
    Object.freeze({
      relative: "lib/darwin-arm64.js",
      bytes: 166,
      sha256: "830ec2bbc0d402f8be13e93d5549c7a9030a2d5eed40f527e4b4aee9f962ec3b",
    }),
    Object.freeze({
      relative: "lib/darwin-x64.js",
      bytes: 164,
      sha256: "2d7671f3e5d0f19e78eb88d6cd2547ec7554acd3844942fa5a8fff61fd8f9c93",
    }),
    Object.freeze({
      relative: "lib/database.js",
      bytes: 4_729,
      sha256: "539315c97591561394d2a0f257632305c3af1e32915a123aa8cc9032056d8ae2",
    }),
    Object.freeze({
      relative: "lib/index.js",
      bytes: 149,
      sha256: "0d56e190de8623278641b613433e89c4af2e5c90092c9c6e425f873d7fbc7ccf",
    }),
    Object.freeze({
      relative: "lib/linux-arm64.js",
      bytes: 165,
      sha256: "e2ff6a1e844f0f95794ebe50cea071f235bd57182ac04985819b86498541797c",
    }),
    Object.freeze({
      relative: "lib/linux-x64.js",
      bytes: 163,
      sha256: "96f9bbd76ab65da4f98a4833eb512746db6a99a2728db20feae2d70db0c2e273",
    }),
    Object.freeze({
      relative: "lib/linuxmusl-arm64.js",
      bytes: 190,
      sha256: "2edb0f14e62d3efa76c8089e58207895abb46642d1e988755a5eef5059605de9",
    }),
    Object.freeze({
      relative: "lib/linuxmusl-x64.js",
      bytes: 188,
      sha256: "d28b85927738844f589601e78e241d501c30231e9b9890f8f3605fca6d238f3d",
    }),
    Object.freeze({
      relative: "lib/methods/aggregate.js",
      bytes: 1_932,
      sha256: "e9f74eb919ec93fe089c95ddf25a98f1f631c80418fa34fb2346ca1bc29f1b82",
    }),
    Object.freeze({
      relative: "lib/methods/backup.js",
      bytes: 2_380,
      sha256: "ea29d34992bb02e006d0fdeda9675ac5d2bb227aaf57468decd997e9fc9c7dbf",
    }),
    Object.freeze({
      relative: "lib/methods/explain.js",
      bytes: 292,
      sha256: "0bd8cc80ccc7338f1d93058beea0cde924d4e7e652da9f51267e7c0757361be7",
    }),
    Object.freeze({
      relative: "lib/methods/function.js",
      bytes: 1_396,
      sha256: "f431d49303b8bbdc044b1f1b455bdad21fc9b74b007de0acb22f08f25b4febd3",
    }),
    Object.freeze({
      relative: "lib/methods/inspect.js",
      bytes: 174,
      sha256: "4975a78daee850adee62ba98719d0f223819a0ec135a07c0e302994bd8dbff61",
    }),
    Object.freeze({
      relative: "lib/methods/pragma.js",
      bytes: 543,
      sha256: "d399bf1dbc85ef8a51f946c5a9505f2c37d0b1bed3f68863b1bf202d53d6524e",
    }),
    Object.freeze({
      relative: "lib/methods/serialize.js",
      bytes: 625,
      sha256: "7a10ee5c2735384b7f0c361811bc6d017db29f62b203fd3c68a35f667e2c2605",
    }),
    Object.freeze({
      relative: "lib/methods/table.js",
      bytes: 7_144,
      sha256: "97c42d9ded1aa96c7d916b5b92f96b4e59581d50eaf629cd2c7afb78ff26a9ea",
    }),
    Object.freeze({
      relative: "lib/methods/transaction.js",
      bytes: 2_855,
      sha256: "40b71d6113f328f96cec8f6f888ffddd98b5926d38fb1e2746939c7daba93e2e",
    }),
    Object.freeze({
      relative: "lib/methods/wrappers.js",
      bytes: 1_152,
      sha256: "b289d339ff56b19ab40d109050080e1c844f2a5d01e62d8cb37a0152b0479a47",
    }),
    Object.freeze({
      relative: "lib/sqlite-error.js",
      bytes: 512,
      sha256: "903c140bb3d9d4f6256124889f5a820a491299907885d5b9d5ff2c4eaa268a06",
    }),
    Object.freeze({
      relative: "lib/util.js",
      bytes: 331,
      sha256: "92b2e39e2151b43a2252e10b6d6de876ecaf0008336a4fa1dfe1317b20f1916f",
    }),
    Object.freeze({
      relative: "lib/win32-arm64.js",
      bytes: 165,
      sha256: "00c1d5355a4e47e485e0ea8408a28423a18204d6d7ea5c57e599ebe64a1aa309",
    }),
    Object.freeze({
      relative: "lib/win32-x64.js",
      bytes: 163,
      sha256: "c25867a2e904a367743498377e6e156a653bd10bcc5f9be7cbdf8a28359012ef",
    }),
  ]),
});

export async function auditDarwinArm64Prebuild(path) {
  const bytes = await readFile(path);
  const digest = sha256(bytes);
  if (bytes.length !== AUDITED_BETTER_SQLITE.native.bytes || digest !== AUDITED_BETTER_SQLITE.native.sha256) {
    throw new Error(
      "Darwin arm64 better-sqlite3 prebuild byte count or SHA-256 drifted: " +
        `expected ${AUDITED_BETTER_SQLITE.native.bytes} bytes/${AUDITED_BETTER_SQLITE.native.sha256}, ` +
        `got ${bytes.length} bytes/${digest}`,
    );
  }
  return Object.freeze({ bytes: bytes.length, sha256: digest });
}

export async function auditBetterSqliteLibrary(sourceRoot) {
  const actual = (await walkRegularFiles(resolve(sourceRoot, "lib"))).map((path) => `lib/${path}`);
  const expected = AUDITED_BETTER_SQLITE.library.map(({ relative: path }) => path);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    const expectedSet = new Set(expected);
    const actualSet = new Set(actual);
    const missing = expected.filter((path) => !actualSet.has(path));
    const unexpected = actual.filter((path) => !expectedSet.has(path));
    throw new Error(
      `Audited better-sqlite3 library inventory changed; missing=[${missing.join(", ")}] ` +
        `unexpected=[${unexpected.join(", ")}]`,
    );
  }
  for (const entry of AUDITED_BETTER_SQLITE.library) {
    const path = resolve(sourceRoot, entry.relative);
    const info = await lstat(path);
    if ((info.mode & 0o111) !== 0) {
      throw new Error(`Audited better-sqlite3 library contains executable mode: ${entry.relative}`);
    }
    const bytes = await readFile(path);
    const digest = sha256(bytes);
    if (bytes.length !== entry.bytes || digest !== entry.sha256) {
      throw new Error(
        `Audited better-sqlite3 ${entry.relative} byte count or SHA-256 changed: ` +
          `expected ${entry.bytes} bytes/${entry.sha256}, got ${bytes.length} bytes/${digest}`,
      );
    }
  }
  return AUDITED_BETTER_SQLITE.library;
}

export async function stageCuratedBetterSqlite({ sourceRoot, destination, auditNative = true }) {
  const descriptor = JSON.parse(await readFile(resolve(sourceRoot, "package.json"), "utf8"));
  if (descriptor.name !== "better-sqlite3" || descriptor.version !== AUDITED_BETTER_SQLITE.version) {
    throw new Error("better-sqlite3 package identity does not match the audited runtime");
  }
  const libraryFiles = (await auditBetterSqliteLibrary(sourceRoot)).map(({ relative: path }) => path);
  const approved = ["package.json", "LICENSE", ...libraryFiles, AUDITED_BETTER_SQLITE.native.relative].sort(
    (left, right) => left.localeCompare(right),
  );
  await rm(destination, { recursive: true, force: true });
  for (const path of approved) {
    const source = resolve(sourceRoot, path);
    const sourceInfo = await lstat(source);
    if (sourceInfo.isSymbolicLink()) throw new Error(`SQLite staging rejects symlink: ${path}`);
    if (!sourceInfo.isFile()) throw new Error(`SQLite staging requires regular file: ${path}`);
    const output = resolve(destination, path);
    await mkdir(dirname(output), { recursive: true });
    await copyFile(source, output);
  }
  const stagedDescriptor = { ...descriptor };
  delete stagedDescriptor.dependencies;
  delete stagedDescriptor.devDependencies;
  delete stagedDescriptor.optionalDependencies;
  delete stagedDescriptor.scripts;
  await writeFile(resolve(destination, "package.json"), `${JSON.stringify(stagedDescriptor, undefined, 2)}\n`, "utf8");
  const stagedFiles = await walkRegularFiles(destination);
  if (JSON.stringify(stagedFiles) !== JSON.stringify(approved)) {
    throw new Error("Curated better-sqlite3 staging inventory changed");
  }
  await auditBetterSqliteLibrary(destination);
  const native = auditNative
    ? await auditDarwinArm64Prebuild(resolve(destination, AUDITED_BETTER_SQLITE.native.relative))
    : Object.freeze({
        bytes: (await lstat(resolve(destination, AUDITED_BETTER_SQLITE.native.relative))).size,
        sha256: sha256(await readFile(resolve(destination, AUDITED_BETTER_SQLITE.native.relative))),
      });
  return Object.freeze({ files: Object.freeze(stagedFiles), library: AUDITED_BETTER_SQLITE.library, native });
}

export async function assertDesktopStageAllowlist(stageRoot, expectedRuntimeManifest) {
  if (expectedRuntimeManifest === undefined) {
    throw new Error("Desktop staging requires the retained external runtime manifest.");
  }
  const runtimeManifest = parseDesktopRuntimeManifest(expectedRuntimeManifest);
  await assertDesktopRuntimeMatchesManifest(resolve(stageRoot, "dist"), runtimeManifest);
  const runtimeFiles = new Set(runtimeManifest.files.map(({ path }) => path));
  const files = await walkRegularFiles(stageRoot);
  const unexpected = files.filter((path) => !isApprovedDesktopStageFile(path, runtimeFiles));
  if (unexpected.length > 0) {
    throw new Error(`Desktop staging contains unexpected files: ${unexpected.join(", ")}`);
  }
  for (const required of [
    "dist/main/index.cjs",
    "dist/preload/index.cjs",
    "dist/renderer/index.html",
    "dist/vendor/robloxstudio-mcp/index.mjs",
    "dist/vendor/robloxstudio-mcp/assets/Baseplate.rbxl",
    "dist/vendor/studio-plugin/MCPPlugin.rbxmx",
    "build/rbxforge.icns",
    "node_modules/better-sqlite3/package.json",
    "node_modules/better-sqlite3/LICENSE",
    "node_modules/better-sqlite3/prebuilds/darwin-arm64.node",
    "package.json",
    "LICENSE",
    "THIRD_PARTY_NOTICES",
  ]) {
    if (!files.includes(required)) throw new Error(`Desktop staging is missing required file: ${required}`);
  }
  if (!files.some((path) => path.startsWith("node_modules/better-sqlite3/lib/"))) {
    throw new Error("Desktop staging is missing the better-sqlite3 JS loader");
  }
  for (const path of files) {
    if (containsDesktopFixtureLaunchArgument(await readFile(resolve(stageRoot, path)))) {
      throw new Error(`Desktop staging contains forbidden fixture launch content in ${path}`);
    }
  }
  return Object.freeze(files);
}

export async function stageDesktopApplication() {
  await recreateOwnedDirectory(desktopStageRoot);
  for (const directory of ["main", "preload", "renderer", "vendor"]) {
    await copyRegularTree(resolve(desktopDist, directory), resolve(desktopStageRoot, "dist", directory));
  }
  await Promise.all([
    copyFile(resolve(repositoryRoot, "LICENSE"), resolve(desktopStageRoot, "LICENSE")),
    copyFile(resolve(desktopDist, "THIRD_PARTY_NOTICES"), resolve(desktopStageRoot, "THIRD_PARTY_NOTICES")),
    mkdir(resolve(desktopStageRoot, "build"), { recursive: true }).then(() =>
      copyFile(resolve(desktopRoot, "build/rbxforge.icns"), resolve(desktopStageRoot, "build/rbxforge.icns")),
    ),
    writeFile(
      resolve(desktopStageRoot, "package.json"),
      `${JSON.stringify(
        {
          name: "rbxforge-desktop",
          version: "0.1.0",
          private: true,
          description: "Local Roblox-first RbxForge standalone desktop workbench",
          main: "dist/main/index.cjs",
          license: "UNLICENSED",
          dependencies: {
            "better-sqlite3": AUDITED_BETTER_SQLITE.version,
          },
        },
        undefined,
        2,
      )}\n`,
      "utf8",
    ),
  ]);
  const desktopRequire = createRequire(desktopPackageJson);
  const sqliteRoot = dirname(desktopRequire.resolve("better-sqlite3/package.json"));
  const sqlite = await stageCuratedBetterSqlite({
    sourceRoot: sqliteRoot,
    destination: resolve(desktopStageRoot, "node_modules/better-sqlite3"),
  });
  const runtimeManifest = parseDesktopRuntimeManifest(
    await readFile(resolve(desktopPackageRoot, "metadata", DESKTOP_RUNTIME_MANIFEST_FILE)),
  );
  const files = await assertDesktopStageAllowlist(desktopStageRoot, runtimeManifest);
  return Object.freeze({ root: desktopStageRoot, files, sqlite });
}

export async function walkRegularFiles(root, current = root) {
  const entries = await readdir(current);
  const files = [];
  for (const name of entries.sort((left, right) => left.localeCompare(right))) {
    const path = resolve(current, name);
    const info = await lstat(path);
    const display = relative(root, path).split("\\").join("/");
    if (isTestOnlyDesktopPath(display)) throw new Error(`Inventory rejects test-only path: ${display}`);
    if (info.isSymbolicLink()) throw new Error(`Inventory rejects symlink: ${display}`);
    if (info.isDirectory()) files.push(...(await walkRegularFiles(root, path)));
    else if (info.isFile()) files.push(display);
    else throw new Error(`Inventory rejects non-regular entry: ${display}`);
  }
  return files.sort((left, right) => left.localeCompare(right));
}

function isApprovedDesktopStageFile(path, runtimeFiles) {
  if (["package.json", "LICENSE", "THIRD_PARTY_NOTICES"].includes(path)) return true;
  if (path === "build/rbxforge.icns") return true;
  if (/^dist\/(?:main|preload|renderer)\//.test(path)) return runtimeFiles.has(path);
  if (
    [
      "dist/vendor/robloxstudio-mcp/index.mjs",
      "dist/vendor/robloxstudio-mcp/assets/Baseplate.rbxl",
      "dist/vendor/studio-plugin/MCPPlugin.rbxmx",
    ].includes(path)
  ) {
    return true;
  }
  return (
    path === "node_modules/better-sqlite3/package.json" ||
    path === "node_modules/better-sqlite3/LICENSE" ||
    AUDITED_BETTER_SQLITE.library.some(
      ({ relative: libraryPath }) => path === `node_modules/better-sqlite3/${libraryPath}`,
    ) ||
    path === "node_modules/better-sqlite3/prebuilds/darwin-arm64.node"
  );
}

async function packageDesktop() {
  assertDarwinArm64Host();
  const desktopRequire = createRequire(desktopPackageJson);
  await buildDesktop();
  await generateDesktopBrand();
  const stage = await stageDesktopApplication();
  const electronPackageRoot = dirname(desktopRequire.resolve("electron/package.json"));
  const packageManifest = await createDesktopPackageManifest({
    electronContentsRoot: resolve(electronPackageRoot, "dist/Electron.app/Contents"),
    iconPath: resolve(desktopRoot, "build/rbxforge.icns"),
    sqliteNativePath: resolve(stage.root, "node_modules/better-sqlite3", AUDITED_BETTER_SQLITE.native.relative),
    vendorRoot: resolve(desktopDist, "vendor"),
  });
  await writeFile(
    resolve(desktopPackageRoot, "metadata", DESKTOP_PACKAGE_MANIFEST_FILE),
    formatDesktopPackageManifest(packageManifest),
    "utf8",
  );
  await mkdir(desktopArtifactRoot, { recursive: true });
  for (const target of [resolve(desktopArtifactRoot, "mac-arm64"), dmgPath, dmgBlockmapPath]) {
    await removeOwnedArtifact(target);
  }

  const electronBuilderPackage = desktopRequire.resolve("electron-builder/package.json");
  const electronBuilderCli = resolve(dirname(electronBuilderPackage), "cli.js");
  await runChecked(
    process.execPath,
    [
      electronBuilderCli,
      "--config",
      resolve(desktopRoot, "electron-builder.yml"),
      "--projectDir",
      desktopStageRoot,
      "--dir",
      "--arm64",
    ],
    { cwd: desktopStageRoot },
  );
  await assertAppBundle(appPath);

  const fuses = desktopRequire("@electron/fuses");
  const beforeFuses = await fuses.getCurrentFuseWire(appPath);
  await fuses.flipFuses(appPath, {
    version: fuses.FuseVersion.V1,
    resetAdHocDarwinSignature: false,
    strictlyRequireAllFuses: false,
    [fuses.FuseV1Options.RunAsNode]: true,
    [fuses.FuseV1Options.EnableCookieEncryption]: true,
    [fuses.FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [fuses.FuseV1Options.EnableNodeCliInspectArguments]: true,
    [fuses.FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [fuses.FuseV1Options.OnlyLoadAppFromAsar]: true,
    // Electron's stock distribution does not ship the browser-only snapshot
    // required by this optional performance fuse. Enabling it makes the
    // packaged browser process fail before JavaScript startup.
    [fuses.FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
    // The renderer is intentionally loaded from file:// inside app.asar.
    // Electron requires its default file privileges for that local page.
    [fuses.FuseV1Options.GrantFileProtocolExtraPrivileges]: true,
  });
  const afterFuses = await fuses.getCurrentFuseWire(appPath);
  assertFuseWire(beforeFuses, afterFuses);
  await signFusedAppWithoutMutatingNative();

  await runChecked(process.execPath, [resolve(repositoryRoot, "scripts/inspect-desktop-package.mjs"), appPath]);
  await runChecked(process.execPath, [resolve(repositoryRoot, "scripts/smoke-packaged-desktop.mjs"), appPath]);
  const dmg = await buildAndVerifyDmg(electronBuilderCli);
  await mkdir(handoffOutputRoot, { recursive: true });
  await copyFile(dmgPath, handoffDmgPath);
  const report = {
    app: {
      path: relative(repositoryRoot, appPath),
      fuses: normalizeFuseWire(afterFuses),
    },
    staging: {
      files: stage.files,
      sqlite: stage.sqlite,
    },
    packageManifest: {
      schemaVersion: packageManifest.schemaVersion,
      electronVersion: packageManifest.electronVersion,
      electronSourceSha256: packageManifest.electronSourceSha256,
      contentsMode: packageManifest.contentsMode,
      entries: packageManifest.entries.length,
      exactFiles: packageManifest.entries.filter(
        ({ type, verification }) => type === "file" && verification === "exact",
      ).length,
      machOFiles: packageManifest.entries.filter(
        ({ type, verification }) => type === "file" && verification === "mach-o",
      ).length,
    },
    dmg,
    handoff: handoffDmgPath,
  };
  await writeJson(resolve(desktopPackageRoot, "package-report.json"), report);
  console.log(JSON.stringify(report, undefined, 2));
  return report;
}

if (pathToFileURL(process.argv[1] ?? "").href === import.meta.url) {
  await packageDesktop();
}

async function copyRegularTree(sourceRoot, destinationRoot, current = sourceRoot) {
  for (const name of (await readdir(current)).sort((left, right) => left.localeCompare(right))) {
    const source = resolve(current, name);
    const info = await lstat(source);
    const relativePath = relative(sourceRoot, source);
    const destination = resolve(destinationRoot, relativePath);
    if (info.isSymbolicLink()) throw new Error(`Desktop staging rejects symlink: ${relativePath}`);
    if (info.isDirectory()) {
      await mkdir(destination, { recursive: true });
      await copyRegularTree(sourceRoot, destinationRoot, source);
    } else if (info.isFile()) {
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(source, destination);
    } else {
      throw new Error(`Desktop staging rejects non-regular entry: ${relativePath}`);
    }
  }
}

async function recreateOwnedDirectory(target) {
  if (!target.startsWith(`${repositoryRoot}/`) || target === repositoryRoot) {
    throw new Error(`Refusing to recreate unsafe desktop package path: ${target}`);
  }
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
}

async function removeOwnedArtifact(target) {
  if (!target.startsWith(`${desktopArtifactRoot}/`) || target === desktopArtifactRoot) {
    throw new Error(`Refusing to remove unsafe desktop artifact path: ${target}`);
  }
  await rm(target, { recursive: true, force: true });
}

function assertDarwinArm64Host() {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("Desktop packaging requires a verified Darwin arm64 host.");
  }
}

async function assertAppBundle(path) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o7777) !== 0o755) {
    throw new Error(`Electron Builder did not create the expected app bundle: ${path}`);
  }
}

function assertFuseWire(before, after) {
  const expected = AUDITED_ELECTRON_FUSE_WIRE.states;
  if (before.version !== "1" || after.version !== "1") throw new Error("Electron fuse wire version changed.");
  const indices = Object.keys(after)
    .filter((key) => /^\d+$/.test(key))
    .map(Number)
    .sort((left, right) => left - right);
  if (indices.length !== expected.length || indices.some((value, index) => value !== index)) {
    throw new Error(`Electron 43.2.0 fuse wire length changed: ${indices.length}`);
  }
  for (let index = 0; index < expected.length; index += 1) {
    if (after[index] !== expected[index]) {
      throw new Error(`Electron named fuse ${index} has unexpected state ${String(after[index])}.`);
    }
  }
  const inheritedFuseIndex = expected.length - 1;
  if (after[inheritedFuseIndex] !== before[inheritedFuseIndex]) {
    throw new Error("Electron's ninth fuse changed from the audited enabled state.");
  }
}

async function signFusedAppWithoutMutatingNative() {
  const nativePath = resolve(
    appPath,
    "Contents/Resources/app.asar.unpacked/node_modules/better-sqlite3/prebuilds/darwin-arm64.node",
  );
  const before = await auditDarwinArm64Prebuild(nativePath);
  const frameworkRoot = resolve(appPath, "Contents/Frameworks");
  const nestedBundles = [
    "Mantle.framework",
    "ReactiveObjC.framework",
    "Squirrel.framework",
    "Electron Framework.framework",
    "RbxForge Helper.app",
    "RbxForge Helper (GPU).app",
    "RbxForge Helper (Plugin).app",
    "RbxForge Helper (Renderer).app",
  ];
  const actualBundles = (await readdir(frameworkRoot))
    .filter((name) => name.endsWith(".framework") || name.endsWith(".app"))
    .sort((left, right) => left.localeCompare(right));
  const expectedBundles = [...nestedBundles].sort((left, right) => left.localeCompare(right));
  if (JSON.stringify(actualBundles) !== JSON.stringify(expectedBundles)) {
    throw new Error(`Electron nested signing inventory changed: ${actualBundles.join(", ")}`);
  }
  for (const name of nestedBundles) {
    await runChecked("/usr/bin/codesign", ["--force", "--sign", "-", resolve(frameworkRoot, name)]);
  }
  await runChecked("/usr/bin/codesign", ["--force", "--sign", "-", appPath]);
  const after = await auditDarwinArm64Prebuild(nativePath);
  if (JSON.stringify(after) !== JSON.stringify(before)) {
    throw new Error("Ad-hoc signing mutated the audited better-sqlite3 native prebuild.");
  }
  await runChecked("/usr/bin/codesign", ["--verify", "--deep", "--strict", appPath]);
}

function normalizeFuseWire(wire) {
  return Object.fromEntries(
    Object.entries(wire)
      .filter(([key]) => key === "version" || /^\d+$/.test(key))
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

async function buildAndVerifyDmg(electronBuilderCli) {
  // Use the already inspected, fused, and signed bundle as electron-builder's
  // prepackaged input. This prevents a second application build from bypassing
  // the package gates while retaining the configured DMG layout.
  await runChecked(
    process.execPath,
    [
      electronBuilderCli,
      "--config",
      resolve(desktopRoot, "electron-builder.yml"),
      "--projectDir",
      desktopStageRoot,
      "--prepackaged",
      appPath,
      "--mac",
      "dmg",
      "--arm64",
    ],
    { cwd: desktopStageRoot },
  );
  await runChecked("/usr/bin/hdiutil", ["verify", dmgPath]);
  const mountRoot = await mkdtemp(resolve(tmpdir(), "rbxforge-dmg-mount-"));
  let mounted = false;
  try {
    await runChecked("/usr/bin/hdiutil", [
      "attach",
      "-readonly",
      "-nobrowse",
      "-noautoopen",
      "-mountpoint",
      mountRoot,
      dmgPath,
    ]);
    mounted = true;
    const mountedApp = resolve(mountRoot, "RbxForge.app");
    const [sourceAppInfo, mountedAppInfo] = await Promise.all([lstat(appPath), lstat(mountedApp)]);
    if ((sourceAppInfo.mode & 0o7777) !== (mountedAppInfo.mode & 0o7777)) {
      throw new Error("Mounted DMG app-root mode differs from the inspected app.");
    }
    await assertDesktopBundlesByteIdentical(resolve(appPath, "Contents"), resolve(mountedApp, "Contents"));
  } finally {
    if (mounted) await runChecked("/usr/bin/hdiutil", ["detach", mountRoot]);
    await rm(mountRoot, { recursive: true, force: true });
  }
  const info = await lstat(dmgPath);
  return Object.freeze({
    path: relative(repositoryRoot, dmgPath),
    bytes: info.size,
    sha256: await sha256File(dmgPath),
  });
}
