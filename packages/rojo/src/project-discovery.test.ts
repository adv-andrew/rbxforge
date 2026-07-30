import { mkdtemp, mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverRojoProjects } from "./project-discovery.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => {
      await import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true }));
    }),
  );
});

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rbxforge-rojo-"));
  temporaryRoots.push(root);
  return root;
}

describe("discoverRojoProjects", () => {
  it("discovers sorted canonical project files while skipping generated and symlinked directories", async () => {
    const root = await fixtureRoot();
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(join(root, "node_modules", "hidden"), { recursive: true });
    await mkdir(join(root, ".git", "hidden"), { recursive: true });
    await mkdir(join(root, ".worktrees", "hidden"), { recursive: true });
    await mkdir(join(root, ".rbxforge", "hidden"), { recursive: true });
    await writeFile(join(root, "src", "z.project.json"), '{ "name": "Z", "tree": {} }');
    await writeFile(join(root, "a.project.json"), '{ "name": "A", "tree": {} }');
    await writeFile(join(root, "node_modules", "hidden", "bad.project.json"), '{ "name": "bad" }');
    await writeFile(join(root, ".git", "hidden", "bad.project.json"), '{ "name": "bad" }');
    await writeFile(join(root, ".worktrees", "hidden", "bad.project.json"), '{ "name": "bad" }');
    await writeFile(join(root, ".rbxforge", "hidden", "bad.project.json"), '{ "name": "bad" }');
    await symlink(join(root, "src"), join(root, "linked-src"));

    const projects = await discoverRojoProjects(root);
    const canonicalRoot = await realpath(root);

    expect(projects.map((project) => project.path)).toEqual([
      join(canonicalRoot, "a.project.json"),
      join(canonicalRoot, "src", "z.project.json"),
    ]);
    expect(Object.isFrozen(projects)).toBe(true);
    expect(Object.isFrozen(projects[0])).toBe(true);
  });

  it("parses comments and trailing commas and derives local unknown-instance safety", async () => {
    const root = await fixtureRoot();
    const projectPath = join(root, "game.project.jsonc");
    await writeFile(
      projectPath,
      `{
      // Comment proves JSONC parsing rather than JSON.parse.
      "name": "Game",
      "servePlaceIds": [123, 456,],
      "tree": {
        "$className": "DataModel",
        "Workspace": { "$ignoreUnknownInstances": false, },
        "Door.Hinge": {},
        "Direct": {},
        "Imported": { "$path": "src", },
      },
    }`,
    );

    const [project] = await discoverRojoProjects(root);

    expect(project?.servePlaceIds).toEqual([123, 456]);
    expect(project?.safety).toEqual([
      { path: "game", unknownInstances: "unsafe" },
      { path: "game.Direct", unknownInstances: "unsafe" },
      { path: "game.Imported", unknownInstances: "unknown" },
      { path: "game.Workspace", unknownInstances: "safe" },
      { path: 'game["Door.Hinge"]', unknownInstances: "unsafe" },
    ]);
  });

  it("retains typed diagnostics for malformed candidates while continuing the scan", async () => {
    const root = await fixtureRoot();
    await writeFile(join(root, "broken.project.json"), '{ "name": 7, ');
    await writeFile(join(root, "invalid.project.json"), '{ "tree": [] }');
    await writeFile(join(root, "invalid-place.project.json"), '{ "tree": {}, "servePlaceIds": [-1] }');
    await writeFile(join(root, "valid.project.json"), '{ "name": "Valid", "tree": {} }');

    const projects = await discoverRojoProjects(root);
    const canonicalRoot = await realpath(root);

    expect(projects.map((project) => project.name)).toEqual(["Valid"]);
    expect(projects.diagnostics).toEqual([
      expect.objectContaining({ path: join(canonicalRoot, "broken.project.json"), code: "parse-error" }),
      expect.objectContaining({ path: join(canonicalRoot, "invalid-place.project.json"), code: "invalid-shape" }),
      expect.objectContaining({ path: join(canonicalRoot, "invalid.project.json"), code: "invalid-shape" }),
    ]);
  });
});
