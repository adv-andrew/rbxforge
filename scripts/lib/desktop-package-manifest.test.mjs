import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, copyFile, cp, lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  assertDesktopBundleMatchesManifest,
  assertDesktopBundlesByteIdentical,
  createDesktopPackageManifest,
  createElectronSourceEvidence,
  createRetainedBundleManifest,
} from "./desktop-package-manifest.mjs";

const execFileAsync = promisify(execFile);

test("retained bundle inventory rejects injected Resources data and arbitrary app entries", async (t) => {
  const root = await createPackagedFixture(t);
  const manifest = await retainedFixtureManifest(root);

  for (const path of [
    "Resources/extra.js",
    "Resources/extra.json",
    "Resources/credentials.json",
    "Resources/unexpected.icns",
    "Resources/extra-directory/payload.txt",
    "unexpected.txt",
  ]) {
    const target = resolve(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, path.includes("credential") ? '{"API_KEY":"secret-value-12345"}' : "unexpected");
    await assert.rejects(
      assertFixtureBundle(root, manifest),
      new RegExp(`bundle inventory mismatch.*unexpected=.*${escapeRegExp(path)}`, "i"),
    );
    await rm(target);
    if (path.includes("/extra-directory/")) {
      await rm(resolve(root, "Resources/extra-directory"), { recursive: true });
    }
  }
});

test("retained bundle inventory rejects missing directories, icon drift, and changed Electron resources", async (t) => {
  const root = await createPackagedFixture(t);
  const manifest = await retainedFixtureManifest(root);

  await rm(resolve(root, "Resources/empty"), { recursive: true });
  await assert.rejects(assertFixtureBundle(root, manifest), /bundle inventory mismatch.*missing=.*Resources\/empty/i);
  await mkdir(resolve(root, "Resources/empty"));

  await writeFile(resolve(root, "Resources/icon.icns"), "changed icon");
  await assert.rejects(assertFixtureBundle(root, manifest), /bundle digest mismatch.*Resources\/icon\.icns/i);
  await writeFile(resolve(root, "Resources/icon.icns"), "audited icon");

  await writeFile(resolve(root, "Resources/en.lproj/locale.pak"), "changed locale");
  await assert.rejects(
    assertFixtureBundle(root, manifest),
    /bundle digest mismatch.*Resources\/en\.lproj\/locale\.pak/i,
  );
});

test("retained bundle scan rejects credential content even when the file is in the exact manifest", async (t) => {
  const root = await createPackagedFixture(t);
  await writeFile(resolve(root, "Resources/safe.json"), '{"API_KEY":"secret-value-12345"}');
  const manifest = await retainedFixtureManifest(root);

  await assert.rejects(assertFixtureBundle(root, manifest), /forbidden credential content.*Resources\/safe\.json/i);
});

test("retained bundle scan rejects every test-only desktop fixture artifact and launch marker", async (t) => {
  const root = await createPackagedFixture(t);

  for (const path of [
    "Resources/test-results/electron/report.json",
    "Resources/fixture-main.cjs",
    "Resources/visual-fixtures.js",
    "Resources/electron-fixture.js",
  ]) {
    const target = resolve(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, "fixture");
    const manifest = await retainedFixtureManifest(root);
    await assert.rejects(assertFixtureBundle(root, manifest), /forbidden path names/i);
    await rm(target, { recursive: true, force: true });
    if (path.startsWith("Resources/test-results/")) {
      await rm(resolve(root, "Resources/test-results"), { recursive: true, force: true });
    }
  }

  await writeFile(resolve(root, "Resources/safe.js"), 'const argument = "--rbxforge-visual-state=onboarding";');
  const manifest = await retainedFixtureManifest(root);
  await assert.rejects(assertFixtureBundle(root, manifest), /forbidden fixture launch content.*Resources\/safe\.js/i);
});

test("bundle inspection rejects a structurally valid manifest that is not anchored to audited Electron evidence", async (t) => {
  const root = await createPackagedFixture(t);
  const manifest = await retainedFixtureManifest(root);

  await assert.rejects(
    assertDesktopBundleMatchesManifest(root, manifest, { trustedManifest: manifest }),
    /retained Electron evidence mismatch/i,
  );
});

