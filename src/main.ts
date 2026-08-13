import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  type IpcMainInvokeEvent,
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
import { AgentService, type AgentCreditMeter } from './main/agentService';
import { AgentMcpRegistry, createAgentMcpRegistry, resolveAgentMcpTargetId } from './main/agentMcpRegistry';
import { CaptureService } from './main/captureService';
import { CapsuleWindowService, normalizeCapsuleBubblePayload } from './main/capsuleWindowService';
import { CreditError, CreditService } from './main/creditService';
import { DigestService } from './main/digestService';
import { ProjectMemoryService } from './main/projectMemoryService';
import { EmbeddingService, type EmbeddingCreditMeter } from './main/embeddingService';
import { ExtensionBridgeService, MAX_OUTBOX_PROMPT_CHARS } from './main/extensionBridgeService';
import { NotionService } from './main/notionService';
import { MembershipError, MembershipService } from './main/membershipService';
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
  MAIN_SHELL_TABS,
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
  type CreditBalance,
  type CreditTier,
  type ExtensionImportRequestPayload,
  type ExtensionImportResultPayload,
  type MembershipActionResult,
  type MembershipCredentials,
  type MembershipErrorCode,
  type MembershipStatus,
  type MemoryEntryView,
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
let membership: MembershipService;
let credits: CreditService;
let agent: AgentService;
let embedding: EmbeddingService;
let digest: DigestService;
let projectMemory: ProjectMemoryService;
let notion: NotionService;
const uiPrefs = new UiPrefsService();
let capsule: CapsuleWindowService;
let extensionBridge: ExtensionBridgeService;
let agentMcp: AgentMcpRegistry;
let productRuntimeActive = false;
let productActivation: Promise<void> | null = null;
let membershipExpiryTimer: NodeJS.Timeout | null = null;
let membershipLockReloadTimer: NodeJS.Timeout | null = null;

// Pending /v1/import requests waiting for the renderer's idempotent import to
// finish. Resolved by the IPC.extensionImportResult handler below.
const pendingExtensionImports = new Map<string, {
  resolve: (result: ExtensionImportResultPayload) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}>();

type MemberIpcHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

function publicMembershipStatus(): MembershipStatus {
  const status = membership.getStatus();
  return {
    state: status.state,
    plan: status.plan,
    registered: status.registered,
    authenticated: status.authenticated,
    // The public `active` flag is the real member entitlement (drives the
    // member/free tier and member-only feature gates); an expired account
    // reports active:false yet keeps using the app as the free tier.
    active: status.active,
    username: status.username,
    memberSince: status.memberSince,
    expiresAt: status.expiresAt,
    daysRemaining: status.daysRemaining,
  };
}

function memberIpcHandle(channel: string, handler: MemberIpcHandler): void {
  ipcMain.handle(channel, (event, ...args) => {
    try {
      membership.requireActive();
    } catch (error) {
      if (productRuntimeActive) {
        void deactivateProductRuntime().finally(() => {
          broadcastMembershipChange();
          reloadRendererAfterMembershipLock();
        });
      }
      throw error;
    }
    return handler(event, ...args);
  });
}

function normalizeMembershipCredentials(value: unknown): MembershipCredentials {
  if (!value || typeof value !== 'object') return { username: '', password: '' };
  const input = value as Partial<MembershipCredentials>;
  return {
    username: typeof input.username === 'string' ? input.username : '',
    password: typeof input.password === 'string' ? input.password : '',
  };
}

function membershipErrorCode(error: unknown): MembershipErrorCode {
  if (error instanceof MembershipError) return error.code;
  return 'STORAGE_ERROR';
}

function broadcastMembershipChange(): MembershipStatus {
  const status = publicMembershipStatus();
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(IPC.membershipChanged, status);
  }
  // The credit tier derives from membership, so push a fresh balance too.
  broadcastCreditChange();
  return status;
}

// ---- Credit ledger (Beta metering) ----

function creditTierContext(): { tier: CreditTier; memberSince: number | null } {
  const status = membership.getStatus();
  return { tier: status.active ? 'member' : 'free', memberSince: status.startedAt };
}

function currentCreditBalance(): CreditBalance {
  const { tier, memberSince } = creditTierContext();
  return credits.getBalance(tier, { memberSince });
}

