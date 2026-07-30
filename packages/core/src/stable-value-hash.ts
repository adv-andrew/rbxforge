import { createHash } from "node:crypto";

/** Hashes JSON-like values with explicit primitive types and stable object-key order. */
export function stableValueHash(value: unknown): string {
  return createHash("sha256").update(stableValue(value)).digest("hex");
}

export function stableValue(value: unknown, seen: Set<object> = new Set()): string {
  if (value === null) return "null";
  if (typeof value === "string") return `string:${JSON.stringify(value)}`;
  if (typeof value === "boolean") return `boolean:${value}`;
  if (typeof value === "number") {
    return Number.isFinite(value) ? `number:${Object.is(value, -0) ? "-0" : String(value)}` : "number:non-finite";
  }
  if (typeof value !== "object") return `${typeof value}:`;
  if (seen.has(value)) return "circular";
  seen.add(value);
  if (Array.isArray(value)) {
    const encoded = `array:[${value.map((entry) => stableValue(entry, seen)).join(",")}]`;
    seen.delete(value);
    return encoded;
  }
  const record = value as Record<string, unknown>;
  const encoded = `object:{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableValue(record[key], seen)}`)
    .join(",")}}`;
  seen.delete(value);
  return encoded;
}
