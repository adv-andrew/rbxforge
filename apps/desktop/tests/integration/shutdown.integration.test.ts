import { expect, it } from "vitest";

import { integrationHarness } from "./integration-harness.js";

it("shuts down exactly retained children and closes real SQLite once", async () => {
  const harness = await integrationHarness();
  await harness.connectAndBind("project-a", "studio-a");
  await harness.connectAndBind("project-b", "studio-b");

  await harness.shutdown();
  await harness.shutdown();

  expect(harness.rojoChildren.map(({ stopCalls }) => stopCalls)).toEqual([1, 1]);
  expect(harness.unownedRojoChild.stopCalls).toBe(0);
  expect(harness.broker.releaseCalls).toBe(2);
  expect(harness.broker.stopCalls).toBe(1);
  expect(harness.broker.unownedHandleStopCalls).toBe(0);
  expect(harness.storageCloseCalls).toBe(1);
});
