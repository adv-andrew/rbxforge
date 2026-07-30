import { createServer } from "node:net";
import { createRequire } from "node:module";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { ensureOwnedProcessGone } from "./lib/owned-process.mjs";
import { repositoryRoot } from "./lib/repository.mjs";

const requestedRoot = process.argv[2];
if (requestedRoot === undefined) {
  throw new Error("Usage: node scripts/smoke-packaged-extension.mjs <staged-extension-root>");
}
const extensionRoot = resolve(repositoryRoot, requestedRoot);
const manifest = JSON.parse(await readFile(resolve(extensionRoot, "package.json"), "utf8"));
const entryPath = resolve(extensionRoot, manifest.main);
const entrySource = await readFile(entryPath, "utf8");
if (/(?:from\s*|import\s*\()\s*["'][^"']*(?:@rbxforge\/|\.tsx?["'])/g.test(entrySource)) {
  throw new Error("Standalone extension bundle retains a workspace or TypeScript runtime import");
}
const bundled = await import(`${pathToFileURL(entryPath).href}?package-smoke=${Date.now()}`);
if (typeof bundled.activateWithFacade !== "function" || typeof bundled.createFixtureServices !== "function") {
  throw new Error("Built extension entry is missing deliberate fixture-smoke exports");
}

const facade = createSmokeFacade(extensionRoot);
const context = { subscriptions: [], extensionPath: extensionRoot };
const fixtureServices = bundled.createFixtureServices();
const screenshotController = {
  state: () => ({
    instanceId: "fixture-instance",
    status: "idle",
    roles: [],
    runtimeGeneration: 0,
    observedAt: 1,
  }),
  onDidChange: () => ({ dispose: () => undefined }),
  disconnect: () => undefined,
  captureScreenshot: async () => ({
    data: "AQID",
    mimeType: "image/jpeg",
    format: "jpeg",
    target: "edit",
    capturedAt: 1,
    width: 2,
    height: 3,
    quality: 90,
  }),
};
const services = {
  ...fixtureServices,
  playtest: {
    availability: () => ({ lifecycle: true, logs: true, screenshot: true }),
    controller: () => screenshotController,
  },
};
const activation = await bundled.activateWithFacade(facade, context, services);
const manifestCommands = new Set(manifest.contributes.commands.map(({ command }) => command));
assertEqualSets(manifestCommands, new Set(facade.commands.keys()), "manifest/runtime command IDs");
const manifestViews = new Set(manifest.contributes.views.rbxforge.map(({ id }) => id));
assertEqualSets(
  manifestViews,
  new Set([...facade.treeProviders.keys(), ...facade.webviewProviders.keys()]),
  "manifest/runtime view IDs",
);
if (facade.createdTreeViews !== 1 || facade.createdPanels !== 0) {
  throw new Error("Fixture activation unexpectedly opened a provider or panel");
}
for (const [viewId, registration] of facade.webviewProviders) {
  const webview = createWebview(extensionRoot);
  await registration.resolveWebviewView({ webview });
  await assertPackagedWebview(webview, extensionRoot, viewId, false);
}
services.connection.update("activeStudioInstance", {
  health: "healthy",
  detail: "Fixture Studio selected for explicit Viewport smoke",
});
facade.allowPanelCreation();
const captureScreenshot = facade.commands.get("rbxforge.captureScreenshot");
if (captureScreenshot === undefined) throw new Error("Built entry did not register the Viewport capture command");
await captureScreenshot();
if (facade.createdPanels !== 1 || facade.panels.length !== 1) {
  throw new Error("Explicit Viewport smoke did not open exactly one packaged panel");
}
await assertPackagedWebview(facade.panels[0].webview, extensionRoot, "Viewport", true);
const commandCount = facade.commands.size;
const webviewProviderCount = facade.webviewProviders.size;
for (const subscription of context.subscriptions) subscription.dispose();
await activation.shutdown();

await smokeStudioMcp(extensionRoot);
console.log(
  `Packaged smoke passed: ${commandCount} commands, ${manifestViews.size} views, ` +
    `${webviewProviderCount} webview providers, explicit blob-enabled Viewport, ` +
    `fixture activation process-free, Studio MCP initialize/listTools/PID cleanup clean.`,
);

