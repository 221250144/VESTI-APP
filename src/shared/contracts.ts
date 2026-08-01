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

export type AgentKind = 'summary' | 'explore' | 'digest' | 'classify' | 'relay' | 'extract' | 'distill' | 'deposit-maintain' | 'daily' | 'persona' | 'roundtable-turn' | 'roundtable-synthesis' | 'learn-deepen' | 'learn-synthesis' | 'prompt-improve' | 'prompt-continue';

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
  /**
   * Per-request model override (capsule quick-ask picker). Demo-proxy mode
   * only accepts DEMO_PROXY_MODEL_IDS (anything else is rejected, never
   * silently sent); BYOK accepts any non-empty id. Defaults to the
   * settings-level modelId.
   */
  modelId?: string;
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
  // A1 subagent folding (optional: absent on renderer-built browser nodes)
  role?: "main" | "subagent";
  /** Display role of the subagent (Cursor subagentTypeName / Claude slug). */
  subagentRole?: string;
  parentSessionId?: string;
  orphan?: boolean;
  childCount?: number;
  descendantMessageCount?: number;
  children?: ConversationTreeSession[];
  // Memory v2 fork lineage (optional, additive)
  forkedFrom?: string | null;
  uniqueMessageCount?: number;
  duplicatedMessageCount?: number;
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

// ---- Memory v2: L0 project state + L2 project briefs ----
// Field-for-field mirrors of capture-core's ProjectState / ProjectBrief /
// FileTimelineEvent (renderer must not import the Node-only capture core).

export interface ProjectActiveFileView {
  path: string;
  touches: number;
  lastTouched: string;
}

/** L0: deterministic per-project "current state card". */
export interface ProjectStateView {
  projectKey: string;
  oneLiner: string;
  activeFiles: ProjectActiveFileView[];
  openQuestions: string[];
  sessionCount: number;
  lastActive: string;
  updatedAt: string;
}

/** L2: LLM-maintained cross-session project brief. */
export interface ProjectBriefView {
  projectKey: string;
  contentMarkdown: string;
  version: number;
  /** JSON array of the last deposit-maintain ops (for MaintainOpsBadge). */
  lastOps: string;
  updatedAt: string;
}

export interface FileTimelineEventView {
  sessionId: string;
  sessionTitle: string;
  platform: string;
  toolName: string;
  toolCategory: string;
  isError: boolean;
  timestamp: number;
}

export interface SessionRecallHit {
  sessionId: string;
  title: string;
  platform: string;
  score: number;
  snippet: string;
  oneLiner: string | null;
  // A1 subagent attribution (optional additive fields)
  hitSource?: "main" | "subagent";
  attributedSessionId?: string;
  subagentSessionId?: string;
}

// ---- Agent MCP registration (one-click vesti-mcp wiring) ----

export type AgentMcpTargetId = 'kimi-code' | 'claude-code' | 'codex' | 'cursor';

export interface AgentMcpTargetStatus {
  id: AgentMcpTargetId;
  label: string;
  /** Config file registration would touch. */
  configPath: string;
  /** The agent appears to be installed (config dir/file exists). */
  detected: boolean;
  /** A vesti entry exists in the agent's MCP config. */
  registered: boolean;
  /** The vesti entry matches exactly what this app would write. */
  upToDate: boolean;
  /** The built vesti-mcp server entry (dist/cli.js) exists on disk. */
  serverAvailable: boolean;
  serverEntry: string | null;
  /** Config read problem (e.g. malformed JSON); status never throws. */
  error?: string;
}

export interface AgentMcpWriteResult {
  ok: boolean;
  /** Whether the config file content actually changed (idempotency signal). */
  changed: boolean;
  /** Where the pre-write backup landed; null when nothing was rewritten. */
  backupPath: string | null;
  error?: string;
}


// ---- Local Beta membership ----

export type MembershipState = 'unregistered' | 'signed_out' | 'active' | 'expired';
export type MembershipPlan = 'beta';

/**
 * Public membership state exposed to renderers. Password material and the
 * stored credential hash never cross the preload boundary.
 */
export interface MembershipStatus {
  state: MembershipState;
  plan: MembershipPlan | null;
  registered: boolean;
  authenticated: boolean;
  active: boolean;
  username: string | null;
  memberSince: number | null;
  expiresAt: number | null;
  daysRemaining: number;
}

