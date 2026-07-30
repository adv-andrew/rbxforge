import { resolve } from "node:path";

import { generatedRoot, repositoryRoot } from "./lib/repository.mjs";
import { scanExtractedTree, scanWorktreeFiles } from "./lib/secrets.mjs";
import { inspectVsix } from "./lib/vsix.mjs";

const requestedPath = process.argv[2];
if (requestedPath === undefined) throw new Error("Usage: node scripts/scan-secrets.mjs <archive.vsix>");
const vsixPath = resolve(repositoryRoot, requestedPath);
const extractedPath = resolve(generatedRoot, "secret-scan-vsix");
await inspectVsix(vsixPath, { extractTo: extractedPath });
const source = await scanWorktreeFiles();
const extracted = await scanExtractedTree(extractedPath);
console.log(`Secret scan passed: ${source} tracked/non-ignored source files and ${extracted} extracted VSIX files.`);
