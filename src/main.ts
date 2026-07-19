import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  safeStorage,
  session,
  shell,
  Tray,
} from 'electron';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { AgentService } from './main/agentService';
import { CaptureService } from './main/captureService';
import { CapsuleWindowService } from './main/capsuleWindowService';
import { DigestService } from './main/digestService';
import { EmbeddingService } from './main/embeddingService';
import { ExtensionBridgeService, MAX_OUTBOX_PROMPT_CHARS } from './main/extensionBridgeService';
import { NotionService } from './main/notionService';
import { SettingsService } from './main/settingsService';
import { UiPrefsService } from './main/uiPrefsService';
import { writeUpstreamExportFile } from './main/vaultExportService';
import {
  IPC,
  type AgentRunRequest,
  type AppSettingsUpdate,
  type CapturePlatform,
  type ExtensionImportRequestPayload,
  type ExtensionImportResultPayload,
  type NotionExportRequest,
  type RelayOutboxEnqueueRequest,
  type RelayPrepareCliRequest,
  type RelayPrepareCliResult,
  type UpstreamWriteFileRequest,
} from './shared/contracts';

const PRIMARY_PLATFORMS: CapturePlatform[] = ['codex', 'cursor', 'kimi-code', 'claude-code'];
// Startup background mirrors tokens.css --bg-tertiary (the app shell surface)
// so the window never flashes a foreign color before the renderer paints.
const WINDOW_BACKGROUND_LIGHT = '#f8f9fb'; // hsl(220 30% 98%)
const WINDOW_BACKGROUND_DARK = '#1a1a1a'; // hsl(0 0% 10%)
let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;
const capture = new CaptureService();
let settings: SettingsService;
let agent: AgentService;
let embedding: EmbeddingService;
let digest: DigestService;
let notion: NotionService;
const uiPrefs = new UiPrefsService();
let capsule: CapsuleWindowService;
let extensionBridge: ExtensionBridgeService;

// Pending /v1/import requests waiting for the renderer's idempotent import to
// finish. Resolved by the IPC.extensionImportResult handler below.
const pendingExtensionImports = new Map<string, {
  resolve: (result: ExtensionImportResultPayload) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}>();

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

function broadcastBridgeChange(): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC.extensionBridgeChanged);
}

// The bridge HTTP server runs even when the main window is hidden/closed
// (tray mode); recreate the window so the renderer can run the Dexie import.
async function ensureRendererWindow(): Promise<BrowserWindow> {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.webContents.isLoading()) {
      await new Promise<void>(resolve => mainWindow!.webContents.once('did-finish-load', resolve));
    }
    return mainWindow;
  }
  await createWindow();
  return mainWindow!;
}

function forwardExtensionImport(bundle: unknown, since: string | undefined): Promise<ExtensionImportResultPayload> {
  return (async () => {
    const target = await ensureRendererWindow();
    const requestId = randomUUID();
    return new Promise<ExtensionImportResultPayload>((resolve, reject) => {
      // Safety net only; the bridge answers 202 after its own 60s timeout.
      const timer = setTimeout(() => {
        pendingExtensionImports.delete(requestId);
        reject(new Error('renderer did not finish the extension import in time'));
      }, 5 * 60_000);
      pendingExtensionImports.set(requestId, { resolve, reject, timer });
      const payload: ExtensionImportRequestPayload = { requestId, bundle, since };
      target.webContents.send(IPC.extensionImportRequest, payload);
    });
  })();
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
  return (request.kind === 'summary' || request.kind === 'explore' || request.kind === 'digest' || request.kind === 'classify' || request.kind === 'relay' || request.kind === 'extract' || request.kind === 'distill' || request.kind === 'daily' || request.kind === 'persona')
    && validSessionId(request.sessionId)
    && (request.question === undefined || typeof request.question === 'string')
    && (request.template === undefined || (typeof request.template === 'string' && request.template.length <= 64))
    && (request.transcriptOverride === undefined
      || (typeof request.transcriptOverride === 'string' && request.transcriptOverride.length <= 30_000))
    && (request.persist === undefined || typeof request.persist === 'boolean');
}

