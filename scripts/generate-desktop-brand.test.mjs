import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";

import { AUDITED_BRAND, DESKTOP_ICON_COMPOSITION, composeDesktopIconMaster } from "./generate-desktop-brand.mjs";
import { repositoryRoot, sha256 } from "./lib/repository.mjs";

const desktopRoot = resolve(repositoryRoot, "apps/desktop");
const desktopRequire = createRequire(resolve(desktopRoot, "package.json"));
const sharp = desktopRequire("sharp");
const markPath = resolve(desktopRoot, "assets/brand/rbxforge-mark.svg");

test("the desktop icon composes the exact audited mark over one graphite rounded square", async () => {
  const mark = await readFile(markPath);
  assert.equal(mark.length, 954);
  assert.equal(sha256(mark), "f3fdcfb89f46ede47ada4289b73ac6e8020c0a1984ee72e532c02f4cc989f26d");
  assert.equal(AUDITED_BRAND.mark.sha256, sha256(mark));
  assert.deepEqual(DESKTOP_ICON_COMPOSITION, {
    size: 1_024,
    background: "#181516",
    backgroundInset: 48,
    cornerRadius: 208,
  });

  const composed = await composeDesktopIconMaster(mark);
  const metadata = await sharp(composed).metadata();
  assert.equal(metadata.width, 1_024);
  assert.equal(metadata.height, 1_024);

  const renderedMark = await sharp(mark).resize(1_024, 1_024, { fit: "fill" }).ensureAlpha().raw().toBuffer();
  const renderedIcon = await sharp(composed).ensureAlpha().raw().toBuffer();
  const pixel = (bytes, x, y) => [...bytes.subarray((y * 1_024 + x) * 4, (y * 1_024 + x) * 4 + 4)];
  assert.deepEqual(pixel(renderedIcon, 0, 0), [0, 0, 0, 0]);
  assert.deepEqual(pixel(renderedIcon, 512, 64), [24, 21, 22, 255]);
  assert.deepEqual(pixel(renderedIcon, 64, 512), [24, 21, 22, 255]);

  let opaqueMarkPixels = 0;
  for (let offset = 0; offset < renderedMark.length; offset += 4) {
    if (renderedMark[offset + 3] !== 255) continue;
    opaqueMarkPixels += 1;
    assert.deepEqual(
      [...renderedIcon.subarray(offset, offset + 4)],
      [...renderedMark.subarray(offset, offset + 4)],
      `opaque audited mark pixel changed at byte ${offset}`,
    );
  }
  assert.ok(opaqueMarkPixels > 500_000);
});

test("all human-review sizes derive from the composed 1024 master and retain the brand palette", async () => {
  const master = await composeDesktopIconMaster(await readFile(markPath));
  for (const size of [16, 32, 128, 512, 1_024]) {
    const { data, info } = await sharp(master)
      .resize(size, size, { fit: "fill" })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    assert.equal(info.width, size);
    assert.equal(info.height, size);
    const opaqueColors = [];
    let transparent = 0;
    for (let offset = 0; offset < data.length; offset += 4) {
      const alpha = data[offset + 3];
      if (alpha === 0) transparent += 1;
      if (alpha === 255) opaqueColors.push([data[offset], data[offset + 1], data[offset + 2]]);
    }
    assert.ok(transparent > 0, `${size}px icon lost rounded transparent corners`);
    assert.equal(nearestPaletteDistance(opaqueColors, [24, 21, 22]), 0, `${size}px icon lost graphite`);
    assert.ok(
      nearestPaletteDistance(opaqueColors, [196, 40, 28]) <= (size === 16 ? 120 : size === 32 ? 24 : 0),
      `${size}px icon lost classic red`,
    );
    assert.ok(
      nearestPaletteDistance(opaqueColors, [242, 237, 231]) <= (size === 16 ? 4 : 0),
      `${size}px icon lost warm white`,
    );
  }
});

test("the wordmark audited master remains byte-identical while changing only icon composition", async () => {
  const wordmark = await readFile(resolve(desktopRoot, "assets/brand/rbxforge-wordmark.svg"));
  assert.equal(wordmark.length, 2_420);
  assert.equal(sha256(wordmark), "a76953bac620eda2fc1dce6c45d117fde52aaa1d09acb8e062a0f1c1a43aeab6");
  assert.equal(AUDITED_BRAND.wordmark.sha256, sha256(wordmark));
});

function nearestPaletteDistance(colors, target) {
  let nearest = Number.POSITIVE_INFINITY;
  for (const color of colors) {
    nearest = Math.min(
      nearest,
      Math.abs(color[0] - target[0]) + Math.abs(color[1] - target[1]) + Math.abs(color[2] - target[2]),
    );
  }
  return nearest;
}
