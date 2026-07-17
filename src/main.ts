import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  session,
  shell,
  Tray,
} from 'electron';
import path from 'node:path';
import { AgentService } from './main/agentService';
import { CaptureService } from './main/captureService';
import { CapsuleWindowService } from './main/capsuleWindowService';
import { SettingsService } from './main/settingsService';
import { UiPrefsService } from './main/uiPrefsService';
import { IPC, type AgentRunRequest, type AppSettingsUpdate, type CapturePlatform } from './shared/contracts';

const PRIMARY_PLATFORMS: CapturePlatform[] = ['codex', 'cursor', 'kimi-code'];
let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;
const capture = new CaptureService();
let settings: SettingsService;
let agent: AgentService;
const uiPrefs = new UiPrefsService();
let capsule: CapsuleWindowService;

function assetPath(fileName: string): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, fileName)
    : path.join(process.cwd(), 'assets', fileName);
}

function broadcastChange(): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC.changed);
  capsule?.pushState();
  updateTrayMenu();
}

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    void createWindow().then(updateTrayMenu);
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  updateTrayMenu();
}

function updateTrayMenu(): void {
  if (!tray || !settings) return;
  const visible = Boolean(mainWindow?.isVisible());
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: visible ? '隐藏 Vesti' : '打开 Vesti', click: () => visible ? mainWindow?.hide() : showMainWindow() },
    { label: '立即同步', click: () => void capture.syncAll().then(broadcastChange).catch(console.error) },
    {
      label: '实时采集',
      type: 'checkbox',
      checked: capture.isWatching,
      click: item => void capture.setWatching(item.checked).then(broadcastChange).catch(console.error),
    },
    {
      label: '显示悬浮球',
      type: 'checkbox',
      checked: capsule ? capsule.isEnabled() : false,
      click: item => void capsule.setEnabled(item.checked).catch(console.error),
    },
    { type: 'separator' },
    { label: '退出 Vesti', click: () => { isQuitting = true; app.quit(); } },
  ]));
}

function createTray(): void {
  if (tray) return;
  tray = new Tray(assetPath(process.platform === 'win32' ? 'icon.ico' : 'icon.png'));
  tray.setToolTip('Vesti · AI 会话记忆');
  tray.on('click', showMainWindow);
  tray.on('double-click', showMainWindow);
  updateTrayMenu();
}

function validSessionId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 2 && value.length < 240 && /^[\w:.-]+$/.test(value);
}

function validAgentRequest(value: unknown): value is AgentRunRequest {
  if (!value || typeof value !== 'object') return false;
  const request = value as Partial<AgentRunRequest>;
  return (request.kind === 'summary' || request.kind === 'explore')
    && validSessionId(request.sessionId)
    && (request.question === undefined || typeof request.question === 'string');
}

function validSettingsUpdate(value: unknown): value is AppSettingsUpdate {
  if (!value || typeof value !== 'object') return false;
  const update = value as Partial<AppSettingsUpdate>;
  if (typeof update.dataDirectory !== 'string' || !update.llm || !update.general
    || !update.capture || !update.network || !update.agent) return false;
  const platforms = update.capture.enabledPlatforms;
  return (update.llm.mode === 'demo_proxy' || update.llm.mode === 'custom_byok')
    && typeof update.llm.baseUrl === 'string'
    && typeof update.llm.modelId === 'string'
    && typeof update.llm.temperature === 'number'
    && typeof update.llm.maxTokens === 'number'
    && (update.llm.apiKey === undefined || typeof update.llm.apiKey === 'string')
    && (update.llm.clearApiKey === undefined || typeof update.llm.clearApiKey === 'boolean')
    && typeof update.general.launchAtLogin === 'boolean'
    && typeof update.general.startMinimized === 'boolean'
    && typeof update.general.closeToTray === 'boolean'
    && typeof update.capture.watchOnStartup === 'boolean'
    && Array.isArray(platforms)
    && platforms.every(platform => PRIMARY_PLATFORMS.includes(platform))
    && ['system', 'direct', 'custom'].includes(update.network.proxyMode)
    && typeof update.network.proxyUrl === 'string'
    && ['zh-CN', 'en-US'].includes(update.agent.outputLanguage)
    && typeof update.agent.includeThinking === 'boolean'
    && typeof update.agent.includeToolDetails === 'boolean'
    && typeof update.agent.customInstructions === 'string';
}

