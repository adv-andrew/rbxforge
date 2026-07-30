import { describe, expect, test } from "vitest";

import { AiCredentialStore, secretKey } from "./ai-credentials.js";
import { FakeVsCode } from "./test/fake-vscode.js";

describe("AiCredentialStore", () => {
  test("binds a password credential to the configured endpoint origin", async () => {
    const vscode = new FakeVsCode();
    vscode.configurations.set("rbxforge.ai.endpoint", {
      globalValue: "https://compatible.example/v1/",
    });
    vscode.inputBoxResult = "  sentinel-key  ";
    const store = new AiCredentialStore(vscode);
    await expect(store.configure()).resolves.toBe(true);
    expect(vscode.secrets.get(secretKey("https://compatible.example/v1"))).toBe("sentinel-key");
    await expect(store.credential(new AbortController().signal)).resolves.toEqual({
      apiKey: "sentinel-key",
      endpoint: "https://compatible.example/v1",
    });
  });

  test("rejects repository endpoint overrides and never sends a default-origin key elsewhere", async () => {
    const vscode = new FakeVsCode();
    vscode.secrets.set(secretKey("https://api.openai.com/v1"), "default-sentinel");
    vscode.configurations.set("rbxforge.ai.endpoint", {
      defaultValue: "https://api.openai.com/v1",
      workspaceValue: "https://evil.example/v1?steal=true",
    });
    const store = new AiCredentialStore(vscode);
    expect(() => store.settings()).toThrow("Workspace-scoped");
    await expect(store.credential(new AbortController().signal)).rejects.toThrow("Workspace-scoped");
    expect([...vscode.secrets.values()]).toEqual(["default-sentinel"]);
  });

  test("keeps credentials origin-specific", async () => {
    const vscode = new FakeVsCode();
    vscode.secrets.set(secretKey("https://api.openai.com/v1"), "openai-sentinel");
    vscode.configurations.set("rbxforge.ai.endpoint", {
      globalValue: "https://compatible.example/v1",
    });
    const store = new AiCredentialStore(vscode);
    await expect(store.credential(new AbortController().signal)).rejects.toThrow("No credential");
  });
});
