import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, extname, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { containsDesktopFixtureLaunchArgument, isTestOnlyDesktopPath } from "./lib/desktop-fixture-boundary.mjs";
import { assertDesktopProductionGraph } from "./lib/desktop-production-graph.mjs";
import { generateThirdPartyNotices } from "./lib/notices.mjs";
import { generatedRoot, repositoryRoot, runChecked, sha256, writeJson } from "./lib/repository.mjs";
import { bundleAuditedStudioMcp } from "./lib/studio-mcp-vendor.mjs";
import {
  DESKTOP_RUNTIME_MANIFEST_FILE,
  createDesktopRuntimeManifest,
  formatDesktopRuntimeManifest,
} from "./lib/desktop-runtime-manifest.mjs";

const desktopRoot = resolve(repositoryRoot, "apps/desktop");
const desktopPackageJson = resolve(desktopRoot, "package.json");
const desktopDist = resolve(desktopRoot, "dist");
const desktopElectronTestResults = resolve(desktopRoot, "test-results/electron");
const desktopGeneratedRoot = resolve(generatedRoot, "desktop");
const metadataRoot = resolve(desktopGeneratedRoot, "metadata");

export function createBuildNonce() {
  return randomBytes(32).toString("base64url");
}

export function createDesktopBuildOptions(nonce) {
  assertNonce(nonce);
  const shared = {
    absWorkingDir: repositoryRoot,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node24",
    sourcemap: false,
    sourcesContent: false,
    legalComments: "none",
    treeShaking: true,
    metafile: true,
    logLevel: "info",
  };
  return Object.freeze({
    main: Object.freeze({
      ...shared,
      entryPoints: [resolve(desktopRoot, "src/main/production.ts")],
      outfile: resolve(desktopDist, "main/index.cjs"),
      external: ["electron", "better-sqlite3"],
      // jsonc-parser's CommonJS package entry is a UMD wrapper whose local
      // require calls are intentionally opaque to esbuild. Use its static ESM
      // entry so every parser module is retained in the standalone bundle.
      alias: {
        "jsonc-parser": resolve(desktopRoot, "node_modules/jsonc-parser/lib/esm/main.js"),
      },
      define: { __RBXFORGE_CSP_NONCE__: JSON.stringify(nonce) },
    }),
    preload: Object.freeze({
      ...shared,
      entryPoints: [resolve(desktopRoot, "src/preload/index.ts")],
      outfile: resolve(desktopDist, "preload/index.cjs"),
      external: ["electron"],
    }),
    fixture: Object.freeze({
      ...shared,
      entryPoints: [resolve(desktopRoot, "tests/electron/fixture-main.ts")],
      outfile: resolve(desktopElectronTestResults, "fixture-main.cjs"),
      external: ["electron", "better-sqlite3"],
      define: { __RBXFORGE_FIXTURE_STYLE_NONCE__: JSON.stringify(nonce) },
    }),
    viteEnvironment: Object.freeze({
      RBXFORGE_CSP_NONCE: nonce,
      RBXFORGE_RENDERER_INVENTORY: resolve(metadataRoot, "renderer.json"),
    }),
  });
}

export function assertPreloadMetafile(metafile) {
  for (const [outputPath, output] of Object.entries(metafile.outputs ?? {})) {
    for (const imported of output.imports ?? []) {
      if (imported.external === true && imported.path !== "electron") {
        throw new Error(`Desktop preload retains forbidden external ${imported.path} in ${outputPath}`);
      }
      if (/^(?:node:|fs(?:\/|$)|path(?:\/|$)|child_process$|net$|http$|https$)/.test(imported.path)) {
        throw new Error(`Desktop preload retains forbidden Node builtin ${imported.path} in ${outputPath}`);
      }
    }
  }
}

