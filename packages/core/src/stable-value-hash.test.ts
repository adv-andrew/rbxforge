import { describe, expect, test } from "vitest";

import { stableValueHash } from "./stable-value-hash.js";

describe("stableValueHash", () => {
  test("is stable across object key order while preserving primitive types", () => {
    expect(stableValueHash({ nested: { b: 2, a: true }, value: "1" })).toBe(
      stableValueHash({ value: "1", nested: { a: true, b: 2 } }),
    );
    expect(stableValueHash("1")).not.toBe(stableValueHash(1));
    expect(stableValueHash(0)).not.toBe(stableValueHash(-0));
  });
});