export interface MembershipCredentials {
  username: string;
  password: string;
}

export type MembershipErrorCode =
  | 'NOT_INITIALIZED'
  | 'ALREADY_REGISTERED'
  | 'INVALID_USERNAME'
  | 'WEAK_PASSWORD'
  | 'NOT_REGISTERED'
  | 'INVALID_CREDENTIALS'
  | 'AUTHENTICATION_REQUIRED'
  | 'MEMBERSHIP_EXPIRED'
  | 'MEMBERSHIP_DATA_CORRUPT'
  | 'STORAGE_ERROR';

export type MembershipActionResult =
  | { ok: true; status: MembershipStatus }
  | { ok: false; status: MembershipStatus; error: MembershipErrorCode };

export const IPC = {
  windowMinimize: 'vesti:window-minimize',
  windowToggleMaximize: 'vesti:window-toggle-maximize',
  windowClose: 'vesti:window-close',
  windowIsMaximized: 'vesti:window-is-maximized',
  windowMaximizedChanged: 'vesti:window-maximized-changed',
  membershipStatus: 'vesti:membership-status',
  membershipRegister: 'vesti:membership-register',
  membershipLogin: 'vesti:membership-login',
  membershipLogout: 'vesti:membership-logout',
  membershipChanged: 'vesti:membership-changed',
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
  projectStates: 'vesti:project-states',
  projectBrief: 'vesti:project-brief',
  fileTimeline: 'vesti:file-timeline',
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
  capsuleDockStatus: 'vesti:capsule-dock-status',
  capsuleQuickAsk: 'vesti:capsule-quick-ask',
  capsuleProjects: 'vesti:capsule-projects',
  capsuleRelayDraft: 'vesti:capsule-relay-draft',
  capsuleRelayPolish: 'vesti:capsule-relay-polish',
  capsuleSearchPrompts: 'vesti:capsule-search-prompts',
  capsulePromptSnapshotGet: 'vesti:capsule-prompt-snapshot-get',
  capsulePromptSnapshotSave: 'vesti:capsule-prompt-snapshot-save',
  capsuleCopyText: 'vesti:capsule-copy-text',
  capsulePanelHeight: 'vesti:capsule-panel-height',
  capsulePromptImprove: 'vesti:capsule-prompt-improve',
  capsulePromptContinue: 'vesti:capsule-prompt-continue',
  extensionBridgeStatus: 'vesti:extension-bridge-status',
  extensionPairCodeCreate: 'vesti:extension-pair-code-create',
  extensionPairingWindowOpen: 'vesti:extension-pairing-window-open',
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
  relaySessionContexts: 'vesti:relay-session-contexts',
  relayFileTouches: 'vesti:relay-file-touches',
  agentMcpStatus: 'vesti:agent-mcp-status',
  agentMcpRegister: 'vesti:agent-mcp-register',
  agentMcpUnregister: 'vesti:agent-mcp-unregister',
} as const;

// ---- Desktop floating capsule ----

export interface CapsuleState {
  watching: boolean;
  syncing: boolean;
  conversationCount: number;
  expanded: boolean;
}

// ---- Capsule dock (P6: layered quick panel) ----

/** A flattened conversation-tree project for the capsule relay scope picker. */
export interface CapsuleProjectView {
  platform: string;
  host: string;
  projectKey: string;
  label: string;
  pathOrDomain: string;
  /** Top-level sessions in this project (subagents fold under parents). */
  sessionCount: number;
  /** Up to 5 most recent sessions, newest first. */
  recentSessions: CapsuleRelaySessionView[];
}

export interface CapsuleRelaySessionView {
  sessionId: string;
  title: string;
  oneLiner: string | null;
  lastActivityAt: number;
}

/**
 * Relay scope: a project reference (platform+host+projectKey as returned by
 * capsuleGetProjects) plus an optional narrowing to explicit session ids.
 * When sessionIds is non-empty it wins over the project-wide selection.
 */
export interface CapsuleRelayDraftRequest {
  platform: string;
  host: string;
  projectKey: string;
  sessionIds?: string[];
}

/** Locally-assembled handoff draft (pure template, no LLM required). */
export interface CapsuleRelayDraft {
  text: string;
  sessionCount: number;
  sessions: CapsuleRelaySessionView[];
}

