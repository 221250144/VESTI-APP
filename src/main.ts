import {
  app,
  BrowserWindow,
  clipboard,
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
import { ProjectMemoryService } from './main/projectMemoryService';
import { EmbeddingService } from './main/embeddingService';
import { ExtensionBridgeService, MAX_OUTBOX_PROMPT_CHARS } from './main/extensionBridgeService';
import { NotionService } from './main/notionService';
import { SettingsService } from './main/settingsService';
import { UiPrefsService } from './main/uiPrefsService';
import { writeUpstreamExportFile } from './main/vaultExportService';
import {
  assembleCapsuleRelayDraft,
  appendQuickAskHistory,
  buildQuickAskTranscript,
  CAPSULE_DRAFT_MAX_SESSIONS,
  CAPSULE_QUICK_ASK_MAX_CHARS,
  CAPSULE_SEARCH_LIMIT,
  normalizePromptSnapshot,
  normalizeRelayDraftRequest,
  searchCapsulePrompts,
  type CapsuleCuratedPromptInput,
  type CapsuleDraftSessionInput,
} from './main/capsuleDock';
import type { RelayPackPayload } from './main/agentPrompts';
import { resolveCuratedPrompts } from './ui/promptPlaza/commonPrompts';
import {
  IPC,
  type AgentRunRequest,
  type AppSettingsUpdate,
  type CapturePlatform,
  type CapsuleContextMenuLabels,
  type CapsuleProjectView,
  type CapsulePromptContinueResult,
  type CapsulePromptImproveResult,
  type CapsulePromptSnapshot,
  type CapsuleQuickAskOptions,
  type CapsuleQuickAskTurn,
  type CapsuleRelayDraft,
  type CapsuleRelaySessionView,
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
let projectMemory: ProjectMemoryService;
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

// TOFU association prompts the user denied: don't nag the same extension
// client again for a while (in-memory only — a restart resets it).
const ASSOCIATION_DENIAL_COOLDOWN_MS = 10 * 60 * 1000;
const associationDenials = new Map<string, number>();

/** Bridge Protocol v1.2 confirm callback: native one-tap TOFU dialog. */
async function confirmExtensionAssociation(request: { client: string; clientId: string }): Promise<boolean> {
  const deniedUntil = associationDenials.get(request.clientId);
  if (deniedUntil !== undefined) {
    if (Date.now() < deniedUntil) return false;
    associationDenials.delete(request.clientId);
  }
  const target = await ensureRendererWindow();
  if (target.isMinimized()) target.restore();
  target.show();
  target.focus();
  const { response } = await dialog.showMessageBox(target, {
    type: 'warning',
    buttons: ['允许连接', '拒绝'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    title: 'VESTI 扩展连接请求',
    message: '允许 VESTI 浏览器扩展连接到此设备？',
    detail: `${request.client}（${request.clientId}）正在请求连接。\n`
      + '允许后，扩展会把你的网页端 AI 会话同步到本设备，此后长期免确认。\n'
      + '仅在你刚安装了 VESTI 扩展时点击「允许连接」。',
  });
  const allowed = response === 0;
  if (!allowed) associationDenials.set(request.clientId, Date.now() + ASSOCIATION_DENIAL_COOLDOWN_MS);
  return allowed;
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
  return (request.kind === 'summary' || request.kind === 'explore' || request.kind === 'digest' || request.kind === 'classify' || request.kind === 'relay' || request.kind === 'extract' || request.kind === 'distill' || request.kind === 'deposit-maintain' || request.kind === 'daily' || request.kind === 'persona' || request.kind === 'roundtable-turn' || request.kind === 'roundtable-synthesis' || request.kind === 'learn-deepen' || request.kind === 'prompt-improve' || request.kind === 'prompt-continue')
    && validSessionId(request.sessionId)
    && (request.question === undefined || typeof request.question === 'string')
    && (request.template === undefined || (typeof request.template === 'string' && request.template.length <= 64))
    && (request.transcriptOverride === undefined
      || (typeof request.transcriptOverride === 'string' && request.transcriptOverride.length <= 30_000))
    && (request.persist === undefined || typeof request.persist === 'boolean')
    && (request.modelId === undefined
      || (typeof request.modelId === 'string' && request.modelId.length <= 100));
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
    && ['zh-CN', 'en-US', 'ja-JP', 'ko-KR'].includes(update.agent.outputLanguage)
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

// ---- P6 capsule dock helpers ----

/** Draft/quick-ask text language follows the agent output language. */
function capsuleDraftLanguage(): 'zh-CN' | 'en-US' {
  return settings.getRuntimeAgent().outputLanguage === 'en-US' ? 'en-US' : 'zh-CN';
}

/** Prompt-catalog language follows the UI language (catalog ships zh/en). */
function capsuleUiLanguage(): 'zh' | 'en' {
  const value = uiPrefs.get('language') as { locale?: unknown } | undefined;
  return value?.locale === 'zh' ? 'zh' : 'en';
}

// The curated catalog is locale-resolved once per language and cached; the
// per-query filtering happens in the pure searchCapsulePrompts.
const curatedCache = new Map<'zh' | 'en', CapsuleCuratedPromptInput[]>();
function curatedPromptsFor(language: 'zh' | 'en'): CapsuleCuratedPromptInput[] {
  const cached = curatedCache.get(language);
  if (cached) return cached;
  const resolved = resolveCuratedPrompts(language);
  curatedCache.set(language, resolved);
  return resolved;
}

function promptSnapshotPath(): string {
  return path.join(capture.activeDataDirectory, 'cache', 'prompt-snapshot.json');
}

// undefined = not loaded yet; null = loaded and absent/invalid.
let promptSnapshotCache: CapsulePromptSnapshot | null | undefined;

async function readPromptSnapshot(): Promise<CapsulePromptSnapshot | null> {
  if (promptSnapshotCache !== undefined) return promptSnapshotCache;
  try {
    const raw = JSON.parse(await fs.readFile(promptSnapshotPath(), 'utf8')) as unknown;
    promptSnapshotCache = normalizePromptSnapshot(raw);
  } catch {
    promptSnapshotCache = null;
  }
  return promptSnapshotCache;
}

async function writePromptSnapshot(value: unknown): Promise<void> {
  const snapshot = normalizePromptSnapshot(value);
  if (!snapshot) throw new Error('提示词快照无效');
  const filePath = promptSnapshotPath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(snapshot), 'utf8');
  await fs.rm(filePath, { force: true });
  await fs.rename(temporary, filePath);
  promptSnapshotCache = snapshot;
}

/** Flatten the conversation tree into the capsule's project picker view. */
function capsuleProjectViews(): CapsuleProjectView[] {
  const tree = capture.getConversationTree();
  const projects: CapsuleProjectView[] = [];
  for (const source of tree.sources) {
    for (const project of source.projects) {
      const sorted = [...project.sessions].sort((a, b) => b.lastActivityAt - a.lastActivityAt);
      projects.push({
        platform: source.platform,
        host: source.host,
        projectKey: project.projectKey,
        label: project.label,
        pathOrDomain: project.pathOrDomain,
        sessionCount: project.sessions.length,
        recentSessions: sorted.slice(0, 5).map(session => ({
          sessionId: session.id,
          title: session.title,
          oneLiner: session.oneLiner,
          lastActivityAt: session.lastActivityAt,
        })),
      });
    }
  }
  // Most recently active projects first.
  return projects.sort(
    (a, b) => (b.recentSessions[0]?.lastActivityAt ?? 0) - (a.recentSessions[0]?.lastActivityAt ?? 0),
  );
}

function buildCapsuleRelayDraft(request: unknown): CapsuleRelayDraft {
  const normalized = normalizeRelayDraftRequest(request);
  if (!normalized) throw new Error('接力范围请求无效');
  const tree = capture.getConversationTree();

  interface LocatedSession {
    id: string;
    title: string;
    platform: string;
    projectLabel: string;
    lastActivityAt: number;
    digest: { oneLiner: string | null; keyTopics: string[]; keyFiles: string[]; decisions: string[] } | null;
  }

  const located: LocatedSession[] = [];
  const wanted = normalized.sessionIds?.length ? new Set(normalized.sessionIds) : null;
  for (const source of tree.sources) {
    for (const project of source.projects) {
      if (!wanted && (source.platform !== normalized.platform || source.host !== normalized.host
        || project.projectKey !== normalized.projectKey)) continue;
      const sorted = [...project.sessions].sort((a, b) => b.lastActivityAt - a.lastActivityAt);
      for (const session of sorted) {
        if (wanted ? !wanted.has(session.id) : located.length >= CAPSULE_DRAFT_MAX_SESSIONS) continue;
        located.push({
          id: session.id,
          title: session.title,
          platform: source.platform,
          projectLabel: project.label,
          lastActivityAt: session.lastActivityAt,
          digest: session.oneLiner || session.keyTopics.length || session.decisions.length
            ? {
                oneLiner: session.oneLiner,
                keyTopics: session.keyTopics,
                keyFiles: session.keyFiles,
                decisions: session.decisions,
              }
            : null,
        });
      }
    }
  }
  if (located.length === 0) {
    throw new Error(wanted ? '所选会话不存在，请先同步' : '所选项目不存在或暂无会话');
  }

  // Enrich with git fields + the full digest (open_questions never reaches
  // the conversation tree), mirroring the renderer relay pipeline.
  const contexts = capture.getRelaySessionContexts(located.map(session => session.id));
  const contextById = new Map(contexts.map(context => [context.sessionId, context]));
  const inputs: CapsuleDraftSessionInput[] = located.map((session) => {
    const context = contextById.get(session.id);
    const digest = context?.digest ?? (session.digest ? { ...session.digest, openQuestions: [] } : null);
    // Sessions without a digest still contribute recent message excerpts.
    let recentMessages: Array<{ role: string; content: string }> = [];
    if (!digest) {
      const detail = capture.getSession(session.id);
      recentMessages = (detail?.messages ?? [])
        .filter(message => message.contentText?.trim())
        .slice(-2)
        .map(message => ({ role: message.role, content: message.contentText ?? '' }));
    }
    return {
      sessionId: session.id,
      title: session.title,
      platform: session.platform,
      projectLabel: session.projectLabel,
      lastActivityAt: session.lastActivityAt,
      gitBranch: context?.gitBranch ?? null,
      gitRemote: context?.gitRemote ?? null,
      digest,
      recentMessages,
    };
  });

  const labels = [...new Set(inputs.map(input => input.projectLabel))];
  const language = capsuleDraftLanguage();
  const projectLabel = labels.length === 1
    ? labels[0]
    : language === 'en-US' ? 'Multiple projects' : '多个项目';
  const { text } = assembleCapsuleRelayDraft(inputs, { language, projectLabel });
  return {
    text,
    sessionCount: inputs.length,
    sessions: inputs.map(input => ({
      sessionId: input.sessionId,
      title: input.title,
      oneLiner: input.digest?.oneLiner ?? null,
      lastActivityAt: input.lastActivityAt,
    })),
  };
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
  ipcMain.handle(IPC.relaySessionContexts, (_event, sessionIds: unknown) => {
    if (!Array.isArray(sessionIds) || sessionIds.length > 50
      || !sessionIds.every(validSessionId)) {
      throw new Error('交接上下文请求无效');
    }
    return capture.getRelaySessionContexts(sessionIds);
  });
  ipcMain.handle(IPC.relayFileTouches, (_event, sessionIds: unknown) => {
    // Subagent sessions ride along with selected parents, so the id list can
    // legitimately exceed the raw selection size — allow a wider fan-out.
    if (!Array.isArray(sessionIds) || sessionIds.length > 200
      || !sessionIds.every(validSessionId)) {
      throw new Error('文件锚点请求无效');
    }
    return capture.getRelayFileTouches(sessionIds);
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
  ipcMain.handle(IPC.projectStates, () => capture.listProjectStates());
  ipcMain.handle(IPC.projectBrief, (_event, projectKey: unknown) => {
    if (typeof projectKey !== 'string' || !projectKey.trim()) throw new Error('Invalid project key');
    return capture.getProjectBrief(projectKey.trim());
  });
  ipcMain.handle(IPC.fileTimeline, (_event, query: unknown) => {
    const input = (query ?? {}) as { projectKey?: unknown; filePath?: unknown };
    if (typeof input.filePath !== 'string' || !input.filePath.trim()) throw new Error('Invalid file path');
    return capture.getFileTimeline({
      projectKey: typeof input.projectKey === 'string' && input.projectKey.trim() ? input.projectKey : undefined,
      filePath: input.filePath.trim(),
    });
  });
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
  ipcMain.handle(IPC.extensionPairingWindowOpen, () => extensionBridge.openPairingWindow());
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
  ipcMain.on(IPC.capsuleDragStart, (_event, x: unknown, y: unknown) => {
    if (typeof x === 'number' && typeof y === 'number') capsule.handleDragStart(x, y);
  });
  ipcMain.on(IPC.capsuleDragCancel, () => capsule.handleDragCancel());
  ipcMain.on(IPC.capsuleDragMove, (_event, x: unknown, y: unknown) => {
    if (typeof x === 'number' && typeof y === 'number') capsule.handleDragMove(x, y);
  });
  ipcMain.handle(IPC.capsuleDragEnd, async (_event, x: unknown, y: unknown) => {
    if (typeof x === 'number' && typeof y === 'number') await capsule.handleDragEnd(x, y);
  });
  ipcMain.on(IPC.capsuleContextMenu, (_event, labels: unknown) => {
    // The capsule renderer sends localized labels; fall back to zh defaults.
    const fallback: CapsuleContextMenuLabels = {
      open: '打开 Vesti',
      sync: '立即同步',
      watching: '实时采集',
      hide: '隐藏悬浮球',
    };
    const candidate = labels && typeof labels === 'object'
      ? (labels as Partial<CapsuleContextMenuLabels>)
      : {};
    const pick = (value: unknown, fallbackValue: string) =>
      typeof value === 'string' && value.trim() ? value.trim().slice(0, 40) : fallbackValue;
    capsule.showContextMenu({
      open: pick(candidate.open, fallback.open),
      sync: pick(candidate.sync, fallback.sync),
      watching: pick(candidate.watching, fallback.watching),
      hide: pick(candidate.hide, fallback.hide),
    });
  });

  // ---- P6 capsule dock ----
  ipcMain.handle(IPC.capsuleDockStatus, async () => {
    // getOverview re-detects sources; only fetched when the panel opens.
    const overview = await capture.getOverview().catch(() => null);
    const llm = settings.getView(capture.activeDataDirectory).llm;
    return {
      llmConfigured: llm.mode === 'demo_proxy' || llm.apiKeyConfigured,
      extensionConnected: extensionBridge.getStatus().clients.length > 0,
      sourceCount: overview
        ? overview.sources.filter(source => source.enabled && source.installed).length
        : 0,
      llmMode: llm.mode,
      defaultModelId: llm.modelId,
    };
  });
  ipcMain.handle(IPC.capsuleQuickAsk, async (_event, question: unknown, options: unknown) => {
    if (typeof question !== 'string' || !question.trim() || question.length > CAPSULE_QUICK_ASK_MAX_CHARS) {
      throw new Error('问题内容无效');
    }
    const query = question.trim();
    // Optional per-request overrides from the quick-ask panel: a model picker
    // selection and the lightweight client-side turn history.
    let modelId: string | undefined;
    let historyTurns: CapsuleQuickAskTurn[] = [];
    if (options && typeof options === 'object') {
      const candidate = options as Partial<CapsuleQuickAskOptions>;
      if (typeof candidate.modelId === 'string' && candidate.modelId.trim()) {
        modelId = candidate.modelId.trim().slice(0, 100);
      }
      if (Array.isArray(candidate.history)) {
        historyTurns = candidate.history.slice(-4).flatMap((turn) => {
          if (!turn || typeof turn !== 'object') return [];
          const entry = turn as Partial<CapsuleQuickAskTurn>;
          if (typeof entry.question !== 'string' || typeof entry.answer !== 'string') return [];
          return [{ question: entry.question.slice(0, 2_000), answer: entry.answer.slice(0, 8_000) }];
        });
      }
    }
    // Query vector is best-effort, mirroring the recall IPC above.
    const vector = await embedding.embed([query]).then(vectors => vectors[0] ?? null).catch(() => null);
    const hits = capture.recallSessions(query, 5, vector);
    const language = capsuleDraftLanguage();
    const transcript = appendQuickAskHistory(
      buildQuickAskTranscript(
        hits.map(hit => ({ title: hit.title, oneLiner: hit.oneLiner, snippet: hit.snippet })),
        { language },
      ),
      historyTurns,
      { language },
    );
    const result = await agent.run({
      kind: 'explore',
      sessionId: `capsule-ask:${Date.now()}`,
      question: query,
      transcriptOverride: transcript,
      ...(modelId ? { modelId } : {}),
      persist: false,
    }, { persist: false });
    return { answer: result.content, recalled: hits.length };
  });
  ipcMain.handle(IPC.capsuleProjects, () => capsuleProjectViews());
  ipcMain.handle(IPC.capsuleRelayDraft, (_event, request: unknown) => buildCapsuleRelayDraft(request));
  ipcMain.handle(IPC.capsuleRelayPolish, async (_event, draft: unknown) => {
    if (typeof draft !== 'string' || !draft.trim() || draft.length > 30_000) {
      throw new Error('交接草稿无效');
    }
    const result = await agent.run({
      kind: 'relay',
      sessionId: `capsule-relay:${Date.now()}`,
      transcriptOverride: draft,
      persist: false,
    }, { persist: false });
    const payload = JSON.parse(result.content) as RelayPackPayload;
    return { title: payload.title, suggestedPrompt: payload.suggested_prompt };
  });
  ipcMain.handle(IPC.capsuleSearchPrompts, async (_event, query: unknown) => {
    const normalized = typeof query === 'string' ? query.slice(0, 200) : '';
    const snapshot = await readPromptSnapshot();
    return searchCapsulePrompts({
      query: normalized,
      curated: curatedPromptsFor(capsuleUiLanguage()),
      snapshot,
      limit: CAPSULE_SEARCH_LIMIT,
    });
  });
  // Capsule prompt assistant: AI refine / continue for the picked prompt.
  // Both run through agentService with persist:false — nothing is logged.
  ipcMain.handle(IPC.capsulePromptImprove, async (_event, body: unknown, instruction: unknown) => {
    if (typeof body !== 'string' || !body.trim() || body.length > 8_000) {
      throw new Error('提示词内容无效');
    }
    // Optional natural-language refine request ("更简洁"…) → the kind's
    // `question` slot; the default clarity pass runs without it.
    const userInstruction = typeof instruction === 'string' && instruction.trim()
      ? instruction.trim().slice(0, 500)
      : undefined;
    const result = await agent.run({
      kind: 'prompt-improve',
      sessionId: `capsule-prompt:${Date.now()}`,
      transcriptOverride: body.trim(),
      ...(userInstruction ? { question: userInstruction } : {}),
      persist: false,
    }, { persist: false });
    // parse() in the kind definition already validated the strict JSON shape.
    return JSON.parse(result.content) as CapsulePromptImproveResult;
  });
  ipcMain.handle(IPC.capsulePromptContinue, async (_event, body: unknown) => {
    if (typeof body !== 'string' || !body.trim() || body.length > 8_000) {
      throw new Error('提示词内容无效');
    }
    const result = await agent.run({
      kind: 'prompt-continue',
      sessionId: `capsule-prompt:${Date.now()}`,
      transcriptOverride: body.trim(),
      persist: false,
    }, { persist: false });
    return { continued: result.content } satisfies CapsulePromptContinueResult;
  });
  ipcMain.handle(IPC.capsulePromptSnapshotGet, () => readPromptSnapshot());
  ipcMain.handle(IPC.capsulePromptSnapshotSave, (_event, value: unknown) => writePromptSnapshot(value));
  ipcMain.handle(IPC.capsuleCopyText, (_event, text: unknown) => {
    if (typeof text !== 'string' || text.length > 200_000) throw new Error('复制内容无效');
    clipboard.writeText(text);
  });
  ipcMain.handle(IPC.capsulePanelHeight, (_event, height: unknown) =>
    capsule.setPanelHeight(typeof height === 'number' && Number.isFinite(height) ? height : null));
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
  // Block navigation away from the app, but allow same-URL reloads: the Vite
  // dev client calls location.reload() after dependency re-optimization, and
  // that reload fires will-navigate — blocking it strands the window on a
  // page whose module requests were invalidated (blank window, no errors).
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== mainWindow?.webContents.getURL()) event.preventDefault();
  });
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
  digest = new DigestService(capture, agent, embedding, () => settings.isLlmConfigured());
  notion = new NotionService(settings);
  projectMemory = new ProjectMemoryService(capture, agent);
  capture.setSyncCompletedListener(() => {
    digest.requestScan();
    projectMemory.requestScan();
  });
  digest.start();
  projectMemory.requestScan();
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
    onPairingWindowChanged: broadcastBridgeChange,
    confirmAssociation: confirmExtensionAssociation,
    loadOriginAllowlist: () => settings.getBridgeOriginAllowlist(),
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
