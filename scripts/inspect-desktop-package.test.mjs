import assert from "node:assert/strict";
import test from "node:test";

import { assertAsarInventory, assertNoForbiddenAsarContent } from "./inspect-desktop-package.mjs";

test("final ASAR inventory rejects every test-only desktop fixture artifact", () => {
  const runtimeManifest = { schemaVersion: 1, files: [] };
  for (const path of [
    "test-results/electron/report.json",
    "dist/renderer/test-results/",
    "dist/renderer/assets/fixture-main.js",
    "dist/renderer/assets/visual-fixtures.js",
    "dist/renderer/assets/electron-fixture.js",
  ]) {
    assert.throws(() => assertAsarInventory([path], runtimeManifest), /ASAR allowlist.*forbidden/i);
  }
  assert.throws(
    () => assertAsarInventory([], runtimeManifest, ["dist/renderer/test-results"]),
    /ASAR allowlist.*forbidden/i,
  );
});

test("final extracted-ASAR content scan rejects the fixture launch marker in text or bytes", () => {
  assert.doesNotThrow(() => assertNoForbiddenAsarContent("safe production content", "dist/main/index.cjs"));
  assert.throws(
    () => assertNoForbiddenAsarContent("--rbxforge-visual-state=onboarding", "dist/main/index.cjs"),
    /forbidden fixture launch content.*dist\/main\/index\.cjs/i,
  );
  assert.throws(
    () =>
      assertNoForbiddenAsarContent(
        Buffer.from("<svg>--rbxforge-visual-state=mismatch-error</svg>"),
        "dist/renderer/assets/mark.svg",
      ),
    /forbidden fixture launch content.*mark\.svg/i,
  );
});
