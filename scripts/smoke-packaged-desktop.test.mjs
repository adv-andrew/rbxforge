import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import {
  PACKAGED_DESKTOP_SCREENSHOT_PATH,
  createPackagedElectronLaunchArguments,
  resolvePlaywrightElectronLoader,
} from "./smoke-packaged-desktop.mjs";
import { repositoryRoot } from "./lib/repository.mjs";

test("custom packaged Electron launch explicitly preloads Playwright's handshake loader", async () => {
  assert.equal(PACKAGED_DESKTOP_SCREENSHOT_PATH, resolve(repositoryRoot, "artifacts/rbxforge-packaged-1280x800.png"));
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
