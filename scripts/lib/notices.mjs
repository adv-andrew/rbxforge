import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

import { repositoryRoot, sha256 } from "./repository.mjs";

const firstPartyRoots = [
  resolve(repositoryRoot, "apps"),
  resolve(repositoryRoot, "packages"),
  resolve(repositoryRoot, "scripts"),
];
const specialLicenses = new Map([
  ["@chrrxs/robloxstudio-mcp", resolve(repositoryRoot, "licenses/chrrxs-robloxstudio-mcp-LICENSE.txt")],
]);

export async function generateThirdPartyNotices(options) {
  const {
    bundles = legacyBundles(options),
    additionalPackageRoots = [],
    requiredPackages = ["@chrrxs/robloxstudio-mcp", "@modelcontextprotocol/sdk", "openai", "react", "zod"],
  } = options;
  const inventories = new Map();
  for (const bundle of bundles) {
    if (
      bundle === null ||
      typeof bundle !== "object" ||
      typeof bundle.name !== "string" ||
      (typeof bundle.metafilePath !== "string") === (typeof bundle.viteInventoryPath !== "string")
    ) {
      throw new Error("Third-party bundle descriptor is invalid");
    }
    if (typeof bundle.metafilePath === "string") {
      await addEsbuildInventory(inventories, bundle.name, bundle.metafilePath);
    } else {
      const modules = JSON.parse(await readFile(bundle.viteInventoryPath, "utf8"));
      if (!Array.isArray(modules) || modules.some((value) => typeof value !== "string")) {
        throw new Error("Vite/Rollup module inventory is invalid");
      }
      for (const modulePath of modules) await addInput(inventories, bundle.name, modulePath);
    }
  }
  for (const packageRoot of additionalPackageRoots) {
    await addPackageRoot(inventories, "additional-runtime", packageRoot);
  }

  const records = [];
  for (const record of [...inventories.values()].sort((left, right) => left.key.localeCompare(right.key))) {
    const descriptor = JSON.parse(await readFile(resolve(record.root, "package.json"), "utf8"));
    const license = normalizeLicense(descriptor.license);
    if (license === undefined || /unknown|unlicensed|see license in/i.test(license)) {
      throw new Error(`Unknown or unsupported license metadata for ${record.key}`);
    }
    const licenseBytes = await readExactLicense(record);
    if (licenseBytes === undefined) {
      throw new Error(`Missing license text for bundled dependency ${record.key}`);
    }
    if (
      record.name === "@chrrxs/robloxstudio-mcp" &&
      sha256(licenseBytes) !== "3bed3331b7048bac17cf50e249d560ccc9508c970da8d7b9283bf4f2e633a91d"
    ) {
      throw new Error("Audited @chrrxs/robloxstudio-mcp license copy changed");
    }
    records.push({
      ...record,
      license,
      licenseText: licenseBytes.toString("utf8").trimEnd(),
      licenseSha256: sha256(licenseBytes),
      source: packageSource(descriptor),
    });
  }
  for (const required of requiredPackages) {
    if (!records.some(({ name }) => name === required)) {
      throw new Error(`Required bundled dependency is absent from notices: ${required}`);
    }
  }

  const sections = records.map((record) =>
    [
      "================================================================================",
      `${record.name}@${record.version}`,
      `Bundles: ${[...record.bundles].sort().join(", ")}`,
      `Declared license: ${record.license}`,
      ...(record.source === undefined ? [] : [`Source: ${record.source}`]),
      `License text SHA-256: ${record.licenseSha256}`,
      "",
      record.licenseText,
      "",
    ].join("\n"),
  );
  const text = [
    "RbxForge Third-Party Notices",
    "",
    "This file is generated from the retained esbuild and Vite/Rollup bundle inventories.",
    "RbxForge itself is UNLICENSED; the notices below apply only to named third-party components.",
    "",
    ...sections,
  ].join("\n");
  return {
    text: `${text.trimEnd()}\n`,
    packages: records.map(({ key, bundles, license, licenseSha256 }) => ({
      package: key,
      bundles: [...bundles].sort(),
      license,
      licenseSha256,
    })),
  };
}

function legacyBundles(options) {
  return [
    { name: "extension-host", metafilePath: options.extensionMetafilePath },
    { name: "studio-mcp", metafilePath: options.studioMetafilePath },
    { name: "webview", viteInventoryPath: options.webviewInventoryPath },
  ];
}

