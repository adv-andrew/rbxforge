import { formatDataModelPath, parentDataModelPath, parseDataModelPath } from "./data-model-path.js";
import type {
  FileProjectionNode,
  Ownership,
  ProjectionNode,
  ReconcileInput,
  UnifiedInstanceNode,
} from "./instance-types.js";

/** Reconciles filesystem, declared Rojo, and live Studio projections by canonical path. */
export function reconcileInstanceGraph(input: ReconcileInput): ReadonlyMap<string, UnifiedInstanceNode> {
  const files = indexFiles(input.files);
  const rojo = indexProjections(input.rojo);
  const studio = indexProjections(input.studio);
  const paths = new Set([...files.keys(), ...rojo.keys(), ...studio.keys()]);
  const drafts = new Map<string, NodeDraft>();

  for (const path of paths) {
    const declared = rojo.get(path);
    const live = studio.get(path);
    const fileMapping = files.get(path);
    const segments = parseDataModelPath(path);
    const name = segments[segments.length - 1];

    if (name === undefined) {
      throw new Error("DataModel path must contain a name");
    }

    drafts.set(path, {
      path,
      name: declared?.name ?? live?.name ?? name,
      className: declared?.className ?? live?.className ?? "Unknown",
      ownership: resolveOwnership(fileMapping, declared, live),
      files: fileMapping,
      rojo: declared,
      studio: live,
      children: [],
      unsafeUnknownChildren: declared?.unsafeUnknownChildren ?? false,
      unsafeParent: false,
    });
  }

  for (const draft of drafts.values()) {
    const parent = parentDataModelPath(draft.path);
    if (parent !== undefined) {
      drafts.get(parent)?.children.push(draft.path);
    }
  }

  for (const draft of drafts.values()) {
    draft.children.sort((left, right) => compareChildren(left, right, drafts));
    draft.unsafeParent = hasUnsafeAncestor(draft.path, drafts);
  }

  const graph = new Map<string, UnifiedInstanceNode>();
  for (const [path, draft] of drafts) {
    graph.set(path, freezeNode(draft));
  }

  return immutableMap(graph);
}

interface NodeDraft {
  path: string;
  name: string;
  className: string;
  ownership: Ownership;
  files: FileProjectionNode | undefined;
  rojo: ProjectionNode | undefined;
  studio: ProjectionNode | undefined;
  children: string[];
  unsafeUnknownChildren: boolean;
  unsafeParent: boolean;
}

function indexFiles(nodes: readonly FileProjectionNode[]): Map<string, FileProjectionNode> {
  const indexed = new Map<string, FileProjectionNode>();
  for (const node of nodes) {
    const path = normalizePath(node.path);
    indexed.set(
      path,
      Object.freeze({
        ...node,
        path,
        filePaths: Object.freeze([...node.filePaths]),
      }),
    );
  }
  return indexed;
}

function indexProjections(nodes: readonly ProjectionNode[]): Map<string, ProjectionNode> {
  const indexed = new Map<string, ProjectionNode>();
  for (const node of nodes) {
    const path = normalizePath(node.path);
    indexed.set(
      path,
      Object.freeze({
        ...node,
        path,
        ...(node.properties === undefined
          ? {}
          : { properties: freezeValue(node.properties) as Readonly<Record<string, unknown>> }),
      }),
    );
  }
  return indexed;
}

function normalizePath(path: string): string {
  return formatDataModelPath(parseDataModelPath(path));
}

function resolveOwnership(
  files: FileProjectionNode | undefined,
  rojo: ProjectionNode | undefined,
  studio: ProjectionNode | undefined,
): Ownership {
  if (files !== undefined && rojo !== undefined && studio !== undefined) {
    return projectionsDrift(rojo, studio) ? "drift" : "files";
  }
  if (studio !== undefined && files === undefined) {
    return "studio";
  }
  return "unknown";
}

function projectionsDrift(declared: ProjectionNode, live: ProjectionNode): boolean {
  return (
    declared.name !== live.name ||
    declared.className !== live.className ||
    propertiesDrift(declared.properties, live.properties)
  );
}

function propertiesDrift(
  declared: Readonly<Record<string, unknown>> | undefined,
  live: Readonly<Record<string, unknown>> | undefined,
): boolean {
  if (declared === undefined || live === undefined) {
    return false;
  }

  for (const key of Object.keys(declared)) {
    if (Object.prototype.hasOwnProperty.call(live, key) && !stableDeepEqual(declared[key], live[key])) {
      return true;
    }
  }
  return false;
}

function stableDeepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => stableDeepEqual(value, right[index]))
    );
  }
  if (!isPlainObject(left) || !isPlainObject(right)) {
    return false;
  }

  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] &&
        Object.prototype.hasOwnProperty.call(right, key) &&
        stableDeepEqual(left[key], right[key]),
    )
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasUnsafeAncestor(path: string, drafts: ReadonlyMap<string, NodeDraft>): boolean {
  let ancestor = parentDataModelPath(path);
  while (ancestor !== undefined) {
    const ancestorNode = drafts.get(ancestor);
    if (ancestorNode?.unsafeUnknownChildren === true) {
      return true;
    }
    ancestor = parentDataModelPath(ancestor);
  }
  return false;
}

function compareChildren(left: string, right: string, drafts: ReadonlyMap<string, NodeDraft>): number {
  const leftNode = drafts.get(left);
  const rightNode = drafts.get(right);
  if (leftNode === undefined || rightNode === undefined) {
    return compareStrings(left, right);
  }
  return (
    compareStrings(leftNode.name, rightNode.name) ||
    compareStrings(leftNode.className, rightNode.className) ||
    compareStrings(leftNode.path, rightNode.path)
  );
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function freezeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return Object.freeze(value.map(freezeValue));
  }
  if (isPlainObject(value)) {
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, freezeValue(nested)])));
  }
  return value;
}

function freezeNode(draft: NodeDraft): UnifiedInstanceNode {
  return Object.freeze({
    path: draft.path,
    name: draft.name,
    className: draft.className,
    ownership: draft.ownership,
    ...(draft.files === undefined ? {} : { files: draft.files }),
    ...(draft.rojo === undefined ? {} : { rojo: draft.rojo }),
    ...(draft.studio === undefined ? {} : { studio: draft.studio }),
    children: Object.freeze([...draft.children]),
    unsafeUnknownChildren: draft.unsafeUnknownChildren,
    unsafeParent: draft.unsafeParent,
  });
}

function immutableMap<T>(source: ReadonlyMap<string, T>): ReadonlyMap<string, T> {
  const entries = new Map(source);
  let readonly: ReadonlyMap<string, T>;
  readonly = Object.freeze({
    get size() {
      return entries.size;
    },
    get: (key: string) => entries.get(key),
    has: (key: string) => entries.has(key),
    entries: () => entries.entries(),
    keys: () => entries.keys(),
    values: () => entries.values(),
    forEach: (callback: (value: T, key: string, map: ReadonlyMap<string, T>) => void, thisArg?: unknown) => {
      entries.forEach((value, key) => callback.call(thisArg, value, key, readonly));
    },
    [Symbol.iterator]: () => entries[Symbol.iterator](),
  } satisfies ReadonlyMap<string, T>);
  return readonly;
}
