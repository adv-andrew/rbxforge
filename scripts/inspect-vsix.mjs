import { stat } from "node:fs/promises";
import { resolve } from "node:path";

import { generatedRoot, repositoryRoot, sha256File, writeJson } from "./lib/repository.mjs";
import { inspectVsix } from "./lib/vsix.mjs";

const requestedPath = process.argv[2];
if (requestedPath === undefined) throw new Error("Usage: node scripts/inspect-vsix.mjs <archive.vsix>");
const vsixPath = resolve(repositoryRoot, requestedPath);
const extractedPath = resolve(generatedRoot, "extracted-vsix");
const report = await inspectVsix(vsixPath, { extractTo: extractedPath });
const info = await stat(vsixPath);
const output = {
  archive: {
    path: vsixPath,
    bytes: info.size,
    sha256: await sha256File(vsixPath),
  },
  entries: report.entries,
};
await writeJson(resolve(generatedRoot, "last-inspection.json"), output);
console.log(JSON.stringify(output, undefined, 2));
