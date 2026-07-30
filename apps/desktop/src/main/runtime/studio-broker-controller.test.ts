import { createServer } from "node:net";
import { describe, expect, it, vi } from "vitest";
import type { StudioMcpService } from "@rbxforge/studio-mcp";
import {
  StudioBrokerController,
  preflightLoopbackPort,
  type StudioBrokerLaunch,
  type StudioBrokerSession,
} from "./studio-broker-controller.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class FakeSession implements StudioBrokerSession {
  readonly stderrListeners = new Set<(line: string) => void>();
  readonly exitListeners = new Set<
    (result: { readonly exitCode: number | null; readonly signal: string | null }) => void
  >();
  closeCalls = 0;
  closeGate: Promise<void> = Promise.resolve();
  closeError: Error | undefined;
  readonly client = {
    listTools: async () => ({ tools: [] }),
    callTool: async () => ({}),
    close: async () => undefined,
  };

  onStderr(listener: (line: string) => void): () => void {
    this.stderrListeners.add(listener);
    return () => this.stderrListeners.delete(listener);
  }

  onExit(listener: (result: { readonly exitCode: number | null; readonly signal: string | null }) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    await this.closeGate;
    if (this.closeError !== undefined) throw this.closeError;
  }

  stderr(line: string): void {
    for (const listener of this.stderrListeners) listener(line.replace(/\\n$/, ""));
  }

  exit(exitCode: number | null = 1, signal: string | null = null): void {
    for (const listener of this.exitListeners) listener({ exitCode, signal });
  }
}

class FakeService {
  discoverCalls = 0;
  clearCalls = 0;
  discoverGate: Promise<ReadonlySet<string>> = Promise.resolve(new Set(["get_connected_instances"]));

  async discover(): Promise<ReadonlySet<string>> {
    this.discoverCalls += 1;
    return this.discoverGate;
  }

  clearSelectedInstance(): void {
    this.clearCalls += 1;
  }
}

function sequence<T>(...values: readonly T[]): () => T {
  let index = 0;
  return () => {
    const value = values[index];
    if (value === undefined) throw new Error("sequence exhausted");
    index += 1;
    return value;
  };
}

function harness(
  sessions: readonly FakeSession[],
  overrides: Partial<ConstructorParameters<typeof StudioBrokerController>[0]> = {},
) {
  const launches: StudioBrokerLaunch[] = [];
  const services: FakeService[] = [];
  let sessionIndex = 0;
  const invalidations: string[] = [];
  const controller = new StudioBrokerController({
    primaryPort: 58741,
    vendoredEntryPath: "/Applications/RbxForge/mcp/index.js",
    environment: {
      PATH: "/usr/bin",
      LANG: "en_US.UTF-8",
      HOME: "/Users/test",
      ROBLOX_STUDIO_AUTH_TOKEN: "inherited-token",
      ROBLOX_STUDIO_NO_AUTH: "1",
      HTTPS_PROXY: "https://proxy.invalid",
      AWS_SECRET_ACCESS_KEY: "inherited-secret",
    },
    preflightPort: async () => true,
    createSession: async (launch) => {
      launches.push(launch);
      const session = sessions[sessionIndex];
      if (session === undefined) throw new Error("session factory exhausted");
      sessionIndex += 1;
      return session;
    },
    createService: (client, gate) => {
      void client;
      void gate;
      const service = new FakeService();
      services.push(service);
      return service as unknown as StudioMcpService;
    },
    createToken: sequence("a".repeat(64), "b".repeat(64), "c".repeat(64)),
    createEpoch: sequence("broker-epoch-1", "broker-epoch-2", "broker-epoch-3"),
    now: sequence(100, 200, 300),
    readinessTimeoutMs: 50,
    legacyTimeoutMs: 5,
    onInvalidated: (reason) => invalidations.push(reason),
    ...overrides,
  });
  return { controller, launches, services, invalidations };
}

async function readyPrimary(session: FakeSession, started: Promise<unknown>, legacy?: "ready" | "occupied") {
  session.stderr("HTTP server listening on 127.0.0.1:58741 for Studio plugin (primary mode)\\n");
  if (legacy === "ready") {
    session.stderr("Legacy HTTP server also listening on 127.0.0.1:3002 for old plugins\\n");
  } else if (legacy === "occupied") {
    session.stderr("Legacy port 3002 in use, skipping backward-compat listener\\n");
  }
  return started;
}

