import { copyFile, mkdir, readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, relative, resolve } from "node:path";

import { repositoryRoot, sha256, writeJson } from "./repository.mjs";

export const AUDITED_STUDIO_MCP = Object.freeze({
  version: "2.22.5",
  entry: Object.freeze({
    relative: "dist/index.js",
    bytes: 622_265,
    sha256: "b4558aef4a299c4253b982ad2da88e8944de7cf59a192c485857cc390623a10f",
  }),
  baseplate: Object.freeze({
    relative: "dist/assets/Baseplate.rbxl",
    bytes: 60_225,
    sha256: "9e576d8eac106d53be6b56a484c528b928f39725170f990c3a0387e86a8dd546",
  }),
  plugin: Object.freeze({
    relative: "studio-plugin/MCPPlugin.rbxmx",
    bytes: 5_396_699,
    sha256: "57f16e4e89f4e60d327fa76c89fc44e85a16d8a7051579d38ec0ee7501cad09c",
  }),
  license: Object.freeze({
    relative: "licenses/chrrxs-robloxstudio-mcp-LICENSE.txt",
    bytes: 1_055,
    sha256: "3bed3331b7048bac17cf50e249d560ccc9508c970da8d7b9283bf4f2e633a91d",
  }),
});

export async function resolveAuditedStudioMcp(packageJsonPath) {
  const requireFromPackage = createRequire(resolve(packageJsonPath));
  const studioMcpRoot = dirname(dirname(requireFromPackage.resolve("@chrrxs/robloxstudio-mcp")));
  const resolved = Object.freeze({
    entry: resolve(studioMcpRoot, AUDITED_STUDIO_MCP.entry.relative),
    baseplate: resolve(studioMcpRoot, AUDITED_STUDIO_MCP.baseplate.relative),
    plugin: resolve(studioMcpRoot, AUDITED_STUDIO_MCP.plugin.relative),
    license: resolve(repositoryRoot, AUDITED_STUDIO_MCP.license.relative),
  });
  await auditStudioMcp(resolved);
  return resolved;
}

export async function auditStudioMcp(paths) {
  await Promise.all([
    assertPinnedFile(paths.entry, AUDITED_STUDIO_MCP.entry, "Studio MCP entry"),
    assertPinnedFile(paths.baseplate, AUDITED_STUDIO_MCP.baseplate, "Studio MCP Baseplate"),
    assertPinnedFile(paths.plugin, AUDITED_STUDIO_MCP.plugin, "Studio MCP plugin"),
    assertPinnedFile(paths.license, AUDITED_STUDIO_MCP.license, "Studio MCP audited license"),
  ]);
}

export async function bundleAuditedStudioMcp({
  packageJsonPath,
  outputRoot,
  metadataPath,
  target = "node20",
  inlineVersion = false,
}) {
  const packageRequire = createRequire(resolve(packageJsonPath));
  const { build, version: esbuildVersion } = packageRequire("esbuild");
  const upstream = await resolveAuditedStudioMcp(packageJsonPath);
  const auditedEntryPath = await realpath(upstream.entry);
  const entryOutput = resolve(outputRoot, "robloxstudio-mcp/index.mjs");
  const baseplateOutput = resolve(outputRoot, "robloxstudio-mcp/assets/Baseplate.rbxl");
  const pluginOutput = resolve(outputRoot, "studio-plugin/MCPPlugin.rbxmx");
  await Promise.all([
    mkdir(dirname(entryOutput), { recursive: true }),
    mkdir(dirname(baseplateOutput), { recursive: true }),
    mkdir(dirname(pluginOutput), { recursive: true }),
  ]);
  const result = await build({
    absWorkingDir: repositoryRoot,
    entryPoints: [upstream.entry],
    outfile: entryOutput,
    bundle: true,
    platform: "node",
    format: "esm",
    target,
    mainFields: ["module", "main"],
    plugins: inlineVersion
      ? [
          {
            name: "rbxforge-audited-studio-mcp-version",
            setup(context) {
              context.onLoad({ filter: /[/\\]@chrrxs[/\\]robloxstudio-mcp[/\\]dist[/\\]index\.js$/ }, async (args) => {
                if ((await realpath(args.path)) !== auditedEntryPath) return undefined;
                const source = await readFile(args.path, "utf8");
                const lookup =
                  'const require2 = createRequire(import.meta.url);\n  const { version: VERSION } = require2("../package.json");';
                if (source.split(lookup).length !== 2) {
                  throw new Error("Audited Studio MCP version lookup changed.");
                }
                return {
                  contents: source.replace(lookup, `const VERSION = ${JSON.stringify(AUDITED_STUDIO_MCP.version)};`),
                  loader: "js",
                  resolveDir: dirname(args.path),
                };
              });
            },
          },
        ]
      : [],
    banner: {
      js: 'import { createRequire as __rbxforgeCreateRequire } from "node:module"; const require = __rbxforgeCreateRequire(import.meta.url);',
    },
    sourcemap: false,
    sourcesContent: false,
    legalComments: "none",
    treeShaking: true,
    metafile: true,
    logLevel: "info",
  });
  await Promise.all([
    copyFile(upstream.baseplate, baseplateOutput),
    copyFile(upstream.plugin, pluginOutput),
    writeJson(metadataPath, result.metafile),
  ]);
  return Object.freeze({
    version: AUDITED_STUDIO_MCP.version,
    esbuildVersion,
    sources: upstream,
    files: Object.freeze(
      [entryOutput, baseplateOutput, pluginOutput]
        .map((path) => relative(outputRoot, path).split("\\").join("/"))
        .sort(),
    ),
  });
}

async function assertPinnedFile(path, expected, label) {
  const bytes = await readFile(path);
  const digest = sha256(bytes);
  if (bytes.length !== expected.bytes || digest !== expected.sha256) {
    throw new Error(
      `${label} byte count or SHA-256 drifted: expected ${expected.bytes} bytes/${expected.sha256}, got ${bytes.length} bytes/${digest}`,
    );
  }
}
