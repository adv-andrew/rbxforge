import type { DesktopError } from "./errors.js";

export const MAX_ECMASCRIPT_DATE_TIMESTAMP_MS = 8_640_000_000_000_000;

export type ProjectRuntimeState =
  | "disconnected"
  | "starting-rojo"
  | "rojo-server-ready"
  | "waiting-for-studio"
  | "studio-selection-required"
  | "studio-bound"
  | "needs-reconnect"
  | "catalog-ambiguous"
  | "project-mismatch"
  | "error";

export interface ProjectRef {
  readonly projectId: string;
  readonly canonicalRoot: string;
  readonly rootDevice: string;
  readonly rootInode: string;
  readonly canonicalProjectFile: string;
  readonly projectFileDevice: string;
  readonly projectFileInode: string;
  readonly configDigest: string;
  readonly revision: number;
}

export interface RojoLease {
  readonly leaseId: string;
  readonly projectId: string;
  readonly projectRevision: number;
  readonly generation: number;
  readonly port: number;
  readonly startedAt: number;
}

export interface StudioConnectionRef {
  readonly brokerEpoch: string;
  readonly instanceId: string;
  readonly connectedAt: number;
  readonly placeId: number;
  readonly role: string;
  readonly pluginVariant: string;
  readonly pluginVersion: string;
  readonly serverVersion: string;
  readonly lastActivity: number;
  readonly catalogObservedAt: number;
  readonly catalogRevision: number;
}

export interface ProjectBinding {
  readonly bindingId: string;
  readonly bindingRevision: number;
  readonly project: ProjectRef;
  readonly rojo: RojoLease;
  readonly studio: StudioConnectionRef;
  readonly rojoHandoffConfirmedAt: number;
}

export interface ProjectRecord {
  readonly id: string;
  readonly displayName: string;
  readonly canonicalRoot: string;
  readonly rootDevice: string;
  readonly rootInode: string;
  readonly canonicalProjectFile: string;
  readonly projectFileDevice: string;
  readonly projectFileInode: string;
  readonly configDigest: string;
  readonly servePlaceIds: readonly number[];
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly lastOpenedAt: number;
}

export interface ThreadRecord {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface MessageRecord {
  readonly id: string;
  readonly threadId: string;
  readonly role: "user" | "system";
  readonly content: string;
  readonly createdAt: number;
}

export interface DraftRecord {
  readonly threadId: string;
  readonly content: string;
  readonly updatedAt: number;
}

export interface StudioCatalogRow {
  readonly instanceId: string;
  readonly role: string;
  readonly placeId: number;
  readonly placeName: string;
  readonly dataModelName: string;
  readonly pluginVersion: string;
  readonly pluginVariant: string;
  readonly serverVersion: string;
  readonly versionMismatch: boolean;
  readonly connectedAt: number;
  readonly lastActivity: number;
  readonly eligible: boolean;
  readonly eligibilityReason?: StudioEligibilityReason;
  readonly warningRequired: boolean;
  readonly warningKind?: StudioWarningKind;
}

export type StudioEligibilityReason =
  | "role"
  | "plugin-variant"
  | "plugin-version"
  | "server-version"
  | "version-mismatch"
  | "stale"
  | "project-mismatch"
  | "catalog-ambiguous";

export type StudioWarningKind = "unknown-place" | "unpublished-place";

export interface ActiveProjectIdentity {
  readonly revision: number;
  readonly canonicalProjectFile: string;
  readonly relativeProjectFile: string;
  readonly configDigest: string;
}

export interface RuntimeSnapshot {
  readonly state: ProjectRuntimeState;
  readonly detail: string;
  readonly activeProject: ActiveProjectIdentity;
  readonly studioMcp: {
    readonly serverVersion: string;
  };
  readonly rojo?: {
    readonly port: number;
    readonly generation: number;
    readonly executablePath: string;
    readonly version: string;
  };
  readonly broker?: {
    readonly state: "stopped" | "starting" | "ready" | "error";
    readonly primaryPort: number;
    readonly legacyPort?: 3002;
    readonly legacyStatus: "listening" | "occupied" | "unknown";
    readonly brokerEpoch?: string;
  };
  readonly studio?: {
    readonly instanceId: string;
    readonly placeId: number;
    readonly placeName: string;
    readonly dataModelName: string;
    readonly role: string;
    readonly pluginVariant: string;
    readonly pluginVersion: string;
    readonly serverVersion: string;
    readonly connectedAt: number;
    readonly lastActivity: number;
  };
  readonly pending?: {
    readonly instanceId: string;
    readonly catalogRevision: number;
    readonly bindingRevision: number;
    readonly rojoHandoffRequired: true;
  };
  readonly catalog: readonly StudioCatalogRow[];
  readonly catalogRevision?: number;
  readonly bindingRevision?: number;
  readonly error?: DesktopError;
  readonly samePublishedPlaceLimitation: string;
}

export interface DesktopSnapshot {
  readonly revision: number;
  readonly projects: readonly ProjectRecord[];
  readonly threads: readonly ThreadRecord[];
  readonly messages: readonly MessageRecord[];
  readonly drafts: readonly DraftRecord[];
  readonly selectedProjectId?: string;
  readonly selectedThreadIdByProject: Readonly<Record<string, string>>;
  readonly runtimeByProject: Readonly<Record<string, RuntimeSnapshot>>;
  readonly settings: {
    readonly preferredMcpPort: number;
    readonly sidebarWidth: number;
    readonly mcpPortChangeAllowed: boolean;
  };
}
