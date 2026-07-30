import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { lstat, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  AUDITED_BETTER_SQLITE,
  auditBetterSqliteLibrary,
  auditDarwinArm64Prebuild,
  walkRegularFiles,
} from "./package-desktop.mjs";
import {
  DESKTOP_PACKAGE_MANIFEST_FILE,
  assertDesktopBundleMatchesManifest,
  createDesktopPackageManifest,
  parseDesktopPackageManifest,
} from "./lib/desktop-package-manifest.mjs";
import {
  DESKTOP_RUNTIME_MANIFEST_FILE,
  assertDesktopRuntimeMatchesManifest,
  parseDesktopRuntimeManifest,
} from "./lib/desktop-runtime-manifest.mjs";
import { containsDesktopFixtureLaunchArgument, isTestOnlyDesktopPath } from "./lib/desktop-fixture-boundary.mjs";
import { AUDITED_ELECTRON_FUSE_WIRE } from "./lib/macho-code-digest.mjs";
import { AUDITED_STUDIO_MCP } from "./lib/studio-mcp-vendor.mjs";
import { artifactsRoot, repositoryRoot, sha256, sha256File, writeJson } from "./lib/repository.mjs";

const execFileAsync = promisify(execFile);
const desktopRoot = resolve(repositoryRoot, "apps/desktop");
const defaultAppPath = resolve(artifactsRoot, "desktop/mac-arm64/RbxForge.app");
const inspectedAppPath = resolve(process.argv[2] ?? defaultAppPath);

