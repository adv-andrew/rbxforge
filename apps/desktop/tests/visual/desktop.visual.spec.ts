import { expect, test, type Page } from "@playwright/test";
import sharp from "sharp";

import { launchElectronFixture } from "../electron/electron-fixture.js";
import { VISUAL_STATES, type VisualState } from "./visual-fixtures.js";

const VIEWPORTS = [
  { width: 960, height: 640 },
  { width: 1280, height: 800 },
  { width: 1440, height: 900 },
] as const;
const SHEET_STATES = new Set<VisualState>(["studio-selection", "studio-bound", "mismatch-error"]);
const WORKING_STATES = new Set<VisualState>([
  "empty-chat",
  "populated-chat",
  "studio-selection",
  "studio-bound",
  "mismatch-error",
]);

test.describe.configure({ mode: "serial" });

for (const state of VISUAL_STATES) {
  for (const viewport of VIEWPORTS) {
    test(`${state} at ${viewport.width}x${viewport.height}`, async () => {
      const fixture = await launchElectronFixture(state, viewport);
      try {
        const page = fixture.window;
        await page.mouse.move(viewport.width - 2, 2);
        if (SHEET_STATES.has(state)) {
          await page.locator("[data-main-connection-action=true]").click();
          await expect(page.getByRole("dialog", { name: "Connection setup" })).toBeVisible();
          await expect(page.getByText("Studio plugin installed")).toBeVisible();
          await revealStateSpecificSheetEvidence(page, state);
        }

        await expectShellGeometry(page, fixture, viewport);
        await expectNoHorizontalOverflow(page);
        if (SHEET_STATES.has(state)) await expectSheetGeometry(page, viewport);
        if (state === "onboarding") await expectOnboardingGeometry(page, viewport);
        await expectDisabledPrimaryIsNeutral(page, state);

        const screenshotName = `${state}-${viewport.width}x${viewport.height}.png`;
        await expect(page).toHaveScreenshot(screenshotName, {
          animations: "disabled",
          caret: "hide",
          maxDiffPixels: 0,
          scale: "css",
          threshold: 0,
        });
        const screenshot = await page.screenshot({
          animations: "disabled",
          caret: "hide",
          scale: "css",
        });
        const metadata = await sharp(screenshot).metadata();
        expect({ width: metadata.width, height: metadata.height }).toEqual(viewport);
        if (WORKING_STATES.has(state)) {
          expect(await classicRedRatio(screenshot, await accessibleBrandRects(page))).toBeLessThan(0.1);
        }
      } finally {
        await fixture.close();
      }
    });
  }
}

async function revealStateSpecificSheetEvidence(page: Page, state: VisualState): Promise<void> {
  const target =
    state === "studio-selection"
      ? page.getByRole("heading", { name: "4 Studio place" })
      : state === "studio-bound"
        ? page.getByText("Studio bound after your manual Rojo handoff confirmation.").first()
        : page.getByRole("alert");
  await target.evaluate((element) => {
    element.scrollIntoView({ behavior: "instant", block: "center", inline: "nearest" });
  });
  await expect(target).toBeVisible();
  const scrollRegion = page.locator("[data-sheet-scroll-region=true]");
  const settledTop = await scrollRegion.evaluate((element) => element.scrollTop);
  await expect
    .poll(() => scrollRegion.evaluate((element) => element.scrollTop), {
      intervals: [100, 150],
      timeout: 500,
    })
    .toBe(settledTop);
  await page.mouse.move(2, 2);
  await page.waitForTimeout(1_000);
}

