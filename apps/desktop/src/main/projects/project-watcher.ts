import { watch } from "node:fs";
import { basename, dirname } from "node:path";
import type { ProjectRef } from "../../shared/domain.js";
import { ProjectIdentityError, assertProjectIdentityCurrent } from "./project-identity.js";

export interface ProjectWatchLease {
  checkNow(): Promise<void>;
  dispose(): Promise<void>;
}

export interface ProjectInvalidation {
  readonly projectId: string;
  readonly ref: ProjectRef;
  readonly reason: ProjectIdentityError;
}

export interface ProjectWatcherPorts {
  readonly watchDirectory: (
    directory: string,
    listener: (eventType: string, filename: string | Buffer | null) => void,
  ) => { close(): void };
  readonly setInterval: (callback: () => void, milliseconds: number) => unknown;
  readonly clearInterval: (handle: unknown) => void;
  readonly schedule: (work: () => Promise<void>) => void;
  readonly validateProjectIdentity: (ref: ProjectRef) => void | Promise<void>;
}

export class ProjectWatcher {
  constructor(private readonly ports: ProjectWatcherPorts = defaultPorts) {}

  start(ref: ProjectRef, onInvalidated: (invalidation: ProjectInvalidation) => void): ProjectWatchLease {
    const ports = this.ports;
    let disposed = false;
    let invalidation: ProjectIdentityError | undefined;
    let inFlight: Promise<void> | undefined;
    let disposal: Promise<void> | undefined;
    const checkNow = async (): Promise<void> => {
      if (disposed) return;
      if (invalidation !== undefined) throw invalidation;
      if (inFlight !== undefined) return inFlight;
      inFlight = Promise.resolve()
        .then(() => ports.validateProjectIdentity(ref))
        .catch((error: unknown) => {
          const reason =
            error instanceof ProjectIdentityError
              ? error
              : new ProjectIdentityError("unreadable", "Unable to revalidate project identity.", { cause: error });
          if (invalidation === undefined) {
            invalidation = reason;
            if (!disposed) {
              onInvalidated(
                Object.freeze({
                  projectId: ref.projectId,
                  ref: Object.freeze({ ...ref, revision: ref.revision + 1 }),
                  reason,
                }),
              );
            }
          }
          throw invalidation;
        })
        .finally(() => {
          inFlight = undefined;
        });
      return inFlight;
    };
    const requestValidation = (): void => {
      ports.schedule(async () => {
        try {
          await checkNow();
        } catch {
          // Invalidation has already been delivered exactly once.
        }
      });
    };
    const selectedName = basename(ref.canonicalProjectFile);
    const watcher = ports.watchDirectory(dirname(ref.canonicalProjectFile), (_eventType, filename) => {
      if (filename !== null && filename.toString() === selectedName) requestValidation();
    });
    const interval = ports.setInterval(requestValidation, 2_000);
    const dispose = (): Promise<void> => {
      if (disposal !== undefined) return disposal;
      disposed = true;
      watcher.close();
      ports.clearInterval(interval);
      const pending = inFlight;
      disposal = (async () => {
        try {
          await pending;
        } catch {
          // Disposal gates invalidation delivery but still waits for validation settlement.
        }
      })();
      return disposal;
    };
    return Object.freeze({
      checkNow,
      dispose,
    });
  }
}

const defaultPorts: ProjectWatcherPorts = {
  watchDirectory: (directory, listener) => watch(directory, listener),
  setInterval: (callback, milliseconds) => globalThis.setInterval(callback, milliseconds),
  clearInterval: (handle) => globalThis.clearInterval(handle as ReturnType<typeof globalThis.setInterval>),
  schedule: (work) => void work(),
  validateProjectIdentity: assertProjectIdentityCurrent,
};
