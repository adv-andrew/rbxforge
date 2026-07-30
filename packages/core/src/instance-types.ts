/** A canonical-filesystem mapping discovered through a Rojo sourcemap. */
export interface FileProjectionNode {
  readonly path: string;
  readonly filePaths: readonly string[];
  readonly revision?: string;
}

/** One declared or live instance projection. */
export interface ProjectionNode {
  readonly path: string;
  readonly name: string;
  readonly className: string;
  readonly properties?: Readonly<Record<string, unknown>>;
  readonly revision?: string;
  readonly unsafeUnknownChildren?: boolean;
}

export type Ownership = "files" | "studio" | "drift" | "unknown";

export interface ReconcileInput {
  readonly files: readonly FileProjectionNode[];
  readonly rojo: readonly ProjectionNode[];
  readonly studio: readonly ProjectionNode[];
}

/**
 * The immutable, provenance-preserving view of one Roblox DataModel instance.
 * `children` contains canonical DataModel paths ordered for deterministic UI use.
 */
export interface UnifiedInstanceNode {
  readonly path: string;
  readonly name: string;
  readonly className: string;
  readonly ownership: Ownership;
  readonly files?: FileProjectionNode;
  readonly rojo?: ProjectionNode;
  readonly studio?: ProjectionNode;
  readonly children: readonly string[];
  readonly unsafeUnknownChildren: boolean;
  readonly unsafeParent: boolean;
}
