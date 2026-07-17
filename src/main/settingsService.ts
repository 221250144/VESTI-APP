import { safeStorage } from 'electron';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  AgentSettings,
  AppSettingsUpdate,
  AppSettingsView,
  CapturePlatform,
  CaptureSettings,
  GeneralSettings,
  LlmAccessMode,
  NetworkSettings,
  SettingsSaveResult,
} from '../shared/contracts';

const DEMO_BASE_URL = 'https://vesti-gate.vercel.app/api';
const CUSTOM_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const DEMO_SERVICE_TOKEN = 'vesti-kcq-default-d850d4dcd610a0e2e919eb610f42066faff1e1c57c0c047c';
const PRIMARY_PLATFORMS: CapturePlatform[] = ['codex', 'cursor', 'kimi-code'];

interface StoredSettings {
  version: 2;
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
  };
}

export interface RuntimeLlmSettings {
  mode: LlmAccessMode;
  baseUrl: string;
  modelId: string;
  temperature: number;
  maxTokens: number;
  apiKey: string;
  serviceToken: string;
}

export type RuntimeAgentSettings = AgentSettings;

export class SettingsService {
  private readonly filePath: string;
  private settings: StoredSettings;

  constructor(
    private readonly userDataDirectory: string,
    private readonly appVersion: string,
  ) {
    this.filePath = path.join(userDataDirectory, 'settings.json');
    this.settings = this.defaults();
  }

