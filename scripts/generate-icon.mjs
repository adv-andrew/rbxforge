import { deflateSync } from "node:zlib";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { extensionSourceRoot } from "./lib/repository.mjs";

const width = 128;
const height = 128;
const svgPath = resolve(extensionSourceRoot, "media/rbxforge.svg");
const outputPath = resolve(extensionSourceRoot, "media/rbxforge.png");
const svg = await readFile(svgPath, "utf8");
if (!svg.includes("#f5f5f5") || !svg.includes("#ff4b4b")) {
  throw new Error("The deterministic PNG generator no longer matches the Activity Bar brand source");
}

const scanlines = Buffer.alloc((width * 4 + 1) * height);
for (let y = 0; y < height; y += 1) {
  const row = y * (width * 4 + 1);
  scanlines[row] = 0;
  for (let x = 0; x < width; x += 1) {
    const pixel = row + 1 + x * 4;
    const outer = insideHexagon(x + 0.5, y + 0.5, 64, 64, 56);
    const innerCutout = insideHexagon(x + 0.5, y + 0.5, 64, 64, 36);
    const core = insideHexagon(x + 0.5, y + 0.5, 64, 64, 24);
    const color = core ? [255, 75, 75, 255] : outer && !innerCutout ? [245, 245, 245, 255] : [20, 23, 31, 255];
    scanlines.set(color, pixel);
  }
}

const png = Buffer.concat([
  Buffer.from("89504e470d0a1a0a", "hex"),
  chunk("IHDR", ihdr(width, height)),
  chunk("IDAT", deflateSync(scanlines, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);
await writeFile(outputPath, png);

function insideHexagon(x, y, centerX, centerY, radius) {
  const normalizedX = Math.abs(x - centerX) / radius;
  const normalizedY = Math.abs(y - centerY) / radius;
  return normalizedY <= 0.866 && 0.866 * normalizedX + 0.5 * normalizedY <= 0.866;
}

function ihdr(imageWidth, imageHeight) {
  const data = Buffer.alloc(13);
  data.writeUInt32BE(imageWidth, 0);
  data.writeUInt32BE(imageHeight, 4);
  data.set([8, 6, 0, 0, 0], 8);
  return data;
}

function chunk(type, data) {
  const name = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
    }
  }
  return (value ^ 0xffffffff) >>> 0;
}