test("bundle inspection rejects preserved-header entry tampering instead of trusting external evidence", async (t) => {
  const root = await createPackagedFixture(t);
  const trustedManifest = await retainedFixtureManifest(root);
  const accepted = [];

  const extraPath = resolve(root, "Resources/extra.js");
  await writeFile(extraPath, "safe extra");
  const extraManifest = await retainedFixtureManifest(root);
  assert.equal(extraManifest.electronVersion, trustedManifest.electronVersion);
  assert.equal(extraManifest.electronSourceSha256, trustedManifest.electronSourceSha256);
  try {
    await assertDesktopBundleMatchesManifest(root, extraManifest, {
      expectedElectronVersion: "43.2.0",
      expectedElectronSourceSha256: "a".repeat(64),
      trustedManifest,
    });
    accepted.push("extra.js");
  } catch (error) {
    assert.match(String(error), /manifest evidence mismatch/i);
  }
  await rm(extraPath);

  await writeFile(resolve(root, "Resources/icon.icns"), "changed icon");
  const changedIconManifest = await retainedFixtureManifest(root);
  assert.equal(changedIconManifest.electronVersion, trustedManifest.electronVersion);
  assert.equal(changedIconManifest.electronSourceSha256, trustedManifest.electronSourceSha256);
  try {
    await assertDesktopBundleMatchesManifest(root, changedIconManifest, {
      expectedElectronVersion: "43.2.0",
      expectedElectronSourceSha256: "a".repeat(64),
      trustedManifest,
    });
    accepted.push("changed icon");
  } catch (error) {
    assert.match(String(error), /manifest evidence mismatch/i);
  }

  assert.deepEqual(accepted, []);
});

test("retained bundle inventory rejects symlink substitution and byte comparison covers every file", async (t) => {
  const source = await createPackagedFixture(t);
  const destination = await createPackagedFixture(t);
  const manifest = await retainedFixtureManifest(source);

  await assertFixtureBundle(source, manifest);
  await assertDesktopBundlesByteIdentical(source, destination);

  await rm(resolve(destination, "Resources/icon.icns"));
  await symlink("en.lproj/locale.pak", resolve(destination, "Resources/icon.icns"));
  await assert.rejects(
    assertFixtureBundle(destination, manifest),
    /bundle inventory mismatch.*type=.*Resources\/icon\.icns/i,
  );
  await assert.rejects(
    assertDesktopBundlesByteIdentical(source, destination),
    /bundle byte comparison.*type=.*Resources\/icon\.icns/i,
  );
});

test(
  "signed helper executable substitution is rejected even after a valid ad-hoc re-sign",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const fixtureRoot = await mkdtemp(resolve(tmpdir(), "rbxforge-signed-substitution-"));
    t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
    const desktopRequire = createRequire(resolve(process.cwd(), "apps/desktop/package.json"));
    const electronRoot = dirname(desktopRequire.resolve("electron/package.json"));
    const electronContents = resolve(electronRoot, "dist/Electron.app/Contents");
    const expectedApp = resolve(fixtureRoot, "Expected Helper.app");
    const substitutedApp = resolve(fixtureRoot, "Substituted Helper.app");
    const sourceHelper = resolve(electronContents, "Frameworks/Electron Helper.app");
    await cp(sourceHelper, expectedApp, { recursive: true });
    await execFileAsync("/usr/bin/codesign", ["--force", "--sign", "-", expectedApp]);
    await cp(expectedApp, substitutedApp, { recursive: true });

    const expectedContents = resolve(expectedApp, "Contents");
    const expectedExecutable = "MacOS/Electron Helper";
    const manifest = await createRetainedBundleManifest(expectedContents, {
      electronVersion: "43.2.0",
      sourceEvidenceSha256: "a".repeat(64),
      verificationForPath: (path) => {
        if (path === expectedExecutable) return "mach-o";
        if (path.startsWith("_CodeSignature/")) return "signed";
        return "exact";
      },
    });

    await copyFile(
      resolve(electronContents, "Frameworks/Mantle.framework/Versions/A/Mantle"),
      resolve(substitutedApp, "Contents", expectedExecutable),
    );
    await execFileAsync("/usr/bin/codesign", ["--force", "--sign", "-", substitutedApp]);
    await execFileAsync("/usr/bin/codesign", ["--verify", "--strict", substitutedApp]);

    await assert.rejects(
      assertDesktopBundleMatchesManifest(resolve(substitutedApp, "Contents"), manifest, {
        expectedElectronVersion: "43.2.0",
        expectedElectronSourceSha256: "a".repeat(64),
        trustedManifest: manifest,
      }),
      /Mach-O code digest mismatch.*MacOS\/Electron Helper/i,
    );
  },
);

