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
  exportConversations: 'vesti:export-conversations',
  uiPrefGet: 'vesti:ui-pref-get',
  uiPrefSet: 'vesti:ui-pref-set',
  uiPrefChanged: 'vesti:ui-pref-changed',
  capsuleState: 'vesti:capsule-state',
  capsuleSync: 'vesti:capsule-sync',
  capsuleToggleWatch: 'vesti:capsule-toggle-watch',
  capsuleOpenMain: 'vesti:capsule-open-main',
  capsuleHide: 'vesti:capsule-hide',
  capsuleSetExpanded: 'vesti:capsule-set-expanded',
  capsuleDragMove: 'vesti:capsule-drag-move',
  capsuleDragEnd: 'vesti:capsule-drag-end',
  capsuleContextMenu: 'vesti:capsule-context-menu',
  capsuleStateChanged: 'vesti:capsule-state-changed',
} as const;

// ---- Desktop floating capsule ----

export interface CapsuleState {
  watching: boolean;
  syncing: boolean;
  conversationCount: number;
  expanded: boolean;
}

/**
 * API surface for the floating capsule window, exposed as
 * window.vestiCapsule.
 */
export interface VestiCapsuleApi {
  getState(): Promise<CapsuleState>;
  sync(): Promise<void>;
  toggleWatch(): Promise<boolean>;
  openMainWindow(): Promise<void>;
  hideCapsule(): Promise<void>;
  setExpanded(expanded: boolean): Promise<void>;
  dragMove(screenX: number, screenY: number): void;
  dragEnd(screenX: number, screenY: number): Promise<void>;
  showContextMenu(): void;
  onStateChanged(listener: (state: CapsuleState) => void): () => void;
}

// ---- VESTI dashboard data bridge (SQLite → renderer mirror) ----
// Field-for-field mirror of capture-core's vestiCompat output, redeclared
// here so the renderer never imports from the Node-only capture core.

export interface VestiConversationRecord {
  id: number;
  uuid: string;
  platform: string;
  title: string;
  snippet: string;
  url: string;
  source_created_at: number | null;
  first_captured_at: number;
  last_captured_at: number;
  created_at: number;
  updated_at: number;
  message_count: number;
  turn_count: number;
  is_archived: boolean;
  is_trash: boolean;
  tags: string[];
  topic_id: number | null;
  is_starred: boolean;
  _source: 'local_terminal';
  _cli_id: string;
  _cli_platform: string;
  _project_path?: string;
  _model?: string;
  _tool_call_count?: number;
}

export interface VestiMessageRecord {
  id: number;
  conversation_id: number;
  role: 'user' | 'ai';
  content_text: string;
  content_ast: null;
  content_ast_version: null;
  degraded_nodes_count: number;
  citations: never[];
  attachments: never[];
  artifacts: never[];
  normalized_html_snapshot: null;
  created_at: number;
  _source: 'local_terminal';
  _thinking?: string;
  _tool_name?: string;
  _tool_input?: string;
  _tool_output?: string;
  _message_source?: string;
}

export interface ConversationExportBundle {
  conversation: VestiConversationRecord;
  messages: VestiMessageRecord[];
}

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
  exportConversations(): Promise<ConversationExportBundle[]>;
  onCaptureChanged(callback: () => void): () => void;
}

/**
 * UI preference bridge exposed as window.vestiUi. Stores small renderer UI
 * state (theme, language, capsule prefs) in a JSON file in userData and
 * broadcasts changes to every window.
 */
export interface VestiUiPrefsApi {
  getUiPreference(key: string): Promise<unknown>;
  setUiPreference(key: string, value: unknown): Promise<void>;
  onUiPreferenceChanged(listener: (key: string, value: unknown) => void): () => void;
}
