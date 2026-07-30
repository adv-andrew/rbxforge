import { createHash } from "node:crypto";
import { mkdtemp, realpath, rename, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { UnifiedInstanceNode } from "@rbxforge/core";
import { describe, expect, test, vi } from "vitest";

import {
  createVsCodeFacade,
  type DisposablePort,
  type EventPort,
  type TreeDataProviderPort,
  type WorkspaceTextEditPort,
} from "./vscode-facade.js";

class Emitter<T> {
  readonly #listeners = new Set<(value: T) => void>();
  constructor(readonly onSubscribe: () => void = () => undefined) {}
  disposeCalls = 0;
  readonly event: EventPort<T> = (listener) => {
    this.onSubscribe();
    this.#listeners.add(listener);
    let disposed = false;
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        this.disposeCalls += 1;
        this.#listeners.delete(listener);
      },
    };
  };
  emit(value: T): void {
    for (const listener of this.#listeners) listener(value);
  }
  get listenerCount(): number {
    return this.#listeners.size;
  }
}

test("real runtime adapter maps callable tree events and TreeItem semantics", async () => {
  const changed = new Emitter<UnifiedInstanceNode | undefined>();
  let registered:
    | {
        readonly provider: {
          onDidChangeTreeData: EventPort<UnifiedInstanceNode | undefined>;
          getTreeItem(node: UnifiedInstanceNode): unknown;
        };
      }
    | undefined;
  class TreeItem {
    description: string | undefined;
    contextValue: string | undefined;
    iconPath: unknown;
    constructor(
      readonly label: string,
      readonly collapsibleState: number,
    ) {}
  }
  class ThemeIcon {
    constructor(readonly id: string) {}
  }
  const runtime = {
    TreeItem,
    ThemeIcon,
    TreeItemCollapsibleState: { None: 0, Collapsed: 1 },
    commands: { registerCommand: () => ({ dispose: () => undefined }), executeCommand: async () => undefined },
    window: {
      registerTreeDataProvider: (_id: string, provider: unknown) => {
        registered = { provider: provider as typeof registered extends { readonly provider: infer P } ? P : never };
        return { dispose: () => undefined };
      },
      createTreeView: () => {
        throw new Error("not used");
      },
      createStatusBarItem: () => {
        throw new Error("not used");
      },
      createOutputChannel: () => {
        throw new Error("not used");
      },
      showInformationMessage: async () => undefined,
      showWarningMessage: async () => undefined,
      showQuickPick: async () => undefined,
      showOpenDialog: async () => undefined,
      showTextDocument: async () => undefined,
    },
    env: { clipboard: { writeText: async () => undefined } },
    workspace: {
      ...workspaceLifecycle([]),
      openTextDocument: async () => undefined,
    },
  } as unknown as typeof import("vscode");
  const facade = createVsCodeFacade(runtime);
  const source: TreeDataProviderPort<UnifiedInstanceNode> = {
    onDidChangeTreeData: changed.event,
    getChildren: async () => [],
    getTreeItem: (node) => ({
      label: node.name,
      icon: "warning",
      contextValue: node.path,
      collapsibleState: "collapsed",
    }),
  };
  facade.registerTreeDataProvider("rbxforge.liveStudio", source);
  const node = {
    path: "game.Workspace",
    name: "Workspace",
    className: "Folder",
    ownership: "files",
    children: [],
    unsafeUnknownChildren: false,
    unsafeParent: false,
  } as const satisfies UnifiedInstanceNode;
  const item = registered?.provider.getTreeItem(node) as {
    readonly collapsibleState: number;
    readonly iconPath: { readonly id: string };
  };
  expect(item.collapsibleState).toBe(1);
  expect(item.iconPath.id).toBe("warning");
  let delivered = false;
  const disposable = registered?.provider.onDidChangeTreeData(() => {
    delivered = true;
  }) as DisposablePort;
  changed.emit(undefined);
  expect(delivered).toBe(true);
  disposable.dispose();
});

