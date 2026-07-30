import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { relative } from "node:path";
import { discoverRojoProjects, type RojoProject } from "@rbxforge/rojo";
import type { ProjectRecord, ThreadRecord } from "../../shared/domain.js";
import { ProjectRepository, type InsertProjectResult } from "../storage/project-repository.js";
import { captureProjectIdentity, readProjectConfig } from "./project-identity.js";

export type ProjectAddResult =
  | { readonly kind: "created"; readonly project: ProjectRecord; readonly thread: ThreadRecord }
  | { readonly kind: "existing"; readonly project: ProjectRecord }
  | {
      readonly kind: "candidates";
      readonly selectionId: string;
      readonly candidates: readonly {
        readonly candidateId: string;
        readonly displayName: string;
        readonly relativeProjectFile: string;
      }[];
    };

interface Selection {
  readonly expiresAt: number;
  readonly root: string;
  readonly candidates: ReadonlyMap<string, RojoProject>;
}

export class ProjectService {
  private readonly selections = new Map<string, Selection>();
  private readonly discover: typeof discoverRojoProjects;
  private readonly now: () => number;

  constructor(options: {
    readonly projects: ProjectRepository;
    readonly discover?: typeof discoverRojoProjects;
    readonly now?: () => number;
  }) {
    this.projects = options.projects;
    this.discover = options.discover ?? discoverRojoProjects;
    this.now = options.now ?? Date.now;
  }

  private readonly projects: ProjectRepository;

  async inspectRoot(rootPath: string): Promise<ProjectAddResult> {
    this.expireSelections();
    const root = realpathSync(rootPath);
    const discovered = await this.discover(root);
    if (discovered.length === 0) throw new Error("No valid Rojo project files were found in the selected root.");
    const existing = this.projects.findByCanonicalRoot(root);
    if (existing !== undefined) return { kind: "existing", project: existing };
    if (discovered.length === 1) return this.commitProject(root, discovered[0]!);
    const selectionId = randomUUID();
    const candidates = new Map<string, RojoProject>();
    const result = discovered.map((candidate) => {
      const candidateId = randomUUID();
      candidates.set(candidateId, candidate);
      return Object.freeze({
        candidateId,
        displayName: candidate.name,
        relativeProjectFile: relative(root, candidate.path),
      });
    });
    this.selections.set(selectionId, { expiresAt: this.now() + 5 * 60_000, root, candidates });
    return Object.freeze({ kind: "candidates", selectionId, candidates: Object.freeze(result) });
  }

  async commitCandidate(
    selectionId: string,
    candidateId: string,
  ): Promise<Extract<ProjectAddResult, { readonly kind: "created" | "existing" }>> {
    this.expireSelections();
    const selection = this.selections.get(selectionId);
    const candidate = selection?.candidates.get(candidateId);
    if (selection === undefined || candidate === undefined)
      throw new Error("Project selection is invalid, expired, or already used.");
    const result = this.commitProject(selection.root, candidate);
    this.selections.delete(selectionId);
    return result;
  }

  cancelCandidate(selectionId: string): void {
    this.selections.delete(selectionId);
  }

  private commitProject(root: string, candidate: RojoProject): InsertProjectResult {
    const identity = captureProjectIdentity({
      projectId: randomUUID(),
      rootPath: root,
      projectFilePath: candidate.path,
      revision: 1,
    });
    const config = readProjectConfig(identity);
    const now = this.now();
    const insert = this.projects.insertWithFirstThread({
      id: identity.projectId,
      displayName: config.displayName,
      canonicalRoot: identity.canonicalRoot,
      rootDevice: identity.rootDevice,
      rootInode: identity.rootInode,
      canonicalProjectFile: identity.canonicalProjectFile,
      projectFileDevice: identity.projectFileDevice,
      projectFileInode: identity.projectFileInode,
      configDigest: identity.configDigest,
      servePlaceIds: config.servePlaceIds,
      createdAt: now,
      updatedAt: now,
      lastOpenedAt: now,
    });
    return insert;
  }

  private expireSelections(): void {
    for (const [id, selection] of this.selections) if (selection.expiresAt <= this.now()) this.selections.delete(id);
  }
}
