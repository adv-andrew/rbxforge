import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { lstat, mkdir } from "node:fs/promises";
import { createServer as createTcpServer } from "node:net";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { buildDesktop, createBuildNonce, createDesktopBuildOptions } from "./build-desktop.mjs";
import { generatedRoot, repositoryRoot } from "./lib/repository.mjs";

const desktopRoot = resolve(repositoryRoot, "apps/desktop");
const desktopPackageJson = resolve(desktopRoot, "package.json");
const rendererInventoryPath = resolve(generatedRoot, "desktop/metadata/renderer-dev.json");

export async function coordinateDesktopDevelopment(options) {
  const pending = [
    Promise.resolve().then(options.buildMain),
    Promise.resolve().then(options.buildPreload),
    Promise.resolve().then(options.startRenderer),
  ];
  let main;
  let preload;
  let renderer;
  try {
    [main, preload, renderer] = await Promise.all(pending);
  } catch (error) {
    const settled = await Promise.allSettled(pending);
    await disposeAll(
      settled
        .filter((result) => result.status === "fulfilled")
        .map((result) => result.value)
        .reverse(),
    );
    throw error;
  }

  let electron;
  try {
    electron = await options.launchElectron({ port: renderer.port });
  } catch (error) {
    await disposeAll([renderer, preload, main]);
    throw error;
  }

  let disposed = false;
  return Object.freeze({
    port: renderer.port,
    electron,
    async dispose() {
      if (disposed) return;
      disposed = true;
      await disposeAll([electron, renderer, preload, main]);
    },
  });
}

export function resolveLoopbackPort(address) {
  if (address === null || typeof address === "string") {
    throw new Error("Vite did not expose a TCP listening address.");
  }
  if (address.address !== "127.0.0.1") {
    throw new Error(`Vite development server escaped loopback: ${address.address}`);
  }
  if (!Number.isSafeInteger(address.port) || address.port < 1_024 || address.port > 65_535) {
    throw new Error("Vite development server returned an invalid loopback port.");
  }
  return address.port;
}

export function createDevelopmentEnvironment({ nonce, port, inventoryPath }) {
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(nonce)) {
    throw new Error("Desktop development CSP nonce is invalid.");
  }
  if (!Number.isSafeInteger(port) || port < 1_024 || port > 65_535) {
    throw new Error("Desktop development port is invalid.");
  }
  if (!isAbsolute(inventoryPath)) {
    throw new Error("Desktop development renderer inventory path must be absolute.");
  }
  return Object.freeze({
    RBXFORGE_CSP_NONCE: nonce,
    RBXFORGE_DEV_SERVER_PORT: String(port),
    RBXFORGE_RENDERER_INVENTORY: inventoryPath,
  });
}

export async function allocateLoopbackPort() {
  const reservation = createTcpServer();
  reservation.unref();
  return await new Promise((resolvePort, rejectPort) => {
    const fail = (error) => rejectPort(new Error("Could not allocate a loopback Vite port.", { cause: error }));
    reservation.once("error", fail);
    reservation.listen(0, "127.0.0.1", () => {
      reservation.removeListener("error", fail);
      let port;
      try {
        port = resolveLoopbackPort(reservation.address());
      } catch (error) {
        reservation.close(() => rejectPort(error));
        return;
      }
      reservation.close((error) => {
        if (error === undefined) resolvePort(port);
        else fail(error);
      });
    });
  });
}

