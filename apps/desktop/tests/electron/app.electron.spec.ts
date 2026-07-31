import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
import Database from "better-sqlite3";

import { ConversationRepository } from "../../src/main/storage/conversation-repository.js";
import { openDesktopDatabase } from "../../src/main/storage/database.js";
import { launchElectronFixture } from "./electron-fixture.js";
import { VISUAL_STATES } from "../visual/visual-fixtures.js";

test.describe.configure({ mode: "serial" });

test("restores valid SQLite window bounds and ignores finite bounds below the production minimum", async () => {
  const restoredBounds = { x: 120, y: 120, width: 1_100, height: 700 };
  const restored = await launchElectronFixture(
    "empty-chat",
    { width: restoredBounds.width, height: restoredBounds.height },
    { preseedWindowBounds: restoredBounds },
  );
  try {
    expect((await restored.geometry()).bounds).toEqual(restoredBounds);
  } finally {
    await restored.close();
  }

  const invalid = await launchElectronFixture(
    "empty-chat",
    { width: 1_280, height: 800 },
    { preseedWindowBounds: { x: 120, y: 120, width: 959, height: 639 } },
  );
  try {
    expect((await invalid.geometry()).bounds).toMatchObject({ width: 1_280, height: 800 });
  } finally {
    await invalid.close();
  }
});

test("launches one hardened window with native geometry, blocked escape hatches, and real storage", async () => {
  const fixture = await launchElectronFixture("empty-chat", { width: 1280, height: 800 });
  try {
    await expect(fixture.window).toHaveTitle("RbxForge");
    expect(await fixture.application.windows()).toHaveLength(1);
    await expect(fixture.window.getByRole("main", { name: "Conversation" })).toBeVisible();

    const geometry = await fixture.geometry();
    expect(geometry.bounds).toMatchObject({ width: 1280, height: 800 });
    expect(geometry.minimumSize).toEqual([960, 640]);
    expect(geometry.buttonPosition).toEqual({ x: 14, y: 14 });
    expect(await fixture.window.evaluate(() => globalThis.devicePixelRatio)).toBe(1);
    expect(await fixture.application.evaluate(() => process.argv)).toContain("--force-color-profile=srgb");

    const rendererBoundary = await fixture.window.evaluate(() => ({
      processType: typeof (globalThis as { process?: unknown }).process,
      requireType: typeof (globalThis as { require?: unknown }).require,
      apiKeys: Object.keys((globalThis as { rbxforge?: unknown }).rbxforge ?? {}).sort(),
    }));
    expect(rendererBoundary).toEqual({
      processType: "undefined",
      requireType: "undefined",
      apiKeys: ["onCloseBlocked", "onCloseRequest", "platform", "request", "subscribe"],
    });
    const originalUrl = fixture.window.url();
    expect(await fixture.window.evaluate(() => globalThis.open("https://example.com") === null)).toBe(true);
    expect(await fixture.application.windows()).toHaveLength(1);

    const dragContract = await fixture.window.evaluate(() => {
      const interactive = [
        ...document.querySelectorAll<HTMLElement>("button, input, textarea, select, a, [role=separator]"),
      ];
      return {
        interactive: interactive.map((element) =>
          getComputedStyle(element).getPropertyValue("-webkit-app-region").trim(),
        ),
        dragRegion: getComputedStyle(document.querySelector<HTMLElement>(".appDragRegion")!).getPropertyValue(
          "-webkit-app-region",
        ),
        brandRegion: getComputedStyle(document.querySelector<HTMLElement>("[data-brand]")!).getPropertyValue(
          "-webkit-app-region",
        ),
      };
    });
    expect(dragContract.interactive.length).toBeGreaterThan(0);
    expect(new Set(dragContract.interactive)).toEqual(new Set(["no-drag"]));
    expect(dragContract.dragRegion).toBe("drag");
    expect(dragContract.brandRegion).toBe("no-drag");

    const brandRect = await fixture.window.locator("[data-brand]").boundingBox();
    expect(brandRect).not.toBeNull();
    expect(brandRect!.x).toBeGreaterThanOrEqual(84);
    expect(brandRect!.y).toBeGreaterThanOrEqual(12);
    expect(geometry.buttonPosition!.x + 54).toBeLessThan(brandRect!.x);
    expect(geometry.buttonPosition!.y + 14).toBeLessThan(60);

    await access(fixture.databasePath);
    const database = new Database(fixture.databasePath, { readonly: true });
    try {
      expect(database.prepare("SELECT MAX(id) AS id FROM migrations").get()).toEqual({ id: 1 });
      expect(
        database
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
          .all()
          .map((row) => (row as { name: string }).name),
      ).toEqual(expect.arrayContaining(["app_state", "drafts", "messages", "projects", "settings", "threads"]));
    } finally {
      database.close();
    }

    expect(fixture.pageErrors).toEqual([]);
    expect(fixture.consoleErrors).toEqual([]);

    await fixture.window.evaluate(() => {
      const link = document.createElement("a");
      link.id = "acceptance-external-navigation";
      link.href = "https://example.com/blocked";
      link.textContent = "Blocked external navigation";
      document.body.append(link);
    });
    await fixture.window.locator("#acceptance-external-navigation").click({ noWaitAfter: true, timeout: 2_000 });
    await fixture.window.waitForTimeout(100);
    expect(fixture.window.url()).toBe(originalUrl);
  } finally {
    await fixture.close();
  }
});

