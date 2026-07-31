import { formatDataModelPath, parentDataModelPath, parseDataModelPath, studioPropertyMetadata } from "@rbxforge/core";
import type {
  StudioInspectorChildren,
  StudioInspectorNode,
  StudioInspectorProperties,
  StudioInspectorProperty,
  StudioInspectorPropertyCategory,
  StudioInspectorPropertyValueKind,
  StudioInspectorRequestIdentity,
} from "../../shared/domain.js";
import type { BindingCoordinator } from "./binding-coordinator.js";

const LIMITS = Object.freeze({
  pathCharacters: 4_096,
  childRows: 1_000,
  propertyRows: 512,
  labelCharacters: 256,
  depth: 4,
  nodes: 128,
  arrayItems: 20,
  objectEntries: 50,
  stringCharacters: 1_024,
  outputCharacters: 8_192,
});

const CHILD_ERROR = "Studio child response exceeds the inspector bounds";
const PROPERTY_ERROR = "Studio property response exceeds the inspector bounds";
const PROPERTY_CATEGORIES = Object.freeze([
  "Appearance",
  "Behavior",
  "Transform",
  "Layout",
  "Content",
  "Data",
  "Other",
] as const);
const SENSITIVE_KEY = /key|token|secret|auth|credential|source|script|base64|prompt|arguments|password|passwd/iu;
const SECRET_LIKE_CONTENT =
  /(?:authorization["']?\s*:\s*["']?\s*(?:bearer|basic)\b|\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|credentials?|private[_-]?key)\b["']?\s*[:=]\s*["']?[^\s"',}]{4,}|-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----|\bsk-[A-Za-z0-9_-]{6,})/iu;
const GENERIC_SENSITIVE_ASSIGNMENT =
  /(?:^|[^A-Za-z0-9_])[A-Za-z0-9_-]*(?:token|secret|auth|authorization|credential)[A-Za-z0-9_-]*["']?\s*[:=]\s*(?:"[^"\r\n]+"|'[^'\r\n]+'|[^\s"',;}\]]+)/iu;
const PASSWORD_ASSIGNMENT =
  /(?:^|[^A-Za-z0-9_])[A-Za-z0-9_-]*(?:password|passwd)[A-Za-z0-9_-]*["']?\s*[:=]\s*(?:"[^"\r\n]+"|'[^'\r\n]+'|[^\s"',;}\]]+)/iu;
const STANDALONE_CREDENTIAL =
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|AKIA[0-9A-Z]{16}|npm_[A-Za-z0-9]{20,})\b/iu;

export type InspectorBindingPort = Pick<BindingCoordinator, "assertCurrent" | "withBinding">;

export interface StudioInspectorServiceOptions {
  readonly bindings: InspectorBindingPort;
  readonly now?: () => number;
}

export class StudioInspectorService {
  readonly #bindings: InspectorBindingPort;
  readonly #now: () => number;

  constructor(options: StudioInspectorServiceOptions) {
    this.#bindings = options.bindings;
    this.#now = options.now ?? Date.now;
  }

  async children(
    input: StudioInspectorRequestIdentity & { readonly instancePath: string },
  ): Promise<StudioInspectorChildren> {
    const binding = this.currentBinding(input);
    const instancePath = canonicalPath(input.instancePath, CHILD_ERROR);
    const children = await this.#bindings.withBinding(
      input.projectId,
      input.bindingRevision,
      async (service, expectedInstanceId) =>
        service.children(instancePath, {
          expectedInstanceId,
        }),
    );
    const rows = boundedChildren(instancePath, children);
    return Object.freeze({
      ...identity(input, binding.studio.brokerEpoch, this.#now()),
      instancePath,
      children: rows,
    });
  }

  async properties(
    input: StudioInspectorRequestIdentity & { readonly instancePath: string },
  ): Promise<StudioInspectorProperties> {
    const binding = this.currentBinding(input);
    const instancePath = canonicalPath(input.instancePath, PROPERTY_ERROR);
    const result = await this.#bindings.withBinding(
      input.projectId,
      input.bindingRevision,
      async (service, expectedInstanceId) =>
        service.properties(instancePath, {
          expectedInstanceId,
        }),
    );
    const responsePath = canonicalPath(result.instancePath, PROPERTY_ERROR);
    if (
      responsePath !== instancePath ||
      result.className.length === 0 ||
      result.className.length > LIMITS.labelCharacters
    ) {
      throw new Error(PROPERTY_ERROR);
    }
    const rows = boundedProperties(result.className, result.properties);
    return Object.freeze({
      ...identity(input, binding.studio.brokerEpoch, this.#now()),
      instancePath: responsePath,
      className: result.className,
      properties: rows,
    });
  }

