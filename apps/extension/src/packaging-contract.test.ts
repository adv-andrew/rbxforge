import { createHash } from "node:crypto";
import { access, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const secretSentinel = `${repositoryRoot}/rbxforge-untracked-secret-fixture.test.ts`;

describe("standalone packaging contract", () => {
  afterEach(async () => {
    await rm(secretSentinel, { force: true });
  });

  test("defines clean, build, package, archive inspection, and secret scan entrypoints", async () => {
    const manifest = JSON.parse(await readFile(`${repositoryRoot}/package.json`, "utf8")) as {
      scripts?: Record<string, string>;
    };

    expect(manifest.scripts).toMatchObject({
      "format:check": expect.any(String),
      lint: expect.any(String),
      typecheck: expect.any(String),
      test: expect.any(String),
      clean: expect.any(String),
      build: expect.any(String),
      package: expect.any(String),
      "inspect:vsix": expect.any(String),
      "scan:secrets": expect.any(String),
    });
  });

  test("keeps the package pipeline and standalone smoke checks in versioned scripts", async () => {
    await expect(access(`${repositoryRoot}/scripts/package-extension.mjs`)).resolves.toBeUndefined();
    await expect(access(`${repositoryRoot}/scripts/inspect-vsix.mjs`)).resolves.toBeUndefined();
    await expect(access(`${repositoryRoot}/scripts/scan-secrets.mjs`)).resolves.toBeUndefined();
    await expect(access(`${repositoryRoot}/scripts/smoke-packaged-extension.mjs`)).resolves.toBeUndefined();
  });

  test("the packaged smoke explicitly exercises Viewport assets and the transport-owned PID", async () => {
    const smoke = await readFile(`${repositoryRoot}/scripts/smoke-packaged-extension.mjs`, "utf8");
    expect(smoke).toContain('facade.commands.get("rbxforge.captureScreenshot")');
    expect(smoke).toContain("data: blob:");
    expect(smoke).toContain("transport.pid");
    expect(smoke).toContain("ensureOwnedProcessGone");
  });

  test("owned-process cleanup signals only the captured PID after bounded graceful polling", async () => {
    // @ts-expect-error no declaration file is needed for the packaging script module
    const { ensureOwnedProcessGone } = (await import("../../../scripts/lib/owned-process.mjs")) as {
      ensureOwnedProcessGone(
        pid: number,
        options: {
          probe(pid: number): boolean;
          force(pid: number, signal: "SIGKILL"): void;
          delay(): Promise<void>;
          gracefulAttempts: number;
          forcedAttempts: number;
        },
      ): Promise<void>;
    };
    const signals: [number, string][] = [];
    let forced = false;
    await expect(
      ensureOwnedProcessGone(42_424, {
        probe: () => !forced,
        force: (pid, signal) => {
          signals.push([pid, signal]);
          forced = true;
        },
        delay: async () => undefined,
        gracefulAttempts: 2,
        forcedAttempts: 2,
      }),
    ).resolves.toBeUndefined();
    expect(signals).toEqual([[42_424, "SIGKILL"]]);
  });

  test("ships the documented ownership and manual verification boundaries", async () => {
    await expect(access(`${repositoryRoot}/README.md`)).resolves.toBeUndefined();
    await expect(access(`${repositoryRoot}/docs/architecture.md`)).resolves.toBeUndefined();
    await expect(access(`${repositoryRoot}/docs/manual-studio-verification.md`)).resolves.toBeUndefined();
    await expect(access(`${repositoryRoot}/apps/extension/LICENSE`)).resolves.toBeUndefined();
  });

  test("pins the clean-clone Studio MCP license copy byte-for-byte", async () => {
    const license = await readFile(`${repositoryRoot}/licenses/chrrxs-robloxstudio-mcp-LICENSE.txt`);
    expect(license).toHaveLength(1_055);
    expect(createHash("sha256").update(license).digest("hex")).toBe(
      "3bed3331b7048bac17cf50e249d560ccc9508c970da8d7b9283bf4f2e633a91d",
    );
  });

  test(
    "secret scanning rejects every credential family even in an untracked test file",
    { timeout: 15_000 },
    async () => {
      // The module is JavaScript because the same implementation runs directly under Node during packaging.
      // @ts-expect-error no declaration file is needed for the packaging script module
      const { scanPaths, scanWorktreeFiles } = (await import("../../../scripts/lib/secrets.mjs")) as {
        scanPaths(paths: string[], scope: string): Promise<void>;
        scanWorktreeFiles(): Promise<number>;
      };
      const families = [
        ["OpenAI API key", ["sk", "A".repeat(24)].join("-")],
        ["GitHub token", ["ghp", "B".repeat(24)].join("_")],
        ["GitHub token", ["github", "pat", "C".repeat(24)].join("_")],
        ["Slack token", ["xoxc", "D".repeat(24)].join("-")],
        ["AWS access key", ["ASIA", "E".repeat(16)].join("")],
        ["PEM private key", ["-----BEGIN", "PRIVATE KEY-----"].join(" ")],
        ["embedded authorization header", ["Authorization", `Basic ${"F".repeat(24)}`].join(": ")],
      ] as const;
      try {
        for (const [index, [label, synthetic]] of families.entries()) {
          await writeFile(secretSentinel, synthetic, "utf8");
          const scan = index === 0 ? scanWorktreeFiles() : scanPaths([secretSentinel], "worktree");
          await expect(scan).rejects.toThrow(label);
        }
      } finally {
        await rm(secretSentinel, { force: true });
      }
    },
  );

  test("accepts VSCE's separate extension ID and publisher identity fields", async () => {
    // @ts-expect-error no declaration file is needed for the packaging script module
    const { validateVsixManifestIdentity } = (await import("../../../scripts/lib/vsix.mjs")) as {
      validateVsixManifestIdentity(value: string): void;
    };
    const manifest = [
      '<Identity Language="en-US" Id="rbxforge" Version="0.1.0" Publisher="rbxforge" />',
      "<License>extension/LICENSE</License>",
      '<Asset Type="Details" Path="extension/README.md" />',
    ].join("\n");
    expect(() => validateVsixManifestIdentity(manifest)).not.toThrow();
    expect(() => validateVsixManifestIdentity(manifest.replace('Publisher="rbxforge"', 'Publisher="other"'))).toThrow(
      "expected identity",
    );
  });

  test("requires an OPC content type for every normalized archive part", async () => {
    // @ts-expect-error no declaration file is needed for the packaging script module
    const { validateVsixContentTypes } = (await import("../../../scripts/lib/vsix.mjs")) as {
      validateVsixContentTypes(value: string, entryNames: readonly string[]): Promise<void>;
    };
    const entries = [
      "[Content_Types].xml",
      "extension/package.json",
      "extension/LICENSE",
      "extension/THIRD_PARTY_NOTICES",
    ];
    const valid = [
      '<?xml version="1.0" encoding="utf-8"?>',
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
      '<Default Extension=".json" ContentType="application/json"/>',
      '<Default Extension=".txt" ContentType="text/plain"/>',
      '<Override PartName="/extension/LICENSE" ContentType="text/plain"/>',
      '<Override PartName="/extension/THIRD_PARTY_NOTICES" ContentType="text/plain"/>',
      "</Types>",
    ].join("");

    await expect(validateVsixContentTypes(valid, entries)).resolves.toBeUndefined();
    await expect(
      validateVsixContentTypes(
        valid.replace('<Override PartName="/extension/LICENSE" ContentType="text/plain"/>', ""),
        entries,
      ),
    ).rejects.toThrow("extension/LICENSE");
    await expect(
      validateVsixContentTypes(
        valid.replace(
          '<Override PartName="/extension/LICENSE" ContentType="text/plain"/>',
          '<Override PartName="/extension/LICENSE.txt" ContentType="text/plain"/>',
        ),
        entries,
      ),
    ).rejects.toThrow("stale LICENSE.txt");
  });
});
