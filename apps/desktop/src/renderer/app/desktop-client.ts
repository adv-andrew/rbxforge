import type { DesktopEvent, DesktopResponse } from "../../shared/protocol.js";

export type RendererApi = Window["rbxforge"];

export interface DesktopClient {
  readonly platform: string;
  subscribe(listener: (event: DesktopEvent) => void): () => void;
  bootstrap(): Promise<DesktopResponse>;
  addProject(): Promise<DesktopResponse>;
  addProjectCandidate(selectionId: string, candidateId: string): Promise<DesktopResponse>;
  cancelProjectAdd(selectionId: string): () => Promise<DesktopResponse>;
  copyProjectFile(projectId: string): Promise<DesktopResponse>;
  selectProject(projectId: string): Promise<DesktopResponse>;
  removeProject(projectId: string): Promise<DesktopResponse>;
  createThread(projectId: string): Promise<DesktopResponse>;
  selectThread(projectId: string, threadId: string): Promise<DesktopResponse>;
  renameThread(projectId: string, threadId: string, title: string): Promise<DesktopResponse>;
  deleteThread(projectId: string, threadId: string): Promise<DesktopResponse>;
  saveDraft(projectId: string, threadId: string, content: string): Promise<DesktopResponse>;
  createMessage(projectId: string, threadId: string, content: string): Promise<DesktopResponse>;
  connectRuntime(projectId: string): Promise<DesktopResponse>;
  selectStudio(
    projectId: string,
    instanceId: string,
    catalogRevision: number,
    warningAccepted: boolean,
  ): Promise<DesktopResponse>;
  confirmRojoHandoff(projectId: string, bindingRevision: number): Promise<DesktopResponse>;
  disconnectRuntime(projectId: string): Promise<DesktopResponse>;
  refreshRuntime(projectId: string): Promise<DesktopResponse>;
  copyMcpUrl(projectId: string): Promise<DesktopResponse>;
  copyRojoAddress(projectId: string): Promise<DesktopResponse>;
  inspectPlugin(): Promise<DesktopResponse>;
  installPlugin(confirmReplace: boolean): Promise<DesktopResponse>;
  showPluginFolder(): Promise<DesktopResponse>;
  chooseRojo(): Promise<DesktopResponse>;
  setMcpPort(port: number): Promise<DesktopResponse>;
  setSidebarWidth(width: number): Promise<DesktopResponse>;
}

export function createDesktopClient(options: {
  readonly api: RendererApi;
  readonly getExpectedRevision: () => number;
}): DesktopClient {
  const expectedRevision = () => options.getExpectedRevision();
  return {
    platform: options.api.platform,
    subscribe: (listener) => options.api.subscribe(listener),
    bootstrap: () => options.api.request({ type: "bootstrap" }),
    addProject: () => options.api.request({ type: "project.add", expectedRevision: expectedRevision() }),
    addProjectCandidate: (selectionId, candidateId) =>
      options.api.request({
        type: "project.addCandidate",
        selectionId,
        candidateId,
        expectedRevision: expectedRevision(),
      }),
    cancelProjectAdd: (selectionId) => {
      let pending: Promise<DesktopResponse> | undefined;
      return () => {
        pending ??= options.api.request({ type: "project.cancelAdd", selectionId });
        return pending;
      };
    },
    copyProjectFile: (projectId) => options.api.request({ type: "project.copyFile", projectId }),
    selectProject: (projectId) =>
      options.api.request({ type: "project.select", projectId, expectedRevision: expectedRevision() }),
    removeProject: (projectId) =>
      options.api.request({ type: "project.remove", projectId, expectedRevision: expectedRevision() }),
    createThread: (projectId) =>
      options.api.request({ type: "thread.create", projectId, expectedRevision: expectedRevision() }),
    selectThread: (projectId, threadId) =>
      options.api.request({
        type: "thread.select",
        projectId,
        threadId,
        expectedRevision: expectedRevision(),
      }),
    renameThread: (projectId, threadId, title) =>
      options.api.request({
        type: "thread.rename",
        projectId,
        threadId,
        title,
        expectedRevision: expectedRevision(),
      }),
    deleteThread: (projectId, threadId) =>
      options.api.request({
        type: "thread.delete",
        projectId,
        threadId,
        expectedRevision: expectedRevision(),
      }),
    saveDraft: (projectId, threadId, content) =>
      options.api.request({
        type: "draft.save",
        projectId,
        threadId,
        content,
        expectedRevision: expectedRevision(),
      }),
    createMessage: (projectId, threadId, content) =>
      options.api.request({
        type: "message.create",
        projectId,
        threadId,
        content,
        expectedRevision: expectedRevision(),
      }),
    connectRuntime: (projectId) =>
      options.api.request({ type: "runtime.connect", projectId, expectedRevision: expectedRevision() }),
    selectStudio: (projectId, instanceId, catalogRevision, warningAccepted) =>
      options.api.request({
        type: "runtime.selectStudio",
        projectId,
        instanceId,
        catalogRevision,
        warningAccepted,
        expectedRevision: expectedRevision(),
      }),
    confirmRojoHandoff: (projectId, bindingRevision) =>
      options.api.request({
        type: "runtime.confirmRojoHandoff",
        projectId,
        bindingRevision,
        expectedRevision: expectedRevision(),
      }),
    disconnectRuntime: (projectId) =>
      options.api.request({ type: "runtime.disconnect", projectId, expectedRevision: expectedRevision() }),
    refreshRuntime: (projectId) =>
      options.api.request({ type: "runtime.refresh", projectId, expectedRevision: expectedRevision() }),
    copyMcpUrl: (projectId) => options.api.request({ type: "runtime.copyMcpUrl", projectId }),
    copyRojoAddress: (projectId) => options.api.request({ type: "runtime.copyRojoAddress", projectId }),
    inspectPlugin: () => options.api.request({ type: "plugin.inspect" }),
    installPlugin: (confirmReplace) =>
      options.api.request({
        type: "plugin.install",
        confirmReplace,
        expectedRevision: expectedRevision(),
      }),
    showPluginFolder: () => options.api.request({ type: "plugin.showFolder" }),
    chooseRojo: () => options.api.request({ type: "settings.chooseRojo", expectedRevision: expectedRevision() }),
    setMcpPort: (port) => options.api.request({ type: "settings.mcpPort", port, expectedRevision: expectedRevision() }),
    setSidebarWidth: (width) =>
      options.api.request({ type: "ui.sidebarWidth", width, expectedRevision: expectedRevision() }),
  };
}