describe("StudioBrokerController startup", () => {
  it("accepts only exact primary readiness and records an optional legacy listener", async () => {
    const session = new FakeSession();
    const { controller, launches, services } = harness([session]);
    const started = controller.retain();
    await vi.waitFor(() => expect(session.stderrListeners.size).toBe(1));
    const lease = await readyPrimary(session, started, "ready");

    expect(launches[0]?.env).toEqual({
      PATH: "/usr/bin",
      LANG: "en_US.UTF-8",
      ELECTRON_RUN_AS_NODE: "1",
      ROBLOX_STUDIO_HOST: "127.0.0.1",
      ROBLOX_STUDIO_PORT: "58741",
      ROBLOX_STUDIO_AUTH_TOKEN: "a".repeat(64),
    });
    expect(services[0]?.discoverCalls).toBe(1);
    expect(lease.ready).toEqual({
      brokerEpoch: "broker-epoch-1",
      primaryPort: 58741,
      legacyPort: 3002,
      legacyStatus: "listening",
      startedAt: 100,
    });
    expect(controller.snapshot()).toMatchObject({ state: "ready", referenceCount: 1, ready: lease.ready });
    expect(controller.service()).toBe(services[0]);
  });

  it.each([
    ["proxy", "Port 58741 in use - entering proxy mode (forwarding to localhost:58741)", "mcp-primary-port-race"],
    ["wrong port", "HTTP server listening on 127.0.0.1:58742 for Studio plugin (primary mode)", "mcp-primary-mismatch"],
    ["wrong host", "HTTP server listening on localhost:58741 for Studio plugin (primary mode)", "mcp-primary-mismatch"],
  ])("rejects %s startup output and closes only its owned session", async (_name, line, code) => {
    const session = new FakeSession();
    const { controller } = harness([session]);
    const started = controller.retain();
    await vi.waitFor(() => expect(session.stderrListeners.size).toBe(1));
    session.stderr(`${line}\\n`);

    await expect(started).rejects.toMatchObject({ code });
    expect(session.closeCalls).toBe(1);
    expect(controller.snapshot()).toMatchObject({ state: "error", referenceCount: 0 });
  });

  it("rejects a preflight collision without creating a session", async () => {
    let creates = 0;
    const { controller } = harness([], {
      preflightPort: async () => false,
      createSession: async () => {
        creates += 1;
        throw new Error("must not create");
      },
    });

    await expect(controller.retain()).rejects.toMatchObject({ code: "mcp-primary-port-occupied" });
    expect(creates).toBe(0);
  });

  it("the production preflight probes loopback exclusively without disturbing an occupied listener", async () => {
    const occupied = createServer();
    await new Promise<void>((resolve, reject) => {
      occupied.once("error", reject);
      occupied.listen({ host: "127.0.0.1", port: 0, exclusive: true }, resolve);
    });
    const address = occupied.address();
    if (address === null || typeof address === "string") throw new Error("missing test listener address");

    try {
      await expect(preflightLoopbackPort(address.port)).resolves.toBe(false);
      expect(occupied.listening).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => {
        occupied.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    }
    await expect(preflightLoopbackPort(address.port)).resolves.toBe(true);
  });

  it("requires an absolute vendored entry before preflight or spawn", async () => {
    let preflights = 0;
    let creates = 0;
    const { controller } = harness([], {
      vendoredEntryPath: "relative/index.js",
      preflightPort: async () => {
        preflights += 1;
        return true;
      },
      createSession: async () => {
        creates += 1;
        throw new Error("must not create");
      },
    });

    await expect(controller.retain()).rejects.toMatchObject({ code: "mcp-entry-not-absolute" });
    expect({ preflights, creates }).toEqual({ preflights: 0, creates: 0 });
  });

  it("times out without exact primary readiness and closes the exact startup session", async () => {
    const session = new FakeSession();
    const { controller } = harness([session]);
    const started = controller.retain();
    await vi.waitFor(() => expect(session.stderrListeners.size).toBe(1));

    await expect(started).rejects.toMatchObject({ code: "mcp-readiness-timeout" });
    expect(session.closeCalls).toBe(1);
  });

  it("treats absent legacy output as unknown without failing primary readiness", async () => {
    const session = new FakeSession();
    const { controller } = harness([session]);
    const started = controller.retain();
    await vi.waitFor(() => expect(session.stderrListeners.size).toBe(1));
    const lease = await readyPrimary(session, started);
    expect(lease.ready).toMatchObject({ legacyStatus: "unknown" });
    expect(lease.ready.legacyPort).toBeUndefined();
  });

  it("records occupied legacy status", async () => {
    const session = new FakeSession();
    const { controller } = harness([session]);
    const started = controller.retain();
    await vi.waitFor(() => expect(session.stderrListeners.size).toBe(1));
    const lease = await readyPrimary(session, started, "occupied");
    expect(lease.ready).toMatchObject({ legacyStatus: "occupied" });
    expect(lease.ready.legacyPort).toBeUndefined();
  });

  it("does not become ready until SDK session creation and Studio discovery both settle", async () => {
    const session = new FakeSession();
    const created = deferred<StudioBrokerSession>();
    const discovery = deferred<ReadonlySet<string>>();
    const service = new FakeService();
    service.discoverGate = discovery.promise;
    const { controller } = harness([], {
      createSession: async () => created.promise,
      createService: () => service as unknown as StudioMcpService,
    });
    const started = controller.retain();
    expect(controller.snapshot().state).toBe("starting");
    created.resolve(session);
    await vi.waitFor(() => expect(session.stderrListeners.size).toBe(1));
    session.stderr("HTTP server listening on 127.0.0.1:58741 for Studio plugin (primary mode)\\n");
    await new Promise((resolve) => setTimeout(resolve, 7));
    expect(controller.snapshot().state).toBe("starting");
    discovery.resolve(new Set());
    await expect(started).resolves.toHaveProperty("ready.brokerEpoch", "broker-epoch-1");
  });

  it("supplies an always-deny mutation gate whose consume path cannot authorize writes", async () => {
    const session = new FakeSession();
    let capturedGate:
      Parameters<NonNullable<ConstructorParameters<typeof StudioBrokerController>[0]["createService"]>>[1] | undefined;
    const service = new FakeService();
    const { controller } = harness([session], {
      createService: (_client, gate) => {
        capturedGate = gate;
        return service as unknown as StudioMcpService;
      },
    });
    const started = controller.retain();
    await vi.waitFor(() => expect(session.stderrListeners.size).toBe(1));
    await readyPrimary(session, started);

    await expect(
      capturedGate?.authorize(
        { operation: "property-write", target: "game.Workspace.Part", path: "Transparency" },
        { allowed: false, reason: "user-confirmation-required" },
        { tool: "set_property", input: {} },
      ),
    ).resolves.toEqual({
      approved: false,
      reason: "Studio mutations are not available in the desktop MVP.",
    });
    expect(() =>
      capturedGate?.consume(
        "forged-authorization",
        { operation: "property-write", target: "game.Workspace.Part", path: "Transparency" },
        { tool: "set_property", input: {} },
      ),
    ).toThrow("Studio mutations are not available in the desktop MVP.");
  });

  it("closes a discovered session and creates no epoch when tool discovery fails", async () => {
    const session = new FakeSession();
    const service = new FakeService();
    const discovery = deferred<ReadonlySet<string>>();
    service.discoverGate = discovery.promise;
    let epochCalls = 0;
    const { controller } = harness([session], {
      createService: () => service as unknown as StudioMcpService,
      createEpoch: () => {
        epochCalls += 1;
        return "must-not-exist";
      },
    });
    const started = controller.retain();
    await vi.waitFor(() => expect(session.stderrListeners.size).toBe(1));
    session.stderr("HTTP server listening on 127.0.0.1:58741 for Studio plugin (primary mode)\\n");
    await vi.waitFor(() => expect(service.discoverCalls).toBe(1));
    discovery.reject(new Error("bad tools"));

    await expect(started).rejects.toMatchObject({ code: "mcp-discovery-failed" });
    expect(session.closeCalls).toBe(1);
    expect(epochCalls).toBe(0);
    expect(controller.snapshot().ready).toBeUndefined();
  });

  it("rejects exit before readiness and closes startup exactly once", async () => {
    const session = new FakeSession();
    const { controller } = harness([session]);
    const started = controller.retain();
    await vi.waitFor(() => expect(session.exitListeners.size).toBe(1));
    session.exit(9, null);

    await expect(started).rejects.toMatchObject({ code: "mcp-broker-exited" });
    expect(session.closeCalls).toBe(1);
  });
});

describe("StudioBrokerController leases and lifecycle", () => {
  it("deduplicates concurrent retains but gives each caller a distinct idempotent lease", async () => {
    const session = new FakeSession();
    const { controller, launches } = harness([session]);
    const first = controller.retain();
    const second = controller.retain();
    await vi.waitFor(() => expect(session.stderrListeners.size).toBe(1));
    session.stderr("HTTP server listening on 127.0.0.1:58741 for Studio plugin (primary mode)\\n");
    const [a, b] = await Promise.all([first, second]);

    expect(a).not.toBe(b);
    expect(launches).toHaveLength(1);
    expect(controller.snapshot().referenceCount).toBe(2);
    await a.release();
    await a.release();
    expect(session.closeCalls).toBe(0);
    expect(controller.snapshot().referenceCount).toBe(1);
    await b.release();
    expect(session.closeCalls).toBe(1);
    expect(controller.snapshot()).toEqual({ state: "stopped", referenceCount: 0 });
  });

  it("a retain during close waits and starts a fresh epoch while stale release cannot affect it", async () => {
    const firstSession = new FakeSession();
    const closing = deferred<undefined>();
    firstSession.closeGate = closing.promise;
    const secondSession = new FakeSession();
    const { controller, launches } = harness([firstSession, secondSession]);
    const firstStarted = controller.retain();
    await vi.waitFor(() => expect(firstSession.stderrListeners.size).toBe(1));
    const stale = await readyPrimary(firstSession, firstStarted);
    const releasing = stale.release();
    await vi.waitFor(() => expect(firstSession.closeCalls).toBe(1));

    const replacementStarted = controller.retain();
    expect(launches).toHaveLength(1);
    closing.resolve(undefined);
    await releasing;
    await vi.waitFor(() => expect(secondSession.stderrListeners.size).toBe(1));
    secondSession.stderr("HTTP server listening on 127.0.0.1:58741 for Studio plugin (primary mode)\\n");
    const replacement = await replacementStarted;
    await stale.release();

    expect(replacement.ready.brokerEpoch).toBe("broker-epoch-2");
    expect(launches.map(({ authToken }) => authToken)).toEqual(["a".repeat(64), "b".repeat(64)]);
    expect(controller.snapshot()).toMatchObject({ state: "ready", referenceCount: 1 });
    expect(secondSession.closeCalls).toBe(0);
  });

  it("stop is idempotent during preflight, session creation, readiness, discovery, and ready state", async () => {
    for (const phase of ["preflight", "session", "readiness", "discovery", "ready"] as const) {
      const session = new FakeSession();
      const preflight = deferred<boolean>();
      const created = deferred<StudioBrokerSession>();
      const discovery = deferred<ReadonlySet<string>>();
      const service = new FakeService();
      service.discoverGate = discovery.promise;
      let createCalls = 0;
      const { controller } = harness([], {
        preflightPort: async () => preflight.promise,
        createSession: async () => {
          createCalls += 1;
          return created.promise;
        },
        createService: () => service as unknown as StudioMcpService,
      });
      const retained = controller.retain();
      if (phase !== "preflight") preflight.resolve(true);
      if (phase === "session") await vi.waitFor(() => expect(createCalls).toBe(1));
      if (phase === "readiness" || phase === "discovery" || phase === "ready") {
        created.resolve(session);
        await vi.waitFor(() => expect(session.stderrListeners.size).toBe(1));
      }
      if (phase === "discovery" || phase === "ready") {
        session.stderr("HTTP server listening on 127.0.0.1:58741 for Studio plugin (primary mode)\\n");
        await new Promise((resolve) => setTimeout(resolve, 7));
      }
      if (phase === "ready") {
        discovery.resolve(new Set());
        await retained;
      }
      const stops = Promise.all([controller.stop(), controller.stop()]);
      preflight.resolve(true);
      created.resolve(session);
      discovery.resolve(new Set());
      await stops;
      if (phase !== "ready") await expect(retained).rejects.toMatchObject({ code: "mcp-startup-stopped" });

      expect(session.closeCalls).toBe(phase === "preflight" ? 0 : 1);
      expect(controller.snapshot()).toEqual({ state: "stopped", referenceCount: 0 });
    }
  });

  it("invalidates current leases and clears explicit selection on unexpected exit", async () => {
    const session = new FakeSession();
    const { controller, invalidations, services } = harness([session]);
    const started = controller.retain();
    await vi.waitFor(() => expect(session.stderrListeners.size).toBe(1));
    const lease = await readyPrimary(session, started);
    session.exit(1, null);

    expect(services[0]?.clearCalls).toBe(1);
    expect(invalidations).toEqual(["broker-exit"]);
    expect(controller.snapshot()).toMatchObject({ state: "error", referenceCount: 0 });
    await lease.release();
    expect(session.closeCalls).toBe(1);
  });

  it("still closes and invalidates the current run when an invalidation observer throws", async () => {
    const session = new FakeSession();
    const { controller } = harness([session], {
      onInvalidated: () => {
        throw new Error("observer failed");
      },
    });
    const started = controller.retain();
    await vi.waitFor(() => expect(session.stderrListeners.size).toBe(1));
    await readyPrimary(session, started);

    expect(() => session.exit(1, null)).not.toThrow();
    expect(controller.snapshot()).toMatchObject({ state: "error", referenceCount: 0 });
    expect(session.closeCalls).toBe(1);
  });

  it("waits for unexpected-exit cleanup before starting a replacement", async () => {
    const oldSession = new FakeSession();
    const oldClose = deferred<undefined>();
    oldSession.closeGate = oldClose.promise;
    const replacementSession = new FakeSession();
    const { controller, launches, invalidations } = harness([oldSession, replacementSession]);
    const firstStarted = controller.retain();
    await vi.waitFor(() => expect(oldSession.stderrListeners.size).toBe(1));
    await readyPrimary(oldSession, firstStarted);

    oldSession.exit(1, null);
    const replacementStarted = controller.retain();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(launches).toHaveLength(1);
    expect(oldSession.closeCalls).toBe(1);
    expect(invalidations).toEqual(["broker-exit"]);

    oldClose.resolve(undefined);
    await vi.waitFor(() => expect(replacementSession.stderrListeners.size).toBe(1));
    replacementSession.stderr("HTTP server listening on 127.0.0.1:58741 for Studio plugin (primary mode)\\n");
    await expect(replacementStarted).resolves.toHaveProperty("ready.brokerEpoch", "broker-epoch-2");
  });

  it("does not finish stop until unexpected-exit cleanup completes", async () => {
    const session = new FakeSession();
    const close = deferred<undefined>();
    session.closeGate = close.promise;
    const { controller } = harness([session]);
    const started = controller.retain();
    await vi.waitFor(() => expect(session.stderrListeners.size).toBe(1));
    await readyPrimary(session, started);
    session.exit(1, null);

    let stopped = false;
    const stopping = controller.stop().then(() => {
      stopped = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(stopped).toBe(false);
    expect(session.closeCalls).toBe(1);

    close.resolve(undefined);
    await stopping;
    expect(controller.snapshot()).toEqual({ state: "stopped", referenceCount: 0 });
  });

  it("propagates one redacted idempotent session-close rejection through stop", async () => {
    const session = new FakeSession();
    session.closeError = new Error("close failed /Users/private token=secret-value");
    const { controller } = harness([session]);
    const started = controller.retain();
    await vi.waitFor(() => expect(session.stderrListeners.size).toBe(1));
    await readyPrimary(session, started);

    const first = controller.stop();
    const second = controller.stop();
    await expect(first).rejects.toMatchObject({
      code: "mcp-session-close-failed",
      message: "Studio MCP session close failed",
    });
    await expect(second).rejects.toMatchObject({
      code: "mcp-session-close-failed",
      message: "Studio MCP session close failed",
    });
    expect(session.closeCalls).toBe(1);
    expect(JSON.stringify(await first.catch((error) => error))).not.toMatch(/Users|secret-value/);
  });

  it("does not suppress a close rejection while cancelling startup", async () => {
    const session = new FakeSession();
    session.closeError = new Error("startup close failed token=private");
    const created = deferred<StudioBrokerSession>();
    const { controller } = harness([], {
      createSession: async () => created.promise,
    });
    const retained = controller.retain();
    const retainedFailure = retained.catch((error) => error);
    created.resolve(session);
    await vi.waitFor(() => expect(session.stderrListeners.size).toBe(1));

    await expect(controller.stop()).rejects.toMatchObject({
      code: "mcp-session-close-failed",
      message: "Studio MCP session close failed",
    });
    await expect(retainedFailure).resolves.toBeDefined();
    expect(session.closeCalls).toBe(1);
  });

  it("propagates a tracked unexpected-exit close rejection through stop without an unhandled raw error", async () => {
    const session = new FakeSession();
    session.closeError = new Error("unexpected close failed /Users/private");
    const { controller } = harness([session]);
    const started = controller.retain();
    await vi.waitFor(() => expect(session.stderrListeners.size).toBe(1));
    await readyPrimary(session, started);
    session.exit(1, null);

    await expect(controller.stop()).rejects.toMatchObject({
      code: "mcp-session-close-failed",
      message: "Studio MCP session close failed",
    });
    expect(session.closeCalls).toBe(1);
  });

  it("retains a settled unexpected-exit close failure for disposal without blocking a clean replacement", async () => {
    const failedSession = new FakeSession();
    failedSession.closeError = new Error("old close failed token=private");
    const replacementSession = new FakeSession();
    const { controller } = harness([failedSession, replacementSession]);
    const firstStarted = controller.retain();
    await vi.waitFor(() => expect(failedSession.stderrListeners.size).toBe(1));
    await readyPrimary(failedSession, firstStarted);
    failedSession.exit(1, null);
    await vi.waitFor(() => expect(failedSession.closeCalls).toBe(1));
    await new Promise<void>((resolve) => setImmediate(resolve));

    const replacementStarted = controller.retain();
    await vi.waitFor(() => expect(replacementSession.stderrListeners.size).toBe(1));
    const replacement = await readyPrimary(replacementSession, replacementStarted);
    expect(replacement.ready.brokerEpoch).toBe("broker-epoch-2");
    await replacement.release();

    await expect(controller.stop()).rejects.toMatchObject({
      code: "mcp-session-close-failed",
      message: "Studio MCP session close failed",
    });
    expect(replacementSession.closeCalls).toBe(1);
  });

  it("ignores a late exit from an old epoch after replacement", async () => {
    const oldSession = new FakeSession();
    const nextSession = new FakeSession();
    const { controller, invalidations } = harness([oldSession, nextSession]);
    const firstStarted = controller.retain();
    await vi.waitFor(() => expect(oldSession.stderrListeners.size).toBe(1));
    const first = await readyPrimary(oldSession, firstStarted);
    await first.release();

    const nextStarted = controller.retain();
    await vi.waitFor(() => expect(nextSession.stderrListeners.size).toBe(1));
    const next = await readyPrimary(nextSession, nextStarted);
    oldSession.exit(1, null);

    expect(next.ready.brokerEpoch).toBe("broker-epoch-2");
    expect(controller.snapshot()).toMatchObject({ state: "ready", referenceCount: 1 });
    expect(invalidations).toEqual([]);
  });

  it("redacts tokens and inherited secrets from bounded failure diagnostics and snapshots", async () => {
    const session = new FakeSession();
    const token = "f".repeat(64);
    const { controller } = harness([session], { createToken: () => token });
    const started = controller.retain();
    await vi.waitFor(() => expect(session.stderrListeners.size).toBe(1));
    session.stderr(`password=hunter2 token=${token} AWS_SECRET_ACCESS_KEY=inherited-secret\\n`);
    session.exit(1, null);

    await expect(started).rejects.toMatchObject({ code: "mcp-broker-exited" });
    const encoded = JSON.stringify(controller.snapshot());
    expect(Buffer.byteLength(encoded, "utf8")).toBeLessThanOrEqual(32_768);
    expect(encoded).not.toContain(token);
    expect(encoded).not.toContain("hunter2");
    expect(encoded).not.toContain("inherited-secret");
    expect(encoded).not.toContain("ROBLOX_STUDIO_AUTH_TOKEN");
  });

  it("bounds blank-line failure diagnostics by framed bytes and record count", async () => {
    const session = new FakeSession();
    const { controller } = harness([session]);
    const started = controller.retain();
    await vi.waitFor(() => expect(session.stderrListeners.size).toBe(1));
    for (let index = 0; index < 10_000; index += 1) session.stderr("\\n");
    session.exit(1, null);

    await expect(started).rejects.toMatchObject({ code: "mcp-broker-exited" });
    const diagnostic = controller.snapshot().diagnostic ?? "";
    expect(diagnostic.split("\n").length).toBeLessThanOrEqual(513);
    expect(Buffer.byteLength(diagnostic, "utf8")).toBeLessThanOrEqual(32_768);
  });
});
