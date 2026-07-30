import { createHash } from "node:crypto";
import { lstatSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";

import { isSensitivePath, type FileSnapshotProvenanceAttestation, type IgnorePolicyAttestation } from "@rbxforge/agent";
import type { UnifiedInstanceNode } from "@rbxforge/core";
import type * as Vscode from "vscode";

import { DocumentProvenanceRegistry } from "./document-provenance.js";

export interface DisposablePort {
  dispose(): void;
}
/** Mirrors VS Code's callable Event<T> shape rather than a Node-style emitter. */
export type EventPort<T> = (listener: (value: T) => void) => DisposablePort;
export interface TreeItemPort {
  readonly label: string;
  readonly description?: string;
  readonly icon?: string;
  readonly contextValue?: string;
  readonly collapsibleState: "none" | "collapsed";
}
export interface TreeDataProviderPort<T> {
  getChildren(element?: T): Promise<readonly T[]>;
  getTreeItem(element: T): TreeItemPort;
  readonly onDidChangeTreeData: EventPort<T | undefined>;
}
export interface TreeViewPort<T> extends DisposablePort {
  readonly visible: boolean;
  readonly onDidChangeVisibility: EventPort<{ readonly visible: boolean }>;
  readonly onDidExpandElement: EventPort<{ readonly element: T }>;
  readonly onDidCollapseElement: EventPort<{ readonly element: T }>;
}
export interface StatusBarItemPort extends DisposablePort {
  text: string;
  tooltip?: string | undefined;
  command?: string | undefined;
  show(): void;
  hide(): void;
}
export interface OutputChannelPort extends DisposablePort {
  appendLine(value: string): void;
  show(): void;
}
export interface WebviewPort {
  html: string;
  readonly cspSource: string;
  options: { readonly enableScripts: boolean; readonly localResourceRoots: readonly string[] };
  asWebviewUri(relativePath: string): string;
  postMessage(message: unknown): Promise<boolean>;
  readonly onDidReceiveMessage: EventPort<unknown>;
}
export interface WebviewViewPort {
  readonly webview: WebviewPort;
}
export interface WebviewViewProviderPort {
  resolveWebviewView(view: WebviewViewPort): Promise<void> | void;
}
export interface WebviewPanelPort extends DisposablePort {
  readonly webview: WebviewPort;
  readonly onDidDispose: EventPort<void>;
  reveal(): void;
}
export interface QuickPickItemPort {
  readonly label: string;
  readonly description?: string;
}
export interface PositionPort {
  readonly line: number;
  readonly character: number;
}
export interface RangePort {
  readonly start: PositionPort;
  readonly end: PositionPort;
}
export interface DocumentSnapshotPort {
  readonly path: string;
  readonly uri: string;
  readonly text: string;
  readonly version: number;
  readonly isDirty: boolean;
}
export interface WorkspaceTextEditPort {
  readonly path: string;
  readonly range: RangePort;
  readonly newText: string;
}
export interface WorkspaceEditFileExpectationPort {
  readonly path: string;
  readonly expectedUri: string;
  readonly canonicalPath: string;
  readonly workspaceRoot: string;
  readonly expectedVersion: number;
  readonly expectedSha256: string;
  readonly expectedDevice: string;
  readonly expectedInode: string;
}
export interface WorkspaceEditSubmissionPort {
  readonly edits: readonly WorkspaceTextEditPort[];
  readonly files: readonly WorkspaceEditFileExpectationPort[];
  readonly signal: AbortSignal;
  readonly ignorePolicyAttestation: IgnorePolicyAttestation;
  isIgnorePolicyCurrent(attestation: IgnorePolicyAttestation): boolean;
  authorize(): boolean;
}
export type WorkspaceEditSubmissionResultPort =
  | Readonly<{
      attempted: false;
      reason: "cancelled" | "changed" | "unauthorized";
    }>
  | Readonly<{
      attempted: true;
      completion: PromiseLike<boolean>;
    }>;
export interface ConfigurationInspectionPort<T> {
  readonly defaultValue?: T;
  readonly globalValue?: T;
  readonly workspaceValue?: T;
  readonly workspaceFolderValue?: T;
}
export interface DiagnosticPort {
  readonly path: string;
  readonly message: string;
  readonly severity: number;
  readonly range: RangePort;
}
export interface ActiveSelectionPort {
  readonly path: string;
  readonly range: RangePort;
  readonly document: DocumentSnapshotPort;
  readonly provenance?: FileSnapshotProvenanceAttestation;
}
export interface VsCodeFacade extends DisposablePort {
  registerCommand(id: string, handler: (...args: readonly unknown[]) => unknown): DisposablePort;
  registerTreeDataProvider(viewId: string, provider: TreeDataProviderPort<UnifiedInstanceNode>): DisposablePort;
  registerWebviewViewProvider(
    viewId: string,
    provider: WebviewViewProviderPort,
    options: { readonly extensionRoot: string },
  ): DisposablePort;
  createWebviewPanel(viewType: string, title: string, options: { readonly extensionRoot: string }): WebviewPanelPort;
  createTreeView<T>(viewId: string, options: { readonly treeDataProvider: TreeDataProviderPort<T> }): TreeViewPort<T>;
  createStatusBarItem(): StatusBarItemPort;
  createOutputChannel(name: string): OutputChannelPort;
  showInformationMessage(message: string, ...items: readonly string[]): Promise<string | undefined>;
  showWarningMessage(message: string): Promise<void>;
  showQuickPick(
    items: readonly QuickPickItemPort[],
    options: { readonly placeHolder: string },
  ): Promise<QuickPickItemPort | undefined>;
  showOpenDialog(options: {
    readonly canSelectFiles: boolean;
    readonly canSelectFolders: boolean;
    readonly canSelectMany: boolean;
  }): Promise<readonly { readonly fsPath: string }[] | undefined>;
  showInputBox(options: {
    readonly prompt: string;
    readonly password: boolean;
    readonly ignoreFocusOut: boolean;
  }): Promise<string | undefined>;
  executeCommand(id: string, ...args: readonly unknown[]): Promise<unknown>;
  writeClipboard(value: string): Promise<void>;
  openTextDocument(path: string): Promise<void>;
  secretGet(key: string): Promise<string | undefined>;
  secretStore(key: string, value: string): Promise<void>;
  secretDelete(key: string): Promise<void>;
  inspectConfiguration<T>(key: string): ConfigurationInspectionPort<T> | undefined;
  workspaceFolders(): readonly string[];
  activeSelection(): ActiveSelectionPort | undefined;
  diagnostics(path?: string): readonly DiagnosticPort[];
  documentSnapshot(path: string): Promise<DocumentSnapshotPort | undefined>;
  isPathIgnored(path: string): Promise<boolean>;
  subscribeIgnorePolicyInvalidation(listener: () => void): DisposablePort;
  registerVirtualTextDocumentProvider(scheme: string, provide: (uri: string) => string | undefined): DisposablePort;
  openDiff(leftPath: string, rightUri: string, title: string): Promise<void>;
  applyWorkspaceEdit(submission: WorkspaceEditSubmissionPort): WorkspaceEditSubmissionResultPort;
}

/** Adapts the real VS Code API at the only runtime boundary. */
export function createVsCodeFacade(vscode: typeof Vscode, secrets?: Vscode.SecretStorage): VsCodeFacade {
  const provider = <T>(source: TreeDataProviderPort<T>): Vscode.TreeDataProvider<T> => ({
    onDidChangeTreeData: source.onDidChangeTreeData,
    getChildren: async (element?: T) => [...(await source.getChildren(element))],
    getTreeItem: (element: T) => {
      const sourceItem = source.getTreeItem(element);
      const item = new vscode.TreeItem(
        sourceItem.label,
        sourceItem.collapsibleState === "collapsed"
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.None,
      );
      if (sourceItem.description !== undefined) item.description = sourceItem.description;
      if (sourceItem.contextValue !== undefined) item.contextValue = sourceItem.contextValue;
      if (sourceItem.icon !== undefined) item.iconPath = new vscode.ThemeIcon(sourceItem.icon);
      return item;
    },
  });
  const event =
    <T>(source: Vscode.Event<T>): EventPort<T> =>
    (listener) =>
      source(listener);
  const provenance = new DocumentProvenanceRegistry({
    documents: () => vscode.workspace.textDocuments,
    onDidOpen: event(vscode.workspace.onDidOpenTextDocument),
    onDidChange: event(vscode.workspace.onDidChangeTextDocument),
    onDidSave: event(vscode.workspace.onDidSaveTextDocument),
    onDidClose: event(vscode.workspace.onDidCloseTextDocument),
    onDidRename: (listener) =>
      vscode.workspace.onDidRenameFiles((change) => {
        for (const file of change.files) {
          listener({
            oldPath: file.oldUri.fsPath,
            newPath: file.newUri.fsPath,
          });
        }
      }),
    onDidFileChange: (listener) => watchWorkspaceFiles(vscode, listener),
  });
  const wrapWebview = (source: Vscode.Webview, extensionRoot: string): WebviewPort => ({
    get html() {
      return source.html;
    },
    set html(value: string) {
      source.html = value;
    },
    get cspSource() {
      return source.cspSource;
    },
    get options() {
      const roots = source.options.localResourceRoots?.map((uri) => uri.fsPath) ?? [];
      return { enableScripts: source.options.enableScripts ?? false, localResourceRoots: roots };
    },
    set options(value) {
      source.options = {
        enableScripts: value.enableScripts,
        localResourceRoots: value.localResourceRoots.map((root) =>
          vscode.Uri.joinPath(vscode.Uri.file(extensionRoot), ...root.split("/")),
        ),
      };
    },
    asWebviewUri: (relativePath) =>
      source.asWebviewUri(vscode.Uri.joinPath(vscode.Uri.file(extensionRoot), ...relativePath.split("/"))).toString(),
    postMessage: async (message) => source.postMessage(message),
    onDidReceiveMessage: event(source.onDidReceiveMessage),
  });
  return {
    registerCommand: (id, handler) =>
      vscode.commands.registerCommand(id, (...args: readonly unknown[]) => handler(...args)),
    registerTreeDataProvider: (viewId, source) => vscode.window.registerTreeDataProvider(viewId, provider(source)),
    registerWebviewViewProvider: (viewId, source, options) =>
      vscode.window.registerWebviewViewProvider(
        viewId,
        {
          resolveWebviewView: async (view) => {
            await source.resolveWebviewView({ webview: wrapWebview(view.webview, options.extensionRoot) });
          },
        },
        { webviewOptions: { retainContextWhenHidden: true } },
      ),
    createWebviewPanel: (viewType, title, options) => {
      const panel = vscode.window.createWebviewPanel(viewType, title, vscode.ViewColumn.Active, {
        enableScripts: true,
        retainContextWhenHidden: true,
      });
      return {
        webview: wrapWebview(panel.webview, options.extensionRoot),
        onDidDispose: event(panel.onDidDispose),
        reveal: () => panel.reveal(vscode.ViewColumn.Active),
        dispose: () => panel.dispose(),
      };
    },
    createTreeView: (viewId, options) => {
      const view = vscode.window.createTreeView(viewId, { treeDataProvider: provider(options.treeDataProvider) });
      return {
        get visible() {
          return view.visible;
        },
        onDidChangeVisibility: event(view.onDidChangeVisibility),
        onDidExpandElement: event(view.onDidExpandElement),
        onDidCollapseElement: event(view.onDidCollapseElement),
        dispose: () => view.dispose(),
      };
    },
    createStatusBarItem: () => {
      const item = vscode.window.createStatusBarItem();
      return {
        get text() {
          return item.text;
        },
        set text(value: string) {
          item.text = value;
        },
        get tooltip() {
          return typeof item.tooltip === "string" ? item.tooltip : undefined;
        },
        set tooltip(value: string | undefined) {
          item.tooltip = value;
        },
        get command() {
          return typeof item.command === "string" ? item.command : undefined;
        },
        set command(value: string | undefined) {
          item.command = value;
        },
        show: () => item.show(),
        hide: () => item.hide(),
        dispose: () => item.dispose(),
      };
    },
    createOutputChannel: (name) => vscode.window.createOutputChannel(name),
    showInformationMessage: async (message, ...items) => vscode.window.showInformationMessage(message, ...items),
    showWarningMessage: async (message) => {
      await vscode.window.showWarningMessage(message);
    },
    showQuickPick: async (items, options) => vscode.window.showQuickPick(items, options),
    showOpenDialog: async (options) => {
      const paths = await vscode.window.showOpenDialog(options);
      return paths?.map((path) => ({ fsPath: path.fsPath }));
    },
    showInputBox: async (options) => vscode.window.showInputBox(options),
    executeCommand: async (id, ...args) => vscode.commands.executeCommand(id, ...args),
    writeClipboard: async (value) => vscode.env.clipboard.writeText(value),
    openTextDocument: async (path) => {
      const document = await vscode.workspace.openTextDocument(path);
      await vscode.window.showTextDocument(document);
    },
    secretGet: async (key) => secrets?.get(key),
    secretStore: async (key, value) => {
      if (secrets === undefined) throw new Error("SecretStorage is unavailable");
      await secrets.store(key, value);
    },
    secretDelete: async (key) => {
      await secrets?.delete(key);
    },
    inspectConfiguration: <T>(key: string) => vscode.workspace.getConfiguration().inspect<T>(key),
    workspaceFolders: () => vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? [],
    activeSelection: () => {
      const editor = vscode.window.activeTextEditor;
      if (editor === undefined || editor.document.uri.scheme !== "file") return undefined;
      const documentProvenance = provenance.attest(editor.document);
      return {
        path: editor.document.uri.fsPath,
        document: {
          path: editor.document.uri.fsPath,
          uri: editor.document.uri.toString(),
          text: editor.document.getText(),
          version: editor.document.version,
          isDirty: editor.document.isDirty,
        },
        ...(documentProvenance === undefined ? {} : { provenance: documentProvenance }),
        range: {
          start: { line: editor.selection.start.line, character: editor.selection.start.character },
          end: { line: editor.selection.end.line, character: editor.selection.end.character },
        },
      };
    },
    diagnostics: (path) => {
      const groups =
        path === undefined
          ? vscode.languages.getDiagnostics()
          : [[vscode.Uri.file(path), vscode.languages.getDiagnostics(vscode.Uri.file(path))] as const];
      return groups.flatMap(([uri, diagnostics]) =>
        diagnostics.map((diagnostic) => ({
          path: uri.fsPath,
          message: diagnostic.message,
          severity: diagnostic.severity,
          range: {
            start: { line: diagnostic.range.start.line, character: diagnostic.range.start.character },
            end: { line: diagnostic.range.end.line, character: diagnostic.range.end.character },
          },
        })),
      );
    },
    documentSnapshot: async (path) => {
      try {
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(path));
        if (document.uri.scheme !== "file") return undefined;
        return {
          path: document.uri.fsPath,
          uri: document.uri.toString(),
          text: document.getText(),
          version: document.version,
          isDirty: document.isDirty,
        };
      } catch {
        return undefined;
      }
    },
    isPathIgnored: async (path) => {
      const uri = vscode.Uri.file(path);
      const folder = vscode.workspace.getWorkspaceFolder(uri);
      if (folder === undefined) return true;
      const relativePath = vscode.workspace.asRelativePath(uri, false);
      if (relativePath.length === 0 || relativePath === path || relativePath.startsWith("..")) return true;
      const matches = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, relativePath), undefined, 1);
      return !matches.some((match) => match.fsPath === uri.fsPath);
    },
    subscribeIgnorePolicyInvalidation: (listener) => subscribeIgnorePolicyInvalidation(vscode, listener),
    registerVirtualTextDocumentProvider: (scheme, provide) =>
      vscode.workspace.registerTextDocumentContentProvider(scheme, {
        provideTextDocumentContent: (uri) => provide(uri.toString()),
      }),
    openDiff: async (leftPath, rightUri, title) => {
      await vscode.commands.executeCommand(
        "vscode.diff",
        vscode.Uri.file(leftPath),
        vscode.Uri.parse(rightUri),
        title,
        { preview: true },
      );
    },
    applyWorkspaceEdit: (submission) => {
      if (submission.signal.aborted) {
        return Object.freeze({ attempted: false, reason: "cancelled" });
      }
      const workspaceEdit = new vscode.WorkspaceEdit();
      try {
        for (const edit of submission.edits) {
          workspaceEdit.replace(
            vscode.Uri.file(edit.path),
            new vscode.Range(
              new vscode.Position(edit.range.start.line, edit.range.start.character),
              new vscode.Position(edit.range.end.line, edit.range.end.character),
            ),
            edit.newText,
          );
        }
      } catch {
        return Object.freeze({ attempted: false, reason: "changed" });
      }
      if (!workspaceEditPreconditionsHold(submission, (path) => currentDocumentSnapshot(vscode, path))) {
        return Object.freeze({
          attempted: false,
          reason: submission.signal.aborted ? "cancelled" : "changed",
        });
      }
      if (!submission.authorize()) {
        return Object.freeze({
          attempted: false,
          reason: submission.signal.aborted ? "cancelled" : "unauthorized",
        });
      }
      return Object.freeze({
        attempted: true,
        completion: vscode.workspace.applyEdit(workspaceEdit),
      });
    },
    dispose: () => provenance.dispose(),
  };
}

