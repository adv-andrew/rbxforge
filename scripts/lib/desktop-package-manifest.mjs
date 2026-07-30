import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir, readlink } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";

import { containsDesktopFixtureLaunchArgument, isTestOnlyDesktopPath } from "./desktop-fixture-boundary.mjs";
import { AUDITED_ELECTRON_FUSE_WIRE, createCanonicalMachOCodeEvidence } from "./macho-code-digest.mjs";

export const DESKTOP_PACKAGE_MANIFEST_FILE = "package-manifest.json";

export const AUDITED_ELECTRON_PACKAGE = Object.freeze({
  version: "43.2.0",
  sourceEvidenceSha256: "ae88f97339ee47a3f3102e89574ac6015802c1dce71dad411a7b606b067eaf11",
});

const REMOVED_ELECTRON_FILES = new Set(["Resources/default_app.asar", "Resources/electron.icns"]);
const MUTABLE_ELECTRON_PLISTS = new Set([
  "Info.plist",
  "Frameworks/Electron Helper.app/Contents/Info.plist",
  "Frameworks/Electron Helper (GPU).app/Contents/Info.plist",
  "Frameworks/Electron Helper (Plugin).app/Contents/Info.plist",
  "Frameworks/Electron Helper (Renderer).app/Contents/Info.plist",
]);
const MUTABLE_ELECTRON_BINARIES = new Set([
  "MacOS/Electron",
  "Frameworks/Electron Framework.framework/Versions/A/Electron Framework",
  "Frameworks/Electron Helper.app/Contents/MacOS/Electron Helper",
  "Frameworks/Electron Helper (GPU).app/Contents/MacOS/Electron Helper (GPU)",
  "Frameworks/Electron Helper (Plugin).app/Contents/MacOS/Electron Helper (Plugin)",
  "Frameworks/Electron Helper (Renderer).app/Contents/MacOS/Electron Helper (Renderer)",
  "Frameworks/Mantle.framework/Versions/A/Mantle",
  "Frameworks/ReactiveObjC.framework/Versions/A/ReactiveObjC",
  "Frameworks/Squirrel.framework/Versions/A/Squirrel",
]);
const FUSED_ELECTRON_BINARY = "Frameworks/Electron Framework.framework/Versions/A/Electron Framework";
const SIGNED_BUNDLE_ROOTS = [
  "",
  "Frameworks/Electron Framework.framework/Versions/A",
  "Frameworks/Mantle.framework/Versions/A",
  "Frameworks/RbxForge Helper.app/Contents",
  "Frameworks/RbxForge Helper (GPU).app/Contents",
  "Frameworks/RbxForge Helper (Plugin).app/Contents",
  "Frameworks/RbxForge Helper (Renderer).app/Contents",
  "Frameworks/ReactiveObjC.framework/Versions/A",
  "Frameworks/Squirrel.framework/Versions/A",
];
const CURATED_RESOURCE_DIRECTORIES = [
  "Resources/app.asar.unpacked",
  "Resources/app.asar.unpacked/node_modules",
  "Resources/app.asar.unpacked/node_modules/better-sqlite3",
  "Resources/app.asar.unpacked/node_modules/better-sqlite3/prebuilds",
  "Resources/vendor",
  "Resources/vendor/robloxstudio-mcp",
  "Resources/vendor/robloxstudio-mcp/assets",
  "Resources/vendor/studio-plugin",
];
const TEXT_EXTENSIONS = new Set([".cjs", ".css", ".html", ".js", ".json", ".mjs", ".plist", ".svg"]);
const FORBIDDEN_PATH =
  /(?:^|\/)(?:fixtures?|tests?|__tests__)(?:\/|$)|(?:^|\/)\.env(?:\.|$)|credential|secret|auth[-_]?token|\.(?:ts|tsx|map)$/i;