export async function inspectDesktopPackage(appPath = inspectedAppPath) {
  const appInfo = await lstat(appPath);
  if (!appInfo.isDirectory() || appInfo.isSymbolicLink() || (appInfo.mode & 0o7777) !== 0o755) {
    throw new Error("Packaged app root must be a regular 0755 directory.");
  }
  const desktopRequire = createRequire(resolve(desktopRoot, "package.json"));
  const asar = desktopRequire("@electron/asar");
  const fuses = desktopRequire("@electron/fuses");
  const resourcesRoot = resolve(appPath, "Contents/Resources");
  const asarPath = resolve(resourcesRoot, "app.asar");
  const unpackedRoot = resolve(resourcesRoot, "app.asar.unpacked");
  const vendorRoot = resolve(resourcesRoot, "vendor");
  const executable = resolve(appPath, "Contents/MacOS/RbxForge");
  const infoPlist = resolve(appPath, "Contents/Info.plist");
  const electronPackageRoot = dirname(desktopRequire.resolve("electron/package.json"));
  const sqlitePackageRoot = dirname(desktopRequire.resolve("better-sqlite3/package.json"));
  const sourceNativePath = resolve(sqlitePackageRoot, AUDITED_BETTER_SQLITE.native.relative);
  await auditDarwinArm64Prebuild(sourceNativePath);
  const packageManifest = parseDesktopPackageManifest(
    await readFile(resolve(repositoryRoot, ".rbxforge-package/desktop/metadata", DESKTOP_PACKAGE_MANIFEST_FILE)),
  );
  const trustedPackageManifest = await createDesktopPackageManifest({
    electronContentsRoot: resolve(electronPackageRoot, "dist/Electron.app/Contents"),
    iconPath: resolve(desktopRoot, "build/rbxforge.icns"),
    sqliteNativePath: sourceNativePath,
    vendorRoot: resolve(desktopRoot, "dist/vendor"),
  });
  const bundleInventory = await assertDesktopBundleMatchesManifest(resolve(appPath, "Contents"), packageManifest, {
    trustedManifest: trustedPackageManifest,
  });

  const asarEntries = asar
    .listPackage(asarPath, { isPack: false })
    .map((path) =>
      path
        .replace(/^[/\\]+/, "")
        .split("\\")
        .join("/"),
    )
    .filter((path) => path !== "")
    .sort((left, right) => left.localeCompare(right));
  const asarFiles = asarEntries.filter((path) => !("files" in asar.statFile(asarPath, path, false)));
  const runtimeManifest = parseDesktopRuntimeManifest(
    await readFile(resolve(repositoryRoot, ".rbxforge-package/desktop/metadata", DESKTOP_RUNTIME_MANIFEST_FILE)),
  );
  assertAsarInventory(asarFiles, runtimeManifest, asarEntries);
  assertNoAsarLinks(asar.getRawHeader(asarPath).header);

  const extractionRoot = await mkdtemp(resolve(tmpdir(), "rbxforge-asar-inspect-"));
  try {
    asar.extractAll(asarPath, extractionRoot);
    await assertExtractedContent(extractionRoot, runtimeManifest);
  } finally {
    await rm(extractionRoot, { recursive: true, force: true });
  }

  const unpackedFiles = await walkRegularFiles(unpackedRoot);
  if (JSON.stringify(unpackedFiles) !== JSON.stringify(["node_modules/better-sqlite3/prebuilds/darwin-arm64.node"])) {
    throw new Error(`Unexpected app.asar.unpacked inventory: ${unpackedFiles.join(", ")}`);
  }
  const native = await auditDarwinArm64Prebuild(
    resolve(unpackedRoot, AUDITED_BETTER_SQLITE.native.relative.replace(/^/, "node_modules/better-sqlite3/")),
  );
  const nativePath = resolve(
    unpackedRoot,
    AUDITED_BETTER_SQLITE.native.relative.replace(/^/, "node_modules/better-sqlite3/"),
  );
  const nativeArchitecture = (await captured("/usr/bin/lipo", ["-archs", nativePath])).trim();
  if (nativeArchitecture !== "arm64") {
    throw new Error(`Packaged SQLite native architecture is not arm64: ${nativeArchitecture}`);
  }
  const vendorFiles = await walkRegularFiles(vendorRoot);
  const expectedVendor = [
    "robloxstudio-mcp/assets/Baseplate.rbxl",
    "robloxstudio-mcp/index.mjs",
    "studio-plugin/MCPPlugin.rbxmx",
  ];
  if (JSON.stringify(vendorFiles) !== JSON.stringify(expectedVendor)) {
    throw new Error(`Unexpected packaged vendor inventory: ${vendorFiles.join(", ")}`);
  }
  const vendorDigests = {};
  for (const path of expectedVendor) {
    const packaged = resolve(vendorRoot, path);
    const built = resolve(desktopRoot, "dist/vendor", path);
    const digest = await sha256File(packaged);
    if (digest !== (await sha256File(built))) {
      throw new Error(`Packaged Studio MCP digest mismatch for ${path}`);
    }
    vendorDigests[path] = digest;
  }
  await assertPinnedVendorAsset(
    resolve(vendorRoot, "robloxstudio-mcp/assets/Baseplate.rbxl"),
    AUDITED_STUDIO_MCP.baseplate,
    "Baseplate",
  );
  await assertPinnedVendorAsset(
    resolve(vendorRoot, "studio-plugin/MCPPlugin.rbxmx"),
    AUDITED_STUDIO_MCP.plugin,
    "Studio plugin",
  );

  const resourceExecutables = await executableFiles(resourcesRoot);
  const allowedResourceExecutables = new Set([
    "app.asar.unpacked/node_modules/better-sqlite3/prebuilds/darwin-arm64.node",
    "vendor/robloxstudio-mcp/index.mjs",
  ]);
  const unexpectedResourceExecutables = resourceExecutables.filter((path) => !allowedResourceExecutables.has(path));
  if (unexpectedResourceExecutables.length > 0) {
    throw new Error(`Unexpected executable/native files in Resources: ${unexpectedResourceExecutables.join(", ")}`);
  }

  const architecture = (await captured("/usr/bin/lipo", ["-archs", executable])).trim();
  if (architecture !== "arm64") throw new Error(`Packaged executable architecture is not arm64: ${architecture}`);
  const plist = {
    identifier: await plistValue(infoPlist, "CFBundleIdentifier"),
    name: await plistValue(infoPlist, "CFBundleName"),
    executable: await plistValue(infoPlist, "CFBundleExecutable"),
    packageType: await plistValue(infoPlist, "CFBundlePackageType"),
    version: await plistValue(infoPlist, "CFBundleShortVersionString"),
    category: await plistValue(infoPlist, "LSApplicationCategoryType"),
    asarIntegrityAlgorithm: await plistValue(infoPlist, "ElectronAsarIntegrity:Resources/app.asar:algorithm"),
    asarIntegrityHash: await plistValue(infoPlist, "ElectronAsarIntegrity:Resources/app.asar:hash"),
  };
  const asarHeaderHash = sha256(Buffer.from(asar.getRawHeader(asarPath).headerString));
  if (
    plist.identifier !== "dev.rbxforge.desktop" ||
    plist.name !== "RbxForge" ||
    plist.executable !== "RbxForge" ||
    plist.packageType !== "APPL" ||
    plist.version !== "0.1.0" ||
    plist.category !== "public.app-category.developer-tools" ||
    plist.asarIntegrityAlgorithm !== "SHA256" ||
    plist.asarIntegrityHash !== asarHeaderHash
  ) {
    throw new Error(`Packaged Info.plist identity is invalid: ${JSON.stringify(plist)}`);
  }
  const helperPlists = await inspectHelperPlists(appPath);
  await captured("/usr/bin/codesign", ["--verify", "--deep", "--strict", appPath]);
  const signature = await captured("/usr/bin/codesign", ["--display", "--verbose=4", appPath], true);
  if (!/Signature=adhoc/i.test(signature)) throw new Error("Packaged app is not ad-hoc signed.");
  const fuseWire = await fuses.getCurrentFuseWire(appPath);
  assertPackagedFuseWire(fuseWire);

  const report = {
    appPath,
    bundle: {
      ...bundleInventory,
      electronVersion: packageManifest.electronVersion,
      electronSourceSha256: packageManifest.electronSourceSha256,
      icon: {
        bytes: (await lstat(resolve(resourcesRoot, "icon.icns"))).size,
        sha256: await sha256File(resolve(resourcesRoot, "icon.icns")),
      },
      helpers: helperPlists,
    },
    asar: {
      bytes: (await lstat(asarPath)).size,
      sha256: await sha256File(asarPath),
      entries: asarEntries,
      files: asarFiles,
      runtimeManifest,
    },
    unpacked: { entries: unpackedFiles, native: { ...native, architecture: nativeArchitecture } },
    vendor: { entries: vendorFiles, sha256: vendorDigests },
    executable: { architecture, fuses: normalizeFuseWire(fuseWire), resourceExecutables },
    plist,
    signature: signature.trim().split("\n"),
  };
  await writeJson(resolve(repositoryRoot, ".rbxforge-package/desktop/inspection.json"), report);
  console.log(JSON.stringify(report, undefined, 2));
  return report;
}

