import { RevisionedIgnorePolicy } from "@rbxforge/agent";
import type { FileProjectionNode, ProjectionNode } from "@rbxforge/core";
import { expect, test, vi } from "vitest";

import * as services from "./service-container.js";
import type { DisposablePort, EventPort } from "./vscode-facade.js";
import { createNativeStudioMutationGate } from "./webviews/native-mutation-gate.js";

class Emitter<T> implements EventPort<T> {
  readonly #listeners = new Set<(value: T) => void>();
  readonly event = (listener: (value: T) => void): DisposablePort => {
    this.#listeners.add(listener);
    return { dispose: () => this.#listeners.delete(listener) };
  };
  emit(value: T): void {
    for (const listener of this.#listeners) listener(value);
  }
}

test("lazy three-source graph reconciles accepted projections into unified nodes", async () => {
  const invalidated = new Emitter<{ readonly path: string }>();
  const files: readonly FileProjectionNode[] = [
    { path: "game.Workspace.Mapped", filePaths: ["/tmp/Mapped.server.lua"] },
  ];
  const rojo: readonly ProjectionNode[] = [{ path: "game.Workspace.Mapped", name: "Mapped", className: "Script" }];
  const studio: readonly ProjectionNode[] = [{ path: "game.Workspace.Mapped", name: "Mapped", className: "Script" }];
  const graph = services.createReconciledLiveGraph({
    files: { children: async () => files, onInvalidated: invalidated.event },
    rojo: { children: async () => rojo, onInvalidated: invalidated.event },
    studio: { children: async () => studio, onInvalidated: invalidated.event },
    onConnectionChanged: (() => ({ dispose: () => undefined })) as EventPort<
      ReturnType<ReturnType<typeof services.createFixtureServices>["connection"]["snapshot"]>
    >,
  });

  const children = await graph.children("game.Workspace", new AbortController().signal);
  expect(children).toEqual([expect.objectContaining({ path: "game.Workspace.Mapped", ownership: "files" })]);
});

test("reconciliation keeps file and Rojo projections when Studio is unavailable", async () => {
  const invalidated = new Emitter<{ readonly path: string }>();
  const files: readonly FileProjectionNode[] = [
    {
      path: "game.Workspace.Mapped",
      filePaths: ["/tmp/Mapped.server.lua"],
    },
  ];
  const rojo: readonly ProjectionNode[] = [
    {
      path: "game.Workspace.Mapped",
      name: "Mapped",
      className: "Script",
    },
  ];
  const graph = services.createReconciledLiveGraph({
    files: { children: async () => files, onInvalidated: invalidated.event },
    rojo: { children: async () => rojo, onInvalidated: invalidated.event },
    studio: {
      children: async () => {
        throw new Error("No Studio instance selected");
      },
      onInvalidated: invalidated.event,
    },
    onConnectionChanged: (() => ({ dispose: () => undefined })) as EventPort<
      ReturnType<ReturnType<typeof services.createFixtureServices>["connection"]["snapshot"]>
    >,
  });

  await expect(graph.children("game.Workspace", new AbortController().signal)).resolves.toEqual([
    expect.objectContaining({
      path: "game.Workspace.Mapped",
      ownership: "unknown",
      files: expect.objectContaining({ filePaths: ["/tmp/Mapped.server.lua"] }),
      rojo: expect.objectContaining({ className: "Script" }),
    }),
  ]);
});

test("fresh graph resolution binds exact identity and invalidation makes its revision unusable", async () => {
  const invalidated = new Emitter<{ readonly path: string }>();
  let studio: readonly ProjectionNode[] = [
    {
      path: "game.Workspace.Part",
      name: "Part",
      className: "Part",
    },
  ];
  const graph = services.createReconciledLiveGraph({
    files: { children: async () => [], onInvalidated: invalidated.event },
    rojo: { children: async () => [], onInvalidated: invalidated.event },
    studio: { children: async () => studio, onInvalidated: invalidated.event },
    onConnectionChanged: (() => ({ dispose: () => undefined })) as EventPort<
      ReturnType<ReturnType<typeof services.createFixtureServices>["connection"]["snapshot"]>
    >,
  });

  const resolved = await graph.resolve("game.Workspace.Part", new AbortController().signal);
  expect(resolved.node).toMatchObject({
    path: "game.Workspace.Part",
    name: "Part",
    className: "Part",
    ownership: "studio",
  });
  expect(() => graph.assertRevision(resolved.revision)).not.toThrow();

  studio = [];
  invalidated.emit({ path: "game.Workspace" });
  expect(() => graph.assertRevision(resolved.revision)).toThrow("graph changed");
  await expect(graph.resolve("game.Workspace.Part", new AbortController().signal)).rejects.toThrow("not found");
});

test("fixture mode exposes deterministic unified nodes", async () => {
  const fixture = services.createFixtureServices();
  let receivedRevision = -1;
  fixture.graph.onConnectionChanged((snapshot) => {
    receivedRevision = snapshot.revision;
  });
  fixture.connection.update("workspace", { health: "healthy", detail: "fixture workspace" });
  const fixtureNodes = await fixture.graph.children("game", new AbortController().signal);
  expect(fixture.connection.snapshot().simulation).toBe(true);
  expect(receivedRevision).toBe(1);
  expect(fixtureNodes[0]).toMatchObject({ path: "game.Workspace", ownership: "files" });
});

test("project selection publishes workspace health", async () => {
  const fixture = services.createFixtureServices();
  await fixture.project.select("/repo/default.project.json");
  expect(fixture.connection.snapshot().checks.workspace).toMatchObject({
    health: "healthy",
    detail: "/repo/default.project.json",
  });
});

test("normal production construction and disposal do not start external adapters", async () => {
  const production = services.createProductionServices();
  expect(production.connection.snapshot().checks.rojoProcess.health).toBe("unknown");
  expect(production.connection.snapshot().checks.mcpProcess.health).toBe("unknown");
  const evaluation = await production.agent.ignorePolicy.evaluate(["/tmp/ordinary.lua"], new AbortController().signal);
  expect(evaluation.results).toEqual([{ path: "/tmp/ordinary.lua", ignored: true }]);
  expect(production.agent.ignorePolicy.isCurrent(evaluation.attestation)).toBe(true);
  await production.dispose();
});

test("production exposes one broker-backed Studio write port but no raw claim issuer or claimed write pair", async () => {
  const gate = createNativeStudioMutationGate(async () => true);
  const production = services.createProductionServices({
    mutationGate: gate,
    studioClaimIssuer: gate,
    ignorePolicy: new RevisionedIgnorePolicy({ evaluate: () => false }),
  });

  expect(production.agent.studioWrites).toBeDefined();
  expect("studioClaimIssuer" in production.agent).toBe(false);
  expect("callWriteWithClaim" in production.studio).toBe(false);
  expect(Object.keys(production.agent).sort()).toEqual([
    "approvalBroker",
    "contextRegistry",
    "ignorePolicy",
    "studioWrites",
  ]);

  await production.dispose();
});

test("service disposal owns and disposes the shared ignore policy exactly once", async () => {
  const attestation = Object.freeze({});
  const dispose = vi.fn();
  const production = services.createProductionServices({
    ignorePolicy: {
      evaluate: async (paths) => ({
        results: paths.map((path) => ({ path, ignored: false })),
        attestation,
      }),
      isCurrent: (candidate) => candidate === attestation,
      dispose,
    },
  });

  await production.dispose();
  await production.dispose();

  expect(dispose).toHaveBeenCalledTimes(1);
});
