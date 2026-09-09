import { safeStorage } from 'electron';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  AgentOutputLanguage,
  AgentSettings,
  AppSettingsUpdate,
  AppSettingsView,
  CapturePlatform,
  CaptureSettings,
  GeneralSettings,
  LlmAccessMode,
  NetworkSettings,
  NotionParentType,
  SettingsSaveResult,
} from '../shared/contracts';
import {
  CURRENT_SETTINGS_VERSION,
  normalizeCustomBaseUrl,
  normalizeEnabledPlatforms,
  normalizeMaxTokens,
  PRIMARY_CAPTURE_PLATFORMS,
} from './settingsMigration';
import { outputLanguageForLocale, resolveMainLocale, settingsStrings } from './mainStrings';

// Official gateway: keys stay server-side, model ids pass through with no
// whitelist; the previous deployment remains the transport-level fallback.
export const DEMO_BASE_URL = 'https://vesti.world/gate/api';
export const LEGACY_DEMO_BASE_URL = 'https://api.ccvg1218.online/api';
export const DEMO_SERVICE_TOKEN = 'vesti-kcq-default-d850d4dcd610a0e2e919eb610f42066faff1e1c57c0c047c';
export const DEFAULT_EMBEDDING_MODEL = 'text-embedding-v1';
// 旧网关(百炼上游)时代的内置模型 id:新网关按前缀路由到 DeepSeek/Kimi,
// 这些 id 没有对应上游,迁移到当前默认模型。
const LEGACY_DEMO_MODEL_IDS = new Set([
  'qwen-plus',
  'qwen-turbo',
  'qwen-max',
  'qwen-coder-plus',
]);

export interface StoredBridgeClient {
  clientId: string;
  client: string;
  tokenEncrypted: string;
  pairedAt: number;
  lastSyncAt: number | null;
}

/** Bridge Protocol v1.1 relay outbox item (prompts awaiting extension pickup). */
export interface StoredBridgeOutboxItem {
  id: number;
  prompt: string;
  createdAt: number;
}

interface StoredBridgeSettings {
  /** Optional override for the extension bridge port (default 28765). */
  port?: number;
  clients?: StoredBridgeClient[];
  outbox?: StoredBridgeOutboxItem[];
  /** Bridge Protocol v1.2: exact chrome-extension://<id> origins allowed to
   * call the browser-facing endpoints. Empty/absent = no Origin enforcement
   * (the TOFU confirm dialog remains the gate). */
  originAllowlist?: string[];
}

interface StoredSettings {
  version: 5;
  dataDirectory: string;
  general: GeneralSettings;
  capture: CaptureSettings;
  network: NetworkSettings;
  agent: AgentSettings;
  llm: {
    mode: LlmAccessMode;
    customBaseUrl: string;
    modelId: string;
    temperature: number;
    maxTokens: number;
    encryptedApiKey?: string;
    embeddingModel?: string;
  };
  upstream: {
    obsidianVaultPath: string;
    obsidianAutoExport: boolean;
    obsidianAutoExportSince: number | null;
    notionParentId: string;
    notionParentType: NotionParentType;
    notionTitleProperty: string;
    encryptedNotionToken?: string;
  };
  bridge?: StoredBridgeSettings;
}

export interface RuntimeLlmSettings {
  mode: LlmAccessMode;
  baseUrl: string;
  fallbackBaseUrl: string;
  modelId: string;
  temperature: number;
  maxTokens: number;
  apiKey: string;
  serviceToken: string;
  embeddingModel: string;
}

/** Decrypted upstream secrets for main-process services (never sent to the renderer). */
export interface RuntimeUpstreamSettings {
  obsidianVaultPath: string;
  obsidianAutoExport: boolean;
  notionParentId: string;
  notionParentType: NotionParentType;
  notionTitleProperty: string;
  notionToken: string;
}

export type RuntimeAgentSettings = AgentSettings;

