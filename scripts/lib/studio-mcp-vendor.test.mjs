import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  AUDITED_STUDIO_MCP,
  auditStudioMcp,
  bundleAuditedStudioMcp,
  resolveAuditedStudioMcp,
} from "./studio-mcp-vendor.mjs";

const desktopPackageJson = fileURLToPath(new URL("../../apps/desktop/package.json", import.meta.url));
const extensionPackageJson = fileURLToPath(new URL("../../apps/extension/package.json", import.meta.url));

test("the shared vendor descriptor pins every audited upstream byte", () => {
  assert.deepEqual(AUDITED_STUDIO_MCP, {
    version: "2.22.5",
    entry: {
      relative: "dist/index.js",
      bytes: 622_265,
      sha256: "b4558aef4a299c4253b982ad2da88e8944de7cf59a192c485857cc390623a10f",
    },
    baseplate: {
      relative: "dist/assets/Baseplate.rbxl",
      bytes: 60_225,
      sha256: "9e576d8eac106d53be6b56a484c528b928f39725170f990c3a0387e86a8dd546",
    },
    plugin: {
      relative: "studio-plugin/MCPPlugin.rbxmx",
      bytes: 5_396_699,
      sha256: "57f16e4e89f4e60d327fa76c89fc44e85a16d8a7051579d38ec0ee7501cad09c",
    },
    license: {
      relative: "licenses/chrrxs-robloxstudio-mcp-LICENSE.txt",
      bytes: 1_055,
      sha256: "3bed3331b7048bac17cf50e249d560ccc9508c970da8d7b9283bf4f2e633a91d",
    },
  });
});

test("the shared vendor audit rejects any changed upstream byte", async () => {
  const resolved = await resolveAuditedStudioMcp(desktopPackageJson);
  const temporaryRoot = await mkdtemp(join(tmpdir(), "rbxforge-vendor-audit-"));
  try {
    const changedEntry = join(temporaryRoot, "index.js");
    await copyFile(resolved.entry, changedEntry);
    const bytes = await readFile(changedEntry);
    bytes[0] = bytes[0] ^ 1;
    await writeFile(changedEntry, bytes);

    await assert.rejects(
      auditStudioMcp({
        entry: changedEntry,
        baseplate: resolved.baseplate,
        plugin: resolved.plugin,
        license: resolved.license,
      }),
      /Studio MCP entry.*SHA-256/i,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("the shared bundler emits only the audited runtime layout and metadata", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "rbxforge-vendor-bundle-"));
  try {
    const outputRoot = join(temporaryRoot, "vendor");
    const metadataPath = join(temporaryRoot, "studio-mcp.json");
    const result = await bundleAuditedStudioMcp({
      packageJsonPath: desktopPackageJson,
      outputRoot,
      metadataPath,
      target: "node24",
      inlineVersion: true,
    });

    assert.equal(result.version, "2.22.5");
    assert.deepEqual(result.files, [
      "robloxstudio-mcp/assets/Baseplate.rbxl",
      "robloxstudio-mcp/index.mjs",
      "studio-plugin/MCPPlugin.rbxmx",
    ]);
    const bundledEntry = await readFile(join(outputRoot, "robloxstudio-mcp/index.mjs"), "utf8");
    assert.doesNotMatch(bundledEntry, /require\w*\(["']\.\.\/package\.json["']\)/);
    assert.match(bundledEntry, /(?:version: VERSION|version: "2\.22\.5")/);
    assert.equal(JSON.parse(await readFile(metadataPath, "utf8")).outputs !== undefined, true);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("the legacy Node 20 bundle remains byte-identical when desktop version inlining is disabled", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "rbxforge-legacy-vendor-parity-"));
  try {
    const outputRoot = join(temporaryRoot, "vendor");
    await bundleAuditedStudioMcp({
      packageJsonPath: extensionPackageJson,
      outputRoot,
      metadataPath: join(temporaryRoot, "studio-mcp.json"),
      target: "node20",
      inlineVersion: false,
    });

    const bytes = await readFile(join(outputRoot, "robloxstudio-mcp/index.mjs"));
    assert.equal(bytes.length, 2_537_534);
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      "607fca3d3c71c63bda4f51082e53398debf2d1c51d554f511ae45c3751aa1af4",
    );
    assert.match(bytes.toString("utf8"), /\.\.\/package\.json/);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
