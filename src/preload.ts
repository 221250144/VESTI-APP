import { contextBridge, ipcRenderer } from 'electron';
import {
  IPC,
  type CapsuleState,
  type ExtensionImportRequestPayload,
  type ExtensionImportResultPayload,
  type VestiCapsuleApi,
  type VestiDesktopApi,
  type VestiUiPrefsApi,
  type VestiWindowApi,
} from './shared/contracts';

const windowControls: VestiWindowApi = {
  platform: process.platform,
  minimize: () => ipcRenderer.send(IPC.windowMinimize),
  toggleMaximize: () => ipcRenderer.send(IPC.windowToggleMaximize),
  close: () => ipcRenderer.send(IPC.windowClose),
  isMaximized: () => ipcRenderer.invoke(IPC.windowIsMaximized),
  onMaximizedChanged: listener => {
    const wrapped = (_event: unknown, maximized: boolean) => listener(maximized);
    ipcRenderer.on(IPC.windowMaximizedChanged, wrapped);
    return () => ipcRenderer.removeListener(IPC.windowMaximizedChanged, wrapped);
  },
};

contextBridge.exposeInMainWorld('vestiWindow', windowControls);

const api: VestiDesktopApi = {
  getOverview: () => ipcRenderer.invoke(IPC.overview),
  getSessions: () => ipcRenderer.invoke(IPC.sessions),
  getSession: id => ipcRenderer.invoke(IPC.session, id),
  sync: () => ipcRenderer.invoke(IPC.sync),
  setWatching: enabled => ipcRenderer.invoke(IPC.watch, enabled),
  getWslStatus: () => ipcRenderer.invoke(IPC.wslStatus),
  redetectWsl: () => ipcRenderer.invoke(IPC.wslRedetect),
  getSettings: () => ipcRenderer.invoke(IPC.settings),
  saveSettings: update => ipcRenderer.invoke(IPC.settingsSave, update),
  chooseDataDirectory: () => ipcRenderer.invoke(IPC.chooseDataDirectory),
  openDataDirectory: () => ipcRenderer.invoke(IPC.openDataDirectory),
  openSettingsDirectory: () => ipcRenderer.invoke(IPC.openSettingsDirectory),
  clearAgentResults: () => ipcRenderer.invoke(IPC.clearAgentResults),
  restartApp: () => ipcRenderer.invoke(IPC.restart),
  testLlm: () => ipcRenderer.invoke(IPC.llmTest),
  embeddingStatus: () => ipcRenderer.invoke(IPC.embeddingStatus),
  runAgent: request => ipcRenderer.invoke(IPC.agentRun, request),
  getAgentResults: () => ipcRenderer.invoke(IPC.agentResults),
  exportConversations: () => ipcRenderer.invoke(IPC.exportConversations),
  getConversationTree: () => ipcRenderer.invoke(IPC.conversationTree),
  recallSessions: (query, topK) => ipcRenderer.invoke(IPC.recallSessions, query, topK),
  getProjectStates: () => ipcRenderer.invoke(IPC.projectStates),
  getProjectBrief: projectKey => ipcRenderer.invoke(IPC.projectBrief, projectKey),
  getFileTimeline: query => ipcRenderer.invoke(IPC.fileTimeline, query),
  getExtensionBridgeStatus: () => ipcRenderer.invoke(IPC.extensionBridgeStatus),
  createExtensionPairCode: () => ipcRenderer.invoke(IPC.extensionPairCodeCreate),
  openExtensionPairingWindow: () => ipcRenderer.invoke(IPC.extensionPairingWindowOpen),
  disconnectExtensionClient: clientId => ipcRenderer.invoke(IPC.extensionClientDisconnect, clientId),
  getAgentMcpStatus: () => ipcRenderer.invoke(IPC.agentMcpStatus),
  registerAgentMcp: id => ipcRenderer.invoke(IPC.agentMcpRegister, id),
  unregisterAgentMcp: id => ipcRenderer.invoke(IPC.agentMcpUnregister, id),
  reportExtensionImportResult: (result: ExtensionImportResultPayload) =>
    ipcRenderer.invoke(IPC.extensionImportResult, result),
  onExtensionImportRequest: listener => {
    const wrapped = (_event: unknown, payload: ExtensionImportRequestPayload) => listener(payload);
    ipcRenderer.on(IPC.extensionImportRequest, wrapped);
    return () => ipcRenderer.removeListener(IPC.extensionImportRequest, wrapped);
  },
  onExtensionBridgeChanged: callback => {
    const listener = () => callback();
    ipcRenderer.on(IPC.extensionBridgeChanged, listener);
    return () => ipcRenderer.removeListener(IPC.extensionBridgeChanged, listener);
  },
  onCaptureChanged: callback => {
    const listener = () => callback();
    ipcRenderer.on(IPC.changed, listener);
    return () => ipcRenderer.removeListener(IPC.changed, listener);
  },
  chooseDirectory: title => ipcRenderer.invoke(IPC.chooseDirectory, title),
  writeUpstreamFile: request => ipcRenderer.invoke(IPC.upstreamWriteFile, request),
  testNotionConnection: () => ipcRenderer.invoke(IPC.notionTest),
  exportNotionPage: request => ipcRenderer.invoke(IPC.notionExport, request),
  prepareRelayCliCommands: request => ipcRenderer.invoke(IPC.relayPrepareCli, request),
  enqueueRelayOutbox: request => ipcRenderer.invoke(IPC.relayOutboxEnqueue, request),
  getRelaySessionContexts: sessionIds => ipcRenderer.invoke(IPC.relaySessionContexts, sessionIds),
  getRelayFileTouches: sessionIds => ipcRenderer.invoke(IPC.relayFileTouches, sessionIds),
};