export function workspaceEditPreconditionsHold(
  submission: WorkspaceEditSubmissionPort,
  currentDocument: (path: string) => DocumentSnapshotPort | undefined,
): boolean {
  if (submission.signal.aborted || submission.files.length === 0 || submission.edits.length === 0) {
    return false;
  }
  const files = new Map(submission.files.map((file) => [file.path, file]));
  if (files.size !== submission.files.length || submission.edits.some((edit) => !files.has(edit.path))) {
    return false;
  }
  try {
    for (const file of submission.files) {
      if (
        submission.signal.aborted ||
        file.path !== file.canonicalPath ||
        isSensitivePath(file.path) ||
        realpathSync(file.workspaceRoot) !== file.workspaceRoot ||
        !within(file.workspaceRoot, file.path)
      ) {
        return false;
      }
      const linkInfo = lstatSync(file.path, { bigint: true });
      if (linkInfo.isSymbolicLink() || !linkInfo.isFile()) return false;
      const canonical = realpathSync(file.path);
      if (canonical !== file.canonicalPath || isSensitivePath(canonical) || !within(file.workspaceRoot, canonical)) {
        return false;
      }
      const info = statSync(canonical, { bigint: true });
      if (!info.isFile() || info.dev.toString() !== file.expectedDevice || info.ino.toString() !== file.expectedInode) {
        return false;
      }
      const document = currentDocument(file.path);
      if (
        document === undefined ||
        document.path !== file.path ||
        document.uri !== file.expectedUri ||
        document.version !== file.expectedVersion ||
        createHash("sha256").update(document.text).digest("hex") !== file.expectedSha256
      ) {
        return false;
      }
    }
  } catch {
    return false;
  }
  return !submission.signal.aborted && submission.isIgnorePolicyCurrent(submission.ignorePolicyAttestation);
}