function broadcastCreditChange(): void {
  if (!credits) return;
  let balance: CreditBalance;
  try {
    balance = currentCreditBalance();
  } catch {
    return; // ledger not initialized yet (early startup)
  }
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(IPC.creditChanged, balance);
  }
}

/**
 * Friendly exhaustion message with the CREDITS_EXHAUSTED marker embedded so
 * the renderer can recognize it after Electron re-wraps the IPC error.
 */
function creditExhaustedError(tier: CreditTier): CreditError {
  const detail = tier === 'member'
    ? '本月会员积分已用完，将在下个结算周期自动重置；你也可以在设置中切换为自带密钥（BYOK），不再消耗积分。'
    : '今日免费积分已用完，零点自动重置；你也可以在设置中切换为自带密钥（BYOK），不再消耗积分。';
  return new CreditError('CREDITS_EXHAUSTED', `[CREDITS_EXHAUSTED] ${detail}`);
}

/** Demo-gateway chat metering; BYOK calls are billed by the user's provider. */
const agentCreditMeter: AgentCreditMeter = {
  beforeChat(estimatedChars, label) {
    if (settings.getRuntimeLlm().mode !== 'demo_proxy') return;
    const context = creditTierContext();
    const peeked = credits.peek({ ...context, category: 'chat', estimatedChars, label });
    if (peeked.balance.remaining <= 0) throw creditExhaustedError(context.tier);
  },
  afterChat(usage, estimatedChars, label) {
    if (settings.getRuntimeLlm().mode !== 'demo_proxy') return;
    void credits.consume({
      ...creditTierContext(),
      category: 'chat',
      tokens: usage ? usage.promptTokens + usage.completionTokens : undefined,
      estimatedChars,
      label,
    })
      .then(() => broadcastCreditChange())
      .catch(error => console.warn('[vesti] credit accounting failed:', error));
  },
};

/** Demo-gateway embeddings metering (accounted, never blocks the pipeline). */
const embeddingCreditMeter: EmbeddingCreditMeter = {
  afterEmbedding(label) {
    if (settings.getRuntimeLlm().mode !== 'demo_proxy') return;
    void credits.consume({ ...creditTierContext(), category: 'embedding', label })
      .then(() => broadcastCreditChange())
      .catch(error => console.warn('[vesti] credit accounting failed:', error));
  },
};

function reloadRendererAfterMembershipLock(): void {
  if (membershipLockReloadTimer) return;
  // Unmounting Shell hides the UI immediately, while this reload tears down
  // module-level renderer schedulers (capture mirror, auto export, daily log,
  // prompt snapshot) that deliberately run for the lifetime of a renderer.
  membershipLockReloadTimer = setTimeout(() => {
    membershipLockReloadTimer = null;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.reload();
  }, 150);
}

function scheduleMembershipExpiryCheck(): void {
  if (membershipExpiryTimer) clearTimeout(membershipExpiryTimer);
  membershipExpiryTimer = null;
  const status = publicMembershipStatus();
  if (!status.active || status.expiresAt === null) return;
  // Node timers cap delays at ~24.8 days. Wake in bounded chunks until the
  // exact expiry is close, then lock the product immediately.
  const delay = Math.min(
    Math.max(250, status.expiresAt - Date.now() + 50),
    2_147_000_000,
  );
  membershipExpiryTimer = setTimeout(() => {
    membershipExpiryTimer = null;
    if (membership.getStatus().active) {
      // Woke before the real expiry (clock adjustments); keep waiting.
      scheduleMembershipExpiryCheck();
      return;
    }
    // Expiry downgrades to the free tier in place — no lock, no reload; the
    // broadcast flips the renderer's tier (badge, credit quota, member-only
    // gates) while local data and the runtime keep running.
    broadcastMembershipChange();
  }, delay);
  membershipExpiryTimer.unref?.();
}

async function activateProductRuntime(): Promise<void> {
  if (productRuntimeActive) return;
  if (productActivation) return productActivation;
  membership.requireActive();
  productActivation = (async () => {
    productRuntimeActive = true;
    digest.start();
    projectMemory.requestScan();
    await extensionBridge.start();
    if (!membership.isActive()) {
      productRuntimeActive = false;
      await extensionBridge.stop();
      return;
    }
    if (capsule.isEnabled()) await capsule.show().catch(console.error);
    void capture.syncAll().then(broadcastChange).catch(console.error);
    if (settings.capture.watchOnStartup) {
      void capture.setWatching(true).then(updateTrayMenu).catch(console.error);
    }
    scheduleMembershipExpiryCheck();
    updateTrayMenu();
  })();
  try {
    await productActivation;
  } finally {
    productActivation = null;
  }
}

