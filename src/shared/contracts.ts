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

export interface UsageBreakdown {
  conversations: number;
  inputTokens: number;
  outputTokens: number;
}

export interface OverviewAnalytics {
  cacheTokens: number;
  platformBreakdown: Record<string, number>;
  platformTokenBreakdown: Record<string, UsageBreakdown>;
  modelBreakdown: Record<string, number>;
  modelTokenBreakdown: Record<string, UsageBreakdown>;
  dailyActivity: Array<{ date: string; conversations: number; messages: number }>;
  dailyTokenUsage: Array<{ date: string; inputTokens: number; outputTokens: number }>;
  topProjects: Array<{ path: string; conversations: number }>;
  toolCategoryBreakdown: Record<string, number>;
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
  analytics: OverviewAnalytics;
  watching: boolean;
  syncing: boolean;
}

export interface SyncSummary {
  sessions: number;
  messages: number;
  tools: number;
  errors: string[];
}

// ---- WSL capture sources ----

export interface WslPlatformInstall {
  platform: CapturePlatform;
  installed: boolean;
}

export interface WslStatusView {
  /** WSL detection only runs on Windows */
  supported: boolean;
  distros: string[];
  /** Per-platform install status inside WSL (native status is in SourceStatus) */
  platforms: WslPlatformInstall[];
  /** Epoch ms of the last detection pass; null until the first one finishes */
  detectedAt: number | null;
}

export type LlmAccessMode = 'demo_proxy' | 'custom_byok';
export type ProxyMode = 'system' | 'direct' | 'custom';
export type AgentOutputLanguage = 'zh-CN' | 'en-US' | 'ja-JP' | 'ko-KR';

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

// ---- P3 upstream export (Obsidian vault / Notion) ----

export type NotionParentType = 'page' | 'database';

export interface UpstreamSettingsView {
  /** Absolute path of the Obsidian vault root chosen by the user; '' = unset. */
  obsidianVaultPath: string;
  /** Auto-export newly synced conversations into the vault after each sync. */
  obsidianAutoExport: boolean;
  /** Capture-time watermark used to keep enabling auto-export from replaying all history. */
  obsidianAutoExportSince: number | null;
  /** Notion parent page_id or database_id (dashes optional). */
  notionParentId: string;
  /** Resolved at verify time so exports know which parent shape to send. */
  notionParentType: NotionParentType;
  /** Title property name of the target database ('' unless type = database). */
  notionTitleProperty: string;
  notionTokenConfigured: boolean;
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
  upstream: UpstreamSettingsView;
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
  upstream: {
    obsidianVaultPath: string;
    obsidianAutoExport: boolean;
    notionParentId: string;
    notionParentType: NotionParentType;
    notionTitleProperty: string;
    notionToken?: string;
    clearNotionToken?: boolean;
  };
}

export interface SettingsSaveResult {
  settings: AppSettingsView;
  restartRequired: boolean;
}

// ---- P3 upstream export IPC payloads ----

/**
 * Restricted vault/directory write. Both paths must stay inside rootPath;
 * previousRelativePath points at the file written by the previous export of
 * the same conversation (idempotent update), and expectedUuid must match the
 * frontmatter uuid before any existing file is overwritten.
 */
export interface UpstreamWriteFileRequest {
  rootPath: string;
  relativePath: string;
  content: string;
  previousRelativePath?: string;
  expectedUuid?: string;
}

export interface UpstreamWriteFileResult {
  relativePath: string;
}

export interface NotionTestResult {
  ok: boolean;
  message: string;
}

/**
 * Renderer-built Notion page payload. Blocks are opaque to the main process
 * (validated only for shape); the renderer also splits >100-block batches and
 * >2000-char rich text before sending.
 */
export interface NotionExportRequest {
  title: string;
  iconEmoji?: string;
  blocks: Array<Record<string, unknown>>;
  /** Re-export: archive this page first, then recreate under the parent. */
  existingPageId?: string | null;
}

export interface NotionExportResult {
  pageId: string;
  url: string;
}

export type AgentKind = 'summary' | 'explore' | 'digest' | 'classify' | 'relay' | 'extract' | 'distill' | 'daily' | 'persona';

/** P4b deposit distillation templates ('custom' carries the user's own
 * instruction in AgentRunRequest.question). */
export type DistillTemplate = 'background_knowledge' | 'project_state' | 'writing_style' | 'custom';