/** AI-polished handoff (agent kind 'relay'): paste-ready suggested prompt. */
export interface CapsuleRelayPolishResult {
  title: string;
  suggestedPrompt: string;
}

export interface CapsuleQuickAskResult {
  answer: string;
  /** How many archived sessions were recalled into the answer context. */
  recalled: number;
}

/**
 * Models the demo gateway (api.ccvg1218.online) actually proxies, verified
 * against the live service: the whitelist rejects anything else with
 * UNSUPPORTED_MODEL (qwen-turbo is an alias answered by qwen-plus), so the
 * app must never offer or send ids outside this list in demo mode —
 * otherwise the UI would show one model while another answers or the call
 * fails outright. BYOK accepts any id. deepseek-v4-flash is the intended
 * default once the gateway whitelist adds it; keep it out until the live
 * probe passes.
 */
export const DEMO_PROXY_MODEL_IDS = [
  'qwen-plus',
  'qwen-turbo',
] as const;
export type DemoProxyModelId = (typeof DEMO_PROXY_MODEL_IDS)[number];

/** One completed quick-ask exchange, kept client-side for multi-turn context. */
export interface CapsuleQuickAskTurn {
  question: string;
  answer: string;
}

export interface CapsuleQuickAskOptions {
  /** Per-request model override (demo mode: whitelist only; BYOK: any id). */
  modelId?: string;
  /** Recent completed turns (oldest first); only the last few are used. */
  history?: CapsuleQuickAskTurn[];
}

/** AI-refined prompt (agent kind 'prompt-improve'): new body + change notes. */
export interface CapsulePromptImproveResult {
  improved: string;
  notes: string[];
}

/** AI-continued prompt (agent kind 'prompt-continue'): full continued text. */
export interface CapsulePromptContinueResult {
  continued: string;
}

/** One prompt-library entry mirrored into the capsule-readable snapshot. */
export interface CapsulePromptSnapshotEntry {
  id: string;
  title: string;
  description: string;
  tags: string[];
  body: string;
  /** Origin label, e.g. 'manual' / 'extracted' / a platform name. */
  source: string;
}

/** ~/.vesti/cache/prompt-snapshot.json — written by the main renderer. */
export interface CapsulePromptSnapshot {
  updatedAt: number;
  prompts: CapsulePromptSnapshotEntry[];
}

/** Unified prompt hit for the capsule prompt assistant (curated + user). */
export interface CapsulePromptHit {
  id: string;
  title: string;
  description: string;
  tags: string[];
  body: string;
  origin: 'curated' | 'user';
  /** Attribution for curated entries (source collection). */
  source: string;
}