test("flushes a typed draft behind an in-flight mutation and restores it from SQLite after a full relaunch", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "rbxforge-electron-persistence-"));
  const userDataDirectory = join(temporaryRoot, "user-data");
  let fixture = await launchElectronFixture(
    "empty-chat",
    { width: 1280, height: 800 },
    { holdExclusiveMutation: true, userDataDirectory },
  );
  try {
    const composer = fixture.window.getByRole<HTMLTextAreaElement>("textbox", { name: "Local project prompt" });
    await composer.fill("Draft persisted across a native close");
    await fixture.window.getByRole("button", { name: "Actions for Round-based lobby" }).click();
    await fixture.window.getByRole("menuitem", { name: "Rename" }).click();
    await fixture.window.getByRole("textbox", { name: "Conversation name" }).fill("Held mutation");
    await fixture.window.getByRole("button", { name: "Rename conversation" }).click();
    await expect
      .poll(() =>
        fixture.application.evaluate(
          ({ app }) =>
            (app as typeof app & { __rbxforgeFixtureState?: { readonly mutationPending: boolean } })
              .__rbxforgeFixtureState?.mutationPending,
        ),
      )
      .toBe(true);

    const closed = fixture.window.waitForEvent("close");
    await fixture.application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
    await fixture.window.waitForTimeout(100);
    expect(await fixture.application.windows()).toHaveLength(1);
    await fixture.application.evaluate(({ app }) => app.emit("rbxforge-fixture-release-mutation" as never));
    await closed;
    expect(await fixture.application.windows()).toHaveLength(0);

    const reopenedEvent = fixture.application.waitForEvent("window");
    await fixture.application.evaluate(({ app }) => app.emit("activate"));
    const reopened = await reopenedEvent;
    await reopened.waitForLoadState("domcontentloaded");
    await expect(reopened.getByRole("textbox", { name: "Local project prompt" })).toHaveValue(
      "Draft persisted across a native close",
    );

    await fixture.application.evaluate(({ BrowserWindow, app }) => {
      BrowserWindow.getAllWindows()[0]?.minimize();
      app.emit("second-instance", {}, [], "");
    });
    await expect
      .poll(() =>
        fixture.application.evaluate(({ BrowserWindow }) => ({
          minimized: BrowserWindow.getAllWindows()[0]?.isMinimized(),
          visible: BrowserWindow.getAllWindows()[0]?.isVisible(),
        })),
      )
      .toEqual({ minimized: false, visible: true });

    await fixture.close();
    const database = openDesktopDatabase(fixture.databasePath);
    try {
      const conversations = new ConversationRepository(database);
      const persistedThread = conversations.listThreads("fixture-project")[0];
      expect(persistedThread).toBeDefined();
      expect(conversations.loadDraft(persistedThread!.id)?.content).toBe("Draft persisted across a native close");
    } finally {
      database.close();
    }

    fixture = await launchElectronFixture("empty-chat", { width: 1280, height: 800 }, { userDataDirectory });
    await expect(fixture.window.getByRole("textbox", { name: "Local project prompt" })).toHaveValue(
      "Draft persisted across a native close",
    );
  } finally {
    await fixture.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("closes and quits after forced renderer crashes without retaining a stale window loop", async () => {
  const fixture = await launchElectronFixture("empty-chat", { width: 1280, height: 800 });
  try {
    await forceCrashRenderer(fixture.application);
    await fixture.application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
    await expect
      .poll(() => fixture.application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), {
        timeout: 1_000,
      })
      .toBe(0);

    const reopenedEvent = fixture.application.waitForEvent("window");
    await fixture.application.evaluate(({ app }) => app.emit("activate"));
    const reopened = await reopenedEvent;
    await reopened.waitForLoadState("domcontentloaded");
    await expect(reopened.getByRole("main", { name: "Conversation" })).toBeVisible();

    await forceCrashRenderer(fixture.application);
    const applicationClosed = fixture.application.waitForEvent("close");
    await fixture.application.evaluate(({ app }) => app.quit());
    await applicationClosed;
  } finally {
    await fixture.close();
  }
});

