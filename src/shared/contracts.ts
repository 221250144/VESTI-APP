export type CapturePlatform = 'codex' | 'cursor' | 'kimi-code' | 'claude-code';

export interface SourceStatus {
  platform: CapturePlatform;
  label: string;
  enabled: boolean;
  installed: boolean;
  version?: string;
  installPath?: string;
  sessionCount: number;
}

export interface SessionSummary {
  id: string;
  sessionId: string;
  platform: CapturePlatform;
  projectPath: string;
  model?: string;
  title: string;
  status: 'active' | 'archived';
  startedAt: number;
  lastActivityAt: number;
  messageCount: number;
  turnCount: number;
  toolCallCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
}

export interface SessionMessage {
  id: string;
  sessionId: string;
  source: string;
  role: 'user' | 'assistant' | 'system';
  contentText?: string;
  contentThinking?: string;
  contentToolName?: string;
  contentToolInput?: string;
  contentToolOutput?: string;
  contentToolError?: string;
  timestamp: number;
}

export interface SessionDetail {
  session: SessionSummary;
  messages: SessionMessage[];
}

export interface Overview {
  sources: SourceStatus[];
  sessions: SessionSummary[];
  totals: {
    conversations: number;
    messages: number;
    inputTokens: number;
    outputTokens: number;
    storageSize: number;
  };
  watching: boolean;
  syncing: boolean;
}

export interface SyncSummary {
  sessions: number;
  messages: number;
  tools: number;
  errors: string[];
}

export type LlmAccessMode = 'demo_proxy' | 'custom_byok';
export type ProxyMode = 'system' | 'direct' | 'custom';
export type AgentOutputLanguage = 'zh-CN' | 'en-US';

export interface GeneralSettings {
  launchAtLogin: boolean;
  startMinimized: boolean;
  closeToTray: boolean;
}

export interface CaptureSettings {
  watchOnStartup: boolean;
  enabledPlatforms: CapturePlatform[];
}

export interface NetworkSettings {
  proxyMode: ProxyMode;
  proxyUrl: string;
}

export interface AgentSettings {
  outputLanguage: AgentOutputLanguage;
  includeThinking: boolean;
  includeToolDetails: boolean;
  customInstructions: string;
}

export interface LlmSettingsView {
  mode: LlmAccessMode;
  baseUrl: string;
  modelId: string;
  temperature: number;
  maxTokens: number;
  apiKeyConfigured: boolean;
}

export interface AppSettingsView {
  appVersion: string;
  settingsDirectory: string;
  dataDirectory: string;
  activeDataDirectory: string;
  restartRequired: boolean;
  general: GeneralSettings;
  capture: CaptureSettings;
  network: NetworkSettings;
  agent: AgentSettings;
  llm: LlmSettingsView;
}

export interface AppSettingsUpdate {
  dataDirectory: string;
  general: GeneralSettings;
  capture: CaptureSettings;
  network: NetworkSettings;
  agent: AgentSettings;
  llm: {
    mode: LlmAccessMode;
    baseUrl: string;
    modelId: string;
    temperature: number;
    maxTokens: number;
    apiKey?: string;
    clearApiKey?: boolean;
  };
}

export interface SettingsSaveResult {
  settings: AppSettingsView;
  restartRequired: boolean;
}

export type AgentKind = 'summary' | 'explore';

export interface AgentRunRequest {
  kind: AgentKind;
  sessionId: string;
  question?: string;
}

export interface AgentResult {
  id: string;
  kind: AgentKind;
  sessionId: string;
  sessionTitle: string;
  question?: string;
  content: string;
  modelId: string;
  createdAt: number;
}

export interface LlmTestResult {
  ok: boolean;
  message: string;
}

export const IPC = {
  overview: 'vesti:overview',
  sessions: 'vesti:sessions',
  session: 'vesti:session',
  sync: 'vesti:sync',
  watch: 'vesti:watch',
  changed: 'vesti:capture-changed',
  settings: 'vesti:settings',
  settingsSave: 'vesti:settings-save',
  chooseDataDirectory: 'vesti:choose-data-directory',
  openDataDirectory: 'vesti:open-data-directory',
  openSettingsDirectory: 'vesti:open-settings-directory',
  clearAgentResults: 'vesti:clear-agent-results',
  restart: 'vesti:restart',
  llmTest: 'vesti:llm-test',
  agentRun: 'vesti:agent-run',
  agentResults: 'vesti:agent-results',
} as const;

export interface VestiDesktopApi {
  getOverview(): Promise<Overview>;
  getSessions(): Promise<SessionSummary[]>;
  getSession(id: string): Promise<SessionDetail | null>;
  sync(): Promise<SyncSummary>;
  setWatching(enabled: boolean): Promise<boolean>;
  getSettings(): Promise<AppSettingsView>;
  saveSettings(update: AppSettingsUpdate): Promise<SettingsSaveResult>;
  chooseDataDirectory(): Promise<string | null>;
  openDataDirectory(): Promise<void>;
  openSettingsDirectory(): Promise<void>;
  clearAgentResults(): Promise<void>;
  restartApp(): Promise<void>;
  testLlm(): Promise<LlmTestResult>;
  runAgent(request: AgentRunRequest): Promise<AgentResult>;
  getAgentResults(): Promise<AgentResult[]>;
  onCaptureChanged(callback: () => void): () => void;
}
