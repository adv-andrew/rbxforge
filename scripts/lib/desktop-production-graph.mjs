const FORBIDDEN_GRAPH_MODULES = Object.freeze([
  {
    label: "@rbxforge/agent runtime",
    matches: (path) =>
      path === "@rbxforge/agent" ||
      path.startsWith("@rbxforge/agent/") ||
      /(?:^|\/)(?:packages\/agent|node_modules\/@rbxforge\/agent)(?:\/|$)/i.test(path),
  },
  {
    label: "OpenAI SDK runtime",
    matches: (path) =>
      path === "openai" ||
      path.startsWith("openai/") ||
      /(?:^|\/)node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?openai(?:\/|$)/i.test(path),
  },
  {
    label: "credential resolver runtime",
    matches: (path) =>
      /(?:^|\/)(?:ai[-_]?credentials?|credentials?[-_]?(?:provider|resolver|store))(?:\.[^/]*)?(?:\/|$)/i.test(path),
  },
]);

export function assertDesktopProductionGraph({ main, preload, renderer }) {
  const modules = [
    ...collectEsbuildModules("main", main),
    ...collectEsbuildModules("preload", preload),
    ...collectRendererModules(renderer),
  ];

  for (const { graph, path } of modules) {
    const normalized = normalizeModulePath(path);
    for (const rule of FORBIDDEN_GRAPH_MODULES) {
      if (rule.matches(normalized)) {
        throw new Error(`Desktop production graph retains forbidden ${rule.label} in ${graph}: ${normalized}`);
      }
    }
  }

  return Object.freeze(modules.map(({ graph, path }) => Object.freeze({ graph, path: normalizeModulePath(path) })));
}

function collectEsbuildModules(name, metafile) {
  if (metafile === null || typeof metafile !== "object" || Array.isArray(metafile)) {
    throw new Error(`Desktop ${name} production graph is invalid`);
  }
  const paths = new Set(Object.keys(metafile.inputs ?? {}));
  for (const output of Object.values(metafile.outputs ?? {})) {
    if (output === null || typeof output !== "object" || Array.isArray(output)) continue;
    for (const input of Object.keys(output.inputs ?? {})) paths.add(input);
    for (const imported of output.imports ?? []) {
      if (imported !== null && typeof imported === "object" && typeof imported.path === "string") {
        paths.add(imported.path);
      }
    }
  }
  return [...paths].sort().map((path) => ({ graph: name, path }));
}

function collectRendererModules(renderer) {
  if (!Array.isArray(renderer) || renderer.some((path) => typeof path !== "string")) {
    throw new Error("Desktop renderer production graph is invalid");
  }
  return [...new Set(renderer)].sort().map((path) => ({ graph: "renderer", path }));
}

function normalizeModulePath(path) {
  return path.replace(/^\0/, "").split("?")[0].replaceAll("\\", "/");
}
