/**
 * Agent Adapter Types
 * Interfaces for platform-specific adapters
 */

import type { AgentPlatform, VestiMessage, VestiConversation, ToolExecution, Subagent, TokenUsage } from './index.js';
import type { HomeRoot } from '../platform/PathResolver.js';

// ==================== Adapter Interface ====================

export interface AgentAdapter {
  readonly platform: AgentPlatform;
  readonly name: string;

  /** Check if this agent is installed on the system */
  detect(): Promise<AgentDetectResult>;

  /** Parse a session file into normalized messages */
  parseSession(filePath: string): Promise<ParsedSession>;

  /** Parse a physical source that contains multiple sessions. */
  parseSessions?(filePath: string): Promise<ParsedSession[]>;

  /** Get all session file paths for this agent */
  getSessionFiles(): Promise<string[]>;

  /** Get watch glob patterns */
  getWatchPatterns(): string[];

  /** Whether SyncEngine should keep a compressed raw copy. */
  readonly shouldBackupSource?: boolean;

  /**
   * Multi-root support: replace the adapter's home roots (native first,
   * then any WSL homes). Adapters that omit this stay native-only.
   */
  setHomeRoots?(homes: HomeRoot[]): void;
}

export interface AgentDetectResult {
  installed: boolean;
  version?: string;
  installPath?: string;
  sessionCount?: number;
}

// ==================== Parsed Session ====================

export interface ParsedSession {
  sessionId: string;
  platform: AgentPlatform;
  projectPath: string;
  gitBranch?: string;
  claudeCodeVersion?: string;
  model?: string;

  /** Source host tag: 'native' or 'wsl:<distro>'. Set by SyncEngine from the file path. */
  host?: string;

  messages: ParsedMessage[];
  toolExecutions: ToolExecution[];
  subagents: SubagentRef[];
  tokenUsage: SessionTokenUsage;

  startTime: number;
  endTime?: number;

  meta?: Record<string, unknown>;
  contextCompactions?: Array<{ sequence: number; compactedAt: number; summary?: string }>;
  peakContextUsage?: number;

  /**
   * Non-fatal parse warnings, e.g. a high share of unrecognized wire events.
   * Surfaced so "parsed OK but extracted nothing" never fails silently.
   */
  warnings?: string[];
}

export interface ParsedMessage {
  uuid: string;
  parentUuid?: string;
  type: 'user' | 'assistant' | 'progress' | 'file-history-snapshot' | 'system' | 'queue-operation';
  role: 'user' | 'assistant' | 'system';
  timestamp: number;

  // Content
  contentText?: string;
  contentThinking?: string;
  toolCalls?: ToolCallBlock[];
  toolResults?: ToolResultBlock[];

  // Context
  cwd?: string;
  gitBranch?: string;
  sessionId?: string;

  // Token usage (assistant only)
  usage?: TokenUsage;
  stopReason?: string;

  // Source classification
  isToolResult: boolean;         // true if this user message is a tool_result (not real user input)

  // Enhanced metadata
  isApiError?: boolean;
  isCompactSummary?: boolean;
  permissionMode?: string;
  systemSubtype?: string;
  errorDetails?: string;         // JSON string of error metadata

  // Claude Code specific
  isSidechain?: boolean;
  agentId?: string;
  slug?: string;
  sourceToolAssistantUUID?: string;
  toolUseResult?: unknown;

  // Calculated
  depth: number;
}

// ==================== Content Blocks ====================

export interface ToolCallBlock {
  id: string;        // toolu_01...
  name: string;      // Bash, Read, Write, etc.
  input: unknown;
}

export interface ToolResultBlock {
  toolUseId: string;
  content: string;
  isError?: boolean;
}

// ==================== Subagent ====================

export interface SubagentRef {
  agentId: string;
  slug?: string;
  filePath: string;
}

// ==================== Token Aggregation ====================

export interface SessionTokenUsage {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheCreationTokens: number;
  totalCacheReadTokens: number;
  models: Set<string>;
}

// ==================== Progress Data ====================

export interface ProgressData {
  type: string;       // e.g. "bash_progress"
  output?: string;
  fullOutput?: string;
  toolUseID?: string;
  parentToolUseID?: string;
}
