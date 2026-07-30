import type { UnifiedInstanceNode } from "@rbxforge/core";

import type { ConnectionStateSnapshot } from "./connection-state.js";
import type { DisposablePort, EventPort, TreeDataProviderPort, TreeItemPort } from "./vscode-facade.js";

export interface LiveGraphPort {
  children(path: string, signal: AbortSignal): Promise<readonly UnifiedInstanceNode[]>;
  resolve(
    path: string,
    signal: AbortSignal,
  ): Promise<{
    readonly node: UnifiedInstanceNode;
    readonly revision: number;
  }>;
  assertRevision(revision: number): void;
  revision?(): number;
  readonly onConnectionChanged: EventPort<ConnectionStateSnapshot>;
  readonly onGraphInvalidated: EventPort<{ readonly path: string }>;
  dispose?(): void;
}

export interface LiveStudioTreeOptions {
  readonly graph: LiveGraphPort;
  readonly scheduleRetry?: (delaySeconds: number, retry: () => void) => void;
}

class Emitter<T> {
  readonly #listeners = new Set<(value: T) => void>();
  readonly event = (listener: (value: T) => void): DisposablePort => {
    this.#listeners.add(listener);
    return { dispose: () => this.#listeners.delete(listener) };
  };
  emit(value: T): void {
    for (const listener of this.#listeners) listener(value);
  }
}

/** A visibility-aware, cached projection of the three-source live graph. */
export class LiveStudioTreeProvider implements TreeDataProviderPort<UnifiedInstanceNode>, DisposablePort {
  readonly #graph: LiveGraphPort;
  readonly #cache = new Map<string, readonly UnifiedInstanceNode[]>();
  readonly #inFlight = new Map<
    string,
    { readonly controller: AbortController; readonly promise: Promise<readonly UnifiedInstanceNode[]> }
  >();
  readonly #expanded = new Set<string>();
  readonly #visibility = new Map<string, boolean>();
  readonly #failures = new Map<string, number>();
  readonly #changed = new Emitter<UnifiedInstanceNode | undefined>();
  readonly #disposables: DisposablePort[];
  #visible = true;
  #stale = false;
  readonly #scheduleRetry: (delaySeconds: number, retry: () => void) => void;

  constructor(options: LiveStudioTreeOptions) {
    this.#graph = options.graph;
    this.#scheduleRetry =
      options.scheduleRetry ??
      ((delaySeconds, retry) => {
        setTimeout(retry, delaySeconds * 1_000);
      });
    this.#disposables = [
      options.graph.onConnectionChanged((snapshot) => {
        this.#stale = snapshot.aggregate.label !== "Ready";
        this.#changed.emit(undefined);
      }),
      options.graph.onGraphInvalidated(({ path }) => {
        this.#cache.delete(path);
        if (this.#visible && this.#expanded.has(path) && this.isPathVisible(path)) void this.childrenFor(path);
        this.#changed.emit(undefined);
      }),
    ];
  }

  get onDidChangeTreeData(): EventPort<UnifiedInstanceNode | undefined> {
    return this.#changed.event;
  }
  setVisible(visible: boolean): void {
    this.#visible = visible;
    if (!visible) this.abortHiddenRequests();
  }
  setPathVisible(path: string, visible: boolean): void {
    this.#visibility.set(path, visible);
    if (!visible) this.abort(path);
  }
  setExpanded(path: string, expanded: boolean): void {
    if (expanded) this.#expanded.add(path);
    else {
      this.#expanded.delete(path);
      this.abort(path);
    }
  }

  getChildren(element?: UnifiedInstanceNode): Promise<readonly UnifiedInstanceNode[]> {
    return this.childrenFor(element?.path ?? "game");
  }

  childrenFor(path: string): Promise<readonly UnifiedInstanceNode[]> {
    const cached = this.#cache.get(path);
    if (cached !== undefined) return Promise.resolve(cached);
    const existing = this.#inFlight.get(path);
    if (existing !== undefined) return existing.promise;
    const controller = new AbortController();
    const promise = this.#graph.children(path, controller.signal).then(
      (children) => {
        this.#inFlight.delete(path);
        if (controller.signal.aborted || !this.#visible || !this.isPathVisible(path))
          return this.#cache.get(path) ?? [];
        const result = Object.freeze([...children]);
        this.#failures.delete(path);
        this.#cache.set(path, result);
        this.#changed.emit(undefined);
        return result;
      },
      (error: unknown) => {
        this.#inFlight.delete(path);
        if (this.#visible && this.#expanded.has(path) && this.isPathVisible(path)) {
          const attempt = (this.#failures.get(path) ?? 0) + 1;
          this.#failures.set(path, attempt);
          this.#scheduleRetry(this.retryDelaySeconds(attempt), () => {
            if (this.#visible && this.#expanded.has(path) && this.isPathVisible(path))
              void this.childrenFor(path).catch(() => undefined);
          });
        }
        throw error;
      },
    );
    this.#inFlight.set(path, { controller, promise });
    return promise;
  }

  async refreshVisible(): Promise<void> {
    if (!this.#visible) return;
    await Promise.all(
      [...new Set(["game", ...this.#expanded])]
        .filter((path) => this.isPathVisible(path))
        .map(async (path) => {
          this.#cache.delete(path);
          await this.childrenFor(path);
        }),
    );
  }

  getTreeItem(node: UnifiedInstanceNode): TreeItemPort {
    const descriptions: string[] = [];
    if (node.ownership === "drift") descriptions.push("drift");
    if (node.ownership === "studio") descriptions.push("Studio-owned");
    if (node.unsafeUnknownChildren || node.unsafeParent) descriptions.push("unsafe");
    if (this.#stale) descriptions.push("stale");
    const warning = node.ownership === "drift" || node.unsafeUnknownChildren || node.unsafeParent;
    return Object.freeze({
      label: node.name,
      ...(descriptions.length === 0 ? {} : { description: descriptions.join("; ") }),
      icon: warning ? "warning" : "symbol-folder",
      contextValue: node.path,
      collapsibleState: node.children.length > 0 ? "collapsed" : "none",
    });
  }

  retryDelaySeconds(attempt: number): number {
    return [1, 2, 4, 8, 15][Math.min(Math.max(attempt, 1) - 1, 4)] ?? 15;
  }

  dispose(): void {
    for (const disposable of this.#disposables) disposable.dispose();
    for (const path of this.#inFlight.keys()) this.abort(path);
  }

  private isPathVisible(path: string): boolean {
    return this.#visibility.get(path) ?? true;
  }
  private abort(path: string): void {
    const request = this.#inFlight.get(path);
    request?.controller.abort();
  }
  private abortHiddenRequests(): void {
    for (const path of this.#inFlight.keys()) this.abort(path);
  }
}
