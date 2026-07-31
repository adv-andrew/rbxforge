import type { StudioInspectorNode, StudioInspectorProperty } from "../../shared/domain.js";

export interface InspectorIdentity {
  readonly projectId: string;
  readonly instanceId: string;
  readonly bindingRevision: number;
  readonly brokerEpoch: string;
}

export type ChildLoadState =
  | { readonly status: "loading"; readonly generation: number }
  | {
      readonly status: "ready";
      readonly generation: number;
      readonly rows: readonly StudioInspectorNode[];
    }
  | { readonly status: "error"; readonly generation: number; readonly message: string };

export type PropertyLoadState =
  | {
      readonly status: "loading";
      readonly generation: number;
      readonly path: string;
    }
  | {
      readonly status: "ready";
      readonly generation: number;
      readonly path: string;
      readonly className: string;
      readonly rows: readonly StudioInspectorProperty[];
      readonly observedAt: number;
    }
  | {
      readonly status: "error";
      readonly generation: number;
      readonly path: string;
      readonly message: string;
    };

export interface StudioInspectorState {
  readonly identity: InspectorIdentity | undefined;
  readonly isOpen: boolean;
  readonly childrenByPath: Readonly<Record<string, ChildLoadState>>;
  readonly expandedPaths: readonly string[];
  readonly selectedPath: string | undefined;
  readonly properties: PropertyLoadState | undefined;
}

export type StudioInspectorAction =
  | { readonly type: "identity.changed"; readonly identity: InspectorIdentity | undefined }
  | {
      readonly type: "opened";
      readonly identity: InspectorIdentity;
      readonly generation: number;
    }
  | { readonly type: "closed" }
  | {
      readonly type: "path.toggled";
      readonly identity: InspectorIdentity;
      readonly path: string;
      readonly generation: number;
    }
  | {
      readonly type: "children.loaded";
      readonly identity: InspectorIdentity;
      readonly path: string;
      readonly generation: number;
      readonly rows: readonly StudioInspectorNode[];
    }
  | {
      readonly type: "children.failed";
      readonly identity: InspectorIdentity;
      readonly path: string;
      readonly generation: number;
      readonly message: string;
    }
  | {
      readonly type: "children.retried";
      readonly identity: InspectorIdentity;
      readonly path: string;
      readonly generation: number;
    }
  | {
      readonly type: "path.selected";
      readonly identity: InspectorIdentity;
      readonly path: string;
      readonly generation: number;
    }
  | {
      readonly type: "properties.loaded";
      readonly identity: InspectorIdentity;
      readonly path: string;
      readonly generation: number;
      readonly className: string;
      readonly rows: readonly StudioInspectorProperty[];
      readonly observedAt: number;
    }
  | {
      readonly type: "properties.failed";
      readonly identity: InspectorIdentity;
      readonly path: string;
      readonly generation: number;
      readonly message: string;
    }
  | {
      readonly type: "properties.retried";
      readonly identity: InspectorIdentity;
      readonly path: string;
      readonly generation: number;
    }
  | {
      readonly type: "refreshed";
      readonly identity: InspectorIdentity;
      readonly loads: readonly {
        readonly path: string;
        readonly generation: number;
      }[];
    };

export function createStudioInspectorState(identity?: InspectorIdentity): StudioInspectorState {
  return {
    identity,
    isOpen: false,
    childrenByPath: {},
    expandedPaths: [],
    selectedPath: undefined,
    properties: undefined,
  };
}

export function sameInspectorIdentity(
  left: InspectorIdentity | undefined,
  right: InspectorIdentity | undefined,
): boolean {
  return (
    left === right ||
    (left !== undefined &&
      right !== undefined &&
      left.projectId === right.projectId &&
      left.instanceId === right.instanceId &&
      left.bindingRevision === right.bindingRevision &&
      left.brokerEpoch === right.brokerEpoch)
  );
}

