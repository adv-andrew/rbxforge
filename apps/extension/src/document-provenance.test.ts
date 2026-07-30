import { createHash } from "node:crypto";
import { mkdtemp, realpath, rename, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as Agent from "@rbxforge/agent";
import { describe, expect, test } from "vitest";

import * as Provenance from "./document-provenance.js";
import type { EventPort } from "./vscode-facade.js";

interface Document {
  readonly uri: {
    readonly scheme: string;
    readonly fsPath: string;
    toString(): string;
  };
  version: number;
  isDirty: boolean;
  text: string;
  getText(): string;
}

interface Registry {
  attest(document: Document): object | undefined;
  dispose(): void;
}

interface RegistryConstructor {
  new (
    options: Readonly<{
      documents(): readonly Document[];
      onDidOpen: EventPort<Document>;
      onDidChange: EventPort<Readonly<{ document: Document }>>;
      onDidSave: EventPort<Document>;
      onDidClose: EventPort<Document>;
      onDidRename: EventPort<Readonly<{ oldPath: string; newPath: string }>>;
      onDidFileChange: EventPort<string>;
    }>,
  ): Registry;
}

class Emitter<T> {
  readonly #listeners = new Set<(value: T) => void>();
  constructor(
    readonly name: string,
    readonly order: string[],
  ) {}
  readonly event: EventPort<T> = (listener) => {
    this.order.push(`subscribe:${this.name}`);
    this.#listeners.add(listener);
    return {
      dispose: () => {
        this.order.push(`dispose:${this.name}`);
        this.#listeners.delete(listener);
      },
    };
  };
  emit(value: T): void {
    for (const listener of this.#listeners) listener(value);
  }
  get listeners(): number {
    return this.#listeners.size;
  }
}

function registryConstructor(): RegistryConstructor {
  const constructor = (
    Provenance as unknown as {
      readonly DocumentProvenanceRegistry?: RegistryConstructor;
    }
  ).DocumentProvenanceRegistry;
  expect(constructor).toBeTypeOf("function");
  return constructor!;
}

function current(
  attestation: object,
  expected: Readonly<{
    canonicalPath: string;
    uri: string;
    version: number;
    sha256: string;
    device: string;
    inode: string;
  }>,
): boolean {
  const check = (
    Agent as unknown as {
      readonly isFileSnapshotProvenanceCurrent?: (attestation: object, expected: typeof expected) => boolean;
    }
  ).isFileSnapshotProvenanceCurrent;
  expect(check).toBeTypeOf("function");
  return check!(attestation, expected);
}

async function workspace(): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), "rbxforge-provenance-")));
}

function document(path: string, text: string, version = 1, isDirty = false): Document {
  return {
    uri: {
      scheme: "file",
      fsPath: path,
      toString: () => `file://${path}`,
    },
    version,
    isDirty,
    text,
    getText() {
      return this.text;
    },
  };
}

function harness(documents: readonly Document[] = []) {
  const order: string[] = [];
  const open = new Emitter<Document>("open", order);
  const change = new Emitter<Readonly<{ document: Document }>>("change", order);
  const save = new Emitter<Document>("save", order);
  const close = new Emitter<Document>("close", order);
  const renameEvent = new Emitter<Readonly<{ oldPath: string; newPath: string }>>("rename", order);
  const file = new Emitter<string>("file", order);
  const options = {
    documents: () => {
      order.push("scan");
      return documents;
    },
    onDidOpen: open.event,
    onDidChange: change.event,
    onDidSave: save.event,
    onDidClose: close.event,
    onDidRename: renameEvent.event,
    onDidFileChange: file.event,
  };
  return { order, open, change, save, close, rename: renameEvent, file, options };
}

async function expected(doc: Document) {
  const info = await stat(doc.uri.fsPath, { bigint: true });
  return {
    canonicalPath: doc.uri.fsPath,
    uri: doc.uri.toString(),
    version: doc.version,
    sha256: createHash("sha256").update(doc.text).digest("hex"),
    device: info.dev.toString(),
    inode: info.ino.toString(),
  };
}

