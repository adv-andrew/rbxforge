import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import type { DesktopSnapshot, StudioInspectorNode } from "../../shared/domain.js";
import type { DesktopResponse } from "../../shared/protocol.js";
import type { DesktopClient } from "./desktop-client.js";
import {
  createStudioInspectorState,
  sameInspectorIdentity,
  studioInspectorReducer,
  type InspectorIdentity,
  type StudioInspectorState,
} from "./studio-inspector-model.js";

const GENERIC_INSPECTOR_ERROR = "Studio inspection could not be completed.";
const MAX_RENDERER_ERROR_LENGTH = 500;

export interface StudioInspectorController {
  readonly state: StudioInspectorState;
  open(): void;
  close(): void;
  refresh(): void;
  togglePath(path: string): void;
  selectPath(path: string): void;
  retryChildren(path: string): void;
  retryProperties(): void;
}

export function useStudioInspector(
  client: DesktopClient,
  snapshot: DesktopSnapshot | undefined,
): StudioInspectorController {
  const selectedProjectId = snapshot?.selectedProjectId;
  const runtime = selectedProjectId === undefined ? undefined : snapshot?.runtimeByProject[selectedProjectId];
  const runtimeState = runtime?.state;
  const instanceId = runtime?.studio?.instanceId;
  const bindingRevision = runtime?.bindingRevision;
  const brokerEpoch = runtime?.broker?.brokerEpoch;
  const identity = useMemo<InspectorIdentity | undefined>(() => {
    if (
      selectedProjectId === undefined ||
      runtimeState !== "studio-bound" ||
      instanceId === undefined ||
      bindingRevision === undefined ||
      brokerEpoch === undefined
    ) {
      return undefined;
    }
    return {
      projectId: selectedProjectId,
      instanceId,
      bindingRevision,
      brokerEpoch,
    };
  }, [selectedProjectId, runtimeState, instanceId, bindingRevision, brokerEpoch]);
  const [state, dispatch] = useReducer(studioInspectorReducer, identity, createStudioInspectorState);
  const controllerState = sameInspectorIdentity(state.identity, identity)
    ? state
    : createStudioInspectorState(identity);
  const generationRef = useRef(0);
  const identityRef = useRef(identity);
  const mountedRef = useRef(false);
  const startedRequestsRef = useRef(new Set<string>());
  identityRef.current = identity;

  const nextGeneration = useCallback((): number => {
    generationRef.current += 1;
    return generationRef.current;
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    dispatch({ type: "identity.changed", identity });
  }, [identity]);

  useEffect(() => {
    const requestIdentity = state.identity;
    if (!state.isOpen || requestIdentity === undefined) return;

    for (const [path, load] of Object.entries(state.childrenByPath)) {
      if (load.status !== "loading") continue;
      const requestKey = requestKeyFor("children", requestIdentity, path, load.generation);
      if (startedRequestsRef.current.has(requestKey)) continue;
      startedRequestsRef.current.add(requestKey);
      void (async () => {
        const fail = (message: string): void => {
          dispatch({
            type: "children.failed",
            identity: requestIdentity,
            path,
            generation: load.generation,
            message,
          });
        };
        const response = await requestDesktopResponse(() =>
          client.loadStudioChildren(
            requestIdentity.projectId,
            requestIdentity.instanceId,
            requestIdentity.bindingRevision,
            path,
          ),
        );
        if (!requestIsCurrent(mountedRef, identityRef, requestIdentity)) return;
        if (response === undefined || !response.ok) {
          fail(response === undefined ? GENERIC_INSPECTOR_ERROR : boundedRendererMessage(response.error.message));
          return;
        }
        if (
          response.result.kind !== "studio-inspector-children" ||
          !sameInspectorIdentity(response.result, requestIdentity) ||
          response.result.instancePath !== path
        ) {
          fail(GENERIC_INSPECTOR_ERROR);
          return;
        }
        dispatch({
          type: "children.loaded",
          identity: requestIdentity,
          path,
          generation: load.generation,
          rows: normalizeInspectorNodes(response.result.children),
        });
      })();
    }

    const properties = state.properties;
    if (properties?.status !== "loading") return;
    const requestKey = requestKeyFor("properties", requestIdentity, properties.path, properties.generation);
    if (startedRequestsRef.current.has(requestKey)) return;
    startedRequestsRef.current.add(requestKey);
    void (async () => {
      const fail = (message: string): void => {
        dispatch({
          type: "properties.failed",
          identity: requestIdentity,
          path: properties.path,
          generation: properties.generation,
          message,
        });
      };
      const response = await requestDesktopResponse(() =>
        client.loadStudioProperties(
          requestIdentity.projectId,
          requestIdentity.instanceId,
          requestIdentity.bindingRevision,
          properties.path,
        ),
      );
      if (!requestIsCurrent(mountedRef, identityRef, requestIdentity)) return;
      if (response === undefined || !response.ok) {
        fail(response === undefined ? GENERIC_INSPECTOR_ERROR : boundedRendererMessage(response.error.message));
        return;
      }
      if (
        response.result.kind !== "studio-inspector-properties" ||
        !sameInspectorIdentity(response.result, requestIdentity) ||
        response.result.instancePath !== properties.path
      ) {
        fail(GENERIC_INSPECTOR_ERROR);
        return;
      }
      dispatch({
        type: "properties.loaded",
        identity: requestIdentity,
        path: properties.path,
        generation: properties.generation,
        className: response.result.className,
        rows: response.result.properties,
        observedAt: response.result.observedAt,
      });
    })();
  }, [client, state.childrenByPath, state.identity, state.isOpen, state.properties]);

  const open = useCallback(() => {
    if (identity === undefined) return;
    dispatch({
      type: "opened",
      identity,
      generation: nextGeneration(),
    });
  }, [identity, nextGeneration]);

  const close = useCallback(() => {
    dispatch({ type: "closed" });
  }, []);

  const refresh = useCallback(() => {
    if (controllerState.identity === undefined) return;
    const paths = ["game", ...controllerState.expandedPaths.filter((path) => path !== "game")];
    dispatch({
      type: "refreshed",
      identity: controllerState.identity,
      loads: paths.map((path) => ({ path, generation: nextGeneration() })),
    });
  }, [controllerState.expandedPaths, controllerState.identity, nextGeneration]);

  const togglePath = useCallback(
    (path: string) => {
      if (controllerState.identity === undefined) return;
      dispatch({
        type: "path.toggled",
        identity: controllerState.identity,
        path,
        generation: nextGeneration(),
      });
    },
    [controllerState.identity, nextGeneration],
  );

  const selectPath = useCallback(
    (path: string) => {
      if (controllerState.identity === undefined) return;
      dispatch({
        type: "path.selected",
        identity: controllerState.identity,
        path,
        generation: nextGeneration(),
      });
    },
    [controllerState.identity, nextGeneration],
  );

  const retryChildren = useCallback(
    (path: string) => {
      if (controllerState.identity === undefined) return;
      dispatch({
        type: "children.retried",
        identity: controllerState.identity,
        path,
        generation: nextGeneration(),
      });
    },
    [controllerState.identity, nextGeneration],
  );

  const retryProperties = useCallback(() => {
    if (controllerState.identity === undefined || controllerState.properties?.status !== "error") {
      return;
    }
    dispatch({
      type: "properties.retried",
      identity: controllerState.identity,
      path: controllerState.properties.path,
      generation: nextGeneration(),
    });
  }, [controllerState.identity, controllerState.properties, nextGeneration]);

  return useMemo(
    () => ({
      state: controllerState,
      open,
      close,
      refresh,
      togglePath,
      selectPath,
      retryChildren,
      retryProperties,
    }),
    [close, open, refresh, retryChildren, retryProperties, selectPath, controllerState, togglePath],
  );
}

