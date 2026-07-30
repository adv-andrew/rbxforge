import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { promisify } from "node:util";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { ensureOwnedProcessGone } from "./lib/owned-process.mjs";
import { artifactsRoot, repositoryRoot } from "./lib/repository.mjs";

const execFileAsync = promisify(execFile);
const desktopRoot = resolve(repositoryRoot, "apps/desktop");
const desktopRequire = createRequire(resolve(desktopRoot, "package.json"));
const defaultAppPath = resolve(artifactsRoot, "desktop/mac-arm64/RbxForge.app");
const requestedAppPath = resolve(process.argv[2] ?? defaultAppPath);
export const PACKAGED_DESKTOP_SCREENSHOT_PATH = resolve(artifactsRoot, "rbxforge-packaged-1280x800.png");

export async function smokePackagedDesktop(appPath = requestedAppPath) {
  const executable = resolve(appPath, "Contents/MacOS/RbxForge");
  const resources = resolve(appPath, "Contents/Resources");
  const userData = await mkdtemp(resolve(tmpdir(), "rbxforge-packaged-user-data-"));
  const rendererErrors = [];
  let electronApp;
  let screenshot;
  try {
    const { _electron } = desktopRequire("@playwright/test");
    const loader = resolvePlaywrightElectronLoader();
    electronApp = await _electron.launch({
      executablePath: executable,
      args: createPackagedElectronLaunchArguments({ loader, userData }),
      env: cleanLaunchEnvironment(),
      timeout: 30_000,
    });
    const attachErrors = (page) => {
      page.on("console", (message) => {
        if (message.type() === "error") rendererErrors.push(`console: ${message.text()}`);
      });
      page.on("pageerror", (error) => rendererErrors.push(`pageerror: ${error.message}`));
    };
    electronApp.on("window", attachErrors);
    const page = await electronApp.firstWindow({ timeout: 30_000 });
    attachErrors(page);
    await page.waitForLoadState("domcontentloaded");
    await page
      .getByRole("heading", { name: "Build locally with RbxForge" })
      .waitFor({ state: "visible", timeout: 30_000 });
    await page.getByRole("button", { name: "Add project" }).first().waitFor({ state: "visible" });
    const renderer = await page.evaluate(() => {
      const rendererDocument = globalThis.document;
      const bridge = globalThis.rbxforge;
      const nonceMeta = rendererDocument.querySelector("meta[property=csp-nonce]");
      const nonceStyle = rendererDocument.querySelector("style[nonce]");
      return {
        title: rendererDocument.title,
        platform: bridge?.platform,
        api: typeof bridge?.request === "function" && typeof bridge?.subscribe === "function",
        // Browsers intentionally hide nonce values from getAttribute(); the
        // nonce IDL property retains the effective CSP value.
        nonce: nonceMeta?.nonce,
        styleNonce: nonceStyle?.nonce,
        onboarding: rendererDocument.body.textContent?.includes("Build locally with RbxForge") === true,
      };
    });
    if (
      renderer.title !== "RbxForge" ||
      renderer.platform !== "darwin" ||
      renderer.api !== true ||
      renderer.onboarding !== true ||
      typeof renderer.nonce !== "string" ||
      renderer.nonce.length < 32 ||
      renderer.styleNonce !== renderer.nonce
    ) {
      throw new Error(`Packaged renderer/preload/bootstrap smoke failed: ${JSON.stringify(renderer)}`);
    }
    const main = await electronApp.evaluate(({ BrowserWindow }) => {
      const windows = BrowserWindow.getAllWindows();
      if (windows.length !== 1) return { windowCount: windows.length };
      const window = windows[0];
      return {
        windowCount: windows.length,
        title: window.getTitle(),
        size: window.getSize(),
        preferences: window.webContents.getLastWebPreferences(),
        url: window.webContents.getURL(),
      };
    });
    if (
      main.windowCount !== 1 ||
      main.title !== "RbxForge" ||
      JSON.stringify(main.size) !== JSON.stringify([1280, 800]) ||
      main.preferences?.nodeIntegration !== false ||
      main.preferences?.contextIsolation !== true ||
      main.preferences?.sandbox !== true ||
      main.preferences?.webSecurity !== true ||
      main.preferences?.webviewTag !== false ||
      !main.url?.startsWith("file:")
    ) {
      throw new Error(`Packaged BrowserWindow security smoke failed: ${JSON.stringify(main)}`);
    }
    await page.waitForTimeout(250);
    if (rendererErrors.length > 0) {
      throw new Error(`Packaged renderer emitted errors: ${rendererErrors.join(" | ")}`);
    }
    screenshot = await capturePackagedOnboardingScreenshot(page);
    const databasePath = resolve(userData, "rbxforge.sqlite");
    await access(databasePath);
    const sqlite = await smokeRunAsNodeSqlite(executable, resources, databasePath);
    if (sqlite.migration !== 1) throw new Error(`Packaged database migration smoke failed: ${JSON.stringify(sqlite)}`);
  } finally {
    if (electronApp !== undefined) await electronApp.close().catch(() => undefined);
    await rm(userData, { recursive: true, force: true });
  }
  const mcp = await smokePackagedMcp(executable, resources, desktopRequire);
  const report = {
    appPath,
    window: {
      title: "RbxForge",
      size: [1280, 800],
      onboarding: true,
      rendererErrors: 0,
      screenshot,
    },
    runtime: { electron: "43.2.0", node: "24.18.0", arch: "arm64", sqliteMigration: 1 },
    mcp,
  };
  console.log(JSON.stringify(report, undefined, 2));
  return report;
}

