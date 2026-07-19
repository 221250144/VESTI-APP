export type Platform =
  | "ChatGPT"
  | "Claude"
  | "Gemini"
  | "DeepSeek"
  | "Qwen"
  | "Doubao"
  | "Kimi"
  | "Yuanbao"
  // Desktop capture platforms (local AI coding tools)
  | "Codex"
  | "Cursor"
  | "Kimi Code"
  | "Claude Code"
  | "Aider";

export type UiThemeMode = "light" | "dark";

export interface Topic {
  id: number;
  name: string;
  parent_id: number | null;
  created_at: number;
  updated_at: number;
  count?: number;
  children?: Topic[];
}

export interface GardenerStep {
  step: string;
  status: "pending" | "running" | "completed";
  details?: string;
}

export interface GardenerResult {
  tags: string[];
  matchedTopic?: Topic;
  createdTopic?: Topic;
  steps: GardenerStep[];
}

export interface Conversation {
  id: number;
  title: string;
  platform: Platform;
  snippet: string;
  url?: string;
  tags: string[];
  topic_id: number | null;
  created_at: number;
  updated_at: number;
  source_created_at?: number | null;
  first_captured_at?: number;
  last_captured_at?: number;
  message_count?: number;
  is_starred: boolean;
  is_archived?: boolean;
  is_trash?: boolean;
  has_note?: boolean;
}

export interface RelatedConversation {
  id: number;
  title: string;
  platform: Platform;
  similarity: number;
}

export type ExploreMode = "agent" | "classic";

export type ExploreSearchScopeMode = "all" | "selected";

export interface ExploreSearchScope {
  mode: ExploreSearchScopeMode;
  conversationIds?: number[];
}

export interface ExploreAskOptions {
  searchScope?: ExploreSearchScope;
}

export type ExploreIntentType =
  | "fact_lookup"
  | "cross_conversation_summary"
  | "weekly_review"
  | "timeline"
  | "clarification_needed";

export type ExploreRequestedTimeScopePreset =
  | "none"
  | "current_week_to_date"
  | "last_7_days"
  | "last_full_week"
  | "custom";

export interface ExploreRequestedTimeScope {
  preset: ExploreRequestedTimeScopePreset;
  label?: string;
  startDate?: string;
  endDate?: string;
}

export interface ExploreResolvedTimeScope {
  preset: Exclude<ExploreRequestedTimeScopePreset, "none">;
  label: string;
  rangeStart: number;
  rangeEnd: number;
  startDate: string;
  endDate: string;
}

export type ExplorePlannerPath = "rag" | "weekly_summary" | "clarify";

export type ExploreToolName =
  | "intent_planner"
  | "time_scope_resolver"
  | "weekly_summary_tool"
  | "query_planner"
  | "search_rag"
  | "summary_tool"
  | "context_compiler"
  | "answer_synthesizer";

export type ExploreToolStatus = "completed" | "failed" | "skipped";

export interface ExploreToolCall {
  id: string;
  name: ExploreToolName;
  status: ExploreToolStatus;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  description?: string;
  inputSummary?: string;
  outputSummary?: string;
  error?: string;
}

export interface ExploreContextCandidate {
  conversationId: number;
  title: string;
  platform: Platform;
  similarity: number;
  matchType?: "semantic" | "time_scope";
  selectionReason?: string;
  summarySnippet?: string;
  excerpt?: string;
}

export interface ExploreAgentPlan {
  intent: ExploreIntentType;
  reason: string;
  preferredPath: ExplorePlannerPath;
  sourceLimit: number;
  summaryTargetCount: number;
  answerGoal?: string;
  needsClarification?: boolean;
  clarifyingQuestion?: string;
  requestedTimeScope?: ExploreRequestedTimeScope;
  resolvedTimeScope?: ExploreResolvedTimeScope;
  toolPlan?: ExploreToolName[];
}

export interface ExploreAgentMeta {
  mode: ExploreMode;
  query?: string;
  searchScope?: ExploreSearchScope;
  plan?: ExploreAgentPlan;
  toolCalls: ExploreToolCall[];
  contextDraft?: string;
  contextCandidates?: ExploreContextCandidate[];
  selectedContextConversationIds?: number[];
  totalDurationMs?: number;
}

export interface RagResponse {
  answer: string;
  sources: RelatedConversation[];
  agent?: ExploreAgentMeta;
}

export type AstVersion = "ast_v1" | "ast_v2";

export interface AstRoot {
  type: "root";
  children: AstNode[];
}

export type AstNode =
  | AstTextNode
  | AstFragmentNode
  | AstParagraphNode
  | AstHeadingNode
  | AstBreakNode
  | AstListNode
  | AstListItemNode
  | AstCodeBlockNode
  | AstInlineCodeNode
  | AstStrongNode
  | AstEmphasisNode
  | AstTableNode
  | AstMathNode
  | AstAttachmentNode
  | AstBlockquoteNode;

export interface AstTextNode {
  type: "text";
  text: string;
}

export interface AstFragmentNode {
  type: "fragment";
  children: AstNode[];
}

export interface AstParagraphNode {
  type: "p";
  children: AstNode[];
}

export interface AstHeadingNode {
  type: "h1" | "h2" | "h3";
  children: AstNode[];
}

export interface AstBreakNode {
  type: "br";
}

export interface AstListNode {
  type: "ul" | "ol";
  children: AstNode[];
}

export interface AstListItemNode {
  type: "li";
  children: AstNode[];
}

export interface AstCodeBlockNode {
  type: "code_block";
  code: string;
  language?: string | null;
}

export interface AstInlineCodeNode {
  type: "code_inline";
  text: string;
}

export interface AstStrongNode {
  type: "strong";
  children: AstNode[];
}

export interface AstEmphasisNode {
  type: "em";
  children: AstNode[];
}

export type AstTableAlign = "left" | "center" | "right" | null;

export type AstTableNode = AstTableNodeLegacy | AstTableNodeV2;

export interface AstTableNodeLegacy {
  type: "table";
  kind?: "legacy";
  headers: string[];
  rows: string[][];
}

export interface AstTableColumnV2 {
  align?: AstTableAlign;
  header: AstNode[];
}

export interface AstTableCellV2 {
  align?: AstTableAlign;
  children: AstNode[];
}

export interface AstTableRowV2 {
  cells: AstTableCellV2[];
}

export interface AstTableNodeV2 {
  type: "table";
  kind: "v2";
  columns: AstTableColumnV2[];
  rows: AstTableRowV2[];
}

export interface AstMathNode {
  type: "math";
  tex: string;
  display?: boolean;
}

export interface AstAttachmentNode {
  type: "attachment";
  name: string;
  mime?: string | null;
}