test("bundle inventory and byte comparison reject exact POSIX permission drift", async (t) => {
  const source = await createPackagedFixture(t);
  const destination = await createPackagedFixture(t);
  const manifest = await retainedFixtureManifest(source);
  const accepted = [];

  for (const [label, path, mode] of [
    ["regular 0644 to 0666", "Resources/icon.icns", 0o666],
    ["executable 0755 to 0777", "MacOS/RbxForge", 0o777],
    ["executable 0755 to 4755", "MacOS/RbxForge", 0o4755],
    ["directory 0755 to 0777", "Resources/empty", 0o777],
    ["Contents root 0755 to 0777", "", 0o777],
  ]) {
    const target = resolve(destination, path);
    const originalMode = (await lstat(target)).mode & 0o7777;
    await chmod(target, mode);
    try {
      await assertFixtureBundle(destination, manifest);
      accepted.push(`manifest: ${label}`);
    } catch (error) {
      assert.match(String(error), new RegExp(`mode=.*${escapeRegExp(path === "" ? "<root>" : path)}`, "i"));
    }
    try {
      await assertDesktopBundlesByteIdentical(source, destination);
      accepted.push(`byte comparison: ${label}`);
    } catch (error) {
      assert.match(String(error), new RegExp(`mode=.*${escapeRegExp(path === "" ? "<root>" : path)}`, "i"));
    }
    await chmod(target, originalMode);
  }

  assert.deepEqual(accepted, []);
});

test("desktop package manifest is derived from pinned Electron and curated inputs, not the output app", async (t) => {
  const fixtureRoot = await mkdtemp(resolve(tmpdir(), "rbxforge-package-evidence-"));
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const electronContentsRoot = resolve(fixtureRoot, "Electron.app/Contents");
  const iconPath = resolve(fixtureRoot, "curated/rbxforge.icns");
  const sqliteNativePath = resolve(fixtureRoot, "curated/darwin-arm64.node");
  const vendorRoot = resolve(fixtureRoot, "curated/vendor");

  for (const [path, contents] of [
    ["Info.plist", "electron plist"],
    ["PkgInfo", "APPL????"],
    ["MacOS/Electron", createTestMachO(0x11)],
    ["Frameworks/Electron Helper.app/Contents/Info.plist", "helper plist"],
    ["Frameworks/Electron Helper.app/Contents/MacOS/Electron Helper", createTestMachO(0x22)],
    ["Frameworks/Electron Helper.app/Contents/PkgInfo", "APPL????"],
    ["Resources/default_app.asar", "default"],
    ["Resources/electron.icns", "electron icon"],
    ["Resources/en.lproj/locale.pak", "locale"],
  ]) {
    const target = resolve(electronContentsRoot, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
  await chmod(resolve(electronContentsRoot, "MacOS/Electron"), 0o755);
  await chmod(resolve(electronContentsRoot, "Frameworks/Electron Helper.app/Contents/MacOS/Electron Helper"), 0o755);

  for (const [path, contents] of [
    [iconPath, "audited icon"],
    [sqliteNativePath, "audited native"],
    [resolve(vendorRoot, "robloxstudio-mcp/index.mjs"), "audited mcp"],
    [resolve(vendorRoot, "robloxstudio-mcp/assets/Baseplate.rbxl"), "audited baseplate"],
    [resolve(vendorRoot, "studio-plugin/MCPPlugin.rbxmx"), "audited plugin"],
  ]) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents);
  }

  const sourceEvidence = await createElectronSourceEvidence(electronContentsRoot);
  const manifest = await createDesktopPackageManifest({
    electronContentsRoot,
    expectedElectronSourceSha256: sourceEvidence.sha256,
    iconPath,
    sqliteNativePath,
    vendorRoot,
  });
  const paths = manifest.entries.map(({ path }) => path);
  assert.ok(paths.includes("MacOS/RbxForge"));
  assert.ok(paths.includes("Frameworks/RbxForge Helper.app/Contents/MacOS/RbxForge Helper"));
  assert.ok(paths.includes("Resources/app.asar"));
  assert.ok(paths.includes("Resources/icon.icns"));
  assert.ok(paths.includes("Resources/en.lproj/locale.pak"));
  assert.ok(!paths.includes("Resources/default_app.asar"));
  assert.ok(!paths.includes("Resources/electron.icns"));
  const iconEntry = manifest.entries.find(({ path }) => path === "Resources/icon.icns");
  assert.equal(iconEntry?.verification, "exact");
  assert.equal(iconEntry?.bytes, Buffer.byteLength("audited icon"));
  assert.match(iconEntry?.sha256 ?? "", /^[a-f0-9]{64}$/);

  await writeFile(resolve(electronContentsRoot, "Resources/extra.json"), "{}");
  await assert.rejects(
    createDesktopPackageManifest({
      electronContentsRoot,
      expectedElectronSourceSha256: sourceEvidence.sha256,
      iconPath,
      sqliteNativePath,
      vendorRoot,
    }),
    /Electron source evidence changed/i,
  );
});

