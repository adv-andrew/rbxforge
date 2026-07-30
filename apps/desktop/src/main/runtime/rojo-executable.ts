import { constants } from "node:fs";
import { access, lstat, realpath } from "node:fs/promises";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import type { ProcessRunner } from "@rbxforge/rojo";

export type RojoExecutableSource = "configured" | "path" | "rokit" | "aftman" | "homebrew" | "usr-local";

export interface ResolvedRojoExecutable {
  readonly path: string;
  readonly version: string;
  readonly source: RojoExecutableSource;
}

export interface RojoExecutableResolverOptions {
  readonly runner: Pick<ProcessRunner, "run">;
  readonly envPath?: string;
  readonly homeDirectory?: string;
  readonly isExecutableFile?: (path: string) => Promise<boolean>;
}

interface Candidate {
  readonly path: string;
  readonly source: RojoExecutableSource;
}

export class RojoExecutableResolver {
  readonly #runner: Pick<ProcessRunner, "run">;
  readonly #envPath: string;
  readonly #homeDirectory: string;
  readonly #inspectCandidate: (path: string) => Promise<string | undefined>;

  constructor(options: RojoExecutableResolverOptions) {
    this.#runner = options.runner;
    this.#envPath = options.envPath ?? process.env.PATH ?? "";
    this.#homeDirectory = options.homeDirectory ?? process.env.HOME ?? "";
    this.#inspectCandidate =
      options.isExecutableFile === undefined
        ? inspectExecutableFile
        : async (path) => ((await options.isExecutableFile?.(path)) === true ? resolve(path) : undefined);
  }

  async resolve(configuredPath?: string): Promise<ResolvedRojoExecutable> {
    const seen = new Set<string>();
    for (const candidate of this.candidates(configuredPath)) {
      let canonicalPath: string | undefined;
      try {
        canonicalPath = await this.#inspectCandidate(candidate.path);
      } catch {
        canonicalPath = undefined;
      }
      if (canonicalPath === undefined || !isAbsolute(canonicalPath) || seen.has(canonicalPath)) continue;
      seen.add(canonicalPath);

      try {
        const result = await this.#runner.run({
          command: canonicalPath,
          args: ["--version"],
          shell: false,
          timeoutMs: 3_000,
        });
        if (result.exitCode !== 0) continue;
        const version = parseSupportedVersion(`${result.stdout}\n${result.stderr}`);
        if (version === undefined) continue;
        return Object.freeze({ path: canonicalPath, version, source: candidate.source });
      } catch {
        // A failed or timed-out probe makes only this candidate unusable.
      }
    }
    throw new Error("No supported Rojo executable was found. Choose an executable reporting >=7.7.0 <8.0.0.");
  }

  private candidates(configuredPath: string | undefined): readonly Candidate[] {
    const candidates: Candidate[] = [];
    if (configuredPath !== undefined && isAbsolute(configuredPath)) {
      candidates.push({ path: resolve(configuredPath), source: "configured" });
    }
    for (const entry of this.#envPath.split(delimiter)) {
      if (entry.length > 0 && isAbsolute(entry)) candidates.push({ path: join(entry, "rojo"), source: "path" });
    }
    if (isAbsolute(this.#homeDirectory)) {
      candidates.push(
        { path: join(this.#homeDirectory, ".rokit", "bin", "rojo"), source: "rokit" },
        { path: join(this.#homeDirectory, ".aftman", "bin", "rojo"), source: "aftman" },
      );
    }
    candidates.push(
      { path: "/opt/homebrew/bin/rojo", source: "homebrew" },
      { path: "/usr/local/bin/rojo", source: "usr-local" },
    );
    return candidates;
  }
}

async function inspectExecutableFile(path: string): Promise<string | undefined> {
  const initial = await lstat(path);
  if (initial.isSymbolicLink() || !initial.isFile()) return undefined;
  await access(path, constants.X_OK);
  const canonicalPath = await realpath(path);
  if (!isAbsolute(canonicalPath)) return undefined;
  const canonicalStat = await lstat(canonicalPath);
  if (canonicalStat.isSymbolicLink() || !canonicalStat.isFile()) return undefined;
  return canonicalPath;
}

function parseSupportedVersion(output: string): string | undefined {
  const matches = [
    ...output.matchAll(/(?<![0-9A-Za-z.+-])(\d+)\.(\d+)\.(\d+)([-+][0-9A-Za-z.-]+)?(?![0-9A-Za-z.+-])/g),
  ];
  if (matches.length !== 1) return undefined;
  const match = matches[0];
  if (match === undefined || match[4] !== undefined) return undefined;
  if ([match[1], match[2], match[3]].some((part) => part !== "0" && part?.startsWith("0"))) return undefined;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) return undefined;
  if (major !== 7 || minor < 7) return undefined;
  return `${major}.${minor}.${patch}`;
}
