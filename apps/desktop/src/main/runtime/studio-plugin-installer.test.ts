import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  truncate,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AUDITED_STUDIO_PLUGIN,
  PluginInstallError,
  StudioPluginInstaller,
  type PluginInstallerFileHandle,
  type PluginInstallerIo,
} from "./studio-plugin-installer.js";

const temporaryDirectories: string[] = [];
const require = createRequire(import.meta.url);
const upstreamEntry = require.resolve("@chrrxs/robloxstudio-mcp");
const auditedSource = join(dirname(upstreamEntry), "..", "studio-plugin", "MCPPlugin.rbxmx");

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

interface HarnessOptions {
  readonly destination?: "missing" | "audited" | "different";
  readonly sourcePath?: string;
  readonly createPluginsDirectory?: boolean;
  readonly io?: PluginInstallerIo;
  readonly now?: () => number;
}

async function pluginHarness(options: HarnessOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), "rbxforge-plugin-installer-"));
  temporaryDirectories.push(root);
  const homeDirectory = join(root, "Home With ünicode");
  const pluginsDirectory = join(homeDirectory, "Documents", "Roblox", "Plugins");
  await mkdir(homeDirectory);
  if (options.createPluginsDirectory !== false) await mkdir(pluginsDirectory, { recursive: true });
  const destinationPath = join(pluginsDirectory, "MCPPlugin.rbxmx");
  const inspectorPath = join(pluginsDirectory, "MCPInspectorPlugin.rbxmx");
  if (options.destination === "audited") await copyFile(auditedSource, destinationPath);
  if (options.destination === "different") await writeFile(destinationPath, "old plugin");
  const installer = new StudioPluginInstaller({
    sourcePath: options.sourcePath ?? auditedSource,
    homeDirectory,
    io: options.io,
    now: options.now,
  });
  return { root, homeDirectory, pluginsDirectory, destinationPath, inspectorPath, installer };
}

function createIo(overrides: Partial<PluginInstallerIo> = {}): PluginInstallerIo {
  return {
    pathOperationsForTesting: true,
    lstat,
    realpath,
    open: (path, flags, mode) => open(path, flags, mode),
    mkdir: (path) => mkdir(path),
    link: async (existingPath, newPath) => {
      await import("node:fs/promises").then(({ link }) => link(existingPath, newPath));
    },
    rename,
    ...overrides,
  };
}

function wrapHandle(
  handle: PluginInstallerFileHandle,
  overrides: Partial<PluginInstallerFileHandle>,
): PluginInstallerFileHandle {
  return {
    stat: overrides.stat ?? (() => handle.stat()),
    read: overrides.read ?? ((buffer, offset, length, position) => handle.read(buffer, offset, length, position)),
    write: overrides.write ?? ((buffer, offset, length, position) => handle.write(buffer, offset, length, position)),
    sync: overrides.sync ?? (() => handle.sync()),
    close: overrides.close ?? (() => handle.close()),
  };
}

async function digest(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

const ownedPartialPattern = /^\.MCPPlugin\.rbxmx\.(?:tmp|backup-partial)-[0-9a-f]{24}$/;

async function ownedPartials(directory: string): Promise<readonly string[]> {
  return (await readdir(directory)).filter((name) => ownedPartialPattern.test(name)).sort();
}

function permissionError(): NodeJS.ErrnoException {
  return Object.assign(new Error("permission denied"), { code: "EACCES" });
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code });
}

