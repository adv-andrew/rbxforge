import { isAbsolute } from "node:path";
import { joinDataModelPath, type ProjectionNode } from "@rbxforge/core";

export interface SourcedProjectionNode extends ProjectionNode {
  readonly filePaths?: readonly string[];
}

interface CompactSourcemapNode {
  readonly name: string;
  readonly className: string;
  readonly filePaths?: readonly string[];
  readonly children?: readonly CompactSourcemapNode[];
}

/** Converts Rojo's compact sourcemap tree to immutable canonical DataModel projections. */
export function parseRojoSourcemap(input: unknown): readonly SourcedProjectionNode[] {
  const root = parseNode(input);
  if (root.className !== "DataModel") {
    throw new Error("Rojo sourcemap root must have className DataModel");
  }
  const nodes: SourcedProjectionNode[] = [];
  const paths = new Set<string>();
  const visit = (node: CompactSourcemapNode, parent: string | undefined): void => {
    const path = parent === undefined ? "game" : joinDataModelPath(parent, node.name);
    if (paths.has(path)) {
      throw new Error(`Duplicate canonical sourcemap path: ${path}`);
    }
    paths.add(path);
    nodes.push(
      Object.freeze({
        path,
        name: node.name,
        className: node.className,
        ...(node.filePaths === undefined ? {} : { filePaths: Object.freeze([...node.filePaths]) }),
      }),
    );
    for (const child of node.children ?? []) {
      visit(child, path);
    }
  };
  visit(root, undefined);
  return Object.freeze(nodes);
}

function parseNode(input: unknown): CompactSourcemapNode {
  if (
    !isRecord(input) ||
    typeof input.name !== "string" ||
    input.name.length === 0 ||
    typeof input.className !== "string" ||
    input.className.length === 0
  ) {
    throw new Error("Invalid Rojo sourcemap node");
  }
  const filePaths = parseStringArray(input.filePaths, "Sourcemap filePaths must be an array");
  if (filePaths !== undefined && filePaths.some((path) => !isAbsolute(path))) {
    throw new Error("Sourcemap file paths must be absolute");
  }
  const childrenInput = input.children;
  if (childrenInput !== undefined && !Array.isArray(childrenInput)) {
    throw new Error("Invalid Rojo sourcemap node");
  }
  const children = childrenInput?.map(parseNode);
  return Object.freeze({
    name: input.name,
    className: input.className,
    ...(filePaths === undefined ? {} : { filePaths: Object.freeze(filePaths) }),
    ...(children === undefined ? {} : { children: Object.freeze(children) }),
  });
}

function parseStringArray(value: unknown, message: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(message);
  }
  return [...value];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