test("real adapter subscribes provenance listeners before scanning clean open documents", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "rbxforge-facade-provenance-")));
  const path = join(root, "main.lua");
  const text = "return 'clean'\n";
  await writeFile(path, text);
  const uri = fileUri(path);
  const document = {
    uri,
    version: 1,
    isDirty: false,
    getText: () => text,
  };
  const order: string[] = [];
  const harness = facadeRuntimeHarness({
    documents: [document],
    editor: {
      document,
      selection: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 0 },
      },
    },
    order,
  });

  const facade = createVsCodeFacade(harness.runtime);
  const selection = facade.activeSelection();

  const scan = order.indexOf("scan");
  expect(scan).toBeGreaterThan(-1);
  for (const subscription of [
    "subscribe:open",
    "subscribe:change",
    "subscribe:save",
    "subscribe:close",
    "subscribe:rename",
    "create-watcher:1",
  ]) {
    expect(order.indexOf(subscription)).toBeGreaterThanOrEqual(0);
    expect(order.indexOf(subscription)).toBeLessThan(scan);
  }
  expect(selection?.provenance).toBeDefined();
  facade.dispose();
});

test("real adapter rejects outside buffer provenance after a safe inode is restored before scanning", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "rbxforge-facade-provenance-")));
  const outside = await realpath(await mkdtemp(join(tmpdir(), "rbxforge-facade-outside-")));
  const path = join(root, "main.lua");
  const backup = join(root, "main.safe.lua");
  const outsidePath = join(outside, "outside.lua");
  await writeFile(path, "SAFE_DISK_BYTES_42");
  await writeFile(outsidePath, "OUTSIDE_BUFFER_BYTES_42");
  await rename(path, backup);
  await symlink(outsidePath, path);
  const uri = fileUri(path);
  const document = {
    uri,
    version: 1,
    isDirty: false,
    getText: () => "OUTSIDE_BUFFER_BYTES_42",
  };
  await unlink(path);
  await rename(backup, path);
  const harness = facadeRuntimeHarness({
    documents: [document],
    editor: {
      document,
      selection: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 0 },
      },
    },
  });

  const facade = createVsCodeFacade(harness.runtime);
  const selection = facade.activeSelection();

  expect(selection).toBeDefined();
  expect(selection?.document.text).toBe("OUTSIDE_BUFFER_BYTES_42");
  expect(selection?.provenance).toBeUndefined();
  facade.dispose();
});

describe("ignore policy invalidation wiring", () => {
  test("invalidates for files.exclude, workspace, UI file, and watcher events and disposes exactly once", () => {
    const harness = facadeRuntimeHarness();
    const facade = createVsCodeFacade(harness.runtime);
    let invalidations = 0;
    const subscription = facade.subscribeIgnorePolicyInvalidation(() => {
      invalidations += 1;
    });
    expect(harness.watchers).toHaveLength(2);

    harness.configuration.emit({
      affectsConfiguration: (key: string) => key === "search.exclude",
    });
    expect(invalidations).toBe(0);
    harness.configuration.emit({
      affectsConfiguration: (key: string) => key === "files.exclude",
    });
    harness.workspaceFolders.emit({});
    harness.created.emit({});
    harness.deleted.emit({});
    harness.renamed.emit({ files: [] });
    harness.watchers[1]!.created.emit(fileUri("/workspace/a.lua"));
    harness.watchers[1]!.changed.emit(fileUri("/workspace/a.lua"));
    harness.watchers[1]!.deleted.emit(fileUri("/workspace/a.lua"));
    expect(invalidations).toBe(8);

    subscription.dispose();
    subscription.dispose();
    harness.configuration.emit({
      affectsConfiguration: () => true,
    });
    harness.watchers[1]!.changed.emit(fileUri("/workspace/a.lua"));
    expect(invalidations).toBe(8);
    expect(harness.watchers[1]!.disposeCalls).toBe(1);
    expect(harness.configuration.listenerCount).toBe(0);
    expect(harness.workspaceFolders.listenerCount).toBe(0);
    expect(harness.created.listenerCount).toBe(0);
    expect(harness.deleted.listenerCount).toBe(0);
    // The remaining rename listener belongs to document provenance.
    expect(harness.renamed.listenerCount).toBe(1);

    facade.dispose();
    facade.dispose();
    expect(harness.watchers[0]!.disposeCalls).toBe(1);
    expect(harness.renamed.listenerCount).toBe(0);
  });

  test("fails closed and cleans partial listeners when watcher registration fails", () => {
    const harness = facadeRuntimeHarness({ failWatcherAt: 2 });
    const facade = createVsCodeFacade(harness.runtime);

    expect(() => facade.subscribeIgnorePolicyInvalidation(() => undefined)).toThrow("watcher unavailable");

    expect(harness.configuration.listenerCount).toBe(0);
    expect(harness.workspaceFolders.listenerCount).toBe(0);
    expect(harness.created.listenerCount).toBe(0);
    expect(harness.deleted.listenerCount).toBe(0);
    expect(harness.renamed.listenerCount).toBe(1);
    facade.dispose();
    expect(harness.renamed.listenerCount).toBe(0);
  });
});

