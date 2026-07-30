import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const extensionSourceRoot = resolve(repositoryRoot, "apps/extension");
export const generatedRoot = resolve(repositoryRoot, ".rbxforge-package");
export const stageRoot = resolve(generatedRoot, "extension");
export const metadataRoot = resolve(generatedRoot, "metadata");
export const artifactsRoot = resolve(repositoryRoot, "artifacts");
export const artifactPath = resolve(artifactsRoot, "rbxforge-0.1.0.vsix");
export const outputsRoot = resolve(repositoryRoot, "outputs");
export const outputPath = resolve(outputsRoot, "rbxforge-0.1.0.vsix");

export async function ensureFile(path, label = path) {
  try {
    await access(path);
  } catch (error) {
    throw new Error(`Missing ${label}: ${path}`, { cause: error });
  }
}

export async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, undefined, 2)}\n`, "utf8");
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function sha256File(path) {
  return sha256(await readFile(path));
}

export async function runChecked(command, args, options = {}) {
  await new Promise((resolveRun, rejectRun) => {
    let child;
    try {
      child = spawn(command, [...args], {
        cwd: options.cwd ?? repositoryRoot,
        env: options.env ?? process.env,
        shell: false,
        stdio: options.stdio ?? "inherit",
      });
    } catch (error) {
      rejectRun(new Error(`Could not start ${command}`, { cause: error }));
      return;
    }
    child.once("error", (error) => rejectRun(new Error(`Could not start ${command}`, { cause: error })));
    child.once("close", (code, signal) => {
      if (signal !== null) {
        rejectRun(new Error(`${command} terminated by signal ${signal}`));
      } else if (code === null) {
        rejectRun(new Error(`${command} terminated without an exit status`));
      } else if (code !== 0) {
        rejectRun(new Error(`${command} exited with status ${code}`));
      } else {
        resolveRun();
      }
    });
  });
}
