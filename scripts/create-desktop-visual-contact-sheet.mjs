import { createRequire } from "node:module";
import { mkdir, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { repositoryRoot } from "./lib/repository.mjs";

const desktopRoot = resolve(repositoryRoot, "apps/desktop");
const desktopRequire = createRequire(resolve(desktopRoot, "package.json"));
const sharp = desktopRequire("sharp");

const STATES = ["onboarding", "empty-chat", "populated-chat", "studio-selection", "studio-bound", "mismatch-error"];
const VIEWPORTS = ["960x640", "1280x800", "1440x900"];

export const DESKTOP_VISUAL_SCREENSHOTS = Object.freeze(
  STATES.flatMap((state) => VIEWPORTS.map((viewport) => `${state}-${viewport}.png`)),
);

export async function createDesktopVisualContactSheet({ screenshotsRoot, outputPath }) {
  const inventory = (await readdir(screenshotsRoot))
    .filter((name) => name.endsWith(".png"))
    .sort((left, right) => left.localeCompare(right));
  const expected = [...DESKTOP_VISUAL_SCREENSHOTS].sort((left, right) => left.localeCompare(right));
  const missing = expected.filter((name) => !inventory.includes(name));
  const unexpected = inventory.filter((name) => !expected.includes(name));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `Desktop contact sheet requires the exact 18-screenshot matrix; ` +
        `missing=[${missing.join(", ")}] unexpected=[${unexpected.join(", ")}]`,
    );
  }

  const cellWidth = 480;
  const cellHeight = 328;
  const imageWidth = 472;
  const imageHeight = 292;
  const composites = [];
  for (const [index, name] of DESKTOP_VISUAL_SCREENSHOTS.entries()) {
    const row = Math.floor(index / VIEWPORTS.length);
    const column = index % VIEWPORTS.length;
    const panel = await sharp(resolve(screenshotsRoot, name))
      .resize({ width: imageWidth, height: imageHeight, fit: "contain", background: "#0b0d10" })
      .png()
      .toBuffer();
    const metadata = await sharp(panel).metadata();
    const left = column * cellWidth + Math.floor((cellWidth - (metadata.width ?? imageWidth)) / 2);
    const top = row * cellHeight + 32 + Math.floor((imageHeight - (metadata.height ?? imageHeight)) / 2);
    composites.push({ input: panel, left, top });
    composites.push({
      input: Buffer.from(labelSvg(cellWidth, 28, name.replace(/\.png$/, ""))),
      left: column * cellWidth,
      top: row * cellHeight,
    });
  }

  await mkdir(dirname(outputPath), { recursive: true });
  await sharp({
    create: {
      width: cellWidth * VIEWPORTS.length,
      height: cellHeight * STATES.length,
      channels: 4,
      background: "#090b0d",
    },
  })
    .composite(composites)
    .png()
    .toFile(outputPath);

  return Object.freeze({
    files: DESKTOP_VISUAL_SCREENSHOTS,
    panels: DESKTOP_VISUAL_SCREENSHOTS.length,
    outputPath,
  });
}

function labelSvg(width, height, label) {
  const safe = label.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect width="${width}" height="${height}" fill="#0f1217"/>
    <rect x="8" y="13" width="12" height="2" fill="#c4281c"/>
    <text x="28" y="19" fill="#f4f6f8" font-family="-apple-system, BlinkMacSystemFont, sans-serif" font-size="13">${safe}</text>
  </svg>`;
}

if (pathToFileURL(process.argv[1] ?? "").href === import.meta.url) {
  const screenshotsRoot = resolve(desktopRoot, "tests/visual/__screenshots__");
  const outputPath = resolve(desktopRoot, "test-results/desktop-visual-contact-sheet.png");
  const result = await createDesktopVisualContactSheet({ screenshotsRoot, outputPath });
  console.log(JSON.stringify(result, undefined, 2));
}
