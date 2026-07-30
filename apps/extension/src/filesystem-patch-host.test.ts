import { createHash } from "node:crypto";
import { renameSync, symlinkSync } from "node:fs";
import { mkdtemp, realpath, rename, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { InMemoryApprovalBroker, RevisionedIgnorePolicy } from "@rbxforge/agent";
import { MutationJournal } from "@rbxforge/core";
import { describe, expect, test, vi } from "vitest";

import { FilesystemPatchHost, type FilesystemPatchSpec } from "./filesystem-patch-host.js";
import { FakeVsCode } from "./test/fake-vscode.js";

describe("FilesystemPatchHost", () => {
  test("prepares an existing-file-only native diff and applies after one bound approval", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "rbxforge-patch-")));
    const path = join(root, "main.lua");
    const before = "return false\n";
    await writeFile(path, before);
    const vscode = new FakeVsCode();
    vscode.documentSnapshots.set(path, snapshot(path, before, 3));
    const journal = new MutationJournal();
    const broker = new InMemoryApprovalBroker({ now: () => 100, randomId: ids("authorization-1") });
    const host = new FilesystemPatchHost({
      vscode,
      journal,
      approvalBroker: broker,
      workspaceRoot: async () => root,
      ignorePolicy: allowPolicy(),
      now: () => 100,
      randomId: ids("prepared-1", "prepared-1", "approval-1", "journal-1"),
    });

    const prepared = await host.prepare(spec("main.lua", before, 3, "true"), context());
    await host.preview(prepared.id);
    expect(vscode.diffs).toEqual([
      {
        leftPath: path,
        rightUri: "rbxforge-diff:/prepared-1/0",
        title: "RbxForge proposed edit: main.lua",
      },
    ]);
    expect(vscode.virtualProviders.get("rbxforge-diff")?.(vscode.diffs[0]!.rightUri)).toBe("return true\n");
    const approval = broker.request(prepared.proposal, new AbortController().signal);
    expect(
      broker.resolve({
        sessionId: "session-1",
        generation: 1,
        runId: "run-1",
        approvalId: "approval-1",
        decision: "approve",
      }),
    ).toBe(true);
    const decision = await approval;
    if (!decision.approved) throw new Error("Expected approval");
    const consume = vi.spyOn(broker, "consumeAuthorization");

    const receipt = await host.execute(prepared.id, decision.authorization, context());

    expect(receipt).toMatchObject({ ok: true, verification: "verified" });
    expect(consume).toHaveBeenCalledTimes(1);
    expect(vscode.appliedEdits).toHaveLength(1);
    expect(vscode.documentSnapshots.get(path)?.text).toBe("return true\n");
    expect(journal.entries()).toEqual([
      expect.objectContaining({
        operation: "file-edit",
        target: "main.lua",
        result: "applied",
        verification: "verified",
      }),
    ]);
    expect(JSON.stringify(journal.entries())).not.toContain(before);
    expect(vscode.virtualProviders.get("rbxforge-diff")?.(vscode.diffs[0]!.rightUri)).toBeUndefined();
    host.dispose();
  });

  test("rejects traversal, nonexistent targets, overlapping ranges and stale version/hash", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "rbxforge-patch-")));
    const path = join(root, "main.lua");
    const before = "abcdef";
    await writeFile(path, before);
    const vscode = new FakeVsCode();
    vscode.documentSnapshots.set(path, snapshot(path, before, 2));
    const host = new FilesystemPatchHost({
      vscode,
      journal: new MutationJournal(),
      approvalBroker: new InMemoryApprovalBroker({ now: () => 0 }),
      workspaceRoot: async () => root,
      ignorePolicy: allowPolicy(),
      now: () => 0,
    });

    await expect(host.prepare(spec("../escape.lua", before, 2, "x"), context())).rejects.toThrow("boundary");
    await expect(host.prepare(spec("missing.lua", before, 2, "x"), context())).rejects.toThrow("existing");
    await expect(
      host.prepare(
        {
          files: [
            {
              path: "main.lua",
              expectedVersion: 2,
              expectedSha256: sha(before),
              edits: [
                { range: range(0, 0, 0, 3), newText: "x" },
                { range: range(0, 2, 0, 4), newText: "y" },
              ],
            },
          ],
        },
        context(),
      ),
    ).rejects.toThrow("overlap");
    await expect(host.prepare(spec("main.lua", `${before}stale`, 2, "x"), context())).rejects.toThrow("hash");
    expect(vscode.appliedEdits).toHaveLength(0);
    host.dispose();
  });

  test("rejects an existing ignored target before reading or preparing a patch", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "rbxforge-patch-")));
    const path = join(root, "ignored.lua");
    const before = "return false\n";
    await writeFile(path, before);
    const vscode = new FakeVsCode();
    vscode.documentSnapshots.set(path, snapshot(path, before, 1));
    let reads = 0;
    let ignored = true;
    vscode.onDocumentSnapshot = () => {
      reads += 1;
    };
    const broker = new InMemoryApprovalBroker();
    const host = new FilesystemPatchHost({
      vscode,
      journal: new MutationJournal(),
      approvalBroker: broker,
      workspaceRoot: async () => root,
      ignorePolicy: allowPolicy((candidate) => ignored && candidate === path),
    });

    await expect(host.prepare(spec("ignored.lua", before, 1, "true"), context())).rejects.toThrow("ignored");
    expect(reads).toBe(0);
    expect(vscode.appliedEdits).toEqual([]);

    ignored = false;
    const prepared = await host.prepare(spec("ignored.lua", before, 1, "true"), context());
    const authorization = await approve(broker, prepared.proposal);
    ignored = true;
    await expect(host.execute(prepared.id, authorization, context())).rejects.toThrow("ignored before apply");
    expect(reads).toBe(1);
    expect(vscode.appliedEdits).toEqual([]);
    expect(broker.consumeAuthorization(authorization, prepared.proposal)).toBe(true);
    host.dispose();
  });

  test("rechecks document version and hash in the final aggregate gate without consuming approval", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "rbxforge-patch-")));
    const path = join(root, "main.lua");
    const before = "return false\n";
    await writeFile(path, before);
    const vscode = new FakeVsCode();
    vscode.documentSnapshots.set(path, snapshot(path, before, 1));
    let ignoreChecks = 0;
    const broker = new InMemoryApprovalBroker();
    const host = new FilesystemPatchHost({
      vscode,
      journal: new MutationJournal(),
      approvalBroker: broker,
      workspaceRoot: async () => root,
      ignorePolicy: allowPolicy(() => {
        ignoreChecks += 1;
        if (ignoreChecks === 3) {
          vscode.documentSnapshots.set(path, snapshot(path, `${before}--late-dirty`, 2));
        }
        return false;
      }),
    });
    const prepared = await host.prepare(spec("main.lua", before, 1, "true"), context());
    const authorization = await approve(broker, prepared.proposal);

    await expect(host.execute(prepared.id, authorization, context())).rejects.toThrow("changed before apply");

    expect(ignoreChecks).toBe(3);
    expect(vscode.appliedEdits).toEqual([]);
    expect(broker.consumeAuthorization(authorization, prepared.proposal)).toBe(true);
    host.dispose();
  });

  test("rechecks ignored state alongside the final snapshot without consuming approval", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "rbxforge-patch-")));
    const path = join(root, "main.lua");
    const before = "return false\n";
    await writeFile(path, before);
    const vscode = new FakeVsCode();
    vscode.documentSnapshots.set(path, snapshot(path, before, 1));
    let snapshotReads = 0;
    let ignored = false;
    vscode.onDocumentSnapshot = () => {
      snapshotReads += 1;
      if (snapshotReads === 3) ignored = true;
    };
    const broker = new InMemoryApprovalBroker();
    const host = new FilesystemPatchHost({
      vscode,
      journal: new MutationJournal(),
      approvalBroker: broker,
      workspaceRoot: async () => root,
      ignorePolicy: allowPolicy(async () => {
        await Promise.resolve();
        return ignored;
      }),
    });
    const prepared = await host.prepare(spec("main.lua", before, 1, "true"), context());
    const authorization = await approve(broker, prepared.proposal);

    await expect(host.execute(prepared.id, authorization, context())).rejects.toThrow("ignored before apply");

    expect(snapshotReads).toBe(3);
    expect(vscode.appliedEdits).toEqual([]);
    expect(broker.consumeAuthorization(authorization, prepared.proposal)).toBe(true);
    host.dispose();
  });

  test("rejects when ignore policy changes after its final result while the document snapshot is pending", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "rbxforge-patch-")));
    const path = join(root, "main.lua");
    const before = "return false\n";
    await writeFile(path, before);
    const vscode = new FakeVsCode();
    vscode.documentSnapshots.set(path, snapshot(path, before, 1));
    let ignored = false;
    let snapshotReads = 0;
    let entered!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    vscode.onDocumentSnapshot = async () => {
      snapshotReads += 1;
      if (snapshotReads === 3) {
        entered();
        await waiting;
      }
    };
    const broker = new InMemoryApprovalBroker();
    const consume = vi.spyOn(broker, "consumeAuthorization");
    const ignorePolicy = allowPolicy(async () => ignored);
    const host = new FilesystemPatchHost({
      vscode,
      journal: new MutationJournal(),
      approvalBroker: broker,
      workspaceRoot: async () => root,
      ignorePolicy,
    });
    const prepared = await host.prepare(spec("main.lua", before, 1, "true"), context());
    const authorization = await approve(broker, prepared.proposal);

    const executing = host.execute(prepared.id, authorization, context());
    await reached;
    ignored = true;
    ignorePolicy.invalidate();
    release();

    await expect(executing).rejects.toThrow("ignored before apply");
    expect(consume).toHaveBeenCalledTimes(0);
    expect(vscode.appliedEdits).toEqual([]);
    expect(broker.consumeAuthorization(authorization, prepared.proposal)).toBe(true);
    host.dispose();
  });

  test("binds every target to one policy revision and rejects invalidation during a later path check", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "rbxforge-patch-")));
    const firstPath = join(root, "first.lua");
    const secondPath = join(root, "second.lua");
    const before = "return false\n";
    await writeFile(firstPath, before);
    await writeFile(secondPath, before);
    const vscode = new FakeVsCode();
    vscode.documentSnapshots.set(firstPath, snapshot(firstPath, before, 1));
    vscode.documentSnapshots.set(secondPath, snapshot(secondPath, before, 1));
    const calls = new Map<string, number>();
    let entered!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const policy = allowPolicy(async (path) => {
      const count = (calls.get(path) ?? 0) + 1;
      calls.set(path, count);
      if (path === secondPath && count === 3) {
        entered();
        await waiting;
      }
      return false;
    });
    const broker = new InMemoryApprovalBroker();
    const host = new FilesystemPatchHost({
      vscode,
      journal: new MutationJournal(),
      approvalBroker: broker,
      workspaceRoot: async () => root,
      ignorePolicy: policy,
    });
    const prepared = await host.prepare(
      {
        files: [spec("first.lua", before, 1, "true").files[0]!, spec("second.lua", before, 1, "true").files[0]!],
      },
      context(),
    );
    const authorization = await approve(broker, prepared.proposal);
    const consume = vi.spyOn(broker, "consumeAuthorization");

    const executing = host.execute(prepared.id, authorization, context());
    await reached;
    policy.invalidate();
    release();

    await expect(executing).rejects.toThrow("ignored before apply");
    expect(consume).toHaveBeenCalledTimes(0);
    expect(vscode.appliedEdits).toEqual([]);
    expect(broker.consumeAuthorization(authorization, prepared.proposal)).toBe(true);
    host.dispose();
  });

  test("rechecks the same policy attestation at the facade boundary before authorization", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "rbxforge-patch-")));
    const path = join(root, "main.lua");
    const before = "return false\n";
    await writeFile(path, before);
    const vscode = new FakeVsCode();
    vscode.documentSnapshots.set(path, snapshot(path, before, 1));
    const policy = allowPolicy();
    const broker = new InMemoryApprovalBroker();
    const host = new FilesystemPatchHost({
      vscode,
      journal: new MutationJournal(),
      approvalBroker: broker,
      workspaceRoot: async () => root,
      ignorePolicy: policy,
    });
    const prepared = await host.prepare(spec("main.lua", before, 1, "true"), context());
    const authorization = await approve(broker, prepared.proposal);
    const consume = vi.spyOn(broker, "consumeAuthorization");
    vscode.onBeforeWorkspaceEditBoundary = () => policy.invalidate();

    await expect(host.execute(prepared.id, authorization, context())).rejects.toThrow("changed before apply");

    expect(consume).toHaveBeenCalledTimes(0);
    expect(vscode.appliedEdits).toEqual([]);
    expect(broker.consumeAuthorization(authorization, prepared.proposal)).toBe(true);
    host.dispose();
  });

  test("rejects a document changed at the facade submission boundary without consuming authorization", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "rbxforge-patch-")));
    const path = join(root, "main.lua");
    const before = "return false\n";
    await writeFile(path, before);
    const vscode = new FakeVsCode();
    vscode.documentSnapshots.set(path, snapshot(path, before, 1));
    const broker = new InMemoryApprovalBroker();
    const consume = vi.spyOn(broker, "consumeAuthorization");
    const host = new FilesystemPatchHost({
      vscode,
      journal: new MutationJournal(),
      approvalBroker: broker,
      workspaceRoot: async () => root,
      ignorePolicy: allowPolicy(),
    });
    const prepared = await host.prepare(spec("main.lua", before, 1, "true"), context());
    const authorization = await approve(broker, prepared.proposal);
    vscode.onBeforeWorkspaceEditBoundary = () => {
      vscode.documentSnapshots.set(path, snapshot(path, `${before}--boundary-change`, 2));
    };

    await expect(host.execute(prepared.id, authorization, context())).rejects.toThrow("changed before apply");

    expect(consume).toHaveBeenCalledTimes(0);
    expect(vscode.appliedEdits).toEqual([]);
    expect(broker.consumeAuthorization(authorization, prepared.proposal)).toBe(true);
    host.dispose();
  });

  test.each(["outside", "sensitive"] as const)(
    "rejects a target swapped to a %s symlink at the facade submission boundary without consuming authorization",
    async (swapKind) => {
      const root = await realpath(await mkdtemp(join(tmpdir(), "rbxforge-patch-")));
      const outside = await realpath(await mkdtemp(join(tmpdir(), "rbxforge-patch-outside-")));
      const path = join(root, "main.lua");
      const backup = join(root, "main.backup.lua");
      const target = swapKind === "outside" ? join(outside, "other.lua") : join(root, "secrets.json");
      const before = "return false\n";
      await writeFile(path, before);
      await writeFile(target, "return 'sentinel'\n");
      const vscode = new FakeVsCode();
      vscode.documentSnapshots.set(path, snapshot(path, before, 1));
      const broker = new InMemoryApprovalBroker();
      const consume = vi.spyOn(broker, "consumeAuthorization");
      const host = new FilesystemPatchHost({
        vscode,
        journal: new MutationJournal(),
        approvalBroker: broker,
        workspaceRoot: async () => root,
        ignorePolicy: allowPolicy(),
      });
      const prepared = await host.prepare(spec("main.lua", before, 1, "true"), context());
      const authorization = await approve(broker, prepared.proposal);
      vscode.onBeforeWorkspaceEditBoundary = () => {
        renameSync(path, backup);
        symlinkSync(target, path);
      };

      await expect(host.execute(prepared.id, authorization, context())).rejects.toThrow("changed before apply");

      expect(consume).toHaveBeenCalledTimes(0);
      expect(vscode.appliedEdits).toEqual([]);
      expect(broker.consumeAuthorization(authorization, prepared.proposal)).toBe(true);
      host.dispose();
    },
  );

  test("cancellation at the facade submission boundary consumes no authorization and applies no edit", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "rbxforge-patch-")));
    const path = join(root, "main.lua");
    const before = "return false\n";
    await writeFile(path, before);
    const vscode = new FakeVsCode();
    vscode.documentSnapshots.set(path, snapshot(path, before, 1));
    const broker = new InMemoryApprovalBroker();
    const consume = vi.spyOn(broker, "consumeAuthorization");
    const controller = new AbortController();
    const toolContext = { ...context(), signal: controller.signal };
    const host = new FilesystemPatchHost({
      vscode,
      journal: new MutationJournal(),
      approvalBroker: broker,
      workspaceRoot: async () => root,
      ignorePolicy: allowPolicy(),
    });
    const prepared = await host.prepare(spec("main.lua", before, 1, "true"), toolContext);
    const authorization = await approve(broker, prepared.proposal);
    vscode.onBeforeWorkspaceEditBoundary = () => controller.abort(new Error("Stop at boundary"));

    await expect(host.execute(prepared.id, authorization, toolContext)).rejects.toThrow("Stop at boundary");

    expect(consume).toHaveBeenCalledTimes(0);
    expect(vscode.appliedEdits).toEqual([]);
    expect(broker.consumeAuthorization(authorization, prepared.proposal)).toBe(true);
    host.dispose();
  });

  test("rejects sensitive requested and canonical filenames before preparing a patch", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "rbxforge-patch-")));
    const before = "return false\n";
    const safePath = join(root, "main.lua");
    await writeFile(safePath, before);
    await Promise.all([
      writeFile(join(root, "credentials.json"), before),
      writeFile(join(root, "secrets.json"), before),
      writeFile(join(root, "id_rsa.pub"), before),
    ]);
    await symlink(safePath, join(root, "credentials-link.json"));
    await symlink(join(root, "secrets.json"), join(root, "safe-link.lua"));
    const vscode = new FakeVsCode();
    for (const path of [
      safePath,
      join(root, "credentials.json"),
      join(root, "secrets.json"),
      join(root, "id_rsa.pub"),
    ]) {
      vscode.documentSnapshots.set(path, snapshot(path, before, 1));
    }
    const host = new FilesystemPatchHost({
      vscode,
      journal: new MutationJournal(),
      approvalBroker: new InMemoryApprovalBroker(),
      workspaceRoot: async () => root,
      ignorePolicy: allowPolicy(),
    });

    for (const path of ["credentials.json", "secrets.json", "id_rsa.pub", "credentials-link.json", "safe-link.lua"]) {
      await expect(host.prepare(spec(path, before, 1, "true"), context())).rejects.toThrow("sensitive");
    }
    expect(vscode.appliedEdits).toEqual([]);
    host.dispose();
  });

  test("revalidates canonical sensitivity after delayed preflight without consuming approval", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "rbxforge-patch-")));
    const path = join(root, "main.lua");
    const sensitivePath = join(root, "secrets.json");
    const before = "return false\n";
    await writeFile(path, before);
    const vscode = new FakeVsCode();
    vscode.documentSnapshots.set(path, snapshot(path, before, 1));
    const broker = new InMemoryApprovalBroker();
    const host = new FilesystemPatchHost({
      vscode,
      journal: new MutationJournal(),
      approvalBroker: broker,
      workspaceRoot: async () => root,
      ignorePolicy: allowPolicy(),
    });
    const prepared = await host.prepare(spec("main.lua", before, 1, "true"), context());
    const authorization = await approve(broker, prepared.proposal);
    let entered!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    vscode.onDocumentSnapshot = async () => {
      entered();
      await waiting;
    };

    const executing = host.execute(prepared.id, authorization, context());
    await reached;
    await rename(path, sensitivePath);
    await symlink(sensitivePath, path);
    release();

    await expect(executing).rejects.toThrow("sensitive");
    expect(vscode.appliedEdits).toEqual([]);
    expect(broker.consumeAuthorization(authorization, prepared.proposal)).toBe(true);
    host.dispose();
  });

  test("rejects a newly sensitive canonical target before generic identity checks without consuming approval", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "rbxforge-patch-")));
    const path = join(root, "main.lua");
    const sensitivePath = join(root, "secrets.json");
    const before = "return false\n";
    await writeFile(path, before);
    const vscode = new FakeVsCode();
    vscode.documentSnapshots.set(path, snapshot(path, before, 1));
    const broker = new InMemoryApprovalBroker();
    const host = new FilesystemPatchHost({
      vscode,
      journal: new MutationJournal(),
      approvalBroker: broker,
      workspaceRoot: async () => root,
      ignorePolicy: allowPolicy(),
    });
    const prepared = await host.prepare(spec("main.lua", before, 1, "true"), context());
    const authorization = await approve(broker, prepared.proposal);
    await rename(path, sensitivePath);
    await symlink(sensitivePath, path);

    await expect(host.execute(prepared.id, authorization, context())).rejects.toThrow("sensitive");
    expect(vscode.appliedEdits).toEqual([]);
    expect(broker.consumeAuthorization(authorization, prepared.proposal)).toBe(true);
    host.dispose();
  });

  test("revalidates immediately before edit and journals observed truth after post-boundary cancellation", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "rbxforge-patch-")));
    const path = join(root, "main.lua");
    const before = "return false\n";
    await writeFile(path, before);
    const vscode = new FakeVsCode();
    vscode.documentSnapshots.set(path, snapshot(path, before, 4));
    const journal = new MutationJournal();
    const broker = new InMemoryApprovalBroker({ now: () => 0, randomId: ids("authorization-1", "authorization-2") });
    const host = new FilesystemPatchHost({
      vscode,
      journal,
      approvalBroker: broker,
      workspaceRoot: async () => root,
      ignorePolicy: allowPolicy(),
      now: () => 0,
      randomId: ids("prepared-1", "approval-1", "journal-1", "prepared-2", "approval-2", "journal-2"),
    });
    const stale = await host.prepare(spec("main.lua", before, 4, "true"), context());
    const staleAuth = await approve(broker, stale.proposal);
    vscode.documentSnapshots.set(path, snapshot(path, `${before}--dirty`, 5));
    await expect(host.execute(stale.id, staleAuth, context())).rejects.toThrow("changed");
    expect(vscode.appliedEdits).toHaveLength(0);

    vscode.documentSnapshots.set(path, snapshot(path, before, 4));
    const controller = new AbortController();
    const prepared = await host.prepare(spec("main.lua", before, 4, "true"), {
      ...context(),
      signal: controller.signal,
    });
    const authorization = await approve(broker, prepared.proposal);
    vscode.onApplyWorkspaceEdit = () => controller.abort();
    const receipt = await host.execute(prepared.id, authorization, { ...context(), signal: controller.signal });
    expect(receipt.ok).toBe(true);
    expect(journal.entries().at(-1)).toMatchObject({ result: "applied", verification: "verified" });
    host.dispose();
  });

  test("rereads and journals observed truth when WorkspaceEdit throws after its side-effect boundary", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "rbxforge-patch-")));
    const path = join(root, "main.lua");
    const before = "return false\n";
    await writeFile(path, before);
    const vscode = new FakeVsCode();
    vscode.documentSnapshots.set(path, snapshot(path, before, 4));
    vscode.applyWorkspaceEditError = new Error("sentinel implementation detail");
    const journal = new MutationJournal();
    const broker = new InMemoryApprovalBroker({ now: () => 0, randomId: ids("authorization-1") });
    const host = new FilesystemPatchHost({
      vscode,
      journal,
      approvalBroker: broker,
      workspaceRoot: async () => root,
      ignorePolicy: allowPolicy(),
      now: () => 0,
      randomId: ids("prepared-1", "approval-1", "journal-1"),
    });
    const prepared = await host.prepare(spec("main.lua", before, 4, "true"), context());
    const authorization = await approve(broker, prepared.proposal);

    await expect(host.execute(prepared.id, authorization, context())).resolves.toMatchObject({
      ok: false,
      code: "workspace-edit-failed",
      verification: "unverified",
    });
    expect(journal.entries()).toEqual([
      expect.objectContaining({
        result: "failed",
        verification: "unverifiable",
        detail: expect.stringContaining("WorkspaceEdit threw"),
      }),
    ]);
    expect(JSON.stringify(journal.entries())).not.toContain("sentinel implementation detail");
    host.dispose();
  });

  test("Stop during the final async preflight consumes no authorization and applies no edit", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "rbxforge-patch-")));
    const path = join(root, "main.lua");
    const before = "return false\n";
    await writeFile(path, before);
    const vscode = new FakeVsCode();
    vscode.documentSnapshots.set(path, snapshot(path, before, 4));
    const journal = new MutationJournal();
    const broker = new InMemoryApprovalBroker({ now: () => 0, randomId: ids("authorization-1") });
    const host = new FilesystemPatchHost({
      vscode,
      journal,
      approvalBroker: broker,
      workspaceRoot: async () => root,
      ignorePolicy: allowPolicy(),
      now: () => 0,
      randomId: ids("prepared-1", "approval-1"),
    });
    const controller = new AbortController();
    const toolContext = { ...context(), signal: controller.signal };
    const prepared = await host.prepare(spec("main.lua", before, 4, "true"), toolContext);
    const authorization = await approve(broker, prepared.proposal);
    let release!: () => void;
    let entered!: () => void;
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    vscode.onDocumentSnapshot = async () => {
      entered();
      await waiting;
    };

    const executing = host.execute(prepared.id, authorization, toolContext);
    await reached;
    controller.abort(new Error("Stop"));
    release();

    await expect(executing).rejects.toThrow("Stop");
    expect(vscode.appliedEdits).toEqual([]);
    expect(journal.entries()).toEqual([]);
    expect(broker.consumeAuthorization(authorization, prepared.proposal)).toBe(true);
    host.dispose();
  });
});