export function assertAsarInventory(fileEntries, runtimeManifest, allEntries = fileEntries) {
  const files = fileEntries.filter((path) => !path.endsWith("/"));
  const runtimeFiles = new Set(runtimeManifest.files.map(({ path }) => path));
  const sqliteLibraryFiles = new Set(
    AUDITED_BETTER_SQLITE.library.map(({ relative: path }) => `node_modules/better-sqlite3/${path}`),
  );
  const allowedNative = "node_modules/better-sqlite3/prebuilds/darwin-arm64.node";
  const forbidden = [
    ...new Set([
      ...allEntries.filter(
        (path) =>
          isTestOnlyDesktopPath(path) ||
          /(?:^|\/)(?:fixtures?|tests?|__tests__)(?:\/|$)/i.test(path) ||
          /\.(?:ts|tsx|map)$/.test(path) ||
          /(?:^|\/)\.env(?:\.|$)/i.test(path) ||
          /credential|secret|auth[-_]?token/i.test(path) ||
          /(?:^|\/)(?:extension|webview)(?:\/|$)/i.test(path),
      ),
      ...files.filter((path) => /\.(?:dylib|dll|exe|node|so|wasm)$/i.test(path) && path !== allowedNative),
    ]),
  ];
  const unexpected = files.filter((path) => !isAllowedAsarFile(path, runtimeFiles, sqliteLibraryFiles));
  if (forbidden.length > 0 || unexpected.length > 0) {
    throw new Error(`ASAR allowlist failed; forbidden=[${forbidden.join(", ")}] unexpected=[${unexpected.join(", ")}]`);
  }
  for (const required of [
    "dist/main/index.cjs",
    "dist/preload/index.cjs",
    "dist/renderer/index.html",
    "node_modules/better-sqlite3/package.json",
    "node_modules/better-sqlite3/LICENSE",
    "node_modules/better-sqlite3/prebuilds/darwin-arm64.node",
    "package.json",
    "LICENSE",
    "THIRD_PARTY_NOTICES",
  ]) {
    if (!files.includes(required)) throw new Error(`ASAR is missing required file: ${required}`);
  }
  if (!files.some((path) => path.startsWith("node_modules/better-sqlite3/lib/"))) {
    throw new Error("ASAR is missing the curated better-sqlite3 JS loader.");
  }
}