async function createPackagedFixture(t) {
  const root = await mkdtemp(resolve(tmpdir(), "rbxforge-packaged-bundle-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const path of ["Resources/empty", "Resources/en.lproj", "MacOS", "_CodeSignature"]) {
    await mkdir(resolve(root, path), { recursive: true });
  }
  for (const [path, contents] of [
    ["Info.plist", "plist"],
    ["PkgInfo", "APPL????"],
    ["MacOS/RbxForge", "executable"],
    ["Resources/app.asar", "asar"],
    ["Resources/icon.icns", "audited icon"],
    ["Resources/en.lproj/locale.pak", "audited locale"],
    ["_CodeSignature/CodeResources", "signature"],
  ]) {
    await writeFile(resolve(root, path), contents);
  }
  await chmod(resolve(root, "MacOS/RbxForge"), 0o755);
  return root;
}

async function retainedFixtureManifest(root) {
  return createRetainedBundleManifest(root, {
    electronVersion: "43.2.0",
    sourceEvidenceSha256: "a".repeat(64),
    verificationForPath: (path) => {
      if (path === "Resources/app.asar") return "asar";
      if (path === "Info.plist") return "plist";
      if (path === "_CodeSignature/CodeResources") return "signed";
      return "exact";
    },
  });
}

async function assertFixtureBundle(root, manifest) {
  return assertDesktopBundleMatchesManifest(root, manifest, {
    expectedElectronVersion: "43.2.0",
    expectedElectronSourceSha256: "a".repeat(64),
    trustedManifest: manifest,
  });
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function createTestMachO(fill) {
  const signatureOffset = 0x4010;
  const signatureBytes = 64;
  const bytes = Buffer.alloc(signatureOffset + signatureBytes, fill);
  bytes.writeUInt32LE(0xfeedfacf, 0);
  bytes.writeUInt32LE(0x0100000c, 4);
  bytes.writeUInt32LE(0, 8);
  bytes.writeUInt32LE(2, 12);
  bytes.writeUInt32LE(3, 16);
  bytes.writeUInt32LE(160, 20);
  bytes.writeUInt32LE(0, 24);
  bytes.writeUInt32LE(0, 28);

  writeTestSegment(bytes, 32, "__TEXT", 0, 0x4000, 0x4000, 7, 5);
  writeTestSegment(bytes, 104, "__LINKEDIT", 0x4000, 80, 0x4000, 1, 1);

  const signature = 176;
  bytes.writeUInt32LE(0x1d, signature);
  bytes.writeUInt32LE(16, signature + 4);
  bytes.writeUInt32LE(signatureOffset, signature + 8);
  bytes.writeUInt32LE(signatureBytes, signature + 12);
  return bytes;
}

function writeTestSegment(bytes, offset, name, fileOffset, fileBytes, virtualSize, maxProtection, initialProtection) {
  bytes.writeUInt32LE(0x19, offset);
  bytes.writeUInt32LE(72, offset + 4);
  bytes.fill(0, offset + 8, offset + 24);
  bytes.write(name, offset + 8, "ascii");
  bytes.writeBigUInt64LE(BigInt(fileOffset), offset + 24);
  bytes.writeBigUInt64LE(BigInt(virtualSize), offset + 32);
  bytes.writeBigUInt64LE(BigInt(fileOffset), offset + 40);
  bytes.writeBigUInt64LE(BigInt(fileBytes), offset + 48);
  bytes.writeUInt32LE(maxProtection, offset + 56);
  bytes.writeUInt32LE(initialProtection, offset + 60);
  bytes.writeUInt32LE(0, offset + 64);
  bytes.writeUInt32LE(0, offset + 68);
}
