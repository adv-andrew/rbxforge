import { RevisionedIgnorePolicy } from "@rbxforge/agent";

import { activateWithFacade, type ActivationHandle, type ExtensionContextPort } from "./activation.js";
import { createProductionServices } from "./service-container.js";
import { createVsCodeFacade } from "./vscode-facade.js";
import { createNativeStudioMutationGate } from "./webviews/native-mutation-gate.js";

// Deliberate package-smoke exports: they exercise this exact bundled entry with
// deterministic fixture adapters and never run during ordinary activation.
export { activateWithFacade } from "./activation.js";
export { createFixtureServices } from "./service-container.js";

/** Runtime-only glue: Vitest exercises activateWithFacade instead of importing vscode. */
let activeServices: ReturnType<typeof createProductionServices> | undefined;
let activeActivation: ActivationHandle | undefined;
let activeFacade: ReturnType<typeof createVsCodeFacade> | undefined;
export async function activate(context: ExtensionContextPort): Promise<void> {
  const vscode = await import("vscode");
  const subscriptionStart = context.subscriptions.length;
  let facade: ReturnType<typeof createVsCodeFacade> | undefined;
  let ignorePolicy: RevisionedIgnorePolicy | undefined;
  try {
    const createdFacade = createVsCodeFacade(vscode, context.secrets);
    facade = createdFacade;
    context.subscriptions.push(createdFacade);
    const mutationGate = createNativeStudioMutationGate(
      async (preview) => {
        const choice = await vscode.window.showWarningMessage(
          `Apply Studio mutation?\n\n${preview}`,
          { modal: true },
          "Apply",
        );
        return choice === "Apply";
      },
      {
        assertCurrent: (binding) => {
          if (activeServices?.studio.snapshot().activeInstanceId !== binding.instanceId) {
            throw new Error("Active Studio instance changed after confirmation");
          }
          activeServices.graph.assertRevision(binding.graphRevision);
        },
      },
    );
    ignorePolicy = new RevisionedIgnorePolicy({
      evaluate: (path) => createdFacade.isPathIgnored(path),
      subscribe: (invalidate) => createdFacade.subscribeIgnorePolicyInvalidation(invalidate),
    });
    activeServices = createProductionServices({
      extensionRoot: context.extensionPath,
      mutationGate,
      studioClaimIssuer: mutationGate,
      ignorePolicy,
    });
    activeActivation = await activateWithFacade(createdFacade, context, activeServices);
    activeFacade = createdFacade;
  } catch (error: unknown) {
    const services = activeServices;
    activeActivation = undefined;
    activeServices = undefined;
    activeFacade = undefined;
    if (services !== undefined) {
      try {
        await services.dispose();
      } catch {
        // Preserve the activation failure.
      }
    } else {
      ignorePolicy?.dispose();
    }
    for (const subscription of context.subscriptions.splice(subscriptionStart)) {
      try {
        subscription.dispose();
      } catch {
        // Dispose every partial registration and preserve the original error.
      }
    }
    facade?.dispose();
    throw error;
  }
}
export async function deactivate(): Promise<void> {
  const facade = activeFacade;
  try {
    await activeActivation?.shutdown();
  } finally {
    activeActivation = undefined;
    activeServices = undefined;
    activeFacade = undefined;
    facade?.dispose();
  }
}
