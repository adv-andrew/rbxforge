import { join, resolve } from "node:path";
import { app, BrowserWindow, ipcMain, powerMonitor, session } from "electron";

import { startDesktopHost } from "../../src/main/index.js";
import { registerDesktopCloseBarrier, registerDesktopIpc } from "../../src/main/ipc.js";
import { ConversationRepository } from "../../src/main/storage/conversation-repository.js";
import { openDesktopDatabase } from "../../src/main/storage/database.js";
import { runMigrations } from "../../src/main/storage/migrations.js";
import { ProjectRepository } from "../../src/main/storage/project-repository.js";
import { SettingsRepository } from "../../src/main/storage/settings-repository.js";
import { createMainWindow, type MainWindowOptions } from "../../src/main/window.js";
import {
  createVisualFixtureController,
  createVisualFixtureSnapshot,
  parseVisualStateArgument,
  type VisualFixtureControllerOptions,
} from "../visual/visual-fixtures.js";

declare const __RBXFORGE_FIXTURE_STYLE_NONCE__: string;

async function launchFixture(): Promise<void> {
  const state = parseVisualStateArgument(process.argv);
  const styleNonce = fixtureStyleNonce();
  await app.whenReady();

  const fixtureRoot = resolve(__dirname, "../..");
  const paths = {
    databasePath: join(app.getPath("userData"), "rbxforge.sqlite"),
    rendererFile: resolve(fixtureRoot, "dist/renderer/index.html"),
    preloadFile: resolve(fixtureRoot, "dist/preload/index.cjs"),
    mcpEntryPath: resolve(fixtureRoot, "dist/vendor/robloxstudio-mcp/index.mjs"),
    pluginSourcePath: resolve(fixtureRoot, "dist/vendor/studio-plugin/MCPPlugin.rbxmx"),
  };
  const holdExclusiveMutation = process.argv.includes("--rbxforge-hold-exclusive-mutation");
  let releaseMutation: (() => void) | undefined;
  const mutationGate = holdExclusiveMutation
    ? new Promise<void>((resolve) => {
        releaseMutation = resolve;
      })
    : Promise.resolve();
  const fixtureState = {
    mutationPending: false,
    closeBarrierRequests: 0,
    draftCloseEvents: [] as Array<"close-barrier-request" | "draft-save">,
  };
  (app as typeof app & { __rbxforgeFixtureState?: typeof fixtureState }).__rbxforgeFixtureState = fixtureState;
  app.on("rbxforge-fixture-release-mutation" as never, (() => releaseMutation?.()) as never);

  await startDesktopHost({
    app,
    powerMonitor,
    openDatabase: openDesktopDatabase,
    migrate: runMigrations,
    databasePath: paths.databasePath,
    rendererFile: paths.rendererFile,
    preloadFile: paths.preloadFile,
    mcpEntryPath: paths.mcpEntryPath,
    pluginSourcePath: paths.pluginSourcePath,
    compose: (database) => {
      const settings = new SettingsRepository(database);
      const initialBounds = settings.getWindowBounds();
      const controller = createVisualFixtureController(state, {
        beforeExecute: async (command) => {
          if (command.type === "draft.save") fixtureState.draftCloseEvents.push("draft-save");
          if (!holdExclusiveMutation || command.type !== "thread.rename") return;
          fixtureState.mutationPending = true;
          try {
            await mutationGate;
          } finally {
            fixtureState.mutationPending = false;
          }
        },
        ...fixtureDraftStore(database, state),
      });
      return {
        controller,
        registerIpc: () => registerDesktopIpc({ ipcMain, controller }),
        registerCloseBarrier: () => {
          const barrier = registerDesktopCloseBarrier({ ipcMain });
          return {
            request: (webContents) => {
              fixtureState.closeBarrierRequests += 1;
              fixtureState.draftCloseEvents.push("close-barrier-request");
              return barrier.request(webContents);
            },
            dispose: () => barrier.dispose(),
          };
        },
        createWindow: () =>
          createMainWindow({
            BrowserWindow: BrowserWindow as unknown as MainWindowOptions["BrowserWindow"],
            rendererFile: paths.rendererFile,
            preloadFile: paths.preloadFile,
            permissionSession: session.defaultSession,
            styleNonce,
            ...(initialBounds === undefined ? {} : { initialBounds }),
            persistBounds: (bounds) => settings.setWindowBounds(bounds),
          }),
        bindingCoordinator: {
          invalidateAll: () => undefined,
        },
      };
    },
  });
}

function fixtureDraftStore(
  database: ReturnType<typeof openDesktopDatabase>,
  state: ReturnType<typeof parseVisualStateArgument>,
): Pick<VisualFixtureControllerOptions, "draftStore"> {
  const snapshot = createVisualFixtureSnapshot(state);
  const project = snapshot.projects[0];
  const visualThread = snapshot.threads[0];
  if (project === undefined || visualThread === undefined) return {};

  const projects = new ProjectRepository(database);
  const conversations = new ConversationRepository(database);
  const inserted = projects.insertWithFirstThread(project);
  const storedThread = inserted.kind === "created" ? inserted.thread : conversations.listThreads(project.id)[0];
  if (storedThread === undefined) {
    throw new Error("The Electron fixture could not resolve its persistent conversation.");
  }

  return {
    draftStore: {
      loadDraft: (threadId) => {
        if (threadId !== visualThread.id) return undefined;
        const draft = conversations.loadDraft(storedThread.id);
        return draft === undefined ? undefined : { ...draft, threadId };
      },
      saveDraft: (threadId, content) => {
        if (threadId !== visualThread.id) {
          throw new Error("The Electron fixture received an unknown draft conversation.");
        }
        return { ...conversations.saveDraft(storedThread.id, content), threadId };
      },
    },
  };
}

function fixtureStyleNonce(): string {
  if (
    typeof __RBXFORGE_FIXTURE_STYLE_NONCE__ !== "string" ||
    !/^[A-Za-z0-9_-]{32,128}$/.test(__RBXFORGE_FIXTURE_STYLE_NONCE__)
  ) {
    throw new Error("The Electron fixture style nonce is unavailable.");
  }
  return __RBXFORGE_FIXTURE_STYLE_NONCE__;
}

void launchFixture().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown fixture startup failure.";
  console.error(`RbxForge Electron fixture failed: ${message}`);
  app.quit();
});
