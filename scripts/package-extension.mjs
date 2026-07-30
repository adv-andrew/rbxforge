import { createRequire } from "node:module";
import { copyFile, lstat, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

import { generateThirdPartyNotices } from "./lib/notices.mjs";
import {
  artifactPath,
  artifactsRoot,
  ensureFile,
  extensionSourceRoot,
  generatedRoot,
  metadataRoot,
  outputPath,
  outputsRoot,
  repositoryRoot,
  runChecked,
  sha256,
  sha256File,
  stageRoot,
  writeJson,
} from "./lib/repository.mjs";
import { scanExtractedTree, scanWorktreeFiles } from "./lib/secrets.mjs";
import { AUDITED_STUDIO_MCP, bundleAuditedStudioMcp } from "./lib/studio-mcp-vendor.mjs";
import { inspectVsix, normalizeVsixPaths } from "./lib/vsix.mjs";

await recreateStaging();
const sourceManifest = JSON.parse(await readFile(resolve(extensionSourceRoot, "package.json"), "utf8"));
assertSourceManifest(sourceManifest);

await runChecked(process.execPath, [resolve(repositoryRoot, "scripts/generate-icon.mjs")]);
await runChecked(process.execPath, [
  resolve(repositoryRoot, "scripts/build-extension.mjs"),
  `--out=${relative(repositoryRoot, resolve(stageRoot, "dist/extension.js"))}`,
  `--metafile=${relative(repositoryRoot, resolve(metadataRoot, "extension.json"))}`,
]);

const webviewOutput = resolve(extensionSourceRoot, "media/webview");
await rm(webviewOutput, { recursive: true, force: true });
const viteRequire = createRequire(resolve(repositoryRoot, "packages/webview-ui/package.json"));
const viteCli = resolve(dirname(dirname(dirname(viteRequire.resolve("vite")))), "bin/vite.js");
await runChecked(process.execPath, [viteCli, "build"], {
  cwd: resolve(repositoryRoot, "packages/webview-ui"),
});
for (const name of ["webview.js", "webview.css", ".bundle-inventory.json"]) {
  await ensureFile(resolve(webviewOutput, name), `fresh Vite output ${name}`);
}

const studioBundle = await bundleAuditedStudioMcp({
  packageJsonPath: resolve(extensionSourceRoot, "package.json"),
  outputRoot: resolve(stageRoot, "vendor"),
  metadataPath: resolve(metadataRoot, "studio-mcp.json"),
  target: "node20",
  inlineVersion: false,
});

await Promise.all([
  copyInto(resolve(extensionSourceRoot, "media/rbxforge.svg"), resolve(stageRoot, "media/rbxforge.svg")),
  copyInto(resolve(extensionSourceRoot, "media/rbxforge.png"), resolve(stageRoot, "media/rbxforge.png")),
  copyInto(resolve(webviewOutput, "webview.js"), resolve(stageRoot, "media/webview/webview.js")),
  copyInto(resolve(webviewOutput, "webview.css"), resolve(stageRoot, "media/webview/webview.css")),
  copyInto(resolve(extensionSourceRoot, "LICENSE"), resolve(stageRoot, "LICENSE")),
]);
const rootReadme = await readFile(resolve(repositoryRoot, "README.md"), "utf8");
const packagedReadme = rootReadme
  .replace("[architecture](docs/architecture.md)", "architecture documentation in the source repository")
  .replace(
    "[manual Studio verification checklist](docs/manual-studio-verification.md)",
    "manual Studio verification checklist in the source repository",
  );
if (packagedReadme.includes("](docs/")) throw new Error("Packaged README retains a source-only relative docs link");
await writeFile(resolve(stageRoot, "README.md"), packagedReadme, "utf8");
await writeJson(resolve(stageRoot, "vendor/package.json"), {
  name: "@chrrxs/robloxstudio-mcp",
  version: studioBundle.version,
  private: true,
  type: "module",
  license: "MIT",
});

const notices = await generateThirdPartyNotices({
  bundles: [
    { name: "extension-host", metafilePath: resolve(metadataRoot, "extension.json") },
    { name: "studio-mcp", metafilePath: resolve(metadataRoot, "studio-mcp.json") },
    { name: "webview", viteInventoryPath: resolve(webviewOutput, ".bundle-inventory.json") },
  ],
  requiredPackages: ["@chrrxs/robloxstudio-mcp", "@modelcontextprotocol/sdk", "openai", "react", "zod"],
});
await writeFile(resolve(stageRoot, "THIRD_PARTY_NOTICES"), notices.text, "utf8");
await writeJson(resolve(metadataRoot, "third-party-packages.json"), notices.packages);
await writeJson(resolve(stageRoot, "package.json"), stagedManifest(sourceManifest));
await assertStagingAllowlist(sourceManifest.files);

await runChecked(process.execPath, [
  resolve(repositoryRoot, "scripts/smoke-packaged-extension.mjs"),
  relative(repositoryRoot, stageRoot),
]);

const requireFromRoot = createRequire(resolve(repositoryRoot, "package.json"));
const vsceEntry = requireFromRoot.resolve("@vscode/vsce/vsce");
await rm(artifactPath, { force: true });
await runChecked(
  process.execPath,
  [vsceEntry, "package", "--out", artifactPath, "--no-dependencies", "--allow-missing-repository"],
  { cwd: stageRoot },
);
await ensureFile(artifactPath, "packaged VSIX");
await normalizeVsixPaths(artifactPath);

const extractedRoot = resolve(generatedRoot, "extracted-vsix");
const inspection = await inspectVsix(artifactPath, { extractTo: extractedRoot });
const sourceFilesScanned = await scanWorktreeFiles();
const extractedFilesScanned = await scanExtractedTree(extractedRoot);
const artifactInfo = await stat(artifactPath);
const artifactSha256 = await sha256File(artifactPath);
const entrySnapshot = inspection.entries.map(({ path, sha256: entrySha256 }) => ({
  path,
  sha256: entrySha256,
}));
const baselinePath = resolve(artifactsRoot, ".rbxforge-entry-hashes.json");
let deterministicComparison = "baseline-created";
try {
  const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
  if (JSON.stringify(baseline) !== JSON.stringify(entrySnapshot)) {
    throw new Error("VSIX entry paths or per-entry SHA-256 values changed between package builds");
  }
  deterministicComparison = "matched-previous-build";
} catch (error) {
  if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
}
await writeJson(baselinePath, entrySnapshot);
const report = {
  versions: {
    node: process.version,
    pnpm: "11.9.0",
    vsce: "3.9.2",
    esbuild: studioBundle.esbuildVersion,
    studioMcp: AUDITED_STUDIO_MCP.version,
  },
  auditedInputs: AUDITED_STUDIO_MCP,
  notices: {
    bytes: Buffer.byteLength(notices.text),
    sha256: sha256(Buffer.from(notices.text)),
    packages: notices.packages,
  },
  scan: {
    sourceFiles: sourceFilesScanned,
    extractedFiles: extractedFilesScanned,
  },
  artifact: {
    path: relative(repositoryRoot, artifactPath),
    bytes: artifactInfo.size,
    sha256: artifactSha256,
    deterministicComparison,
  },
  entries: inspection.entries,
};
await writeJson(resolve(artifactsRoot, "rbxforge-0.1.0.report.json"), report);
await mkdir(outputsRoot, { recursive: true });
await copyFile(artifactPath, outputPath);
console.log(JSON.stringify(report, undefined, 2));

async function recreateStaging() {
  if (!generatedRoot.startsWith(`${repositoryRoot}/`) || generatedRoot === repositoryRoot) {
    throw new Error(`Refusing to recreate unsafe staging path: ${generatedRoot}`);
  }
  await rm(generatedRoot, { recursive: true, force: true });
  await mkdir(stageRoot, { recursive: true });
  await mkdir(metadataRoot, { recursive: true });
  await mkdir(artifactsRoot, { recursive: true });
}

function assertSourceManifest(manifest) {
  if (
    manifest.name !== "rbxforge" ||
    manifest.version !== "0.1.0" ||
    manifest.publisher !== "rbxforge" ||
    manifest.engines?.vscode !== "^1.100.0" ||
    manifest.license !== "UNLICENSED"
  ) {
    throw new Error("Source extension manifest does not match the pinned package identity");
  }
  if (!Array.isArray(manifest.files) || manifest.files.length !== 12) {
    throw new Error("Source extension manifest must use the exact fail-closed files whitelist");
  }
}

function stagedManifest(source) {
  const result = { ...source };
  delete result.private;
  delete result.scripts;
  delete result.dependencies;
  delete result.devDependencies;
  return result;
}

async function copyInto(source, destination) {
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
}

async function assertStagingAllowlist(files) {
  const expected = new Set(["package.json", ...files]);
  const actual = new Set(await walkRelative(stageRoot));
  const missing = [...expected].filter((path) => !actual.has(path));
  const unexpected = [...actual].filter((path) => !expected.has(path));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `Staging allowlist mismatch; missing=[${missing.join(", ")}] unexpected=[${unexpected.join(", ")}]`,
    );
  }
}

async function walkRelative(root, current = root) {
  const result = [];
  for (const name of await readdir(current)) {
    const path = resolve(current, name);
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error(`Staging must not contain symlink: ${relative(root, path)}`);
    if (info.isDirectory()) result.push(...(await walkRelative(root, path)));
    else if (info.isFile()) result.push(relative(root, path).split("\\").join("/"));
    else throw new Error(`Unsupported staging entry: ${relative(root, path)}`);
  }
  return result.sort((left, right) => left.localeCompare(right));
}
