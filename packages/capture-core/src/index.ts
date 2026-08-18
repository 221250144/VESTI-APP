// @vesti-cli/core - Main entry point
export * from './types/index.js';
export * from './types/agent.js';
export * from './types/unified.js';
export { VestiConfig } from './config/VestiConfig.js';
export { DatabaseManager } from './storage/DatabaseManager.js';
export { MessageConverter } from './storage/MessageConverter.js';
export { ClaudeCodeParser } from './adapters/claude-code/parser.js';
export { ClaudeCodeAdapter } from './adapters/claude-code/adapter.js';
export type { ClaudeSessionMeta } from './adapters/claude-code/types.js';
export { CodexAdapter } from './adapters/codex/adapter.js';
export { CodexParser } from './adapters/codex/parser.js';
export { CursorAdapter } from './adapters/cursor/adapter.js';
export { CursorParser } from './adapters/cursor/parser.js';
export { AiderAdapter } from './adapters/aider/adapter.js';
export { AiderParser } from './adapters/aider/parser.js';
export { KimiCodeAdapter } from './adapters/kimi-code/adapter.js';
export { KimiCodeParser } from './adapters/kimi-code/parser.js';
export { TraeAdapter } from './adapters/trae/adapter.js';
export { TraeParser } from './adapters/trae/parser.js';
export { CoderAdapter } from './adapters/coder/adapter.js';
export { CoderParser } from './adapters/coder/parser.js';
export { WorkBuddyAdapter } from './adapters/workbuddy/adapter.js';
export { WorkBuddyParser } from './adapters/workbuddy/parser.js';
export { AdapterManager } from './adapters/AdapterManager.js';
export { WslDetector, decodeWslOutput, parseWslDistroList, wslDistroRoot } from './platform/WslDetector.js';
export type { WslDetection, WslDetectorOptions, WslUserHome } from './platform/WslDetector.js';
export { hostFromPath, nativeHomeRoot, rewriteSessionIdForHost } from './platform/PathResolver.js';
export type { HomeRoot } from './platform/PathResolver.js';
export { SyncEngine } from './sync/SyncEngine.js';
export type { SyncResult, SyncFileResult } from './sync/SyncEngine.js';
export { SearchEngine } from './search/SearchEngine.js';
export { serializeVector, deserializeVector, cosineSimilarity, searchByVector } from './search/VectorSearch.js';
export type { VectorCandidate, VectorMatch } from './search/VectorSearch.js';
export { buildSemanticEdges } from './search/SemanticEdges.js';
export type {
  SemanticEdgeVector,
  SemanticEdge,
  SemanticEdgePolicy,
  SemanticEdgeBuildResult,
} from './search/SemanticEdges.js';
export {
  recallSessions,
  recallTokens,
  toFtsQuery,
  buildSnippet,
  recencyFactor,
  detectFtsTokenizer,
  effectiveTokens,
  buildQueryPlan,
  confidenceForCoverage,
  RECENCY_TAU_DAYS,
  RECENCY_FLOOR,
  TRIGRAM_MIN_TOKEN_CHARS,
  COVERAGE_MERGE_MIN_SHORT_CHARS,
  CONFIDENCE_COVERAGE_FLOOR,
} from './search/SessionRecall.js';
export type { SessionRecallHit, SessionRecallOptions, RecallConfidence, QueryPlan } from './search/SessionRecall.js';
export { buildConversationTree } from './tree/TreeIndex.js';
export type {
  ConversationTree,
  ConversationTreeSource,
  ConversationTreeProject,
  ConversationTreeSession,
} from './tree/TreeIndex.js';
export {
  deriveProjectKey,
  projectBasis,
  projectLabel,
  normalizeProjectPath,
  normalizeGitRemote,
} from './storage/projectRegistry.js';
export type { ProjectKeyInput } from './storage/projectRegistry.js';
export {
  messageDedupKey,
  detectForksByMessageOverlap,
  buildForkAncestorMap,
  computeUniqueMessageCounts,
} from './tree/forks.js';
export type {
  ForkCandidateSession,
  ForkDetectionOptions,
  ForkCountSession,
} from './tree/forks.js';
export {
  buildProjectState,
  listProjectKeys,
  renderProjectStateMarkdown,
  extractFilePaths,
  rankActiveFiles,
  mergeOpenQuestions,
  ACTIVE_FILES_WINDOW_DAYS,
  ACTIVE_FILES_LIMIT,
  OPEN_QUESTIONS_LIMIT,
} from './state/projectState.js';
export { getFileTimeline, pathMatches } from './state/fileTimeline.js';
export { stripInjectedContextBlocks } from './utils/injectedBlocks.js';
export type { FileTimelineQuery } from './state/fileTimeline.js';
export { ExportEngine } from './export/ExportEngine.js';
export { VaultManager } from './storage/VaultManager.js';
export { APIServer } from './api/APIServer.js';
export {
  workSessionToVestiConversation,
  sessionMessagesToVestiMessages,
  firstVisibleUserSnippet,
  cliIdToNumeric,
  resolveCliId,
  mapPlatform,
  reverseMapPlatform,
} from './api/vestiCompat.js';
export type { VestiConversationCompat, VestiMessageCompat } from './api/vestiCompat.js';
