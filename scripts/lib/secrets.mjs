import { execFile } from "node:child_process";
import { lstat, readdir, readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { resolve, relative } from "node:path";

import { repositoryRoot } from "./repository.mjs";

const execFileAsync = promisify(execFile);
const detectors = Object.freeze([
  ["OpenAI API key", /\bsk-[A-Za-z0-9_-]{20,}\b/g],
  ["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g],
  ["Slack token", /\bxox[a-z]-[A-Za-z0-9-]{20,}\b/gi],
  ["AWS access key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ["PEM private key", new RegExp(["-----BEGIN ", "(?:RSA |EC |OPENSSH )?", "PRIVATE KEY-----"].join(""), "g")],
  ["embedded authorization header", /\bAuthorization\s*:\s*(?:Basic|Bearer)\s+[A-Za-z0-9+/=._-]{16,}\b/gi],
]);

export async function scanWorktreeFiles() {
  const { stdout } = await execFileAsync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: repositoryRoot,
    encoding: "buffer",
    maxBuffer: 32 * 1024 * 1024,
  });
  const paths = stdout.toString("utf8").split("\0").filter(Boolean);
  const existing = [];
  for (const path of paths.map((path) => resolve(repositoryRoot, path))) {
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink()) throw new Error(`Source scan rejects symlink: ${path}`);
      if (info.isFile()) existing.push(path);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  await scanPaths(existing, "worktree");
  return existing.length;
}

export async function scanExtractedTree(root) {
  const paths = await walk(root);
  await scanPaths(paths, "extracted");
  return paths.length;
}

export async function scanPaths(paths, scope) {
  const findings = [];
  for (const path of paths) {
    const displayPath = relative(repositoryRoot, path);
    if (
      /(?:^|\/)(?:\.env(?:\..*)?|\.npmrc|credentials)(?:\/|$)/i.test(displayPath) ||
      /(?:^|\/)\.rbxforge\/credentials(?:\/|$)/i.test(displayPath)
    ) {
      findings.push(`${scope}:${displayPath}: credential-bearing path`);
      continue;
    }
    const bytes = await readFile(path);
    const text = bytes.toString("utf8");
    for (const [label, detector] of detectors) {
      detector.lastIndex = 0;
      if (detector.test(text)) findings.push(`${scope}:${displayPath}: ${label}`);
    }
    if (scope === "extracted" && text.includes('"sourcesContent"')) {
      findings.push(`${scope}:${displayPath}: source-map sourcesContent`);
    }
  }
  if (findings.length > 0) {
    throw new Error(`Secret scan failed:\n${findings.join("\n")}`);
  }
}

async function walk(root) {
  const result = [];
  for (const name of await readdir(root)) {
    const path = resolve(root, name);
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error(`Secret scan rejects symlink: ${path}`);
    if (info.isDirectory()) result.push(...(await walk(path)));
    else if (info.isFile()) result.push(path);
  }
  return result;
}