  async initialize(): Promise<void> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, 'utf8')) as unknown;
      this.settings = parsed && typeof parsed === 'object'
        ? this.merge(parsed as Partial<StoredSettings>)
        : this.defaults();
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
        baseUrl: mode === 'demo_proxy' ? DEMO_BASE_URL : this.settings.llm.customBaseUrl,
        modelId: this.settings.llm.modelId,
        temperature: this.settings.llm.temperature,
        maxTokens: this.settings.llm.maxTokens,
        apiKeyConfigured: Boolean(this.settings.llm.encryptedApiKey),
      },
    };
  }

  getRuntimeLlm(): RuntimeLlmSettings {
    let apiKey = '';
    if (this.settings.llm.encryptedApiKey) {
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error('系统安全存储当前不可用，无法读取 API Key');
      }
      apiKey = safeStorage.decryptString(Buffer.from(this.settings.llm.encryptedApiKey, 'base64'));
    }
    return {
      mode: this.settings.llm.mode,
      baseUrl: this.settings.llm.mode === 'demo_proxy' ? DEMO_BASE_URL : this.settings.llm.customBaseUrl,
      modelId: this.settings.llm.modelId,
      temperature: this.settings.llm.temperature,
      maxTokens: this.settings.llm.maxTokens,
      apiKey,
      serviceToken: DEMO_SERVICE_TOKEN,
    };
  }

  async save(update: AppSettingsUpdate, activeDataDirectory: string): Promise<SettingsSaveResult> {
    const requestedDirectory = update.dataDirectory.trim();
    if (!requestedDirectory) throw new Error('数据目录不能为空');
    const dataDirectory = path.resolve(requestedDirectory);
    await this.ensureWritableDirectory(dataDirectory);

    const mode = update.llm.mode;
    const customBaseUrl = mode === 'custom_byok'
      ? this.normalizeUrl(update.llm.baseUrl || CUSTOM_BASE_URL)
      : this.settings.llm.customBaseUrl;
    const modelId = update.llm.modelId.trim();
    if (!modelId) throw new Error('模型名称不能为空');

    let encryptedApiKey = this.settings.llm.encryptedApiKey;
    if (update.llm.clearApiKey) encryptedApiKey = undefined;
    const apiKey = update.llm.apiKey?.trim();
    if (apiKey) {
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error('系统安全存储不可用，Vesti 不会以明文保存 API Key');
      }
      encryptedApiKey = safeStorage.encryptString(apiKey).toString('base64');
    }

    const enabledPlatforms = [...new Set(update.capture.enabledPlatforms)]
      .filter((platform): platform is CapturePlatform => PRIMARY_PLATFORMS.includes(platform));
    const proxyMode = ['system', 'direct', 'custom'].includes(update.network.proxyMode)
      ? update.network.proxyMode
      : 'system';
    const proxyUrl = proxyMode === 'custom'
      ? this.normalizeProxyUrl(update.network.proxyUrl)
      : update.network.proxyUrl.trim();
    const outputLanguage = update.agent.outputLanguage === 'en-US' ? 'en-US' : 'zh-CN';

    this.settings = {
      version: 2,
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
        maxTokens: Math.round(this.numberInRange(update.llm.maxTokens, 128, 16_384, 1600)),
        encryptedApiKey,
      },
    };
    await this.persist();
    const settings = this.getView(activeDataDirectory);
    return { settings, restartRequired: settings.restartRequired };
  }

  private defaults(): StoredSettings {
    return {
      version: 2,
      dataDirectory: path.join(os.homedir(), '.vesti'),
      general: {
        launchAtLogin: false,
        startMinimized: true,
        closeToTray: true,
      },
      capture: {
        watchOnStartup: true,
        enabledPlatforms: [...PRIMARY_PLATFORMS],
      },
      network: {
        proxyMode: 'system',
        proxyUrl: '',
      },
      agent: {
        outputLanguage: 'zh-CN',
        includeThinking: true,
        includeToolDetails: true,
        customInstructions: '',
      },
      llm: {
        mode: 'demo_proxy',
        customBaseUrl: CUSTOM_BASE_URL,
        modelId: 'qwen-plus',
        temperature: 0.3,
        maxTokens: 1600,
      },
    };
  }

  private merge(parsed: Partial<StoredSettings>): StoredSettings {
    const defaults = this.defaults();
    const llm = parsed.llm ?? defaults.llm;
    let customBaseUrl = defaults.llm.customBaseUrl;
    try {
      customBaseUrl = this.normalizeUrl(llm.customBaseUrl || customBaseUrl);
    } catch {
      // Keep the safe default when a manually edited settings file contains an invalid URL.
    }
    const general = parsed.general ?? defaults.general;
    const capture = parsed.capture ?? defaults.capture;
    const network = parsed.network ?? defaults.network;
    const agent = parsed.agent ?? defaults.agent;
    const enabledPlatforms = Array.isArray(capture.enabledPlatforms)
      ? [...new Set(capture.enabledPlatforms)].filter((platform): platform is CapturePlatform => PRIMARY_PLATFORMS.includes(platform))
      : defaults.capture.enabledPlatforms;
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
      version: 2,
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
        outputLanguage: agent.outputLanguage === 'en-US' ? 'en-US' : 'zh-CN',
        includeThinking: typeof agent.includeThinking === 'boolean' ? agent.includeThinking : defaults.agent.includeThinking,
        includeToolDetails: typeof agent.includeToolDetails === 'boolean' ? agent.includeToolDetails : defaults.agent.includeToolDetails,
        customInstructions: typeof agent.customInstructions === 'string' ? agent.customInstructions.trim().slice(0, 4_000) : '',
      },
      llm: {
        mode: llm.mode === 'custom_byok' ? 'custom_byok' : 'demo_proxy',
        customBaseUrl,
        modelId: llm.modelId?.trim() || defaults.llm.modelId,
        temperature: this.numberInRange(llm.temperature, 0, 2, defaults.llm.temperature),
        maxTokens: Math.round(this.numberInRange(llm.maxTokens, 128, 16_384, defaults.llm.maxTokens)),
        encryptedApiKey: typeof llm.encryptedApiKey === 'string' ? llm.encryptedApiKey : undefined,
      },
    };
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
    if (!['https:', 'http:'].includes(url.protocol)) throw new Error('模型地址必须使用 HTTP 或 HTTPS');
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