export async function assertDesktopBundleSecurity({ distRoot, repositoryRoot: root }) {
  const files = await walkFiles(distRoot);
  const maps = files.filter((path) => path.endsWith(".map"));
  if (maps.length > 0) throw new Error(`Desktop bundle source map files are forbidden: ${maps.join(", ")}`);
  const fixturePaths = files.filter(isTestOnlyDesktopPath);
  if (fixturePaths.length > 0) {
    throw new Error(`Desktop test fixture path is forbidden: ${fixturePaths.join(", ")}`);
  }
  const textExtensions = new Set([".cjs", ".mjs", ".js", ".css", ".html", ".json"]);
  for (const path of files) {
    const bytes = await readFile(resolve(distRoot, path));
    if (containsDesktopFixtureLaunchArgument(bytes)) {
      throw new Error(`Desktop fixture-argument detected in ${path}`);
    }
    if (!textExtensions.has(extname(path))) continue;
    const source = bytes.toString("utf8");
    for (const [label, pattern] of [
      ["fixture branch", /\bfixture(?:Mode|Data|Activation|[-_ ]?mode)?\b/i],
      ["VSCode runtime", /(?:from\s*|require\s*\(|import\s*\(|import\s+)["']vscode["']/i],
      ["OpenAI runtime", /(?:from\s*|require\s*\(|import\s*\(|import\s+)["']openai(?:\/[^"']*)?["']/i],
      ["auth token value", /(?:AUTH_TOKEN|API_KEY)\s*=\s*["'][A-Za-z0-9_-]{10,}["']/i],
      ["workspace absolute path", new RegExp(escapeRegExp(root), "i")],
    ]) {
      if (pattern.test(source)) throw new Error(`Desktop ${label} detected in ${path}`);
    }
    for (const match of source.matchAll(/\bhttps?:\/\/[^\s"'`)<>{}]+/gi)) {
      const endpoint = match[0].replace(/[;,]+$/, "");
      if (!isAllowedNetworkEndpoint(endpoint, path)) {
        throw new Error(`Desktop unexpected network endpoint detected in ${path}: ${endpoint}`);
      }
    }
  }
  return Object.freeze(files);
}

export async function buildDesktop() {
  const desktopRequire = createRequire(desktopPackageJson);
  const { build } = desktopRequire("esbuild");
  const nonce = createBuildNonce();
  const options = createDesktopBuildOptions(nonce);

  await recreateDesktopBuildDirectories();
  const tscEntry = desktopRequire.resolve("typescript/bin/tsc");
  await runChecked(process.execPath, [tscEntry, "-b", resolve(desktopRoot, "tsconfig.json")]);

  const [mainResult, preloadResult, fixtureResult] = await Promise.all([
    build(options.main),
    build(options.preload),
    build(options.fixture),
  ]);
  assertPreloadMetafile(preloadResult.metafile);
  await Promise.all([
    writeJson(resolve(metadataRoot, "main.json"), mainResult.metafile),
    writeJson(resolve(metadataRoot, "preload.json"), preloadResult.metafile),
    writeJson(resolve(metadataRoot, "fixture.json"), fixtureResult.metafile),
  ]);

  const viteEntry = resolve(dirname(desktopRequire.resolve("vite")), "../../bin/vite.js");
  await runChecked(process.execPath, [viteEntry, "build", "--config", resolve(desktopRoot, "vite.config.ts")], {
    cwd: desktopRoot,
    env: {
      ...process.env,
      ...options.viteEnvironment,
    },
  });
  const rendererInventory = JSON.parse(await readFile(resolve(metadataRoot, "renderer.json"), "utf8"));
  assertDesktopProductionGraph({
    main: mainResult.metafile,
    preload: preloadResult.metafile,
    renderer: rendererInventory,
  });

  const studioBundle = await bundleAuditedStudioMcp({
    packageJsonPath: desktopPackageJson,
    outputRoot: resolve(desktopDist, "vendor"),
    metadataPath: resolve(metadataRoot, "studio-mcp.json"),
    target: "node24",
    inlineVersion: true,
  });
  const betterSqlitePackageJson = desktopRequire.resolve("better-sqlite3/package.json");
  const betterSqlitePackageRoot = dirname(betterSqlitePackageJson);
  const notices = await generateThirdPartyNotices({
    bundles: [
      { name: "desktop-main", metafilePath: resolve(metadataRoot, "main.json") },
      { name: "desktop-renderer", viteInventoryPath: resolve(metadataRoot, "renderer.json") },
      { name: "studio-mcp", metafilePath: resolve(metadataRoot, "studio-mcp.json") },
    ],
    additionalPackageRoots: [betterSqlitePackageRoot],
    requiredPackages: ["@chrrxs/robloxstudio-mcp", "@modelcontextprotocol/sdk", "better-sqlite3", "react", "zod"],
  });
  await Promise.all([
    writeFile(resolve(desktopDist, "THIRD_PARTY_NOTICES"), notices.text, "utf8"),
    writeJson(resolve(metadataRoot, "third-party-packages.json"), notices.packages),
  ]);
  const runtimeManifest = await createDesktopRuntimeManifest(desktopDist);
  await writeFile(resolve(metadataRoot, DESKTOP_RUNTIME_MANIFEST_FILE), formatDesktopRuntimeManifest(runtimeManifest));
  const files = await assertDesktopBundleSecurity({ distRoot: desktopDist, repositoryRoot });
  const report = Object.freeze({
    nonceSha256: sha256(Buffer.from(nonce)),
    files,
    runtimeManifest,
    fixture: {
      output: relative(repositoryRoot, options.fixture.outfile).split("\\").join("/"),
      files: Object.keys(fixtureResult.metafile.outputs ?? {}).sort((left, right) => left.localeCompare(right)),
    },
    studioMcp: {
      version: studioBundle.version,
      esbuild: studioBundle.esbuildVersion,
      files: studioBundle.files,
    },
    notices: {
      bytes: Buffer.byteLength(notices.text),
      sha256: sha256(Buffer.from(notices.text)),
      packages: notices.packages,
    },
  });
  await writeJson(resolve(desktopGeneratedRoot, "build-report.json"), report);
  console.log(JSON.stringify(report, undefined, 2));
  return report;
}

async function recreateDesktopBuildDirectories() {
  for (const target of [desktopDist, desktopElectronTestResults, desktopGeneratedRoot]) {
    if (!target.startsWith(`${repositoryRoot}/`) || target === repositoryRoot) {
      throw new Error(`Refusing to recreate unsafe desktop build path: ${target}`);
    }
    await rm(target, { recursive: true, force: true });
  }
  await Promise.all([
    mkdir(desktopDist, { recursive: true }),
    mkdir(desktopElectronTestResults, { recursive: true }),
    mkdir(metadataRoot, { recursive: true }),
  ]);
}

async function walkFiles(root, current = root) {
  const files = [];
  for (const name of (await readdir(current)).sort((left, right) => left.localeCompare(right))) {
    const path = resolve(current, name);
    const info = await import("node:fs/promises").then(({ lstat }) => lstat(path));
    const display = relative(root, path).split("\\").join("/");
    if (isTestOnlyDesktopPath(display)) {
      throw new Error(`Desktop test fixture path is forbidden: ${display}`);
    }
    if (info.isSymbolicLink()) throw new Error(`Desktop build contains symlink: ${display}`);
    if (info.isDirectory()) files.push(...(await walkFiles(root, path)));
    else if (info.isFile()) files.push(display);
    else throw new Error(`Desktop build contains unsupported entry: ${display}`);
  }
  return files.sort((left, right) => left.localeCompare(right));
}

function assertNonce(nonce) {
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(nonce)) throw new Error("Desktop CSP nonce is invalid");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isAuditedStaticReference(endpoint) {
  if (endpoint.startsWith("http://[$")) return true;
  return [
    "http://json-schema.org/",
    "http://stackoverflow.com/questions/201323/",
    "http://tools.ietf.org/html/",
    "http://www.w3.org/",
    "https://gist.github.com/dperini/729294",
    "https://github.com/mafintosh/is-my-json-valid/",
    "https://github.com/miguelmota/is-base64",
    "https://github.com/modelcontextprotocol/modelcontextprotocol/",
    "https://mathiasbynens.be/demo/url-regex",
    "https://raw.githubusercontent.com/ajv-validator/ajv/master/lib/refs/data.json",
    "https://spec.openapis.org/oas/v3.0.0",
    "https://tools.ietf.org/html/",
    "https://www.safaribooksonline.com/library/view/regular-expressions-cookbook/",
  ].some((prefix) => endpoint.startsWith(prefix));
}

function isAllowedNetworkEndpoint(endpoint, path) {
  if (
    endpoint === "http://127.0.0.1" ||
    endpoint.startsWith("http://127.0.0.1:") ||
    isAuditedStaticReference(endpoint) ||
    /^https:\/\/react\.dev\/errors\//.test(endpoint)
  ) {
    return true;
  }
  if (!path.startsWith("vendor/robloxstudio-mcp/")) return false;
  if (endpoint === "http://localhost:$") return true;
  let origin;
  try {
    origin = new URL(endpoint.replace(/\$$/, "1")).origin;
  } catch {
    return false;
  }
  return new Set([
    "http://encoding.spec.whatwg.org",
    "http://en.wikipedia.org",
    "http://icu-project.org",
    "http://me.abelcheung.org",
    "http://moztw.org",
    "http://source.icu-project.org",
    "http://stackoverflow.com",
    "http://www.haible.de",
    "http://www.khngai.com",
    "http://www.ogcio.gov.hk",
    "http://www.unicode.org",
    "http://www8.plala.or.jp",
    "https://api.github.com",
    "https://apis.roblox.com",
    "https://bugzilla.mozilla.org",
    "https://create.roblox.com",
    "https://developer.mozilla.org",
    "https://dub.sh",
    "https://example.com",
    "https://git.io",
    "https://github.com",
    "https://itemconfiguration.roblox.com",
    "https://thumbnails.roblox.com",
    "https://users.roblox.com",
    "https://www.w3.org",
  ]).has(origin);
}

if (pathToFileURL(process.argv[1] ?? "").href === import.meta.url) {
  await buildDesktop();
}