async function expectShellGeometry(
  page: Page,
  fixture: Awaited<ReturnType<typeof launchElectronFixture>>,
  viewport: { readonly width: number; readonly height: number },
): Promise<void> {
  const geometry = await fixture.geometry();
  expect(geometry.bounds).toMatchObject(viewport);
  expect(geometry.minimumSize).toEqual([960, 640]);
  expect(geometry.buttonPosition).toEqual({ x: 14, y: 14 });

  const shell = await page.evaluate(() => {
    const sidebar = document.querySelector<HTMLElement>("aside[aria-label='RbxForge projects']")!;
    const header = document.querySelector<HTMLElement>("header[aria-label='Project status']")!;
    const main = document.querySelector<HTMLElement>("main[aria-label='Conversation']")!;
    const brand = document.querySelector<HTMLElement>("[data-brand]")!;
    const rectangle = (element: HTMLElement) => {
      const box = element.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height, right: box.right, bottom: box.bottom };
    };
    const boundedContent = [
      document.querySelector<HTMLElement>("section[aria-label='Conversation history'] > div"),
      document.querySelector<HTMLElement>("section[aria-label='Local prompt composer'] > div"),
    ].filter((element): element is HTMLElement => element !== null);
    return {
      brand: rectangle(brand),
      header: rectangle(header),
      main: rectangle(main),
      sidebar: rectangle(sidebar),
      contentWidths: boundedContent.map((element) => element.getBoundingClientRect().width),
    };
  });
  expect(shell.sidebar).toMatchObject({ x: 0, y: 0, width: 272, height: viewport.height });
  expect(shell.sidebar.width).toBeGreaterThanOrEqual(232);
  expect(shell.sidebar.width).toBeLessThanOrEqual(360);
  expect(shell.header).toMatchObject({
    x: 272,
    y: 0,
    width: viewport.width - 272,
    height: 60,
  });
  expect(shell.main).toMatchObject({
    x: 272,
    y: 60,
    width: viewport.width - 272,
    height: viewport.height - 60,
  });
  expect(shell.contentWidths.every((width) => width <= 760)).toBe(true);
  expect(shell.brand.x).toBeGreaterThanOrEqual(84);
  expect(shell.brand.y).toBeGreaterThanOrEqual(12);
  expect(geometry.buttonPosition!.x + 54).toBeLessThan(shell.brand.x);
  expect(geometry.buttonPosition!.y + 14).toBeLessThan(shell.header.height);
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => {
    const rootFits = document.documentElement.scrollWidth <= document.documentElement.clientWidth;
    const offenders = [...document.querySelectorAll<HTMLElement>("*")]
      .filter((element) => {
        const style = getComputedStyle(element);
        const box = element.getBoundingClientRect();
        const visible =
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          box.width > 0 &&
          box.height > 0 &&
          box.bottom > 0 &&
          box.top < innerHeight;
        const intentionalEllipsis = element.dataset.ellipsized === "true" || style.textOverflow === "ellipsis";
        const textLeaf = element.childElementCount === 0 && (element.textContent?.trim().length ?? 0) > 0;
        return visible && textLeaf && !intentionalEllipsis && element.scrollWidth > element.clientWidth + 1;
      })
      .map((element) => ({
        tag: element.tagName.toLowerCase(),
        label: element.getAttribute("aria-label"),
        text: element.childElementCount === 0 ? element.textContent?.trim().slice(0, 120) : undefined,
        overflow: element.scrollWidth - element.clientWidth,
      }));
    return { rootFits, offenders };
  });
  expect(overflow.rootFits).toBe(true);
  expect(overflow.offenders).toEqual([]);
}

