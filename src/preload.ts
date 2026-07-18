import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type CapsuleState, type VestiCapsuleApi, type VestiDesktopApi, type VestiUiPrefsApi } from './shared/contracts';

const api: VestiDesktopApi = {
  getOverview: () => ipcRenderer.invoke(IPC.overview),
  getSessions: () => ipcRenderer.invoke(IPC.sessions),
  getSession: id => ipcRenderer.invoke(IPC.session, id),
  sync: () => ipcRenderer.invoke(IPC.sync),
  setWatching: enabled => ipcRenderer.invoke(IPC.watch, enabled),
  getSettings: () => ipcRenderer.invoke(IPC.settings),
  saveSettings: update => ipcRenderer.invoke(IPC.settingsSave, update),
  chooseDataDirectory: () => ipcRenderer.invoke(IPC.chooseDataDirectory),
  openDataDirectory: () => ipcRenderer.invoke(IPC.openDataDirectory),
  openSettingsDirectory: () => ipcRenderer.invoke(IPC.openSettingsDirectory),
  clearAgentResults: () => ipcRenderer.invoke(IPC.clearAgentResults),
  restartApp: () => ipcRenderer.invoke(IPC.restart),
  testLlm: () => ipcRenderer.invoke(IPC.llmTest),
  runAgent: request => ipcRenderer.invoke(IPC.agentRun, request),
  getAgentResults: () => ipcRenderer.invoke(IPC.agentResults),
  exportConversations: () => ipcRenderer.invoke(IPC.exportConversations),
  onCaptureChanged: callback => {
    const listener = () => callback();
    ipcRenderer.on(IPC.changed, listener);
    return () => ipcRenderer.removeListener(IPC.changed, listener);
  },
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
  dragMove: (screenX, screenY) => ipcRenderer.send(IPC.capsuleDragMove, screenX, screenY),
  dragEnd: (screenX, screenY) => ipcRenderer.invoke(IPC.capsuleDragEnd, screenX, screenY),
  showContextMenu: () => ipcRenderer.send(IPC.capsuleContextMenu),
  onStateChanged: listener => {
    const wrapped = (_event: unknown, state: CapsuleState) => listener(state);
    ipcRenderer.on(IPC.capsuleStateChanged, wrapped);
    return () => ipcRenderer.removeListener(IPC.capsuleStateChanged, wrapped);
  },
};

contextBridge.exposeInMainWorld('vestiCapsule', capsule);

