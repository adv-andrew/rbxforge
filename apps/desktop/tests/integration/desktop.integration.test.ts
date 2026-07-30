import { createConnection } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { integrationHarness, type IntegrationHarness } from "./integration-harness.js";
import { withFailClosedExecutionBoundary } from "./integrated-execution-boundary.js";

const harnesses: IntegrationHarness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.shutdown()));
});

describe("standalone desktop integration", () => {
  it("keeps two projects on isolated Rojo leases and bindings while sharing one broker", async () => {
    const harness = await trackedHarness();

    const a = await harness.connectAndBind("project-a", "studio-a");
    const b = await harness.connectAndBind("project-b", "studio-b");

    expect(a.rojo.leaseId).not.toBe(b.rojo.leaseId);
    expect(a.rojo.port).not.toBe(b.rojo.port);
    expect(a.rojo.generation).toBe(1);
    expect(b.rojo.generation).toBe(1);
    expect(a.studio.brokerEpoch).toBe(b.studio.brokerEpoch);
    expect(harness.broker.startCalls).toBe(1);
    expect(harness.ports.allocatedRojoPorts).toEqual([34_871, 34_872]);
    expect(() => harness.bindings.assertCurrent("project-a", b.bindingRevision)).toThrow(
      "Studio binding is not current",
    );

    await expect(harness.selectProject("project-a")).resolves.toBe(true);
    expect(harness.broker.selectedInstanceId).toBe("studio-b");
    expect(harness.bindings.assertCurrent("project-a", a.bindingRevision).studio.instanceId).toBe("studio-a");
    expect(harness.bindings.assertCurrent("project-b", b.bindingRevision).studio.instanceId).toBe("studio-b");

    const routedA = await harness.bindings.withBinding("project-a", a.bindingRevision, async (_service, id) => id);
    const routedB = await harness.bindings.withBinding("project-b", b.bindingRevision, async (_service, id) => id);
    expect([routedA, routedB]).toEqual(["studio-a", "studio-b"]);
    expect(harness.broker.routeSelections.slice(-2)).toEqual(["studio-a", "studio-b"]);
  });

  it("never auto-selects a sole Studio row and fails closed on wrong-project identity", async () => {
    const harness = await trackedHarness({
      studios: [
        {
          instanceId: "wrong-project",
          placeId: 202,
          placeName: "Project B",
          dataModelName: "Project B",
        },
      ],
    });

    const catalog = await harness.connectProject("project-a");
    expect(catalog.instances).toHaveLength(1);
    expect(catalog.instances[0]).toMatchObject({
      instanceId: "wrong-project",
      eligible: false,
      eligibilityReason: "project-mismatch",
    });
    expect(harness.broker.routeSelections).toEqual([]);
    expect(() => harness.selectStudio("project-a", "wrong-project", catalog.revision)).toThrow(
      "not eligible: project-mismatch",
    );
    expect(harness.bindings.snapshot("project-a").binding).toBeUndefined();
  });

  it("binds same-name Studio rows by stable ID and place ID rather than display name", async () => {
    const harness = await trackedHarness({
      studios: [
        {
          instanceId: "same-name-a",
          placeId: 101,
          placeName: "Shared Name",
          dataModelName: "Shared Name",
        },
        {
          instanceId: "same-name-b",
          placeId: 202,
          placeName: "Shared Name",
          dataModelName: "Shared Name",
        },
      ],
    });

    const a = await harness.connectAndBind("project-a", "same-name-a");
    const b = await harness.connectAndBind("project-b", "same-name-b");

    expect(a.studio).toMatchObject({ instanceId: "same-name-a", placeId: 101 });
    expect(b.studio).toMatchObject({ instanceId: "same-name-b", placeId: 202 });
  });

  it("invalidates an atomically replaced project file before the next bound host use", async () => {
    const harness = await trackedHarness();
    const binding = await harness.connectAndBind("project-a", "studio-a");
    let hostCalls = 0;

    await harness.replaceProjectFileAtomically("project-a");

    await expect(
      harness.bindings.withBinding("project-a", binding.bindingRevision, async () => {
        hostCalls += 1;
      }),
    ).rejects.toThrow("identity changed");
    expect(hostCalls).toBe(0);
    expect(harness.bindings.snapshot("project-a")).toMatchObject({
      state: "needs-reconnect",
      invalidationReason: "project-drift",
    });
  });

  it("invalidates within the accepted catalog, activity, resume, broker, and Rojo bounds", async () => {
    const catalogFailure = await trackedHarness();
    await catalogFailure.connectAndBind("project-a", "studio-a");
    catalogFailure.broker.failNextCatalogs(3);
    await expect(catalogFailure.refreshCatalog()).rejects.toThrow("catalog fixture failure");
    await expect(catalogFailure.refreshCatalog()).rejects.toThrow("catalog fixture failure");
    await expect(catalogFailure.refreshCatalog()).rejects.toThrow("catalog fixture failure");
    expect(catalogFailure.bindings.snapshot("project-a")).toMatchObject({
      state: "needs-reconnect",
      invalidationReason: "catalog-refresh-failed",
    });

    const stale = await trackedHarness();
    const staleBinding = await stale.connectAndBind("project-a", "studio-a");
    stale.clock.advance(5_001);
    expect(() => stale.bindings.assertCurrent("project-a", staleBinding.bindingRevision)).toThrow("stale");
    expect(stale.bindings.snapshot("project-a")).toMatchObject({
      state: "needs-reconnect",
      invalidationReason: "catalog-stale",
    });

    const resume = await trackedHarness();
    await resume.connectAndBind("project-a", "studio-a");
    resume.simulateResume();
    expect(resume.bindings.snapshot("project-a")).toMatchObject({
      state: "needs-reconnect",
      invalidationReason: "resume",
    });

    const brokerRestart = await trackedHarness();
    const oldBinding = await brokerRestart.connectAndBind("project-a", "studio-a");
    brokerRestart.broker.restart({ preserveRawInstanceIds: true });
    await brokerRestart.refreshCatalog();
    expect(() => brokerRestart.bindings.assertCurrent("project-a", oldBinding.bindingRevision)).toThrow("not current");
    expect(brokerRestart.bindings.snapshot("project-a")).toMatchObject({
      state: "needs-reconnect",
      invalidationReason: "broker-restart",
    });

    const rojoExit = await trackedHarness();
    await rojoExit.connectAndBind("project-a", "studio-a");
    rojoExit.emitRojoExit("project-a");
    await rojoExit.settleInvalidations();
    expect(rojoExit.bindings.snapshot("project-a")).toMatchObject({
      state: "needs-reconnect",
      invalidationReason: "rojo-exit",
    });
  });

  it("never revives an old binding when the same raw instance ID returns after broker restart", async () => {
    const harness = await trackedHarness();
    const oldBinding = await harness.connectAndBind("project-a", "studio-a");

    harness.broker.restart({ preserveRawInstanceIds: true });
    await harness.refreshCatalog();
    const replacement = await harness.bindFromCurrentCatalog("project-a", "studio-a");

    expect(replacement.studio.instanceId).toBe(oldBinding.studio.instanceId);
    expect(replacement.studio.brokerEpoch).not.toBe(oldBinding.studio.brokerEpoch);
    expect(replacement.bindingRevision).toBeGreaterThan(oldBinding.bindingRevision);
    expect(() => harness.bindings.assertCurrent("project-a", oldBinding.bindingRevision)).toThrow("not current");
  });

  it("relaunches with durable local rows and settings but no process or binding identity", async () => {
    const harness = await trackedHarness();
    const binding = await harness.connectAndBind("project-a", "studio-a");
    await harness.persistConversationState();
    harness.repositories.settings.setRojoPath("/opt/rbxforge-test/rojo");
    harness.repositories.settings.setMcpPort(59_741);
    harness.repositories.settings.setSidebarWidth(312);

    const relaunched = await harness.relaunch();
    harnesses.push(relaunched);

    expect(relaunched.snapshot.projects.map(({ id }) => id)).toEqual(["project-b", "project-a"]);
    expect(relaunched.snapshot.messages.map(({ content }) => content)).toContain(
      "Keep the round lobby local and deterministic.",
    );
    expect(relaunched.snapshot.drafts.map(({ content }) => content)).toContain("Draft survives relaunch.");
    expect(relaunched.snapshot.settings).toMatchObject({
      preferredMcpPort: 59_741,
      sidebarWidth: 312,
    });
    expect(relaunched.repositories.settings.getRojoPath()).toBe("/opt/rbxforge-test/rojo");
    expect(relaunched.runtimes.snapshot("project-a")).toBeUndefined();
    expect(relaunched.broker.startCalls).toBe(0);
    expect(relaunched.bindings.snapshot("project-a").binding).toBeUndefined();
    expect(relaunched.bindings.snapshot("project-a").pending).toBeUndefined();
    expect(relaunched.snapshot.runtimeByProject["project-a"]).not.toHaveProperty("rojo");
    expect(relaunched.snapshot.runtimeByProject["project-a"]).not.toHaveProperty("broker");
    expect(relaunched.snapshot.runtimeByProject["project-a"]).not.toHaveProperty("studio");
    expect(relaunched.snapshot.runtimeByProject["project-a"]).not.toHaveProperty("bindingRevision");
    expect(binding.bindingId).not.toEqual("");
  });

  it("completes its integrated lifecycle behind fail-closed AI, credential, fetch, and socket traps", async () => {
    await withFailClosedExecutionBoundary(async () => {
      const harness = await integrationHarness();
      try {
        await harness.connectAndBind("project-a", "studio-a");
        await harness.persistConversationState();
      } finally {
        await harness.shutdown();
      }
    });
  });

  it("mutation check: fails closed when integrated execution calls global fetch", async () => {
    await expect(
      withFailClosedExecutionBoundary(async () => {
        await fetch("https://api.openai.com/v1/responses");
      }),
    ).rejects.toThrow(/forbidden global fetch.*api\.openai\.com/i);
  });

  it("mutation check: fails closed when integrated execution opens a forbidden external port", async () => {
    await expect(
      withFailClosedExecutionBoundary(() => {
        createConnection({ host: "198.51.100.1", port: 443 });
      }),
    ).rejects.toThrow(/forbidden socket connect.*198\.51\.100\.1:443/i);
  });

  it("mutation check: fails closed when integrated execution looks up a credential environment key", async () => {
    await expect(
      withFailClosedExecutionBoundary(() => {
        void process.env.OPENAI_API_KEY;
      }),
    ).rejects.toThrow(/forbidden credential environment lookup.*OPENAI_API_KEY/i);
  });
});

async function trackedHarness(options: Parameters<typeof integrationHarness>[0] = {}): Promise<IntegrationHarness> {
  const harness = await integrationHarness(options);
  harnesses.push(harness);
  return harness;
}