async function expectSheetGeometry(page: Page, viewport: { readonly width: number; readonly height: number }) {
  const geometry = await page.getByRole("dialog", { name: "Connection setup" }).evaluate((sheet) => {
    const box = sheet.getBoundingClientRect();
    const scrollRegion = sheet.querySelector<HTMLElement>("[data-sheet-scroll-region=true]")!;
    const scrollBox = scrollRegion.getBoundingClientRect();
    const footer = sheet.querySelector<HTMLElement>("[data-sticky-action-footer=true]")!;
    const footerBox = footer.getBoundingClientRect();
    const occludedContent = [...scrollRegion.querySelectorAll<HTMLElement>("*")]
      .filter((element) => {
        if (footer.contains(element) || element.contains(footer)) return false;
        const style = getComputedStyle(element);
        const elementBox = element.getBoundingClientRect();
        const visible =
          style.display !== "none" && style.visibility !== "hidden" && elementBox.width > 0 && elementBox.height > 0;
        const hasOwnEvidence =
          element.matches("button, input, label, p, h3, code, [role='alert']") ||
          (element.childElementCount === 0 && (element.textContent?.trim().length ?? 0) > 0);
        const clippedTop = Math.max(elementBox.top, scrollBox.top);
        const clippedBottom = Math.min(elementBox.bottom, scrollBox.bottom);
        return visible && hasOwnEvidence && clippedBottom > footerBox.top && clippedTop < footerBox.bottom;
      })
      .map((element) => ({
        tag: element.tagName.toLowerCase(),
        text: element.textContent?.trim().slice(0, 100),
      }));
    return {
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
      scrollClientWidth: scrollRegion.clientWidth,
      scrollWidth: scrollRegion.scrollWidth,
      scrollViewport: { top: scrollBox.top, bottom: scrollBox.bottom },
      footer: { top: footerBox.top, right: footerBox.right, bottom: footerBox.bottom, left: footerBox.left },
      occludedContent,
    };
  });
  expect(geometry).toMatchObject({
    x: viewport.width - 480,
    y: 0,
    width: 480,
    height: viewport.height,
  });
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.scrollClientWidth);
  expect(geometry.scrollViewport.bottom).toBeLessThanOrEqual(geometry.footer.top);
  expect(geometry.footer.left).toBeGreaterThanOrEqual(geometry.x);
  expect(geometry.footer.right).toBeLessThanOrEqual(viewport.width);
  expect(geometry.footer.top).toBeGreaterThanOrEqual(0);
  expect(geometry.footer.bottom).toBeLessThanOrEqual(viewport.height);
  expect(geometry.occludedContent).toEqual([]);
}

async function expectOnboardingGeometry(
  page: Page,
  viewport: { readonly width: number; readonly height: number },
): Promise<void> {
  const geometry = await page.locator("[data-onboarding-state=true]").evaluate((element) => {
    const box = element.getBoundingClientRect();
    const mark = element.querySelector<HTMLElement>("[data-testid=onboarding-mark]")!.getBoundingClientRect();
    return {
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
      mark: { width: mark.width, height: mark.height },
    };
  });
  expect(geometry.width).toBeLessThanOrEqual(480);
  expect(geometry.y).toBeGreaterThanOrEqual(96);
  expect(geometry.y + geometry.height).toBeLessThan(viewport.height * 0.7);
  expect(geometry.mark).toEqual({ width: 64, height: 64 });
}

async function expectDisabledPrimaryIsNeutral(page: Page, state: VisualState): Promise<void> {
  const primary = page.locator(
    "button[data-button-variant=primary]:disabled, button[data-button-variant=primary][aria-disabled=true]",
  );
  const count = await primary.count();
  if (state === "studio-selection") expect(count).toBeGreaterThan(0);
  for (let index = 0; index < count; index += 1) {
    const colors = await primary.nth(index).evaluate((element) => {
      const style = getComputedStyle(element);
      return { background: style.backgroundColor, border: style.borderColor };
    });
    expect(colors).toEqual({ background: "rgb(26, 32, 41)", border: "rgb(39, 46, 57)" });
  }
}

async function accessibleBrandRects(page: Page) {
  return page.locator("img[data-brand][alt='RbxForge']").evaluateAll((images) =>
    images.map((image) => {
      const box = image.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height };
    }),
  );
}

async function classicRedRatio(
  screenshot: Buffer,
  exclusions: readonly { readonly x: number; readonly y: number; readonly width: number; readonly height: number }[],
): Promise<number> {
  const { data, info } = await sharp(screenshot).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let opaque = 0;
  let classicRed = 0;
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      if (
        exclusions.some(
          (rectangle) =>
            x >= Math.floor(rectangle.x) &&
            x < Math.ceil(rectangle.x + rectangle.width) &&
            y >= Math.floor(rectangle.y) &&
            y < Math.ceil(rectangle.y + rectangle.height),
        )
      ) {
        continue;
      }
      const offset = (y * info.width + x) * 4;
      if (data[offset + 3] === 0) continue;
      opaque += 1;
      if (data[offset] === 196 && data[offset + 1] === 40 && data[offset + 2] === 28) classicRed += 1;
    }
  }
  if (opaque === 0) throw new Error("The screenshot did not contain any sampled opaque pixels.");
  return classicRed / opaque;
}