async function addEsbuildInventory(inventories, bundle, metafilePath) {
  const metafile = JSON.parse(await readFile(metafilePath, "utf8"));
  const retained = new Set();
  for (const output of Object.values(metafile.outputs ?? {})) {
    for (const [input, detail] of Object.entries(output.inputs ?? {})) {
      if (typeof detail.bytesInOutput === "number" && detail.bytesInOutput > 0) retained.add(input);
    }
  }
  for (const input of retained) await addInput(inventories, bundle, input);
}

async function addInput(inventories, bundle, rawPath) {
  const cleaned = rawPath.replace(/^\0/, "").split("?")[0];
  if (cleaned === "" || cleaned.startsWith("<")) return;
  const absolute = isAbsolute(cleaned) ? cleaned : resolve(repositoryRoot, cleaned);
  if (firstPartyRoots.some((root) => absolute === root || absolute.startsWith(`${root}/`))) return;
  const packageRoot = await findPackageRoot(absolute);
  if (packageRoot === undefined) {
    if (absolute.startsWith(`${repositoryRoot}/`)) return;
    throw new Error(`Could not map retained bundle input to a package: ${rawPath}`);
  }
  await addPackageRoot(inventories, bundle, packageRoot, rawPath);
}

async function addPackageRoot(inventories, bundle, packageRoot, rawPath = packageRoot) {
  const descriptor = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8"));
  if (typeof descriptor.name !== "string" || typeof descriptor.version !== "string") {
    throw new Error(`Invalid package metadata for retained input: ${rawPath}`);
  }
  if (descriptor.name.startsWith("@rbxforge/") || descriptor.name === "rbxforge") return;
  const key = `${descriptor.name}@${descriptor.version}`;
  const existing = inventories.get(key);
  if (existing === undefined) {
    inventories.set(key, {
      key,
      name: descriptor.name,
      version: descriptor.version,
      root: packageRoot,
      bundles: new Set([bundle]),
    });
  } else {
    existing.bundles.add(bundle);
  }
}

async function findPackageRoot(inputPath) {
  let current;
  try {
    const info = await stat(inputPath);
    current = info.isDirectory() ? inputPath : dirname(inputPath);
  } catch {
    return undefined;
  }
  const resolvedRepositoryRoot = await realpath(repositoryRoot);
  while (current !== dirname(current)) {
    try {
      const descriptor = JSON.parse(await readFile(resolve(current, "package.json"), "utf8"));
      if (typeof descriptor.name === "string" && typeof descriptor.version === "string") return current;
    } catch {
      // Keep walking toward the package boundary.
    }
    if (current === resolvedRepositoryRoot) return undefined;
    current = dirname(current);
  }
  return undefined;
}

async function discoverLicense(packageRoot) {
  const entries = await readdir(packageRoot);
  const candidate = entries
    .filter((name) => /^(licen[cs]e|copying|notice)(?:\..+)?$/i.test(name))
    .sort((left, right) => left.localeCompare(right))[0];
  return candidate === undefined ? undefined : resolve(packageRoot, candidate);
}

async function readExactLicense(record) {
  const special = specialLicenses.get(record.name);
  const licensePath = special ?? (await discoverLicense(record.root));
  if (licensePath !== undefined) {
    return Buffer.from(normalizeNewlines(await readFile(licensePath, "utf8")), "utf8");
  }
  const entries = await readdir(record.root);
  const readme = entries
    .filter((name) => /^readme(?:\..+)?$/i.test(name))
    .sort((left, right) => left.localeCompare(right))[0];
  if (readme === undefined) return undefined;
  const content = normalizeNewlines(await readFile(resolve(record.root, readme), "utf8"));
  const match = /^#{1,3}\s+licen[cs]e\s*$/im.exec(content);
  if (match === null) return undefined;
  const remainder = content.slice(match.index + match[0].length).replace(/^\n+/, "");
  const nextHeading = /^#{1,3}\s+/m.exec(remainder);
  const exactSection = (nextHeading === null ? remainder : remainder.slice(0, nextHeading.index)).trimEnd();
  return exactSection.length >= 200 ? Buffer.from(exactSection, "utf8") : undefined;
}

function normalizeLicense(value) {
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  if (value !== null && typeof value === "object" && typeof value.type === "string") {
    return value.type.trim();
  }
  return undefined;
}

function packageSource(descriptor) {
  if (typeof descriptor.repository === "string") return descriptor.repository;
  if (
    descriptor.repository !== null &&
    typeof descriptor.repository === "object" &&
    typeof descriptor.repository.url === "string"
  ) {
    return descriptor.repository.url;
  }
  return typeof descriptor.homepage === "string" ? descriptor.homepage : undefined;
}

function normalizeNewlines(value) {
  return value.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}