const uiPrefs: VestiUiPrefsApi = {
  getUiPreference: key => ipcRenderer.invoke(IPC.uiPrefGet, key),
  setUiPreference: (key, value) => ipcRenderer.invoke(IPC.uiPrefSet, key, value),
  onUiPreferenceChanged: listener => {
    const wrapped = (_event: unknown, key: string, value: unknown) => listener(key, value);
    ipcRenderer.on(IPC.uiPrefChanged, wrapped);
    return () => ipcRenderer.removeListener(IPC.uiPrefChanged, wrapped);
  },
};

contextBridge.exposeInMainWorld('vesti', api);
contextBridge.exposeInMainWorld('vestiUi', uiPrefs);

const capsule: VestiCapsuleApi = {
  getState: () => ipcRenderer.invoke(IPC.capsuleState),
  sync: () => ipcRenderer.invoke(IPC.capsuleSync),
  toggleWatch: () => ipcRenderer.invoke(IPC.capsuleToggleWatch),
  openMainWindow: () => ipcRenderer.invoke(IPC.capsuleOpenMain),
  hideCapsule: () => ipcRenderer.invoke(IPC.capsuleHide),
  setExpanded: expanded => ipcRenderer.invoke(IPC.capsuleSetExpanded, expanded),
  dragStart: (screenX, screenY) => ipcRenderer.send(IPC.capsuleDragStart, screenX, screenY),
  dragCancel: () => ipcRenderer.send(IPC.capsuleDragCancel),
  dragMove: (screenX, screenY) => ipcRenderer.send(IPC.capsuleDragMove, screenX, screenY),
  dragEnd: (screenX, screenY) => ipcRenderer.invoke(IPC.capsuleDragEnd, screenX, screenY),
  showContextMenu: labels => ipcRenderer.send(IPC.capsuleContextMenu, labels ?? null),
  onStateChanged: listener => {
    const wrapped = (_event: unknown, state: CapsuleState) => listener(state);
    ipcRenderer.on(IPC.capsuleStateChanged, wrapped);
    return () => ipcRenderer.removeListener(IPC.capsuleStateChanged, wrapped);
  },
  // ---- P6 dock ----
  getDockStatus: () => ipcRenderer.invoke(IPC.capsuleDockStatus),
  quickAsk: (question, options) => ipcRenderer.invoke(IPC.capsuleQuickAsk, question, options),
  getProjects: () => ipcRenderer.invoke(IPC.capsuleProjects),
  buildRelayDraft: request => ipcRenderer.invoke(IPC.capsuleRelayDraft, request),
  relayAiPolish: draft => ipcRenderer.invoke(IPC.capsuleRelayPolish, draft),
  searchPrompts: query => ipcRenderer.invoke(IPC.capsuleSearchPrompts, query),
  improvePrompt: (body, instruction) => ipcRenderer.invoke(IPC.capsulePromptImprove, body, instruction),
  continuePrompt: body => ipcRenderer.invoke(IPC.capsulePromptContinue, body),
  getPromptSnapshot: () => ipcRenderer.invoke(IPC.capsulePromptSnapshotGet),
  savePromptSnapshot: snapshot => ipcRenderer.invoke(IPC.capsulePromptSnapshotSave, snapshot),
  enqueueOutbox: prompt => ipcRenderer.invoke(IPC.relayOutboxEnqueue, { prompt }),
  prepareRelayCli: request => ipcRenderer.invoke(IPC.relayPrepareCli, request),
  copyText: text => ipcRenderer.invoke(IPC.capsuleCopyText, text),
  setPanelHeight: height => ipcRenderer.invoke(IPC.capsulePanelHeight, height),
};

contextBridge.exposeInMainWorld('vestiCapsule', capsule);

