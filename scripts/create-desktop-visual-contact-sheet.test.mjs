import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { DESKTOP_VISUAL_SCREENSHOTS, createDesktopVisualContactSheet } from "./create-desktop-visual-contact-sheet.mjs";
import { repositoryRoot } from "./lib/repository.mjs";

const desktopRequire = createRequire(resolve(repositoryRoot, "apps/desktop/package.json"));
const sharp = desktopRequire("sharp");

test("desktop visual contact sheet requires and labels the exact 18-state matrix", async (t) => {
  const temporaryRoot = await mkdtemp(resolve(tmpdir(), "rbxforge-contact-sheet-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const screenshotsRoot = resolve(temporaryRoot, "screenshots");
  const outputPath = resolve(temporaryRoot, "contact-sheet.png");
  await mkdir(screenshotsRoot, { recursive: true });
  for (const [index, name] of DESKTOP_VISUAL_SCREENSHOTS.entries()) {
    await sharp({
      create: {
        width: 96,
        height: 64,
        channels: 4,
        background: { r: index * 7, g: 20, b: 30, alpha: 1 },
      },
    })
      .png()
      .toFile(resolve(screenshotsRoot, name));
  }

  const result = await createDesktopVisualContactSheet({ screenshotsRoot, outputPath });
  assert.equal(result.panels, 18);
  assert.deepEqual(result.files, DESKTOP_VISUAL_SCREENSHOTS);
  assert.deepEqual(await sharp(outputPath).metadata(), {
    ...(await sharp(outputPath).metadata()),
    width: 1_440,
    height: 1_968,
  });

  await rm(resolve(screenshotsRoot, DESKTOP_VISUAL_SCREENSHOTS[0]));
  await assert.rejects(
    createDesktopVisualContactSheet({ screenshotsRoot, outputPath }),
    /exact 18-screenshot.*missing=/i,
  );
});