test("reloads the same crashed renderer and flushes an immediate sub-debounce draft before close", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "rbxforge-electron-reload-persistence-"));
  const userDataDirectory = join(temporaryRoot, "user-data");
  let fixture = await launchElectronFixture("empty-chat", { width: 1280, height: 800 }, { userDataDirectory });
  const draft = "Draft persisted after renderer reload";
  try {
    const originalWindowId = await fixture.application.evaluate(
      ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.id,
    );
    await test.step("force-crash the renderer", () => forceCrashRenderer(fixture.application));
    const recoveredWindowId = await test.step("reload the same native window", () =>
      reloadCrashedRenderer(fixture.application));
    expect(recoveredWindowId).toBe(originalWindowId);
    expect(await enterDraftAndCloseThroughReloadedWebContents(fixture.application, draft)).toBe(draft);
    await expect
      .poll(() => fixture.application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length))
      .toBe(0);
    const fixtureState = await fixture.application.evaluate(
      ({ app }) =>
        (
          app as typeof app & {
            __rbxforgeFixtureState?: {
              readonly closeBarrierRequests: number;
              readonly draftCloseEvents: readonly string[];
            };
          }
        ).__rbxforgeFixtureState,
    );
    expect(fixtureState?.closeBarrierRequests).toBe(1);
    expect(fixtureState?.draftCloseEvents).toEqual(["close-barrier-request", "draft-save"]);

    const reopenedEvent = fixture.application.waitForEvent("window");
    await fixture.application.evaluate(({ app }) => app.emit("activate"));
    const reopened = await reopenedEvent;
    await reopened.waitForLoadState("domcontentloaded");
    await expect(reopened.getByRole("textbox", { name: "Local project prompt" })).toHaveValue(draft);

    await fixture.close();
    fixture = await launchElectronFixture("empty-chat", { width: 1280, height: 800 }, { userDataDirectory });
    await expect(fixture.window.getByRole("textbox", { name: "Local project prompt" })).toHaveValue(draft);
  } finally {
    await fixture.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("passes the relevant WCAG 2.2 AA axe rules in all six deterministic states", async () => {
  for (const state of VISUAL_STATES) {
    const fixture = await launchElectronFixture(state, { width: 1280, height: 800 });
    try {
      if (state === "studio-selection" || state === "studio-bound" || state === "mismatch-error") {
        await fixture.window.locator("[data-main-connection-action=true]").click();
        await expect(fixture.window.getByRole("dialog", { name: "Connection setup" })).toBeVisible();
      }
      const results = await new AxeBuilder({ page: fixture.window })
        .setLegacyMode()
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
        .analyze();
      expect(results.violations, `${state}: ${formatAxeViolations(results.violations)}`).toEqual([]);
    } finally {
      await fixture.close();
    }
  }
});

test("keyboard-walks visible actions, menus, dialogs, and the sheet with exact focus restoration", async () => {
  const fixture = await launchElectronFixture("studio-selection", { width: 1280, height: 800 });
  try {
    await keyboardWalkAllVisible(fixture.window);

    const threadMenu = fixture.window.getByRole("button", { name: "Actions for Round-based lobby" });
    await threadMenu.focus();
    await fixture.window.keyboard.press("ArrowDown");
    await expect(fixture.window.getByRole("menuitem", { name: "Rename" })).toBeFocused();
    await expectTwoPixelFocus(fixture.window);
    await fixture.window.keyboard.press("Escape");
    await expect(threadMenu).toBeFocused();

    await fixture.window.keyboard.press("ArrowDown");
    await fixture.window.keyboard.press("Enter");
    const renameDialog = fixture.window.getByRole("dialog", { name: "Rename conversation" });
    await expect(renameDialog).toBeVisible();
    await expect(fixture.window.getByRole("textbox", { name: "Conversation name" })).toBeFocused();
    await expectTwoPixelFocus(fixture.window);
    await fixture.window.keyboard.press("Escape");
    await expect(renameDialog).toBeHidden();
    await expect(threadMenu).toBeFocused();

    const about = fixture.window.getByRole("button", { name: "About RbxForge" });
    await about.focus();
    await fixture.window.keyboard.press("Enter");
    const aboutDialog = fixture.window.getByRole("dialog", { name: "About RbxForge" });
    await expect(aboutDialog).toBeVisible();
    await expect(fixture.window.getByRole("button", { name: "Close" })).toBeFocused();
    await expectTwoPixelFocus(fixture.window);
    await fixture.window.keyboard.press("Escape");
    await expect(aboutDialog).toBeHidden();
    await expect(about).toBeFocused();

    const connection = fixture.window.locator("[data-main-connection-action=true]");
    await connection.focus();
    await fixture.window.keyboard.press("Enter");
    const sheet = fixture.window.getByRole("dialog", { name: "Connection setup" });
    await expect(sheet).toBeVisible();
    await expect(fixture.window.getByRole("button", { name: "Close connection setup" })).toBeFocused();
    await keyboardWalkAllVisible(fixture.window, '[role="dialog"]');
    await fixture.window.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    await expect(connection).toBeFocused();
  } finally {
    await fixture.close();
  }
});

test("reduced motion collapses transitions without moving the shell", async () => {
  const fixture = await launchElectronFixture("empty-chat", { width: 1280, height: 800 });
  try {
    const button = fixture.window.getByRole("button", { name: "Reconnect" });
    const shellBefore = await fixture.window.locator("main").boundingBox();
    const defaultDurations = await button.evaluate((element) => getComputedStyle(element).transitionDuration);
    expect(maxCssDurationSeconds(defaultDurations)).toBeGreaterThanOrEqual(0.12);

    await fixture.window.emulateMedia({ reducedMotion: "reduce" });
    const reducedDurations = await button.evaluate((element) => getComputedStyle(element).transitionDuration);
    expect(maxCssDurationSeconds(reducedDurations)).toBeLessThanOrEqual(0.000_01);
    expect(await fixture.window.locator("main").boundingBox()).toEqual(shellBefore);
  } finally {
    await fixture.close();
  }
});

async function forceCrashRenderer(application: import("@playwright/test").ElectronApplication): Promise<void> {
  await application.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window === undefined) throw new Error("Expected an Electron fixture window to crash.");
    return new Promise<void>((resolve) => {
      window.webContents.once("render-process-gone", () => resolve());
      window.webContents.forcefullyCrashRenderer();
    });
  });
}

