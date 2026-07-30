import type { ConnectionStateStore } from "./connection-state.js";
import type { DisposablePort, VsCodeFacade } from "./vscode-facade.js";

export function registerStatusBar(vscode: VsCodeFacade, state: ConnectionStateStore): readonly DisposablePort[] {
  const status = vscode.createStatusBarItem();
  const simulation = vscode.createStatusBarItem();
  const update = (): void => {
    const snapshot = state.snapshot();
    status.text = `RbxForge: ${snapshot.aggregate.label}`;
    status.command = "rbxforge.connection.focus";
    status.show();
    if (snapshot.simulation) {
      simulation.text = "RbxForge: Simulation";
      simulation.show();
    } else simulation.hide();
  };
  update();
  const listener = state.onDidChange(update);
  return [status, simulation, { dispose: listener }];
}