async function runDesktopDevelopment() {
  const desktopRequire = createRequire(desktopPackageJson);
  const { context } = desktopRequire("esbuild");
  const electronBinary = desktopRequire("electron");

  // A deterministic build establishes type safety, the audited vendor payload,
  // and notices before the long-running development surfaces begin watching.
  await buildDesktop();
  const nonce = createBuildNonce();
  const buildOptions = createDesktopBuildOptions(nonce);
  await mkdir(resolve(generatedRoot, "desktop/metadata"), { recursive: true });

  const previousEnvironment = Object.fromEntries(
    ["RBXFORGE_CSP_NONCE", "RBXFORGE_DEV_SERVER_PORT", "RBXFORGE_RENDERER_INVENTORY"].map((name) => [
      name,
      process.env[name],
    ]),
  );
  process.env.RBXFORGE_CSP_NONCE = nonce;
  process.env.RBXFORGE_RENDERER_INVENTORY = rendererInventoryPath;

  let session;
  try {
    session = await coordinateDesktopDevelopment({
      buildMain: () => startEsbuildWatch(context, buildOptions.main),
      buildPreload: () => startEsbuildWatch(context, buildOptions.preload),
      startRenderer: () => startViteRenderer(nonce),
      launchElectron: ({ port }) =>
        launchElectron({
          electronBinary,
          environment: createDevelopmentEnvironment({
            nonce,
            port,
            inventoryPath: rendererInventoryPath,
          }),
        }),
    });
    console.log(`RbxForge development renderer ready at http://127.0.0.1:${session.port}`);
    const result = await session.electron.completion;
    if (result.signal === null && result.code !== null && result.code !== 0) {
      process.exitCode = result.code;
    }
  } finally {
    await session?.dispose();
    restoreEnvironment(previousEnvironment);
  }
}

async function startEsbuildWatch(createContext, options) {
  const buildContext = await createContext(options);
  try {
    await buildContext.rebuild();
    await assertRegularFile(options.outfile);
    await buildContext.watch();
  } catch (error) {
    await buildContext.dispose();
    throw error;
  }
  return Object.freeze({
    async dispose() {
      await buildContext.dispose();
    },
  });
}

async function startViteRenderer(nonce) {
  const desktopRequire = createRequire(desktopPackageJson);
  const viteEntry = desktopRequire.resolve("vite");
  const { createServer } = await import(pathToFileURL(viteEntry).href);
  const assignedPort = await allocateLoopbackPort();
  const server = await createServer({
    configFile: resolve(desktopRoot, "vite.config.ts"),
    clearScreen: false,
    server: {
      host: "127.0.0.1",
      port: assignedPort,
      strictPort: true,
    },
  });
  try {
    await server.listen();
    const port = resolveLoopbackPort(server.httpServer?.address() ?? null);
    await assertRendererReady(port, nonce);
    return Object.freeze({
      port,
      async dispose() {
        await server.close();
      },
    });
  } catch (error) {
    await server.close();
    throw error;
  }
}

async function assertRendererReady(port, nonce) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  timeout.unref();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      signal: controller.signal,
    });
    const html = await response.text();
    if (!response.ok || !html.includes(`property="csp-nonce"`) || !html.includes(`nonce="${nonce}"`)) {
      throw new Error("Vite renderer did not return the shared CSP nonce.");
    }
  } finally {
    clearTimeout(timeout);
  }
}

function launchElectron({ electronBinary, environment }) {
  const child = spawn(electronBinary, [desktopRoot], {
    cwd: desktopRoot,
    env: {
      ...process.env,
      ...environment,
    },
    stdio: "inherit",
  });
  const completion = new Promise((resolveCompletion, rejectCompletion) => {
    child.once("error", rejectCompletion);
    child.once("exit", (code, signal) => resolveCompletion({ code, signal }));
  });
  return Object.freeze({
    completion,
    async dispose() {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        await completion;
      }
    },
  });
}

async function assertRegularFile(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`Desktop development output is not a regular file: ${path}`);
  }
}

async function disposeAll(resources) {
  const failures = [];
  for (const resource of resources) {
    try {
      await resource.dispose();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, "Desktop development cleanup failed.");
  }
}

function restoreEnvironment(previous) {
  for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

if (pathToFileURL(process.argv[1] ?? "").href === import.meta.url) {
  await runDesktopDevelopment();
}