  private currentBinding(input: StudioInspectorRequestIdentity) {
    const binding = this.#bindings.assertCurrent(input.projectId, input.bindingRevision);
    if (binding.studio.instanceId !== input.instanceId) {
      throw new Error("Studio inspector identity is not current");
    }
    return binding;
  }
}

function identity(input: StudioInspectorRequestIdentity, brokerEpoch: string, observedAt: number) {
  return {
    projectId: input.projectId,
    instanceId: input.instanceId,
    bindingRevision: input.bindingRevision,
    brokerEpoch,
    observedAt,
  };
}

function boundedChildren(
  instancePath: string,
  children: readonly {
    readonly name: string;
    readonly className: string;
    readonly path: string;
    readonly hasChildren: boolean;
    readonly enabled?: boolean;
  }[],
): readonly StudioInspectorNode[] {
  if (children.length > LIMITS.childRows) throw new Error(CHILD_ERROR);
  const paths = new Set<string>();
  const rows = children.map((node) => {
    if (
      node.name.length === 0 ||
      node.name.length > LIMITS.labelCharacters ||
      node.className.length === 0 ||
      node.className.length > LIMITS.labelCharacters
    ) {
      throw new Error(CHILD_ERROR);
    }
    const path = canonicalPath(node.path, CHILD_ERROR);
    if (
      parentDataModelPath(path) !== instancePath ||
      parseDataModelPath(path).at(-1) !== node.name ||
      paths.has(path)
    ) {
      throw new Error(CHILD_ERROR);
    }
    paths.add(path);
    return displayNode({ ...node, path });
  });
  rows.sort(compareNodes);
  return Object.freeze(rows);
}