function validSettingsUpdate(value: unknown): value is AppSettingsUpdate {
  if (!value || typeof value !== 'object') return false;
  const update = value as Partial<AppSettingsUpdate>;
  if (typeof update.dataDirectory !== 'string' || !update.llm || !update.general
    || !update.capture || !update.network || !update.agent || !update.upstream) return false;
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
    && typeof update.agent.customInstructions === 'string'
    && typeof update.upstream.obsidianVaultPath === 'string'
    && typeof update.upstream.obsidianAutoExport === 'boolean'
    && typeof update.upstream.notionParentId === 'string'
    && (update.upstream.notionParentType === 'page' || update.upstream.notionParentType === 'database')
    && typeof update.upstream.notionTitleProperty === 'string'
    && (update.upstream.notionToken === undefined || typeof update.upstream.notionToken === 'string')
    && (update.upstream.clearNotionToken === undefined || typeof update.upstream.clearNotionToken === 'boolean');
}

function validUpstreamWriteRequest(value: unknown): value is UpstreamWriteFileRequest {
  if (!value || typeof value !== 'object') return false;
  const request = value as Partial<UpstreamWriteFileRequest>;
  return typeof request.rootPath === 'string'
    && typeof request.relativePath === 'string'
    && typeof request.content === 'string'
    && request.content.length <= 5 * 1024 * 1024
    && (request.previousRelativePath === undefined || typeof request.previousRelativePath === 'string')
    && (request.expectedUuid === undefined || typeof request.expectedUuid === 'string');
}

function validNotionExportRequest(value: unknown): value is NotionExportRequest {
  if (!value || typeof value !== 'object') return false;
  const request = value as Partial<NotionExportRequest>;
  return typeof request.title === 'string'
    && (request.iconEmoji === undefined || typeof request.iconEmoji === 'string')
    && Array.isArray(request.blocks)
    && request.blocks.length <= 5_000
    && request.blocks.every(
      block => Boolean(block) && typeof block === 'object' && typeof (block as { type?: unknown }).type === 'string',
    )
    && (request.existingPageId === undefined
      || request.existingPageId === null
      || typeof request.existingPageId === 'string');
}

function validRelayPrepareCliRequest(value: unknown): value is RelayPrepareCliRequest {
  if (!value || typeof value !== 'object') return false;
  const request = value as Partial<RelayPrepareCliRequest>;
  return Number.isInteger(request.id)
    && (request.id as number) >= 1
    && typeof request.slug === 'string'
    && typeof request.markdown === 'string'
    && request.markdown.length > 0
    && request.markdown.length <= 1024 * 1024;
}

function validRelayOutboxEnqueueRequest(value: unknown): value is RelayOutboxEnqueueRequest {
  if (!value || typeof value !== 'object') return false;
  const request = value as Partial<RelayOutboxEnqueueRequest>;
  return typeof request.prompt === 'string'
    && request.prompt.trim().length > 0
    && request.prompt.length <= MAX_OUTBOX_PROMPT_CHARS;
}

// CLIs the relay panel offers one-click launch commands for.
const RELAY_CLI_TARGETS: Array<{ id: string; label: string }> = [
  { id: 'kimi', label: 'Kimi CLI' },
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
];