async function reloadCrashedRenderer(
  application: import("@playwright/test").ElectronApplication,
): Promise<number | undefined> {
  return application.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window === undefined) throw new Error("Expected an Electron fixture window to reload.");
    return new Promise<number | undefined>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("The crashed renderer did not finish reloading."));
      }, 5_000);
      window.webContents.once("did-finish-load", () => {
        clearTimeout(timeout);
        resolve(BrowserWindow.getAllWindows()[0]?.id);
      });
      window.webContents.reload();
    });
  });
}

async function enterDraftAndCloseThroughReloadedWebContents(
  application: import("@playwright/test").ElectronApplication,
  draft: string,
): Promise<string> {
  return application.evaluate(async ({ BrowserWindow }, content) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window === undefined) throw new Error("Expected an Electron fixture window with a recovered renderer.");
    const serializedContent = JSON.stringify(content);
    const entered = await window.webContents.executeJavaScript(
      `new Promise((resolve, reject) => {
        const deadline = performance.now() + 5_000;
        const fill = () => {
          const composer = document.querySelector("#local-project-prompt");
          const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
          if (composer instanceof HTMLTextAreaElement && valueSetter !== undefined) {
            valueSetter.call(composer, ${serializedContent});
            composer.dispatchEvent(new Event("input", { bubbles: true }));
            requestAnimationFrame(() => resolve(composer.value));
            return;
          }
          if (performance.now() >= deadline) {
            reject(new Error("The recovered renderer did not expose the local project prompt."));
            return;
          }
          setTimeout(fill, 25);
        };
        fill();
      })`,
      true,
    );
    window.close();
    return entered;
  }, draft);
}

