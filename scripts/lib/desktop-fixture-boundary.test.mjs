import assert from "node:assert/strict";
import test from "node:test";

import { containsDesktopFixtureLaunchArgument, isTestOnlyDesktopPath } from "./desktop-fixture-boundary.mjs";

test("desktop fixture path boundary rejects exact and hashed test-only artifacts without broad false positives", () => {
  for (const path of [
    "test-results/electron/fixture-main.cjs",
    "Resources/test-results/report.json",
    "renderer/assets/fixture-main.js",
    "renderer/assets/fixture-main-ABC123.js",
    "renderer/assets/visual-fixtures.js",
    "renderer/assets/electron-fixture.bundle.js",
  ]) {
    assert.equal(isTestOnlyDesktopPath(path), true, path);
  }

  for (const path of [
    "renderer/assets/index.js",
    "renderer/assets/my-fixture-mainly.js",
    "Resources/test-result/report.json",
  ]) {
    assert.equal(isTestOnlyDesktopPath(path), false, path);
  }
});

test("desktop fixture path boundary rejects generic test and fixture components without prefix false positives", () => {
  for (const path of [
    "dist/types/renderer/test/fixtures.d.ts",
    "types/renderer/tests/render-helper.d.ts",
    "types/renderer/fixture/catalog.d.ts",
    "types/renderer/fixtures/catalog.d.ts",
  ]) {
    assert.equal(isTestOnlyDesktopPath(path), true, path);
  }

  for (const path of [
    "renderer/assets/test-runner.js",
    "renderer/assets/fixture-loader.js",
    "renderer/assets/fixtures-production.js",
    "types/renderer/components/Testimonial.d.ts",
    "types/renderer/components/ContestResults.d.ts",
  ]) {
    assert.equal(isTestOnlyDesktopPath(path), false, path);
  }
});

test("desktop fixture launch marker scan accepts bytes and strings but rejects the exact argument", () => {
  assert.equal(containsDesktopFixtureLaunchArgument("safe production content"), false);
  assert.equal(containsDesktopFixtureLaunchArgument("--rbxforge-visual-state=onboarding"), true);
  assert.equal(containsDesktopFixtureLaunchArgument(Buffer.from("--rbxforge-visual-state=mismatch-error")), true);
});
