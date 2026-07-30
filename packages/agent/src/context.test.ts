import { createHash } from "node:crypto";
import { mkdtemp, mkdir, open, realpath, rename, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test, vi } from "vitest";

import { CONTEXT_LIMITS, HostContextRegistry, type ContextRecord } from "./context.js";
import { issueFileSnapshotProvenance } from "./file-snapshot-provenance.js";
import { RevisionedIgnorePolicy } from "./ignore-policy.js";

const capabilities = Object.freeze({ vision: false });

async function workspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "rbxforge-context-"));
}

describe("HostContextRegistry", () => {
  test("rejects file-kind registration outside the identity-bound file APIs", async () => {
    const root = await workspace();
    const registry = new HostContextRegistry({ now: () => 100 });

    expect(() =>
      registry.register({
        ...commonBinding(root),
        kind: "file",
        label: "unbound.lua",
        resolve: async () => record("UNBOUND_FILE_SENTINEL"),
      } as unknown as Parameters<HostContextRegistry["register"]>[0]),
    ).toThrow("identity-bound file API");
  });

  test("resolves only selected opaque chips in stable order and records truncation", async () => {
    const root = await workspace();
    await writeFile(join(root, "first.lua"), "a".repeat(CONTEXT_LIMITS.perItemBytes + 10));
    await writeFile(join(root, "second.lua"), "return 2");
    const registry = new HostContextRegistry({
      now: () => 100,
      randomId: ids("chip-b", "chip-a"),
      ignorePolicy: allowPolicy(),
    });
    const first = await registry.registerFile(binding(root, "first.lua"));
    const second = await registry.registerFile(binding(root, "second.lua"));

    const context = await registry.build(
      selection(root, [second, "unknown", first]),
      capabilities,
      new AbortController().signal,
    );

    expect(context.records.map((record) => record.chipId)).toEqual([second, first]);
    expect(context.records[1]?.content).toHaveLength(CONTEXT_LIMITS.perItemBytes);
    expect(context.receipts).toContainEqual(
      expect.objectContaining({
        chipId: first,
        outcome: "truncated",
      }),
    );
    expect(context.instructions).toContain("untrusted data");
    expect(Object.isFrozen(context.records)).toBe(true);
  });

  test("rejects traversal, symlink escape, roots, ignored and sensitive files", async () => {
    const root = await workspace();
    const outside = await workspace();
    await mkdir(join(root, "sub"));
    await writeFile(join(root, ".env.local"), "SAFE=value");
    await writeFile(join(root, "ignored.lua"), "return 1");
    await writeFile(join(outside, "secret.lua"), "return 2");
    await symlink(join(outside, "secret.lua"), join(root, "sub", "escape.lua"));
    const registry = new HostContextRegistry({
      now: () => 100,
      randomId: ids("traversal", "escape", "root", "ignored", "env"),
      ignorePolicy: allowPolicy((path) => path.endsWith("ignored.lua")),
    });
    const chips = await Promise.all([
      registry.registerFile(binding(root, "../outside.lua")),
      registry.registerFile(binding(root, "sub/escape.lua")),
      registry.registerFile(binding(root, ".")),
      registry.registerFile(binding(root, "ignored.lua")),
      registry.registerFile(binding(root, ".env.local")),
    ]);

    const context = await registry.build(selection(root, chips), capabilities, new AbortController().signal);

    expect(context.records).toEqual([]);
    expect(context.receipts.map((receipt) => receipt.reason)).toEqual([
      "outside-boundary",
      "outside-boundary",
      "root-expansion",
      "ignored",
      "sensitive-path",
    ]);
  });

  test("registers an immutable editor snapshot only after canonical boundary and ignore checks", async () => {
    const root = await workspace();
    const outside = await workspace();
    await writeFile(join(root, "current.lua"), "stale disk text");
    await writeFile(join(root, "ignored.lua"), "ignored disk text");
    await writeFile(join(outside, "outside.lua"), "outside disk text");
    const registry = new HostContextRegistry({
      now: () => 100,
      randomId: ids("current"),
      ignorePolicy: allowPolicy((path) => path.endsWith("ignored.lua")),
    });
    const captured = record('{"path":"current.lua","version":9,"sha256":"exact-sha","text":"live buffer text"}');
    const provenance = await snapshotProvenance(join(root, "current.lua"), 9, "live buffer text");
    const current = await registry.registerFileSnapshot(binding(root, "current.lua"), captured, provenance);
    await expect(registry.registerFileSnapshot(binding(root, "ignored.lua"), captured, provenance)).rejects.toThrow(
      "ignored",
    );
    await expect(registry.registerFileSnapshot(binding(root, "../outside.lua"), captured, provenance)).rejects.toThrow(
      "outside-boundary",
    );
    const controller = new AbortController();

    const context = await registry.build(selection(root, [current]), capabilities, controller.signal);

    expect(context.records).toHaveLength(1);
    expect(context.records[0]?.content).toBe(
      '{"path":"current.lua","version":9,"sha256":"exact-sha","text":"live buffer text"}',
    );
    expect(context.receipts.map((receipt) => receipt.reason)).toEqual([undefined]);
  });

  test("omits secret-like content from every source and gates screenshots on vision", async () => {
    const root = await workspace();
    const registry = new HostContextRegistry({
      now: () => 100,
      randomId: ids("log", "diagnostic", "studio", "shot"),
    });
    const common = commonBinding(root);
    const log = registry.register({
      ...common,
      kind: "log",
      label: "Runtime log",
      resolve: async () => record("Authorization: Bearer sentinel-token"),
    });
    const diagnostic = registry.register({
      ...common,
      kind: "diagnostic",
      label: "Diagnostic",
      resolve: async () => record("api_key=sk-sentinel"),
    });
    const studio = registry.register({
      ...common,
      kind: "studio-properties",
      label: "Properties",
      resolve: async () => record('{"Credential":"sentinel"}'),
    });
    const shot = registry.register({
      ...common,
      kind: "screenshot",
      label: "Viewport",
      resolve: async () => ({ content: "YWJj", mimeType: "image/png" }),
    });

    const withoutVision = await registry.build(
      selection(root, [log, diagnostic, studio, shot]),
      capabilities,
      new AbortController().signal,
    );
    expect(withoutVision.records).toEqual([]);
    expect(withoutVision.receipts.map((receipt) => receipt.reason)).toEqual([
      "sensitive-content",
      "sensitive-content",
      "sensitive-content",
      "vision-unavailable",
    ]);

    const withVision = await registry.build(selection(root, [shot]), { vision: true }, new AbortController().signal);
    expect(withVision.records).toHaveLength(1);
    expect(withVision.records[0]).toMatchObject({ kind: "screenshot", mimeType: "image/png" });
  });

  test("preserves valid screenshot base64 within the aggregate cap and omits invalid or oversized images", async () => {
    const root = await workspace();
    const registry = new HostContextRegistry({
      now: () => 100,
      randomId: ids("valid", "oversized", "invalid"),
      limits: {
        perItemBytes: 4,
        totalBytes: 8,
        screenshotBytes: 8,
      },
    });
    const common = commonBinding(root);
    const valid = registry.register({
      ...common,
      kind: "screenshot",
      label: "Valid viewport",
      resolve: async () => ({ content: "YWJjZGVm", mimeType: "image/png" }),
    });
    const oversized = registry.register({
      ...common,
      kind: "screenshot",
      label: "Oversized viewport",
      resolve: async () => ({ content: "YWJjZGVmZ2hp", mimeType: "image/png" }),
    });
    const invalid = registry.register({
      ...common,
      kind: "screenshot",
      label: "Invalid viewport",
      resolve: async () => ({ content: "YWJj!", mimeType: "image/png" }),
    });

    const included = await registry.build(selection(root, [valid]), { vision: true }, new AbortController().signal);
    expect(included.records).toEqual([
      expect.objectContaining({
        chipId: valid,
        content: "YWJjZGVm",
        mimeType: "image/png",
        truncated: false,
      }),
    ]);
    expect(included.receipts).toEqual([expect.objectContaining({ chipId: valid, outcome: "included", bytes: 6 })]);

    const omitted = await registry.build(
      selection(root, [oversized, invalid]),
      { vision: true },
      new AbortController().signal,
    );
    expect(omitted.records).toEqual([]);
    expect(omitted.receipts.map((receipt) => receipt.reason)).toEqual(["screenshot-bytes", "invalid-screenshot"]);
  });

  test("shares the aggregate byte budget between decoded screenshots and text", async () => {
    const root = await workspace();
    const registry = new HostContextRegistry({
      now: () => 100,
      randomId: ids("first-shot", "second-shot", "text"),
      limits: {
        perItemBytes: 10,
        totalBytes: 6,
        screenshotBytes: 10,
        screenshots: 2,
      },
    });
    const common = commonBinding(root);
    const firstShot = registry.register({
      ...common,
      kind: "screenshot",
      label: "First viewport",
      resolve: async () => ({ content: "YWJjZA==", mimeType: "image/png" }),
    });
    const secondShot = registry.register({
      ...common,
      kind: "screenshot",
      label: "Second viewport",
      resolve: async () => ({ content: "ZWZnaA==", mimeType: "image/png" }),
    });
    const text = registry.register({
      ...common,
      kind: "selection",
      label: "Selection",
      resolve: async () => record("ijkl"),
    });

    const context = await registry.build(
      selection(root, [firstShot, secondShot, text]),
      { vision: true },
      new AbortController().signal,
    );

    expect(context.records.map((item) => item.chipId)).toEqual([firstShot, text]);
    expect(context.records[1]).toMatchObject({ content: "ij", truncated: true });
    expect(context.receipts).toEqual([
      expect.objectContaining({ chipId: firstShot, outcome: "included", bytes: 4 }),
      expect.objectContaining({
        chipId: secondShot,
        outcome: "omitted",
        reason: "total-cap",
        bytes: 4,
      }),
      expect.objectContaining({
        chipId: text,
        outcome: "truncated",
        reason: "total-cap",
        bytes: 2,
      }),
    ]);
    const retainedBytes = context.receipts
      .filter((receipt) => receipt.outcome !== "omitted")
      .reduce((sum, receipt) => sum + receipt.bytes, 0);
    expect(context.totalBytes).toBe(retainedBytes);
    expect(context.totalBytes).toBeLessThanOrEqual(6);
  });

  test("rechecks host currentness after an asynchronous resolver and fails closed on callback errors", async () => {
    const root = await workspace();
    let current = true;
    let release!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const isCurrent = vi.fn(() => current);
    const registry = new HostContextRegistry({
      now: () => 100,
      randomId: ids("changing", "throwing"),
    });
    const changing = registry.register({
      ...commonBinding(root),
      kind: "studio-properties",
      label: "Changing Studio properties",
      isCurrent,
      resolve: async () => {
        markStarted();
        await waiting;
        return record("post-await-stale-sentinel");
      },
    });
    const throwing = registry.register({
      ...commonBinding(root),
      kind: "studio-properties",
      label: "Throwing currentness",
      isCurrent: () => {
        throw new Error("currentness unavailable");
      },
      resolve: async () => record("throwing-currentness-sentinel"),
    });

    const building = registry.build(selection(root, [changing, throwing]), capabilities, new AbortController().signal);
    await started;
    expect(isCurrent).toHaveBeenCalledTimes(1);
    current = false;
    release();
    const context = await building;

    expect(isCurrent).toHaveBeenCalledTimes(2);
    expect(context.records).toEqual([]);
    expect(context.receipts.map((receipt) => receipt.reason)).toEqual(["stale-capability", "stale-capability"]);
    expect(JSON.stringify(context)).not.toContain("post-await-stale-sentinel");
    expect(JSON.stringify(context)).not.toContain("throwing-currentness-sentinel");
  });

  test("does not consult file ignore policy for a non-file-only aggregate", async () => {
    const root = await workspace();
    const evaluate = vi.fn(async () => {
      throw new Error("file policy should not run");
    });
    const registry = new HostContextRegistry({
      now: () => 100,
      randomId: ids("studio-only"),
      ignorePolicy: {
        evaluate,
        isCurrent: () => false,
        dispose: () => undefined,
      },
    });
    const chip = registry.register({
      ...commonBinding(root),
      kind: "studio-properties",
      label: "Studio only",
      resolve: async () => record("Anchored=true"),
    });

    const context = await registry.build(selection(root, [chip]), capabilities, new AbortController().signal);

    expect(context.records).toHaveLength(1);
    expect(evaluate).toHaveBeenCalledTimes(0);
  });

  test("revalidates every included volatile binding before releasing an aggregate context", async () => {
    const root = await workspace();
    await writeFile(join(root, "later.lua"), "return true");
    let studioCurrent = true;
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const isCurrent = vi.fn(() => studioCurrent);
    const registry = new HostContextRegistry({
      now: () => 100,
      randomId: ids("studio-first", "file-later"),
      ignorePolicy: allowPolicy(),
      openFile: async (path, flags) => {
        const handle = await open(path, flags);
        return {
          stat: (options) => handle.stat(options),
          read: async (buffer, offset, length, position) => {
            entered();
            await waiting;
            return handle.read(buffer, offset, length, position);
          },
          close: () => handle.close(),
        };
      },
    });
    const studio = registry.register({
      ...commonBinding(root),
      kind: "studio-properties",
      label: "Workspace.Part",
      instanceId: "instance-a",
      graphRevision: 7,
      isCurrent,
      resolve: async () => record("Anchored=true"),
    });
    const file = await registry.registerFile(binding(root, "later.lua"));
    const building = registry.build(
      {
        ...selection(root, [studio, file]),
        instanceId: "instance-a",
        graphRevision: 7,
      },
      capabilities,
      new AbortController().signal,
    );

    await started;
    expect(isCurrent).toHaveBeenCalledTimes(2);
    studioCurrent = false;
    release();

    await expect(building).rejects.toThrow("volatile context changed");
    expect(isCurrent).toHaveBeenCalledTimes(3);
  });

  test.each(["outside", "sensitive"] as const)(
    "rechecks file identity after an asynchronous host read swaps to a %s symlink",
    async (swapKind) => {
      const root = await workspace();
      const outside = await workspace();
      const requested = join(root, "main.lua");
      const backup = join(root, "main.backup.lua");
      const target = swapKind === "outside" ? join(outside, "other.lua") : join(root, "secrets.json");
      await writeFile(requested, "return true");
      await writeFile(target, "LEAKED_FILE_BYTES_42");
      let closeCalls = 0;
      const registry = new HostContextRegistry({
        now: () => 100,
        randomId: ids(`post-read-${swapKind}`),
        ignorePolicy: allowPolicy(),
        openFile: async (path, flags) => {
          const handle = await open(path, flags);
          return {
            stat: (options) => handle.stat(options),
            read: async (buffer, offset, length, position) => {
              await rename(requested, backup);
              await symlink(target, requested);
              return handle.read(buffer, offset, length, position);
            },
            close: async () => {
              closeCalls += 1;
              await handle.close();
            },
          };
        },
      });
      const chip = await registry.registerFile(binding(root, "main.lua"));

      const context = await registry.build(selection(root, [chip]), capabilities, new AbortController().signal);

      expect(context.records).toEqual([]);
      expect(context.receipts).toEqual([
        expect.objectContaining({
          chipId: chip,
          outcome: "omitted",
          reason: "changed",
        }),
      ]);
      expect(JSON.stringify(context)).not.toContain("LEAKED_FILE_BYTES_42");
      expect(closeCalls).toBe(1);
    },
  );

  test("does not release file bytes when ignore policy changes while final stat remains pending", async () => {
    const root = await workspace();
    const path = join(root, "main.lua");
    await writeFile(path, "SAFE_CONTEXT_BYTES");
    let ignored = false;
    let ignoreChecks = 0;
    const policy = allowPolicy(async () => {
      ignoreChecks += 1;
      if (ignoreChecks === 2) {
        queueMicrotask(() => {
          ignored = true;
          policy.invalidate();
        });
      }
      return ignored;
    });
    const registry = new HostContextRegistry({
      now: () => 100,
      randomId: ids("late-ignore"),
      ignorePolicy: policy,
    });
    const chip = await registry.registerFile(binding(root, "main.lua"));

    const building = registry.build(selection(root, [chip]), capabilities, new AbortController().signal);

    await expect(building).rejects.toThrow("policy changed");
    expect(ignored).toBe(true);
  });

  test("rejects an active immutable snapshot when policy changes while a later binding resolves", async () => {
    const root = await workspace();
    await writeFile(join(root, "active.lua"), "stale disk");
    let ignored = false;
    let entered!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const policy = allowPolicy(async () => ignored);
    const registry = new HostContextRegistry({
      now: () => 100,
      randomId: ids("active-snapshot", "later-binding"),
      ignorePolicy: policy,
    });
    const active = await registry.registerFileSnapshot(
      binding(root, "active.lua"),
      record("SAFE_UNSAVED_ACTIVE_BYTES"),
      await snapshotProvenance(join(root, "active.lua"), 1, "SAFE_UNSAVED_ACTIVE_BYTES"),
    );
    const later = registry.register({
      ...commonBinding(root),
      kind: "selection",
      label: "Later context",
      resolve: async () => {
        entered();
        await waiting;
        return record("later");
      },
    });
    const building = registry.build(selection(root, [active, later]), capabilities, new AbortController().signal);

    await reached;
    ignored = true;
    policy.invalidate();
    release();

    await expect(building).rejects.toThrow("policy changed");
  });

  test("rejects active snapshot provenance that expires while a later binding resolves", async () => {
    const root = await workspace();
    const path = join(root, "active.lua");
    await writeFile(path, "safe disk baseline");
    let provenanceCurrent = true;
    let entered!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const registry = new HostContextRegistry({
      now: () => 100,
      randomId: ids("active-provenance", "later-provenance-binding"),
      ignorePolicy: allowPolicy(),
    });
    const active = await registry.registerFileSnapshot(
      binding(root, "active.lua"),
      record("PROVENANCE_SENTINEL_BYTES_42"),
      await snapshotProvenance(path, 1, "PROVENANCE_SENTINEL_BYTES_42", () => provenanceCurrent),
    );
    const later = registry.register({
      ...commonBinding(root),
      kind: "selection",
      label: "Later context",
      resolve: async () => {
        entered();
        await waiting;
        return record("later");
      },
    });
    let releasedContext: unknown;
    const building = registry
      .build(selection(root, [active, later]), capabilities, new AbortController().signal)
      .then((context) => {
        releasedContext = context;
        return context;
      });

    await reached;
    provenanceCurrent = false;
    release();

    await expect(building).rejects.toThrow("provenance changed");
    expect(releasedContext).toBeUndefined();
    expect(String(JSON.stringify(releasedContext))).not.toContain("PROVENANCE_SENTINEL_BYTES_42");
  });

  test.each(["abort", "read-error"] as const)(
    "closes an identity-bound file handle exactly once after %s",
    async (testCase) => {
      const root = await workspace();
      const path = join(root, "main.lua");
      await writeFile(path, "ORIGINAL_SAFE_BYTES");
      const controller = new AbortController();
      let closeCalls = 0;
      let readCalls = 0;
      const options = {
        now: () => 100,
        randomId: ids(`handle-${testCase}`),
        ignorePolicy: allowPolicy(),
        openFile: async (candidate: string, flags: number) => {
          const handle = await open(candidate, flags);
          return {
            stat: (options) => handle.stat(options),
            read: async (buffer: Buffer, offset: number, length: number, position: number) => {
              readCalls += 1;
              if (testCase === "abort") controller.abort(new Error("context read stopped"));
              if (testCase === "read-error") throw new Error("sentinel read error");
              return handle.read(buffer, offset, length, position);
            },
            close: async () => {
              closeCalls += 1;
              await handle.close();
            },
          };
        },
      };
      const registry = new HostContextRegistry(options);
      const chip = await registry.registerFile(binding(root, "main.lua"));
      const building = registry.build(selection(root, [chip]), capabilities, controller.signal);

      if (testCase === "abort") {
        await expect(building).rejects.toThrow("context read stopped");
      } else {
        await expect(building).resolves.toMatchObject({
          records: [],
          receipts: [expect.objectContaining({ outcome: "omitted", reason: "unavailable" })],
        });
      }
      expect(readCalls).toBe(1);
      expect(closeCalls).toBe(1);
    },
  );

  test("rejects a changed opened-file snapshot before reading and still closes the handle", async () => {
    const root = await workspace();
    const path = join(root, "main.lua");
    await writeFile(path, "ORIGINAL_SAFE_BYTES");
    const actual = await stat(path);
    let readCalls = 0;
    let closeCalls = 0;
    const registry = new HostContextRegistry({
      now: () => 100,
      randomId: ids("changed-before-read"),
      ignorePolicy: allowPolicy(),
      openFile: async (candidate, flags) => {
        const handle = await open(candidate, flags);
        return {
          stat: async () => ({
            ...actual,
            isFile: () => true,
            size: actual.size + 1,
          }),
          read: async (buffer, offset, length, position) => {
            readCalls += 1;
            return handle.read(buffer, offset, length, position);
          },
          close: async () => {
            closeCalls += 1;
            await handle.close();
          },
        };
      },
    });
    const chip = await registry.registerFile(binding(root, "main.lua"));

    const context = await registry.build(selection(root, [chip]), capabilities, new AbortController().signal);

    expect(context).toMatchObject({
      records: [],
      receipts: [expect.objectContaining({ outcome: "omitted", reason: "changed" })],
    });
    expect(readCalls).toBe(0);
    expect(closeCalls).toBe(1);
  });

  test("bounds every identity-handle read to the per-item cap plus UTF-8 slack", async () => {
    const root = await workspace();
    const path = join(root, "main.lua");
    await writeFile(path, "a".repeat(CONTEXT_LIMITS.perItemBytes + 64));
    const requestedLengths: number[] = [];
    let closeCalls = 0;
    const registry = new HostContextRegistry({
      now: () => 100,
      randomId: ids("bounded-read"),
      ignorePolicy: allowPolicy(),
      openFile: async (candidate, flags) => {
        const handle = await open(candidate, flags);
        return {
          stat: (options) => handle.stat(options),
          read: async (buffer, offset, length, position) => {
            requestedLengths.push(length);
            return handle.read(buffer, offset, length, position);
          },
          close: async () => {
            closeCalls += 1;
            await handle.close();
          },
        };
      },
    });
    const chip = await registry.registerFile(binding(root, "main.lua"));

    const context = await registry.build(selection(root, [chip]), capabilities, new AbortController().signal);

    expect(context.records[0]?.content).toHaveLength(CONTEXT_LIMITS.perItemBytes);
    expect(context.records[0]?.truncated).toBe(true);
    expect(requestedLengths.length).toBeGreaterThan(0);
    expect(Math.max(...requestedLengths)).toBeLessThanOrEqual(CONTEXT_LIMITS.perItemBytes + 4);
    expect(closeCalls).toBe(1);
  });

  test.each(["outside", "sensitive"] as const)(
    "never releases %s bytes from an identity-bound swap-read-restore",
    async (swapKind) => {
      const root = await workspace();
      const outside = await workspace();
      const requested = join(root, "main.lua");
      const backup = join(root, "main.backup.lua");
      const target = swapKind === "outside" ? join(outside, "other.lua") : join(root, "secrets.json");
      await writeFile(requested, "ORIGINAL_SAFE_BYTES");
      await writeFile(target, "LEAKED_FILE_BYTES_42");
      const registry = new HostContextRegistry({
        now: () => 100,
        randomId: ids(`swap-restore-${swapKind}`),
        ignorePolicy: allowPolicy(),
        openFile: async (path, flags) => {
          const handle = await open(path, flags);
          return {
            stat: (options) => handle.stat(options),
            read: async (buffer, offset, length, position) => {
              await rename(requested, backup);
              await symlink(target, requested);
              await rename(requested, join(root, `discarded-${swapKind}-link`));
              await rename(backup, requested);
              return handle.read(buffer, offset, length, position);
            },
            close: () => handle.close(),
          };
        },
      });
      const chip = await registry.registerFile(binding(root, "main.lua"));

      const context = await registry.build(selection(root, [chip]), capabilities, new AbortController().signal);

      expect(JSON.stringify(context)).not.toContain("LEAKED_FILE_BYTES_42");
      expect(context.records[0]?.content === "ORIGINAL_SAFE_BYTES" || context.receipts[0]?.outcome === "omitted").toBe(
        true,
      );
    },
  );

  test("omits password and passwd assignments from generic and file context", async () => {
    const root = await workspace();
    await writeFile(join(root, "notes.txt"), "password=abc\nDB_PASSWORD=q");
    const registry = new HostContextRegistry({
      now: () => 100,
      randomId: ids("file-password", "generic-password"),
      ignorePolicy: allowPolicy(),
    });
    const file = await registry.registerFile(binding(root, "notes.txt"));
    const generic = registry.register({
      ...commonBinding(root),
      kind: "selection",
      label: "Editor selection",
      resolve: async () => record('passwd=x\ndbPassword=z\n{"db_passwd":"y"}'),
    });

    const context = await registry.build(selection(root, [file, generic]), capabilities, new AbortController().signal);

    expect(context.records).toEqual([]);
    expect(context.receipts.map((receipt) => receipt.reason)).toEqual(["sensitive-content", "sensitive-content"]);
    expect(JSON.stringify(context)).not.toContain("password=abc");
    expect(JSON.stringify(context)).not.toContain("DB_PASSWORD=q");
    expect(JSON.stringify(context)).not.toContain("passwd=x");
    expect(JSON.stringify(context)).not.toContain("dbPassword=z");
    expect(JSON.stringify(context)).not.toContain('"db_passwd":"y"');
  });

  test("fails closed for stale session, generation, workspace, Studio revision and expiry", async () => {
    const root = await workspace();
    const registry = new HostContextRegistry({ now: () => 101, randomId: ids("chip") });
    const chip = registry.register({
      ...commonBinding(root),
      instanceId: "instance-a",
      graphRevision: 7,
      expiresAt: 101,
      kind: "studio-properties",
      label: "Part",
      resolve: async () => record("Anchored=true"),
    });

    const context = await registry.build(
      { ...selection(root, [chip]), generation: 2, instanceId: "instance-b", graphRevision: 8 },
      capabilities,
      new AbortController().signal,
    );
    expect(context.records).toEqual([]);
    expect(context.receipts[0]?.reason).toBe("stale-capability");
  });
});

