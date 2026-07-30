/** The sole command-ID catalog; manifest validation rejects package.json drift. */
export const COMMAND_CATALOG = [
  { id: "rbxforge.openWorkbench" },
  { id: "rbxforge.selectProject" },
  { id: "rbxforge.startRojo" },
  { id: "rbxforge.stopRojo" },
  { id: "rbxforge.installStudioPlugin" },
  { id: "rbxforge.selectStudioInstance" },
  { id: "rbxforge.refreshStudio" },
  { id: "rbxforge.copyDataModelPath" },
  { id: "rbxforge.revealSource" },
  { id: "rbxforge.openProperties" },
  { id: "rbxforge.addAgentContext" },
  { id: "rbxforge.captureScreenshot" },
  { id: "rbxforge.configureAiProvider" },
] as const;
