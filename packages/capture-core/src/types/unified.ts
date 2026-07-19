/**
 * VESTI-CLI v2 Unified Types
 * Double-layer architecture: raw vault + structured working memory
 */

import type { AgentPlatform } from './index.js';

// ==================== Message Source ====================

export type MessageSource =
  | 'user_input'       // Real user input (~1.7%)
  | 'tool_result'      // Tool execution result (~97.7%)
  | 'assistant_text'   // Agent text response
  | 'assistant_think'  // Agent thinking process
  | 'tool_request'     // Agent requesting tool call
  | 'progress'         // Tool execution intermediate output
  | 'system_event'     // API errors, retries, queue-operation
  | 'file_snapshot';   // File state snapshot

// ==================== Tool Category ====================

export type ToolCategory =
  | 'shell'       // Bash, terminal
  | 'file_read'   // Read, Cat
  | 'file_write'  // Write
  | 'file_edit'   // Edit, NotebookEdit
  | 'search'      // Glob, Grep, WebSearch, WebFetch
  | 'agent'       // Task (subagent)
  | 'git'         // Git operations
  | 'interaction' // AskUserQuestion, user interaction
  | 'planning'    // Plan mode, todo lists, scheduling
  | 'other';

// ==================== Tool Outcome ====================

export type ToolOutcome = 'success' | 'error' | 'pending';

// ==================== WorkSession ====================

export interface WorkSession {
  id: string;                    // {platform}:{sessionId} — WSL sources: {platform}:wsl-<distro>-{sessionId}
  sessionId: string;
  platform: AgentPlatform;
  host?: string;                 // 'native' | 'wsl:<distro>'
  platformVersion?: string;
  projectPath: string;
  gitBranch?: string;
  gitRemote?: string;
  model?: string;
  models?: string;               // JSON array of all models used

  title: string;
  summary?: string;
  tags: string[];
  status: 'active' | 'archived';
  sessionType: 'conversation' | 'file_snapshot' | 'empty';

  startedAt: number;
  endedAt?: number;
  lastActivityAt: number;
  durationMs: number;

  // Counts
  messageCount: number;
  userInputCount: number;        // Real user inputs (not tool_result)
  assistantMessageCount: number;
  thinkingCount: number;
  toolCallCount: number;
  codeBlockCount: number;
  turnCount: number;

  // Tokens
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheCreationTokens: number;
  totalCacheReadTokens: number;

  // Flags
  hasSubagents: boolean;
  hasContextCompaction: boolean;

  // Agent-specific metadata (JSON)
  agentMeta?: string;
  claudeCodeVersion?: string;

  createdAt: number;
  updatedAt: number;
}

// ==================== Turn ====================

export interface Turn {
  id: string;                    // {sessionId}:turn:{sequence}
  sessionId: string;             // WorkSession.id
  sequence: number;              // 1-based turn number

  userInput?: string;            // The user's actual input text
  userInputMessageId?: string;   // Message ID of the user_input message
  assistantResponse?: string;    // Final assistant text response (truncated)
  assistantResponseMessageId?: string;

  // Aggregated stats for this turn
  messageCount: number;
  toolExecutionCount: number;
  thinkingTokens: number;
  inputTokens: number;
  outputTokens: number;

  startedAt: number;
  endedAt?: number;
  durationMs: number;
}

// ==================== SessionMessage ====================

export interface SessionMessage {
  id: string;                    // uuid from raw data
  sessionId: string;             // WorkSession.id
  turnId?: string;               // Turn.id (null for orphan messages)
  source: MessageSource;
  sequence: number;              // Order within session

  role: 'user' | 'assistant' | 'system';

  contentText?: string;
  contentThinking?: string;
  contentToolName?: string;
  contentToolInput?: string;
  contentToolOutput?: string;
  contentToolError?: string;

  // Context
  cwd?: string;
  gitBranch?: string;

  // Tokens
  tokenInput?: number;
  tokenOutput?: number;
  tokenCacheCreation?: number;
  tokenCacheRead?: number;
  tokenReasoning?: number;
  model?: string;
  stopReason?: string;

  // Claude Code specific
  parentId?: string;
  depth: number;
  isSidechain?: boolean;
  agentId?: string;

  timestamp: number;
  createdAt: number;
}

// ==================== ToolExecution (enhanced) ====================

export interface UnifiedToolExecution {
  id: string;
  sessionId: string;             // WorkSession.id
  turnId?: string;               // Turn.id
  sequence: number;              // Order within turn

  toolUseMessageId: string;
  toolResultMessageId?: string;
  toolUseId: string;
  toolName: string;
  toolCategory: ToolCategory;
  outcome: ToolOutcome;