describe("guarded WorkspaceEdit submission", () => {
  test("returns synchronously without attempting a stale active document or consuming authorization", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "rbxforge-facade-")));
    const path = join(root, "main.lua");
    const before = "return false\n";
    await writeFile(path, before);
    const info = await stat(path);
    const authorize = vi.fn(() => true);
    const applyEdit = vi.fn(async () => true);
    const facade = createVsCodeFacade(
      workspaceEditRuntime({
        path,
        text: `${before}--changed`,
        version: 2,
        applyEdit,
      }),
    );
    const edits = [textEdit(path)];
    const request = Object.assign(
      {
        edits,
        files: [
          {
            path,
            expectedUri: `file://${path}`,
            canonicalPath: path,
            workspaceRoot: root,
            expectedVersion: 1,
            expectedSha256: sha(before),
            expectedDevice: info.dev.toString(),
            expectedInode: info.ino.toString(),
          },
        ],
        signal: new AbortController().signal,
        ignorePolicyAttestation: Object.freeze({}),
        isIgnorePolicyCurrent: () => true,
        authorize,
      },
      {
        *[Symbol.iterator]() {
          yield* edits;
        },
      },
    );

    const result = (facade.applyWorkspaceEdit as unknown as (value: typeof request) => unknown)(request);

    expect(result).toMatchObject({ attempted: false });
    expect(authorize).toHaveBeenCalledTimes(0);
    expect(applyEdit).toHaveBeenCalledTimes(0);
  });

  test("checks ignore-policy currentness immediately before authorization", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "rbxforge-facade-")));
    const path = join(root, "main.lua");
    const before = "return false\n";
    await writeFile(path, before);
    const info = await stat(path);
    const authorize = vi.fn(() => true);
    const applyEdit = vi.fn(async () => true);
    const isIgnorePolicyCurrent = vi.fn(() => false);
    const facade = createVsCodeFacade(
      workspaceEditRuntime({
        path,
        text: before,
        version: 1,
        applyEdit,
      }),
    );

    const result = facade.applyWorkspaceEdit({
      edits: [textEdit(path)],
      files: [
        {
          path,
          expectedUri: `file://${path}`,
          canonicalPath: path,
          workspaceRoot: root,
          expectedVersion: 1,
          expectedSha256: sha(before),
          expectedDevice: info.dev.toString(),
          expectedInode: info.ino.toString(),
        },
      ],
      signal: new AbortController().signal,
      ignorePolicyAttestation: Object.freeze({}),
      isIgnorePolicyCurrent,
      authorize,
    });

    expect(result).toMatchObject({ attempted: false, reason: "changed" });
    expect(isIgnorePolicyCurrent).toHaveBeenCalledTimes(1);
    expect(authorize).toHaveBeenCalledTimes(0);
    expect(applyEdit).toHaveBeenCalledTimes(0);
    facade.dispose();
  });

  test("prebuilds edits, authorizes, and invokes applyEdit adjacently in one synchronous stack", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "rbxforge-facade-")));
    const path = join(root, "main.lua");
    const before = "return false\n";
    await writeFile(path, before);
    const info = await stat(path);
    const order: string[] = [];
    const authorize = vi.fn(() => {
      order.push("authorize");
      return true;
    });
    const applyEdit = vi.fn(() => {
      order.push("apply");
      return Promise.resolve(true);
    });
    const facade = createVsCodeFacade(
      workspaceEditRuntime({
        path,
        text: before,
        version: 1,
        applyEdit,
        onReplace: () => order.push("prebuild"),
      }),
    );
    const edits = [textEdit(path)];
    const request = Object.assign(
      {
        edits,
        files: [
          {
            path,
            expectedUri: `file://${path}`,
            canonicalPath: path,
            workspaceRoot: root,
            expectedVersion: 1,
            expectedSha256: sha(before),
            expectedDevice: info.dev.toString(),
            expectedInode: info.ino.toString(),
          },
        ],
        signal: new AbortController().signal,
        ignorePolicyAttestation: Object.freeze({}),
        isIgnorePolicyCurrent: () => true,
        authorize,
      },
      {
        *[Symbol.iterator]() {
          yield* edits;
        },
      },
    );

    const result = (
      facade.applyWorkspaceEdit as unknown as (value: typeof request) => {
        readonly attempted: boolean;
        readonly completion?: PromiseLike<boolean>;
      }
    )(request);

    expect(result.attempted).toBe(true);
    expect(order).toEqual(["prebuild", "authorize", "apply"]);
    await expect(result.completion).resolves.toBe(true);
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(applyEdit).toHaveBeenCalledTimes(1);
  });

  test.each(["symlink-swap", "cancelled"] as const)(
    "does not attempt the real adapter submission after %s",
    async (testCase) => {
      const root = await realpath(await mkdtemp(join(tmpdir(), "rbxforge-facade-")));
      const outside = await realpath(await mkdtemp(join(tmpdir(), "rbxforge-facade-outside-")));
      const path = join(root, "main.lua");
      const before = "return false\n";
      await writeFile(path, before);
      await writeFile(join(outside, "outside.lua"), before);
      const info = await stat(path);
      const controller = new AbortController();
      if (testCase === "symlink-swap") {
        await rename(path, join(root, "main.backup.lua"));
        await symlink(join(outside, "outside.lua"), path);
      } else {
        controller.abort(new Error("Stop"));
      }
      const authorize = vi.fn(() => true);
      const applyEdit = vi.fn(async () => true);
      const facade = createVsCodeFacade(
        workspaceEditRuntime({
          path,
          text: before,
          version: 1,
          applyEdit,
        }),
      );

      const result = facade.applyWorkspaceEdit({
        edits: [textEdit(path)],
        files: [
          {
            path,
            expectedUri: `file://${path}`,
            canonicalPath: path,
            workspaceRoot: root,
            expectedVersion: 1,
            expectedSha256: sha(before),
            expectedDevice: info.dev.toString(),
            expectedInode: info.ino.toString(),
          },
        ],
        signal: controller.signal,
        ignorePolicyAttestation: Object.freeze({}),
        isIgnorePolicyCurrent: () => true,
        authorize,
      });

      expect(result).toMatchObject({
        attempted: false,
        reason: testCase === "cancelled" ? "cancelled" : "changed",
      });
      expect(authorize).toHaveBeenCalledTimes(0);
      expect(applyEdit).toHaveBeenCalledTimes(0);
    },
  );
});

