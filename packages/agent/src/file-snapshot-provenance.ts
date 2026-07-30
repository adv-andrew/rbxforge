export interface FileSnapshotProvenanceAttestation {}

export interface FileSnapshotProvenanceExpected {
  readonly canonicalPath: string;
  readonly uri: string;
  readonly version: number;
  readonly sha256: string;
  readonly device: string;
  readonly inode: string;
}

interface StoredAttestation {
  readonly expected: FileSnapshotProvenanceExpected;
  readonly isCurrent: () => boolean;
}

const attestations = new WeakMap<object, StoredAttestation>();

export function issueFileSnapshotProvenance(
  expected: FileSnapshotProvenanceExpected,
  isCurrent: () => boolean,
): FileSnapshotProvenanceAttestation {
  const attestation = Object.freeze({});
  attestations.set(
    attestation,
    Object.freeze({
      expected: Object.freeze({ ...expected }),
      isCurrent,
    }),
  );
  return attestation;
}

export function isFileSnapshotProvenanceCurrent(
  attestation: FileSnapshotProvenanceAttestation,
  expected: FileSnapshotProvenanceExpected,
): boolean {
  if (typeof attestation !== "object" || attestation === null) return false;
  const stored = attestations.get(attestation);
  if (
    stored === undefined ||
    stored.expected.canonicalPath !== expected.canonicalPath ||
    stored.expected.uri !== expected.uri ||
    stored.expected.version !== expected.version ||
    stored.expected.sha256 !== expected.sha256 ||
    stored.expected.device !== expected.device ||
    stored.expected.inode !== expected.inode
  ) {
    return false;
  }
  try {
    return stored.isCurrent();
  } catch {
    return false;
  }
}