  inputSummary?: string;
  outputSummary?: string;
  displayData?: string;          // JSON: Kimi Code display array (diffs, briefs, todos)
  isError: boolean;
  exitCode?: number;
  durationMs?: number;
  timestamp: number;
}

// ==================== SubagentLink ====================

export interface SubagentLink {
  id: string;
  parentSessionId: string;       // Parent WorkSession.id
  childSessionId?: string;       // Child WorkSession.id (if synced)
  agentId: string;
  agentRole?: string;            // e.g. "Explore", "Plan"
  slug?: string;
  filePath: string;
  messageCount: number;
  spawnedAt?: number;
}

// ==================== ContextCompaction ====================

export interface ContextCompaction {
  id: string;
  sessionId: string;
  sequence: number;              // Which compaction (1st, 2nd, etc.)
  compactedAt: number;
  messagesBefore?: number;
  messagesAfter?: number;
  summary?: string;
}

// ==================== SystemEvent ====================

export interface SystemEvent {
  id: string;
  sessionId: string;
  turnId?: string;
  eventType: string;             // 'api_error', 'retry', 'rate_limit', 'queue_operation', etc.
  message?: string;
  metadata?: string;             // JSON
  timestamp: number;
}

// ==================== Converter Output ====================

export interface ConvertedSession {
  session: WorkSession;
  turns: Turn[];
  messages: SessionMessage[];
  toolExecutions: UnifiedToolExecution[];
  systemEvents: SystemEvent[];
  subagentLinks: SubagentLink[];
  contextCompactions: ContextCompaction[];
}

// ==================== Session Digest (P1.5) ====================

export type DigestEmbeddingStatus = 'none' | 'ok' | 'skipped' | 'failed';

export interface SessionDigest {
  sessionId: string;             // work_sessions.id
  host: string;
  platform: string;
  projectKey: string;
  oneLiner: string;
  keyTopics: string[];           // stored as JSON arrays
  keyFiles: string[];
  decisions: string[];
  openQuestions: string[];
  embedding?: Buffer | null;     // serialized Float32Array (little-endian)
  embeddingStatus: DigestEmbeddingStatus;
  digestVersion: number;
  messageCount: number;
  updatedAt: string;             // ISO 8601
}

// ==================== Project Registry (P1.5) ====================

export interface ProjectRegistryEntry {
  projectKey: string;
  kind: 'cli_path';
  label: string;
  pathOrDomain: string;
  firstSeen: string;             // ISO 8601
  lastSeen: string;              // ISO 8601
}

// ==================== Tool Category Mapping ====================

const TOOL_CATEGORY_MAP: Record<string, ToolCategory> = {
  // Shell (Claude Code + Kimi Code + Codex)
  Bash: 'shell',
  Shell: 'shell',
  shell_command: 'shell',
  // File read
  Read: 'file_read',
  ReadFile: 'file_read',
  Cat: 'file_read',
  readFile: 'file_read',
  readCode: 'file_read',
  ReadMediaFile: 'file_read',
  // File write
  Write: 'file_write',
  WriteFile: 'file_write',
  writeFile: 'file_write',
  // File edit
  Edit: 'file_edit',
  NotebookEdit: 'file_edit',
  MultiEdit: 'file_edit',
  StrReplaceFile: 'file_edit',
  // Search
  Glob: 'search',
  Grep: 'search',
  WebSearch: 'search',
  WebFetch: 'search',
  SearchWeb: 'search',
  FetchURL: 'search',
  // Agent (Claude Code + Kimi Code)
  Task: 'agent',
  Agent: 'agent',
  TaskCreate: 'agent',
  TaskUpdate: 'agent',
  TaskList: 'agent',
  TaskOutput: 'agent',
  TaskStop: 'agent',
  TaskGet: 'agent',
  // Git operations
  GitCommit: 'git',
  GitPush: 'git',
  GitPull: 'git',
  GitStatus: 'git',
  GitDiff: 'git',
  GitLog: 'git',
  GitBranch: 'git',
  GitCheckout: 'git',
  // User interaction
  AskUserQuestion: 'interaction',
  PromptUser: 'interaction',
  RequestApproval: 'interaction',
  // Planning & scheduling
  EnterPlanMode: 'planning',
  ExitPlanMode: 'planning',
  SetTodoList: 'planning',
  TodoWrite: 'planning',
  TodoRead: 'planning',
  CronCreate: 'planning',
  CronDelete: 'planning',
  CronList: 'planning',
  Skill: 'planning',
  EnterWorktree: 'planning',
  ExitWorktree: 'planning',
};

export function classifyTool(toolName: string): ToolCategory {
  return TOOL_CATEGORY_MAP[toolName] || 'other';
}
