import { describe, expect, test } from "vitest";

import { assertSafeStudioPropertyMutation, studioPropertyMetadata } from "./studio-property-policy.js";

describe("shared Studio property policy", () => {
  test.each(["Source", "Parent", "Name", "ClassName", "ScriptCode"])("blocks code and identity property %s", (name) => {
    expect(studioPropertyMetadata("Script", name)).toBeUndefined();
    expect(() => assertSafeStudioPropertyMutation("Script", name, "value")).toThrow("blocked");
  });

  test("allows one supported property/value and rejects ambiguous shapes", () => {
    expect(() => assertSafeStudioPropertyMutation("Part", "Anchored", true)).not.toThrow();
    expect(() => assertSafeStudioPropertyMutation("Part", "Anchored", "true")).toThrow("unsupported");
    expect(() => assertSafeStudioPropertyMutation("Part", "Color", { R: 1, G: 0, B: 0 })).not.toThrow();
    expect(() => assertSafeStudioPropertyMutation("Part", "Color", { R: 1, G: 0, B: 0, Secret: 1 })).toThrow(
      "unsupported",
    );
  });
});
