import { describe, expect, it } from "vitest";
import { FakeProcessHandle, FakeProcessRunner } from "./fake-process-runner.js";

describe("FakeProcessRunner", () => {
  it("records an immutable timeout-aware spec and returns only configured children", async () => {
    const child = new FakeProcessHandle();
    const runner = new FakeProcessRunner({ startedHandles: [child] });
    const args = ["serve", "game.project.json"];

    expect(await runner.start({ command: "/opt/rojo", args, shell: false, timeoutMs: 8_000 })).toBe(child);
    args.push("--mutated");

    expect(runner.calls).toEqual([
      { command: "/opt/rojo", args: ["serve", "game.project.json"], shell: false, timeoutMs: 8_000 },
    ]);
    await expect(runner.start({ command: "/opt/rojo", args: [], shell: false })).rejects.toThrow(
      "more children than configured",
    );
  });

  it("counts stops while allowing a supplied exit result", async () => {
    const handle = new FakeProcessHandle({ exitResult: { exitCode: 7, stdout: "out", stderr: "err" } });

    await handle.stop();

    expect(handle.stopCalls).toBe(1);
    await expect(handle.exited()).resolves.toEqual({ exitCode: 7, stdout: "out", stderr: "err" });
  });
});
