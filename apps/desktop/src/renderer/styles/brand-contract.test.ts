// @vitest-environment jsdom

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import sharp from "sharp";
import { describe, expect, it } from "vitest";

const brandRoot = resolve(import.meta.dirname, "../../../assets/brand");
const allowedElements = new Set(["svg", "metadata", "path"]);
const allowedAttributes = new Set([
  "xmlns",
  "viewBox",
  "role",
  "aria-label",
  "data-construction",
  "fill",
  "stroke",
  "stroke-width",
  "stroke-linejoin",
  "d",
]);
const palette = new Set(["#181516", "#2A2020", "#090808", "#C4281C", "#F2EDE7", "none"]);

async function asset(name: string): Promise<string> {
  return readFile(resolve(brandRoot, name), "utf8");
}

describe.each([
  ["rbxforge-mark.svg", "0 0 1024 1024"],
  ["rbxforge-wordmark.svg", "0 0 1500 220"],
])("%s", (name, viewBox) => {
  it("is an original, self-contained path-only master", async () => {
    const source = await asset(name);
    expect(source).not.toMatch(/<!DOCTYPE|<!ENTITY|\son[a-z]+\s*=|url\(|javascript:/i);
    const parsed = new DOMParser().parseFromString(source, "image/svg+xml");
    expect(parsed.querySelector("parsererror")).toBeNull();
    const root = parsed.documentElement;
    expect(root.tagName).toBe("svg");
    expect(root.getAttribute("xmlns")).toBe("http://www.w3.org/2000/svg");
    expect(root.getAttribute("viewBox")).toBe(viewBox);
    expect(root.getAttribute("role")).toBe("img");
    expect(root.getAttribute("aria-label")).toBe("RbxForge");
    expect(root.getAttribute("data-construction")).toBe("forge-cut-45");
    expect(root.querySelector("metadata")?.textContent).toMatch(/original/i);

    for (const element of [root, ...root.querySelectorAll("*")]) {
      expect(allowedElements, `element ${element.tagName}`).toContain(element.tagName);
      for (const attribute of element.attributes) {
        expect(allowedAttributes, `attribute ${attribute.name}`).toContain(attribute.name);
        if (attribute.name === "fill" || attribute.name === "stroke") {
          expect(palette, `${attribute.name}=${attribute.value}`).toContain(attribute.value);
        }
      }
    }
  });
});

it("preserves the approved RF forge-plate geometry exactly", async () => {
  const root = new DOMParser().parseFromString(await asset("rbxforge-mark.svg"), "image/svg+xml").documentElement;
  expect([...root.querySelectorAll("path")].map((path) => path.getAttribute("d"))).toEqual([
    "M176 104H736L920 288V848L848 920H176L104 848V176Z",
    "M184 128H728L896 296V840L840 896H184L128 840V184Z",
    "M266 292H558L634 368V514L582 566L646 732H520L466 584H388V732H266Z",
    "M246 272H570L654 356V522L606 570L674 752H500L446 604H408V752H246ZM408 398V478H506L526 458V418L506 398Z",
    "M266 292H558L634 368V510L582 562L646 732H520L466 584H388V732H266ZM388 398V478H506L526 458V418L506 398Z",
    "M632 272H832L872 312V390H754V454H842V568H754V752H632Z",
    "M652 292H812L852 332V370H734V474H822V548H734V732H652Z",
  ]);
});

it("uses the specified wordmark face, outline, keyline, and unblurred depth layers", async () => {
  const root = new DOMParser().parseFromString(await asset("rbxforge-wordmark.svg"), "image/svg+xml").documentElement;
  const paths = [...root.querySelectorAll("path")];
  expect(paths.map((path) => path.getAttribute("stroke"))).toEqual(["#090808", "#2A2020", "#C4281C", "#F2EDE7"]);
  expect(paths.map((path) => path.getAttribute("stroke-width"))).toEqual(["53", "53", "48", "28"]);
  expect(paths.every((path) => path.getAttribute("stroke-linejoin") === "bevel")).toBe(true);
  expect(paths[3]?.getAttribute("d")).toContain("M775 52L800 27H925L950 52V162");
  expect(paths[0]?.getAttribute("d")).toContain("M613 190V30H728L748 50");
  expect(paths[0]?.getAttribute("d")).toContain("M1373 190V30H1453L1473 50");
  for (const path of paths.slice(1)) {
    expect(path.getAttribute("d")).toContain("M610 187V27H725L745 47");
    expect(path.getAttribute("d")).toContain("M1370 187V27H1450L1470 47");
  }
});

it("keeps visible 45-degree outside cuts on the F and E at native resolution", async () => {
  const { data, info } = await sharp(Buffer.from(await asset("rbxforge-wordmark.svg")))
    .resize(1500, 220)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const isWarmWhite = (x: number, y: number) => {
    const offset = (y * info.width + x) * 4;
    return data[offset]! > 220 && data[offset + 1]! > 210 && data[offset + 2]! > 200;
  };
  expect(isWarmWhite(744, 18)).toBe(false);
  expect(isWarmWhite(735, 37)).toBe(true);
  expect(isWarmWhite(1469, 18)).toBe(false);
  expect(isWarmWhite(1460, 37)).toBe(true);
});

it("keeps the native wordmark inside its viewBox after adding the F and E cuts", async () => {
  const { data, info } = await sharp(Buffer.from(await asset("rbxforge-wordmark.svg")))
    .resize(1500, 220)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const alpha = (x: number, y: number) => data[(y * info.width + x) * 4 + 3] ?? 0;
  const top = Math.max(...Array.from({ length: info.width }, (_, x) => alpha(x, 0)));
  expect(top).toBeLessThan(128);
  expect(Array.from({ length: info.width }, (_, x) => alpha(x, info.height - 1)).every((value) => value === 0)).toBe(
    true,
  );
  expect(Array.from({ length: info.height }, (_, y) => alpha(0, y)).every((value) => value === 0)).toBe(true);
  expect(Array.from({ length: info.height }, (_, y) => alpha(info.width - 1, y)).every((value) => value === 0)).toBe(
    true,
  );
});

it.each([16, 32, 64, 128, 512, 1024])(
  "renders the RF mark with transparent, unclipped, meaningful color bounds at %ipx",
  async (size) => {
    const source = await asset("rbxforge-mark.svg");
    const { data, info } = await sharp(Buffer.from(source))
      .resize(size, size, { fit: "contain" })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const alpha = (x: number, y: number) => data[(y * info.width + x) * 4 + 3] ?? 0;
    expect([...Array(size).keys()].every((index) => alpha(index, 0) === 0)).toBe(true);
    expect([...Array(size).keys()].every((index) => alpha(index, size - 1) === 0)).toBe(true);
    expect([...Array(size).keys()].every((index) => alpha(0, index) === 0)).toBe(true);
    expect([...Array(size).keys()].every((index) => alpha(size - 1, index) === 0)).toBe(true);
    const opaque = [...Array(size * size).keys()].filter((index) => data[index * 4 + 3]! > 0);
    const red = opaque.filter((index) => data[index * 4]! > 130 && data[index * 4 + 1]! < 100);
    const warmWhite = opaque.filter(
      (index) => data[index * 4]! > 180 && data[index * 4 + 1]! > 170 && data[index * 4 + 2]! > 160,
    );
    expect(opaque.length).toBeGreaterThan(size * size * 0.2);
    expect(red.length).toBeGreaterThan(0);
    expect(warmWhite.length).toBeGreaterThan(0);
  },
);

it.each([16, 24, 32, 64])("renders the wordmark proportionally at %ipx high", async (height) => {
  const source = await asset("rbxforge-wordmark.svg");
  const { info } = await sharp(Buffer.from(source))
    .resize({ height, fit: "inside" })
    .png()
    .toBuffer({ resolveWithObject: true });
  expect(info.height).toBe(height);
  expect(info.width).toBe(Math.round((1500 / 220) * height));
});

it("fits the intended sidebar lockup without square resizing", async () => {
  const source = await asset("rbxforge-wordmark.svg");
  const { info } = await sharp(Buffer.from(source)).resize({ width: 164 }).png().toBuffer({ resolveWithObject: true });
  expect(info.width).toBe(164);
  expect(info.height).toBe(24);
  expect(84 + info.width + 12).toBeLessThanOrEqual(260);
});
