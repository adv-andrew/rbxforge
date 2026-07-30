import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";

import { issueFileSnapshotProvenance } from "@rbxforge/agent";
import type { UnifiedInstanceNode } from "@rbxforge/core";

import type {
  ActiveSelectionPort,
  ConfigurationInspectionPort,
  DiagnosticPort,
  DisposablePort,
  DocumentSnapshotPort,
  EventPort,
  OutputChannelPort,
  QuickPickItemPort,
  StatusBarItemPort,
  TreeDataProviderPort,
  TreeViewPort,
  VsCodeFacade,
  WebviewPanelPort,
  WebviewPort,
  WebviewViewProviderPort,
  WorkspaceEditSubmissionPort,
  WorkspaceEditSubmissionResultPort,
  WorkspaceTextEditPort,
} from "../vscode-facade.js";
import { workspaceEditPreconditionsHold } from "../vscode-facade.js";

class Emitter<T> implements EventPort<T> {
  readonly #listeners = new Set<(value: T) => void>();
  readonly event = (listener: (value: T) => void): DisposablePort => {
    this.#listeners.add(listener);
    return { dispose: () => this.#listeners.delete(listener) };
  };
  emit(value: T): void {
    for (const listener of this.#listeners) listener(value);
  }
}

export class FakeVsCode implements VsCodeFacade {
  readonly commands = new Map<string, (...args: readonly unknown[]) => unknown>();
  readonly executed: { id: string; args: readonly unknown[] }[] = [];
  readonly messages: string[] = [];
  readonly warnings: string[] = [];
  readonly clipboard: string[] = [];
  readonly documents: string[] = [];
  readonly trees = new Map<string, TreeDataProviderPort<UnifiedInstanceNode>>();
  readonly webviewProviders = new Map<
    string,
    { readonly provider: WebviewViewProviderPort; readonly extensionRoot: string }
  >();
  readonly treeViews: FakeTreeView<UnifiedInstanceNode>[] = [];
  readonly statusItems: FakeStatusBarItem[] = [];
  readonly outputs: string[] = [];
  readonly panels: FakeWebviewPanel[] = [];
  readonly secrets = new Map<string, string>();
  readonly configurations = new Map<string, ConfigurationInspectionPort<unknown>>();
  readonly documentSnapshots = new Map<string, DocumentSnapshotPort>();
  readonly ignoredPaths = new Set<string>();
  readonly virtualProviders = new Map<string, (uri: string) => string | undefined>();
  readonly diffs: { leftPath: string; rightUri: string; title: string }[] = [];
  readonly appliedEdits: WorkspaceTextEditPort[][] = [];
  readonly diagnosticEntries: DiagnosticPort[] = [];
  workspaceFolderPaths: readonly string[] = [];
  activeSelectionValue: ActiveSelectionPort | undefined;
  inputBoxResult: string | undefined;
  applyWorkspaceEditResult = true;
  applyWorkspaceEditError: Error | undefined;
  onDocumentSnapshot: ((path: string) => Promise<void> | void) | undefined;
  onBeforeWorkspaceEditBoundary: (() => void) | undefined;
  onApplyWorkspaceEdit: (() => void) | undefined;
  readonly quickPickEmitter = new Emitter<QuickPickItemPort | undefined>();
  readonly ignorePolicyEmitter = new Emitter<void>();
  readonly disposables: { disposed: boolean }[] = [];
  openDialogResult: readonly { readonly fsPath: string }[] | undefined;
  quickPickResult: QuickPickItemPort | undefined;

  registerCommand(id: string, handler: (...args: readonly unknown[]) => unknown): DisposablePort {
    this.commands.set(id, handler);
    return this.track(() => this.commands.delete(id));
  }
  registerTreeDataProvider(viewId: string, provider: TreeDataProviderPort<UnifiedInstanceNode>): DisposablePort {
    this.trees.set(viewId, provider);
    return this.track(() => this.trees.delete(viewId));
  }
  registerWebviewViewProvider(
    viewId: string,
    provider: WebviewViewProviderPort,
    options: { readonly extensionRoot: string },
  ): DisposablePort {
    this.webviewProviders.set(viewId, { provider, extensionRoot: options.extensionRoot });
    return this.track(() => this.webviewProviders.delete(viewId));
  }
  createWebviewPanel(_viewType: string, _title: string, options: { readonly extensionRoot: string }): WebviewPanelPort {
    const panel = new FakeWebviewPanel(options.extensionRoot);
    this.panels.push(panel);
    return panel;
  }
  async resolveWebview(viewId: string): Promise<FakeWebview> {
    const registration = this.webviewProviders.get(viewId);
    if (registration === undefined) throw new Error(`Unknown webview: ${viewId}`);
    const webview = new FakeWebview(registration.extensionRoot);
    await registration.provider.resolveWebviewView({ webview });
    return webview;
  }
  createTreeView<T>(
    _viewId: string,
    _options: { readonly treeDataProvider: TreeDataProviderPort<T> },
  ): TreeViewPort<T> {
    const view = new FakeTreeView<T>();
    if (isUnifiedTreeView<T>(view)) this.treeViews.push(view);
    return view;
  }
  createStatusBarItem(): StatusBarItemPort {
    const item = new FakeStatusBarItem();
    this.statusItems.push(item);
    return item;
  }
  createOutputChannel(_name: string): OutputChannelPort {
    return { appendLine: (value) => this.outputs.push(value), show: () => undefined, dispose: () => undefined };
  }
  async showInformationMessage(message: string, ...items: readonly string[]): Promise<string | undefined> {
    this.messages.push(message);
    return items[0];
  }
  async showWarningMessage(message: string): Promise<void> {
    this.warnings.push(message);
  }
  async showQuickPick(
    _items: readonly QuickPickItemPort[],
    _options: { readonly placeHolder: string },
  ): Promise<QuickPickItemPort | undefined> {
    return this.quickPickResult;
  }
  async showOpenDialog(_options: {
    readonly canSelectFiles: boolean;
    readonly canSelectFolders: boolean;
    readonly canSelectMany: boolean;
  }): Promise<readonly { readonly fsPath: string }[] | undefined> {
    return this.openDialogResult;
  }
  async showInputBox(_options: {
    readonly prompt: string;
    readonly password: boolean;
    readonly ignoreFocusOut: boolean;
  }): Promise<string | undefined> {
    return this.inputBoxResult;
  }
  async executeCommand(id: string, ...args: readonly unknown[]): Promise<unknown> {
    this.executed.push({ id, args });
    const handler = this.commands.get(id);
    return handler === undefined ? undefined : await handler(...args);
  }
  async writeClipboard(value: string): Promise<void> {
    this.clipboard.push(value);
  }
  async openTextDocument(path: string): Promise<void> {
    this.documents.push(path);
  }
  async secretGet(key: string): Promise<string | undefined> {
    return this.secrets.get(key);
  }
  async secretStore(key: string, value: string): Promise<void> {
    this.secrets.set(key, value);
  }
  async secretDelete(key: string): Promise<void> {
    this.secrets.delete(key);
  }
  inspectConfiguration<T>(key: string): ConfigurationInspectionPort<T> | undefined {
    return this.configurations.get(key) as ConfigurationInspectionPort<T> | undefined;
  }
  workspaceFolders(): readonly string[] {
    return this.workspaceFolderPaths;
  }
  activeSelection(): ActiveSelectionPort | undefined {
    return this.activeSelectionValue;
  }
  trustActiveSelection(): void {
    const selection = this.activeSelectionValue;
    if (selection === undefined) throw new Error("No active selection to trust");
    const canonicalPath = realpathSync(selection.path);
    if (canonicalPath !== selection.path) throw new Error("Active selection is not canonical");
    const info = statSync(canonicalPath, { bigint: true });
    const expected = {
      canonicalPath,
      uri: selection.document.uri,
      version: selection.document.version,
      sha256: createHash("sha256").update(selection.document.text).digest("hex"),
      device: info.dev.toString(),
      inode: info.ino.toString(),
    };
    const provenance = issueFileSnapshotProvenance(expected, () => {
      const current = this.activeSelectionValue;
      if (
        current === undefined ||
        current.path !== canonicalPath ||
        current.document.uri !== expected.uri ||
        current.document.version !== expected.version ||
        createHash("sha256").update(current.document.text).digest("hex") !== expected.sha256
      ) {
        return false;
      }
      try {
        const currentInfo = statSync(canonicalPath, { bigint: true });
        return (
          realpathSync(canonicalPath) === canonicalPath &&
          currentInfo.dev.toString() === expected.device &&
          currentInfo.ino.toString() === expected.inode
        );
      } catch {
        return false;
      }
    });
    this.activeSelectionValue = Object.freeze({ ...selection, provenance });
  }
  diagnostics(path?: string): readonly DiagnosticPort[] {
    return path === undefined ? this.diagnosticEntries : this.diagnosticEntries.filter((entry) => entry.path === path);
  }
  async documentSnapshot(path: string): Promise<DocumentSnapshotPort | undefined> {
    await this.onDocumentSnapshot?.(path);
    return this.documentSnapshots.get(path);
  }
  async isPathIgnored(path: string): Promise<boolean> {
    return this.ignoredPaths.has(path);
  }
  subscribeIgnorePolicyInvalidation(listener: () => void): DisposablePort {
    return this.ignorePolicyEmitter.event(listener);
  }
  emitIgnorePolicyInvalidation(): void {
    this.ignorePolicyEmitter.emit();
  }
  registerVirtualTextDocumentProvider(scheme: string, provide: (uri: string) => string | undefined): DisposablePort {
    this.virtualProviders.set(scheme, provide);
    return this.track(() => this.virtualProviders.delete(scheme));
  }
  async openDiff(leftPath: string, rightUri: string, title: string): Promise<void> {
    this.diffs.push({ leftPath, rightUri, title });
  }
  applyWorkspaceEdit(submission: WorkspaceEditSubmissionPort): WorkspaceEditSubmissionResultPort {
    this.onBeforeWorkspaceEditBoundary?.();
    if (!workspaceEditPreconditionsHold(submission, (path) => this.documentSnapshots.get(path))) {
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
    this.appliedEdits.push([...submission.edits]);
    this.onApplyWorkspaceEdit?.();
    if (this.applyWorkspaceEditError !== undefined) throw this.applyWorkspaceEditError;
    if (!this.applyWorkspaceEditResult) {
      return Object.freeze({ attempted: true, completion: Promise.resolve(false) });
    }
    const byPath = new Map<string, WorkspaceTextEditPort[]>();
    for (const edit of submission.edits) {
      byPath.set(edit.path, [...(byPath.get(edit.path) ?? []), edit]);
    }
    for (const [path, pathEdits] of byPath) {
      const snapshot = this.documentSnapshots.get(path);
      if (snapshot === undefined) continue;
      let text = snapshot.text;
      const sorted = [...pathEdits].sort(
        (left, right) => offset(text, right.range.start) - offset(text, left.range.start),
      );
      for (const edit of sorted) {
        text = text.slice(0, offset(text, edit.range.start)) + edit.newText + text.slice(offset(text, edit.range.end));
      }
      this.documentSnapshots.set(path, {
        ...snapshot,
        text,
        version: snapshot.version + 1,
        isDirty: true,
      });
    }
    return Object.freeze({ attempted: true, completion: Promise.resolve(true) });
  }
  private track(dispose: () => void): DisposablePort {
    const state = { disposed: false };
    this.disposables.push(state);
    return {
      dispose: () => {
        state.disposed = true;
        dispose();
      },
    };
  }
  dispose(): void {
    for (const disposable of this.disposables) disposable.disposed = true;
  }
}

export class FakeWebviewPanel implements WebviewPanelPort {
  readonly webview: FakeWebview;
  readonly #disposeEmitter = new Emitter<void>();
  readonly onDidDispose = this.#disposeEmitter.event;
  disposed = false;
  reveals = 0;
  constructor(extensionRoot: string) {
    this.webview = new FakeWebview(extensionRoot);
  }
  reveal(): void {
    this.reveals += 1;
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.#disposeEmitter.emit();
  }
}

export class FakeWebview implements WebviewPort {
  html = "";
  #options = { enableScripts: false, localResourceRoots: [] as readonly string[] };
  readonly cspSource = "vscode-webview://fake";
  readonly posted: unknown[] = [];
  readonly #messages = new Emitter<unknown>();
  readonly onDidReceiveMessage = this.#messages.event;
  constructor(readonly extensionRoot: string) {}
  get options(): { readonly enableScripts: boolean; readonly localResourceRoots: readonly string[] } {
    return this.#options;
  }
  set options(value: { readonly enableScripts: boolean; readonly localResourceRoots: readonly string[] }) {
    this.#options = {
      enableScripts: value.enableScripts,
      localResourceRoots: value.localResourceRoots.map((root) => `${this.extensionRoot}/${root}`),
    };
  }
  asWebviewUri(relativePath: string): string {
    return `webview-resource:${this.extensionRoot}/${relativePath}`;
  }
  async postMessage(message: unknown): Promise<boolean> {
    this.posted.push(message);
    return true;
  }
  receive(message: unknown): void {
    this.#messages.emit(message);
  }
}

class FakeStatusBarItem implements StatusBarItemPort {
  text = "";
  tooltip?: string;
  command?: string;
  visible = false;
  show(): void {
    this.visible = true;
  }
  hide(): void {
    this.visible = false;
  }
  dispose(): void {
    this.visible = false;
  }
}

class FakeTreeView<T> implements TreeViewPort<T> {
  visible = true;
  readonly #visibility = new Emitter<{ readonly visible: boolean }>();
  readonly #expand = new Emitter<{ readonly element: T }>();
  readonly #collapse = new Emitter<{ readonly element: T }>();
  readonly onDidChangeVisibility = this.#visibility.event;
  readonly onDidExpandElement = this.#expand.event;
  readonly onDidCollapseElement = this.#collapse.event;
  emitVisibility(visible: boolean): void {
    this.visible = visible;
    this.#visibility.emit({ visible });
  }
  emitExpand(element: T): void {
    this.#expand.emit({ element });
  }
  emitCollapse(element: T): void {
    this.#collapse.emit({ element });
  }
  dispose(): void {
    this.visible = false;
  }
}

function isUnifiedTreeView<T>(view: FakeTreeView<T>): view is FakeTreeView<UnifiedInstanceNode> {
  return view !== undefined;
}

function offset(text: string, position: { readonly line: number; readonly character: number }): number {
  const lines = text.split("\n");
  let value = 0;
  for (let line = 0; line < position.line; line += 1) value += (lines[line]?.length ?? 0) + 1;
  return value + position.character;
}