describe("DocumentProvenanceRegistry", () => {
  test("subscribes before scanning and establishes an already-open clean canonical document", async () => {
    const root = await workspace();
    const path = join(root, "main.lua");
    const text = "return 'clean'\n";
    await writeFile(path, text);
    const doc = document(path, text);
    const events = harness([doc]);
    const Registry = registryConstructor();

    const registry = new Registry(events.options);
    const attestation = registry.attest(doc);

    expect(events.order.slice(0, 6)).toEqual([
      "subscribe:open",
      "subscribe:change",
      "subscribe:save",
      "subscribe:close",
      "subscribe:rename",
      "subscribe:file",
    ]);
    expect(events.order[6]).toBe("scan");
    expect(attestation).toBeDefined();
    expect(Object.keys(attestation!)).toEqual([]);
    expect(current(attestation!, await expected(doc))).toBe(true);
    registry.dispose();
  });

  test("never lazily establishes a dirty document without a trusted clean lease", async () => {
    const root = await workspace();
    const path = join(root, "main.lua");
    await writeFile(path, "return 'disk'\n");
    const doc = document(path, "return 'unsaved'\n", 7, true);
    const events = harness([doc]);
    const Registry = registryConstructor();

    const registry = new Registry(events.options);

    expect(registry.attest(doc)).toBeUndefined();
    doc.version = 8;
    doc.text = "return 'still unsaved'\n";
    events.change.emit({ document: doc });
    expect(registry.attest(doc)).toBeUndefined();
    registry.dispose();
  });

  test("tracks exact unsaved version and hash lineage only after a clean baseline", async () => {
    const root = await workspace();
    const path = join(root, "main.lua");
    const clean = "return 'clean'\n";
    await writeFile(path, clean);
    const doc = document(path, clean);
    const events = harness([doc]);
    const Registry = registryConstructor();
    const registry = new Registry(events.options);
    const cleanAttestation = registry.attest(doc)!;

    doc.version = 2;
    doc.isDirty = true;
    doc.text = "return 'unsaved'\n";
    events.change.emit({ document: doc });
    const dirtyAttestation = registry.attest(doc);

    expect(dirtyAttestation).toBeDefined();
    expect(
      current(cleanAttestation, {
        ...(await expected(doc)),
        version: 1,
        sha256: createHash("sha256").update(clean).digest("hex"),
      }),
    ).toBe(false);
    expect(current(dirtyAttestation!, await expected(doc))).toBe(true);
    doc.version = 4;
    doc.text = "return 'missed event lineage'\n";
    events.change.emit({ document: doc });
    expect(
      current(dirtyAttestation!, {
        ...(await expected(doc)),
        version: 2,
        sha256: createHash("sha256").update("return 'unsaved'\n").digest("hex"),
      }),
    ).toBe(false);
    expect(registry.attest(doc)).toBeUndefined();
    registry.dispose();
  });

  test("revokes and freshly attests save inode replacement, clean reload, and reopen", async () => {
    const root = await workspace();
    const path = join(root, "main.lua");
    const backup = join(root, "main.old.lua");
    const clean = "return 1\n";
    await writeFile(path, clean);
    const first = document(path, clean);
    const events = harness([first]);
    const Registry = registryConstructor();
    const registry = new Registry(events.options);
    const original = registry.attest(first)!;

    await rename(path, backup);
    const saved = "return 2\n";
    await writeFile(path, saved);
    first.version = 2;
    first.text = saved;
    first.isDirty = false;
    events.save.emit(first);
    const afterSave = registry.attest(first)!;

    expect(
      current(original, {
        ...(await expected(first)),
        version: 1,
        sha256: createHash("sha256").update(clean).digest("hex"),
      }),
    ).toBe(false);
    expect(current(afterSave, await expected(first))).toBe(true);

    const reloaded = "return 3\n";
    await writeFile(path, reloaded);
    first.version = 3;
    first.text = reloaded;
    first.isDirty = false;
    events.change.emit({ document: first });
    expect(
      current(afterSave, {
        ...(await expected(first)),
        version: 2,
        sha256: createHash("sha256").update(saved).digest("hex"),
      }),
    ).toBe(false);
    expect(registry.attest(first)).toBeDefined();

    const reopened = document(path, reloaded, 1, false);
    events.close.emit(first);
    events.open.emit(reopened);
    expect(registry.attest(first)).toBeUndefined();
    expect(registry.attest(reopened)).toBeDefined();
    registry.dispose();
  });

  test("rejects a buffer opened through an outside symlink even after the safe inode is restored", async () => {
    const root = await workspace();
    const outside = await workspace();
    const path = join(root, "main.lua");
    const backup = join(root, "main.safe.lua");
    const outsidePath = join(outside, "outside.lua");
    const safe = "SAFE_DISK_BYTES_42";
    const leaked = "OUTSIDE_BUFFER_BYTES_42";
    await writeFile(path, safe);
    await writeFile(outsidePath, leaked);
    await rename(path, backup);
    await symlink(outsidePath, path);
    const doc = document(path, leaked);
    await unlink(path);
    await rename(backup, path);
    const events = harness([doc]);
    const Registry = registryConstructor();
    const registry = new Registry(events.options);

    expect(registry.attest(doc)).toBeUndefined();
    registry.dispose();
  });

  test("file events and disposal revoke leases and dispose every listener once", async () => {
    const root = await workspace();
    const path = join(root, "main.lua");
    const text = "return true\n";
    await writeFile(path, text);
    const doc = document(path, text);
    const events = harness([doc]);
    const Registry = registryConstructor();
    const registry = new Registry(events.options);
    const attestation = registry.attest(doc)!;

    events.file.emit(root);
    expect(current(attestation, await expected(doc))).toBe(false);
    expect(registry.attest(doc)).toBeDefined();
    registry.dispose();
    registry.dispose();

    expect(events.open.listeners).toBe(0);
    expect(events.change.listeners).toBe(0);
    expect(events.save.listeners).toBe(0);
    expect(events.close.listeners).toBe(0);
    expect(events.rename.listeners).toBe(0);
    expect(events.file.listeners).toBe(0);
    expect(registry.attest(doc)).toBeUndefined();
    expect(events.order.filter((entry) => entry.startsWith("dispose:"))).toHaveLength(6);
  });
});
