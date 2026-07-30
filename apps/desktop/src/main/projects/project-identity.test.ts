import { chmod, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ProjectIdentityError,
  assertProjectIdentityCurrent,
  captureProjectIdentity,
  isPathWithin,
  readProjectConfig,
} from "./project-identity.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("project identity", () => {
  it("rejects a Windows sibling path outside the selected root", () => {
    expect(isPathWithin("C:\\games\\deepwater", "C:\\games\\outside\\default.project.json", win32)).toBe(false);
  });

  it("captures the selected file's canonical identity and exact byte digest", async () => {
    const root = await fixtureRoot({ name: "Deepwater", servePlaceIds: [1_537_690_962] });
    const canonicalRoot = await realpath(root);
    const ref = captureProjectIdentity({
      projectId: "project-1",
      rootPath: root,
      projectFilePath: join(root, "default.project.json"),
      revision: 1,
    });

    expect(ref).toMatchObject({
      projectId: "project-1",
      canonicalRoot,
      canonicalProjectFile: join(canonicalRoot, "default.project.json"),
      revision: 1,
      configDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(ref.rootDevice).toMatch(/^\d+$/);
    expect(ref.rootInode).toMatch(/^\d+$/);
    expect(ref.projectFileInode).toMatch(/^\d+$/);
    expect(readProjectConfig(ref)).toEqual({ displayName: "Deepwater", servePlaceIds: [1_537_690_962] });
    expect(() => assertProjectIdentityCurrent(ref)).not.toThrow();
  });

  it("fails closed when the selected file is atomically replaced", async () => {
    const root = await fixtureRoot({ name: "Deepwater" });
    const projectFile = join(root, "default.project.json");
    const ref = captureProjectIdentity({
      projectId: "project-1",
      rootPath: root,
      projectFilePath: projectFile,
      revision: 1,
    });
    await writeFile(join(root, "replacement.json"), JSON.stringify({ name: "Other", tree: {} }));
    await rename(join(root, "replacement.json"), projectFile);

    expectIdentityFailure(() => assertProjectIdentityCurrent(ref), "inode-changed");
  });

  it("fails closed when the selected file bytes change without replacing its inode", async () => {
    const root = await fixtureRoot({ name: "Deepwater" });
    const projectFile = join(root, "default.project.json");
    const ref = captureProjectIdentity({
      projectId: "project-1",
      rootPath: root,
      projectFilePath: projectFile,
      revision: 1,
    });
    await writeFile(projectFile, JSON.stringify({ name: "Changed", tree: {} }));

    expectIdentityFailure(() => assertProjectIdentityCurrent(ref), "digest-changed");
  });

  it("rejects a symlink replacement even when the target bytes are identical", async () => {
    const root = await fixtureRoot({ name: "Deepwater" });
    const projectFile = join(root, "default.project.json");
    const copy = join(root, "copy.project.json");
    await writeFile(copy, await readFile(projectFile));
    const ref = captureProjectIdentity({
      projectId: "project-1",
      rootPath: root,
      projectFilePath: projectFile,
      revision: 1,
    });
    await rm(projectFile);
    await symlink(copy, projectFile);

    expectIdentityFailure(() => assertProjectIdentityCurrent(ref), "symlink");
  });

  it("rejects a deleted selected file and a replaced root", async () => {
    const root = await fixtureRoot({ name: "Deepwater" });
    const projectFile = join(root, "default.project.json");
    const ref = captureProjectIdentity({
      projectId: "project-1",
      rootPath: root,
      projectFilePath: projectFile,
      revision: 1,
    });
    await rm(projectFile);
    expectIdentityFailure(() => assertProjectIdentityCurrent(ref), "missing");

    await writeFile(projectFile, JSON.stringify({ name: "Deepwater", tree: {} }));
    await rm(root, { recursive: true });
    expectIdentityFailure(() => assertProjectIdentityCurrent(ref), "missing");
  });

  it("refuses a project file outside the selected root", async () => {
    const root = await fixtureRoot({ name: "Deepwater" });
    const elsewhere = await fixtureRoot({ name: "Elsewhere" });

    expectIdentityFailure(
      () =>
        captureProjectIdentity({
          projectId: "project-1",
          rootPath: root,
          projectFilePath: join(elsewhere, "default.project.json"),
          revision: 1,
        }),
      "outside-root",
    );
  });

  it("parses JSONC config and preserves zero or more serve place ids", async () => {
    const root = await fixtureRoot({
      source: '{ // allowed\n "name": "Commented", "servePlaceIds": [], "tree": {}, }',
    });
    const ref = captureProjectIdentity({
      projectId: "project-1",
      rootPath: root,
      projectFilePath: join(root, "default.project.json"),
      revision: 1,
    });
    expect(readProjectConfig(ref)).toEqual({ displayName: "Commented", servePlaceIds: [] });
  });

  it("rejects malformed JSONC instead of inventing project config", async () => {
    const root = await fixtureRoot({ source: '{ "name": "Nope", ' });
    const ref = captureProjectIdentity({
      projectId: "project-1",
      rootPath: root,
      projectFilePath: join(root, "default.project.json"),
      revision: 1,
    });

    expectIdentityFailure(() => readProjectConfig(ref), "digest-changed");
  });

  it("reports unreadable files on platforms where permissions are enforced", async () => {
    if (process.platform === "win32") return;
    const root = await fixtureRoot({ name: "Deepwater" });
    const projectFile = join(root, "default.project.json");
    const ref = captureProjectIdentity({
      projectId: "project-1",
      rootPath: root,
      projectFilePath: projectFile,
      revision: 1,
    });
    await chmod(projectFile, 0);
    try {
      try {
        await readFile(projectFile);
      } catch {
        expectIdentityFailure(() => assertProjectIdentityCurrent(ref), "unreadable");
      }
    } finally {
      await chmod(projectFile, 0o600);
    }
  });
});

function expectIdentityFailure(action: () => unknown, code: ProjectIdentityError["code"]): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(ProjectIdentityError);
    expect((error as ProjectIdentityError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code} identity failure`);
}

async function fixtureRoot(input: {
  readonly name?: string;
  readonly servePlaceIds?: readonly number[];
  readonly source?: string;
}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rbxforge-project-"));
  roots.push(root);
  await writeFile(
    join(root, "default.project.json"),
    input.source ??
      JSON.stringify({ name: input.name ?? "Deepwater", servePlaceIds: input.servePlaceIds ?? [], tree: {} }),
  );
  return root;
}
