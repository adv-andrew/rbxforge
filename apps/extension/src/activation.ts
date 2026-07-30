import { registerCommands } from "./commands.js";
import { LiveStudioTreeProvider } from "./live-studio-tree.js";
import type { ExtensionServices } from "./service-container.js";
import { registerStatusBar } from "./status-bar.js";
import { ViewportPanel } from "./viewport-panel.js";
import type { DisposablePort, VsCodeFacade } from "./vscode-facade.js";
import { ConnectionWebviewProvider } from "./webviews/connection-provider.js";
import { ActivityWebviewProvider } from "./webviews/activity-provider.js";
import { PlaytestWebviewProvider } from "./webviews/playtest-provider.js";
import { PropertiesWebviewProvider } from "./webviews/properties-provider.js";
import { AgentWebviewProvider } from "./webviews/agent-provider.js";

export interface ExtensionContextPort {
  readonly subscriptions: DisposablePort[];
  readonly extensionPath: string;
  readonly secrets?: import("vscode").SecretStorage;
}

export interface ActivationHandle {
  shutdown(): Promise<void>;
}

export async function activateWithFacade(
  vscode: VsCodeFacade,
  context: ExtensionContextPort,
  services: ExtensionServices,
): Promise<ActivationHandle> {
  const subscriptionStart = context.subscriptions.length;
  try {
    return await activateWithFacadeUnchecked(vscode, context, services);
  } catch (error: unknown) {
    for (const subscription of context.subscriptions.splice(subscriptionStart)) {
      try {
        subscription.dispose();
      } catch {
        // Preserve the activation error while exhausting partial cleanup.
      }
    }
    try {
      await services.dispose();
    } catch {
      // Preserve the activation error.
    }
    throw error;
  }
}

async function activateWithFacadeUnchecked(
  vscode: VsCodeFacade,
  context: ExtensionContextPort,
  services: ExtensionServices,
): Promise<ActivationHandle> {
  const tree = new LiveStudioTreeProvider({ graph: services.graph });
  context.subscriptions.push(tree);
  context.subscriptions.push(vscode.registerTreeDataProvider("rbxforge.liveStudio", tree));
  const view = vscode.createTreeView("rbxforge.liveStudio", { treeDataProvider: tree });
  context.subscriptions.push(view);
  tree.setVisible(view.visible);
  context.subscriptions.push(view.onDidChangeVisibility(({ visible }) => tree.setVisible(visible)));
  context.subscriptions.push(view.onDidExpandElement(({ element }) => tree.setExpanded(element.path, true)));
  context.subscriptions.push(view.onDidCollapseElement(({ element }) => tree.setExpanded(element.path, false)));
  const connectionWebview = new ConnectionWebviewProvider({ services, vscode });
  const propertiesWebview = new PropertiesWebviewProvider({ services, vscode });
  const playtestWebview = new PlaytestWebviewProvider({ services });
  const activityWebview = new ActivityWebviewProvider({ services, vscode });
  const agentWebview = new AgentWebviewProvider({ services, vscode });
  let shutdownPromise: Promise<void> | undefined;
  const handle: ActivationHandle = Object.freeze({
    shutdown: () => {
      shutdownPromise ??= (async () => {
        try {
          await agentWebview.shutdown();
        } finally {
          await services.dispose();
        }
      })();
      return shutdownPromise;
    },
  });
  context.subscriptions.push({
    dispose: () => {
      void handle.shutdown().catch(() => undefined);
    },
  });
  const viewportPanel = new ViewportPanel({ services, vscode, extensionRoot: context.extensionPath });
  context.subscriptions.push(
    connectionWebview,
    propertiesWebview,
    agentWebview,
    playtestWebview,
    activityWebview,
    viewportPanel,
  );
  context.subscriptions.push(
    vscode.registerWebviewViewProvider("rbxforge.connection", connectionWebview, {
      extensionRoot: context.extensionPath,
    }),
  );
  context.subscriptions.push(
    vscode.registerWebviewViewProvider("rbxforge.playtest", playtestWebview, { extensionRoot: context.extensionPath }),
  );
  context.subscriptions.push(
    vscode.registerWebviewViewProvider("rbxforge.activity", activityWebview, { extensionRoot: context.extensionPath }),
  );
  context.subscriptions.push(
    vscode.registerWebviewViewProvider("rbxforge.properties", propertiesWebview, {
      extensionRoot: context.extensionPath,
    }),
  );
  context.subscriptions.push(
    vscode.registerWebviewViewProvider("rbxforge.agent", agentWebview, { extensionRoot: context.extensionPath }),
  );
  context.subscriptions.push(...registerStatusBar(vscode, services.connection));
  context.subscriptions.push(
    ...registerCommands(
      vscode,
      services,
      tree,
      (target) => propertiesWebview.selectTarget(target),
      (target) => agentWebview.addStudioContext(target),
      () => agentWebview.configureCredential(),
      () => viewportPanel.capture(),
    ),
  );
  return handle;
}