function compareNodes(left: StudioInspectorNode, right: StudioInspectorNode): number {
  return (
    compareText(left.name, right.name) ||
    compareText(left.className, right.className) ||
    compareText(left.path, right.path)
  );
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function displayNode(node: {
  readonly name: string;
  readonly className: string;
  readonly path: string;
  readonly hasChildren: boolean;
  readonly enabled?: boolean;
}): StudioInspectorNode {
  return Object.freeze({
    name: node.name,
    className: node.className,
    path: node.path,
    hasChildren: node.hasChildren,
    ...(node.enabled === undefined ? {} : { enabled: node.enabled }),
  });
}

function displayProperty(
  name: string,
  value: unknown,
  category: StudioInspectorPropertyCategory,
): StudioInspectorProperty {
  const formatted = formatDisplayValue(value);
  return Object.freeze({
    name,
    category,
    value: formatted.value,
    valueKind: formatted.valueKind,
  });
}

function boundedProperties(
  className: string,
  properties: Readonly<Record<string, unknown>>,
): readonly StudioInspectorProperty[] {
  const candidates = Object.entries(properties)
    .filter(([name]) => name.length > 0 && name.length <= LIMITS.labelCharacters && !isSensitiveKey(name))
    .map(([name, value]) => ({
      name,
      value,
      category: propertyCategory(className, name, valueKind(value)),
    }))
    .sort(
      (left, right) =>
        categoryIndex(left.category) - categoryIndex(right.category) || compareText(left.name, right.name),
    )
    .slice(0, LIMITS.propertyRows);
  return Object.freeze(candidates.map(({ name, value, category }) => displayProperty(name, value, category)));
}

function propertyCategory(
  className: string,
  name: string,
  kind: StudioInspectorPropertyValueKind,
): StudioInspectorPropertyCategory {
  const metadata = studioPropertyMetadata(className, name);
  return protocolCategory(metadata?.category) ?? (kind === "structured" || kind === "unsupported" ? "Other" : "Data");
}

function categoryIndex(category: StudioInspectorPropertyCategory): number {
  return PROPERTY_CATEGORIES.indexOf(category);
}

function valueKind(value: unknown): StudioInspectorPropertyValueKind {
  if (value === null || value === undefined) return "nil";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return "number";
  if (typeof value === "string") return "string";
  if (Array.isArray(value) || plainRecord(value)) return "structured";
  return "unsupported";
}

function formatDisplayValue(value: unknown): {
  readonly value: string;
  readonly valueKind: StudioInspectorPropertyValueKind;
} {
  const kind = valueKind(value);
  switch (kind) {
    case "nil":
      return { value: "nil", valueKind: kind };
    case "boolean":
      return { value: String(value), valueKind: kind };
    case "number":
      return {
        value: typeof value === "number" && Number.isFinite(value) ? String(value) : "[non-finite number]",
        valueKind: kind,
      };
    case "string":
      return {
        value: displayString(value as string),
        valueKind: kind,
      };
    case "structured": {
      const budget: FormatBudget = { nodes: 0, seen: new WeakSet<object>() };
      const serialized = JSON.stringify(sanitizeStructured(value, 0, budget));
      return {
        value: boundedOutput(serialized),
        valueKind: kind,
      };
    }
    case "unsupported":
      return {
        value: unsupportedValue(value),
        valueKind: kind,
      };
  }
}

interface FormatBudget {
  nodes: number;
  readonly seen: WeakSet<object>;
}

function sanitizeStructured(value: unknown, depth: number, budget: FormatBudget): unknown {
  if (depth > LIMITS.depth) return "[maximum depth reached]";
  if (budget.nodes >= LIMITS.nodes) return "[node budget reached]";
  budget.nodes += 1;
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return displayString(value);
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : "[non-finite number]";
  if (typeof value !== "object") return unsupportedValue(value);
  if (!Array.isArray(value) && !plainRecord(value)) return "[unsupported object]";
  if (budget.seen.has(value)) return "[cyclic value]";
  budget.seen.add(value);
  try {
    if (Array.isArray(value)) {
      const items = value.slice(0, LIMITS.arrayItems).map((entry) => sanitizeStructured(entry, depth + 1, budget));
      if (value.length > LIMITS.arrayItems) items.push("[array items omitted]");
      return items;
    }
    const output: Record<string, unknown> = {};
    const entries = Object.entries(value)
      .filter(([key]) => !isSensitiveKey(key))
      .sort(([left], [right]) => compareText(left, right));
    for (const [key, entry] of entries.slice(0, LIMITS.objectEntries)) {
      output[key] = sanitizeStructured(entry, depth + 1, budget);
    }
    if (entries.length > LIMITS.objectEntries) {
      output["[object entries omitted]"] = entries.length - LIMITS.objectEntries;
    }
    return output;
  } finally {
    budget.seen.delete(value);
  }
}

function displayString(value: string): string {
  if (
    SECRET_LIKE_CONTENT.test(value) ||
    GENERIC_SENSITIVE_ASSIGNMENT.test(value) ||
    PASSWORD_ASSIGNMENT.test(value) ||
    STANDALONE_CREDENTIAL.test(value)
  ) {
    return "[sensitive value omitted]";
  }
  if (value.length <= LIMITS.stringCharacters) return value;
  return `${value.slice(0, LIMITS.stringCharacters - 3)}...`;
}

function isSensitiveKey(value: string): boolean {
  return value.toLowerCase() !== "description" && SENSITIVE_KEY.test(value);
}

function unsupportedValue(value: unknown): string {
  if (typeof value === "object") return "[unsupported object]";
  return `[unsupported ${typeof value}]`;
}

function boundedOutput(value: string): string {
  if (value.length <= LIMITS.outputCharacters) return value;
  return `${value.slice(0, LIMITS.outputCharacters - 3)}...`;
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalPath(path: string, errorMessage: string): string {
  try {
    const canonical = formatDataModelPath(parseDataModelPath(path));
    if (canonical.length > LIMITS.pathCharacters) throw new Error(errorMessage);
    return canonical;
  } catch {
    throw new Error(errorMessage);
  }
}

function protocolCategory(value: string | undefined): StudioInspectorPropertyCategory | undefined {
  switch (value) {
    case "Appearance":
    case "Behavior":
    case "Transform":
    case "Layout":
    case "Content":
    case "Data":
    case "Other":
      return value;
    default:
      return undefined;
  }
}