export class SettingsService {
  private readonly filePath: string;
  private settings: StoredSettings;

  constructor(
    private readonly userDataDirectory: string,
    private readonly appVersion: string,
    /** UI-language source (ui-prefs `language`) for user-facing validation
     * messages and the locale-derived default agent output language; defaults
     * to Chinese, the legacy factory language. */
    private readonly uiLocale: () => unknown = () => 'zh',
  ) {
    this.filePath = path.join(userDataDirectory, 'settings.json');
    this.settings = this.defaults();
  }

  private strings() {
    return settingsStrings(resolveMainLocale(this.uiLocale()));
  }

  /** Default agent output language: follows the UI language unless the user
   * picked one explicitly. */
  private defaultOutputLanguage(): AgentOutputLanguage {
    return outputLanguageForLocale(resolveMainLocale(this.uiLocale()));
  }

  async initialize(): Promise<void> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, 'utf8')) as unknown;
      const stored = parsed && typeof parsed === 'object'
        ? parsed as Partial<StoredSettings>
        : null;
      this.settings = stored
        ? this.merge(stored)
        : this.defaults();
      if (!stored || stored.version !== CURRENT_SETTINGS_VERSION) await this.persist();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
      await this.persist();
    }
    await this.ensureWritableDirectory(this.settings.dataDirectory);
  }

  get dataDirectory(): string {
    return this.settings.dataDirectory;
  }

  get general(): GeneralSettings {
    return { ...this.settings.general };
  }

  get capture(): CaptureSettings {
    return { ...this.settings.capture, enabledPlatforms: [...this.settings.capture.enabledPlatforms] };
  }

  get network(): NetworkSettings {
    return { ...this.settings.network };
  }

  getRuntimeAgent(): RuntimeAgentSettings {
    return { ...this.settings.agent };
  }

  /**
   * Default-follows-UI sync for the agent output language, called by main
   * when the ui-prefs `language` changes. The stored value only tracks the
   * new language when the user never picked a different one explicitly:
   * with a previous UI locale that means the stored value still equals that
   * locale's mapping; without one (first-ever pref write) it means the value
   * is still a factory default ('zh-CN' legacy builds, 'en-US' otherwise).
   * Returns true when the setting was updated and persisted.
   */
  async followAgentOutputLanguage(
    previous: AgentOutputLanguage | null,
    next: AgentOutputLanguage,
  ): Promise<boolean> {
    const current = this.settings.agent.outputLanguage;
    const follows = previous
      ? current === previous
      : current === 'zh-CN' || current === 'en-US';
    if (!follows || current === next) return false;
    this.settings = {
      ...this.settings,
      agent: { ...this.settings.agent, outputLanguage: next },
    };
    await this.persist();
    return true;
  }

  getBridgePort(): number | undefined {
    return this.settings.bridge?.port;
  }

  getBridgeClients(): StoredBridgeClient[] {
    return (this.settings.bridge?.clients ?? []).map((client) => ({ ...client }));
  }

  async saveBridgeClients(clients: StoredBridgeClient[]): Promise<void> {
    this.settings = {
      ...this.settings,
      bridge: { ...this.settings.bridge, clients },
    };
    await this.persist();
  }

  getBridgeOutbox(): StoredBridgeOutboxItem[] {
    return (this.settings.bridge?.outbox ?? []).map((item) => ({ ...item }));
  }

  getBridgeOriginAllowlist(): string[] {
    return [...(this.settings.bridge?.originAllowlist ?? [])];
  }

  async saveBridgeOutbox(items: StoredBridgeOutboxItem[]): Promise<void> {
    this.settings = {
      ...this.settings,
      bridge: { ...this.settings.bridge, outbox: items },
    };
    await this.persist();
  }

  getView(activeDataDirectory: string): AppSettingsView {
    const mode = this.settings.llm.mode;
    return {
      appVersion: this.appVersion,
      settingsDirectory: this.userDataDirectory,
      dataDirectory: this.settings.dataDirectory,
      activeDataDirectory,
      restartRequired: path.resolve(this.settings.dataDirectory) !== path.resolve(activeDataDirectory),
      general: this.general,
      capture: this.capture,
      network: this.network,
      agent: this.getRuntimeAgent(),
      llm: {
        mode,
        // The renderer only needs the user-owned BYOK value. Demo Proxy's
        // managed endpoint stays in the main process and is never displayed.
        baseUrl: this.settings.llm.customBaseUrl,
        modelId: this.settings.llm.modelId,
        temperature: this.settings.llm.temperature,
        maxTokens: this.settings.llm.maxTokens,
        apiKeyConfigured: Boolean(this.settings.llm.encryptedApiKey),
        // Effective embedding model (BYOK-editable in the settings UI).
        embeddingModel: this.settings.llm.embeddingModel?.trim() || DEFAULT_EMBEDDING_MODEL,
      },
      upstream: {
        obsidianVaultPath: this.settings.upstream.obsidianVaultPath,
        obsidianAutoExport: this.settings.upstream.obsidianAutoExport,
        obsidianAutoExportSince: this.settings.upstream.obsidianAutoExportSince,
        notionParentId: this.settings.upstream.notionParentId,
        notionParentType: this.settings.upstream.notionParentType,
        notionTitleProperty: this.settings.upstream.notionTitleProperty,
        notionTokenConfigured: Boolean(this.settings.upstream.encryptedNotionToken),
      },
    };
  }

  getRuntimeUpstream(): RuntimeUpstreamSettings {
    let notionToken = '';
    if (this.settings.upstream.encryptedNotionToken) {
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error('系统安全存储当前不可用，无法读取 Notion Token');
      }
      notionToken = safeStorage.decryptString(
        Buffer.from(this.settings.upstream.encryptedNotionToken, 'base64'),
      );
    }
    return {
      obsidianVaultPath: this.settings.upstream.obsidianVaultPath,
      obsidianAutoExport: this.settings.upstream.obsidianAutoExport,
      notionParentId: this.settings.upstream.notionParentId,
      notionParentType: this.settings.upstream.notionParentType,
      notionTitleProperty: this.settings.upstream.notionTitleProperty,
      notionToken,
    };
  }

  /** Persist the parent type/title property resolved by a Notion verify or export. */
  async saveResolvedNotionParent(type: NotionParentType, titleProperty: string): Promise<void> {
    this.settings = {
      ...this.settings,
      upstream: {
        ...this.settings.upstream,
        notionParentType: type,
        notionTitleProperty: type === 'database' ? titleProperty : '',
      },
    };
    await this.persist();
  }

  /** Whether the chat LLM is usable without touching secrets: demo proxy
   * needs no key, BYOK needs a stored one. */
  isLlmConfigured(): boolean {
    return this.settings.llm.mode === 'demo_proxy' || Boolean(this.settings.llm.encryptedApiKey);
  }

  getRuntimeLlm(): RuntimeLlmSettings {
    let apiKey = '';
    if (this.settings.llm.encryptedApiKey) {
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error(this.strings().safeStorageReadApiKey);
      }
      apiKey = safeStorage.decryptString(Buffer.from(this.settings.llm.encryptedApiKey, 'base64'));
    }
    return {
      mode: this.settings.llm.mode,
      baseUrl: this.settings.llm.mode === 'demo_proxy' ? DEMO_BASE_URL : this.settings.llm.customBaseUrl,
      // 旧兜底网关 ccvg1218 已下线(404);兜底改为重试主网关 ——
      // 网关侧 key 池化后,重试可能落到池内另一条上游。
      fallbackBaseUrl: DEMO_BASE_URL,
      modelId: this.settings.llm.modelId,
      temperature: this.settings.llm.temperature,
      maxTokens: this.settings.llm.maxTokens,
      apiKey,
      serviceToken: DEMO_SERVICE_TOKEN,
      embeddingModel: this.settings.llm.embeddingModel?.trim() || DEFAULT_EMBEDDING_MODEL,
    };
  }

  async save(update: AppSettingsUpdate, activeDataDirectory: string): Promise<SettingsSaveResult> {
    const strings = this.strings();
    const requestedDirectory = update.dataDirectory.trim();
    if (!requestedDirectory) throw new Error('数据目录不能为空');
    const dataDirectory = path.resolve(requestedDirectory);
    await this.ensureWritableDirectory(dataDirectory);

    const mode = update.llm.mode;
    const requestedCustomBaseUrl = update.llm.baseUrl.trim();
    if (mode === 'custom_byok' && !requestedCustomBaseUrl) {
      throw new Error(strings.byokBaseUrlRequired);
    }
    const customBaseUrl = mode === 'custom_byok'
      ? this.normalizeUrl(requestedCustomBaseUrl)
      : this.settings.llm.customBaseUrl;
    const modelId = update.llm.modelId.trim();
    if (!modelId) throw new Error(strings.modelIdRequired);

    let encryptedApiKey = this.settings.llm.encryptedApiKey;
    if (update.llm.clearApiKey) encryptedApiKey = undefined;
    const apiKey = update.llm.apiKey?.trim();
    if (apiKey) {
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error(strings.safeStorageSaveApiKey);
      }
      encryptedApiKey = safeStorage.encryptString(apiKey).toString('base64');
    }

    const enabledPlatforms = [...new Set(update.capture.enabledPlatforms)]
      .filter((platform): platform is CapturePlatform => PRIMARY_CAPTURE_PLATFORMS.includes(platform));
    const proxyMode = ['system', 'direct', 'custom'].includes(update.network.proxyMode)
      ? update.network.proxyMode
      : 'system';
    const proxyUrl = proxyMode === 'custom'
      ? this.normalizeProxyUrl(update.network.proxyUrl)
      : update.network.proxyUrl.trim();
    const outputLanguage = ['zh-CN', 'en-US', 'ja-JP', 'ko-KR'].includes(update.agent.outputLanguage)
      ? update.agent.outputLanguage
      : this.defaultOutputLanguage();

    const obsidianVaultPath = update.upstream.obsidianVaultPath.trim();
    if (obsidianVaultPath && !path.isAbsolute(obsidianVaultPath)) {
      throw new Error('Obsidian 库目录必须是绝对路径');
    }
    let encryptedNotionToken = this.settings.upstream.encryptedNotionToken;
    if (update.upstream.clearNotionToken) encryptedNotionToken = undefined;
    const notionToken = update.upstream.notionToken?.trim();
    if (notionToken) {
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error('系统安全存储不可用，Vesti 不会以明文保存 Notion Token');
      }
      encryptedNotionToken = safeStorage.encryptString(notionToken).toString('base64');
    }
    const notionParentType: NotionParentType = update.upstream.notionParentType === 'database' ? 'database' : 'page';

    this.settings = {
      version: CURRENT_SETTINGS_VERSION,
      dataDirectory,
      general: {
        launchAtLogin: Boolean(update.general.launchAtLogin),
        startMinimized: Boolean(update.general.startMinimized),
        closeToTray: Boolean(update.general.closeToTray),
      },
      capture: {
        watchOnStartup: Boolean(update.capture.watchOnStartup),
        enabledPlatforms,
      },
      network: { proxyMode, proxyUrl },
      agent: {
        outputLanguage,
        includeThinking: Boolean(update.agent.includeThinking),
        includeToolDetails: Boolean(update.agent.includeToolDetails),
        customInstructions: update.agent.customInstructions.trim().slice(0, 4_000),
      },
      llm: {
        mode,
        customBaseUrl,
        modelId,
        temperature: this.numberInRange(update.llm.temperature, 0, 2, 0.3),
        maxTokens: Math.round(this.numberInRange(update.llm.maxTokens, 0, 16_384, 0)),
        encryptedApiKey,
        // BYOK-editable embedding model: an explicit string is stored (empty
        // resets to the default); an absent field preserves the stored value.
        embeddingModel: typeof update.llm.embeddingModel === 'string'
          ? update.llm.embeddingModel.trim() || undefined
          : this.settings.llm.embeddingModel,
      },
      upstream: {
        obsidianVaultPath: obsidianVaultPath ? path.resolve(obsidianVaultPath) : '',
        obsidianAutoExport: Boolean(update.upstream.obsidianAutoExport),
        obsidianAutoExportSince: update.upstream.obsidianAutoExport
          ? this.settings.upstream.obsidianAutoExport
            ? this.settings.upstream.obsidianAutoExportSince ?? Date.now()
            : Date.now()
          : null,
        notionParentId: update.upstream.notionParentId.trim(),
        notionParentType,
        notionTitleProperty: notionParentType === 'database' ? update.upstream.notionTitleProperty.trim() : '',
        encryptedNotionToken,
      },
      // Extension bridge pairing state is managed by the bridge service, not
      // the settings form; carry it through untouched.
      bridge: this.settings.bridge,
    };
    await this.persist();
    const settings = this.getView(activeDataDirectory);
    return { settings, restartRequired: settings.restartRequired };
  }

  private defaults(): StoredSettings {
    return {
      version: CURRENT_SETTINGS_VERSION,
      dataDirectory: path.join(os.homedir(), '.vesti'),
      general: {
        launchAtLogin: false,
        startMinimized: true,
        closeToTray: true,
      },
      capture: {
        watchOnStartup: true,
        enabledPlatforms: [...PRIMARY_CAPTURE_PLATFORMS],
      },
      network: {
        proxyMode: 'system',
        proxyUrl: '',
      },
      agent: {
        outputLanguage: this.defaultOutputLanguage(),
        includeThinking: true,
        includeToolDetails: true,
        customInstructions: '',
      },
      llm: {
        mode: 'demo_proxy',
        customBaseUrl: '',
        modelId: 'deepseek-v4-flash',
        temperature: 0.3,
        // 0 = uncapped: no max_tokens is sent, the model's own default applies.
        // A per-request 1600 cap silently truncated relay packs and daily logs.
        maxTokens: 0,
      },
      upstream: {
        obsidianVaultPath: '',
        obsidianAutoExport: false,
        obsidianAutoExportSince: null,
        notionParentId: '',
        notionParentType: 'page',
        notionTitleProperty: '',
      },
    };
  }

  private merge(parsed: Partial<StoredSettings>): StoredSettings {
    const defaults = this.defaults();
    const llm = parsed.llm ?? defaults.llm;
    const llmMode = llm.mode === 'custom_byok' ? 'custom_byok' : 'demo_proxy';
    const migratedCustomBaseUrl = normalizeCustomBaseUrl(
      llm.customBaseUrl,
      llmMode,
      typeof llm.encryptedApiKey === 'string' && Boolean(llm.encryptedApiKey),
      parsed.version,
    );
    let customBaseUrl = '';
    if (migratedCustomBaseUrl) {
      try {
        customBaseUrl = this.normalizeUrl(migratedCustomBaseUrl);
      } catch {
        // Invalid manually edited BYOK URLs are discarded instead of being
        // replaced by a provider-specific default.
      }
    }
    const general = parsed.general ?? defaults.general;
    const capture = parsed.capture ?? defaults.capture;
    const network = parsed.network ?? defaults.network;
    const agent = parsed.agent ?? defaults.agent;
    const enabledPlatforms = normalizeEnabledPlatforms(capture.enabledPlatforms, parsed.version);
    let proxyMode = ['system', 'direct', 'custom'].includes(network.proxyMode)
      ? network.proxyMode
      : defaults.network.proxyMode;
    let proxyUrl = typeof network.proxyUrl === 'string' ? network.proxyUrl.trim() : '';
    if (proxyMode === 'custom') {
      try {
        proxyUrl = this.normalizeProxyUrl(proxyUrl);
      } catch {
        proxyMode = 'system';
        proxyUrl = '';
      }
    }
    return {
      version: CURRENT_SETTINGS_VERSION,
      dataDirectory: typeof parsed.dataDirectory === 'string' && parsed.dataDirectory.trim()
        ? path.resolve(parsed.dataDirectory)
        : defaults.dataDirectory,
      general: {
        launchAtLogin: typeof general.launchAtLogin === 'boolean' ? general.launchAtLogin : defaults.general.launchAtLogin,
        startMinimized: typeof general.startMinimized === 'boolean' ? general.startMinimized : defaults.general.startMinimized,
        closeToTray: typeof general.closeToTray === 'boolean' ? general.closeToTray : defaults.general.closeToTray,
      },
      capture: {
        watchOnStartup: typeof capture.watchOnStartup === 'boolean' ? capture.watchOnStartup : defaults.capture.watchOnStartup,
        enabledPlatforms,
      },
      network: { proxyMode, proxyUrl },
      agent: {
        outputLanguage: ['zh-CN', 'en-US', 'ja-JP', 'ko-KR'].includes(agent.outputLanguage)
          ? agent.outputLanguage
          : this.defaultOutputLanguage(),
        includeThinking: typeof agent.includeThinking === 'boolean' ? agent.includeThinking : defaults.agent.includeThinking,
        includeToolDetails: typeof agent.includeToolDetails === 'boolean' ? agent.includeToolDetails : defaults.agent.includeToolDetails,
        customInstructions: typeof agent.customInstructions === 'string' ? agent.customInstructions.trim().slice(0, 4_000) : '',
      },
      llm: {
        mode: llmMode,
        customBaseUrl,
        // 旧网关的百炼模型在新网关没有对应上游:demo_proxy 下统一迁移到默认模型
        modelId: (() => {
          const stored = llm.modelId?.trim();
          if (llmMode === 'demo_proxy' && stored && LEGACY_DEMO_MODEL_IDS.has(stored)) {
            return defaults.llm.modelId;
          }
          return stored || defaults.llm.modelId;
        })(),
        temperature: this.numberInRange(llm.temperature, 0, 2, defaults.llm.temperature),
        maxTokens: normalizeMaxTokens(llm.maxTokens, llmMode, parsed.version),
        encryptedApiKey: typeof llm.encryptedApiKey === 'string' ? llm.encryptedApiKey : undefined,
        embeddingModel: typeof llm.embeddingModel === 'string' && llm.embeddingModel.trim()
          ? llm.embeddingModel.trim()
          : undefined,
      },
      upstream: this.mergeUpstream(parsed.upstream, defaults.upstream),
      bridge: this.mergeBridge(parsed.bridge),
    };
  }

  private mergeUpstream(
    upstream: StoredSettings['upstream'] | undefined,
    defaults: StoredSettings['upstream'],
  ): StoredSettings['upstream'] {
    if (!upstream || typeof upstream !== 'object') return { ...defaults };
    const vaultPath = typeof upstream.obsidianVaultPath === 'string' ? upstream.obsidianVaultPath.trim() : '';
    return {
      obsidianVaultPath: vaultPath && path.isAbsolute(vaultPath) ? path.resolve(vaultPath) : '',
      obsidianAutoExport: typeof upstream.obsidianAutoExport === 'boolean'
        ? upstream.obsidianAutoExport
        : defaults.obsidianAutoExport,
      obsidianAutoExportSince: upstream.obsidianAutoExport === true
        ? typeof upstream.obsidianAutoExportSince === 'number' && Number.isFinite(upstream.obsidianAutoExportSince)
          ? upstream.obsidianAutoExportSince
          : Date.now()
        : null,
      notionParentId: typeof upstream.notionParentId === 'string'
        ? upstream.notionParentId.trim()
        : defaults.notionParentId,
      notionParentType: upstream.notionParentType === 'database' ? 'database' : 'page',
      notionTitleProperty: upstream.notionParentType === 'database' && typeof upstream.notionTitleProperty === 'string'
        ? upstream.notionTitleProperty.trim()
        : '',
      encryptedNotionToken: typeof upstream.encryptedNotionToken === 'string'
        ? upstream.encryptedNotionToken
        : undefined,
    };
  }

  private mergeBridge(bridge: StoredSettings['bridge']): StoredBridgeSettings | undefined {
    if (!bridge || typeof bridge !== 'object') return undefined;
    const port = typeof bridge.port === 'number'
      && Number.isInteger(bridge.port)
      && bridge.port >= 1
      && bridge.port <= 65535
      ? bridge.port
      : undefined;
    const clients = Array.isArray(bridge.clients)
      ? bridge.clients.filter(
          (client): client is StoredBridgeClient => Boolean(client)
            && typeof client.clientId === 'string'
            && typeof client.client === 'string'
            && typeof client.tokenEncrypted === 'string'
            && typeof client.pairedAt === 'number',
        ).map((client) => ({ ...client, lastSyncAt: client.lastSyncAt ?? null }))
      : undefined;
    const outbox = Array.isArray(bridge.outbox)
      ? bridge.outbox.filter(
          (item): item is StoredBridgeOutboxItem => Boolean(item)
            && Number.isInteger(item.id)
            && item.id >= 1
            && typeof item.prompt === 'string'
            && typeof item.createdAt === 'number',
        ).map((item) => ({ ...item }))
      : undefined;
    const originAllowlist = Array.isArray(bridge.originAllowlist)
      ? [...new Set(
          bridge.originAllowlist
            .filter((origin): origin is string => typeof origin === 'string' && Boolean(origin.trim()))
            .map((origin) => origin.trim()),
        )]
      : undefined;
    if (port === undefined && clients === undefined && outbox === undefined && originAllowlist === undefined) {
      return undefined;
    }
    return { port, clients, outbox, originAllowlist };
  }

  private async ensureWritableDirectory(directory: string): Promise<void> {
    if (!path.isAbsolute(directory)) throw new Error('数据目录必须是绝对路径');
    await fs.mkdir(directory, { recursive: true });
    const probe = path.join(directory, `.vesti-write-${process.pid}-${Date.now()}`);
    try {
      await fs.writeFile(probe, 'ok', { flag: 'wx' });
    } finally {
      await fs.rm(probe, { force: true });
    }
  }

  private async persist(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(this.settings, null, 2), 'utf8');
    await fs.rm(this.filePath, { force: true });
    await fs.rename(temporary, this.filePath);
  }

  private normalizeUrl(value: string): string {
    const url = new URL(value.trim());
    if (!['https:', 'http:'].includes(url.protocol)) throw new Error(this.strings().modelUrlProtocol);
    return url.toString().replace(/\/$/, '');
  }

  private normalizeProxyUrl(value: string): string {
    const trimmed = value.trim();
    if (!trimmed) throw new Error('自定义代理地址不能为空');
    const url = new URL(trimmed);
    if (!['http:', 'https:', 'socks4:', 'socks5:'].includes(url.protocol)) {
      throw new Error('代理地址必须使用 HTTP、HTTPS、SOCKS4 或 SOCKS5');
    }
    if (!url.hostname || !url.port) throw new Error('代理地址必须包含主机和端口');
    return url.toString().replace(/\/$/, '');
  }

  private numberInRange(value: number | undefined, min: number, max: number, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value)
      ? Math.min(max, Math.max(min, value))
      : fallback;
  }
}
