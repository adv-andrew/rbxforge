import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { basename, join } from "node:path";
import { parse, type ParseError } from "jsonc-parser";
import { z } from "zod";
import { formatDataModelPath } from "@rbxforge/core";

const ignoredDirectories = new Set(["node_modules", ".git", ".worktrees", ".rbxforge"]);
const candidatePattern = /\.project\.jsonc?$/;

export type UnknownInstanceSafety = "safe" | "unsafe" | "unknown";

export interface RojoProjectSafetyNode {
  readonly path: string;
  readonly unknownInstances: UnknownInstanceSafety;
}

export interface RojoProjectDiagnostic {
  readonly path: string;
  readonly code: "parse-error" | "invalid-shape" | "read-error";
  readonly message: string;
}

export interface RojoProject {
  readonly path: string;
  readonly name: string;
  readonly servePlaceIds: readonly number[];
  readonly safety: readonly RojoProjectSafetyNode[];
}

export type RojoProjectDiscovery = readonly RojoProject[] & {
  readonly diagnostics: readonly RojoProjectDiagnostic[];
};

const projectSchema = z
  .object({
    name: z.string().optional(),
    servePlaceIds: z.array(z.number().int().nonnegative().safe()).optional(),
    tree: z.record(z.unknown()),
  })
  .passthrough();

/** Finds and statically validates Rojo project files without entering ignored or symlinked directories. */
export async function discoverRojoProjects(root: string): Promise<RojoProjectDiscovery> {
  const canonicalRoot = await realpath(root);
  const paths = await scan(canonicalRoot);
  const projects: RojoProject[] = [];
  const diagnostics: RojoProjectDiagnostic[] = [];

  for (const path of paths) {
    try {
      const parsed = parseJsonc(await readFile(path, "utf8"));
      const validated = projectSchema.safeParse(parsed.value);
      if (!validated.success) {
        diagnostics.push(
          Object.freeze({
            path,
            code: "invalid-shape",
            message: validated.error.issues.map((issue) => issue.message).join("; "),
          }),
        );
        continue;
      }
      projects.push(
        freezeProject({
          path,
          name: validated.data.name ?? basename(path).replace(/\.project\.jsonc?$/, ""),
          servePlaceIds: validated.data.servePlaceIds ?? [],
          safety: deriveSafety(validated.data.tree),
        }),
      );
    } catch (error) {
      diagnostics.push(
        Object.freeze({
          path,
          code: error instanceof JsoncParseFailure ? "parse-error" : "read-error",
          message: error instanceof Error ? error.message : "Unable to read project file",
        }),
      );
    }
  }

  projects.sort((left, right) => left.path.localeCompare(right.path));
  diagnostics.sort((left, right) => left.path.localeCompare(right.path));
  const result = projects as unknown as RojoProjectDiscovery;
  Object.defineProperty(result, "diagnostics", {
    value: Object.freeze(diagnostics),
    enumerable: true,
    configurable: false,
    writable: false,
  });
  return Object.freeze(result);
}

async function scan(root: string): Promise<string[]> {
  const found: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) {
          await visit(path);
        }
      } else if (entry.isFile() && candidatePattern.test(entry.name)) {
        const stat = await lstat(path);
        if (!stat.isSymbolicLink()) {
          found.push(await realpath(path));
        }
      }
    }
  };
  await visit(root);
  return found;
}

function parseJsonc(source: string): { readonly value: unknown } {
  const errors: ParseError[] = [];
  const value = parse(source, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0) {
    throw new JsoncParseFailure(errors);
  }
  return { value };
}

class JsoncParseFailure extends Error {
  constructor(errors: readonly ParseError[]) {
    super(`Invalid JSONC project file (${errors.map((error) => error.error).join(", ")})`);
  }
}

function deriveSafety(tree: Record<string, unknown>): readonly RojoProjectSafetyNode[] {
  const root = tree;
  const nodes: RojoProjectSafetyNode[] = [];
  visitTree(root, ["game"], nodes);
  return Object.freeze(nodes.sort((left, right) => left.path.localeCompare(right.path)));
}

function visitTree(value: Record<string, unknown>, segments: readonly string[], nodes: RojoProjectSafetyNode[]): void {
  const path = formatDataModelPath(segments);
  const explicitIgnore = value.$ignoreUnknownInstances;
  const hasPath = typeof value.$path === "string";
  const safety: UnknownInstanceSafety =
    explicitIgnore === true ? "unsafe" : explicitIgnore === false ? "safe" : hasPath ? "unknown" : "unsafe";
  nodes.push(Object.freeze({ path, unknownInstances: safety }));
  for (const [name, child] of Object.entries(value)) {
    if (!name.startsWith("$") && isRecord(child)) {
      visitTree(child, [...segments, name], nodes);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function freezeProject(project: RojoProject): RojoProject {
  return Object.freeze({
    path: project.path,
    name: project.name,
    servePlaceIds: Object.freeze([...project.servePlaceIds]),
    safety: Object.freeze(project.safety.map((node) => Object.freeze({ ...node }))),
  });
}
