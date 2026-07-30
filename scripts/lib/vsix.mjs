import { createRequire } from "node:module";
import { createWriteStream } from "node:fs";
import { once } from "node:events";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

import { repositoryRoot, sha256 } from "./repository.mjs";

export const expectedVsixEntries = Object.freeze([
  "[Content_Types].xml",
  "extension.vsixmanifest",
  "extension/package.json",
  "extension/dist/extension.js",
  "extension/media/rbxforge.svg",
  "extension/media/rbxforge.png",
  "extension/media/webview/webview.js",
  "extension/media/webview/webview.css",
  "extension/vendor/package.json",
  "extension/vendor/robloxstudio-mcp/index.mjs",
  "extension/vendor/robloxstudio-mcp/assets/Baseplate.rbxl",
  "extension/vendor/studio-plugin/MCPPlugin.rbxmx",
  "extension/README.md",
  "extension/LICENSE",
  "extension/THIRD_PARTY_NOTICES",
]);

export async function normalizeVsixPaths(vsixPath) {
  const entries = await readZip(vsixPath);
  const require = createRequire(import.meta.url);
  const vsceRequire = createRequire(require.resolve("@vscode/vsce/vsce"));
  const { ZipFile } = vsceRequire("yazl");
  const archive = new ZipFile();
  const renamed = new Map([
    ["extension/LICENSE.txt", "extension/LICENSE"],
    ["extension/readme.md", "extension/README.md"],
  ]);
  for (const [sourceName, targetName] of renamed) {
    if (!entries.has(sourceName)) throw new Error(`VSCE archive is missing normalization source ${sourceName}`);
    if (entries.has(targetName)) throw new Error(`VSCE archive already contains normalization target ${targetName}`);
  }
  const normalizedNames = [...entries.keys()].map((name) => renamed.get(name) ?? name);
  const normalizedContentTypes = await addRequiredContentTypeOverrides(
    entries.get("[Content_Types].xml")?.bytes,
    normalizedNames,
  );
  for (const [sourceName, entry] of [...entries].sort(([left], [right]) => left.localeCompare(right))) {
    const targetName = renamed.get(sourceName) ?? sourceName;
    let bytes = entry.bytes;
    if (sourceName === "[Content_Types].xml") {
      bytes = normalizedContentTypes;
    } else if (sourceName === "extension.vsixmanifest") {
      const text = bytes
        .toString("utf8")
        .replaceAll("extension/LICENSE.txt", "extension/LICENSE")
        .replaceAll("extension/readme.md", "extension/README.md");
      if (text.includes("extension/LICENSE.txt") || text.includes("extension/readme.md")) {
        throw new Error("VSIX manifest path normalization was incomplete");
      }
      bytes = Buffer.from(text, "utf8");
    }
    archive.addBuffer(bytes, targetName, {
      compress: true,
      mode: 0o100644,
      mtime: new Date("1980-01-01T00:00:00.000Z"),
    });
  }
  const temporaryPath = `${vsixPath}.normalized`;
  await rm(temporaryPath, { force: true });
  const output = createWriteStream(temporaryPath, { flags: "wx", mode: 0o600 });
  const complete = once(output, "close");
  archive.outputStream.pipe(output);
  archive.end();
  await complete;
  await rename(temporaryPath, vsixPath);
}