export interface AstBlockquoteNode {
  type: "blockquote";
  children: AstNode[];
}

export type MessageCitationSourceType =
  | "inline_pill"
  | "search_card"
  | "reference_list"
  | "unknown";

export interface MessageCitation {
  label: string;
  href: string;
  host: string;
  sourceType: MessageCitationSourceType;
}

export type MessageArtifactKind =
  | "canvas"
  | "preview"
  | "code_artifact"
  | "download_card"
  | "standalone_artifact"
  | "unknown";

export type MessageArtifactCaptureMode =
  | "presence_only"
  | "embedded_dom_snapshot"
  | "standalone_artifact";

export interface MessageArtifact {
  kind: MessageArtifactKind;
  label?: string;
  captureMode?: MessageArtifactCaptureMode;
  renderDimensions?: { width: number; height: number };
  plainText?: string;
  markdownSnapshot?: string;
  normalizedHtmlSnapshot?: string;
}

export type MessageAttachmentOccurrenceRole = "user_upload";

export interface MessageAttachment {
  indexAlt: string;
  label?: string;
  mime?: string | null;
  occurrenceRole: MessageAttachmentOccurrenceRole;
}

export interface Message {
  id: number;
  conversation_id: number;
  role: "user" | "ai";
  content_text: string;
  content_ast?: AstRoot | null;
  content_ast_version?: AstVersion | null;
  degraded_nodes_count?: number;
  citations?: MessageCitation[];
  attachments?: MessageAttachment[];
  artifacts?: MessageArtifact[];
  normalized_html_snapshot?: string | null;
  created_at: number;
}

export interface Annotation {
  id: number;
  conversation_id: number;
  message_id: number;
  content_text: string;
  created_at: number;
  days_after: number;
}

export type AsyncStatus = "idle" | "loading" | "ready" | "error";
export type ExportFormat = "json" | "txt" | "md";
export type StorageUsageStatus = "ok" | "warning" | "blocked";

export interface StorageUsageSnapshot {
  originUsed: number;
  originQuota: number | null;
  localUsed: number;
  unlimitedStorageEnabled: boolean;
  softLimit: number;
  hardLimit: number;
  status: StorageUsageStatus;
}

export type ConversationFilters = {
  platform?: Platform;
  search?: string;
  dateRange?: { start: number; end: number };
};

