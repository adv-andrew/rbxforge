import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";

import {
  issueFileSnapshotProvenance,
  type FileSnapshotProvenanceAttestation,
  type FileSnapshotProvenanceExpected,
} from "@rbxforge/agent";

import type { DisposablePort, EventPort } from "./vscode-facade.js";

export interface ProvenanceDocumentPort {
  readonly uri: {
    readonly scheme: string;
    readonly fsPath: string;
    toString(): string;
  };
  readonly version: number;
  readonly isDirty: boolean;
  getText(): string;
}

export interface DocumentProvenanceRegistryOptions {
  readonly documents: () => readonly ProvenanceDocumentPort[];
  readonly onDidOpen: EventPort<ProvenanceDocumentPort>;
  readonly onDidChange: EventPort<Readonly<{ document: ProvenanceDocumentPort }>>;
  readonly onDidSave: EventPort<ProvenanceDocumentPort>;
  readonly onDidClose: EventPort<ProvenanceDocumentPort>;
  readonly onDidRename: EventPort<Readonly<{ oldPath: string; newPath: string }>>;
  readonly onDidFileChange: EventPort<string>;
}

interface DiskIdentity {
  readonly canonicalPath: string;
  readonly device: string;
  readonly inode: string;
  readonly size: string;
  readonly mtimeNs: string;
  readonly ctimeNs: string;
}

interface Lease {
  readonly document: ProvenanceDocumentPort;
  readonly path: string;
  readonly uri: string;
  readonly version: number;
  readonly sha256: string;
  readonly identity: DiskIdentity;
  current: boolean;
}

export class DocumentProvenanceRegistry implements DisposablePort {
  readonly #leases = new Map<ProvenanceDocumentPort, Lease>();
  readonly #openDocuments = new Set<ProvenanceDocumentPort>();
  readonly #subscriptions: DisposablePort[] = [];
  #disposed = false;

  constructor(options: DocumentProvenanceRegistryOptions) {
    try {
      // Events are subscribed before the initial scan so no open/change can be
      // missed between discovering a document and establishing its lineage.
      this.#subscriptions.push(
        options.onDidOpen((document) => {
          this.#openDocuments.add(document);
          this.#revoke(document);
          if (!document.isDirty) this.#establish(document);
        }),
      );
      this.#subscriptions.push(
        options.onDidChange(({ document }) => {
          this.#changed(document);
        }),
      );
      this.#subscriptions.push(
        options.onDidSave((document) => {
          this.#revoke(document);
          if (!document.isDirty) this.#establish(document);
        }),
      );
      this.#subscriptions.push(
        options.onDidClose((document) => {
          this.#revoke(document);
          this.#openDocuments.delete(document);
        }),
      );
      this.#subscriptions.push(
        options.onDidRename(({ oldPath, newPath }) => {
          this.#invalidatePath(oldPath);
          this.#invalidatePath(newPath);
        }),
      );
      this.#subscriptions.push(
        options.onDidFileChange((path) => {
          this.#invalidatePath(path);
        }),
      );
    } catch (error: unknown) {
      this.#disposed = true;
      for (const subscription of this.#subscriptions.splice(0)) {
        try {
          subscription.dispose();
        } catch {
          // Construction still fails closed with the original listener error.
        }
      }
      throw error;
    }
    try {
      for (const document of options.documents()) {
        this.#openDocuments.add(document);
        if (!document.isDirty) this.#establish(document);
      }
    } catch (error: unknown) {
      this.dispose();
      throw error;
    }
  }

  attest(document: ProvenanceDocumentPort): FileSnapshotProvenanceAttestation | undefined {
    if (this.#disposed || !this.#openDocuments.has(document)) return undefined;
    let lease = this.#leases.get(document);
    if (lease === undefined) {
      // A dirty document without a prior clean baseline has no trustworthy
      // source lineage and must never be lazily admitted.
      if (document.isDirty) return undefined;
      lease = this.#establish(document);
    }
    if (lease === undefined || !this.#leaseCurrent(lease)) {
      this.#revoke(document);
      return undefined;
    }
    const expected = expectedFrom(lease);
    return issueFileSnapshotProvenance(expected, () => this.#leaseCurrent(lease!));
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const lease of this.#leases.values()) lease.current = false;
    this.#leases.clear();
    this.#openDocuments.clear();
    for (const subscription of this.#subscriptions.splice(0)) {
      try {
        subscription.dispose();
      } catch {
        // Disposing one runtime listener must not strand the rest.
      }
    }
  }

  #changed(document: ProvenanceDocumentPort): void {
    if (this.#disposed) return;
    const prior = this.#leases.get(document);
    if (prior === undefined) return;
    if (
      !document.isDirty ||
      document.uri.scheme !== "file" ||
      document.uri.fsPath !== prior.path ||
      document.uri.toString() !== prior.uri ||
      document.version !== prior.version + 1 ||
      !diskIdentityCurrent(prior.identity)
    ) {
      this.#revoke(document);
      return;
    }
    prior.current = false;
    this.#leases.set(document, {
      document,
      path: prior.path,
      uri: prior.uri,
      version: document.version,
      sha256: sha256(document.getText()),
      identity: prior.identity,
      current: true,
    });
  }

  #establish(document: ProvenanceDocumentPort): Lease | undefined {
    if (
      this.#disposed ||
      document.isDirty ||
      document.uri.scheme !== "file" ||
      !Number.isSafeInteger(document.version) ||
      document.version < 0
    ) {
      return undefined;
    }
    const path = document.uri.fsPath;
    const uri = document.uri.toString();
    const text = document.getText();
    const observed = readCanonicalDiskHash(path);
    if (observed === undefined || observed.bytes !== Buffer.byteLength(text) || observed.sha256 !== sha256(text)) {
      return undefined;
    }
    const lease: Lease = {
      document,
      path,
      uri,
      version: document.version,
      sha256: sha256(document.getText()),
      identity: observed.identity,
      current: true,
    };
    this.#leases.set(document, lease);
    return lease;
  }

  #leaseCurrent(lease: Lease): boolean {
    if (
      this.#disposed ||
      !lease.current ||
      this.#leases.get(lease.document) !== lease ||
      lease.document.uri.scheme !== "file" ||
      lease.document.uri.fsPath !== lease.path ||
      lease.document.uri.toString() !== lease.uri ||
      lease.document.version !== lease.version ||
      sha256(lease.document.getText()) !== lease.sha256
    ) {
      return false;
    }
    return diskIdentityCurrent(lease.identity);
  }

  #invalidatePath(path: string): void {
    for (const [document, lease] of this.#leases) {
      if (pathAffects(path, lease.path)) this.#revoke(document);
    }
  }

  #revoke(document: ProvenanceDocumentPort): void {
    const lease = this.#leases.get(document);
    if (lease !== undefined) lease.current = false;
    this.#leases.delete(document);
  }
}

