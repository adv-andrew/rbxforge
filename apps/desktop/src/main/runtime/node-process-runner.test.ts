import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeProcessRunner } from "./node-process-runner.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

describe("createNodeProcessRunner", () => {
  it("bounds both captured streams to 8,192 bytes while continuing to drain the child", async () => {
    const runner = createNodeProcessRunner();
    const result = await runner.run({
      command: process.execPath,
      args: [
        "-e",
        [
          'process.stdout.write("a".repeat(2_000_000) + "stdout-tail");',
          'process.stderr.write("b".repeat(2_000_000) + "stderr-tail");',
        ].join(""),
      ],
      shell: false,
      timeoutMs: 5_000,
    });

    expect(result.exitCode).toBe(0);
    expect(Buffer.byteLength(result.stdout)).toBe(8_192);
    expect(Buffer.byteLength(result.stderr)).toBe(8_192);
    expect(result.stdout).toMatch(/stdout-tail$/);
    expect(result.stderr).toMatch(/stderr-tail$/);
  });

  it("returns one shared exit promise and stops the retained child idempotently", async () => {
    const runner = createNodeProcessRunner({ terminationGraceMs: 50 });
    const handle = await runner.start({
      command: process.execPath,
      args: ["-e", "setInterval(() => undefined, 10_000)"],
      shell: false,
    });

    const firstExit = handle.exited();
    expect(handle.exited()).toBe(firstExit);
    await Promise.all([handle.stop(), handle.stop(), handle.stop()]);
    await expect(firstExit).resolves.toMatchObject({ exitCode: expect.any(Number) });
    expect(handle.exited()).toBe(firstExit);
  });

  it("times out with TERM followed by bounded KILL of only the retained child", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rbxforge-runner-"));
    temporaryDirectories.push(directory);
    const marker = join(directory, "term.txt");
    const runner = createNodeProcessRunner({ terminationGraceMs: 75 });

    const startedAt = Date.now();
    const result = await runner.run({
      command: process.execPath,
      args: [
        "-e",
        [
          'const fs = require("node:fs");',
          `process.on("SIGTERM", () => fs.writeFileSync(${JSON.stringify(marker)}, "term"));`,
          "setInterval(() => undefined, 10_000);",
        ].join(""),
      ],
      shell: false,
      timeoutMs: 300,
    });

    expect(result.exitCode).not.toBe(0);
    await expect(readFile(marker, "utf8")).resolves.toBe("term");
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it("rejects an invalid timeout before spawning a child", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rbxforge-runner-invalid-"));
    temporaryDirectories.push(directory);
    const marker = join(directory, "spawned.txt");
    const runner = createNodeProcessRunner();

    await expect(
      runner.run({
        command: process.execPath,
        args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "spawned")`],
        shell: false,
        timeoutMs: 0,
      }),
    ).rejects.toThrow(RangeError);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects stop within the post-KILL bound when an untouched descendant keeps stdio open", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rbxforge-runner-descendant-"));
    temporaryDirectories.push(directory);
    const readyMarker = join(directory, "ready.txt");
    const descendantMarker = join(directory, "descendant.txt");
    const runner = createNodeProcessRunner({ terminationGraceMs: 30, killGraceMs: 40 });
    const handle = await runner.start({
      command: process.execPath,
      args: [
        "-e",
        [
          'const fs = require("node:fs");',
          'const { spawn } = require("node:child_process");',
          'process.on("SIGTERM", () => undefined);',
          "spawn(process.execPath, [",
          '"-e",',
          JSON.stringify(
            `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(descendantMarker)}, "alive"), 350)`,
          ),
          '], { stdio: "inherit" });',
          `fs.writeFileSync(${JSON.stringify(readyMarker)}, "ready");`,
          "setInterval(() => undefined, 10_000);",
        ].join(""),
      ],
      shell: false,
    });
    await waitForFile(readyMarker);

    const startedAt = Date.now();
    await expect(handle.stop()).rejects.toThrow(/did not close after SIGKILL/i);
    expect(Date.now() - startedAt).toBeLessThan(250);
    await handle.exited();
    await expect(readFile(descendantMarker, "utf8")).resolves.toBe("alive");
  });
});

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      await readFile(path);
      return;
    } catch (error: unknown) {
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        (error as { readonly code?: string }).code !== "ENOENT"
      ) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`Timed out waiting for fixture file: ${path}`);
}