function isAllowedAsarFile(path, runtimeFiles, sqliteLibraryFiles) {
  if (["package.json", "LICENSE", "THIRD_PARTY_NOTICES"].includes(path)) return true;
  if (/^dist\/(?:main|preload|renderer)\//.test(path)) return runtimeFiles.has(path);
  return (
    path === "node_modules/better-sqlite3/package.json" ||
    path === "node_modules/better-sqlite3/LICENSE" ||
    sqliteLibraryFiles.has(path) ||
    path === "node_modules/better-sqlite3/prebuilds/darwin-arm64.node"
  );
}

function assertNoAsarLinks(header) {
  const visit = (node, prefix = "") => {
    for (const [name, child] of Object.entries(node.files ?? {})) {
      const path = prefix === "" ? name : `${prefix}/${name}`;
      if ("link" in child) throw new Error(`ASAR contains forbidden symlink: ${path}`);
      visit(child, path);
    }
  };
  visit(header);
}

async function assertExtractedContent(root, runtimeManifest) {
  await assertDesktopRuntimeMatchesManifest(resolve(root, "dist"), runtimeManifest);
  await auditBetterSqliteLibrary(resolve(root, "node_modules/better-sqlite3"));
  const allowedNative = "node_modules/better-sqlite3/prebuilds/darwin-arm64.node";
  for (const path of await walkRegularFiles(root)) {
    const info = await lstat(resolve(root, path));
    if ((info.mode & 0o111) !== 0 && path !== allowedNative) {
      throw new Error(`ASAR contains unexpected executable-mode file: ${path}`);
    }
    if (/\.(?:dylib|dll|exe|node|so|wasm)$/i.test(path) && path !== allowedNative) {
      throw new Error(`ASAR contains unexpected native/executable payload: ${path}`);
    }
    const bytes = await readFile(resolve(root, path));
    assertNoForbiddenAsarContent(bytes, path);
    const extension = extname(path);
    if (!new Set([".cjs", ".mjs", ".js", ".css", ".html", ".json", ""]).has(extension)) continue;
    const source = bytes.toString("utf8");
    if (source.includes(repositoryRoot)) throw new Error(`ASAR contains workspace absolute path in ${path}`);
    if (/(?:AUTH_TOKEN|API_KEY)\s*=\s*["'][A-Za-z0-9_-]{10,}["']/i.test(source)) {
      throw new Error(`ASAR contains an auth-token value in ${path}`);
    }
  }
  const notices = await readFile(resolve(root, "THIRD_PARTY_NOTICES"), "utf8");
  if (!notices.includes("@chrrxs/robloxstudio-mcp@2.22.5") || !notices.includes(AUDITED_STUDIO_MCP.license.sha256)) {
    throw new Error("ASAR notices omit the audited Studio MCP license.");
  }
  const license = await readFile(resolve(root, "LICENSE"), "utf8");
  if (!/standalone RbxForge app/i.test(license)) {
    throw new Error("ASAR license does not cover the standalone app.");
  }
}

export function assertNoForbiddenAsarContent(source, path) {
  if (containsDesktopFixtureLaunchArgument(source)) {
    throw new Error(`ASAR contains forbidden fixture launch content in ${path}`);
  }
}

async function assertPinnedVendorAsset(path, expected, label) {
  const info = await lstat(path);
  const digest = await sha256File(path);
  if (info.size !== expected.bytes || digest !== expected.sha256) {
    throw new Error(`${label} digest mismatch in packaged resources.`);
  }
}

async function executableFiles(root, current = root) {
  const files = [];
  for (const name of await readdir(current)) {
    const path = resolve(current, name);
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error(`Packaged Resources contains symlink: ${relative(root, path)}`);
    if (info.isDirectory()) files.push(...(await executableFiles(root, path)));
    else if (info.isFile() && ((info.mode & 0o111) !== 0 || path.endsWith(".node"))) {
      files.push(relative(root, path).split("\\").join("/"));
    }
  }
  return files.sort((left, right) => left.localeCompare(right));
}

async function plistValue(path, key) {
  return (await captured("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, path])).trim();
}

async function inspectHelperPlists(appPath) {
  const expected = [
    {
      suffix: "",
      identifier: "dev.rbxforge.desktop.helper",
      name: "Electron Helper",
      executable: "RbxForge Helper",
    },
    {
      suffix: " (GPU)",
      identifier: "dev.rbxforge.desktop.helper.GPU",
      name: "Electron Helper (GPU)",
      executable: "RbxForge Helper (GPU)",
    },
    {
      suffix: " (Plugin)",
      identifier: "dev.rbxforge.desktop.helper.Plugin",
      name: "Electron Helper (Plugin)",
      executable: "RbxForge Helper (Plugin)",
    },
    {
      suffix: " (Renderer)",
      identifier: "dev.rbxforge.desktop.helper.Renderer",
      name: "Electron Helper (Renderer)",
      executable: "RbxForge Helper (Renderer)",
    },
  ];
  const inspected = [];
  for (const entry of expected) {
    const path = resolve(appPath, `Contents/Frameworks/RbxForge Helper${entry.suffix}.app/Contents/Info.plist`);
    const actual = {
      identifier: await plistValue(path, "CFBundleIdentifier"),
      name: await plistValue(path, "CFBundleName"),
      executable: await plistValue(path, "CFBundleExecutable"),
    };
    if (
      actual.identifier !== entry.identifier ||
      actual.name !== entry.name ||
      actual.executable !== entry.executable
    ) {
      throw new Error(`Packaged helper Info.plist identity is invalid: ${JSON.stringify(actual)}`);
    }
    inspected.push(Object.freeze({ suffix: entry.suffix, ...actual }));
  }
  return Object.freeze(inspected);
}

async function captured(command, args, includeStderr = false) {
  try {
    const result = await execFileAsync(command, args, { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
    return includeStderr ? `${result.stdout}${result.stderr}` : result.stdout;
  } catch (error) {
    throw new Error(`${command} inspection failed`, { cause: error });
  }
}

function assertPackagedFuseWire(wire) {
  const expected = AUDITED_ELECTRON_FUSE_WIRE.states;
  const actual = expected.map((_value, index) => wire[index]);
  if (wire.version !== "1" || JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Packaged Electron fuse state changed: ${JSON.stringify(normalizeFuseWire(wire))}`);
  }
}

function normalizeFuseWire(wire) {
  return Object.fromEntries(
    Object.entries(wire)
      .filter(([key]) => key === "version" || /^\d+$/.test(key))
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

if (pathToFileURL(process.argv[1] ?? "").href === import.meta.url) {
  await inspectDesktopPackage();
}
