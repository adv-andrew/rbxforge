import { describe, expect, it } from "vitest";
import { FakeProcessRunner } from "@rbxforge/test-fixtures";
import { createSyncbackController } from "./syncback-preview.js";

describe("guarded syncback", () => {
  it("rejects unsupported input types before a process is started", async () => {
    const runner = new FakeProcessRunner();
    const controller = createSyncbackController({
      runner,
      now: () => 0,
      createId: () => "preview-1",
      fingerprint: async () => "same",
      dirtyPaths: async () => [],
    });

    await expect(
      controller.previewSyncback({ projectPath: "/repo/game.project.json", inputPath: "/repo/game.json" }),
    ).rejects.toThrow("Syncback input must be a .rbxl, .rbxlx, .rbxm, or .rbxmx file");
    expect(runner.calls).toEqual([]);
  });

  it("previews with exact non-mutating argv and only parses anchored write/remove lines", async () => {
    const runner = new FakeProcessRunner({
      runResults: [
        {
          exitCode: 0,
          stdout:
            "Writing /repo/src/New.server.lua\nRemoving /repo/src/Old.server.lua\nnot Writing /repo/src/ignored.lua\n",
          stderr: "preview detail",
        },
      ],
    });
    const controller = createSyncbackController({
      runner,
      now: () => 0,
      createId: () => "preview-1",
      fingerprint: async () => "same",
      dirtyPaths: async () => [],
    });

    const preview = await controller.previewSyncback({
      projectPath: "/repo/game.project.json",
      inputPath: "/repo/game.rbxlx",
    });

    expect(runner.calls[0]).toEqual({
      command: "rojo",
      shell: false,
      args: [
        "--color",
        "never",
        "syncback",
        "/repo/game.project.json",
        "--input",
        "/repo/game.rbxlx",
        "--list",
        "--dry-run",
      ],
    });
    expect(preview).toMatchObject({
      id: "preview-1",
      approvable: true,
      additionsOrChanges: ["/repo/src/New.server.lua"],
      removals: ["/repo/src/Old.server.lua"],
    });
    expect(runner.calls[0]?.args).not.toContain("--non-interactive");
  });

  it("blocks approval and consumes approval if freshness checks fail before apply", async () => {
    const runner = new FakeProcessRunner({
      runResults: [
        {
          exitCode: 0,
          stdout: "Writing /repo/src/Changed.lua\n",
          stderr: "",
        },
      ],
    });
    let dirty = false;
    const fingerprints = new Map<string, string>([
      ["/repo/game.project.json", "project-v1"],
      ["/repo/game.rbxl", "input-v1"],
      ["/repo/src/Changed.lua", "source-v1"],
    ]);
    const controller = createSyncbackController({
      runner,
      now: () => 0,
      createId: () => "preview-1",
      fingerprint: async (path) => fingerprints.get(path) ?? "missing",
      dirtyPaths: async () => (dirty ? ["/repo/src/Changed.lua"] : []),
    });
    await controller.previewSyncback({ projectPath: "/repo/game.project.json", inputPath: "/repo/game.rbxl" });
    await controller.approveSyncback("preview-1");
    dirty = true;

    await expect(controller.applyApprovedSyncback("preview-1")).rejects.toThrow(
      "Syncback preview overlaps dirty paths",
    );
    dirty = false;
    await expect(controller.applyApprovedSyncback("preview-1")).rejects.toThrow("Syncback preview is not approved");
    expect(runner.calls).toHaveLength(1);
  });

  it("resolves printed relative paths before detecting dirty directory overlap at approval", async () => {
    const runner = new FakeProcessRunner({ runResults: [{ exitCode: 0, stdout: "Writing src/x.lua\n", stderr: "" }] });
    let dirty = false;
    const controller = createSyncbackController({
      runner,
      now: () => 0,
      createId: () => "preview-relative",
      fingerprint: async () => "same",
      dirtyPaths: async () => (dirty ? ["/repo/src"] : []),
    });
    const preview = await controller.previewSyncback({
      projectPath: "/repo/default.project.json",
      inputPath: "/repo/game.rbxl",
    });
    expect(preview.additionsOrChanges).toEqual(["/repo/src/x.lua"]);
    dirty = true;
    await expect(controller.approveSyncback("preview-relative")).rejects.toThrow(
      "Syncback preview overlaps dirty paths",
    );
  });

  it("applies exactly once after approval with fresh fingerprints and mutating argv", async () => {
    const runner = new FakeProcessRunner({
      runResults: [
        { exitCode: 0, stdout: "Writing /repo/src/Changed.lua\n", stderr: "" },
        { exitCode: 0, stdout: "Writing /repo/src/Changed.lua\n", stderr: "applied" },
      ],
    });
    const controller = createSyncbackController({
      runner,
      now: () => 100,
      createId: () => "preview-1",
      fingerprint: async () => "same",
      dirtyPaths: async () => [],
    });
    await controller.previewSyncback({ projectPath: "/repo/game.project.json", inputPath: "/repo/game.rbxmx" });
    await controller.approveSyncback("preview-1");

    const result = await controller.applyApprovedSyncback("preview-1");

    expect(runner.calls[1]).toEqual({
      command: "rojo",
      shell: false,
      args: [
        "--color",
        "never",
        "syncback",
        "/repo/game.project.json",
        "--input",
        "/repo/game.rbxmx",
        "--list",
        "--non-interactive",
      ],
    });
    expect(runner.calls[1]?.args).not.toContain("--dry-run");
    expect(result).toMatchObject({ ok: true, changedPaths: ["/repo/src/Changed.lua"], stderr: "applied" });
    await expect(controller.applyApprovedSyncback("preview-1")).rejects.toThrow("Syncback preview is not approved");
  });

  it("allows exactly 256 operations but fails closed on the 257th", async () => {
    const lines = Array.from({ length: 256 }, (_, index) => `Writing /repo/src/${index}.lua`).join("\n");
    const runner = new FakeProcessRunner({
      runResults: [
        { exitCode: 0, stdout: `${lines}\n\nnot an operation`, stderr: "" },
        { exitCode: 0, stdout: `${lines}\nWriting /repo/src/overflow.lua`, stderr: "" },
      ],
    });
    const controller = createSyncbackController({
      runner,
      now: () => 0,
      createId: (() => {
        let id = 0;
        return () => `p-${id++}`;
      })(),
      fingerprint: async () => "same",
      dirtyPaths: async () => [],
    });
    const exact = await controller.previewSyncback({
      projectPath: "/repo/game.project.json",
      inputPath: "/repo/game.rbxl",
    });
    const overflow = await controller.previewSyncback({
      projectPath: "/repo/game.project.json",
      inputPath: "/repo/game.rbxl",
    });
    expect(exact.approvable).toBe(true);
    expect(exact.additionsOrChanges).toHaveLength(256);
    expect(overflow).toMatchObject({ approvable: false, safetyReason: "operation-limit-exceeded" });
    await expect(controller.approveSyncback("p-1")).rejects.toThrow("operation-limit-exceeded");
  });
});