async function deactivateProductRuntime(): Promise<void> {
  if (productActivation) await productActivation.catch(() => undefined);
  productRuntimeActive = false;
  digest.stop();
  projectMemory.stop();
  await capture.setWatching(false).catch(() => false);
  await extensionBridge.stop().catch(() => undefined);
  await capsule.hide().catch(() => undefined);
  for (const [requestId, pending] of pendingExtensionImports) {
    clearTimeout(pending.timer);
    pending.reject(new MembershipError('AUTHENTICATION_REQUIRED', 'Membership is no longer active.'));
    pendingExtensionImports.delete(requestId);
  }
  if (membershipExpiryTimer) clearTimeout(membershipExpiryTimer);
  membershipExpiryTimer = null;
  updateTrayMenu();
}

async function finishMembershipAction(
  action: () => Promise<unknown>,
): Promise<MembershipActionResult> {
  try {
    await action();
    if (membership.isActive()) await activateProductRuntime();
    else await deactivateProductRuntime();
    const status = broadcastMembershipChange();
    scheduleMembershipExpiryCheck();
    return { ok: true, status };
  } catch (error) {
    return {
      ok: false,
      status: publicMembershipStatus(),
      error: membershipErrorCode(error),
    };
  }
}

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
  membership.requireActive();
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
    membership.requireActive();
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
  if (!tray || !settings || !membership) return;
  const visible = Boolean(mainWindow?.isVisible());
  // Free tier (expired membership) keeps the capture tray entries.
  const active = publicMembershipStatus().authenticated;
  const template: Electron.MenuItemConstructorOptions[] = [
    { label: visible ? '隐藏 Vesti' : '打开 Vesti', click: () => visible ? mainWindow?.hide() : showMainWindow() },
  ];
  if (active) {
    template.push(
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
    );
  } else {
    template.push({ label: '登录有效会员后可使用 Vesti', enabled: false });
  }
  template.push(
    { type: 'separator' },
    { label: '退出 Vesti', click: () => { isQuitting = true; app.quit(); } },
  );
  tray.setContextMenu(Menu.buildFromTemplate(template));
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
  // dream batches pack many sessions per LLM call for throughput and get a
  // raised override budget; every other kind keeps the original 30K cap.
  const transcriptCap = request.kind === 'dream-extract' || request.kind === 'dream-maintain' ? 60_000 : 30_000;
  return (request.kind === 'summary' || request.kind === 'explore' || request.kind === 'digest' || request.kind === 'classify' || request.kind === 'relay' || request.kind === 'extract' || request.kind === 'distill' || request.kind === 'deposit-maintain' || request.kind === 'daily' || request.kind === 'persona' || request.kind === 'roundtable-turn' || request.kind === 'roundtable-synthesis' || request.kind === 'learn-deepen' || request.kind === 'learn-synthesis' || request.kind === 'prompt-improve' || request.kind === 'prompt-continue' || request.kind === 'dream-extract' || request.kind === 'dream-maintain' || request.kind === 'companion')
    && validSessionId(request.sessionId)
    && (request.question === undefined || typeof request.question === 'string')
    && (request.template === undefined || (typeof request.template === 'string' && request.template.length <= 64))
    && (request.transcriptOverride === undefined
      || (typeof request.transcriptOverride === 'string' && request.transcriptOverride.length <= transcriptCap))
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
    && Number.isSafeInteger(update.llm.maxTokens)
    && update.llm.maxTokens >= 0
    && update.llm.maxTokens <= 16_384
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

// ---- 记忆空间 (memory_entries) IPC validation ----

const MEMORY_ENTRY_KINDS = ['deposit', 'dream', 'dream-log', 'note'] as const;

function validMemoryId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 240 && /^[\w:.-]+$/.test(value);
}

function validMemoryMetaKey(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200;
}

function isOptionalShortText(value: unknown, maxChars: number): boolean {
  return value === undefined || value === null
    || (typeof value === 'string' && value.length <= maxChars);
}

