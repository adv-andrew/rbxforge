import { lstat, readFile, readdir } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";

import { isTestOnlyDesktopPath } from "./desktop-fixture-boundary.mjs";
import { sha256 } from "./repository.mjs";

export const DESKTOP_RUNTIME_MANIFEST_FILE = "runtime-manifest.json";

const ALLOWED_RENDERER_EXTENSIONS = new Set([
  ".avif",
  ".css",
  ".html",
  ".ico",
  ".js",
  ".json",
  ".otf",
  ".png",
  ".svg",
  ".ttf",
  ".webp",
  ".woff",
  ".woff2",
]);
const FORBIDDEN_EXECUTABLE_EXTENSIONS = /\.(?:dylib|dll|exe|node|so|wasm)$/i;

export async function createDesktopRuntimeManifest(distRoot) {
  const files = [];
  for (const directory of ["main", "preload", "renderer"]) {
    files.push(...(await walkRuntimeFiles(distRoot, resolve(distRoot, directory))));
  }
  const paths = files.map(({ path }) => path);
  assertRuntimeLayout(paths);
  const entries = [];
  for (const { absolutePath, bytes, path } of files.sort((left, right) => left.path.localeCompare(right.path))) {
    entries.push(
      Object.freeze({
        path: `dist/${path}`,
        bytes,
        sha256: sha256(await readFile(absolutePath)),
      }),
    );
  }
  return Object.freeze({
    schemaVersion: 1,
    files: Object.freeze(entries),
  });
}

export function parseDesktopRuntimeManifest(value) {
  const parsed = typeof value === "string" || Buffer.isBuffer(value) ? JSON.parse(value.toString("utf8")) : value;
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    parsed.schemaVersion !== 1 ||
    !Array.isArray(parsed.files)
  ) {
    throw new Error("Desktop runtime manifest schema is invalid.");
  }
  const entries = parsed.files.map((entry) => {
    if (
      entry === null ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      typeof entry.path !== "string" ||
      !entry.path.startsWith("dist/") ||
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes < 0 ||
      typeof entry.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(entry.sha256)
    ) {
      throw new Error("Desktop runtime manifest entry is invalid.");
    }
    return Object.freeze({ path: entry.path, bytes: entry.bytes, sha256: entry.sha256 });
  });
  const paths = entries.map(({ path }) => path);
  if (
    new Set(paths).size !== paths.length ||
    JSON.stringify(paths) !== JSON.stringify([...paths].sort((left, right) => left.localeCompare(right)))
  ) {
    throw new Error("Desktop runtime manifest paths must be unique and sorted.");
  }
  assertRuntimeLayout(paths.map((path) => path.slice("dist/".length)));
  return Object.freeze({ schemaVersion: 1, files: Object.freeze(entries) });
}

export function formatDesktopRuntimeManifest(manifest) {
  return `${JSON.stringify(parseDesktopRuntimeManifest(manifest), undefined, 2)}\n`;
}

export async function assertDesktopRuntimeMatchesManifest(distRoot, expectedValue) {
  const expected = parseDesktopRuntimeManifest(expectedValue);
  const actual = await createDesktopRuntimeManifest(distRoot);
  const expectedByPath = new Map(expected.files.map((entry) => [entry.path, entry]));
  const actualByPath = new Map(actual.files.map((entry) => [entry.path, entry]));
  const missing = expected.files.filter(({ path }) => !actualByPath.has(path)).map(({ path }) => path);
  const unexpected = actual.files.filter(({ path }) => !expectedByPath.has(path)).map(({ path }) => path);
  const changed = actual.files
    .filter(({ path, bytes, sha256: digest }) => {
      const expectedEntry = expectedByPath.get(path);
      return expectedEntry !== undefined && (expectedEntry.bytes !== bytes || expectedEntry.sha256 !== digest);
    })
    .map(({ path }) => path);
  if (missing.length > 0 || unexpected.length > 0 || changed.length > 0) {
    throw new Error(
      `Desktop runtime inventory mismatch; missing=[${missing.join(", ")}] ` +
        `unexpected=[${unexpected.join(", ")}] changed=[${changed.join(", ")}]`,
    );
  }
  return actual;
}

function assertRuntimeLayout(paths) {
  const main = paths.filter((path) => path.startsWith("main/"));
  if (JSON.stringify(main) !== JSON.stringify(["main/index.cjs"])) {
    throw new Error(`Desktop runtime main inventory must contain only main/index.cjs; got=[${main.join(", ")}]`);
  }
  const preload = paths.filter((path) => path.startsWith("preload/"));
  if (JSON.stringify(preload) !== JSON.stringify(["preload/index.cjs"])) {
    throw new Error(
      `Desktop runtime preload inventory must contain only preload/index.cjs; got=[${preload.join(", ")}]`,
    );
  }
  const renderer = paths.filter((path) => path.startsWith("renderer/"));
  if (!renderer.includes("renderer/index.html") || renderer.some((path) => !isAllowedRendererPath(path))) {
    throw new Error(`Desktop runtime renderer inventory is invalid: ${renderer.join(", ")}`);
  }
  if (paths.some((path) => !/^(?:main|preload|renderer)\//.test(path))) {
    throw new Error("Desktop runtime manifest contains a path outside its closed roots.");
  }
}

function isAllowedRendererPath(path) {
  if (path === "renderer/index.html") return true;
  return (
    /^renderer\/assets\/[^/]+$/.test(path) &&
    !isTestOnlyDesktopPath(path) &&
    ALLOWED_RENDERER_EXTENSIONS.has(extname(path).toLowerCase())
  );
}

async function walkRuntimeFiles(root, current) {
  const files = [];
  for (const name of (await readdir(current)).sort((left, right) => left.localeCompare(right))) {
    const absolutePath = resolve(current, name);
    const info = await lstat(absolutePath);
    const path = relative(root, absolutePath).split("\\").join("/");
    if (isTestOnlyDesktopPath(path)) {
      throw new Error(`Desktop runtime inventory rejects test-only path: ${path}`);
    }
    if (info.isSymbolicLink()) throw new Error(`Desktop runtime inventory rejects symlink: ${path}`);
    if (info.isDirectory()) {
      files.push(...(await walkRuntimeFiles(root, absolutePath)));
    } else if (info.isFile()) {
      if ((info.mode & 0o111) !== 0 || FORBIDDEN_EXECUTABLE_EXTENSIONS.test(path)) {
        throw new Error(`Desktop runtime inventory rejects executable/native payload: ${path}`);
      }
      files.push({ absolutePath, bytes: info.size, path });
    } else {
      throw new Error(`Desktop runtime inventory rejects non-regular entry: ${path}`);
    }
  }
  return files;
}