function context() {
  return {
    sessionId: "session-1",
    generation: 1,
    runId: "run-1",
    signal: new AbortController().signal,
    context: {
      records: [],
      receipts: [],
      instructions: "untrusted",
      totalBytes: 0,
    },
    selection: {
      chipIds: [],
      workspaceRoot: "/workspace",
      sessionId: "session-1",
      generation: 1,
    },
    simulation: false,
  } as const;
}

function spec(path: string, before: string, version: number, replacement: string): FilesystemPatchSpec {
  return {
    files: [
      {
        path,
        expectedVersion: version,
        expectedSha256: sha(before),
        edits: [{ range: range(0, 7, 0, 12), newText: replacement }],
      },
    ],
  };
}

function snapshot(path: string, text: string, version: number) {
  return { path, uri: `file://${path}`, text, version, isDirty: false };
}

function range(startLine: number, startCharacter: number, endLine: number, endCharacter: number) {
  return { start: { line: startLine, character: startCharacter }, end: { line: endLine, character: endCharacter } };
}

function allowPolicy(
  evaluate: (path: string, signal: AbortSignal) => boolean | Promise<boolean> = () => false,
): RevisionedIgnorePolicy {
  return new RevisionedIgnorePolicy({ evaluate });
}

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function ids(...values: string[]): () => string {
  let index = 0;
  return () => values[index++] ?? `id-${index}`;
}

async function approve(broker: InMemoryApprovalBroker, proposal: Parameters<InMemoryApprovalBroker["request"]>[0]) {
  const pending = broker.request(proposal, new AbortController().signal);
  broker.resolve({
    sessionId: proposal.sessionId,
    generation: proposal.generation,
    runId: proposal.runId,
    approvalId: proposal.approvalId,
    decision: "approve",
  });
  const decision = await pending;
  if (!decision.approved) throw new Error("Expected approval");
  return decision.authorization;
}