function createSmokeFacade(root) {
  const commands = new Map();
  const treeProviders = new Map();
  const webviewProviders = new Map();
  const dispose = () => undefined;
  const panels = [];
  let createdTreeViews = 0;
  let createdPanels = 0;
  let panelCreationAllowed = false;
  return {
    commands,
    treeProviders,
    webviewProviders,
    panels,
    get createdTreeViews() {
      return createdTreeViews;
    },
    get createdPanels() {
      return createdPanels;
    },
    allowPanelCreation() {
      panelCreationAllowed = true;
    },
    registerCommand(id, handler) {
      commands.set(id, handler);
      return { dispose: () => commands.delete(id) };
    },
    registerTreeDataProvider(id, provider) {
      treeProviders.set(id, provider);
      return { dispose: () => treeProviders.delete(id) };
    },
    registerWebviewViewProvider(id, provider) {
      webviewProviders.set(id, provider);
      return { dispose: () => webviewProviders.delete(id) };
    },
    createWebviewPanel() {
      if (!panelCreationAllowed) {
        throw new Error("Package smoke activation must not open a webview panel");
      }
      createdPanels += 1;
      const panel = createPanel(root);
      panels.push(panel);
      return panel;
    },
    createTreeView() {
      createdTreeViews += 1;
      return {
        visible: false,
        onDidChangeVisibility: () => ({ dispose }),
        onDidExpandElement: () => ({ dispose }),
        onDidCollapseElement: () => ({ dispose }),
        dispose,
      };
    },
    createStatusBarItem() {
      return { text: "", show: dispose, hide: dispose, dispose };
    },
    createOutputChannel() {
      return { appendLine: dispose, show: dispose, dispose };
    },
    showInformationMessage: async () => undefined,
    showWarningMessage: async () => undefined,
    showQuickPick: async () => undefined,
    showOpenDialog: async () => undefined,
    showInputBox: async () => undefined,
    executeCommand: async () => undefined,
    writeClipboard: async () => undefined,
    openTextDocument: async () => undefined,
    secretGet: async () => undefined,
    secretStore: async () => {
      throw new Error("Package smoke must not store secrets");
    },
    secretDelete: async () => undefined,
    inspectConfiguration: (key) => {
      if (key === "rbxforge.ai.endpoint") return { defaultValue: "https://api.openai.com/v1" };
      if (key === "rbxforge.ai.model") return { defaultValue: "gpt-5.6" };
      return undefined;
    },
    workspaceFolders: () => [root],
    activeSelection: () => undefined,
    diagnostics: () => [],
    documentSnapshot: async () => undefined,
    isPathIgnored: async () => false,
    subscribeIgnorePolicyInvalidation: () => ({ dispose }),
    registerVirtualTextDocumentProvider: () => ({ dispose }),
    openDiff: async () => undefined,
    applyWorkspaceEdit: () => {
      throw new Error("Package smoke must not apply a workspace edit");
    },
    dispose,
  };
}

function createPanel(root) {
  const disposeListeners = new Set();
  let disposed = false;
  return {
    webview: createWebview(root),
    onDidDispose: (listener) => {
      disposeListeners.add(listener);
      return { dispose: () => disposeListeners.delete(listener) };
    },
    reveal: () => undefined,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const listener of disposeListeners) listener();
      disposeListeners.clear();
    },
  };
}

function createWebview(root) {
  const listeners = new Set();
  let options = { enableScripts: false, localResourceRoots: [] };
  return {
    html: "",
    cspSource: "vscode-webview://package-smoke",
    get options() {
      return options;
    },
    set options(value) {
      options = {
        enableScripts: value.enableScripts,
        localResourceRoots: value.localResourceRoots.map((path) => `${root}/${path}`),
      };
    },
    asWebviewUri: (relativePath) => `webview-resource:${root}/${relativePath}`,
    postMessage: async () => true,
    onDidReceiveMessage: (listener) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
  };
}