/** Availability flags + capture-point count for the capsule home screen. */
export interface CapsuleDockStatus {
  llmConfigured: boolean;
  extensionConnected: boolean;
  /** Capture sources that are enabled and detected as installed. */
  sourceCount: number;
  /** LLM access mode + the settings-level default model (for model pickers). */
  llmMode: LlmAccessMode;
  defaultModelId: string;
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
  showContextMenu(labels?: CapsuleContextMenuLabels): void;
  onStateChanged(listener: (state: CapsuleState) => void): () => void;
  // ---- P6 dock ----
  getDockStatus(): Promise<CapsuleDockStatus>;
  /** Recall-grounded quick question (agent kind 'explore'). */
  quickAsk(question: string, options?: CapsuleQuickAskOptions): Promise<CapsuleQuickAskResult>;
  getProjects(): Promise<CapsuleProjectView[]>;
  /** Assemble the local (no-LLM) handoff draft for a scope. */
  buildRelayDraft(request: CapsuleRelayDraftRequest): Promise<CapsuleRelayDraft>;
  /** AI-polish a draft into a paste-ready prompt (agent kind 'relay'). */
  relayAiPolish(draft: string): Promise<CapsuleRelayPolishResult>;
  /** Search curated catalog + user prompt snapshot. */
  searchPrompts(query: string): Promise<CapsulePromptHit[]>;
  /**
   * AI-refine a prompt body (agent kind 'prompt-improve', persist:false).
   * `instruction` is the user's natural-language refine request ("更简洁"…);
   * omitted → the default clarity/reusability pass.
   */
  improvePrompt(body: string, instruction?: string): Promise<CapsulePromptImproveResult>;
  /** AI-continue a prompt body (agent kind 'prompt-continue', persist:false). */
  continuePrompt(body: string): Promise<CapsulePromptContinueResult>;
  getPromptSnapshot(): Promise<CapsulePromptSnapshot | null>;
  /** Main-renderer only: persist the prompt snapshot for the capsule. */
  savePromptSnapshot(snapshot: CapsulePromptSnapshot): Promise<void>;
  /** Enqueue a prompt into the extension bridge outbox (browser delivery). */
  enqueueOutbox(prompt: string): Promise<RelayOutboxEnqueueResult>;
  /** Write a relay file + build CLI launch commands (shared with P4a). */
  prepareRelayCli(request: RelayPrepareCliRequest): Promise<RelayPrepareCliResult>;
  /** Reliable clipboard write from the main process. */
  copyText(text: string): Promise<void>;
  /** Temporarily grow the expanded panel (px); null restores the default. */
  setPanelHeight(height: number | null): Promise<void>;
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
  /** A1: parent work-session id when this session is a folded subagent run. */
  _subagent_of?: string;
  /** A1: subagent role/type (e.g. "bugbot", "Task"), when known. */
  _agent_role?: string;
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

/** Bridge Protocol v1.2: TOFU pairing window state shown in settings. */
export interface ExtensionPairingWindowState {
  open: boolean;
  expiresAt: number | null;
}

export interface ExtensionBridgeStatusView {
  running: boolean;
  port: number;
  error: string | null;
  clients: ExtensionBridgeClientView[];
  pairingWindow: ExtensionPairingWindowState;
}

export interface ExtensionPairCodeView {
  code: string;
  expiresAt: number;
}

/** Bridge Protocol v1.2: result of manually reopening the pairing window. */
export interface ExtensionPairingWindowView {
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

/**
 * Per-session relay context (P4a v2): the git fields from work_sessions plus
 * the full session digest (including open_questions, which the conversation
 * tree does not carry). Assembled in main; renderer merges it into the relay
 * transcript per selected conversation.
 */
export interface RelaySessionContextDigest {
  oneLiner: string | null;
  keyTopics: string[];
  keyFiles: string[];
  decisions: string[];
  openQuestions: string[];
}

export interface RelaySessionContext {
  sessionId: string;
  gitBranch: string | null;
  gitRemote: string | null;
  digest: RelaySessionContextDigest | null;
}

/**
 * Raw file-tool touch row (P4a relay quality): one captured read/write/edit
 * tool execution. The renderer aggregates these deterministically into the
 * anchored key-file list injected into the relay transcript, so the handoff
 * pack's file section is grounded on captured executions rather than model
 * recollection.
 */
export interface RelayFileTouchRow {
  sessionId: string;
  toolName: string;
  toolCategory: string;
  inputSummary: string | null;
  timestamp: number;
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
  getProjectStates(): Promise<ProjectStateView[]>;
  getProjectBrief(projectKey: string): Promise<ProjectBriefView | null>;
  getFileTimeline(query: { projectKey?: string; filePath: string }): Promise<FileTimelineEventView[]>;
  getExtensionBridgeStatus(): Promise<ExtensionBridgeStatusView>;
  createExtensionPairCode(): Promise<ExtensionPairCodeView>;
  openExtensionPairingWindow(): Promise<ExtensionPairingWindowView>;
  disconnectExtensionClient(clientId: string): Promise<boolean>;
  getAgentMcpStatus(): Promise<AgentMcpTargetStatus[]>;
  registerAgentMcp(id: AgentMcpTargetId): Promise<AgentMcpWriteResult>;
  unregisterAgentMcp(id: AgentMcpTargetId): Promise<AgentMcpWriteResult>;
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
  getRelaySessionContexts(sessionIds: string[]): Promise<RelaySessionContext[]>;
  getRelayFileTouches(sessionIds: string[]): Promise<RelayFileTouchRow[]>;
}

/** Authentication bridge available before the product shell is unlocked. */
export interface VestiMembershipApi {
  getStatus(): Promise<MembershipStatus>;
  register(credentials: MembershipCredentials): Promise<MembershipActionResult>;
  login(credentials: MembershipCredentials): Promise<MembershipActionResult>;
  logout(): Promise<MembershipStatus>;
  onStatusChanged(listener: (status: MembershipStatus) => void): () => void;
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