export async function capturePackagedOnboardingScreenshot(page, screenshotPath = PACKAGED_DESKTOP_SCREENSHOT_PATH) {
  await mkdir(dirname(screenshotPath), { recursive: true });
  const image = await page.screenshot({
    animations: "disabled",
    caret: "hide",
    path: screenshotPath,
    scale: "css",
  });
  const pngSignature = image.subarray(0, 8).toString("hex");
  const width = image.length >= 24 ? image.readUInt32BE(16) : 0;
  const height = image.length >= 24 ? image.readUInt32BE(20) : 0;
  if (pngSignature !== "89504e470d0a1a0a" || width !== 1_280 || height !== 800) {
    throw new Error(`Packaged screenshot is not the exact 1280x800 PNG: ${width}x${height}`);
  }
  return Object.freeze({ path: screenshotPath, bytes: image.length, width, height });
}

export function resolvePlaywrightElectronLoader() {
  const playwrightTestPackage = desktopRequire.resolve("@playwright/test/package.json");
  const playwrightRequire = createRequire(playwrightTestPackage);
  const playwrightCoreRoot = dirname(playwrightRequire.resolve("playwright-core/package.json"));
  return resolve(playwrightCoreRoot, "lib/server/electron/loader.js");
}

export function createPackagedElectronLaunchArguments({ loader, userData }) {
  if (!isAbsolute(loader) || !isAbsolute(userData)) {
    throw new Error("Packaged Electron smoke loader and user-data paths must be absolute.");
  }
  return Object.freeze(["-r", loader, `--user-data-dir=${userData}`]);
}

async function smokeRunAsNodeSqlite(executable, resources, databasePath) {
  const loader = resolve(resources, "app.asar/node_modules/better-sqlite3/lib/index.js");
  const source = [
    "const Database = require(process.argv[1]);",
    "const database = new Database(process.argv[2]);",
    "const migration = database.prepare('SELECT MAX(id) AS id FROM migrations').get().id;",
    "database.exec('CREATE TABLE IF NOT EXISTS package_smoke(value TEXT NOT NULL)');",
    "database.prepare('INSERT INTO package_smoke(value) VALUES (?)').run('ok');",
    "const value = database.prepare('SELECT value FROM package_smoke ORDER BY rowid DESC LIMIT 1').get().value;",
    "database.close();",
    "process.stdout.write(JSON.stringify({electron:process.versions.electron,node:process.versions.node,arch:process.arch,migration,value}));",
  ].join("");
  const { stdout, stderr } = await execFileAsync(executable, ["-e", source, loader, databasePath], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    env: {
      ...cleanLaunchEnvironment(),
      ELECTRON_RUN_AS_NODE: "1",
      NODE_OPTIONS: "--require=/rbxforge-node-options-must-be-disabled",
    },
  });
  if (stderr.trim() !== "") throw new Error(`Packaged RunAsNode/SQLite smoke wrote stderr: ${stderr}`);
  const result = JSON.parse(stdout);
  if (result.electron !== "43.2.0" || result.node !== "24.18.0" || result.arch !== "arm64" || result.value !== "ok") {
    throw new Error(`Packaged RunAsNode/SQLite identity failed: ${stdout}`);
  }
  return result;
}