async function keyboardWalkAllVisible(page: import("@playwright/test").Page, scopeSelector?: string): Promise<void> {
  const markers = await page.evaluate((selector) => {
    const scope = selector === undefined ? document : document.querySelector(selector);
    if (scope === null) throw new Error(`Missing keyboard-walk scope: ${selector}`);
    const candidates = [
      ...scope.querySelectorAll<HTMLElement>(
        'a[href], button, input, select, textarea, details > summary:first-of-type, [tabindex]:not([tabindex="-1"])',
      ),
    ].filter((element) => {
      if (element.matches(":disabled") || element.closest("[inert], [aria-hidden=true]")) return false;
      let current: HTMLElement | null = element;
      while (current !== null) {
        const style = getComputedStyle(current);
        if (style.display === "none" || style.visibility === "hidden" || current.hidden) return false;
        current = current.parentElement;
      }
      return element.tabIndex >= 0;
    });
    return candidates.map((element, index) => {
      const marker = `acceptance-tab-${index}`;
      element.dataset.acceptanceTab = marker;
      return marker;
    });
  }, scopeSelector);
  expect(markers.length).toBeGreaterThan(0);

  const seen: string[] = [];
  if (scopeSelector === undefined) {
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press("Tab");
  }
  for (let index = 0; index < markers.length; index += 1) {
    const marker = await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.acceptanceTab);
    expect(marker, `Tab stop ${index + 1}/${markers.length}`).toBeDefined();
    seen.push(marker!);
    await expectTwoPixelFocus(page);
    await page.keyboard.press("Tab");
  }
  expect(new Set(seen)).toEqual(new Set(markers));
}

async function expectTwoPixelFocus(page: import("@playwright/test").Page): Promise<void> {
  const focus = await page.evaluate(() => {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) return undefined;
    const style = getComputedStyle(active);
    return {
      element: `${active.tagName.toLowerCase()}[${active.dataset.acceptanceTab ?? ""}]`,
      label: active.getAttribute("aria-label") ?? active.textContent?.trim().slice(0, 80),
      outlineWidth: style.outlineWidth,
      outlineStyle: style.outlineStyle,
      outlineOffset: style.outlineOffset,
      outlineColor: style.outlineColor,
    };
  });
  expect(focus, `Focused element: ${JSON.stringify(focus)}`).toMatchObject({
    outlineWidth: "2px",
    outlineStyle: "solid",
    outlineOffset: "2px",
  });
  expect(focus?.outlineColor).not.toBe("rgba(0, 0, 0, 0)");
}

function maxCssDurationSeconds(value: string): number {
  return Math.max(
    ...value.split(",").map((duration) => {
      const trimmed = duration.trim();
      return trimmed.endsWith("ms") ? Number.parseFloat(trimmed) / 1_000 : Number.parseFloat(trimmed);
    }),
  );
}

function formatAxeViolations(
  violations: readonly { readonly id: string; readonly nodes: readonly unknown[] }[],
): string {
  return violations.map(({ id, nodes }) => `${id} (${nodes.length})`).join(", ");
}