function currentDocumentSnapshot(vscode: typeof Vscode, path: string): DocumentSnapshotPort | undefined {
  const uri = vscode.Uri.file(path);
  const documents = vscode.workspace.textDocuments.filter(
    (document) =>
      document.uri.scheme === "file" && document.uri.fsPath === path && document.uri.toString() === uri.toString(),
  );
  if (documents.length !== 1) return undefined;
  const document = documents[0]!;
  return {
    path: document.uri.fsPath,
    uri: document.uri.toString(),
    text: document.getText(),
    version: document.version,
    isDirty: document.isDirty,
  };
}

function watchWorkspaceFiles(vscode: typeof Vscode, listener: (path: string) => void): DisposablePort {
  const disposables: DisposablePort[] = [];
  try {
    const watcher = vscode.workspace.createFileSystemWatcher("**/*");
    disposables.push(watcher);
    disposables.push(watcher.onDidCreate((uri) => listener(uri.fsPath)));
    disposables.push(watcher.onDidChange((uri) => listener(uri.fsPath)));
    disposables.push(watcher.onDidDelete((uri) => listener(uri.fsPath)));
    return disposeAllOnce(disposables);
  } catch (error: unknown) {
    disposeAllOnce(disposables).dispose();
    throw error;
  }
}

function subscribeIgnorePolicyInvalidation(vscode: typeof Vscode, listener: () => void): DisposablePort {
  const disposables: DisposablePort[] = [];
  try {
    disposables.push(
      vscode.workspace.onDidChangeConfiguration((change) => {
        if (change.affectsConfiguration("files.exclude")) listener();
      }),
    );
    disposables.push(vscode.workspace.onDidChangeWorkspaceFolders(listener));
    disposables.push(vscode.workspace.onDidCreateFiles(listener));
    disposables.push(vscode.workspace.onDidDeleteFiles(listener));
    disposables.push(vscode.workspace.onDidRenameFiles(listener));
    disposables.push(watchWorkspaceFiles(vscode, listener));
    return disposeAllOnce(disposables);
  } catch (error: unknown) {
    disposeAllOnce(disposables).dispose();
    throw error;
  }
}

function disposeAllOnce(disposables: readonly DisposablePort[]): DisposablePort {
  let disposed = false;
  return {
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const disposable of disposables) {
        try {
          disposable.dispose();
        } catch {
          // Listener disposal is best-effort but exhaustive.
        }
      }
    },
  };
}

function within(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}