async function openDirectory(directory: string): Promise<void> {
  const error = await shell.openPath(directory);
  if (error) throw new Error(error);
}

async function applyProxySettings(): Promise<void> {
  const network = settings.network;
  if (network.proxyMode === 'direct') {
    await session.defaultSession.setProxy({ mode: 'direct' });
  } else if (network.proxyMode === 'custom') {
    await session.defaultSession.setProxy({ mode: 'fixed_servers', proxyRules: network.proxyUrl });
  } else {
    await session.defaultSession.setProxy({ mode: 'system' });
  }
  await session.defaultSession.closeAllConnections();
}

function applyGeneralSettings(): void {
  if (!app.isPackaged) return;
  const general = settings.general;
  app.setLoginItemSettings({
    openAtLogin: general.launchAtLogin,
    path: process.execPath,
    args: general.startMinimized ? ['--hidden'] : [],
  });
}

function registerIpc(): void {
  ipcMain.handle(IPC.overview, () => capture.getOverview());
  ipcMain.handle(IPC.sessions, () => capture.getSessions());
  ipcMain.handle(IPC.session, (_event, id: unknown) => {
    if (!validSessionId(id)) throw new Error('Invalid session id');
    return capture.getSession(id);
  });
  ipcMain.handle(IPC.sync, () => capture.syncAll());
  ipcMain.handle(IPC.watch, async (_event, enabled: unknown) => {
    const watching = await capture.setWatching(enabled === true);
    updateTrayMenu();
    return watching;
  });
  ipcMain.handle(IPC.settings, () => settings.getView(capture.activeDataDirectory));
  ipcMain.handle(IPC.settingsSave, async (_event, update: unknown) => {
    if (!validSettingsUpdate(update)) throw new Error('设置数据无效');
    const result = await settings.save(update, capture.activeDataDirectory);
    capture.setEnabledPlatforms(result.settings.capture.enabledPlatforms);
    await applyProxySettings();
    applyGeneralSettings();
    updateTrayMenu();
    return result;
  });
  ipcMain.handle(IPC.chooseDataDirectory, async () => {
    const options: Electron.OpenDialogOptions = {
      title: '选择 Vesti 内容数据目录',
      defaultPath: settings.dataDirectory,
      properties: ['openDirectory', 'createDirectory'],
    };
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  ipcMain.handle(IPC.openDataDirectory, () => openDirectory(capture.activeDataDirectory));
  ipcMain.handle(IPC.openSettingsDirectory, () => openDirectory(settings.getView(capture.activeDataDirectory).settingsDirectory));
  ipcMain.handle(IPC.clearAgentResults, async () => {
    await agent.clearResults();
  });
  ipcMain.handle(IPC.restart, () => {
    isQuitting = true;
    app.relaunch();
    app.exit(0);
  });
  ipcMain.handle(IPC.llmTest, () => agent.test());
  ipcMain.handle(IPC.agentRun, (_event, request: unknown) => {
    if (!validAgentRequest(request)) throw new Error('Agent 请求无效');
    return agent.run(request);
  });
  ipcMain.handle(IPC.agentResults, () => agent.listResults());
  ipcMain.handle(IPC.exportConversations, () => capture.exportConversations());
  ipcMain.handle(IPC.uiPrefGet, (_event, key: unknown) => {
    if (typeof key !== 'string') throw new Error('Invalid preference key');
    return uiPrefs.get(key) ?? null;
  });
  ipcMain.handle(IPC.uiPrefSet, async (_event, key: unknown, value: unknown) => {
    if (typeof key !== 'string') throw new Error('Invalid preference key');
    await uiPrefs.set(key, value);
  });
  ipcMain.handle(IPC.capsuleState, () => capsule.getState());
  ipcMain.handle(IPC.capsuleSync, async () => {
    await capture.syncAll();
    broadcastChange();
  });
  ipcMain.handle(IPC.capsuleToggleWatch, async () => {
    const watching = await capture.setWatching(!capture.isWatching);
    broadcastChange();
    return watching;
  });
  ipcMain.handle(IPC.capsuleOpenMain, () => showMainWindow());
  ipcMain.handle(IPC.capsuleHide, () => capsule.setEnabled(false));
  ipcMain.handle(IPC.capsuleSetExpanded, (_event, expanded: unknown) =>
    capsule.setExpanded(expanded === true));
  ipcMain.on(IPC.capsuleDragMove, (_event, x: unknown, y: unknown) => {
    if (typeof x === 'number' && typeof y === 'number') capsule.handleDragMove(x, y);
  });
  ipcMain.handle(IPC.capsuleDragEnd, async (_event, x: unknown, y: unknown) => {
    if (typeof x === 'number' && typeof y === 'number') await capsule.handleDragEnd(x, y);
  });
  ipcMain.on(IPC.capsuleContextMenu, () => {
    capsule.showContextMenu({
      open: '打开 Vesti',
      sync: '立即同步',
      watching: '实时采集',
      hide: '隐藏悬浮球',
    });
  });
}

async function createWindow(): Promise<void> {
  const startedFromLogin = process.argv.includes('--hidden');
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1040,
    minHeight: 680,
    show: !(startedFromLogin && settings.general.startMinimized),
    backgroundColor: '#f4f1ea',
    icon: assetPath(process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  });
  mainWindow.on('close', event => {
    if (!isQuitting && settings.general.closeToTray) {
      event.preventDefault();
      mainWindow?.hide();
      updateTrayMenu();
    }
  });
  mainWindow.on('show', updateTrayMenu);
  mainWindow.on('hide', updateTrayMenu);
  mainWindow.on('closed', () => {
    mainWindow = null;
    // The capsule window keeps the process alive; without close-to-tray the
    // main window closing is the user's quit signal.
    if (!isQuitting && settings && !settings.general.closeToTray) {
      isQuitting = true;
      app.quit();
    }
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', event => event.preventDefault());
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    await mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    await mainWindow.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
  }
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();
app.on('second-instance', showMainWindow);

app.whenReady().then(async () => {
  app.setAppUserModelId('com.vesti.desktop');
  settings = new SettingsService(app.getPath('userData'), app.getVersion());
  await settings.initialize();
  await uiPrefs.initialize(app.getPath('userData'), (key, value) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(IPC.uiPrefChanged, key, value);
    }
    if (key === 'capsule.enabled' && capsule) {
      if (value === false) void capsule.hide();
      else void capsule.show();
    }
    updateTrayMenu();
  });
  capsule = new CapsuleWindowService({
    getState: () => capture.getCaptureState(),
    sync: () => capture.syncAll(),
    toggleWatch: () => capture.setWatching(!capture.isWatching),
    openMainWindow: () => showMainWindow(),
    loadPreference: key => uiPrefs.get(key),
    savePreference: (key, value) => uiPrefs.set(key, value),
    iconPath: () => assetPath(process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
  });
  await applyProxySettings();
  applyGeneralSettings();
  await capture.initialize(broadcastChange, settings.dataDirectory, settings.capture.enabledPlatforms);
  agent = new AgentService(capture, settings);
  registerIpc();
  await createWindow();
  if (capsule.isEnabled()) void capsule.show().catch(console.error);
  createTray();
  void capture.syncAll().then(broadcastChange).catch(console.error);
  if (settings.capture.watchOnStartup) void capture.setWatching(true).then(updateTrayMenu).catch(console.error);
  app.on('activate', showMainWindow);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && (!settings || !settings.general.closeToTray)) app.quit();
});
app.on('before-quit', () => {
  isQuitting = true;
  tray?.destroy();
  tray = null;
  if (agent) void capture.close().catch(console.error);
});