function sanitizeRelaySlug(value: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = value
    .replace(/[<>:"/\\|?*^#[\]\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, 40);
  return cleaned || 'relay-pack';
}

/**
 * P4a relay: writes the pack Markdown into the app's own relay directory
 * (<activeDataDir>/relay, i.e. ~/.vesti/relay by default). This is app-owned
 * storage, not the user-chosen vault root, so it deliberately does NOT go
 * through the restricted upstream write path. Returns copyable CLI launch
 * commands that read the file into the CLI's prompt.
 */
async function writeRelaySharedFile(request: RelayPrepareCliRequest): Promise<RelayPrepareCliResult> {
  const directory = path.join(capture.activeDataDirectory, 'relay');
  await fs.mkdir(directory, { recursive: true });
  const filePath = path.join(directory, `${request.id}-${sanitizeRelaySlug(request.slug)}.md`);
  const temporary = `${filePath}.tmp`;
  await fs.writeFile(temporary, request.markdown, 'utf8');
  await fs.rm(filePath, { force: true });
  await fs.rename(temporary, filePath);
  const displayPath = filePath.split(path.sep).join('/');
  return {
    filePath,
    commands: RELAY_CLI_TARGETS.map((target) => ({
      ...target,
      command: `${target.id} "$(cat '${displayPath}')"`,
    })),
  };
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
  // Custom title bar window controls. Resolve the sender's window so the
  // handlers stay correct no matter which window invoked them.
  ipcMain.on(IPC.windowMinimize, event => {
    BrowserWindow.fromWebContents(event.sender)?.minimize();
  });
  ipcMain.on(IPC.windowToggleMaximize, event => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) return;
    if (window.isMaximized()) window.unmaximize();
    else window.maximize();
  });
  ipcMain.on(IPC.windowClose, event => {
    BrowserWindow.fromWebContents(event.sender)?.close();
  });
  ipcMain.handle(IPC.windowIsMaximized, event =>
    BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false);
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
  ipcMain.handle(IPC.wslStatus, () => capture.getWslStatus());
  ipcMain.handle(IPC.wslRedetect, () => capture.redetectWsl());
  ipcMain.handle(IPC.settings, () => settings.getView(capture.activeDataDirectory));
  ipcMain.handle(IPC.settingsSave, async (_event, update: unknown) => {
    if (!validSettingsUpdate(update)) throw new Error('设置数据无效');
    const result = await settings.save(update, capture.activeDataDirectory);
    embedding.invalidateStatus();
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
  ipcMain.handle(IPC.chooseDirectory, async (_event, title: unknown) => {
    const options: Electron.OpenDialogOptions = {
      title: typeof title === 'string' && title.trim() ? title : '选择目录',
      properties: ['openDirectory', 'createDirectory'],
    };
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  ipcMain.handle(IPC.upstreamWriteFile, (_event, request: unknown) => {
    if (!validUpstreamWriteRequest(request)) throw new Error('导出写入请求无效');
    return writeUpstreamExportFile(request);
  });
  ipcMain.handle(IPC.notionTest, () => notion.testConnection());
  ipcMain.handle(IPC.notionExport, (_event, request: unknown) => {
    if (!validNotionExportRequest(request)) throw new Error('Notion 导出请求无效');
    return notion.exportPage(request);
  });
  ipcMain.handle(IPC.relayPrepareCli, (_event, request: unknown) => {
    if (!validRelayPrepareCliRequest(request)) throw new Error('交接包写入请求无效');
    return writeRelaySharedFile(request);
  });
  ipcMain.handle(IPC.relayOutboxEnqueue, async (_event, request: unknown) => {
    if (!validRelayOutboxEnqueueRequest(request)) throw new Error('交接包投递请求无效');
    if (extensionBridge.getStatus().clients.length === 0) {
      throw new Error('没有已配对的浏览器扩展，请先在扩展桥设置中完成配对');
    }
    const item = await extensionBridge.enqueueOutbox(request.prompt);
    return { id: item.id };
  });
  ipcMain.handle(IPC.clearAgentResults, async () => {
    await agent.clearResults();
  });
  ipcMain.handle(IPC.restart, () => {
    isQuitting = true;
    app.relaunch();
    app.exit(0);
  });
  ipcMain.handle(IPC.llmTest, () => agent.test());
  ipcMain.handle(IPC.embeddingStatus, () => embedding.getStatus());
  ipcMain.handle(IPC.agentRun, (_event, request: unknown) => {
    if (!validAgentRequest(request)) throw new Error('Agent 请求无效');
    return agent.run(request, { persist: request.persist });
  });
  ipcMain.handle(IPC.agentResults, () => agent.listResults());
  ipcMain.handle(IPC.exportConversations, () => capture.exportConversations());
  ipcMain.handle(IPC.conversationTree, () => capture.getConversationTree());
  ipcMain.handle(IPC.recallSessions, async (_event, query: unknown, topK: unknown) => {
    if (typeof query !== 'string' || !query.trim()) throw new Error('Invalid recall query');
    const limit = typeof topK === 'number' && Number.isInteger(topK) && topK >= 1 && topK <= 20 ? topK : 5;
    // The query vector is best-effort: without a reachable embedding endpoint
    // recall silently falls back to the pure-FTS path.
    const vector = await embedding.embed([query.trim()]).then(vectors => vectors[0] ?? null).catch(() => null);
    return capture.recallSessions(query.trim(), limit, vector);
  });
  ipcMain.handle(IPC.extensionBridgeStatus, () => extensionBridge.getStatus());
  ipcMain.handle(IPC.extensionPairCodeCreate, () => extensionBridge.createPairCode());
  ipcMain.handle(IPC.extensionClientDisconnect, (_event, clientId: unknown) => {
    if (typeof clientId !== 'string' || !clientId) throw new Error('Invalid client id');
    return extensionBridge.disconnectClient(clientId);
  });
  ipcMain.handle(IPC.extensionImportResult, (_event, result: unknown) => {
    if (!result || typeof result !== 'object') return;
    const payload = result as ExtensionImportResultPayload;
    if (typeof payload.requestId !== 'string') return;
    const pending = pendingExtensionImports.get(payload.requestId);
    if (!pending) return;
    pendingExtensionImports.delete(payload.requestId);
    clearTimeout(pending.timer);
    if (payload.error) pending.reject(new Error(payload.error));
    else pending.resolve(payload);
  });
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
    backgroundColor: uiPrefs.get('theme') === 'dark' ? WINDOW_BACKGROUND_DARK : WINDOW_BACKGROUND_LIGHT,
    icon: assetPath(process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    // Windows/Linux use a fully custom in-page title bar; macOS keeps the
    // native traffic lights inset over the same TitleBar drag strip.
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const } : { frame: false }),
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
  mainWindow.on('maximize', () => {
    mainWindow?.webContents.send(IPC.windowMaximizedChanged, true);
  });
  mainWindow.on('unmaximize', () => {
    mainWindow?.webContents.send(IPC.windowMaximizedChanged, false);
  });
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
    if (key === 'theme' && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setBackgroundColor(value === 'dark' ? WINDOW_BACKGROUND_DARK : WINDOW_BACKGROUND_LIGHT);
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
  embedding = new EmbeddingService(settings);
  digest = new DigestService(capture, agent, embedding);
  notion = new NotionService(settings);
  capture.setSyncCompletedListener(() => digest.requestScan());
  digest.start();
  extensionBridge = new ExtensionBridgeService({
    appVersion: app.getVersion(),
    port: settings.getBridgePort(),
    encrypt: plain => {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('safe storage unavailable');
      return safeStorage.encryptString(plain).toString('base64');
    },
    decrypt: payload => safeStorage.decryptString(Buffer.from(payload, 'base64')),
    loadClients: () => settings.getBridgeClients(),
    saveClients: clients => settings.saveBridgeClients(clients),
    loadOutbox: () => settings.getBridgeOutbox(),
    saveOutbox: items => settings.saveBridgeOutbox(items),
    importBundle: (bundle, since) =>
      forwardExtensionImport(bundle, since).then(result => ({
        conversations: result.conversations,
        messages: result.messages,
        maxCapturedAt: result.maxCapturedAt,
      })),
    onClientsChanged: broadcastBridgeChange,
    log: line => console.log(`[vesti] ${line}`),
  });
  registerIpc();
  await createWindow();
  // Loopback bridge for the browser extension; failure (e.g. port taken) only
  // degrades the bridge, never app startup.
  void extensionBridge.start();
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
  if (extensionBridge) void extensionBridge.stop().catch(console.error);
  if (agent) void capture.close().catch(console.error);
});