export interface ExploreSession {
  id: string;
  title: string;
  preview: string;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface ExploreMessage {
  id: string;
  sessionId: string;
  role: "user" | "assistant";
  content: string;
  sources?: RelatedConversation[];
  agentMeta?: ExploreAgentMeta;
  timestamp: number;
}

export type StorageApi = {
  getTopics: () => Promise<Topic[]>;
  getConversations: (filters?: ConversationFilters) => Promise<Conversation[]>;
  runGardener?: (
    conversationId: number
  ) => Promise<{ updated: boolean; conversation: Conversation; result: GardenerResult }>;
  getRelatedConversations?: (
    conversationId: number,
    limit?: number
  ) => Promise<RelatedConversation[]>;
  getAllEdges?: (options?: {
    threshold?: number;
    conversationIds?: number[];
  }) => Promise<Array<{ source: number; target: number; weight: number }>>;
  getMessages?: (conversationId: number) => Promise<Message[]>;
  getAnnotationsByConversation?: (conversationId: number) => Promise<Annotation[]>;
  saveAnnotation?: (payload: {
    conversationId: number;
    messageId: number;
    contentText: string;
  }) => Promise<Annotation>;
  deleteAnnotation?: (annotationId: number) => Promise<void>;
  exportAnnotationToNote?: (annotationId: number) => Promise<Note>;
  exportAnnotationToNotion?: (
    annotationId: number
  ) => Promise<{ pageId: string; url?: string }>;
  updateConversation?: (
    id: number,
    changes: { topic_id?: number | null; is_starred?: boolean; tags?: string[] }
  ) => Promise<{ updated: boolean; conversation: Conversation }>;
  updateConversationTitle?: (id: number, title: string) => Promise<Conversation>;
  deleteConversation?: (id: number) => Promise<void>;
  renameFolderTag?: (
    from: string,
    to: string
  ) => Promise<{ updated: number }>;
  moveFolderTag?: (
    from: string,
    to: string
  ) => Promise<{ updated: number }>;
  removeFolderTag?: (tag: string) => Promise<{ updated: number }>;
  askKnowledgeBase?: (
    query: string,
    sessionId?: string,
    limit?: number,
    mode?: ExploreMode,
    options?: ExploreAskOptions
  ) => Promise<RagResponse & { sessionId: string }>;
  // Explore Session APIs
  createExploreSession?: (title: string) => Promise<string>;
  listExploreSessions?: (limit?: number) => Promise<ExploreSession[]>;
  getExploreSession?: (sessionId: string) => Promise<ExploreSession | null>;
  getExploreMessages?: (sessionId: string) => Promise<ExploreMessage[]>;
  deleteExploreSession?: (sessionId: string) => Promise<void>;
  renameExploreSession?: (sessionId: string, title: string) => Promise<void>;
  updateExploreMessageContext?: (
    messageId: string,
    contextDraft: string,
    selectedContextConversationIds: number[]
  ) => Promise<void>;
  runRoundtable?: (
    question: string,
    personaIds: RoundtablePersonaId[],
    opts?: { lang?: "zh" | "en" }
  ) => Promise<RoundtableResult>;
  getSummary?: (conversationId: number) => Promise<ChatSummaryData | null>;
  generateSummary?: (conversationId: number) => Promise<ChatSummaryData>;
  /** Bulk digest fetch for the library list/detail views (P1.5). */
  getConversationDigests?: () => Promise<ConversationDigest[]>;
  /** Desktop conversation tree for the source-tree nav (P2b). */
  getConversationTree?: () => Promise<ConversationTree | null>;
  /** Soft-trash conversations in bulk (P2b organizer). Returns the number
   * actually updated. Soft trash keeps the record (and its capture lineage)
   * so capture re-syncs reconcile cleanly. */
  trashConversations?: (ids: number[]) => Promise<number>;
  /** Add one tag to many conversations at once (P2b organizer); respects the
   * per-conversation tag cap. Returns the number actually updated. */
  bulkAddTag?: (ids: number[], tag: string) => Promise<number>;
  // P4a AI relay: handoff packs distilled from multi-selected conversations.
  listRelayPacks?: () => Promise<RelayPack[]>;
  /** Assembles context, runs the relay agent, persists and returns the pack.
   * Rejects when the LLM is not configured or the output is malformed. */
  generateRelayPack?: (conversationIds: number[]) => Promise<RelayPack>;
  deleteRelayPack?: (id: number) => Promise<void>;
  /** Serializes the pack to Markdown and writes it under a user-chosen
   * directory; resolves null when the user cancels the picker. */
  exportRelayPackMarkdown?: (id: number) => Promise<{ relativePath: string } | null>;
  /** Writes the pack Markdown into the app relay directory and returns
   * copyable CLI launch commands (kimi/claude/codex). */
  getRelayPackCliCommands?: (id: number) => Promise<RelayCliCommandView[]>;
  /** Pushes the pack's suggested prompt into the extension bridge outbox
   * (Bridge Protocol v1.1); rejects when no extension is paired. */
  deliverRelayPackToBrowser?: (id: number) => Promise<void>;
  /** Capability probe for the relay UI: LLM configured + extension paired. */
  getRelayAvailability?: () => Promise<RelayAvailability>;
  // P4b knowledge extract: reusable knowledge assets from multi-selected
  // conversations. The result is not persisted; the panel saves it into the
  // deposits area on demand (template 'extract').
  generateExtract?: (conversationIds: number[]) => Promise<ExtractResult>;
  // P4b deposits area: distilled long-lived knowledge documents.
  listDeposits?: () => Promise<Deposit[]>;
  /** Persist a ready-made deposit (extract results, external content). */
  createDeposit?: (input: CreateDepositInput) => Promise<Deposit>;
  /** Resolve the scope, run the distill agent and persist the new deposit
   * (or a version+1 regeneration when previousId is given). Rejects when the
   * LLM is not configured or the scope matches no conversations. */
  generateDeposit?: (input: GenerateDepositInput) => Promise<Deposit>;
  renameDeposit?: (id: number, title: string) => Promise<Deposit>;
  deleteDeposit?: (id: number) => Promise<void>;
  /** Preview how many conversations a scope resolves to (scope picker). */
  resolveDepositScope?: (scope: DepositScope) => Promise<number[]>;
  /** Serializes the deposit Markdown and writes it under a user-chosen
   * directory; resolves null when the user cancels the picker. */
  exportDepositMarkdown?: (id: number) => Promise<{ relativePath: string } | null>;
  // P4c daily log + weekly report.
  listDailyLogs?: () => Promise<DailyLog[]>;
  /** Generate (or regenerate) the log for a local day ("YYYY-MM-DD";
   * defaults to today). Resolves null when the day had no activity. */
  generateDailyLog?: (input?: { date?: string }) => Promise<DailyLog | null>;
  /** Dates that should have a log but don't (yesterday missed + today past
   * the scheduled time), oldest first — drives the "catch up" action. */
  getPendingDailyDates?: () => Promise<string[]>;
  /** Streak + week-activity header stats for the log view. */
  getDailyLogOverview?: () => Promise<DailyLogOverview>;
  listWeeklyReports?: () => Promise<WeeklyReport[]>;
  /** Aggregate the last 7 local days into a weekly report (upserted by
   * range). Rejects when the week had no activity at all. */
  generateWeeklyReport?: () => Promise<WeeklyReport>;
  /** Serializes the daily-log Markdown and writes it under a user-chosen
   * directory; resolves null when the user cancels the picker. */
  exportDailyLogMarkdown?: (id: number) => Promise<{ relativePath: string } | null>;
  getNotes?: () => Promise<Note[]>;
  saveNote?: (note: CreateNoteInput) => Promise<Note>;
  updateNote?: (id: number, changes: UpdateNoteChanges) => Promise<Note>;
  deleteNote?: (id: number) => Promise<void>;
  getObsidianVaultStatus?: () => Promise<ObsidianVaultStatus>;
  connectObsidianVault?: () => Promise<ObsidianVaultStatus>;
  exportNoteToObsidian?: (note: Note) => Promise<ObsidianNoteExportResult>;
  // Send a whole conversation / its summary out as ready Markdown.
  // `conversation` + `scope` let implementations re-serialize from structured
  // data (desktop P3 upstream export) instead of using the prebuilt markdown;
  // payload mode (derived outputs) passes neither.
  exportConversationToNotion?: (input: {
    title: string;
    markdown: string;
    conversation?: Conversation;
    scope?: "conversation" | "summary";
  }) => Promise<{ pageId: string; url?: string }>;
  exportConversationToObsidian?: (input: {
    title: string;
    markdown: string;
    conversation?: Conversation;
    scope?: "conversation" | "summary";
  }) => Promise<{ relative_path: string; vault_name: string; exported_at: number }>;
  importObsidianDirectory?: (
    vaultName: string,
    entries: ObsidianImportFileEntry[]
  ) => Promise<ObsidianImportSummary>;
  importObsidianZip?: (
    fileName: string,
    data: ArrayBuffer
  ) => Promise<ObsidianImportSummary>;
  getNoteAsset?: (assetId: string) => Promise<NoteAssetRecord | null>;
  getStorageUsage?: () => Promise<StorageUsageSnapshot>;
  exportData?: (
    format: ExportFormat
  ) => Promise<{ blob: Blob; filename: string; mime: string }>;
  clearAllData?: () => Promise<void>;
  // Prompt Management
  listPrompts?: (filter?: PromptListFilter) => Promise<Prompt[]>;
  searchPrompts?: (query: string, limit?: number) => Promise<Prompt[]>;
  createPrompt?: (
    input: CreatePromptInput
  ) => Promise<{ prompt: Prompt; created: boolean }>;
  updatePrompt?: (id: number, changes: UpdatePromptChanges) => Promise<Prompt>;
  deletePrompt?: (id: number) => Promise<void>;
  togglePromptFavorite?: (id: number, isFavorite: boolean) => Promise<Prompt>;
  incrementPromptUsage?: (id: number) => Promise<Prompt>;
  extractPromptsFromLibrary?: (options?: {
    scope?: "all" | "recent";
    limit?: number;
  }) => Promise<PromptExtractionResult>;
  completePrompt?: (payload: {
    draft: string;
    platform?: Platform;
    useLibrary?: boolean;
  }) => Promise<PromptCompletionResult>;
};

// ---- Prompt Management types (mirror of frontend/src/lib/types) -------------

export type PromptSource = "manual" | "extracted";

export interface Prompt {
  id: number;
  title: string;
  body: string;
  category: string | null;
  tags: string[];
  source: PromptSource;
  source_platform: Platform | null;
  source_conversation_id: number | null;
  source_message_id: number | null;
  is_favorite: boolean;
  is_archived: boolean;
  quality_score: number;
  summary: string | null;
  variables: string[];
  use_count: number;
  last_used_at: number | null;
  body_hash: string;
  created_at: number;
  updated_at: number;
}

export interface CreatePromptInput {
  title?: string;
  body: string;
  category?: string | null;
  tags?: string[];
  source?: PromptSource;
  source_platform?: Platform | null;
  source_conversation_id?: number | null;
  source_message_id?: number | null;
  is_favorite?: boolean;
  summary?: string | null;
  quality_score?: number;
}

export interface UpdatePromptChanges {
  title?: string;
  body?: string;
  category?: string | null;
  tags?: string[];
  is_favorite?: boolean;
  is_archived?: boolean;
  summary?: string | null;
  quality_score?: number;
  source?: PromptSource;
}

export interface PromptListFilter {
  category?: string | null;
  favoritesOnly?: boolean;
  includeArchived?: boolean;
  source?: PromptSource;
  search?: string;
  sort?: "recent" | "score" | "usage";
}

export interface PromptExtractionResult {
  created: number;
  skipped: number;
  candidates: number;
  usedLlm: boolean;
}

export interface PromptCompletionResult {
  completion: string;
  usedLlm: boolean;
}

export interface ArtifactMetaData {
  title: string;
  generated_at: string;
  tags: string[];
  fallback: boolean;
  range_label?: string;
}

export interface ChatSummaryData {
  meta: ArtifactMetaData;
  core_question: string;
  thinking_journey: Array<{
    step: number;
    speaker: "User" | "AI";
    assertion: string;
    real_world_anchor: string | null;
  }>;
  key_insights: Array<{
    term: string;
    definition: string;
  }>;
  unresolved_threads: string[];
  meta_observations: {
    thinking_style: string;
    emotional_tone: string;
    depth_level: "superficial" | "moderate" | "deep";
  };
  actionable_next_steps: string[];
  plain_text?: string;
}

/**
 * Lightweight per-conversation digest (P1.5 conversation tree index).
 * Produced by the desktop digest pipeline; optional in the StorageApi so
 * platforms without it (extension) simply render the plain snippet.
 */
export interface ConversationDigest {
  conversationId: number;
  oneLiner: string;
  keyTopics: string[];
  keyFiles: string[];
  decisions: string[];
}

// ---- P4a AI relay (handoff packs) -----------------------------------------
// Mirror of the desktop db relay types (src/ui/db/types.ts). The pack payload
// keeps the relay agent's snake_case JSON contract verbatim so a stored pack
// round-trips losslessly.
export interface RelayPackKeyFile {
  path: string;
  why: string;
  last_state: string;
}

export interface RelayPackPayload {
  title: string;
  goal: string;
  current_state: string;
  key_decisions: string[];
  key_files: RelayPackKeyFile[];
  open_issues: string[];
  next_steps: string[];
  suggested_prompt: string;
}

export interface RelayPack {
  id: number;
  createdAt: number;
  title: string;
  conversationIds: number[];
  pack: RelayPackPayload;
  suggestedPrompt: string;
  source: "manual";
}

export interface RelayCliCommandView {
  id: string;
  label: string;
  command: string;
}

export interface RelayAvailability {
  llmConfigured: boolean;
  extensionConnected: boolean;
}

// ---- P4b knowledge extract + deposits --------------------------------------
// Mirror of the desktop db deposit types (src/ui/db/types.ts) and the extract
// agent's normalized JSON payload (src/main/agentPrompts.ts).
export interface ExtractCodeSnippet {
  language: string;
  code: string;
  why: string;
}

export interface ExtractDecision {
  title: string;
  context: string;
  decision: string;
  consequences: string;
}

export interface ExtractPayload {
  knowledge_points: string[];
  code_snippets: ExtractCodeSnippet[];
  decisions: ExtractDecision[];
  prompts: string[];
}

/** One extract run over a multi-selection. Not persisted by itself — the
 * panel saves it into the deposits area (template 'extract') on demand. */
export interface ExtractResult {
  title: string;
  conversationIds: number[];
  extract: ExtractPayload;
}

export type DepositTemplate =
  | "background_knowledge"
  | "project_state"
  | "writing_style"
  | "extract"
  | "custom";

export type DepositScope =
  | { kind: "project"; projectKey: string; label: string }
  | { kind: "topic"; topicId: number; label: string }
  | { kind: "timerange"; start: number; end: number }
  | { kind: "selection"; conversationIds: number[] };

export interface Deposit {
  id: number;
  createdAt: number;
  updatedAt: number;
  template: DepositTemplate;
  title: string;
  scope: DepositScope;
  contentMarkdown: string;
  version: number;
  prevId: number | null;
  customInstruction: string | null;
}

export interface CreateDepositInput {
  template: DepositTemplate;
  title: string;
  scope: DepositScope;
  contentMarkdown: string;
  version?: number;
  prevId?: number | null;
  customInstruction?: string | null;
}

/** Distill generation request: resolve the scope, run the distill agent and
 * persist the result. previousId regenerates an existing deposit as
 * version+1 chained onto it. */
export interface GenerateDepositInput {
  template: DepositTemplate;
  scope: DepositScope;
  customInstruction?: string;
  previousId?: number;
}

// ---- P4c daily log + weekly report -----------------------------------------
// Mirror of the desktop db daily types (src/ui/db/types.ts). Optional in
// StorageApi: platforms without the desktop pipeline leave them
// unimplemented and the tab renders the empty state.

export interface DailyLogStats {
  cliSessions: number;
  browserConversations: number;
  platforms: string[];
  projects: string[];
  messages: number;
}

export interface DailyLog {
  id: number;
  /** Local calendar day, "YYYY-MM-DD". Unique per row. */
  date: string;
  createdAt: number;
  updatedAt: number;
  contentMarkdown: string;
  stats: DailyLogStats;
  source: "auto" | "manual";
}

/** Stats header for the log view (streak + week activity). */
export interface DailyLogOverview {
  totalDays: number;
  streak: number;
  week: Array<{ date: string; messages: number; hasLog: boolean }>;
}

export interface WeeklyReport {
  id: number;
  rangeStart: number;
  rangeEnd: number;
  content: string;
  createdAt: number;
}

// ---- Conversation tree (P2b source-tree nav) -------------------------------
// Field-for-field mirror of the desktop conversation-tree contract
// (src/shared/contracts.ts). Optional in StorageApi: platforms without a
// capture pipeline (the extension) leave it unimplemented and the source-tree
// navigation simply stays hidden.
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

export type NoteSourceType = "native" | "obsidian";
export type ObsidianImportSourceKind = "directory" | "zip";
export type NoteImportAssetKind = "link" | "embed";

export interface NoteImportAssetRef {
  path: string;
  asset_id: string | null;
  kind: NoteImportAssetKind;
}

export interface NoteImportConflict {
  detected_at: number;
  incoming_source_file_hash: string;
  incoming_content: string;
  incoming_frontmatter: Record<string, unknown> | null;
}

export interface NoteImportMeta {
  vault_id: string | null;
  vault_name: string | null;
  relative_path: string | null;
  folder_path: string | null;
  frontmatter: Record<string, unknown> | null;
  wikilinks: string[];
  embeds: string[];
  tags: string[];
  assets: NoteImportAssetRef[];
  source_mtime: number | null;
  source_file_hash: string | null;
  last_imported_note_hash: string | null;
  imported_at: number | null;
  last_imported_at: number | null;
  conflict: NoteImportConflict | null;
}

export interface NoteObsidianExportMeta {
  vault_id: string;
  relative_path: string;
  last_exported_at: number;
}

export type ObsidianVaultConnectionState =
  | "not_connected"
  | "connected"
  | "needs_reconnect";

export interface ObsidianVaultStatus {
  state: ObsidianVaultConnectionState;
  vault_id: string | null;
  vault_name: string | null;
}

export interface Note {
  id: number;
  title: string;
  content: string;
  excerpt: string;
  hash: string;
  created_at: number;
  updated_at: number;
  linked_conversation_ids: number[];
  source_type: NoteSourceType;
  source_path: string | null;
  import_meta: NoteImportMeta | null;
  obsidian_export: NoteObsidianExportMeta | null;
}

export interface CreateNoteInput {
  title: string;
  content: string;
  linked_conversation_ids: number[];
  source_type?: NoteSourceType;
  source_path?: string | null;
  import_meta?: NoteImportMeta | null;
  obsidian_export?: NoteObsidianExportMeta | null;
}

export interface UpdateNoteChanges {
  title?: string;
  content?: string;
  linked_conversation_ids?: number[];
  source_type?: NoteSourceType;
  source_path?: string | null;
  import_meta?: NoteImportMeta | null;
  obsidian_export?: NoteObsidianExportMeta | null;
}

export interface NoteSourceRecord {
  id: string;
  name: string;
  kind: ObsidianImportSourceKind;
  created_at: number;
  updated_at: number;
}

export interface NoteAssetRecord {
  id: string;
  vault_id: string;
  relative_path: string;
  mime_type: string;
  hash: string;
  byte_size: number;
  blob: Blob;
  created_at: number;
  updated_at: number;
}

export interface ObsidianImportFileEntry {
  path: string;
  mime_type: string;
  last_modified: number;
  data: ArrayBuffer;
}

export interface ObsidianImportSummary {
  vaultId: string;
  importedNotes: number;
  updatedNotes: number;
  skippedNotes: number;
  conflictedNotes: number;
  importedAssets: number;
  unsupportedFiles: string[];
}

export interface ObsidianNoteExportResult {
  note: Note;
  vault_id: string;
  vault_name: string;
  relative_path: string;
  exported_at: number;
}

export interface ExploreStarterPromptLabel {
  title: string;
  prompt: string;
  detail: string;
}

export interface ExploreStarterDeckLabel {
  eyebrow: string;
  title: string;
  description: string;
  privacyTip: string;
  capabilityHint: string;
  prompts: readonly ExploreStarterPromptLabel[];
}

export interface ExploreLabels {
  // Choose Conversations dialog
  chooseConversationsTitle: string;
  chooseConversationsDesc: string;
  applySelected: string;
  useAll: string;
  noSearchResults: string;
  noPreviewAvailable: string;
  closeSidebar: string;
  openSidebar: string;
  noConversationsSelected: string;
  oneConversationSelected: string;
  multipleConversationsSelected: string;
  // Sessions / scope / mode toggles
  newChat: string;
  noConversationsYet: string;
  today: string;
  yesterday: string;
  earlier: string;
  agent: string;
  classic: string;
  all: string;
  selected: string;
  allConversations: string;
  send: string;
  starterPrompts: string;
  choosePromptHint: string;
  loadingStarterIdeas: string;
  starterDeckReady: string;
  cardsUpdateHint: string;
  askPlaceholder: string;
  askAgentPlaceholder: string;
  askClassicPlaceholder: string;
  agentModeDesc: string;
  classicModeDesc: string;
  newChatPrefill: string;
  searchByTitlePlaceholder: string;
  fillComposer: string;
  // Existing flat starter-deck header keys (kept for backward compatibility)
  starterDeck1Eyebrow: string;
  starterDeck1Title: string;
  starterDeck1Description: string;
  starterDeck2Eyebrow: string;
  starterDeck2Title: string;
  starterDeck2Description: string;
  starterDeck3Eyebrow: string;
  starterDeck3Title: string;
  starterDeck3Description: string;
  // Structured starter content (drives STARTER_DECKS)
  modeStages: {
    agent: readonly string[];
    classic: readonly string[];
  };
  starterDecks: readonly ExploreStarterDeckLabel[];
  libraryStarter: {
    titleTemplate: string;
    promptTemplate: string;
    detail: string;
  };
  // Enum/key maps
  toolLabels: Record<ExploreToolName, string>;
  toolExplanations: Record<ExploreToolName, string>;
  intentLabels: Record<ExploreIntentType, string>;
  pathLabels: Record<ExplorePlannerPath, string>;
  toolStatus: {
    running: string;
    completed: string;
    failed: string;
  };
  // Helper returns / summaries
  inRange: string;
  unknown: string;
  unavailable: string;
  noToolCalls: string;
  toolCallsSummary: string;
  toolCallsSummaryFailed: string;
  stepsLabel: string;
  failedLabel: string;
  untitled: string;
  // Message authorship / meta bar
  you: string;
  assistantName: string;
  plan: string;
  toolCalls: string;
  intentPrefix: string;
  routePrefix: string;
  scopePrefix: string;
  timePrefix: string;
  currentScopePrefix: string;
  sourceControls: string;
  openContextDraft: string;
  sources: string;
  noRelevantConversations: string;
  // Refresh / starter
  refreshingSuggestions: string;
  open: string;
  // Error / notice strings
  failedToLoadConversations: string;
  exploreUnavailable: string;
  chooseAtLeastOne: string;
  failedToRetrieveAnswer: string;
  deleteConversationConfirm: string;
  contextDraftSaved: string;
  savedLocally: string;
  failedToSaveContext: string;
  copiedToClipboard: string;
  clipboardUnavailable: string;
  downloaded: string;
  selectAtLeastOneSource: string;
  couldNotDetermineQuery: string;
  regeneratedNotice: string;
  failedToRegenerate: string;
  dismiss: string;
  // Session list fallbacks / row actions
  untitledSession: string;
  noMessages: string;
  rename: string;
  delete: string;
  // Tool-call rows
  inputLabel: string;
  outputLabel: string;
  errorLabel: string;
  // aria labels
  resizeSidebarAria: string;
  resizeDrawerAria: string;
  // Drawer headings / plan fields
  executionDetails: string;
  contextDraft: string;
  plannerDecision: string;
  sourceLimitPrefix: string;
  summaryTargetPrefix: string;
  timeScopePrefix: string;
  whyThisRoute: string;
  goalPrefix: string;
  clarificationPrefix: string;
  plannedTools: string;
  plannerFootnote: string;
  noPlannerMetadata: string;
  noToolCallsRecorded: string;
  // Sources drawer
  activeQuery: string;
  selectedSourcesPrefix: string;
  candidateSources: string;
  noContextCandidates: string;
  saving: string;
  saveSelection: string;
  regenerateAnswer: string;
  openDraft: string;
  regenerationFootnote: string;
  // Context-draft drawer
  draftEditable: string;
  save: string;
  copy: string;
  downloadTxt: string;
}

export interface DataLabels {
  title: string;
  unavailableTitle: string;
  unavailableDesc: string;
  usedAppLimit: string;
  unknown: string;
  browserQuota: string;
  healthy: string;
  softLimitWarning: string;
  writeBlocked: string;
  storageWarning: string;
  storageBlocked: string;
  advancedStorageDetails: string;
  chromeStorageUsed: string;
  estimatedIndexedDb: string;
  softLimit: string;
  unlimitedStorage: string;
  enabled: string;
  disabled: string;
  exportLocalData: string;
  exportFormat: string;
  exportHint: string;
  dangerZone: string;
  dangerDesc: string;
  clearLocalData: string;
  clearPrompt: string;
  clearCancelled: string;
  localDataCleared: string;
  exportedFile: string;
  runningDataAction: string;
  refreshingStorage: string;
}

export interface DashboardLabels {
  tabs: {
    library: string;
    explore: string;
    network: string;
    prompts: string;
    deposits: string;
    daily: string;
  };
  nav: {
    backToExplore: string;
    backToNetwork: string;
    dashboardSections: string;
    closeDrawer: string;
  };
  settings: {
    settings: string;
    dataOperations: string;
    appearance: string;
    modelIntegration: string;
    themeShared: string;
    themeSharedDark: string;
    themeSharedLight: string;
    syncingAppearance: string;
    changesStayInSync: string;
    modelscopeKeyPlaceholder: string;
    savedLocally: string;
    saveFailed: string;
    storedInChromeStorage: string;
    availableInExtension: string;
    notionWorkspaceConnected: string;
    connectToNotion: string;
    legacyToken: string;
    oauthFlowDesc: string;
    connecting: string;
    change: string;
    connect: string;
    searchSharedDatabases: string;
    loadingSharedDatabases: string;
    noDatabasesLoaded: string;
    chooseDatabase: string;
    actionFailed: string;
    notionConnected: string;
    notionDisconnected: string;
    settingsSaved: string;
    manageIntegrationKeys: string;
    modelscopeKeyLabel: string;
    save: string;
    notionExportTitle: string;
    notionExportDesc: string;
    connectedChooseDatabase: string;
    oauthUnavailableOutsideExtension: string;
    disconnect: string;
    targetDatabase: string;
    databaseSearchPlaceholder: string;
    refresh: string;
    shareDatabaseHint: string;
    selectedColon: string;
    readyForOneShotExport: string;
    noSharedDatabasesFound: string;
    selectedDatabaseMessage: string;
    themeUpdateFailed: string;
  };
  library: {
    allConversations: string;
    starred: string;
    recent: string;
    folders: string;
    myNotes: string;
    exporting: string;
    notion: string;
    general: string;
    libraryNavigation: string;
    conversationCount: string;
    noMessages: string;
    loadingMessages: string;
    you: string;
    untitled: string;
    newNote: string;
    saving: string;
    unsavedChanges: string;
    noNoteYet: string;
    deleteNote: string;
    exitSplitView: string;
    deleteNotAvailable: string;
    renameNotAvailable: string;
    deleteFolderNotAvailable: string;
    renameFolderFailed: string;
    deleteFolderFailed: string;
    updateStarFailed: string;
    renameConversationFailed: string;
    newFolderPrompt: string;
    renameFolderPrompt: string;
    renameConversationPrompt: string;
    deleteConversationLabel: string;
    initiatingPipeline: string;
    extractingCore: string;
    generatingInsights: string;
    savingSummary: string;
    loadRelatedFailed: string;
    loadMessagesFailed: string;
    directoryExportNotSupported: string;
    directorySelectionCancelled: string;
    saveBeforeExport: string;
    exportFailed: string;
    // Reader / conversation detail
    analyzed: string;
    notAnalyzedYet: string;
    summary: string;
    noSummaryYet: string;
    generateSummary: string;
    regenerate: string;
    importToNotes: string;
    viewNote: string;
    originalConversation: string;
    preview: string;
    messageCountLabel: string;
    showOriginalMessages: string;
    hideOriginalMessages: string;
    loadingOriginalConversation: string;
    messagesAvailableButEmpty: string;
    openOriginal: string;
    splitView: string;
    openSplitView: string;
    exitSplit: string;
    conversationNote: string;
    updatedAt: string;
    updatedAtTime: string;
    notesForPrefix: string;
    linkedConversations: string;
    noLinkedConversations: string;
    open: string;
    focusNote: string;
    noNoteLinkedYet: string;
    startExtractingHint: string;
    startWritingPlaceholder: string;
    createConversationNote: string;
    extractedExcerptsPlaceholder: string;
    // Related
    relatedConversations: string;
    findingRelated: string;
    noRelatedConversations: string;
    unableToLoadRelated: string;
    relatedNotes: string;
    // Annotation
    addAnnotation: string;
    openAnnotation: string;
    annotation: string;
    annotationCount: string;
    annotationsCount: string;
    deleteThisComment: string;
    deleting: string;
    cancel: string;
    commentPlaceholder: string;
    commentsUnavailable: string;
    couldNotSaveComment: string;
    couldNotDeleteComment: string;
    myNotesExportUnavailable: string;
    savedToMyNotes: string;
    couldNotExportToMyNotes: string;
    notionExportUnavailable: string;
    sentToNotion: string;
    notionSettingsMissing: string;
    notionReconnectRequired: string;
    couldNotExportToNotion: string;
    addedOn: string;
    dayAfter: string;
    daysAfter: string;
    afterTheConversation: string;
    unknownTime: string;
    // Note editor
    localNote: string;
    obsidianNote: string;
    noExcerptYet: string;
    conflict: string;
    vaultPath: string;
    sourceHash: string;
    unknown: string;
    unavailable: string;
    attachments: string;
    attachmentPreview: string;
    previewAvailableForImages: string;
    useOpenForOtherAttachments: string;
    importMetadata: string;
    exportToObsidian: string;
    choosingFolder: string;
    notesWorkspace: string;
    selectNoteToEdit: string;
    localNotesAndObsidianShareEditor: string;
    loadingNotes: string;
    createLocalNoteHint: string;
    createNote: string;
    localNotes: string;
    noLocalNotesYet: string;
    importedVaults: string;
    // Rename / delete dialogs
    renameNote: string;
    updateNoteTitle: string;
    noteTitlePlaceholder: string;
    deleteNoteConfirm: string;
    deleteConversationConfirm: string;
    deleteFolderConfirm: string;
    // Actions
    star: string;
    unstar: string;
    rename: string;
    changeFolder: string;
    removeFromFolder: string;
    delete: string;
    moveToTopic?: string;
    noTopic?: string;
    folderActions: string;
    createNewFolder: string;
    newFolder: string;
    conversationActions: string;
    // Selection / Extract
    extract: string;
    // Status
    justNow: string;
    minutesAgo: string;
    hoursAgo: string;
    daysAgo: string;
    monthsAgo: string;
    yearsAgo: string;
    // Source file conflict
    sourceFileChangedAfterEdits: string;
    // Formatting
    dateUnknown: string;
    frontmatter: string;
    // Choose Conversations dialog
    chooseConversationsTitle: string;
    chooseConversationsDesc: string;
    applySelected: string;
    useAll: string;
    noSearchResults: string;
    noPreviewAvailable: string;
    closeSidebar: string;
    openSidebar: string;
    emptyDetailTitle: string;
    emptyDetailHint: string;
    summaryCard: {
      coreQuestion: string;
      thinkingJourney: string;
      step: string;
      example: string;
      keyInsights: string;
      unresolvedThreads: string;
      metaObservations: string;
      thinkingStyle: string;
      emotionalTone: string;
      depth: string;
      nextSteps: string;
      fallback: string;
    };
    sendToButton?: string;
    sendToNotionConversation?: string;
    sendToNotionSummary?: string;
    sendToObsidianConversation?: string;
    sendToObsidianSummary?: string;
    sendToExporting?: string;
    sendToDone?: string;
    sendToFailed?: string;
    // Source-tree navigation (P2b)
    sourceTree?: {
      sectionLabel: string;
      notes: string;
      browser: string;
      wslBadge: string;
    };
    // Organizer assistant (P2b)
    organize?: {
      button: string;
      title: string;
      subtitle: string;
      actionEmpty: string;
      actionEmptyDesc: string;
      actionDuplicates: string;
      actionDuplicatesDesc: string;
      actionTag: string;
      actionTagDesc: string;
      actionArchive: string;
      actionArchiveDesc: string;
      back: string;
      previewAffected: string;
      previewEmpty: string;
      previewMore: string;
      confirm: string;
      executing: string;
      done: string;
      failed: string;
      cancel: string;
      close: string;
      tagLabel: string;
      tagPlaceholder: string;
      archiveTarget: string;
      archiveNoTopic: string;
      scopeAll: string;
      scopeSelection: string;
      scopeOlder30: string;
      scopeOlder90: string;
      keepLabel: string;
      dropLabel: string;
      reasonSameSource: string;
      reasonSameTitle: string;
      unavailable: string;
    };
  };
  explore: ExploreLabels;
  data: DataLabels;
  network: {
    emptyTitle: string;
    emptyDesc: string;
    noConversationsYet: string;
    replayInfo: string;
    newConversationOn: string;
    conversationOn: string;
    buildingGraph: string;
    trendLabel: string;
    noSemanticLinks: string;
    dragHint: string;
    replay: string;
    edgeLoadingUnavailable: string;
    edgePlaybackUnavailable: string;
    close: string;
    started: string;
    messages: string;
    semanticLinks: string;
    noPreviewSnippet: string;
    tags: string;
    connectedConversations: string;
    noSemanticLinksForNode: string;
    viewInLibrary: string;
    edgeSemanticSimilarity: string;
    trendScrubberAriaLabel: string;
    conversationsVisible: string;
    appearsLaterInReplay: string;
    starred: string;
    unknownPlatform: string;
    conversationN: string;
    thinkingMapView: string;
    conversationMapView: string;
    thinkingMapEmpty: string;
    loadingThinkingMap: string;
    gapInsightTitle: string;
    gapInsightTemplate: string;
    conceptMentionedIn: string;
    relatedConversations: string;
  };
  prompts: {
    title: string;
    summary: string;
    extractFromChats: string;
    extracting: string;
    extractTooltip: string;
    newPrompt: string;
    searchPlaceholder: string;
    favorites: string;
    allCategories: string;
    sortRecent: string;
    sortQuality: string;
    sortUsage: string;
    loading: string;
    emptyNone: string;
    emptyFiltered: string;
    emptyHint: string;
    retry: string;
    favorite: string;
    unfavorite: string;
    copy: string;
    deleteAria: string;
    closeEditor: string;
    editorNew: string;
    editorEdit: string;
    fieldTitle: string;
    titlePlaceholder: string;
    fieldBody: string;
    bodyPlaceholder: string;
    improveTooltip: string;
    improving: string;
    improveWithAI: string;
    fieldCategory: string;
    categoryPlaceholder: string;
    fieldTags: string;
    tagsPlaceholder: string;
    markFavorite: string;
    openSource: string;
    save: string;
    cancel: string;
    deleteBtn: string;
    usedTimes: string;
    scorePoor: string;
    scoreGood: string;
    scoreHigh: string;
    toastBodyEmpty: string;
    toastSaved: string;
    toastDuplicate: string;
    toastUpdated: string;
    toastSaveFailed: string;
    toastDeleted: string;
    toastDeleteFailed: string;
    toastFavoriteFailed: string;
    toastCopied: string;
    toastClipboard: string;
    toastImproved: string;
    toastNoLlm: string;
    toastImproveFailed: string;
    toastExtract: string;
    unavailable: string;
    exportLabel: string;
    importLabel: string;
    importBackup: string;
    toastExported: string;
    toastImported: string;
    importFailed: string;
    loadFailed: string;
    draftFirst: string;
    extractFailed: string;
    summaryLabel: string;
    plazaTitle: string;
    plazaSubtitle: string;
    plazaDaily: string;
    plazaDailyHint: string;
    plazaUse: string;
    plazaSourcePrefix: string;
    supermarketTitle: string;
    supermarketSubtitle: string;
    myPlaza: string;
    myPlazaEmpty: string;
    adopt: string;
    adopted: string;
    selectAria: string;
    selectedCount: string;
    deleteSelected: string;
    clearSelection: string;
  };
  /** P4b deposits area labels (loose record, same idiom as the library
   * relay/organize groups: components carry English fallbacks inline). */
  deposits?: Record<string, string>;
  /** P4c daily log + weekly report labels (same loose-record idiom). */
  daily?: Record<string, string>;
  aiti: {
    modeAsk: string;
    modeAiti: string;
    modeRoundtable: string;
    title: string;
    subtitle: string;
    insufficient: string;
    sample: string;
    typeSeparator: string;
    strengthsTitle: string;
    empoweringIntro: string;
    obsessionsTitle: string;
    evidence: string;
    axisNeedsSignal: string;
    axisDepthLabel: string;
    axisDepthLeft: string;
    axisDepthRight: string;
    axisDepthLeftStrength: string;
    axisDepthRightStrength: string;
    axisMakerLabel: string;
    axisMakerLeft: string;
    axisMakerRight: string;
    axisMakerLeftStrength: string;
    axisMakerRightStrength: string;
    axisFocusLabel: string;
    axisFocusLeft: string;
    axisFocusRight: string;
    axisFocusLeftStrength: string;
    axisFocusRightStrength: string;
    axisAffectLabel: string;
    axisAffectLeft: string;
    axisAffectRight: string;
    axisAffectLeftStrength: string;
    axisAffectRightStrength: string;
    /** P5 思维意象: weak band [45,55] axis hint (distinct from no-signal). */
    axisSignalFaint: string;
    /** P5: overall note when any axis is weak ("意象轮廓尚浅"). */
    imageryFaint: string;
    /** P5: caption above the LLM persona footnote. */
    personaNoteLabel: string;
    /** P5: lead-in for the per-axis evidence chips. */
    evidenceBecause: string;
    /** P5: evidence chip fallback text, "{id}" = conversation id. */
    evidenceConversation: string;
    /** P5: export-share-image button. */
    exportCard: string;
  };
  learn: {
    modeLearn: string;
    title: string;
    subtitle: string;
    insufficient: string;
    sample: string;
    domainsTitle: string;
    uncategorized: string;
    domainConversations: string;
    glossaryTitle: string;
    openLoopsTitle: string;
    openLoopsEmpty: string;
  };
  roundtable: {
    title: string;
    subtitle: string;
    questionPlaceholder: string;
    personasLabel: string;
    run: string;
    running: string;
    latencyHint: string;
    needQuestion: string;
    seatsTitle: string;
    synthesisTitle: string;
    consensus: string;
    disagreements: string;
    recommendation: string;
    openQuestions: string;
    empty: string;
    personaSkeptic: string;
    personaOptimist: string;
    personaPragmatist: string;
    personaDomainExpert: string;
    personaDevilsAdvocate: string;
  };
}

/** A curated/recommended prompt for the 提示词广场 (Prompt Plaza). */
export interface PlazaPrompt {
  id: string;
  title: string;
  body: string;
  category: string;
  source: string;
  sourceUrl?: string;
  featured?: boolean;
}

/** A big-category group of curated prompts for the 提示词超市. */
export interface PlazaCategory {
  category: string;
  prompts: PlazaPrompt[];
}

/** AITI (个人内向探索) — a locally-computed "thinking fingerprint". */
export interface AitiAxisScore {
  /** stable axis key: "depth" | "maker" | "focus" | "affect" */
  key: string;
  /** 0..100, toward the axis's RIGHT pole */
  score: number;
  /** up to a few source conversations that contributed most (evidence) */
  evidenceConversationIds: number[];
  /** false when the axis has no supporting evidence (score is a neutral default,
   * not an observation) — the UI renders it muted instead of confidently labeled */
  hasSignal?: boolean;
}

export interface AitiObsession {
  term: string;
  count: number;
}

export interface AitiProfile {
  /** false → not enough summaries to be meaningful (show the gated state) */
  available: boolean;
  sampleSize: number;
  axes: AitiAxisScore[];
  obsessions: AitiObsession[];
}

/**
 * AITI 思维意象 (P5) — flat, already-localized mirror of the host's imagery
 * table entry (src/ui/aiti/imagery.ts). The host resolves axes → imagery and
 * hands the card render-ready strings; the package stays table-free.
 */
export interface AitiImagery {
  /** letter type code, e.g. "DMFS" */
  code: string;
  /** emblem asset id; the host maps it to src/ui/assets/emblems/<id>.png */
  emblemId: string;
  name: string;
  origin: string;
  verdict: string;
  /** axis keys whose signal is faint (no signal, or score inside [45, 55]) */
  weakAxes: string[];
  /** true when any axis is weak — the imagery outline is "尚浅" */
  faint: boolean;
}

/** "学习 Learn" — the captured KB reframed as a personal curriculum. */
export interface LearnDomain {
  topicId: number | null;
  name: string;
  count: number;
  deep: number;
  moderate: number;
  superficial: number;
}
export interface LearnGlossaryEntry {
  term: string;
  definition: string;
  conversationId?: number;
}
export interface LearnOpenLoop {
  text: string;
  conversationId: number;
}
export interface LearnProfile {
  available: boolean;
  sampleSize: number;
  domains: LearnDomain[];
  glossary: LearnGlossaryEntry[];
  openLoops: LearnOpenLoop[];
}

// ---- AI 圆桌 (Roundtable) ----
export type RoundtablePersonaId =
  | "skeptic"
  | "optimist"
  | "pragmatist"
  | "domain_expert"
  | "devils_advocate"
  | "moderator";

export interface RoundtablePersona {
  id: RoundtablePersonaId;
  nameZh: string;
  nameEn: string;
  blurbZh: string;
  blurbEn: string;
  systemPromptZh: string;
  systemPromptEn: string;
}

export interface RoundtableSeatTurn {
  personaId: RoundtablePersonaId;
  content: string;
  ok: boolean;
  error?: string;
  durationMs: number;
}

export interface RoundtableSynthesis {
  consensus: string[];
  disagreements: string[];
  recommendation: string;
  openQuestions: string[];
}

export interface RoundtableResult {
  question: string;
  lang: "zh" | "en";
  grounded: boolean;
  seatTurns: RoundtableSeatTurn[];
  synthesis: RoundtableSynthesis | null;
  synthesisRaw: string;
  sources: RelatedConversation[];
  totalDurationMs: number;
}

/** Everything the Prompts tab needs to render the plaza + supermarket. */
export interface PlazaData {
  /** Today's date-seeded recommendations. */
  daily: PlazaPrompt[];
  /** Full catalog grouped by big-category (the 提示词超市). */
  supermarket: PlazaCategory[];
  /** Catalog ids the user has adopted into their personal 提示词广场. */
  adoptedIds: string[];
}
