import { describe, expect, test } from "vitest";

import { ProcessSupervisor } from "./process-supervisor.js";

const childProgram = [
  "const mode = process.argv[1];",
  "const secret = process.argv[2];",
  "console.error(`diagnostic ${secret}`);",
  "if (mode === 'error') throw new Error('startup failure');",
  "if (mode === 'exit') process.exit(7);",
  "if (mode === 'ignore') process.on('SIGTERM', () => {}); else process.on('SIGTERM', () => process.exit(0));",
  "if (mode === 'split') { process.stderr.write('running on '); setTimeout(() => process.stderr.write('stdio\\n'), 5); } else console.error('running on stdio');",
  "setInterval(() => {}, 1000);",
].join(" ");

function spec(mode: "ready" | "ignore" | "exit" | "error" | "split" = "ready") {
  return {
    command: process.execPath,
    args: ["-e", childProgram, mode, "replace-me"],
    readinessToken: "running on stdio",
    timeoutMs: 1_000,
    terminationTimeoutMs: 50,
    redact: ["replace-me"],
  };
}

describe("ProcessSupervisor", () => {
  test("starts one child after a readiness token emitted to stderr", async () => {
    const output: string[] = [];
    const supervisor = new ProcessSupervisor({ onDiagnostic: (line) => output.push(line) });

    await supervisor.start(spec());

    expect(supervisor.snapshot()).toMatchObject({ running: true, ready: true });
    expect(output.join("\n")).toContain("running on stdio");
    await supervisor.stop();
  });

  test("recognizes a readiness token split across stderr chunks", async () => {
    const supervisor = new ProcessSupervisor();

    await supervisor.start(spec("split"));

    expect(supervisor.snapshot()).toMatchObject({ running: true, ready: true });
    await supervisor.stop();
  });

  test("rejects duplicate starts", async () => {
    const supervisor = new ProcessSupervisor();
    await supervisor.start(spec());

    await expect(supervisor.start(spec())).rejects.toThrow("Process supervisor is already running");
    await supervisor.stop();
  });

  test("captures diagnostics while redacting configured secrets", async () => {
    const supervisor = new ProcessSupervisor();
    await supervisor.start(spec());

    expect(supervisor.snapshot().diagnostics.join("\n")).toContain("[REDACTED]");
    expect(supervisor.snapshot().diagnostics.join("\n")).not.toContain("replace-me");
    await supervisor.stop();
  });

  test("waits for a clean child exit when stopped", async () => {
    const supervisor = new ProcessSupervisor();
    await supervisor.start(spec());

    await supervisor.stop();

    expect(supervisor.snapshot()).toMatchObject({ running: false, ready: false });
  });

  test("forces termination after the configured timeout", async () => {
    const supervisor = new ProcessSupervisor();
    await supervisor.start(spec("ignore"));

    await supervisor.stop();

    expect(supervisor.snapshot().diagnostics.join("\n")).toContain("SIGKILL");
  });

  test("rejects a child startup error instead of waiting indefinitely", async () => {
    const supervisor = new ProcessSupervisor();

    await expect(supervisor.start({ ...spec("error"), command: "/not/a-real-rbxforge-command" })).rejects.toThrow();
    expect(supervisor.snapshot().running).toBe(false);
  });

  test("rejects a child that exits before readiness", async () => {
    const supervisor = new ProcessSupervisor();

    await expect(supervisor.start(spec("exit"))).rejects.toThrow("exited before readiness");
    expect(supervisor.snapshot().running).toBe(false);
  });
});