export function studioInspectorReducer(
  state: StudioInspectorState,
  action: StudioInspectorAction,
): StudioInspectorState {
  switch (action.type) {
    case "identity.changed":
      return sameInspectorIdentity(state.identity, action.identity)
        ? state
        : createStudioInspectorState(action.identity);
    case "opened":
      if (!sameInspectorIdentity(state.identity, action.identity) || state.isOpen) return state;
      return {
        ...state,
        isOpen: true,
        childrenByPath: {
          ...state.childrenByPath,
          game: { status: "loading", generation: action.generation },
        },
      };
    case "closed":
      return state.isOpen ||
        Object.keys(state.childrenByPath).length > 0 ||
        state.expandedPaths.length > 0 ||
        state.selectedPath !== undefined ||
        state.properties !== undefined
        ? createStudioInspectorState(state.identity)
        : state;
    case "path.toggled": {
      if (!state.isOpen || !sameInspectorIdentity(state.identity, action.identity)) return state;
      if (state.expandedPaths.includes(action.path)) {
        return {
          ...state,
          expandedPaths: state.expandedPaths.filter((path) => path !== action.path),
        };
      }
      return {
        ...state,
        expandedPaths: [...state.expandedPaths, action.path],
        childrenByPath:
          state.childrenByPath[action.path] === undefined
            ? {
                ...state.childrenByPath,
                [action.path]: { status: "loading", generation: action.generation },
              }
            : state.childrenByPath,
      };
    }
    case "children.loaded": {
      if (!matchesChildLoad(state, action)) return state;
      return {
        ...state,
        childrenByPath: {
          ...state.childrenByPath,
          [action.path]: {
            status: "ready",
            generation: action.generation,
            rows: action.rows,
          },
        },
      };
    }
    case "children.failed": {
      if (!matchesChildLoad(state, action)) return state;
      return {
        ...state,
        childrenByPath: {
          ...state.childrenByPath,
          [action.path]: {
            status: "error",
            generation: action.generation,
            message: action.message,
          },
        },
      };
    }
    case "children.retried": {
      if (!sameInspectorIdentity(state.identity, action.identity)) return state;
      const current = state.childrenByPath[action.path];
      if (current?.status !== "error") return state;
      return {
        ...state,
        childrenByPath: {
          ...state.childrenByPath,
          [action.path]: {
            status: "loading",
            generation: action.generation,
          },
        },
      };
    }
    case "path.selected":
      if (
        !state.isOpen ||
        !sameInspectorIdentity(state.identity, action.identity) ||
        state.selectedPath === action.path
      ) {
        return state;
      }
      return {
        ...state,
        selectedPath: action.path,
        properties: {
          status: "loading",
          generation: action.generation,
          path: action.path,
        },
      };
    case "properties.loaded":
      if (!matchesPropertyLoad(state, action)) return state;
      return {
        ...state,
        properties: {
          status: "ready",
          generation: action.generation,
          path: action.path,
          className: action.className,
          rows: action.rows,
          observedAt: action.observedAt,
        },
      };
    case "properties.failed":
      if (!matchesPropertyLoad(state, action)) return state;
      return {
        ...state,
        properties: {
          status: "error",
          generation: action.generation,
          path: action.path,
          message: action.message,
        },
      };
    case "properties.retried":
      if (
        !sameInspectorIdentity(state.identity, action.identity) ||
        state.selectedPath !== action.path ||
        state.properties?.status !== "error" ||
        state.properties.path !== action.path
      ) {
        return state;
      }
      return {
        ...state,
        properties: {
          status: "loading",
          generation: action.generation,
          path: action.path,
        },
      };
    case "refreshed": {
      if (!state.isOpen || !sameInspectorIdentity(state.identity, action.identity)) return state;
      const refreshable = new Set(["game", ...state.expandedPaths]);
      let childrenByPath = state.childrenByPath;
      for (const load of action.loads) {
        if (!refreshable.has(load.path)) continue;
        if (childrenByPath === state.childrenByPath) childrenByPath = { ...state.childrenByPath };
        childrenByPath = {
          ...childrenByPath,
          [load.path]: { status: "loading", generation: load.generation },
        };
      }
      return childrenByPath === state.childrenByPath ? state : { ...state, childrenByPath };
    }
  }
}

function matchesChildLoad(
  state: StudioInspectorState,
  action: {
    readonly identity: InspectorIdentity;
    readonly path: string;
    readonly generation: number;
  },
): boolean {
  const current = state.childrenByPath[action.path];
  return (
    sameInspectorIdentity(state.identity, action.identity) &&
    current?.status === "loading" &&
    current.generation === action.generation
  );
}

function matchesPropertyLoad(
  state: StudioInspectorState,
  action: {
    readonly identity: InspectorIdentity;
    readonly path: string;
    readonly generation: number;
  },
): boolean {
  return (
    sameInspectorIdentity(state.identity, action.identity) &&
    state.selectedPath === action.path &&
    state.properties?.status === "loading" &&
    state.properties.generation === action.generation &&
    state.properties.path === action.path
  );
}