export async function inspectVsix(vsixPath, { extractTo } = {}) {
  const entries = await readZip(vsixPath);
  const names = [...entries.keys()].sort((left, right) => left.localeCompare(right));
  const expected = [...expectedVsixEntries].sort((left, right) => left.localeCompare(right));
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    const missing = expected.filter((name) => !entries.has(name));
    const unexpected = names.filter((name) => !expectedVsixEntries.includes(name));
    throw new Error(`VSIX allowlist mismatch; missing=[${missing.join(", ")}] unexpected=[${unexpected.join(", ")}]`);
  }

  const extensionManifest = parseJsonEntry(entries, "extension/package.json");
  if (
    extensionManifest.name !== "rbxforge" ||
    extensionManifest.version !== "0.1.0" ||
    extensionManifest.publisher !== "rbxforge" ||
    extensionManifest.main !== "./dist/extension.js"
  ) {
    throw new Error("Packaged extension manifest identity is invalid");
  }
  const vsixManifest = entries.get("extension.vsixmanifest")?.bytes.toString("utf8");
  validateVsixManifestIdentity(vsixManifest);
  const contentTypes = entries.get("[Content_Types].xml")?.bytes.toString("utf8");
  await validateVsixContentTypes(contentTypes, names);
  const png = entries.get("extension/media/rbxforge.png")?.bytes;
  if (png === undefined || png.length < 24 || png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
    throw new Error("Marketplace icon is not a PNG");
  }
  if (png.readUInt32BE(16) < 128 || png.readUInt32BE(20) < 128) {
    throw new Error("Marketplace icon must be at least 128x128");
  }

  for (const [name, entry] of entries) {
    if (isForbiddenArchiveName(name)) throw new Error(`Forbidden VSIX entry: ${name}`);
    if (entry.symlink) throw new Error(`VSIX entry must not be a symlink: ${name}`);
    if (name.endsWith(".map") || entry.bytes.includes(Buffer.from('"sourcesContent"'))) {
      throw new Error(`Source map content is forbidden in the VSIX: ${name}`);
    }
  }

  if (extractTo !== undefined) {
    const absoluteExtractRoot = resolve(extractTo);
    if (!absoluteExtractRoot.startsWith(`${repositoryRoot}${sep}`)) {
      throw new Error(`Refusing to extract VSIX outside the repository: ${absoluteExtractRoot}`);
    }
    await rm(absoluteExtractRoot, { recursive: true, force: true });
    await mkdir(absoluteExtractRoot, { recursive: true });
    for (const [name, entry] of entries) {
      const output = resolve(absoluteExtractRoot, ...name.split("/"));
      if (!output.startsWith(`${absoluteExtractRoot}${sep}`)) throw new Error(`Unsafe VSIX path: ${name}`);
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, entry.bytes);
    }
  }

  return Object.freeze({
    entries: Object.freeze(
      names.map((name) => {
        const bytes = entries.get(name)?.bytes;
        if (bytes === undefined) throw new Error(`Lost VSIX entry during inspection: ${name}`);
        return Object.freeze({ path: name, bytes: bytes.length, sha256: sha256(bytes) });
      }),
    ),
    manifest: extensionManifest,
  });
}

export function validateVsixManifestIdentity(vsixManifest) {
  if (
    typeof vsixManifest !== "string" ||
    !vsixManifest.includes('Id="rbxforge"') ||
    !vsixManifest.includes('Publisher="rbxforge"') ||
    !vsixManifest.includes('Version="0.1.0"') ||
    !vsixManifest.includes("<License>extension/LICENSE</License>") ||
    !vsixManifest.includes('Path="extension/README.md"')
  ) {
    throw new Error("extension.vsixmanifest does not contain the expected identity and normalized assets");
  }
}

export async function validateVsixContentTypes(contentTypesXml, entryNames) {
  if (typeof contentTypesXml !== "string") {
    throw new Error("VSIX is missing [Content_Types].xml");
  }
  if (/\/?extension\/LICENSE\.txt/i.test(contentTypesXml)) {
    throw new Error("[Content_Types].xml contains a stale LICENSE.txt part reference");
  }

  const { defaults, overrides } = await parseContentTypes(contentTypesXml);
  if (overrides.get("/extension/LICENSE") !== "text/plain") {
    throw new Error("[Content_Types].xml must map extension/LICENSE to text/plain");
  }
  if (overrides.get("/extension/THIRD_PARTY_NOTICES") !== "text/plain") {
    throw new Error("[Content_Types].xml must map extension/THIRD_PARTY_NOTICES to text/plain");
  }

  for (const name of entryNames) {
    if (name === "[Content_Types].xml") continue;
    const partName = `/${name}`;
    if (overrides.has(partName)) continue;
    const basename = name.slice(name.lastIndexOf("/") + 1);
    const dot = basename.lastIndexOf(".");
    const extension = dot > 0 ? basename.slice(dot).toLowerCase() : undefined;
    if (extension === undefined || !defaults.has(extension)) {
      throw new Error(`[Content_Types].xml does not resolve archive part ${name}`);
    }
  }
}

async function addRequiredContentTypeOverrides(contentTypesBytes, entryNames) {
  if (contentTypesBytes === undefined) {
    throw new Error("VSCE archive is missing [Content_Types].xml");
  }
  let contentTypesXml = contentTypesBytes.toString("utf8");
  if (/\/?extension\/LICENSE\.txt/i.test(contentTypesXml)) {
    throw new Error("[Content_Types].xml contains a stale LICENSE.txt part reference");
  }

  const { overrides } = await parseContentTypes(contentTypesXml);
  const required = [
    ["/extension/LICENSE", "text/plain"],
    ["/extension/THIRD_PARTY_NOTICES", "text/plain"],
  ];
  for (const [partName, contentType] of required) {
    const existing = overrides.get(partName);
    if (existing !== undefined && existing !== contentType) {
      throw new Error(`[Content_Types].xml maps ${partName} to unexpected content type ${existing}`);
    }
    if (existing === undefined) {
      const closingTag = "</Types>";
      const closingIndex = contentTypesXml.lastIndexOf(closingTag);
      if (closingIndex < 0 || closingIndex !== contentTypesXml.indexOf(closingTag)) {
        throw new Error("[Content_Types].xml must contain exactly one closing Types tag");
      }
      const override = `<Override PartName="${partName}" ContentType="${contentType}"/>`;
      contentTypesXml = contentTypesXml.slice(0, closingIndex) + override + contentTypesXml.slice(closingIndex);
    }
  }

  await validateVsixContentTypes(contentTypesXml, entryNames);
  return Buffer.from(contentTypesXml, "utf8");
}

