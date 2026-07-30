import { createRequire } from "node:module";
import { copyFile, mkdir, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { repositoryRoot, runChecked, sha256 } from "./lib/repository.mjs";

const desktopRoot = resolve(repositoryRoot, "apps/desktop");
const brandRoot = resolve(desktopRoot, "assets/brand");
const buildRoot = resolve(desktopRoot, "build");
const iconsetRoot = resolve(buildRoot, "rbxforge.iconset");
const pngRoot = resolve(buildRoot, "brand");
const markPath = resolve(brandRoot, "rbxforge-mark.svg");
const wordmarkPath = resolve(brandRoot, "rbxforge-wordmark.svg");

export const AUDITED_BRAND = Object.freeze({
  mark: Object.freeze({
    bytes: 954,
    sha256: "f3fdcfb89f46ede47ada4289b73ac6e8020c0a1984ee72e532c02f4cc989f26d",
    viewBox: "0 0 1024 1024",
    construction: "forge-cut-45",
  }),
  wordmark: Object.freeze({
    bytes: 2_420,
    sha256: "a76953bac620eda2fc1dce6c45d117fde52aaa1d09acb8e062a0f1c1a43aeab6",
    viewBox: "0 0 1500 220",
    construction: "forge-cut-45",
  }),
});

export const DESKTOP_ICON_COMPOSITION = Object.freeze({
  size: 1_024,
  background: "#181516",
  backgroundInset: 48,
  cornerRadius: 208,
});

const desktopRequire = createRequire(resolve(desktopRoot, "package.json"));
const sharp = desktopRequire("sharp");

export async function composeDesktopIconMaster(mark) {
  const { background, backgroundInset, cornerRadius, size } = DESKTOP_ICON_COMPOSITION;
  const backgroundSize = size - backgroundInset * 2;
  const roundedSquare = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><rect x="${backgroundInset}" y="${backgroundInset}" width="${backgroundSize}" height="${backgroundSize}" rx="${cornerRadius}" fill="${background}"/></svg>`,
  );
  const renderedMark = await sharp(mark).resize(size, size, { fit: "fill" }).png().toBuffer();
  return sharp({
    create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([{ input: roundedSquare }, { input: renderedMark }])
    .png()
    .toBuffer();
}

export async function generateDesktopBrand() {
  if (process.platform !== "darwin") throw new Error("Desktop .icns generation requires macOS iconutil.");
  const [mark, wordmark] = await Promise.all([
    auditMaster(markPath, AUDITED_BRAND.mark, "mark"),
    auditMaster(wordmarkPath, AUDITED_BRAND.wordmark, "wordmark"),
  ]);
  const iconMaster = await composeDesktopIconMaster(mark);
  for (const target of [iconsetRoot, pngRoot]) {
    if (!target.startsWith(`${desktopRoot}/`) || target === desktopRoot) {
      throw new Error(`Refusing to recreate unsafe desktop brand path: ${target}`);
    }
    await rm(target, { recursive: true, force: true });
    await mkdir(target, { recursive: true });
  }

  const sizes = [16, 32, 64, 128, 256, 512, 1024];
  for (const size of sizes) {
    await sharp(iconMaster)
      .resize(size, size, { fit: "fill" })
      .png()
      .toFile(resolve(pngRoot, `rbxforge-${size}.png`));
  }
  for (const [name, size] of [
    ["icon_16x16.png", 16],
    ["icon_16x16@2x.png", 32],
    ["icon_32x32.png", 32],
    ["icon_32x32@2x.png", 64],
    ["icon_128x128.png", 128],
    ["icon_128x128@2x.png", 256],
    ["icon_256x256.png", 256],
    ["icon_256x256@2x.png", 512],
    ["icon_512x512.png", 512],
    ["icon_512x512@2x.png", 1024],
  ]) {
    await copyFile(resolve(pngRoot, `rbxforge-${size}.png`), resolve(iconsetRoot, name));
  }
  await runChecked("/usr/bin/iconutil", ["-c", "icns", "-o", resolve(buildRoot, "rbxforge.icns"), iconsetRoot]);

  const wordmarkPng = await sharp(wordmark).resize(1_500, 220, { fit: "fill" }).png().toBuffer();
  const background = sharp({
    create: { width: 2_100, height: 1_420, channels: 4, background: "#100e0f" },
  });
  const composites = [{ input: wordmarkPng, left: 50, top: 50 }];
  let left = 50;
  for (const size of [16, 32, 128, 512, 1024]) {
    const input = await sharp(iconMaster).resize(size, size, { fit: "fill" }).png().toBuffer();
    composites.push({ input, left, top: 320 });
    left += size + 36;
  }
  await background.composite(composites).png().toFile(resolve(buildRoot, "rbxforge-brand-contact-sheet.png"));
  return Object.freeze({
    icon: resolve(buildRoot, "rbxforge.icns"),
    contactSheet: resolve(buildRoot, "rbxforge-brand-contact-sheet.png"),
    sizes: Object.freeze(sizes),
  });
}

async function auditMaster(path, expected, label) {
  const bytes = await readFile(path);
  const source = bytes.toString("utf8");
  if (
    bytes.length !== expected.bytes ||
    sha256(bytes) !== expected.sha256 ||
    !source.includes(`viewBox="${expected.viewBox}"`) ||
    !source.includes(`data-construction="${expected.construction}"`)
  ) {
    throw new Error(`Desktop ${label} SVG master changed from its audited vector contract.`);
  }
  return bytes;
}

if (pathToFileURL(process.argv[1] ?? "").href === import.meta.url) {
  console.log(JSON.stringify(await generateDesktopBrand(), undefined, 2));
}
