import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test";

import { openDesktopDatabase } from "../../src/main/storage/database.js";
import { runMigrations } from "../../src/main/storage/migrations.js";
import { SettingsRepository, type WindowBounds } from "../../src/main/storage/settings-repository.js";
import type { VisualFixtureState } from "../visual/visual-fixtures.js";

export interface FixtureSize {
  readonly width: number;
  readonly height: number;
}

export interface ElectronWindowGeometry {
  readonly bounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly minimumSize: readonly [number, number];
  readonly buttonPosition: { readonly x: number; readonly y: number } | null;
}

export interface ElectronFixtureLaunchOptions {
  readonly preseedWindowBounds?: WindowBounds;
  readonly holdExclusiveMutation?: boolean;
  readonly userDataDirectory?: string;
}

export interface ElectronFixture {
  readonly application: ElectronApplication;
  readonly consoleErrors: readonly string[];
  readonly databasePath: string;
  readonly pageErrors: readonly string[];
  readonly userDataDirectory: string;
  readonly window: Page;
  close(): Promise<void>;
  geometry(): Promise<ElectronWindowGeometry>;
}

const desktopRoot = resolve(import.meta.dirname, "../..");
const fixtureMain = resolve(desktopRoot, "test-results/electron/fixture-main.cjs");

export async function launchElectronFixture(
  state: VisualFixtureState,
  size: FixtureSize,
  options: ElectronFixtureLaunchOptions = {},
): Promise<ElectronFixture> {
  validateSize(size);
  await access(fixtureMain);
  const temporaryRoot =
    options.userDataDirectory === undefined ? await mkdtemp(join(tmpdir(), "rbxforge-electron-fixture-")) : undefined;
  const userDataDirectory =
    options.userDataDirectory === undefined ? resolve(temporaryRoot!, "user-data") : resolve(options.userDataDirectory);
  let application: ElectronApplication | undefined;
  try {
    if (options.preseedWindowBounds !== undefined) {
      await mkdir(userDataDirectory, { recursive: true });
      const database = openDesktopDatabase(resolve(userDataDirectory, "rbxforge.sqlite"));
      try {
        runMigrations(database);
        new SettingsRepository(database).setWindowBounds(options.preseedWindowBounds);
      } finally {
        database.close();
      }
    }
    application = await electron.launch({
      args: [
        fixtureMain,
        `--rbxforge-visual-state=${state}`,
        ...(options.holdExclusiveMutation === true ? ["--rbxforge-hold-exclusive-mutation"] : []),
        `--user-data-dir=${userDataDirectory}`,
        "--force-device-scale-factor=1",
        "--force-color-profile=srgb",
        "--lang=en-US",
      ],
      cwd: desktopRoot,
      env: {
        ...process.env,
        LANG: "en_US.UTF-8",
        LC_ALL: "en_US.UTF-8",
        TZ: "UTC",
      },
    });
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    const instrumented = new WeakSet<Page>();
    const instrument = (page: Page): void => {
      if (instrumented.has(page)) return;
      instrumented.add(page);
      page.on("console", (message) => {
        if (message.type() === "error") consoleErrors.push(message.text());
      });
      page.on("pageerror", (error) => pageErrors.push(error.message));
    };
    application.on("window", instrument);
    const window = await application.firstWindow();
    instrument(window);
    await window.waitForLoadState("domcontentloaded");
    if (options.preseedWindowBounds === undefined) {
      await application.evaluate(({ BrowserWindow, screen }, dimensions) => {
        const windows = BrowserWindow.getAllWindows();
        if (windows.length !== 1 || windows[0] === undefined) {
          throw new Error(`Expected one Electron fixture window, received ${windows.length}.`);
        }
        const primaryWorkArea = screen.getPrimaryDisplay().workArea;
        windows[0].setBounds({ x: primaryWorkArea.x, y: primaryWorkArea.y, ...dimensions });
      }, size);
    }
    await window.waitForFunction(
      (dimensions) =>
        globalThis.innerWidth === dimensions.width &&
        globalThis.innerHeight === dimensions.height &&
        document.readyState === "complete",
      size,
    );

    let closed = false;
    return {
      application,
      consoleErrors,
      databasePath: resolve(userDataDirectory, "rbxforge.sqlite"),
      pageErrors,
      userDataDirectory,
      window,
      async close() {
        if (closed) return;
        closed = true;
        try {
          await application?.close();
        } finally {
          if (temporaryRoot !== undefined) await rm(temporaryRoot, { recursive: true, force: true });
        }
      },
      geometry: () =>
        application!.evaluate(({ BrowserWindow }) => {
          const windows = BrowserWindow.getAllWindows();
          if (windows.length !== 1 || windows[0] === undefined) {
            throw new Error(`Expected one Electron fixture window, received ${windows.length}.`);
          }
          return {
            bounds: windows[0].getBounds(),
            minimumSize: windows[0].getMinimumSize() as [number, number],
            buttonPosition: windows[0].getWindowButtonPosition(),
          };
        }),
    };
  } catch (error) {
    await application?.close().catch(() => undefined);
    if (temporaryRoot !== undefined) await rm(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}

function validateSize(size: FixtureSize): void {
  if (
    !Number.isSafeInteger(size.width) ||
    !Number.isSafeInteger(size.height) ||
    size.width < 960 ||
    size.height < 640
  ) {
    throw new Error("Electron fixture dimensions must satisfy the production minimum window size.");
  }
}