export interface AgentRunRequest {
  kind: AgentKind;
  sessionId: string;
  question?: string;
  /**
   * Pre-built transcript used instead of the session's own messages
   * (cross-session recall context, digest pipeline). Capped in main.
   */
  transcriptOverride?: string;
  /**
   * Prompt variant selector for parameterized kinds (P4b distill). Values are
   * kind-specific; for 'distill' it is a DistillTemplate.
   */
  template?: string;
  /**
   * Pass false to keep the result out of the user-facing agent-results log
   * (batch jobs like digest/classify pipelines). Defaults to true.
   */
  persist?: boolean;
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

export interface EmbeddingStatus {
  available: boolean;
  reason?: string;
}

// ---- Conversation tree index & session recall (P1.5) ----
// Field-for-field mirror of capture-core's TreeIndex / SessionRecall output,
// redeclared here so the renderer never imports the Node-only capture core.

export interface ConversationTreeSession {
  id: string;
  title: string;
  messageCount: number;
  lastActivityAt: number;
  oneLiner: string | null;
  keyTopics: string[];
  keyFiles: string[];
  decisions: string[];
}

export interface ConversationTreeProject {
  projectKey: string;
  label: string;
  pathOrDomain: string;
  sessions: ConversationTreeSession[];
}

export interface ConversationTreeSource {
  platform: string;
  host: string;
  projects: ConversationTreeProject[];
}

export interface ConversationTree {
  generatedAt: string;
  sources: ConversationTreeSource[];
}

export interface SessionRecallHit {
  sessionId: string;
  title: string;
  platform: string;
  score: number;
  snippet: string;
  oneLiner: string | null;
}

export const IPC = {
  windowMinimize: 'vesti:window-minimize',
  windowToggleMaximize: 'vesti:window-toggle-maximize',
  windowClose: 'vesti:window-close',
  windowIsMaximized: 'vesti:window-is-maximized',
  windowMaximizedChanged: 'vesti:window-maximized-changed',
  overview: 'vesti:overview',
  sessions: 'vesti:sessions',
  session: 'vesti:session',
  sync: 'vesti:sync',
  watch: 'vesti:watch',
  wslStatus: 'vesti:wsl-status',
  wslRedetect: 'vesti:wsl-redetect',
  changed: 'vesti:capture-changed',
  settings: 'vesti:settings',
  settingsSave: 'vesti:settings-save',
  chooseDataDirectory: 'vesti:choose-data-directory',
  openDataDirectory: 'vesti:open-data-directory',
  openSettingsDirectory: 'vesti:open-settings-directory',
  clearAgentResults: 'vesti:clear-agent-results',
  restart: 'vesti:restart',
  llmTest: 'vesti:llm-test',
  embeddingStatus: 'vesti:embedding-status',
  agentRun: 'vesti:agent-run',
  agentResults: 'vesti:agent-results',
  exportConversations: 'vesti:export-conversations',
  conversationTree: 'vesti:conversation-tree',
  recallSessions: 'vesti:recall-sessions',
  uiPrefGet: 'vesti:ui-pref-get',
  uiPrefSet: 'vesti:ui-pref-set',
  uiPrefChanged: 'vesti:ui-pref-changed',
  capsuleState: 'vesti:capsule-state',
  capsuleSync: 'vesti:capsule-sync',
  capsuleToggleWatch: 'vesti:capsule-toggle-watch',
  capsuleOpenMain: 'vesti:capsule-open-main',
  capsuleHide: 'vesti:capsule-hide',
  capsuleSetExpanded: 'vesti:capsule-set-expanded',
  capsuleDragStart: 'vesti:capsule-drag-start',
  capsuleDragCancel: 'vesti:capsule-drag-cancel',
  capsuleDragMove: 'vesti:capsule-drag-move',
  capsuleDragEnd: 'vesti:capsule-drag-end',
  capsuleContextMenu: 'vesti:capsule-context-menu',
  capsuleStateChanged: 'vesti:capsule-state-changed',
  extensionBridgeStatus: 'vesti:extension-bridge-status',
  extensionPairCodeCreate: 'vesti:extension-pair-code-create',
  extensionClientDisconnect: 'vesti:extension-client-disconnect',
  extensionBridgeChanged: 'vesti:extension-bridge-changed',
  extensionImportRequest: 'vesti:extension-import-request',
  extensionImportResult: 'vesti:extension-import-result',
  chooseDirectory: 'vesti:choose-directory',
  upstreamWriteFile: 'vesti:upstream-write-file',
  notionTest: 'vesti:notion-test',
  notionExport: 'vesti:notion-export',
  relayPrepareCli: 'vesti:relay-prepare-cli',
  relayOutboxEnqueue: 'vesti:relay-outbox-enqueue',
} as const;

// ---- Desktop floating capsule ----

export interface CapsuleState {
  watching: boolean;
  syncing: boolean;
  conversationCount: number;
  expanded: boolean;
}

export interface CapsuleContextMenuLabels {
  open: string;
  sync: string;
  watching: string;
  hide: string;
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
  dragStart(screenX: number, screenY: number): void;
  dragCancel(): void;
  dragMove(screenX: number, screenY: number): void;
  dragEnd(screenX: number, screenY: number): Promise<void>;
  showContextMenu(labels: CapsuleContextMenuLabels): void;
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

// ---- Browser extension bridge (Bridge Protocol v1) ----

export interface ExtensionBridgeClientView {
  clientId: string;
  client: string;
  pairedAt: number;
  lastSyncAt: number | null;
}

export interface ExtensionBridgeStatusView {
  running: boolean;
  port: number;
  error: string | null;
  clients: ExtensionBridgeClientView[];
}

export interface ExtensionPairCodeView {
  code: string;
  expiresAt: number;
}

/** main → renderer: run the idempotent vesti_export.v1 merge import. */
export interface ExtensionImportRequestPayload {
  requestId: string;
  bundle: unknown;
  since?: string;
}

/** renderer → main: import outcome for a pending /v1/import request. */
export interface ExtensionImportResultPayload {
  requestId: string;
  conversations: number;
  messages: number;
  maxCapturedAt: string | null;
  error?: string;
}

// ---- P4a AI relay (handoff packs) ----

/** A copyable one-liner that starts a CLI session seeded with the pack file. */
export interface RelayCliCommand {
  id: string;
  label: string;
  command: string;
}

/**
 * Writes the relay pack Markdown into the app's own relay directory
 * (<dataDir>/relay, default ~/.vesti/relay — not the user-chosen vault root,
 * so this bypasses the restricted upstream write on purpose) and returns
 * ready-to-paste CLI launch commands.
 */
export interface RelayPrepareCliRequest {
  /** Relay pack id (Dexie relay_packs row); used in the file name. */
  id: number;
  /** Short sanitized title fragment for a readable file name. */
  slug: string;
  markdown: string;
}

export interface RelayPrepareCliResult {
  filePath: string;
  commands: RelayCliCommand[];
}

/** Enqueue a suggested prompt into the extension bridge outbox (v1.1). */
export interface RelayOutboxEnqueueRequest {
  prompt: string;
}

export interface RelayOutboxEnqueueResult {
  id: number;
}

export interface VestiDesktopApi {
  getOverview(): Promise<Overview>;
  getSessions(): Promise<SessionSummary[]>;
  getSession(id: string): Promise<SessionDetail | null>;
  sync(): Promise<SyncSummary>;
  setWatching(enabled: boolean): Promise<boolean>;
  getWslStatus(): Promise<WslStatusView>;
  redetectWsl(): Promise<WslStatusView>;
  getSettings(): Promise<AppSettingsView>;
  saveSettings(update: AppSettingsUpdate): Promise<SettingsSaveResult>;
  chooseDataDirectory(): Promise<string | null>;
  openDataDirectory(): Promise<void>;
  openSettingsDirectory(): Promise<void>;
  clearAgentResults(): Promise<void>;
  restartApp(): Promise<void>;
  testLlm(): Promise<LlmTestResult>;
  embeddingStatus(): Promise<EmbeddingStatus>;
  runAgent(request: AgentRunRequest): Promise<AgentResult>;
  getAgentResults(): Promise<AgentResult[]>;
  exportConversations(): Promise<ConversationExportBundle[]>;
  getConversationTree(): Promise<ConversationTree>;
  recallSessions(query: string, topK?: number): Promise<SessionRecallHit[]>;
  getExtensionBridgeStatus(): Promise<ExtensionBridgeStatusView>;
  createExtensionPairCode(): Promise<ExtensionPairCodeView>;
  disconnectExtensionClient(clientId: string): Promise<boolean>;
  reportExtensionImportResult(result: ExtensionImportResultPayload): Promise<void>;
  onExtensionImportRequest(listener: (payload: ExtensionImportRequestPayload) => void): () => void;
  onExtensionBridgeChanged(callback: () => void): () => void;
  onCaptureChanged(callback: () => void): () => void;
  chooseDirectory(title?: string): Promise<string | null>;
  writeUpstreamFile(request: UpstreamWriteFileRequest): Promise<UpstreamWriteFileResult>;
  testNotionConnection(): Promise<NotionTestResult>;
  exportNotionPage(request: NotionExportRequest): Promise<NotionExportResult>;
  prepareRelayCliCommands(request: RelayPrepareCliRequest): Promise<RelayPrepareCliResult>;
  enqueueRelayOutbox(request: RelayOutboxEnqueueRequest): Promise<RelayOutboxEnqueueResult>;
}

/**
 * Window-control bridge for the custom title bar, exposed as
 * window.vestiWindow. `platform` lets the renderer adapt its chrome
 * (macOS keeps native traffic lights and needs the left inset).
 */
export interface VestiWindowApi {
  platform: string;
  minimize(): void;
  toggleMaximize(): void;
  close(): void;
  isMaximized(): Promise<boolean>;
  onMaximizedChanged(listener: (maximized: boolean) => void): () => void;
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
