import type { Ownership } from "@rbxforge/core";

import type { DisposablePort, QuickPickItemPort, VsCodeFacade } from "./vscode-facade.js";
import type { ExtensionServices } from "./service-container.js";
import { COMMAND_CATALOG } from "./command-catalog.js";

export { COMMAND_CATALOG as COMMANDS } from "./command-catalog.js";
const COMMANDS = COMMAND_CATALOG;

export interface PropertiesCommandTarget {
  readonly path: string;
  readonly name: string;
  readonly className: string;
  readonly ownership: Ownership;
}

export function registerCommands(
  vscode: VsCodeFacade,
  services: ExtensionServices,
  tree: { refreshVisible(): Promise<void> },
  onOpenProperties?: (target: PropertiesCommandTarget) => void,
  onAddAgentContext?: (target: PropertiesCommandTarget) => Promise<void> | void,
  onConfigureAi?: () => Promise<boolean>,
  onCaptureScreenshot?: () => Promise<{ readonly ok: boolean; readonly reason?: string }>,
): readonly DisposablePort[] {
  return COMMANDS.map(({ id }) =>
    vscode.registerCommand(id, async (...args: readonly unknown[]) => {
      const path = dataModelPath(args[0]);
      switch (id) {
        case "rbxforge.openWorkbench":
          return vscode.executeCommand("rbxforge.connection.focus");
        case "rbxforge.selectProject": {
          const selected = await vscode.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
          });
          const project = selected?.[0]?.fsPath;
          if (project === undefined) return undefined;
          return services.project.select(project);
        }
        case "rbxforge.startRojo": {
          const project = services.project.currentPath();
          if (project === undefined)
            return vscode.showWarningMessage("Select a local Rojo project before starting Rojo.");
          try {
            await services.rojo.start(project);
          } catch (error: unknown) {
            return vscode.showWarningMessage(unavailable("Rojo start", error));
          }
          return undefined;
        }
        case "rbxforge.stopRojo":
          try {
            await services.rojo.stop();
          } catch (error: unknown) {
            return vscode.showWarningMessage(unavailable("Rojo stop", error));
          }
          return undefined;
        case "rbxforge.installStudioPlugin":
          return vscode.showInformationMessage(
            "Studio plugin installation is not available in this shell. No download or installation will run.",
            "Open instructions",
          );
        case "rbxforge.selectStudioInstance": {
          const instances = await services.studio.instances();
          const choices: readonly QuickPickItemPort[] = instances.map((instance) => ({
            label: instance.dataModelName,
            description: instance.instanceId,
          }));
          const choice = await vscode.showQuickPick(choices, { placeHolder: "Select a connected Studio instance" });
          if (choice?.description === undefined) return undefined;
          try {
            await services.studio.selectInstance(choice.description);
          } catch (error: unknown) {
            return vscode.showWarningMessage(unavailable("Studio instance selection", error));
          }
          return undefined;
        }
        case "rbxforge.refreshStudio":
          return tree.refreshVisible();
        case "rbxforge.copyDataModelPath":
          return path === undefined
            ? vscode.showWarningMessage("Select a Studio instance to copy its DataModel path.")
            : vscode.writeClipboard(path);
        case "rbxforge.revealSource": {
          const source = path === undefined ? undefined : services.source.pathFor(path);
          return source === undefined
            ? vscode.showWarningMessage("No mapped source exists for this Studio instance.")
            : vscode.openTextDocument(source);
        }
        case "rbxforge.openProperties": {
          if (path === undefined) return vscode.showWarningMessage("Select a Studio instance to read its properties.");
          onOpenProperties?.(propertiesTarget(args[0], path));
          await vscode.executeCommand("workbench.view.extension.rbxforge");
          await vscode.executeCommand("rbxforge.properties.focus");
          return undefined;
        }
        case "rbxforge.addAgentContext": {
          if (path === undefined) return vscode.showWarningMessage("Select a Studio instance to add local context.");
          if (onAddAgentContext === undefined) return vscode.showWarningMessage("Agent context is unavailable.");
          try {
            await onAddAgentContext(propertiesTarget(args[0], path));
          } catch {
            return vscode.showWarningMessage("Agent context could not be added. Refresh Studio and try again.");
          }
          await vscode.executeCommand("rbxforge.agent.focus");
          return undefined;
        }
        case "rbxforge.captureScreenshot": {
          if (onCaptureScreenshot === undefined) {
            return vscode.showWarningMessage("Studio MCP screenshot capability is unavailable.");
          }
          const outcome = await onCaptureScreenshot();
          if (!outcome.ok) {
            return vscode.showWarningMessage(outcome.reason ?? "Studio MCP screenshot capability is unavailable.");
          }
          return undefined;
        }
        case "rbxforge.configureAiProvider": {
          if (onConfigureAi === undefined) return vscode.showWarningMessage("AI provider setup is unavailable.");
          try {
            const configured = await onConfigureAi();
            if (configured) {
              services.connection.update("aiProvider", {
                health: "healthy",
                detail: "Credential stored for the configured endpoint origin",
              });
            }
          } catch {
            return vscode.showWarningMessage("AI provider setup failed.");
          }
          return undefined;
        }
      }
    }),
  );
}

function propertiesTarget(value: unknown, path: string): PropertiesCommandTarget {
  if (value !== null && typeof value === "object") {
    const record = value as Readonly<Record<string, unknown>>;
    const ownership = record.ownership;
    return {
      path,
      name: typeof record.name === "string" ? record.name : (path.split(".").at(-1) ?? path),
      className: typeof record.className === "string" ? record.className : "Instance",
      ownership:
        ownership === "files" || ownership === "studio" || ownership === "drift" || ownership === "unknown"
          ? ownership
          : "unknown",
    };
  }
  return { path, name: path.split(".").at(-1) ?? path, className: "Instance", ownership: "unknown" };
}

function unavailable(capability: string, error: unknown): string {
  void error;
  return `${capability} is unavailable.`;
}

function dataModelPath(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value === null || typeof value !== "object") return undefined;
  const path = (value as Readonly<Record<string, unknown>>).path;
  return typeof path === "string" ? path : undefined;
}
