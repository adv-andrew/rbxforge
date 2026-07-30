import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import {
  PACKAGED_DESKTOP_SCREENSHOT_PATH,
  assertPackagedWindowSize,
  capturePackagedOnboardingScreenshot,
  createPackagedElectronLaunchArguments,
  resolvePlaywrightElectronLoader,
} from "./smoke-packaged-desktop.mjs";
import { repositoryRoot } from "./lib/repository.mjs";

test("custom packaged Electron launch explicitly preloads Playwright's handshake loader", async () => {
  assert.equal(PACKAGED_DESKTOP_SCREENSHOT_PATH, resolve(repositoryRoot, "artifacts/rbxforge-packaged.png"));
  const loader = resolvePlaywrightElectronLoader();
  await access(loader);
  assert.match(loader, /playwright-core\/lib\/server\/electron\/loader\.js$/);
  assert.deepEqual(
    createPackagedElectronLaunchArguments({
      loader,
      userData: resolve(repositoryRoot, "work/package-smoke-profile"),
    }),
    ["-r", loader, `--user-data-dir=${resolve(repositoryRoot, "work/package-smoke-profile")}`],
  );
});

test("packaged smoke accepts macOS-constrained window sizes without weakening the app minimum", () => {
  assert.deepEqual(assertPackagedWindowSize([1280, 800]), [1280, 800]);
  assert.deepEqual(assertPackagedWindowSize([1024, 681]), [1024, 681]);
  assert.deepEqual(assertPackagedWindowSize([960, 640]), [960, 640]);

  for (const size of [
    undefined,
    [],
    [1024],
    [1024, 681, 1],
    [959, 681],
    [1024, 639],
    [1281, 800],
    [1280, 801],
    [1024.5, 681],
    ["1024", 681],
  ]) {
    assert.throws(() => assertPackagedWindowSize(size), /window geometry smoke failed/i);
  }
});

test("packaged screenshot dimensions must match the observed renderer viewport", async () => {
  const image = pngHeader(1024, 681);
  const page = {
    screenshot: async () => image,
  };
  const output = resolve(repositoryRoot, "work/packaged-screenshot-dimension-test.png");

  assert.deepEqual(await capturePackagedOnboardingScreenshot(page, output, [1024, 681]), {
    path: output,
    bytes: 24,
    width: 1024,
    height: 681,
  });
  await assert.rejects(
    capturePackagedOnboardingScreenshot(page, output, [1023, 681]),
    /renderer viewport.*1023x681.*1024x681/i,
  );

  const fullSizePage = {
    screenshot: async () => pngHeader(1280, 800),
  };
  assert.deepEqual(await capturePackagedOnboardingScreenshot(fullSizePage, output, [1280, 800]), {
    path: output,
    bytes: 24,
    width: 1280,
    height: 800,
  });

  const invalidPage = {
    screenshot: async () => Buffer.alloc(24),
  };
  await assert.rejects(capturePackagedOnboardingScreenshot(invalidPage, output, [1024, 681]), /not a PNG/i);
});

function pngHeader(width, height) {
  const image = Buffer.alloc(24);
  Buffer.from("89504e470d0a1a0a", "hex").copy(image);
  image.writeUInt32BE(width, 16);
  image.writeUInt32BE(height, 20);
  return image;
}
