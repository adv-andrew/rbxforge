import { mkdtemp, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectIdentityError, assertProjectIdentityCurrent, captureProjectIdentity } from "./project-identity.js";
import { ProjectWatcher, type ProjectWatcherPorts } from "./project-watcher.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("ProjectWatcher", () => {
  it("invalidates once when either a selected-parent event or two-second rehash finds drift", async () => {
    const root = await fixtureRoot();
    const projectFile = join(root, "default.project.json");
    const ref = captureProjectIdentity({
      projectId: "project-1",
      rootPath: root,
      projectFilePath: projectFile,
      revision: 1,
    });
    const clock = createWatcherClock();
    const invalidations: string[] = [];
    const watcher = new ProjectWatcher(clock.ports);
    const lease = watcher.start(ref, (payload) => invalidations.push(payload.reason.code));
    await writeFile(join(root, "replacement.json"), JSON.stringify({ name: "Other", tree: {} }));
    await rename(join(root, "replacement.json"), projectFile);

    clock.emitDirectoryEvent("rename", "default.project.json");
    clock.tickInterval();
    await clock.flush();

    expect(invalidations).toEqual(["inode-changed"]);
    expect(clock.intervalMs).toBe(2_000);
    expect(clock.watchedDirectory).toBe(await realpath(root));
    await lease.dispose();
  });

  it("emits an immutable next-revision ref while retaining the guarded identity", async () => {
    const root = await fixtureRoot();
    const projectFile = join(root, "default.project.json");
    const ref = captureProjectIdentity({
      projectId: "project-1",
      rootPath: root,
      projectFilePath: projectFile,
      revision: 7,
    });
    const clock = createWatcherClock();
    const invalidations: unknown[] = [];
    const lease = new ProjectWatcher(clock.ports).start(ref, (payload) => invalidations.push(payload));
    await writeFile(join(root, "replacement.json"), JSON.stringify({ name: "Replacement", tree: {} }));
    await rename(join(root, "replacement.json"), projectFile);

    await expect(lease.checkNow()).rejects.toMatchObject({ code: "inode-changed" });

    expect(invalidations).toHaveLength(1);
    const payload = invalidations[0] as {
      readonly projectId: string;
      readonly ref: typeof ref;
      readonly reason: { readonly code: string };
    };
    expect(payload).toMatchObject({
      projectId: "project-1",
      ref: { ...ref, revision: 8, configDigest: ref.configDigest },
      reason: { code: "inode-changed" },
    });
    expect(payload.ref).not.toBe(ref);
    expect(Object.isFrozen(payload.ref)).toBe(true);
    await lease.dispose();
  });

  it("ignores unrelated parent events and closes its only resources on dispose", async () => {
    const root = await fixtureRoot();
    const ref = captureProjectIdentity({
      projectId: "project-1",
      rootPath: root,
      projectFilePath: join(root, "default.project.json"),
      revision: 1,
    });
    const clock = createWatcherClock();
    const watcher = new ProjectWatcher(clock.ports);
    const lease = watcher.start(ref, () => undefined);

    clock.emitDirectoryEvent("change", "unrelated.txt");
    await clock.flush();
    await lease.dispose();

    expect(clock.closed).toBe(true);
    expect(clock.cleared).toBe(true);
  });

  it("waits for in-flight validation and suppresses invalidation after disposal begins", async () => {
    const root = await fixtureRoot();
    const ref = captureProjectIdentity({
      projectId: "project-1",
      rootPath: root,
      projectFilePath: join(root, "default.project.json"),
      revision: 1,
    });
    const clock = createWatcherClock();
    let rejectValidation: (reason: unknown) => void = () => undefined;
    const validation = new Promise<void>((_resolve, reject) => {
      rejectValidation = reject;
    });
    const ports = {
      ...clock.ports,
      validateProjectIdentity: () => validation,
    } as ProjectWatcherPorts;
    const invalidations: unknown[] = [];
    const lease = new ProjectWatcher(ports).start(ref, (payload) => invalidations.push(payload));
    const checking = lease.checkNow().catch(() => undefined);
    await Promise.resolve();
    let disposeSettled = false;
    const disposing = lease.dispose().then(() => {
      disposeSettled = true;
    });

    await Promise.resolve();
    expect(disposeSettled).toBe(false);
    rejectValidation(new ProjectIdentityError("digest-changed", "Project file changed."));
    await disposing;
    await checking;

    expect(invalidations).toEqual([]);
    expect(clock.closed).toBe(true);
    expect(clock.cleared).toBe(true);
  });
});

function createWatcherClock() {
  let interval: (() => void) | undefined;
  let directoryListener: ((eventType: string, filename: string | Buffer | null) => void) | undefined;
  const pending: Promise<void>[] = [];
  const clock = {
    intervalMs: 0,
    watchedDirectory: "",
    closed: false,
    cleared: false,
    ports: {
      watchDirectory(directory: string, listener: (eventType: string, filename: string | Buffer | null) => void) {
        clock.watchedDirectory = directory;
        directoryListener = listener;
        return { close: () => (clock.closed = true) };
      },
      setInterval(callback: () => void, milliseconds: number) {
        clock.intervalMs = milliseconds;
        interval = callback;
        return 1;
      },
      clearInterval() {
        clock.cleared = true;
      },
      schedule(work: () => Promise<void>) {
        pending.push(work());
      },
      validateProjectIdentity: assertProjectIdentityCurrent,
    } satisfies ProjectWatcherPorts,
    emitDirectoryEvent(eventType: string, filename: string) {
      directoryListener?.(eventType, filename);
    },
    tickInterval() {
      interval?.();
    },
    async flush() {
      await Promise.all(pending.splice(0));
      await Promise.resolve();
    },
  };
  return clock;
}

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rbxforge-watcher-"));
  roots.push(root);
  await writeFile(join(root, "default.project.json"), JSON.stringify({ name: "Deepwater", tree: {} }));
  return root;
}