function textEdit(path: string): WorkspaceTextEditPort {
  return {
    path,
    range: {
      start: { line: 0, character: 7 },
      end: { line: 0, character: 12 },
    },
    newText: "true",
  };
}

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function workspaceEditRuntime(
  options: Readonly<{
    path: string;
    text: string;
    version: number;
    applyEdit: (edit: unknown) => PromiseLike<boolean>;
    onReplace?: () => void;
  }>,
): typeof import("vscode") {
  class Position {
    constructor(
      readonly line: number,
      readonly character: number,
    ) {}
  }
  class Range {
    constructor(
      readonly start: Position,
      readonly end: Position,
    ) {}
  }
  class WorkspaceEdit {
    replace(): void {
      options.onReplace?.();
    }
  }
  const uri = {
    scheme: "file",
    fsPath: options.path,
    toString: () => `file://${options.path}`,
  };
  return {
    Position,
    Range,
    WorkspaceEdit,
    Uri: {
      file: () => uri,
    },
    workspace: {
      ...workspaceLifecycle([
        {
          uri,
          version: options.version,
          isDirty: false,
          getText: () => options.text,
        },
      ]),
      textDocuments: [
        {
          uri,
          version: options.version,
          isDirty: false,
          getText: () => options.text,
        },
      ],
      applyEdit: options.applyEdit,
    },
  } as unknown as typeof import("vscode");
}

