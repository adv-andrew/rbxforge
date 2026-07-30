export type SafeStudioPropertyKind = "boolean" | "number" | "string" | "Color3" | "Vector3" | "UDim2";

export interface StudioPropertyMetadata {
  readonly kind: SafeStudioPropertyKind | "CFrame";
  readonly category: string;
  readonly editable: boolean;
}

const BLOCKED = new Set(["source", "sourcelength", "linecount", "parent", "name", "classname", "class", "archivable"]);

export function studioPropertyMetadata(className: string, propertyName: string): StudioPropertyMetadata | undefined {
  const normalized = propertyName.toLowerCase();
  if (BLOCKED.has(normalized) || normalized.includes("source") || normalized.includes("script")) return undefined;
  if (propertyName === "CFrame") return Object.freeze({ kind: "CFrame", category: "Transform", editable: false });
  if (["Anchored", "CanCollide", "Visible", "Active", "Enabled", "Shadows"].includes(propertyName)) {
    return Object.freeze({ kind: "boolean", category: "Behavior", editable: true });
  }
  if (["Transparency", "Brightness", "Range", "ZIndex", "BorderSizePixel"].includes(propertyName)) {
    return Object.freeze({ kind: "number", category: "Appearance", editable: true });
  }
  if (["Color", "TextColor3", "BackgroundColor3", "ImageColor3"].includes(propertyName)) {
    return Object.freeze({ kind: "Color3", category: "Appearance", editable: true });
  }
  if (
    (className.endsWith("Gui") || className === "Frame" || className === "TextLabel" || className === "ImageLabel") &&
    (propertyName === "Size" || propertyName === "Position")
  ) {
    return Object.freeze({ kind: "UDim2", category: "Layout", editable: true });
  }
  if (["Size", "Position", "Rotation"].includes(propertyName)) {
    return Object.freeze({ kind: "Vector3", category: "Transform", editable: true });
  }
  if (["Text", "Image", "MeshId", "TextureID", "TextureId", "SoundId"].includes(propertyName)) {
    return Object.freeze({ kind: "string", category: "Content", editable: true });
  }
  return undefined;
}

export function assertSafeStudioPropertyMutation(className: string, propertyName: string, value: unknown): void {
  const metadata = studioPropertyMetadata(className, propertyName);
  if (metadata === undefined || !metadata.editable) {
    throw new Error("Studio property is blocked by the shared host policy");
  }
  if (!matchesKind(metadata.kind, value)) {
    throw new Error("Studio property value is unsupported by the shared host policy");
  }
}

function matchesKind(kind: SafeStudioPropertyKind | "CFrame", value: unknown): boolean {
  if (kind === "boolean" || kind === "number" || kind === "string") {
    return typeof value === kind && (kind !== "number" || Number.isFinite(value));
  }
  if (kind === "Color3")
    return numericObject(value, ["R", "G", "B"]) && Object.values(value).every((entry) => entry >= 0 && entry <= 1);
  if (kind === "Vector3") return numericObject(value, ["X", "Y", "Z"]);
  if (kind === "UDim2") {
    if (!plainRecord(value) || value._type !== "UDim2") return false;
    return udim(value.X) && udim(value.Y);
  }
  return false;
}

function udim(value: unknown): boolean {
  return numericObject(value, ["Scale", "Offset"]);
}

function numericObject(value: unknown, keys: readonly string[]): value is Record<string, number> {
  return (
    plainRecord(value) &&
    Object.keys(value).sort().join(",") === [...keys].sort().join(",") &&
    keys.every((key) => typeof value[key] === "number" && Number.isFinite(value[key]))
  );
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