async function assertPackagedWebview(webview, root, label, allowBlobImages) {
  if (
    !webview.html.includes("default-src 'none'") ||
    !webview.html.includes("connect-src 'none'") ||
    !/script-src 'nonce-[A-Za-z0-9_-]+'/.test(webview.html)
  ) {
    throw new Error(`Invalid packaged webview CSP for ${label}`);
  }
  const blobDirective = `img-src ${webview.cspSource} data: blob:`;
  if (allowBlobImages !== webview.html.includes(blobDirective)) {
    throw new Error(`Packaged ${label} has an invalid blob-image CSP boundary`);
  }
  if (
    webview.options.enableScripts !== true ||
    JSON.stringify(webview.options.localResourceRoots) !== JSON.stringify([`${root}/media/webview`])
  ) {
    throw new Error(`Packaged ${label} has invalid installed-layout webview options`);
  }
  for (const relativePath of ["media/webview/webview.js", "media/webview/webview.css"]) {
    await access(resolve(root, relativePath));
    if (!webview.html.includes(`webview-resource:${root}/${relativePath}`)) {
      throw new Error(`Packaged ${label} does not use the installed ${relativePath}`);
    }
  }
}

async function smokeStudioMcp(root) {
  const entry = resolve(root, "vendor/robloxstudio-mcp/index.mjs");
  await access(entry);
  const require = createRequire(resolve(repositoryRoot, "apps/extension/package.json"));
  const clientModule = await import(pathToFileURL(require.resolve("@modelcontextprotocol/sdk/client/index.js")).href);
  const transportModule = await import(
    pathToFileURL(require.resolve("@modelcontextprotocol/sdk/client/stdio.js")).href
  );
  const basePort = await reserveThenReleasePort();
  const legacy = await occupyLegacyPort();
  const transport = new transportModule.StdioClientTransport({
    command: process.execPath,
    args: [entry],
    env: {
      ROBLOX_STUDIO_AUTH_TOKEN: `rbxforge-smoke-token-${process.pid}`,
      ROBLOX_STUDIO_HOST: "127.0.0.1",
      ROBLOX_STUDIO_PORT: String(basePort),
      ROBLOX_STUDIO_PROXY_PROMOTION_INTERVAL_MS: "60000",
    },
    stderr: "pipe",
  });
  const client = new clientModule.Client({ name: "rbxforge-package-smoke", version: "0.1.0" });
  let ownedPid;
  try {
    await withTimeout(client.connect(transport), 10_000, "MCP initialize");
    ownedPid = transport.pid;
    if (!Number.isInteger(ownedPid) || ownedPid <= 0) {
      throw new Error("Pinned MCP transport did not expose its spawned child PID");
    }
    const listed = await withTimeout(client.listTools(), 10_000, "MCP listTools");
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
      if (!names.has(required)) throw new Error(`Vendored Studio MCP is missing canonical tool ${required}`);
    }
  } finally {
    await withTimeout(client.close(), 6_000, "MCP close").catch(async () => {
      await withTimeout(transport.close(), 6_000, "MCP transport close").catch(() => undefined);
    });
    try {
      if (ownedPid !== undefined) await ensureOwnedProcessGone(ownedPid);
    } finally {
      await closeServer(legacy);
    }
  }
}

async function reserveThenReleasePort() {
  const server = createServer();
  await listen(server, 0);
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await closeServer(server);
  if (port === 0 || port === 3002) throw new Error("Could not reserve a disposable Studio MCP port");
  return port;
}

async function occupyLegacyPort() {
  const server = createServer();
  try {
    await listen(server, 3002);
    return server;
  } catch (error) {
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

async function closeServer(server) {
  if (server === undefined || !server.listening) return;
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error !== undefined) rejectClose(error);
      else resolveClose();
    });
  });
}

async function withTimeout(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function assertEqualSets(left, right, label) {
  const leftValues = [...left].sort();
  const rightValues = [...right].sort();
  if (JSON.stringify(leftValues) !== JSON.stringify(rightValues)) {
    throw new Error(`${label} differ: manifest=[${leftValues.join(", ")}] runtime=[${rightValues.join(", ")}]`);
  }
}