function requestIsCurrent(
  mountedRef: { readonly current: boolean },
  identityRef: { readonly current: InspectorIdentity | undefined },
  identity: InspectorIdentity,
): boolean {
  return mountedRef.current && sameInspectorIdentity(identityRef.current, identity);
}

function requestKeyFor(
  kind: "children" | "properties",
  identity: InspectorIdentity,
  path: string,
  generation: number,
): string {
  return [
    kind,
    identity.projectId,
    identity.instanceId,
    identity.bindingRevision,
    identity.brokerEpoch,
    path,
    generation,
  ].join("\u0000");
}

function boundedRendererMessage(message: string): string {
  const bounded = message.slice(0, MAX_RENDERER_ERROR_LENGTH);
  return bounded.length > 0 ? bounded : GENERIC_INSPECTOR_ERROR;
}

async function requestDesktopResponse(request: () => Promise<DesktopResponse>): Promise<DesktopResponse | undefined> {
  try {
    return await request();
  } catch {
    return undefined;
  }
}

function normalizeInspectorNodes(
  rows: readonly {
    readonly name: string;
    readonly className: string;
    readonly path: string;
    readonly hasChildren: boolean;
    readonly enabled?: boolean | undefined;
  }[],
): readonly StudioInspectorNode[] {
  return rows.map((row) => ({
    name: row.name,
    className: row.className,
    path: row.path,
    hasChildren: row.hasChildren,
    ...(row.enabled === undefined ? {} : { enabled: row.enabled }),
  }));
}