describe("StudioPluginInstaller inspection", () => {
  it("exports the one audited upstream descriptor used by packaging and installation", () => {
    expect(AUDITED_STUDIO_PLUGIN).toEqual({
      fileName: "MCPPlugin.rbxmx",
      inspectorFileName: "MCPInspectorPlugin.rbxmx",
      sha256: "57f16e4e89f4e60d327fa76c89fc44e85a16d8a7051579d38ec0ee7501cad09c",
      size: 5_396_699,
      variant: "main",
      version: "2.22.5",
    });
  });

  it("reports an identical audited destination as installed without rewriting", async () => {
    const harness = await pluginHarness({ destination: "audited" });
    const before = await stat(harness.destinationPath);

    await expect(harness.installer.install({ confirmReplace: false })).resolves.toMatchObject({
      state: "installed",
      changed: false,
      restartRequired: false,
      destinationSha256: AUDITED_STUDIO_PLUGIN.sha256,
    });
    expect((await stat(harness.destinationPath)).mtimeMs).toBe(before.mtimeMs);
  });

  it("performs no write or parent-directory creation while inspecting a missing install", async () => {
    const harness = await pluginHarness({ createPluginsDirectory: false });

    await expect(harness.installer.inspect()).resolves.toMatchObject({
      state: "missing",
      destinationPath: harness.destinationPath,
      sourcePath: auditedSource,
    });
    await expect(lstat(join(harness.homeDirectory, "Documents"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    ["a regular file", async (path: string) => writeFile(path, "inspector")],
    ["a directory", async (path: string) => mkdir(path)],
    ["a symlink", async (path: string) => symlink(auditedSource, path)],
    ["a dangling symlink", async (path: string) => symlink(join(dirname(path), "missing"), path)],
  ])("blocks installation when the inspector path is %s and leaves it untouched", async (_label, createEntry) => {
    const harness = await pluginHarness();
    await createEntry(harness.inspectorPath);
    const before = await lstat(harness.inspectorPath);

    await expect(harness.installer.inspect()).resolves.toMatchObject({
      state: "inspector-conflict",
      inspectorPath: harness.inspectorPath,
      detail: expect.stringMatching(/Show Plugins folder/i),
    });
    await expectCode(harness.installer.install({ confirmReplace: true }), "plugin-inspector-conflict");
    const after = await lstat(harness.inspectorPath);
    expect([after.dev, after.ino, after.mode]).toEqual([before.dev, before.ino, before.mode]);
    await expect(lstat(harness.destinationPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    ["a directory", async (path: string) => mkdir(path)],
    ["a symlink", async (path: string) => symlink(auditedSource, path)],
    ["a dangling symlink", async (path: string) => symlink(join(dirname(path), "missing"), path)],
  ])("never classifies destination %s as replaceable", async (_label, createEntry) => {
    const harness = await pluginHarness();
    await createEntry(harness.destinationPath);

    await expect(harness.installer.inspect()).resolves.toMatchObject({
      state: "error",
      detail: expect.stringMatching(/regular file/i),
    });
    await expectCode(harness.installer.install({ confirmReplace: true }), "plugin-destination-invalid");
  });

  it("treats non-regular socket entries as an inspector conflict or an invalid destination", async () => {
    const root = await mkdtemp("/tmp/rbxforge-socket-");
    temporaryDirectories.push(root);
    const homeDirectory = join(root, "h");
    const pluginsDirectory = join(homeDirectory, "Documents", "Roblox", "Plugins");
    const inspectorPath = join(pluginsDirectory, "MCPInspectorPlugin.rbxmx");
    const destinationPath = join(pluginsDirectory, "MCPPlugin.rbxmx");
    await mkdir(pluginsDirectory, { recursive: true });
    const installer = new StudioPluginInstaller({ sourcePath: auditedSource, homeDirectory });
    const inspectorServer = createServer();
    await new Promise<void>((resolveListen, rejectListen) => {
      inspectorServer.once("error", rejectListen);
      inspectorServer.listen(inspectorPath, resolveListen);
    });
    try {
      await expect(installer.inspect()).resolves.toMatchObject({ state: "inspector-conflict" });
    } finally {
      await new Promise<void>((resolveClose) => inspectorServer.close(() => resolveClose()));
    }

    const destinationServer = createServer();
    await new Promise<void>((resolveListen, rejectListen) => {
      destinationServer.once("error", rejectListen);
      destinationServer.listen(destinationPath, resolveListen);
    });
    try {
      await expect(installer.inspect()).resolves.toMatchObject({
        state: "error",
        detail: expect.stringMatching(/regular file/i),
      });
    } finally {
      await new Promise<void>((resolveClose) => destinationServer.close(() => resolveClose()));
    }
  });

  it.each(["inspector", "destination"] as const)(
    "reports a stable permission failure instead of treating %s access as missing",
    async (blockedEntry) => {
      const harness = await pluginHarness();
      const blockedPath = blockedEntry === "inspector" ? harness.inspectorPath : harness.destinationPath;
      const io = createIo({
        lstat: async (path) => {
          if (path === blockedPath) throw permissionError();
          return lstat(path);
        },
      });
      const installer = new StudioPluginInstaller({
        sourcePath: auditedSource,
        homeDirectory: harness.homeDirectory,
        io,
      });

      await expect(installer.inspect()).resolves.toMatchObject({
        state: "error",
        detail: expect.stringMatching(/permission/i),
      });
      await expectCode(installer.install({ confirmReplace: true }), "plugin-permission-denied");
    },
  );

  it("rejects wrong source size and wrong source digest", async () => {
    const smallHarness = await pluginHarness();
    const smallSource = join(smallHarness.root, "small.rbxmx");
    await writeFile(smallSource, "wrong");
    const smallInstaller = new StudioPluginInstaller({
      sourcePath: smallSource,
      homeDirectory: smallHarness.homeDirectory,
    });
    await expect(smallInstaller.inspect()).resolves.toMatchObject({
      state: "error",
      detail: expect.stringMatching(/audited size/i),
    });

    const corruptSource = join(smallHarness.root, "same-size-wrong-hash.rbxmx");
    const bytes = await readFile(auditedSource);
    bytes[0] = (bytes[0] ?? 0) ^ 1;
    await writeFile(corruptSource, bytes);
    const corruptInstaller = new StudioPluginInstaller({
      sourcePath: corruptSource,
      homeDirectory: smallHarness.homeDirectory,
    });
    await expect(corruptInstaller.inspect()).resolves.toMatchObject({
      state: "error",
      detail: expect.stringMatching(/audited digest/i),
    });
  });

  it.each([
    ["a directory", async (path: string) => mkdir(path)],
    ["a symlink", async (path: string) => symlink(auditedSource, path)],
  ])("rejects source %s without following it", async (_label, createEntry) => {
    const harness = await pluginHarness();
    const sourcePath = join(harness.root, "source-entry");
    await createEntry(sourcePath);
    const installer = new StudioPluginInstaller({ sourcePath, homeDirectory: harness.homeDirectory });

    await expect(installer.inspect()).resolves.toMatchObject({
      state: "error",
      detail: expect.stringMatching(/source.*regular/i),
    });
  });

  it("detects a source identity swap between path inspection and retained-handle audit", async () => {
    const harness = await pluginHarness();
    const sourcePath = join(harness.root, "source.rbxmx");
    await copyFile(auditedSource, sourcePath);
    let swapped = false;
    const io = createIo({
      open: async (path, flags, mode) => {
        if (!swapped && path === sourcePath) {
          swapped = true;
          await unlink(sourcePath);
          await writeFile(sourcePath, Buffer.alloc(AUDITED_STUDIO_PLUGIN.size));
        }
        return open(path, flags, mode);
      },
    });
    const installer = new StudioPluginInstaller({ sourcePath, homeDirectory: harness.homeDirectory, io });

    await expect(installer.inspect()).resolves.toMatchObject({
      state: "error",
      detail: expect.stringMatching(/source.*changed|audited digest/i),
    });
  });

  it("rejects symlinked directory components while allowing Unicode and spaces in a contained home", async () => {
    const valid = await pluginHarness();
    expect(valid.installer.pluginsDirectory()).toBe(valid.pluginsDirectory);
    await expect(valid.installer.inspect()).resolves.toMatchObject({ state: "missing" });

    const root = await mkdtemp(join(tmpdir(), "rbxforge-plugin-component-"));
    temporaryDirectories.push(root);
    const home = join(root, "home");
    const outside = join(root, "outside");
    await mkdir(home);
    await mkdir(outside);
    await symlink(outside, join(home, "Documents"));
    const installer = new StudioPluginInstaller({ sourcePath: auditedSource, homeDirectory: home });
    await expect(installer.inspect()).resolves.toMatchObject({
      state: "error",
      detail: expect.stringMatching(/directory.*symlink|component/i),
    });
  });
});

describe("StudioPluginInstaller installation", () => {
  it("requires confirmation with zero writes, then creates an exact timestamped backup and atomically installs", async () => {
    const harness = await pluginHarness({
      destination: "different",
      now: () => Date.UTC(2024, 6, 28, 12, 34, 56),
    });
    const before = await readFile(harness.destinationPath);

    await expectCode(harness.installer.install({ confirmReplace: false }), "plugin-replace-confirmation-required");
    expect(await readFile(harness.destinationPath)).toEqual(before);
    expect(await readdir(harness.pluginsDirectory)).toEqual(["MCPPlugin.rbxmx"]);

    const result = await harness.installer.install({ confirmReplace: true });
    expect(result).toMatchObject({
      state: "installed",
      changed: true,
      restartRequired: true,
      backupPath: join(harness.pluginsDirectory, "MCPPlugin.rbxmx.backup-20240728-123456"),
    });
    expect(await digest(harness.destinationPath)).toBe(AUDITED_STUDIO_PLUGIN.sha256);
    expect(await readFile(result.backupPath!)).toEqual(before);
    expect(ownedPartialPattern.test(result.backupPath!.split("/").at(-1)!)).toBe(false);
    expect(await ownedPartials(harness.pluginsDirectory)).toEqual([
      expect.stringMatching(/^\.MCPPlugin\.rbxmx\.backup-partial-/),
    ]);
  });

  it("serializes concurrent installs so only one changes a missing destination", async () => {
    const harness = await pluginHarness();

    const results = await Promise.all([
      harness.installer.install({ confirmReplace: false }),
      harness.installer.install({ confirmReplace: false }),
    ]);

    expect(results.map((result) => result.changed).sort()).toEqual([false, true]);
    expect(await digest(harness.destinationPath)).toBe(AUDITED_STUDIO_PLUGIN.sha256);
    expect((await readdir(harness.pluginsDirectory)).filter((name) => name.includes(".tmp-"))).toHaveLength(1);
    expect(results.find((result) => result.changed)?.detail).toMatch(/hidden owned staging hard link/i);
  });

  it("serializes two installer instances that target the same canonical destination", async () => {
    const harness = await pluginHarness();
    let sourceOpens = 0;
    let releaseFirstOpen!: () => void;
    let reportFirstOpen!: () => void;
    const firstOpenStarted = new Promise<void>((resolveStarted) => {
      reportFirstOpen = resolveStarted;
    });
    const firstOpenRelease = new Promise<void>((resolveRelease) => {
      releaseFirstOpen = resolveRelease;
    });
    const io = createIo({
      open: async (path, flags, mode) => {
        if (path === auditedSource) {
          sourceOpens += 1;
          if (sourceOpens === 1) {
            reportFirstOpen();
            await firstOpenRelease;
          }
        }
        return open(path, flags, mode);
      },
    });
    const first = new StudioPluginInstaller({
      sourcePath: auditedSource,
      homeDirectory: harness.homeDirectory,
      io,
    });
    const second = new StudioPluginInstaller({
      sourcePath: auditedSource,
      homeDirectory: join(harness.homeDirectory, "."),
      io,
    });

    const firstInstall = first.install({ confirmReplace: false });
    await firstOpenStarted;
    const secondInstall = second.install({ confirmReplace: false });
    await new Promise<void>((resolveImmediate) => setImmediate(resolveImmediate));
    const opensWhileFirstWasBlocked = sourceOpens;
    releaseFirstOpen();
    const results = await Promise.all([firstInstall, secondInstall]);
    expect(opensWhileFirstWasBlocked).toBe(1);
    expect(results.map((result) => result.changed).sort()).toEqual([false, true]);
  });

  it("releases the canonical destination lock after a rejected install", async () => {
    const harness = await pluginHarness();
    let linkCalls = 0;
    const io = createIo({
      link: async (existingPath, newPath) => {
        linkCalls += 1;
        if (linkCalls === 1) throw Object.assign(new Error("first link failed"), { code: "EIO" });
        await import("node:fs/promises").then(({ link: createLink }) => createLink(existingPath, newPath));
      },
    });
    const first = new StudioPluginInstaller({
      sourcePath: auditedSource,
      homeDirectory: harness.homeDirectory,
      io,
    });
    const second = new StudioPluginInstaller({
      sourcePath: auditedSource,
      homeDirectory: harness.homeDirectory,
      io,
    });

    const [firstResult, secondResult] = await Promise.allSettled([
      first.install({ confirmReplace: false }),
      second.install({ confirmReplace: false }),
    ]);

    const results = [firstResult, secondResult];
    expect(results.filter((result) => result.status === "rejected")).toEqual([
      expect.objectContaining({
        status: "rejected",
        reason: expect.objectContaining({ code: "plugin-install-io-failed" }),
      }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toEqual([
      expect.objectContaining({
        status: "fulfilled",
        value: expect.objectContaining({ state: "installed", changed: true }),
      }),
    ]);
    expect(linkCalls).toBe(2);
    expect(await digest(harness.destinationPath)).toBe(AUDITED_STUDIO_PLUGIN.sha256);
  });

  it("does not serialize installers with different canonical destinations", async () => {
    const firstHarness = await pluginHarness();
    const secondHarness = await pluginHarness();
    let blockedSourceOpens = 0;
    let reportBothSourceOpens!: () => void;
    let releaseSourceOpens!: () => void;
    const bothSourceOpensStarted = new Promise<void>((resolveStarted) => {
      reportBothSourceOpens = resolveStarted;
    });
    const sourceOpenRelease = new Promise<void>((resolveRelease) => {
      releaseSourceOpens = resolveRelease;
    });
    const io = createIo({
      open: async (path, flags, mode) => {
        if (path === auditedSource && blockedSourceOpens < 2) {
          blockedSourceOpens += 1;
          if (blockedSourceOpens === 2) reportBothSourceOpens();
          await sourceOpenRelease;
        }
        return open(path, flags, mode);
      },
    });
    const first = new StudioPluginInstaller({
      sourcePath: auditedSource,
      homeDirectory: firstHarness.homeDirectory,
      io,
    });
    const second = new StudioPluginInstaller({
      sourcePath: auditedSource,
      homeDirectory: secondHarness.homeDirectory,
      io,
    });

    const firstInstall = first.install({ confirmReplace: false });
    const secondInstall = second.install({ confirmReplace: false });
    const installsSettled = Promise.allSettled([firstInstall, secondInstall]);
    let readinessTimeout: ReturnType<typeof setTimeout> | undefined;
    const readinessDeadline = new Promise<false>((resolveDeadline) => {
      readinessTimeout = setTimeout(() => resolveDeadline(false), 5_000);
    });
    let bothStartedBeforeDeadline = false;
    try {
      bothStartedBeforeDeadline = await Promise.race([bothSourceOpensStarted.then(() => true), readinessDeadline]);
    } finally {
      if (readinessTimeout !== undefined) clearTimeout(readinessTimeout);
      releaseSourceOpens();
      await installsSettled;
    }

    expect(
      bothStartedBeforeDeadline,
      "installers with different canonical destinations must reach the source audit concurrently",
    ).toBe(true);
    await Promise.all([firstInstall, secondInstall]);

    expect(blockedSourceOpens).toBe(2);
    expect(await digest(firstHarness.destinationPath)).toBe(AUDITED_STUDIO_PLUGIN.sha256);
    expect(await digest(secondHarness.destinationPath)).toBe(AUDITED_STUDIO_PLUGIN.sha256);
  }, 10_000);

  it("uses an exclusive missing-destination commit and cannot overwrite a destination that appears after inspection", async () => {
    const harness = await pluginHarness({ createPluginsDirectory: false });
    const io = createIo({
      mkdir: async (path) => {
        await mkdir(path);
        if (path === harness.pluginsDirectory) await writeFile(harness.destinationPath, "racer");
      },
    });
    const installer = new StudioPluginInstaller({
      sourcePath: auditedSource,
      homeDirectory: harness.homeDirectory,
      io,
    });

    await expectCode(installer.install({ confirmReplace: false }), "plugin-destination-changed");
    expect(await readFile(harness.destinationPath, "utf8")).toBe("racer");
  });

  it("creates missing directory components only through anchored direct-child operations", async () => {
    const harness = await pluginHarness({ createPluginsDirectory: false });

    await expect(harness.installer.install({ confirmReplace: false })).resolves.toMatchObject({
      state: "installed",
      changed: true,
      restartRequired: true,
    });

    expect(await digest(harness.destinationPath)).toBe(AUDITED_STUDIO_PLUGIN.sha256);
    expect((await lstat(harness.pluginsDirectory)).isDirectory()).toBe(true);
  });

  it.each([
    ["write-backup", "different"],
    ["write-temporary", "missing"],
    ["commit-missing", "missing"],
    ["commit-replacement", "different"],
  ] as const)(
    "pins the original Plugins directory when an ancestor is swapped immediately before %s",
    async (boundary, destination) => {
      const harness = await pluginHarness({ destination });
      const outsideDirectory = join(harness.root, "outside");
      const originalDirectory = join(harness.root, "original-plugins");
      const outsideSentinel = join(outsideDirectory, "outside-sentinel.txt");
      const outsideDestination = join(outsideDirectory, "MCPPlugin.rbxmx");
      await mkdir(outsideDirectory);
      await writeFile(outsideSentinel, "outside sentinel");
      if (boundary === "commit-replacement") await writeFile(outsideDestination, "outside destination");
      let swapped = false;
      const swapOnce = async () => {
        if (swapped) return;
        swapped = true;
        await rename(harness.pluginsDirectory, originalDirectory);
        await symlink(outsideDirectory, harness.pluginsDirectory);
      };
      const io = createIo({
        open: async (path, flags, mode) => {
          if (
            (boundary === "write-backup" && path.includes(".backup-")) ||
            (boundary === "write-temporary" && path.includes(".tmp-"))
          ) {
            await swapOnce();
          }
          return open(path, flags, mode);
        },
        link: async (existingPath, newPath) => {
          if (boundary === "commit-missing") await swapOnce();
          await import("node:fs/promises").then(({ link: createLink }) => createLink(existingPath, newPath));
        },
        rename: async (oldPath, newPath) => {
          if (boundary === "commit-replacement") await swapOnce();
          await rename(oldPath, newPath);
        },
      });
      const installer = new StudioPluginInstaller({
        sourcePath: auditedSource,
        homeDirectory: harness.homeDirectory,
        io,
        useAnchoredOperations: true,
        beforeAnchoredDirectoryOperation: async (operation) => {
          if (operation === boundary) await swapOnce();
        },
      });

      await expectCode(installer.install({ confirmReplace: true }), "plugin-path-invalid");
      expect(swapped).toBe(true);
      expect(await readFile(outsideSentinel, "utf8")).toBe("outside sentinel");
      if (boundary === "commit-replacement") {
        expect(await readFile(outsideDestination, "utf8")).toBe("outside destination");
      } else {
        await expect(lstat(outsideDestination)).rejects.toMatchObject({ code: "ENOENT" });
      }
      expect(
        (await readdir(outsideDirectory)).some((name) => name.includes(".backup-") || name.includes(".tmp-")),
      ).toBe(false);
    },
  );

  it.each(["identity", "digest"] as const)(
    "preserves the verified backup and aborts when destination %s changes before replacement commit",
    async (changeKind) => {
      const harness = await pluginHarness({
        destination: "different",
        now: () => Date.UTC(2024, 6, 28, 12, 34, 56),
      });
      const backupPath = join(harness.pluginsDirectory, "MCPPlugin.rbxmx.backup-20240728-123456");
      let changed = false;
      const io = createIo({
        open: async (path, flags, mode) => {
          const handle = await open(path, flags, mode);
          if (path !== backupPath) return handle;
          return wrapHandle(handle, {
            sync: async () => {
              await handle.sync();
              if (!changed) {
                changed = true;
                if (changeKind === "identity") await unlink(harness.destinationPath);
                await writeFile(harness.destinationPath, "replacement racer");
              }
            },
          });
        },
      });
      const installer = new StudioPluginInstaller({
        sourcePath: auditedSource,
        homeDirectory: harness.homeDirectory,
        now: () => Date.UTC(2024, 6, 28, 12, 34, 56),
        io,
      });

      await expectCode(installer.install({ confirmReplace: true }), "plugin-destination-changed");
      expect(await readFile(harness.destinationPath, "utf8")).toBe("replacement racer");
      expect(await readFile(backupPath, "utf8")).toBe("old plugin");
    },
  );

  it("cannot overwrite a destination created in the final exclusive-link race window", async () => {
    const harness = await pluginHarness();
    const io = createIo({
      link: async (existingPath, newPath) => {
        await writeFile(newPath, "last-window racer");
        await import("node:fs/promises").then(({ link: createLink }) => createLink(existingPath, newPath));
      },
    });
    const installer = new StudioPluginInstaller({
      sourcePath: auditedSource,
      homeDirectory: harness.homeDirectory,
      io,
    });

    await expectCode(installer.install({ confirmReplace: false }), "plugin-destination-changed");
    expect(await readFile(harness.destinationPath, "utf8")).toBe("last-window racer");
  });

  it("rechecks the inspector immediately before commit and never copies or deletes it", async () => {
    const harness = await pluginHarness();
    let created = false;
    const io = createIo({
      open: async (path, flags, mode) => {
        const handle = await open(path, flags, mode);
        if (!path.includes(".tmp-")) return handle;
        return wrapHandle(handle, {
          sync: async () => {
            await handle.sync();
            if (!created) {
              created = true;
              await writeFile(harness.inspectorPath, "late inspector");
            }
          },
        });
      },
    });
    const installer = new StudioPluginInstaller({
      sourcePath: auditedSource,
      homeDirectory: harness.homeDirectory,
      io,
    });

    await expectCode(installer.install({ confirmReplace: false }), "plugin-inspector-conflict");
    expect(await readFile(harness.inspectorPath, "utf8")).toBe("late inspector");
    await expect(lstat(harness.destinationPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("blocks an inspector that appears during the final retained source audit", async () => {
    const harness = await pluginHarness();
    let sourceOpens = 0;
    let created = false;
    const io = createIo({
      open: async (path, flags, mode) => {
        const handle = await open(path, flags, mode);
        if (path !== auditedSource) return handle;
        sourceOpens += 1;
        if (sourceOpens !== 3) return handle;
        return wrapHandle(handle, {
          close: async () => {
            await handle.close();
            if (!created) {
              created = true;
              await writeFile(harness.inspectorPath, "last-moment inspector");
            }
          },
        });
      },
    });
    const installer = new StudioPluginInstaller({
      sourcePath: auditedSource,
      homeDirectory: harness.homeDirectory,
      io,
    });

    await expectCode(installer.install({ confirmReplace: false }), "plugin-inspector-conflict");
    expect(await readFile(harness.inspectorPath, "utf8")).toBe("last-moment inspector");
    await expect(lstat(harness.destinationPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("revalidates the exact owned temporary identity immediately before commit", async () => {
    const harness = await pluginHarness();
    let sourceOpens = 0;
    let swapped = false;
    const io = createIo({
      open: async (path, flags, mode) => {
        const handle = await open(path, flags, mode);
        if (path !== auditedSource) return handle;
        sourceOpens += 1;
        if (sourceOpens !== 3) return handle;
        return wrapHandle(handle, {
          close: async () => {
            await handle.close();
            if (!swapped) {
              swapped = true;
              const temporaryName = (await readdir(harness.pluginsDirectory)).find((name) => name.includes(".tmp-"));
              if (temporaryName !== undefined) {
                const temporaryPath = join(harness.pluginsDirectory, temporaryName);
                await unlink(temporaryPath);
                await writeFile(temporaryPath, "temporary decoy");
              }
            }
          },
        });
      },
    });
    const installer = new StudioPluginInstaller({
      sourcePath: auditedSource,
      homeDirectory: harness.homeDirectory,
      io,
    });

    await expectCode(installer.install({ confirmReplace: false }), "plugin-temporary-verification-failed");
    await expect(lstat(harness.destinationPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(harness.pluginsDirectory)).some((name) => name.includes(".tmp-"))).toBe(true);
  });

  it("detects temporary-file corruption before commit", async () => {
    const harness = await pluginHarness();
    let corrupted = false;
    const io = createIo({
      open: async (path, flags, mode) => {
        const handle = await open(path, flags, mode);
        if (!path.includes(".tmp-")) return handle;
        return wrapHandle(handle, {
          sync: async () => {
            await handle.sync();
            if (!corrupted) {
              corrupted = true;
              const corruptor = await open(path, "r+");
              try {
                await corruptor.write(Buffer.from([0]), 0, 1, 0);
                await corruptor.sync();
              } finally {
                await corruptor.close();
              }
            }
          },
        });
      },
    });
    const installer = new StudioPluginInstaller({
      sourcePath: auditedSource,
      homeDirectory: harness.homeDirectory,
      io,
    });

    await expectCode(installer.install({ confirmReplace: false }), "plugin-temporary-verification-failed");
    await expect(lstat(harness.destinationPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(harness.pluginsDirectory)).filter((name) => name.includes(".tmp-"))).toHaveLength(1);
  });

  it("retains a decoy that replaced an interrupted owned temporary path", async () => {
    const harness = await pluginHarness();
    let tempPath = "";
    const io = createIo({
      open: async (path, flags, mode) => {
        const handle = await open(path, flags, mode);
        if (!path.includes(".tmp-")) return handle;
        tempPath = path;
        return wrapHandle(handle, {
          write: async (buffer, offset, length, position) => {
            await handle.write(buffer, offset, Math.min(length, 32), position);
            await unlink(path);
            await writeFile(path, "decoy");
            throw Object.assign(new Error("interrupted"), { code: "EIO" });
          },
        });
      },
    });
    const installer = new StudioPluginInstaller({
      sourcePath: auditedSource,
      homeDirectory: harness.homeDirectory,
      io,
    });

    await expectCode(installer.install({ confirmReplace: false }), "plugin-install-io-failed");
    expect(await readFile(tempPath, "utf8")).toBe("decoy");
    await expect(lstat(harness.destinationPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never unlinks a decoy swapped into the final cleanup window", async () => {
    const harness = await pluginHarness();
    let temporaryPath = "";
    let swapped = false;
    const io = createIo({
      open: async (path, flags, mode) => {
        const handle = await open(path, flags, mode);
        if (!path.includes(".tmp-")) return handle;
        temporaryPath = path;
        return wrapHandle(handle, {
          write: async (buffer, offset, length, position) => {
            await handle.write(buffer, offset, Math.min(length, 32), position);
            throw Object.assign(new Error("interrupted"), { code: "EIO" });
          },
        });
      },
      lstat: async (path) => {
        const before = await lstat(path);
        if (!swapped && path === temporaryPath) {
          swapped = true;
          await unlink(path);
          await writeFile(path, "final-window decoy");
        }
        return before;
      },
    });
    const installer = new StudioPluginInstaller({
      sourcePath: auditedSource,
      homeDirectory: harness.homeDirectory,
      io,
    });

    await expectCode(installer.install({ confirmReplace: false }), "plugin-install-io-failed");
    expect(await readFile(temporaryPath, "utf8")).toBe("final-window decoy");
  });

  it.each([
    ["temporary file", "temp"],
    ["backup file", "backup"],
  ] as const)("fails closed when %s fsync fails", async (_label, target) => {
    const harness = await pluginHarness({
      destination: target === "backup" ? "different" : "missing",
      now: () => Date.UTC(2024, 6, 28, 12, 34, 56),
    });
    const io = createIo({
      open: async (path, flags, mode) => {
        const handle = await open(path, flags, mode);
        const isTarget = target === "temp" ? path.includes(".tmp-") : path.includes(".backup-");
        return isTarget
          ? wrapHandle(handle, { sync: () => Promise.reject(Object.assign(new Error("fsync"), { code: "EIO" })) })
          : handle;
      },
    });
    const installer = new StudioPluginInstaller({
      sourcePath: auditedSource,
      homeDirectory: harness.homeDirectory,
      now: () => Date.UTC(2024, 6, 28, 12, 34, 56),
      io,
    });

    await expectCode(installer.install({ confirmReplace: true }), "plugin-install-io-failed");
    expect((await readdir(harness.pluginsDirectory)).some((name) => name.includes(".tmp-"))).toBe(target === "temp");
    if (target === "backup") {
      expect((await readdir(harness.pluginsDirectory)).some((name) => name.includes(".backup-"))).toBe(true);
      expect(await readFile(harness.destinationPath, "utf8")).toBe("old plugin");
    }
  });

  it("fails closed on a backup-name collision without overwriting it", async () => {
    const harness = await pluginHarness({
      destination: "different",
      now: () => Date.UTC(2024, 6, 28, 12, 34, 56),
    });
    const backupPath = join(harness.pluginsDirectory, "MCPPlugin.rbxmx.backup-20240728-123456");
    await writeFile(backupPath, "existing backup");

    await expectCode(harness.installer.install({ confirmReplace: true }), "plugin-backup-collision");
    expect(await readFile(backupPath, "utf8")).toBe("existing backup");
    expect(await readFile(harness.destinationPath, "utf8")).toBe("old plugin");
  });

  it("revalidates the exact owned backup after its directory fsync and preserves a decoy", async () => {
    const harness = await pluginHarness({
      destination: "different",
      now: () => Date.UTC(2024, 6, 28, 12, 34, 56),
    });
    const backupPath = join(harness.pluginsDirectory, "MCPPlugin.rbxmx.backup-20240728-123456");
    let swapped = false;
    const io = createIo({
      open: async (path, flags, mode) => {
        const handle = await open(path, flags, mode);
        if (path !== harness.pluginsDirectory) return handle;
        return wrapHandle(handle, {
          sync: async () => {
            await handle.sync();
            if (!swapped) {
              swapped = true;
              await unlink(backupPath);
              await writeFile(backupPath, "backup decoy");
            }
          },
        });
      },
    });
    const installer = new StudioPluginInstaller({
      sourcePath: auditedSource,
      homeDirectory: harness.homeDirectory,
      now: () => Date.UTC(2024, 6, 28, 12, 34, 56),
      io,
    });

    await expectCode(installer.install({ confirmReplace: true }), "plugin-install-io-failed");
    expect(await readFile(harness.destinationPath, "utf8")).toBe("old plugin");
    expect(await readFile(backupPath, "utf8")).toBe("backup decoy");
  });

  it.each([
    ["hard-link commit", "link"],
    ["replacement rename", "rename"],
  ] as const)("surfaces %s failure without claiming installation", async (_label, operation) => {
    const harness = await pluginHarness({ destination: operation === "rename" ? "different" : "missing" });
    const io = createIo({
      ...(operation === "link"
        ? { link: () => Promise.reject(Object.assign(new Error("link failed"), { code: "EIO" })) }
        : { rename: () => Promise.reject(Object.assign(new Error("rename failed"), { code: "EIO" })) }),
    });
    const installer = new StudioPluginInstaller({
      sourcePath: auditedSource,
      homeDirectory: harness.homeDirectory,
      io,
    });

    await expectCode(installer.install({ confirmReplace: true }), "plugin-install-io-failed");
    if (operation === "link") await expect(lstat(harness.destinationPath)).rejects.toMatchObject({ code: "ENOENT" });
    else expect(await readFile(harness.destinationPath, "utf8")).toBe("old plugin");
  });

  it("reports an indeterminate stable error when directory fsync fails after commit and keeps the audited install", async () => {
    const harness = await pluginHarness();
    let directorySyncs = 0;
    const io = createIo({
      open: async (path, flags, mode) => {
        const handle = await open(path, flags, mode);
        if (path !== harness.pluginsDirectory) return handle;
        return wrapHandle(handle, {
          sync: async () => {
            directorySyncs += 1;
            throw Object.assign(new Error("directory fsync failed"), { code: "EIO" });
          },
        });
      },
    });
    const installer = new StudioPluginInstaller({
      sourcePath: auditedSource,
      homeDirectory: harness.homeDirectory,
      io,
    });

    await expectCode(installer.install({ confirmReplace: false }), "plugin-commit-indeterminate");
    expect(directorySyncs).toBe(1);
    expect(await digest(harness.destinationPath)).toBe(AUDITED_STUDIO_PLUGIN.sha256);
  });

  it("caps installer-owned retained partials across repeated failures and releases the global lock after rejection", async () => {
    const harness = await pluginHarness();
    const installer = new StudioPluginInstaller({
      sourcePath: auditedSource,
      homeDirectory: harness.homeDirectory,
      beforeAnchoredDirectoryOperation: (operation) => {
        if (operation === "commit-missing") throw new Error("injected pre-commit failure");
      },
    });

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await expectCode(installer.install({ confirmReplace: false }), "plugin-install-io-failed");
    }
    let limitFailure: PluginInstallError | undefined;
    try {
      await installer.install({ confirmReplace: false });
    } catch (error) {
      limitFailure = error as PluginInstallError;
    }
    expect(limitFailure).toMatchObject({ code: "plugin-retained-partial-limit" });
    expect(limitFailure?.message).toMatch(/Show Plugins folder.*manually/i);
    const retained = await ownedPartials(harness.pluginsDirectory);
    expect(retained).toHaveLength(4);
    expect(limitFailure?.message).toContain(retained[0]!);
    const retainedBytes = (
      await Promise.all(retained.map((name) => stat(join(harness.pluginsDirectory, name))))
    ).reduce((total, entry) => total + entry.size, 0);
    expect(retainedBytes).toBeLessThanOrEqual(24 * 1024 * 1024);

    await unlink(join(harness.pluginsDirectory, retained[0]!));
    const unlockedInstaller = new StudioPluginInstaller({
      sourcePath: auditedSource,
      homeDirectory: harness.homeDirectory,
    });
    await expect(unlockedInstaller.install({ confirmReplace: false })).resolves.toMatchObject({
      state: "installed",
      changed: true,
    });
    expect(await ownedPartials(harness.pluginsDirectory)).toHaveLength(4);
  });

  it("enforces both retained-partial count and byte caps before creating another file", async () => {
    const countHarness = await pluginHarness();
    for (let index = 0; index < 4; index += 1) {
      await writeFile(
        join(countHarness.pluginsDirectory, `.MCPPlugin.rbxmx.tmp-${index.toString(16).padStart(24, "0")}`),
        "x",
      );
    }
    await expectCode(countHarness.installer.install({ confirmReplace: false }), "plugin-retained-partial-limit");
    expect(await ownedPartials(countHarness.pluginsDirectory)).toHaveLength(4);

    const bytesHarness = await pluginHarness();
    for (let index = 0; index < 2; index += 1) {
      await writeFile(
        join(bytesHarness.pluginsDirectory, `.MCPPlugin.rbxmx.tmp-${(index + 8).toString(16).padStart(24, "0")}`),
        "",
      );
      await truncate(
        join(bytesHarness.pluginsDirectory, `.MCPPlugin.rbxmx.tmp-${(index + 8).toString(16).padStart(24, "0")}`),
        12 * 1024 * 1024,
      );
    }
    await expectCode(bytesHarness.installer.install({ confirmReplace: false }), "plugin-retained-partial-limit");
    expect(await ownedPartials(bytesHarness.pluginsDirectory)).toHaveLength(2);

    const replacementHarness = await pluginHarness({
      destination: "different",
      now: () => Date.UTC(2024, 6, 28, 12, 34, 56),
    });
    for (let index = 0; index < 3; index += 1) {
      await writeFile(
        join(
          replacementHarness.pluginsDirectory,
          `.MCPPlugin.rbxmx.tmp-${(index + 12).toString(16).padStart(24, "0")}`,
        ),
        "x",
      );
    }
    await expectCode(replacementHarness.installer.install({ confirmReplace: true }), "plugin-retained-partial-limit");
    expect(await ownedPartials(replacementHarness.pluginsDirectory)).toHaveLength(3);
    await expect(
      lstat(join(replacementHarness.pluginsDirectory, "MCPPlugin.rbxmx.backup-20240728-123456")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(replacementHarness.destinationPath, "utf8")).toBe("old plugin");
  });

  it("ignores unrelated and lookalike names while counting successful staging predictably", async () => {
    const harness = await pluginHarness();
    for (const name of [
      ".MCPPlugin.rbxmx.tmp-not-hex",
      ".MCPPlugin.rbxmx.tmp-00000000000000000000000g",
      ".MCPPlugin.rbxmx.tmp-000000000000000000000000-extra",
      "MCPPlugin.rbxmx.backup-20240728-123456",
    ]) {
      await writeFile(join(harness.pluginsDirectory, name), "unrelated");
    }

    await expect(harness.installer.install({ confirmReplace: false })).resolves.toMatchObject({
      state: "installed",
      changed: true,
    });
    expect(await ownedPartials(harness.pluginsDirectory)).toHaveLength(1);
    await expect(harness.installer.install({ confirmReplace: false })).resolves.toMatchObject({
      state: "installed",
      changed: false,
    });
    expect(await ownedPartials(harness.pluginsDirectory)).toHaveLength(1);
  });

  it.each([
    [
      "hard-link then timeout",
      "missing",
      () => ({
        stdout: "",
        stderr: "",
        status: null,
        signal: null,
        error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }),
      }),
    ],
    [
      "rename then signal crash",
      "different",
      () => ({ stdout: "", stderr: "", status: null, signal: "SIGKILL" as const }),
    ],
    [
      "hard-link then spawn result error",
      "missing",
      () => ({
        stdout: "",
        stderr: "",
        status: null,
        signal: null,
        error: Object.assign(new Error("spawn result failed"), { code: "EIO" }),
      }),
    ],
    ["hard-link then invalid output", "missing", () => ({ stdout: "not-json", stderr: "", status: 0, signal: null })],
    ["rename then truncated output", "different", () => ({ stdout: '{"ok":', stderr: "", status: 0, signal: null })],
  ] as const)("treats an anchored helper %s as an indeterminate commit", async (_label, destination, fault) => {
    const harness = await pluginHarness({ destination });
    const installer = new StudioPluginInstaller({
      sourcePath: auditedSource,
      homeDirectory: harness.homeDirectory,
      anchoredHelperRunnerForTesting: (operation, runDefault) => {
        const completed = runDefault();
        return operation === "commit" ? fault() : completed;
      },
    });

    let failure: PluginInstallError | undefined;
    try {
      await installer.install({ confirmReplace: true });
    } catch (error) {
      failure = error as PluginInstallError;
    }
    expect(failure).toMatchObject({ code: "plugin-commit-indeterminate" });
    expect(failure?.message).toMatch(/reinspect/i);
    expect(failure?.message).not.toMatch(/rolled back|rollback/i);
    expect(await digest(harness.destinationPath)).toBe(AUDITED_STUDIO_PLUGIN.sha256);
  });

  it.each([
    ["empty success payload", () => ({ ok: true })],
    [
      "success payload missing its digest",
      (valid: Record<string, unknown>) => ({ ok: true, snapshot: valid.snapshot }),
    ],
    [
      "success payload with a malformed snapshot",
      (valid: Record<string, unknown>) => ({
        ok: true,
        snapshot: {
          ...(valid.snapshot as Record<string, unknown>),
          size: AUDITED_STUDIO_PLUGIN.size + 1,
        },
        sha256: valid.sha256,
      }),
    ],
    [
      "success payload with a malformed digest",
      (valid: Record<string, unknown>) => ({
        ok: true,
        snapshot: valid.snapshot,
        sha256: "0".repeat(64),
      }),
    ],
  ] as const)("treats an anchored helper %s as an indeterminate commit", async (_label, transform) => {
    const harness = await pluginHarness();
    const installer = new StudioPluginInstaller({
      sourcePath: auditedSource,
      homeDirectory: harness.homeDirectory,
      anchoredHelperRunnerForTesting: (operation, runDefault) => {
        const completed = runDefault();
        if (operation !== "commit") return completed;
        const valid = JSON.parse(completed.stdout) as Record<string, unknown>;
        return { ...completed, stdout: JSON.stringify(transform(valid)) };
      },
    });

    await expectCode(installer.install({ confirmReplace: false }), "plugin-commit-indeterminate");
    expect(await digest(harness.destinationPath)).toBe(AUDITED_STUDIO_PLUGIN.sha256);
  });

  it("accepts a complete valid helper success payload at the direct helper seam", async () => {
    const harness = await pluginHarness();
    const installer = new StudioPluginInstaller({
      sourcePath: auditedSource,
      homeDirectory: harness.homeDirectory,
      anchoredHelperRunnerForTesting: (operation, runDefault) => {
        const completed = runDefault();
        if (operation !== "commit") return completed;
        const valid = JSON.parse(completed.stdout) as Record<string, unknown>;
        return {
          ...completed,
          stdout: JSON.stringify({
            ok: true,
            snapshot: valid.snapshot,
            sha256: valid.sha256,
          }),
        };
      },
    });

    await expect(installer.install({ confirmReplace: false })).resolves.toMatchObject({
      state: "installed",
      changed: true,
      destinationSha256: AUDITED_STUDIO_PLUGIN.sha256,
    });
  });

  it("keeps a valid structured pre-mutation path error definitive for commit dispatch", async () => {
    const harness = await pluginHarness();
    const installer = new StudioPluginInstaller({
      sourcePath: auditedSource,
      homeDirectory: harness.homeDirectory,
      anchoredHelperRunnerForTesting: (operation, runDefault) => {
        if (operation !== "commit") return runDefault();
        return {
          stdout: JSON.stringify({
            ok: false,
            code: "plugin-path-invalid",
            message: "The anchored directory changed before mutation.",
          }),
          stderr: "",
          status: 1,
          signal: null,
        };
      },
    });

    await expectCode(installer.install({ confirmReplace: false }), "plugin-path-invalid");
    await expect(lstat(harness.destinationPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects oversized and sparse existing plugins before allocating or writing", async () => {
    const harness = await pluginHarness();
    await writeFile(harness.destinationPath, "");
    await truncate(harness.destinationPath, 16 * 1024 * 1024 + 1);

    await expect(harness.installer.inspect()).resolves.toMatchObject({
      state: "error",
      detail: expect.stringMatching(/16 MiB.*too large/i),
    });
    await expectCode(harness.installer.install({ confirmReplace: true }), "plugin-file-too-large");
    expect((await stat(harness.destinationPath)).size).toBe(16 * 1024 * 1024 + 1);
    expect(await ownedPartials(harness.pluginsDirectory)).toHaveLength(0);
  });

  it("rejects an oversized sparse temporary in the anchored helper before allocation or commit", async () => {
    const harness = await pluginHarness();
    let enlarged = false;
    const installer = new StudioPluginInstaller({
      sourcePath: auditedSource,
      homeDirectory: harness.homeDirectory,
      beforeAnchoredDirectoryOperation: async (operation) => {
        if (operation !== "commit-missing" || enlarged) return;
        const temporaryName = (await ownedPartials(harness.pluginsDirectory))[0];
        expect(temporaryName).toBeDefined();
        await truncate(join(harness.pluginsDirectory, temporaryName!), 16 * 1024 * 1024 + 1);
        enlarged = true;
      },
    });

    await expectCode(installer.install({ confirmReplace: false }), "plugin-file-too-large");
    await expect(lstat(harness.destinationPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await stat(join(harness.pluginsDirectory, (await ownedPartials(harness.pluginsDirectory))[0]!))).size).toBe(
      16 * 1024 * 1024 + 1,
    );
  });

  it("rejects an oversized helper request before spawning or creating a staging file", async () => {
    const harness = await pluginHarness();
    const installer = new StudioPluginInstaller({
      sourcePath: auditedSource,
      homeDirectory: harness.homeDirectory,
      randomName: () => "a".repeat(70 * 1024),
    });

    await expectCode(installer.install({ confirmReplace: false }), "plugin-helper-payload-too-large");
    await expect(lstat(harness.destinationPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await ownedPartials(harness.pluginsDirectory)).toHaveLength(0);
  });

  it("maps permission failures during commit to the stable permission code", async () => {
    const harness = await pluginHarness();
    const io = createIo({
      link: () => Promise.reject(permissionError()),
    });
    const installer = new StudioPluginInstaller({
      sourcePath: auditedSource,
      homeDirectory: harness.homeDirectory,
      io,
    });

    await expectCode(installer.install({ confirmReplace: false }), "plugin-permission-denied");
  });
});

describe("PluginInstallError", () => {
  it("carries a stable machine-readable code", () => {
    expect(new PluginInstallError("plugin-install-io-failed", "failed")).toMatchObject({
      name: "PluginInstallError",
      code: "plugin-install-io-failed",
      message: "failed",
    });
  });
});
