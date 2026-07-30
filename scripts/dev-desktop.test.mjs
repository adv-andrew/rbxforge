import assert from "node:assert/strict";
import test from "node:test";

import {
  allocateLoopbackPort,
  coordinateDesktopDevelopment,
  createDevelopmentEnvironment,
  resolveLoopbackPort,
} from "./dev-desktop.mjs";

test("development launch waits for main, preload, and renderer readiness", async () => {
  const events = [];
  const barriers = {
    main: deferred(),
    preload: deferred(),
    renderer: deferred(),
  };
  const launch = coordinateDesktopDevelopment({
    buildMain: async () => {
      events.push("main-start");
      await barriers.main.promise;
      events.push("main-ready");
      return disposable("main", events);
    },
    buildPreload: async () => {
      events.push("preload-start");
      await barriers.preload.promise;
      events.push("preload-ready");
      return disposable("preload", events);
    },
    startRenderer: async () => {
      events.push("renderer-start");
      await barriers.renderer.promise;
      events.push("renderer-ready");
      return { ...disposable("renderer", events), port: 54_321 };
    },
    launchElectron: async ({ port }) => {
      events.push(`electron-${port}`);
      return disposable("electron", events);
    },
  });

  await Promise.resolve();
  assert.deepEqual(events.sort(), ["main-start", "preload-start", "renderer-start"]);
  barriers.renderer.resolve();
  barriers.main.resolve();
  await Promise.resolve();
  assert.ok(!events.some((event) => event.startsWith("electron-")));
  barriers.preload.resolve();

  const session = await launch;
  assert.equal(events.at(-1), "electron-54321");
  await session.dispose();
  assert.deepEqual(events.slice(-4), ["dispose-electron", "dispose-renderer", "dispose-preload", "dispose-main"]);
});

test("development environment shares one nonce and an OS-assigned loopback port", () => {
  assert.equal(resolveLoopbackPort({ address: "127.0.0.1", family: "IPv4", port: 54_321 }), 54_321);
  assert.throws(() => resolveLoopbackPort({ address: "0.0.0.0", family: "IPv4", port: 54_321 }), /loopback/i);
  assert.throws(() => resolveLoopbackPort(null), /listening address/i);

  const environment = createDevelopmentEnvironment({
    nonce: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN",
    port: 54_321,
    inventoryPath: "/tmp/rbxforge-renderer-inventory.json",
  });
  assert.deepEqual(environment, {
    RBXFORGE_CSP_NONCE: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN",
    RBXFORGE_DEV_SERVER_PORT: "54321",
    RBXFORGE_RENDERER_INVENTORY: "/tmp/rbxforge-renderer-inventory.json",
  });
});

test("the development server port comes from an operating-system allocation", async () => {
  const port = await allocateLoopbackPort();
  assert.ok(Number.isSafeInteger(port));
  assert.ok(port >= 1_024 && port <= 65_535);
});

function deferred() {
  let resolve;
  const promise = new Promise((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function disposable(name, events) {
  return {
    async dispose() {
      events.push(`dispose-${name}`);
    },
  };
}
