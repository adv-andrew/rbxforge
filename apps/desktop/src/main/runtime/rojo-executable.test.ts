import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProcessHandle, ProcessResult, ProcessRunner, ProcessSpec } from "@rbxforge/rojo";
import { afterEach, describe, expect, it } from "vitest";
import { RojoExecutableResolver } from "./rojo-executable.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

class RecordingRunner implements ProcessRunner {
  readonly runCalls: ProcessSpec[] = [];

  constructor(
    private readonly resultFor: (spec: ProcessSpec) => ProcessResult | Promise<ProcessResult> = () => ({
      exitCode: 0,
      stdout: "Rojo 7.8.0",
      stderr: "",
    }),
  ) {}

  run(spec: ProcessSpec): Promise<ProcessResult> {
    this.runCalls.push(spec);
    return Promise.resolve(this.resultFor(spec));
  }

  start(_spec: ProcessSpec): Promise<ProcessHandle> {
    return Promise.reject(new Error("start is not used by executable resolution"));
  }
}

describe("RojoExecutableResolver", () => {
  it("uses the first regular executable in the exact search order that reports a supported version", async () => {
    const runner = new RecordingRunner((spec) =>
      spec.command === "/chosen/rojo"
        ? { exitCode: 0, stdout: "Rojo 7.6.1", stderr: "" }
        : { exitCode: 0, stdout: "Rojo 7.8.0", stderr: "" },
    );
    const resolver = new RojoExecutableResolver({
      runner,
      envPath: "/tools:/usr/bin",
      homeDirectory: "/Users/andy",
      isExecutableFile: async (path) => path === "/chosen/rojo" || path === "/tools/rojo",
    });

    await expect(resolver.resolve("/chosen/rojo")).resolves.toEqual({
      path: "/tools/rojo",
      version: "7.8.0",
      source: "path",
    });
    expect(runner.runCalls.map((call) => call.command)).toEqual(["/chosen/rojo", "/tools/rojo"]);
    expect(
      runner.runCalls.every(
        (call) =>
          call.args.length === 1 && call.args[0] === "--version" && call.timeoutMs === 3_000 && call.shell === false,
      ),
    ).toBe(true);
  });

  it("ignores empty and relative PATH entries and falls back through rokit then aftman", async () => {
    const runner = new RecordingRunner((spec) => ({
      exitCode: 0,
      stdout: spec.command.endsWith("/.aftman/bin/rojo") ? "Rojo 7.7.0" : "Rojo 7.6.9",
      stderr: "",
    }));
    const resolver = new RojoExecutableResolver({
      runner,
      envPath: ":relative:/tools::/tools",
      homeDirectory: "/Users/andy",
      isExecutableFile: async (path) =>
        path === "/tools/rojo" || path === "/Users/andy/.rokit/bin/rojo" || path === "/Users/andy/.aftman/bin/rojo",
    });

    await expect(resolver.resolve()).resolves.toEqual({
      path: "/Users/andy/.aftman/bin/rojo",
      version: "7.7.0",
      source: "aftman",
    });
    expect(runner.runCalls.map((call) => call.command)).toEqual([
      "/tools/rojo",
      "/Users/andy/.rokit/bin/rojo",
      "/Users/andy/.aftman/bin/rojo",
    ]);
  });

  it("rejects symlinks, directories, and files without execute permission", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rbxforge-rojo-resolver-"));
    temporaryDirectories.push(directory);
    const configuredTarget = join(directory, "configured-target");
    const configuredLink = join(directory, "configured-link");
    const pathDirectory = join(directory, "path");
    const homeDirectory = join(directory, "home");
    const rokitExecutable = join(homeDirectory, ".rokit", "bin", "rojo");
    const aftmanExecutable = join(homeDirectory, ".aftman", "bin", "rojo");
    await writeFile(configuredTarget, "#!/bin/sh\n");
    await chmod(configuredTarget, 0o755);
    await symlink(configuredTarget, configuredLink);
    await mkdir(join(pathDirectory, "rojo"), { recursive: true });
    await mkdir(join(homeDirectory, ".rokit", "bin"), { recursive: true });
    await writeFile(rokitExecutable, "#!/bin/sh\n");
    await chmod(rokitExecutable, 0o644);
    await mkdir(join(homeDirectory, ".aftman", "bin"), { recursive: true });
    await writeFile(aftmanExecutable, "#!/bin/sh\n");
    await chmod(aftmanExecutable, 0o755);
    const runner = new RecordingRunner();
    const resolver = new RojoExecutableResolver({
      runner,
      envPath: `${pathDirectory}:relative:`,
      homeDirectory,
    });

    await expect(resolver.resolve(configuredLink)).resolves.toEqual({
      path: await realpath(aftmanExecutable),
      version: "7.8.0",
      source: "aftman",
    });
    expect(runner.runCalls.map((call) => call.command)).toEqual([await realpath(aftmanExecutable)]);
  });

  it("canonically deduplicates candidate paths before probing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rbxforge-rojo-dedupe-"));
    temporaryDirectories.push(directory);
    const toolDirectory = join(directory, "tools");
    const executable = join(toolDirectory, "rojo");
    await mkdir(toolDirectory);
    await writeFile(executable, "#!/bin/sh\n");
    await chmod(executable, 0o755);
    const runner = new RecordingRunner(() => ({ exitCode: 0, stdout: "Rojo 7.8.0", stderr: "" }));
    const resolver = new RojoExecutableResolver({
      runner,
      envPath: `${toolDirectory}:${join(toolDirectory, "..", "tools")}`,
      homeDirectory: join(directory, "missing-home"),
    });

    await expect(resolver.resolve()).resolves.toMatchObject({ path: await realpath(executable), source: "path" });
    expect(runner.runCalls).toHaveLength(1);
  });

  it.each([
    ["nonzero exit", { exitCode: 1, stdout: "Rojo 7.8.0", stderr: "failed" }],
    ["malformed output", { exitCode: 0, stdout: "Rojo seven", stderr: "" }],
    ["multiple version tokens", { exitCode: 0, stdout: "Rojo 7.8.0 protocol 7.9.0", stderr: "" }],
    ["7.6.x", { exitCode: 0, stdout: "Rojo 7.6.9", stderr: "" }],
    ["8.x", { exitCode: 0, stdout: "Rojo 8.0.0", stderr: "" }],
    ["a prerelease", { exitCode: 0, stdout: "Rojo 7.8.0-beta.1", stderr: "" }],
    ["a semantic version with leading zeroes", { exitCode: 0, stdout: "Rojo 07.8.0", stderr: "" }],
  ] as const)("rejects %s", async (_label, result) => {
    const runner = new RecordingRunner(() => result);
    const resolver = new RojoExecutableResolver({
      runner,
      envPath: "",
      homeDirectory: "/missing",
      isExecutableFile: async (path) => path === "/chosen/rojo",
    });

    await expect(resolver.resolve("/chosen/rojo")).rejects.toThrow(/supported Rojo executable/i);
  });

  it("rejects a version probe timeout and does not try to execute any relative candidate", async () => {
    const runner = new RecordingRunner(() => Promise.reject(new Error("process timed out")));
    const resolver = new RojoExecutableResolver({
      runner,
      envPath: "relative:",
      homeDirectory: "relative-home",
      isExecutableFile: async (path) => path === "/chosen/rojo",
    });

    await expect(resolver.resolve("/chosen/rojo")).rejects.toThrow(/supported Rojo executable/i);
    expect(runner.runCalls.map((call) => call.command)).toEqual(["/chosen/rojo"]);
  });
});