function binding(root: string, path: string) {
  return {
    ...commonBinding(root),
    relativePath: path,
    kind: "file" as const,
    label: path,
  };
}

function commonBinding(workspaceRoot: string) {
  return {
    workspaceRoot,
    sessionId: "session-1",
    generation: 1,
    expiresAt: 1_000,
  };
}

function selection(workspaceRoot: string, chipIds: readonly string[]) {
  return {
    workspaceRoot,
    sessionId: "session-1",
    generation: 1,
    chipIds,
  };
}

function record(content: string): ContextRecord {
  return { content };
}

function allowPolicy(
  evaluate: (path: string, signal: AbortSignal) => boolean | Promise<boolean> = () => false,
): RevisionedIgnorePolicy {
  return new RevisionedIgnorePolicy({ evaluate });
}

async function snapshotProvenance(path: string, version: number, text: string, isCurrent: () => boolean = () => true) {
  const canonicalPath = await realpath(path);
  const info = await stat(canonicalPath, { bigint: true });
  const uri = `file://${canonicalPath}`;
  const sha256 = createHash("sha256").update(text).digest("hex");
  const attestation = issueFileSnapshotProvenance(
    {
      canonicalPath,
      uri,
      version,
      sha256,
      device: info.dev.toString(),
      inode: info.ino.toString(),
    },
    isCurrent,
  );
  return { attestation, uri, version, sha256 };
}

function ids(...values: string[]): () => string {
  let index = 0;
  return () => values[index++] ?? `chip-${index}`;
}