function isStringArray(value: unknown, maxItems: number): boolean {
  return Array.isArray(value) && value.length <= maxItems
    && value.every(item => typeof item === 'string');
}

function validMemoryEntry(value: unknown): value is MemoryEntryView {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<MemoryEntryView>;
  return validMemoryId(entry.id)
    && MEMORY_ENTRY_KINDS.includes(entry.kind as (typeof MEMORY_ENTRY_KINDS)[number])
    && typeof entry.title === 'string' && entry.title.length <= 200
    && typeof entry.contentMarkdown === 'string' && entry.contentMarkdown.length <= 100_000
    && isOptionalShortText(entry.summary, 500)
    && isOptionalShortText(entry.scope, 500)
    && isOptionalShortText(entry.template, 500)
    && isOptionalShortText(entry.entryDate, 500)
    && isStringArray(entry.sourceSessionIds, 100)
    && isStringArray(entry.tags, 100)
    && Number.isInteger(entry.version) && (entry.version as number) >= 1
    && (entry.prevId === undefined || entry.prevId === null || typeof entry.prevId === 'string')
    && (entry.lastOps === undefined || entry.lastOps === null || typeof entry.lastOps === 'string')
    && (entry.status === 'active' || entry.status === 'archived')
    // 时间戳由主进程补（导入迁移路径除外，见 memoryImport handler）。
    && (entry.createdAt === undefined
      || (typeof entry.createdAt === 'number' && Number.isSafeInteger(entry.createdAt) && entry.createdAt >= 0))
    && (entry.updatedAt === undefined
      || (typeof entry.updatedAt === 'number' && Number.isSafeInteger(entry.updatedAt) && entry.updatedAt >= 0));
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
  ipcMain.handle(IPC.membershipStatus, async () => {
    const status = publicMembershipStatus();
    // Only a sign-out locks the runtime; an expired member keeps the free tier.
    if (!status.authenticated && productRuntimeActive) {
      await deactivateProductRuntime();
      reloadRendererAfterMembershipLock();
    }
    return status;
  });
  ipcMain.handle(IPC.membershipRegister, (_event, value: unknown) =>
    finishMembershipAction(() => membership.register(normalizeMembershipCredentials(value))));
  ipcMain.handle(IPC.membershipLogin, (_event, value: unknown) =>
    finishMembershipAction(() => membership.login(normalizeMembershipCredentials(value))));
  ipcMain.handle(IPC.membershipLogout, async () => {
    await membership.logout();
    await deactivateProductRuntime();
    const status = broadcastMembershipChange();
    reloadRendererAfterMembershipLock();
    return status;
  });
  memberIpcHandle(IPC.creditBalance, () => currentCreditBalance());
  memberIpcHandle(IPC.overview, () => capture.getOverview());
  memberIpcHandle(IPC.sessions, () => capture.getSessions());
  memberIpcHandle(IPC.session, (_event, id: unknown) => {
    if (!validSessionId(id)) throw new Error('Invalid session id');
    return capture.getSession(id);
  });
  memberIpcHandle(IPC.sync, () => capture.syncAll());
  memberIpcHandle(IPC.watch, async (_event, enabled: unknown) => {
    const watching = await capture.setWatching(enabled === true);
    updateTrayMenu();
    return watching;
  });
  memberIpcHandle(IPC.wslStatus, () => capture.getWslStatus());
  memberIpcHandle(IPC.wslRedetect, () => capture.redetectWsl());
  memberIpcHandle(IPC.settings, () => settings.getView(capture.activeDataDirectory));
  memberIpcHandle(IPC.settingsSave, async (_event, update: unknown) => {
    if (!validSettingsUpdate(update)) throw new Error('设置数据无效');
    const result = await settings.save(update, capture.activeDataDirectory);
    embedding.invalidateStatus();
    capture.setEnabledPlatforms(result.settings.capture.enabledPlatforms);
    await applyProxySettings();
    applyGeneralSettings();
    updateTrayMenu();
    return result;
  });
  memberIpcHandle(IPC.chooseDataDirectory, async () => {
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
  memberIpcHandle(IPC.openDataDirectory, () => openDirectory(capture.activeDataDirectory));
  memberIpcHandle(IPC.openSettingsDirectory, () => openDirectory(settings.getView(capture.activeDataDirectory).settingsDirectory));
  memberIpcHandle(IPC.chooseDirectory, async (_event, title: unknown) => {
    const options: Electron.OpenDialogOptions = {
      title: typeof title === 'string' && title.trim() ? title : '选择目录',
      properties: ['openDirectory', 'createDirectory'],
    };
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  memberIpcHandle(IPC.upstreamWriteFile, (_event, request: unknown) => {
    if (!validUpstreamWriteRequest(request)) throw new Error('导出写入请求无效');
    return writeUpstreamExportFile(request);
  });
  memberIpcHandle(IPC.notionTest, () => notion.testConnection());
  memberIpcHandle(IPC.notionExport, (_event, request: unknown) => {
    if (!validNotionExportRequest(request)) throw new Error('Notion 导出请求无效');
    return notion.exportPage(request);
  });
  memberIpcHandle(IPC.relayPrepareCli, (_event, request: unknown) => {
    if (!validRelayPrepareCliRequest(request)) throw new Error('交接包写入请求无效');
    return writeRelaySharedFile(request);
  });
  memberIpcHandle(IPC.relayOutboxEnqueue, async (_event, request: unknown) => {
    if (!validRelayOutboxEnqueueRequest(request)) throw new Error('交接包投递请求无效');
    if (extensionBridge.getStatus().clients.length === 0) {
      throw new Error('没有已配对的浏览器扩展，请先在扩展桥设置中完成配对');
    }
    const item = await extensionBridge.enqueueOutbox(request.prompt);
    return { id: item.id };
  });
  memberIpcHandle(IPC.relaySessionContexts, (_event, sessionIds: unknown) => {
    if (!Array.isArray(sessionIds) || sessionIds.length > 50
      || !sessionIds.every(validSessionId)) {
      throw new Error('交接上下文请求无效');
    }
    return capture.getRelaySessionContexts(sessionIds);
  });
  memberIpcHandle(IPC.relayFileTouches, (_event, sessionIds: unknown) => {
    // Subagent sessions ride along with selected parents, so the id list can
    // legitimately exceed the raw selection size — allow a wider fan-out.
    if (!Array.isArray(sessionIds) || sessionIds.length > 200
      || !sessionIds.every(validSessionId)) {
      throw new Error('文件锚点请求无效');
    }
    return capture.getRelayFileTouches(sessionIds);
  });
  memberIpcHandle(IPC.clearAgentResults, async () => {
    await agent.clearResults();
  });
  memberIpcHandle(IPC.restart, () => {
    isQuitting = true;
    app.relaunch();
    app.exit(0);
  });
  memberIpcHandle(IPC.llmTest, () => agent.test());
  memberIpcHandle(IPC.embeddingStatus, () => embedding.getStatus());
  memberIpcHandle(IPC.agentRun, (_event, request: unknown) => {
    if (!validAgentRequest(request)) throw new Error('Agent 请求无效');
    return agent.run(request, { persist: request.persist });
  });
  memberIpcHandle(IPC.agentResults, () => agent.listResults());
  memberIpcHandle(IPC.exportConversations, () => capture.exportConversations());
  memberIpcHandle(IPC.conversationTree, () => capture.getConversationTree());
  memberIpcHandle(IPC.projectStates, () => capture.listProjectStates());
  memberIpcHandle(IPC.projectBrief, (_event, projectKey: unknown) => {
    if (typeof projectKey !== 'string' || !projectKey.trim()) throw new Error('Invalid project key');
    return capture.getProjectBrief(projectKey.trim());
  });
  memberIpcHandle(IPC.fileTimeline, (_event, query: unknown) => {
    const input = (query ?? {}) as { projectKey?: unknown; filePath?: unknown };
    if (typeof input.filePath !== 'string' || !input.filePath.trim()) throw new Error('Invalid file path');
    return capture.getFileTimeline({
      projectKey: typeof input.projectKey === 'string' && input.projectKey.trim() ? input.projectKey : undefined,
      filePath: input.filePath.trim(),
    });
  });
  memberIpcHandle(IPC.recallSessions, async (_event, query: unknown, topK: unknown) => {
    if (typeof query !== 'string' || !query.trim()) throw new Error('Invalid recall query');
    const limit = typeof topK === 'number' && Number.isInteger(topK) && topK >= 1 && topK <= 20 ? topK : 5;
    // The query vector is best-effort: without a reachable embedding endpoint
    // recall silently falls back to the pure-FTS path.
    const queryEmbedding = await embedding.embedWithMetadata([query.trim()]).catch(() => null);
    return capture.recallSessions(
      query.trim(),
      limit,
      queryEmbedding?.vectors[0] ?? null,
      queryEmbedding?.metadata.version ?? null,
    );
  });
  memberIpcHandle(IPC.extensionBridgeStatus, () => extensionBridge.getStatus());
  // ---- 记忆空间 (memory_entries) ----
  memberIpcHandle(IPC.memoryList, (_event, opts: unknown) => {
    const input = (opts ?? {}) as { kind?: unknown; status?: unknown; limit?: unknown; offset?: unknown };
    if (input.kind !== undefined
      && !MEMORY_ENTRY_KINDS.includes(input.kind as (typeof MEMORY_ENTRY_KINDS)[number])) {
      throw new Error('记忆条目请求无效');
    }
    if (input.status !== undefined && input.status !== 'active' && input.status !== 'archived') {
      throw new Error('记忆条目请求无效');
    }
    if (input.limit !== undefined
      && (!Number.isInteger(input.limit) || (input.limit as number) < 1 || (input.limit as number) > 500)) {
      throw new Error('记忆条目请求无效');
    }
    if (input.offset !== undefined && (!Number.isInteger(input.offset) || (input.offset as number) < 0)) {
      throw new Error('记忆条目请求无效');
    }
    return capture.listMemoryEntries({
      kind: input.kind as MemoryEntryView['kind'] | undefined,
      status: input.status as MemoryEntryView['status'] | undefined,
      limit: input.limit as number | undefined,
      offset: input.offset as number | undefined,
    });
  });
  memberIpcHandle(IPC.memoryGet, (_event, ids: unknown) => {
    if (!Array.isArray(ids) || ids.length > 50 || !ids.every(validMemoryId)) {
      throw new Error('记忆条目请求无效');
    }
    return capture.getMemoryEntries(ids);
  });
  memberIpcHandle(IPC.memoryUpsert, (_event, entry: unknown) => {
    if (!validMemoryEntry(entry)) throw new Error('记忆条目无效');
    const now = Date.now();
    capture.upsertMemoryEntry({ ...entry, createdAt: entry.createdAt ?? now, updatedAt: now });
  });
  memberIpcHandle(IPC.memoryDelete, (_event, id: unknown) => {
    if (!validMemoryId(id)) throw new Error('记忆条目请求无效');
    capture.deleteMemoryEntry(id);
  });
  memberIpcHandle(IPC.memorySearch, (_event, query: unknown, limit: unknown) => {
    if (typeof query !== 'string' || !query.trim()) throw new Error('记忆检索请求无效');
    const capped = typeof limit === 'number' && Number.isInteger(limit) && limit >= 1 && limit <= 20 ? limit : 10;
    return capture.searchMemoryEntries(query.trim(), capped);
  });
  memberIpcHandle(IPC.memoryImport, (_event, entries: unknown) => {
    // Dexie 沉淀的一次性迁移：批量 upsert，保留原始时间戳。
    if (!Array.isArray(entries) || entries.length > 200 || !entries.every(validMemoryEntry)) {
      throw new Error('记忆条目导入请求无效');
    }
    const now = Date.now();
    return capture.importMemoryEntries(entries.map(entry => ({
      ...entry,
      createdAt: entry.createdAt ?? now,
      updatedAt: entry.updatedAt ?? now,
    })));
  });
  memberIpcHandle(IPC.memoryMetaGet, (_event, key: unknown) => {
    if (!validMemoryMetaKey(key)) throw new Error('记忆元数据请求无效');
    return capture.getMemoryMeta(key);
  });
  memberIpcHandle(IPC.memoryMetaSet, (_event, key: unknown, value: unknown) => {
    if (!validMemoryMetaKey(key) || typeof value !== 'string' || value.length > 4_000) {
      throw new Error('记忆元数据请求无效');
    }
    capture.setMemoryMeta(key, value);
  });
  memberIpcHandle(IPC.extensionPairCodeCreate, () => extensionBridge.createPairCode());
  memberIpcHandle(IPC.extensionPairingWindowOpen, () => extensionBridge.openPairingWindow());
  memberIpcHandle(IPC.extensionClientDisconnect, (_event, clientId: unknown) => {
    if (typeof clientId !== 'string' || !clientId) throw new Error('Invalid client id');
    return extensionBridge.disconnectClient(clientId);
  });
  memberIpcHandle(IPC.agentMcpStatus, () => agentMcp.listStatus());
  memberIpcHandle(IPC.agentMcpRegister, (_event, id: unknown) => {
    const targetId = resolveAgentMcpTargetId(id);
    if (!targetId) throw new Error('无效的 Agent 目标');
    return agentMcp.register(targetId);
  });
  memberIpcHandle(IPC.agentMcpUnregister, (_event, id: unknown) => {
    const targetId = resolveAgentMcpTargetId(id);
    if (!targetId) throw new Error('无效的 Agent 目标');
    return agentMcp.unregister(targetId);
  });
  memberIpcHandle(IPC.extensionImportResult, (_event, result: unknown) => {
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
    if (!membership.isActive() && key !== 'theme' && key !== 'language') {
      throw new MembershipError('AUTHENTICATION_REQUIRED', 'Membership is required for this preference.');
    }
    return uiPrefs.get(key) ?? null;
  });
  ipcMain.handle(IPC.uiPrefSet, async (_event, key: unknown, value: unknown) => {
    if (typeof key !== 'string') throw new Error('Invalid preference key');
    if (!membership.isActive() && key !== 'theme' && key !== 'language') {
      throw new MembershipError('AUTHENTICATION_REQUIRED', 'Membership is required for this preference.');
    }
    await uiPrefs.set(key, value);
  });
  memberIpcHandle(IPC.capsuleState, () => capsule.getState());
  memberIpcHandle(IPC.capsuleSync, async () => {
    await capture.syncAll();
    broadcastChange();
  });
  memberIpcHandle(IPC.capsuleToggleWatch, async () => {
    const watching = await capture.setWatching(!capture.isWatching);
    broadcastChange();
    return watching;
  });
  memberIpcHandle(IPC.capsuleOpenMain, () => showMainWindow());
  memberIpcHandle(IPC.capsuleHide, () => capsule.setEnabled(false));
  memberIpcHandle(IPC.capsuleSetExpanded, (_event, expanded: unknown) =>
    capsule.setExpanded(expanded === true));
  ipcMain.on(IPC.capsuleDragStart, (_event, x: unknown, y: unknown) => {
    if (!membership.isActive()) return;
    if (typeof x === 'number' && typeof y === 'number') capsule.handleDragStart(x, y);
  });
  ipcMain.on(IPC.capsuleDragCancel, () => {
    if (membership.isActive()) capsule.handleDragCancel();
  });
  ipcMain.on(IPC.capsuleDragMove, (_event, x: unknown, y: unknown) => {
    if (!membership.isActive()) return;
    if (typeof x === 'number' && typeof y === 'number') capsule.handleDragMove(x, y);
  });
  memberIpcHandle(IPC.capsuleDragEnd, async (_event, x: unknown, y: unknown) => {
    if (typeof x === 'number' && typeof y === 'number') await capsule.handleDragEnd(x, y);
  });
  ipcMain.on(IPC.capsuleContextMenu, (_event, labels: unknown) => {
    if (!membership.isActive()) return;
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
  memberIpcHandle(IPC.capsuleDockStatus, async () => {
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
  memberIpcHandle(IPC.capsuleQuickAsk, async (_event, question: unknown, options: unknown) => {
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
    const queryEmbedding = await embedding.embedWithMetadata([query]).catch(() => null);
    const hits = capture.recallSessions(
      query,
      5,
      queryEmbedding?.vectors[0] ?? null,
      queryEmbedding?.metadata.version ?? null,
    );
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
  memberIpcHandle(IPC.capsuleProjects, () => capsuleProjectViews());
  memberIpcHandle(IPC.capsuleRelayDraft, (_event, request: unknown) => buildCapsuleRelayDraft(request));
  memberIpcHandle(IPC.capsuleRelayPolish, async (_event, draft: unknown) => {
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
  memberIpcHandle(IPC.capsuleSearchPrompts, async (_event, query: unknown) => {
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
  memberIpcHandle(IPC.capsulePromptImprove, async (_event, body: unknown, instruction: unknown) => {
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
  memberIpcHandle(IPC.capsulePromptContinue, async (_event, body: unknown) => {
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
  memberIpcHandle(IPC.capsulePromptSnapshotGet, () => readPromptSnapshot());
  memberIpcHandle(IPC.capsulePromptSnapshotSave, (_event, value: unknown) => writePromptSnapshot(value));
  memberIpcHandle(IPC.capsuleCopyText, (_event, text: unknown) => {
    if (typeof text !== 'string' || text.length > 200_000) throw new Error('复制内容无效');
    clipboard.writeText(text);
  });
  memberIpcHandle(IPC.capsulePanelHeight, (_event, height: unknown) =>
    capsule.setPanelHeight(typeof height === 'number' && Number.isFinite(height) ? height : null));
  // ---- Capsule bubble (third capsule form) + dock tab navigation ----
  memberIpcHandle(IPC.capsuleBubbleShow, (_event, payload: unknown) => {
    const bubble = normalizeCapsuleBubblePayload(payload);
    if (!bubble) throw new Error('气泡内容无效');
    return capsule.showBubble(bubble);
  });
  memberIpcHandle(IPC.capsuleBubbleDismiss, () => capsule.dismissBubble());
  memberIpcHandle(IPC.capsuleOpenMainTab, (_event, tab: unknown) => {
    if (typeof tab !== 'string' || !(MAIN_SHELL_TABS as readonly string[]).includes(tab)) {
      throw new Error('无效的导航目标');
    }
    const sendNavigate = () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IPC.mainTabNavigate, tab);
      }
    };
    if (!mainWindow || mainWindow.isDestroyed()) {
      // The window is recreated asynchronously; navigate only after its load.
      void createWindow().then(() => {
        mainWindow?.show();
        mainWindow?.focus();
        updateTrayMenu();
        sendNavigate();
      });
      return;
    }
    showMainWindow();
    sendNavigate();
  });
}

async function createWindow(): Promise<void> {
  const startedFromLogin = process.argv.includes('--hidden');
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1040,
    minHeight: 680,
    // A locked app must always show its login/registration gate even when the
    // process was launched with --hidden at OS sign-in.
    show: !membership.isActive() || !(startedFromLogin && settings.general.startMinimized),
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
  membership = new MembershipService(app.getPath('userData'));
  try {
    await membership.initialize();
  } catch (error) {
    dialog.showErrorBox(
      'Vesti membership data error',
      error instanceof Error
        ? `${error.message}\n\nPlease restore or remove the damaged membership.json file in the Vesti settings directory.`
        : 'The local membership file could not be read.',
    );
    app.quit();
    return;
  }
  // Credit ledger (Beta metering): never blocks startup — a corrupt file
  // resets to a fresh ledger inside initialize().
  credits = new CreditService(app.getPath('userData'));
  await credits.initialize();
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
  agent = new AgentService(capture, settings, agentCreditMeter);
  embedding = new EmbeddingService(settings, embeddingCreditMeter);
  digest = new DigestService(capture, agent, embedding, () => settings.isLlmConfigured());
  notion = new NotionService(settings);
  projectMemory = new ProjectMemoryService(capture, agent);
  agentMcp = createAgentMcpRegistry(app.getAppPath(), process.resourcesPath);
  capture.setSyncCompletedListener(() => {
    if (!productRuntimeActive) return;
    digest.requestScan();
    projectMemory.requestScan();
  });
  capture.setAgentActivityListener(payload => {
    if (!productRuntimeActive) return;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC.agentActivity, payload);
  });
  extensionBridge = new ExtensionBridgeService({
    appVersion: app.getVersion(),
    isAuthorized: () => membership.isActive(),
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
  createTray();
  // Product background services stay completely idle until a signed-in
  // account (member or free tier) unlocks the app.
  if (membership.isActive()) await activateProductRuntime();
  app.on('activate', showMainWindow);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && (!settings || !settings.general.closeToTray)) app.quit();
});
app.on('before-quit', () => {
  isQuitting = true;
  if (membershipExpiryTimer) clearTimeout(membershipExpiryTimer);
  membershipExpiryTimer = null;
  if (membershipLockReloadTimer) clearTimeout(membershipLockReloadTimer);
  membershipLockReloadTimer = null;
  tray?.destroy();
  tray = null;
  if (extensionBridge) void extensionBridge.stop().catch(console.error);
  digest?.stop();
  projectMemory?.stop();
  if (agent) void capture.close().catch(console.error);
});
