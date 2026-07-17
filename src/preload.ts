import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type VestiDesktopApi } from './shared/contracts';

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
  onCaptureChanged: callback => {
    const listener = () => callback();
    ipcRenderer.on(IPC.changed, listener);
    return () => ipcRenderer.removeListener(IPC.changed, listener);
  },
};

contextBridge.exposeInMainWorld('vesti', api);