async function smokePackagedMcp(executable, resources, desktopRequire) {
  const entry = resolve(resources, "vendor/robloxstudio-mcp/index.mjs");
  await access(entry);
  const clientModule = await import(
    pathToFileURL(desktopRequire.resolve("@modelcontextprotocol/sdk/client/index.js")).href
  );
  const transportModule = await import(
    pathToFileURL(desktopRequire.resolve("@modelcontextprotocol/sdk/client/stdio.js")).href
  );
  const primaryPort = await reserveThenReleasePort();
  const legacy = await occupyLegacyPort();
  const token = randomBytes(32).toString("hex");
  const transport = new transportModule.StdioClientTransport({
    command: executable,
    args: [entry],
    env: {
      ...cleanLaunchEnvironment(),
      ELECTRON_RUN_AS_NODE: "1",
      ROBLOX_STUDIO_AUTH_TOKEN: token,
      ROBLOX_STUDIO_HOST: "127.0.0.1",
      ROBLOX_STUDIO_PORT: String(primaryPort),
      ROBLOX_STUDIO_PROXY_PROMOTION_INTERVAL_MS: "60000",
    },
    stderr: "pipe",
  });
  const client = new clientModule.Client({ name: "rbxforge-desktop-package-smoke", version: "0.1.0" });
  let ownedPid;
  try {
    await withTimeout(client.connect(transport), 10_000, "packaged MCP initialize");
    ownedPid = transport.pid;
    if (!Number.isInteger(ownedPid) || ownedPid <= 0) {
      throw new Error("Packaged MCP transport did not expose its child PID.");
    }
    const listed = await withTimeout(client.listTools(), 10_000, "packaged MCP listTools");
    const names = new Set(listed.tools.map(({ name }) => name));
    for (const required of [
      "get_connected_instances",
      "get_file_tree",
      "get_instance_children",
      "get_instance_properties",
      "set_property",
      "set_properties",
      "create_object",
      "delete_object",
      "solo_playtest",
      "get_runtime_logs",
      "capture_screenshot",
    ]) {
      if (!names.has(required)) throw new Error(`Packaged Studio MCP is missing canonical tool ${required}`);
    }
    return Object.freeze({ initialized: true, toolCount: names.size });
  } finally {
    await withTimeout(client.close(), 6_000, "packaged MCP close").catch(async () => {
      await withTimeout(transport.close(), 6_000, "packaged MCP transport close").catch(() => undefined);
    });
    try {
      if (ownedPid !== undefined) await ensureOwnedProcessGone(ownedPid);
    } finally {
      if (legacy !== undefined) await closeServer(legacy);
    }
  }
}

function cleanLaunchEnvironment() {
  const environment = { ...process.env };
  for (const key of [
    "ELECTRON_RUN_AS_NODE",
    "NODE_OPTIONS",
    "RBXFORGE_DEV_SERVER_PORT",
    "RBXFORGE_CSP_NONCE",
    "RBXFORGE_RENDERER_INVENTORY",
  ]) {
    delete environment[key];
  }
  return environment;
}

async function reserveThenReleasePort() {
  const server = createServer();
  await listen(server, 0);
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Could not reserve MCP smoke port.");
  await closeServer(server);
  return address.port;
}

async function occupyLegacyPort() {
  const server = createServer();
  try {
    await listen(server, 3_002);
    return server;
  } catch (error) {
    await closeServer(server).catch(() => undefined);
    if (error instanceof Error && "code" in error && error.code === "EADDRINUSE") return undefined;
    throw error;
  }
}

function listen(server, port) {
  return new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", rejectListen);
      resolveListen();
    });
  });
}

function closeServer(server) {
  return new Promise((resolveClose, rejectClose) => {
    if (!server.listening) {
      resolveClose();
      return;
    }
    server.close((error) => (error === undefined ? resolveClose() : rejectClose(error)));
  });
}

async function withTimeout(promise, milliseconds, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

if (pathToFileURL(process.argv[1] ?? "").href === import.meta.url) {
  await smokePackagedDesktop();
}
