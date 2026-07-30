import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDesktopDatabase } from "../storage/database.js";
import { runMigrations } from "../storage/migrations.js";
import { ProjectRepository } from "../storage/project-repository.js";
import { ProjectService } from "./project-service.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("ProjectService", () => {
  it("rejects an empty root without persisting a partial project", async () => {
    const root = await mkdtemp(join(tmpdir(), "rbxforge-empty-service-"));
    roots.push(root);
    const database = openDesktopDatabase(join(root, "desktop.sqlite"));
    runMigrations(database);
    const projects = new ProjectRepository(database);
    const service = new ProjectService({ projects });

    await expect(service.inspectRoot(root)).rejects.toThrow(/No valid Rojo project/i);
    expect(projects.list()).toEqual([]);
    database.close();
  });

  it("creates one project and its first thread only after an unambiguous discovery", async () => {
    const root = await fixtureRoot("default.project.json", { name: "Deepwater", servePlaceIds: [1_537_690_962] });
    const database = openDesktopDatabase(join(root, "desktop.sqlite"));
    runMigrations(database);
    const service = new ProjectService({ projects: new ProjectRepository(database) });

    const result = await service.inspectRoot(root);

    expect(result.kind).toBe("created");
    if (result.kind === "created") {
      expect(result.project).toMatchObject({
        displayName: "Deepwater",
        servePlaceIds: [1_537_690_962],
        canonicalRoot: await realpath(root),
      });
      expect(result.thread.projectId).toBe(result.project.id);
    }
    database.close();
  });

  it("keeps multi-candidate paths private until an opaque candidate is committed", async () => {
    const root = await fixtureRoot("one.project.json", { name: "One" });
    await writeFile(join(root, "two.project.json"), JSON.stringify({ name: "Two", tree: {} }));
    const database = openDesktopDatabase(join(root, "desktop.sqlite"));
    runMigrations(database);
    const service = new ProjectService({ projects: new ProjectRepository(database) });
    const choice = await service.inspectRoot(root);

    expect(choice.kind).toBe("candidates");
    if (choice.kind !== "candidates") throw new Error("expected candidates");
    expect(choice.candidates).toEqual([
      expect.objectContaining({ displayName: "One", relativeProjectFile: "one.project.json" }),
      expect.objectContaining({ displayName: "Two", relativeProjectFile: "two.project.json" }),
    ]);
    const committed = service.commitCandidate(choice.selectionId, choice.candidates[0]!.candidateId);
    await expect(committed).resolves.toMatchObject({ kind: "created", project: { displayName: "One" } });
    await expect(service.commitCandidate(choice.selectionId, choice.candidates[1]!.candidateId)).rejects.toThrow(
      /selection/i,
    );
    database.close();
  });

  it("returns the winning existing project when another selection commits first", async () => {
    const root = await fixtureRoot("one.project.json", { name: "One" });
    await writeFile(join(root, "two.project.json"), JSON.stringify({ name: "Two", tree: {} }));
    const database = openDesktopDatabase(join(root, "desktop.sqlite"));
    runMigrations(database);
    const projects = new ProjectRepository(database);
    const firstService = new ProjectService({ projects });
    const secondService = new ProjectService({ projects });
    const firstChoice = await firstService.inspectRoot(root);
    const secondChoice = await secondService.inspectRoot(root);
    if (firstChoice.kind !== "candidates" || secondChoice.kind !== "candidates") throw new Error("expected candidates");
    const firstOne = firstChoice.candidates.find((candidate) => candidate.displayName === "One");
    const secondOne = secondChoice.candidates.find((candidate) => candidate.displayName === "One");
    if (firstOne === undefined || secondOne === undefined) throw new Error("expected One candidates");

    const winning = await secondService.commitCandidate(secondChoice.selectionId, secondOne.candidateId);
    const raced = await firstService.commitCandidate(firstChoice.selectionId, firstOne.candidateId);

    expect(winning.kind).toBe("created");
    expect(raced).toEqual({ kind: "existing", project: winning.project });
    expect(projects.list()).toEqual([winning.project]);
    await expect(firstService.commitCandidate(firstChoice.selectionId, firstOne.candidateId)).rejects.toThrow(
      /selection/i,
    );
    database.close();
  });

  it("cancels a candidate selection without creating a partial row", async () => {
    const root = await fixtureRoot("one.project.json", { name: "One" });
    await writeFile(join(root, "two.project.json"), JSON.stringify({ name: "Two", tree: {} }));
    const database = openDesktopDatabase(join(root, "desktop.sqlite"));
    runMigrations(database);
    const projects = new ProjectRepository(database);
    const service = new ProjectService({ projects });
    const choice = await service.inspectRoot(root);
    if (choice.kind !== "candidates") throw new Error("expected candidates");

    service.cancelCandidate(choice.selectionId);

    await expect(service.commitCandidate(choice.selectionId, choice.candidates[0]!.candidateId)).rejects.toThrow(
      /selection/i,
    );
    expect(projects.list()).toEqual([]);
    database.close();
  });
});

async function fixtureRoot(
  filename: string,
  project: { readonly name: string; readonly servePlaceIds?: readonly number[] },
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rbxforge-service-"));
  roots.push(root);
  await writeFile(join(root, filename), JSON.stringify({ ...project, tree: {} }));
  return root;
}
