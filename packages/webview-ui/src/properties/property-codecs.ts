import { z } from "zod";

import type { TypedPropertyValue } from "../protocol.js";

export type PropertyKind =
  "boolean" | "number" | "string" | "enum" | "Color3" | "Vector2" | "Vector3" | "CFrame" | "UDim" | "UDim2" | "unknown";

export type ParseResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string };

export interface PropertyCodec<T> {
  readonly kind: string;
  readonly editable: boolean;
  parse(input: string): ParseResult<T>;
  format(value: T): string;
}

const finite = z.number().finite();
const color3 = z
  .object({
    R: finite.min(0).max(1),
    G: finite.min(0).max(1),
    B: finite.min(0).max(1),
  })
  .strict();
const vector2 = z.object({ X: finite, Y: finite }).strict();
const vector3 = z.object({ X: finite, Y: finite, Z: finite }).strict();
const udim = z.object({ Scale: finite, Offset: finite }).strict();
const udim2 = z
  .object({
    _type: z.literal("UDim2"),
    X: udim,
    Y: udim,
  })
  .strict();

export function createPropertyCodec(
  kind: PropertyKind,
  enumOptions?: readonly string[],
): PropertyCodec<TypedPropertyValue> {
  switch (kind) {
    case "boolean":
      return codec(
        kind,
        true,
        (input) => {
          if (input === "true") return ok(true);
          if (input === "false") return ok(false);
          return fail("Expected exact true or false");
        },
        String,
      );
    case "number":
      return codec(
        kind,
        true,
        (input) => {
          if (input.trim() === "") return fail("Expected a finite number");
          const value = Number(input);
          return Number.isFinite(value) ? ok(value) : fail("Expected a finite number");
        },
        String,
      );
    case "string":
      return codec(kind, true, ok, String);
    case "enum": {
      const options = enumOptions === undefined ? undefined : new Set(enumOptions);
      return codec(
        kind,
        options !== undefined && options.size > 0,
        (input) => (options?.has(input) === true ? ok(input) : fail("Value is not in the verified option set")),
        String,
      );
    }
    case "Color3":
      return jsonCodec(kind, true, color3);
    case "Vector2":
      return jsonCodec(kind, true, vector2);
    case "Vector3":
      return jsonCodec(kind, true, vector3);
    case "UDim":
      return jsonCodec(kind, false, udim);
    case "UDim2":
      return jsonCodec(kind, true, udim2);
    case "CFrame":
      return codec(kind, false, parseCFrame, (value) =>
        Array.isArray(value) ? value.join(",") : JSON.stringify(value),
      );
    case "unknown":
      return codec(kind, false, () => fail("Unsupported structured value"), String);
  }
}

function codec<T extends TypedPropertyValue>(
  kind: string,
  editable: boolean,
  parse: (input: string) => ParseResult<T>,
  format: (value: T) => string,
): PropertyCodec<TypedPropertyValue> {
  return {
    kind,
    editable,
    parse: (input) => parse(input),
    format: (value) => format(value as T),
  };
}

function jsonCodec<T extends TypedPropertyValue>(
  kind: string,
  editable: boolean,
  schema: z.ZodType<T>,
): PropertyCodec<TypedPropertyValue> {
  return codec(
    kind,
    editable,
    (input) => {
      let decoded: unknown;
      try {
        decoded = JSON.parse(input) as unknown;
      } catch {
        return fail(`Expected an exact ${kind} JSON object`);
      }
      const result = schema.safeParse(decoded);
      return result.success ? ok(result.data) : fail(`Invalid ${kind} value`);
    },
    (value) => JSON.stringify(value),
  );
}

function parseCFrame(input: string): ParseResult<TypedPropertyValue> {
  const values = input.split(",").map((entry) => Number(entry.trim()));
  if (values.length !== 12 || values.some((value) => !Number.isFinite(value))) {
    return fail("CFrame requires exactly 12 finite values");
  }
  const rotation = values.slice(3);
  const rows = [rotation.slice(0, 3), rotation.slice(3, 6), rotation.slice(6, 9)];
  if (
    rows.some((row) => Math.abs(dot(row, row) - 1) > 1e-5) ||
    Math.abs(dot(rows[0] ?? [], rows[1] ?? [])) > 1e-5 ||
    Math.abs(dot(rows[0] ?? [], rows[2] ?? [])) > 1e-5 ||
    Math.abs(dot(rows[1] ?? [], rows[2] ?? [])) > 1e-5 ||
    Math.abs(determinant(rotation) - 1) > 1e-5
  ) {
    return fail("CFrame rotation must be a rigid right-handed matrix");
  }
  return ok(values as [number, number, number, number, number, number, number, number, number, number, number, number]);
}

function dot(left: readonly number[], right: readonly number[]): number {
  return (left[0] ?? 0) * (right[0] ?? 0) + (left[1] ?? 0) * (right[1] ?? 0) + (left[2] ?? 0) * (right[2] ?? 0);
}

function determinant(matrix: readonly number[]): number {
  const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, g = 0, h = 0, i = 0] = matrix;
  return a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
}

function ok<T>(value: T): ParseResult<T> {
  return { ok: true, value };
}

function fail(message: string): ParseResult<never> {
  return { ok: false, message };
}