function expectedFrom(lease: Lease): FileSnapshotProvenanceExpected {
  return Object.freeze({
    canonicalPath: lease.identity.canonicalPath,
    uri: lease.uri,
    version: lease.version,
    sha256: lease.sha256,
    device: lease.identity.device,
    inode: lease.identity.inode,
  });
}

function readCanonicalDiskHash(
  path: string,
): Readonly<{ sha256: string; bytes: number; identity: DiskIdentity }> | undefined {
  if (!isAbsolute(path)) return undefined;
  let descriptor: number | undefined;
  try {
    const beforePath = lstatSync(path, { bigint: true });
    if (beforePath.isSymbolicLink() || !beforePath.isFile() || realpathSync(path) !== path) {
      return undefined;
    }
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.dev !== beforePath.dev || before.ino !== beforePath.ino) {
      return undefined;
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let bytes = 0;
    for (;;) {
      const read = readSync(descriptor, buffer, 0, buffer.length, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
      bytes += read;
    }
    const after = fstatSync(descriptor, { bigint: true });
    const afterPath = lstatSync(path, { bigint: true });
    if (
      !after.isFile() ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs ||
      afterPath.isSymbolicLink() ||
      !afterPath.isFile() ||
      afterPath.dev !== before.dev ||
      afterPath.ino !== before.ino ||
      realpathSync(path) !== path
    ) {
      return undefined;
    }
    return Object.freeze({
      sha256: hash.digest("hex"),
      bytes,
      identity: Object.freeze({
        canonicalPath: path,
        device: before.dev.toString(),
        inode: before.ino.toString(),
        size: before.size.toString(),
        mtimeNs: before.mtimeNs.toString(),
        ctimeNs: before.ctimeNs.toString(),
      }),
    });
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // A failed close cannot make an untrusted document admissible.
      }
    }
  }
}

function pathAffects(eventPath: string, leasePath: string): boolean {
  if (eventPath === leasePath) return true;
  const descendant = relative(eventPath, leasePath);
  return descendant !== "" && descendant !== ".." && !descendant.startsWith(`..${sep}`) && !isAbsolute(descendant);
}

function diskIdentityCurrent(expected: DiskIdentity): boolean {
  try {
    const info = lstatSync(expected.canonicalPath, { bigint: true });
    return (
      !info.isSymbolicLink() &&
      info.isFile() &&
      realpathSync(expected.canonicalPath) === expected.canonicalPath &&
      info.dev.toString() === expected.device &&
      info.ino.toString() === expected.inode &&
      info.size.toString() === expected.size &&
      info.mtimeNs.toString() === expected.mtimeNs &&
      info.ctimeNs.toString() === expected.ctimeNs
    );
  } catch {
    return false;
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
