import { rm } from "node:fs/promises";
import { resolve } from "node:path";

import { artifactsRoot, generatedRoot, repositoryRoot } from "./lib/repository.mjs";

const safeTargets = [
  generatedRoot,
  artifactsRoot,
  resolve(repositoryRoot, "apps/extension/dist"),
  resolve(repositoryRoot, "apps/extension/media/webview"),
  resolve(repositoryRoot, "apps/desktop/dist"),
  resolve(repositoryRoot, "apps/desktop/build"),
];
for (const target of safeTargets) {
  if (!target.startsWith(`${repositoryRoot}/`) || target === repositoryRoot) {
    throw new Error(`Refusing to clean unsafe path: ${target}`);
  }
  await rm(target, { recursive: true, force: true });
}