const CREDENTIAL_ASSIGNMENT =
  /(?:AUTH_TOKEN|API_KEY|ACCESS_TOKEN|CLIENT_SECRET|CREDENTIALS?)[\s"'`]*[:=]\s*["'`][A-Za-z0-9_./+=-]{10,}["'`]/i;

export async function createElectronSourceEvidence(contentsRoot) {
  const rootInfo = await lstat(contentsRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error("Electron source evidence requires a regular Contents directory.");
  }
  const entries = await collectBundleEntries(contentsRoot, { hashAllFiles: true });
  const contentsMode = rootInfo.mode & 0o7777;
  return Object.freeze({
    sha256: manifestDigest({ contentsMode, entries }),
    contentsMode,
    entries: Object.freeze(entries),
  });
}

export async function createDesktopPackageManifest({
  electronContentsRoot,
  expectedElectronSourceSha256 = AUDITED_ELECTRON_PACKAGE.sourceEvidenceSha256,
  iconPath,
  sqliteNativePath,
  vendorRoot,
}) {
  if (!/^[a-f0-9]{64}$/.test(expectedElectronSourceSha256)) {
    throw new Error("Desktop package manifest requires a pinned Electron source evidence SHA-256.");
  }
  const sourceEvidence = await createElectronSourceEvidence(electronContentsRoot);
  if (sourceEvidence.sha256 !== expectedElectronSourceSha256) {
    throw new Error(
      `Electron source evidence changed: expected ${expectedElectronSourceSha256}, got ${sourceEvidence.sha256}`,
    );
  }
  await assertNoForbiddenBundleData(electronContentsRoot, sourceEvidence.entries);

  const entries = [];
  for (const sourceEntry of sourceEvidence.entries) {
    if (sourceEntry.type === "file" && REMOVED_ELECTRON_FILES.has(sourceEntry.path)) continue;
    const path = normalizeElectronPath(sourceEntry.path);
    if (sourceEntry.type === "file") {
      const verification = MUTABLE_ELECTRON_PLISTS.has(sourceEntry.path)
        ? "plist"
        : MUTABLE_ELECTRON_BINARIES.has(sourceEntry.path)
          ? "mach-o"
          : "exact";
      const codeEvidence =
        verification === "mach-o"
          ? await createCanonicalMachOCodeEvidence(resolve(electronContentsRoot, sourceEntry.path), {
              expectedFuseWire: sourceEntry.path === FUSED_ELECTRON_BINARY ? AUDITED_ELECTRON_FUSE_WIRE : undefined,
            })
          : undefined;
      entries.push(retainedFileEntry({ ...sourceEntry, path }, verification, codeEvidence));
    } else if (sourceEntry.type === "symlink") {
      entries.push(Object.freeze({ path, type: "symlink", target: sourceEntry.target, mode: sourceEntry.mode }));
    } else {
      entries.push(Object.freeze({ path, type: "directory", mode: sourceEntry.mode }));
    }
  }

  for (const root of SIGNED_BUNDLE_ROOTS) {
    const signatureRoot = root === "" ? "_CodeSignature" : `${root}/_CodeSignature`;
    entries.push(Object.freeze({ path: signatureRoot, type: "directory", mode: 0o755 }));
    entries.push(
      Object.freeze({
        path: `${signatureRoot}/CodeResources`,
        type: "file",
        verification: "signed",
        mode: 0o644,
      }),
    );
  }
  for (const path of CURATED_RESOURCE_DIRECTORIES) {
    entries.push(Object.freeze({ path, type: "directory", mode: 0o755 }));
  }
  entries.push(
    Object.freeze({
      path: "Resources/app.asar",
      type: "file",
      verification: "asar",
      mode: 0o644,
    }),
  );
  for (const [path, source] of [
    ["Resources/icon.icns", iconPath],
    ["Resources/app.asar.unpacked/node_modules/better-sqlite3/prebuilds/darwin-arm64.node", sqliteNativePath],
    ["Resources/vendor/robloxstudio-mcp/index.mjs", resolve(vendorRoot, "robloxstudio-mcp/index.mjs")],
    [
      "Resources/vendor/robloxstudio-mcp/assets/Baseplate.rbxl",
      resolve(vendorRoot, "robloxstudio-mcp/assets/Baseplate.rbxl"),
    ],
    ["Resources/vendor/studio-plugin/MCPPlugin.rbxmx", resolve(vendorRoot, "studio-plugin/MCPPlugin.rbxmx")],
  ]) {
    entries.push(await exactFileEntry(path, source));
  }

  return parseDesktopPackageManifest({
    schemaVersion: 2,
    electronVersion: AUDITED_ELECTRON_PACKAGE.version,
    electronSourceSha256: sourceEvidence.sha256,
    contentsMode: sourceEvidence.contentsMode,
    entries: sortEntries(entries),
  });
}

export async function createRetainedBundleManifest(
  contentsRoot,
  { electronVersion, sourceEvidenceSha256, verificationForPath = () => "exact" },
) {
  const entries = await collectBundleEntries(contentsRoot, { hashAllFiles: true });
  const retainedEntries = [];
  for (const entry of entries) {
    if (entry.type !== "file") {
      retainedEntries.push(entry);
      continue;
    }
    const verification = verificationForPath(entry.path);
    const codeEvidence =
      verification === "mach-o" ? await createCanonicalMachOCodeEvidence(resolve(contentsRoot, entry.path)) : undefined;
    retainedEntries.push(retainedFileEntry(entry, verification, codeEvidence));
  }
  return parseDesktopPackageManifest({
    schemaVersion: 2,
    electronVersion,
    electronSourceSha256: sourceEvidenceSha256,
    contentsMode: (await lstat(contentsRoot)).mode & 0o7777,
    entries: retainedEntries,
  });
}

export function parseDesktopPackageManifest(value) {
  const parsed = typeof value === "string" || Buffer.isBuffer(value) ? JSON.parse(value.toString("utf8")) : value;
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    parsed.schemaVersion !== 2 ||
    typeof parsed.electronVersion !== "string" ||
    !/^\d+\.\d+\.\d+$/.test(parsed.electronVersion) ||
    typeof parsed.electronSourceSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(parsed.electronSourceSha256) ||
    !isExactMode(parsed.contentsMode) ||
    !Array.isArray(parsed.entries)
  ) {
    throw new Error("Desktop package manifest schema is invalid.");
  }
  const entries = parsed.entries.map(parseManifestEntry);
  const paths = entries.map(({ path }) => path);
  if (
    paths.length === 0 ||
    new Set(paths).size !== paths.length ||
    JSON.stringify(paths) !== JSON.stringify([...paths].sort((left, right) => left.localeCompare(right)))
  ) {
    throw new Error("Desktop package manifest paths must be non-empty, unique, and sorted.");
  }
  return Object.freeze({
    schemaVersion: 2,
    electronVersion: parsed.electronVersion,
    electronSourceSha256: parsed.electronSourceSha256,
    contentsMode: parsed.contentsMode,
    entries: Object.freeze(entries),
  });
}

export function formatDesktopPackageManifest(manifest) {
  return `${JSON.stringify(parseDesktopPackageManifest(manifest), undefined, 2)}\n`;
}

export async function assertDesktopBundleMatchesManifest(
  contentsRoot,
  expectedValue,
  {
    expectedElectronVersion = AUDITED_ELECTRON_PACKAGE.version,
    expectedElectronSourceSha256 = AUDITED_ELECTRON_PACKAGE.sourceEvidenceSha256,
    trustedManifest,
  } = {},
) {
  if (trustedManifest === undefined) {
    throw new Error("Desktop bundle inspection requires an independently derived trusted manifest.");
  }
  const evidence = parseDesktopPackageManifest(expectedValue);
  const expected = parseDesktopPackageManifest(trustedManifest);
  if (JSON.stringify(evidence) !== JSON.stringify(expected)) {
    throw new Error("Desktop package manifest evidence mismatch against independently derived inputs.");
  }
  if (
    expected.electronVersion !== expectedElectronVersion ||
    expected.electronSourceSha256 !== expectedElectronSourceSha256
  ) {
    throw new Error(
      "Desktop package manifest retained Electron evidence mismatch: " +
        `expected ${expectedElectronVersion}/${expectedElectronSourceSha256}, ` +
        `got ${expected.electronVersion}/${expected.electronSourceSha256}`,
    );
  }
  const contentsMode = (await lstat(contentsRoot)).mode & 0o7777;
  if (contentsMode !== expected.contentsMode) {
    throw new Error("Desktop bundle inventory mismatch; missing=[] unexpected=[] type=[] mode=[<root>]");
  }
  const expectedByPath = new Map(expected.entries.map((entry) => [entry.path, entry]));
  const actual = await collectBundleEntries(contentsRoot, {
    shouldHashFile: (path) => expectedByPath.get(path)?.verification === "exact",
  });
  assertEntryInventory(expected.entries, actual, "Desktop bundle inventory mismatch");

  const changed = [];
  const changedMachO = [];
  for (const actualEntry of actual) {
    const expectedEntry = expectedByPath.get(actualEntry.path);
    if (
      actualEntry.type === "file" &&
      expectedEntry?.type === "file" &&
      expectedEntry.verification === "exact" &&
      (actualEntry.bytes !== expectedEntry.bytes || actualEntry.sha256 !== expectedEntry.sha256)
    ) {
      changed.push(actualEntry.path);
    }
    if (actualEntry.type === "file" && expectedEntry?.type === "file" && expectedEntry.verification === "mach-o") {
      let evidence;
      try {
        evidence = await createCanonicalMachOCodeEvidence(resolve(contentsRoot, actualEntry.path));
      } catch (error) {
        throw new Error(`Mach-O code inspection failed for ${actualEntry.path}`, { cause: error });
      }
      if (evidence.codeBytes !== expectedEntry.codeBytes || evidence.codeSha256 !== expectedEntry.codeSha256) {
        changedMachO.push(actualEntry.path);
      }
    }
  }
  if (changed.length > 0) {
    throw new Error(`Desktop bundle digest mismatch; changed=[${changed.join(", ")}]`);
  }
  if (changedMachO.length > 0) {
    throw new Error(`Desktop bundle Mach-O code digest mismatch; changed=[${changedMachO.join(", ")}]`);
  }
  await assertNoForbiddenBundleData(contentsRoot, actual);
  return Object.freeze({
    entries: actual.length,
    directories: actual.filter(({ type }) => type === "directory").length,
    files: actual.filter(({ type }) => type === "file").length,
    symlinks: actual.filter(({ type }) => type === "symlink").length,
    exactFiles: expected.entries.filter(({ type, verification }) => type === "file" && verification === "exact").length,
    machOFiles: expected.entries.filter(({ type, verification }) => type === "file" && verification === "mach-o")
      .length,
    manifestSha256: manifestDigest(expected),
  });
}

export async function assertDesktopBundlesByteIdentical(expectedRoot, actualRoot) {
  const [expectedRootInfo, actualRootInfo] = await Promise.all([lstat(expectedRoot), lstat(actualRoot)]);
  if ((expectedRootInfo.mode & 0o7777) !== (actualRootInfo.mode & 0o7777)) {
    throw new Error("Desktop bundle byte comparison failed; missing=[] unexpected=[] type=[] mode=[<root>]");
  }
  const [expected, actual] = await Promise.all([
    collectBundleEntries(expectedRoot, { hashAllFiles: true }),
    collectBundleEntries(actualRoot, { hashAllFiles: true }),
  ]);
  assertEntryInventory(expected, actual, "Desktop bundle byte comparison failed");
  const expectedByPath = new Map(expected.map((entry) => [entry.path, entry]));
  const changed = actual
    .filter((entry) => {
      const wanted = expectedByPath.get(entry.path);
      return (
        entry.type === "file" &&
        wanted?.type === "file" &&
        (entry.bytes !== wanted.bytes || entry.sha256 !== wanted.sha256)
      );
    })
    .map(({ path }) => path);
  if (changed.length > 0) {
    throw new Error(`Desktop bundle byte comparison failed; changed=[${changed.join(", ")}]`);
  }
  return Object.freeze({ entries: actual.length, files: actual.filter(({ type }) => type === "file").length });
}

function parseManifestEntry(entry) {
  if (
    entry === null ||
    typeof entry !== "object" ||
    Array.isArray(entry) ||
    typeof entry.path !== "string" ||
    !isSafeRelativePath(entry.path)
  ) {
    throw new Error("Desktop package manifest entry is invalid.");
  }
  if (entry.type === "directory") {
    if (!isExactMode(entry.mode)) {
      throw new Error("Desktop package manifest directory mode is invalid.");
    }
    return Object.freeze({ path: entry.path, type: "directory", mode: entry.mode });
  }
  if (entry.type === "symlink") {
    if (
      typeof entry.target !== "string" ||
      entry.target.length === 0 ||
      entry.target.includes("\0") ||
      !isExactMode(entry.mode)
    ) {
      throw new Error("Desktop package manifest symlink entry is invalid.");
    }
    return Object.freeze({ path: entry.path, type: "symlink", target: entry.target, mode: entry.mode });
  }
  if (
    entry.type !== "file" ||
    !new Set(["asar", "exact", "mach-o", "plist", "signed"]).has(entry.verification) ||
    !isExactMode(entry.mode)
  ) {
    throw new Error("Desktop package manifest file entry is invalid.");
  }
  if (entry.verification === "exact") {
    if (
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes < 0 ||
      typeof entry.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(entry.sha256)
    ) {
      throw new Error("Desktop package manifest exact-file entry is invalid.");
    }
    return Object.freeze({
      path: entry.path,
      type: "file",
      verification: "exact",
      mode: entry.mode,
      bytes: entry.bytes,
      sha256: entry.sha256,
    });
  }
  if (entry.verification === "mach-o") {
    if (
      (entry.mode & 0o111) === 0 ||
      !Number.isSafeInteger(entry.codeBytes) ||
      entry.codeBytes <= 0 ||
      typeof entry.codeSha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(entry.codeSha256)
    ) {
      throw new Error("Desktop package manifest Mach-O entry is invalid.");
    }
    return Object.freeze({
      path: entry.path,
      type: "file",
      verification: "mach-o",
      mode: entry.mode,
      codeBytes: entry.codeBytes,
      codeSha256: entry.codeSha256,
    });
  }
  if (entry.verification === "signed" && (entry.mode & 0o111) !== 0) {
    throw new Error("Desktop package manifest cannot delegate executable content authority to signing.");
  }
  return Object.freeze({
    path: entry.path,
    type: "file",
    verification: entry.verification,
    mode: entry.mode,
  });
}

async function collectBundleEntries(root, { hashAllFiles = false, shouldHashFile = () => false } = {}, current = root) {
  const entries = [];
  for (const name of (await readdir(current)).sort((left, right) => left.localeCompare(right))) {
    const absolutePath = resolve(current, name);
    const info = await lstat(absolutePath);
    const path = relative(root, absolutePath).split("\\").join("/");
    const mode = info.mode & 0o7777;
    if (info.isSymbolicLink()) {
      entries.push(Object.freeze({ path, type: "symlink", target: await readlink(absolutePath), mode }));
    } else if (info.isDirectory()) {
      entries.push(Object.freeze({ path, type: "directory", mode }));
      entries.push(...(await collectBundleEntries(root, { hashAllFiles, shouldHashFile }, absolutePath)));
    } else if (info.isFile()) {
      const entry = {
        path,
        type: "file",
        mode,
        bytes: info.size,
      };
      if (hashAllFiles || shouldHashFile(path)) entry.sha256 = await sha256File(absolutePath);
      entries.push(Object.freeze(entry));
    } else {
      throw new Error(`Desktop bundle inventory rejects non-regular entry: ${path}`);
    }
  }
  return sortEntries(entries);
}

function assertEntryInventory(expectedEntries, actualEntries, label) {
  const expectedByPath = new Map(expectedEntries.map((entry) => [entry.path, entry]));
  const actualByPath = new Map(actualEntries.map((entry) => [entry.path, entry]));
  const missing = expectedEntries.filter(({ path }) => !actualByPath.has(path)).map(({ path }) => path);
  const unexpected = actualEntries.filter(({ path }) => !expectedByPath.has(path)).map(({ path }) => path);
  const type = actualEntries
    .filter((entry) => {
      const expected = expectedByPath.get(entry.path);
      return (
        expected !== undefined &&
        (expected.type !== entry.type ||
          (expected.type === "symlink" && entry.type === "symlink" && expected.target !== entry.target))
      );
    })
    .map(({ path }) => path);
  const mode = actualEntries
    .filter((entry) => {
      const expected = expectedByPath.get(entry.path);
      return expected !== undefined && expected.type === entry.type && expected.mode !== entry.mode;
    })
    .map(({ path }) => path);
  if (missing.length > 0 || unexpected.length > 0 || type.length > 0 || mode.length > 0) {
    throw new Error(
      `${label}; missing=[${missing.join(", ")}] unexpected=[${unexpected.join(", ")}] ` +
        `type=[${type.join(", ")}] mode=[${mode.join(", ")}]`,
    );
  }
}

async function assertNoForbiddenBundleData(root, entries) {
  const forbiddenPaths = entries
    .filter(({ path }) => FORBIDDEN_PATH.test(path) || isTestOnlyDesktopPath(path))
    .map(({ path }) => path);
  if (forbiddenPaths.length > 0) {
    throw new Error(`Desktop bundle contains forbidden path names: ${forbiddenPaths.join(", ")}`);
  }
  for (const { path, type } of entries) {
    if (type !== "file" || !TEXT_EXTENSIONS.has(extname(path).toLowerCase())) continue;
    const source = await readFile(resolve(root, path), "utf8");
    if (source.includes(root) || source.includes(resolve(root, "..")) || source.includes(process.cwd())) {
      throw new Error(`Desktop bundle contains a workspace absolute path in ${path}`);
    }
    if (CREDENTIAL_ASSIGNMENT.test(source)) {
      throw new Error(`Desktop bundle contains forbidden credential content in ${path}`);
    }
    if (containsDesktopFixtureLaunchArgument(source)) {
      throw new Error(`Desktop bundle contains forbidden fixture launch content in ${path}`);
    }
  }
}

function retainedFileEntry(entry, verification, codeEvidence) {
  if (!new Set(["asar", "exact", "mach-o", "plist", "signed"]).has(verification)) {
    throw new Error(`Desktop package manifest has unknown verification policy for ${entry.path}: ${verification}`);
  }
  if (verification === "exact") {
    if (!Number.isSafeInteger(entry.bytes) || typeof entry.sha256 !== "string") {
      throw new Error(`Desktop package manifest exact evidence is incomplete for ${entry.path}`);
    }
    return Object.freeze({
      path: entry.path,
      type: "file",
      verification,
      mode: entry.mode,
      bytes: entry.bytes,
      sha256: entry.sha256,
    });
  }
  if (verification === "mach-o") {
    if (
      (entry.mode & 0o111) === 0 ||
      codeEvidence === undefined ||
      !Number.isSafeInteger(codeEvidence.codeBytes) ||
      typeof codeEvidence.codeSha256 !== "string"
    ) {
      throw new Error(`Desktop package manifest Mach-O evidence is incomplete for ${entry.path}`);
    }
    return Object.freeze({
      path: entry.path,
      type: "file",
      verification,
      mode: entry.mode,
      codeBytes: codeEvidence.codeBytes,
      codeSha256: codeEvidence.codeSha256,
    });
  }
  if (verification === "signed" && (entry.mode & 0o111) !== 0) {
    throw new Error(`Desktop package manifest cannot trust signing for executable content: ${entry.path}`);
  }
  return Object.freeze({
    path: entry.path,
    type: "file",
    verification,
    mode: entry.mode,
  });
}

async function exactFileEntry(path, source) {
  const info = await lstat(source);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`Desktop package evidence requires a regular source file for ${path}`);
  }
  return Object.freeze({
    path,
    type: "file",
    verification: "exact",
    mode: info.mode & 0o7777,
    bytes: info.size,
    sha256: await sha256File(source),
  });
}

function normalizeElectronPath(path) {
  if (path === "MacOS/Electron") return "MacOS/RbxForge";
  return path.replaceAll("Electron Helper", "RbxForge Helper");
}

function sortEntries(entries) {
  return [...entries].sort((left, right) => left.path.localeCompare(right.path));
}

function isSafeRelativePath(path) {
  return (
    path.length > 0 &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !path.includes("\0") &&
    path.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  );
}

function isExactMode(mode) {
  return Number.isInteger(mode) && mode >= 0 && mode <= 0o7777;
}

function manifestDigest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function sha256File(path) {
  const hash = createHash("sha256");
  await new Promise((resolveRead, rejectRead) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", rejectRead);
    stream.once("end", resolveRead);
  });
  return hash.digest("hex");
}