function workspaceLifecycle(textDocuments: readonly unknown[]) {
  const event = () => ({ dispose: () => undefined });
  return {
    textDocuments,
    onDidOpenTextDocument: event,
    onDidChangeTextDocument: event,
    onDidSaveTextDocument: event,
    onDidCloseTextDocument: event,
    onDidRenameFiles: event,
    onDidChangeConfiguration: event,
    onDidChangeWorkspaceFolders: event,
    onDidCreateFiles: event,
    onDidDeleteFiles: event,
    createFileSystemWatcher: () => ({
      onDidCreate: event,
      onDidChange: event,
      onDidDelete: event,
      dispose: () => undefined,
    }),
  };
}

class FakeWatcher {
  readonly created = new Emitter<ReturnType<typeof fileUri>>();
  readonly changed = new Emitter<ReturnType<typeof fileUri>>();
  readonly deleted = new Emitter<ReturnType<typeof fileUri>>();
  readonly onDidCreate = this.created.event;
  readonly onDidChange = this.changed.event;
  readonly onDidDelete = this.deleted.event;
  disposeCalls = 0;
  dispose(): void {
    if (this.disposeCalls === 0) this.disposeCalls = 1;
  }
}

function fileUri(path: string) {
  return {
    scheme: "file",
    fsPath: path,
    toString: () => `file://${path}`,
  };
}

function facadeRuntimeHarness(
  options: Readonly<{
    documents?: readonly unknown[];
    editor?: unknown;
    order?: string[];
    failWatcherAt?: number;
  }> = {},
) {
  const order = options.order ?? [];
  const opened = new Emitter<unknown>(() => order.push("subscribe:open"));
  const changedDocuments = new Emitter<unknown>(() => order.push("subscribe:change"));
  const saved = new Emitter<unknown>(() => order.push("subscribe:save"));
  const closed = new Emitter<unknown>(() => order.push("subscribe:close"));
  const renamed = new Emitter<unknown>(() => order.push("subscribe:rename"));
  const configuration = new Emitter<
    Readonly<{
      affectsConfiguration(key: string): boolean;
    }>
  >();
  const workspaceFolders = new Emitter<unknown>();
  const created = new Emitter<unknown>();
  const deleted = new Emitter<unknown>();
  const watchers: FakeWatcher[] = [];
  const workspace: Record<string, unknown> = {
    onDidOpenTextDocument: opened.event,
    onDidChangeTextDocument: changedDocuments.event,
    onDidSaveTextDocument: saved.event,
    onDidCloseTextDocument: closed.event,
    onDidRenameFiles: renamed.event,
    onDidChangeConfiguration: configuration.event,
    onDidChangeWorkspaceFolders: workspaceFolders.event,
    onDidCreateFiles: created.event,
    onDidDeleteFiles: deleted.event,
    createFileSystemWatcher: () => {
      const ordinal = watchers.length + 1;
      order.push(`create-watcher:${ordinal}`);
      if (options.failWatcherAt === ordinal) throw new Error("watcher unavailable");
      const watcher = new FakeWatcher();
      watchers.push(watcher);
      return watcher;
    },
  };
  Object.defineProperty(workspace, "textDocuments", {
    enumerable: true,
    get: () => {
      order.push("scan");
      return options.documents ?? [];
    },
  });
  const runtime = {
    workspace,
    window: {
      activeTextEditor: options.editor,
    },
  } as unknown as typeof import("vscode");
  return {
    runtime,
    opened,
    changedDocuments,
    saved,
    closed,
    renamed,
    configuration,
    workspaceFolders,
    created,
    deleted,
    watchers,
  };
}