async function parseContentTypes(contentTypesXml) {
  const require = createRequire(import.meta.url);
  const vsceRequire = createRequire(require.resolve("@vscode/vsce/vsce"));
  const { parseStringPromise } = vsceRequire("xml2js");
  let parsed;
  try {
    parsed = await parseStringPromise(contentTypesXml, {
      explicitArray: true,
      explicitRoot: true,
    });
  } catch (error) {
    throw new Error(`Invalid [Content_Types].xml: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
  const root = parsed?.Types;
  if (root === undefined || root.$?.xmlns !== "http://schemas.openxmlformats.org/package/2006/content-types") {
    throw new Error("[Content_Types].xml has an invalid root or namespace");
  }

  const defaults = new Map();
  for (const item of root.Default ?? []) {
    const rawExtension = item.$?.Extension;
    const contentType = item.$?.ContentType;
    if (typeof rawExtension !== "string" || typeof contentType !== "string" || contentType.length === 0) {
      throw new Error("[Content_Types].xml contains an invalid Default mapping");
    }
    const extension = `${rawExtension.startsWith(".") ? "" : "."}${rawExtension}`.toLowerCase();
    if (defaults.has(extension)) {
      throw new Error(`[Content_Types].xml contains duplicate Default mapping ${extension}`);
    }
    defaults.set(extension, contentType);
  }

  const overrides = new Map();
  for (const item of root.Override ?? []) {
    const partName = item.$?.PartName;
    const contentType = item.$?.ContentType;
    if (
      typeof partName !== "string" ||
      !partName.startsWith("/") ||
      typeof contentType !== "string" ||
      contentType.length === 0
    ) {
      throw new Error("[Content_Types].xml contains an invalid Override mapping");
    }
    if (overrides.has(partName)) {
      throw new Error(`[Content_Types].xml contains duplicate Override mapping ${partName}`);
    }
    overrides.set(partName, contentType);
  }
  return { defaults, overrides };
}

async function readZip(vsixPath) {
  const require = createRequire(import.meta.url);
  const vsceRequire = createRequire(require.resolve("@vscode/vsce/vsce"));
  const yauzl = vsceRequire("yauzl");
  const zip = await new Promise((resolveZip, rejectZip) => {
    yauzl.open(vsixPath, { lazyEntries: true, validateEntrySizes: true }, (error, opened) => {
      if (error !== null) rejectZip(error);
      else resolveZip(opened);
    });
  });
  return await new Promise((resolveEntries, rejectEntries) => {
    const entries = new Map();
    const fail = (error) => {
      try {
        zip.close();
      } catch {
        // Preserve the original archive error.
      }
      rejectEntries(error);
    };
    zip.once("error", fail);
    zip.once("end", () => resolveEntries(entries));
    zip.on("entry", (entry) => {
      const name = entry.fileName;
      try {
        assertSafeArchivePath(name);
      } catch (error) {
        fail(error);
        return;
      }
      if (entries.has(name)) {
        fail(new Error(`Duplicate VSIX entry: ${name}`));
        return;
      }
      zip.openReadStream(entry, (error, stream) => {
        if (error !== null) {
          fail(error);
          return;
        }
        const chunks = [];
        stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        stream.once("error", fail);
        stream.once("end", () => {
          const mode = entry.externalFileAttributes >>> 16;
          entries.set(name, {
            bytes: Buffer.concat(chunks),
            symlink: (mode & 0o170000) === 0o120000,
          });
          zip.readEntry();
        });
      });
    });
    zip.readEntry();
  });
}

function assertSafeArchivePath(name) {
  const parts = name.split("/");
  if (
    name === "" ||
    name.startsWith("/") ||
    name.includes("\\") ||
    parts.some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`Unsafe VSIX path: ${name}`);
  }
}

function parseJsonEntry(entries, name) {
  const bytes = entries.get(name)?.bytes;
  if (bytes === undefined) throw new Error(`Missing VSIX JSON entry: ${name}`);
  return JSON.parse(bytes.toString("utf8"));
}

function isForbiddenArchiveName(name) {
  const lower = `/${name.toLowerCase()}`;
  return (
    /\/(?:src|test|tests|fixtures|node_modules|work|\.git)(?:\/|$)/.test(lower) ||
    /\.(?:ts|tsx|d\.ts|d\.mts|map|tsbuildinfo)$/i.test(name) ||
    /(?:^|\/)(?:tsconfig[^/]*\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|\.env(?:\..*)?|\.npmrc)$/i.test(
      name,
    ) ||
    /\/\.rbxforge\/credentials(?:\/|$)/i.test(lower)
  );
}
