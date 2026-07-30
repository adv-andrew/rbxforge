import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { build } from "esbuild";

import { extensionSourceRoot, generatedRoot, repositoryRoot, writeJson } from "./lib/repository.mjs";

function argument(name, fallback) {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? fallback;
}

const outputPath = resolve(repositoryRoot, argument("out", "apps/extension/dist/extension.js"));
const metafilePath = resolve(repositoryRoot, argument("metafile", ".rbxforge-package/metadata/extension.json"));

await mkdir(dirname(outputPath), { recursive: true });
await mkdir(generatedRoot, { recursive: true });
const result = await build({
  absWorkingDir: repositoryRoot,
  entryPoints: [resolve(extensionSourceRoot, "src/extension.ts")],
  outfile: outputPath,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  mainFields: ["module", "main"],
  external: ["vscode"],
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
await writeJson(metafilePath, result.metafile);
