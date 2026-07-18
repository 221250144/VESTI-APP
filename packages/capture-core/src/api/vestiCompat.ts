/**
 * VESTI Mainline Compatibility Layer
 * Converts VESTI-CLI data models to VESTI mainline format
 *
 * VESTI mainline uses:
 *   - Conversation { id: number, uuid, platform: "ChatGPT"|"Claude"|..., title, snippet, url, ... }
 *   - Message { id: number, conversation_id, role: "user"|"ai", content_text, ... }
 *
 * VESTI-CLI uses:
 *   - WorkSession { id: string, sessionId, platform: "claude-code"|"kimi-code"|..., title, ... }
 *   - SessionMessage { id: string, sessionId, source, role: "user"|"assistant"|"system", ... }
 */

import type { WorkSession, SessionMessage } from '../types/unified.js';

// ==================== ID Conversion ====================

/**
 * Convert a CLI string ID to a stable numeric ID.
 * Uses FNV-1a hash with offset to avoid collision with Dexie auto-increment IDs.
 */
const CLI_ID_OFFSET = 10_000_000;
// Hash space: (10M, 2^53-1). The previous 90M range hit ~50% collision
// probability at ~10k hashed IDs (birthday bound); 2^53 pushes that
// out past any realistic local session/message count.
const ID_SPACE = BigInt(Number.MAX_SAFE_INTEGER - CLI_ID_OFFSET);

export function cliIdToNumeric(cliId: string): number {
  // 64-bit FNV-1a folded into the safe-integer range above the offset.
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < cliId.length; i++) {
    hash ^= BigInt(cliId.charCodeAt(i));
    hash = (hash * prime) & mask;
  }
  return CLI_ID_OFFSET + Number(hash % ID_SPACE);
}

// Reverse lookup: numeric → CLI ID
const numericToCliIdMap = new Map<number, string>();

export function registerCliId(cliId: string): number {
  const numeric = cliIdToNumeric(cliId);
  numericToCliIdMap.set(numeric, cliId);
  return numeric;
}

export function resolveCliId(numericId: number | string): string | null {
  if (typeof numericId === 'string') {
    // Could be the CLI ID itself or a numeric string
    const asNum = parseInt(numericId);
    if (!isNaN(asNum) && numericToCliIdMap.has(asNum)) {
      return numericToCliIdMap.get(asNum)!;
    }
    return numericId; // Return as-is, might be CLI ID directly
  }
  return numericToCliIdMap.get(numericId) ?? null;
}

// ==================== Platform Mapping ====================

const CLI_TO_VESTI_PLATFORM: Record<string, string> = {
  'claude-code': 'Claude Code',
  'kimi-code': 'Kimi Code',
  'codex': 'Codex',
  'cursor': 'Cursor',
  'aider': 'Aider',
};

const VESTI_TO_CLI_PLATFORM: Record<string, string> = {
  'Claude Code': 'claude-code',
  'Kimi Code': 'kimi-code',
  'Codex': 'codex',
  'Cursor': 'cursor',
  'Aider': 'aider',
  'Claude': 'claude-code',
  'Kimi': 'kimi-code',
  'ChatGPT': 'codex',
};

export function mapPlatform(cliPlatform: string): string {
  return CLI_TO_VESTI_PLATFORM[cliPlatform] || cliPlatform;
}

/**
 * Reverse map: VESTI mainline platform → CLI platform name
 * Used when the frontend sends a platform filter in VESTI format
 */
export function reverseMapPlatform(vestiPlatform: string): string | undefined {
  return VESTI_TO_CLI_PLATFORM[vestiPlatform];
}

// ==================== Data Conversion ====================

export interface VestiConversationCompat {
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
  // Extension fields
  _source: 'local_terminal';
  _cli_id: string;
  _cli_platform: string;
  _project_path?: string;
  _model?: string;
  _tool_call_count?: number;
}

export interface VestiMessageCompat {
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
  // Extension fields
  _source: 'local_terminal';
  _thinking?: string;
  _tool_name?: string;
  _tool_input?: string;
  _tool_output?: string;
  _message_source?: string;
}

/**
 * Convert a WorkSession to VESTI mainline Conversation format
 */
export function workSessionToVestiConversation(
  ws: WorkSession,
  snippet?: string,
): VestiConversationCompat {
  const numericId = registerCliId(ws.id);

  return {
    id: numericId,
    uuid: ws.sessionId,
    platform: mapPlatform(ws.platform),
    title: ws.title,
    snippet: snippet || '',
    url: ws.projectPath ? `file://${ws.projectPath}` : '',
    source_created_at: ws.startedAt,
    first_captured_at: ws.startedAt,
    last_captured_at: ws.endedAt || ws.startedAt,
    created_at: ws.startedAt,
    updated_at: ws.endedAt || ws.startedAt,
    message_count: ws.messageCount,
    turn_count: ws.turnCount,
    is_archived: ws.status === 'archived',
    is_trash: false,
    tags: ws.tags || [],
    topic_id: null,
    is_starred: false,
    _source: 'local_terminal',
    _cli_id: ws.id,
    _cli_platform: ws.platform,
    _project_path: ws.projectPath || undefined,
    _model: ws.model || undefined,
    _tool_call_count: ws.toolCallCount || undefined,
  };
}

/**
 * Convert SessionMessages to VESTI mainline Message format
 * Only includes user_input and assistant_text (excludes tool_result, progress, system_event)
 */
export function sessionMessagesToVestiMessages(
  messages: SessionMessage[],
  conversationNumericId: number,
): VestiMessageCompat[] {
  return messages
    .filter(m =>
      m.source === 'user_input' ||
      m.source === 'assistant_text' ||
      m.source === 'assistant_think'
    )
    .map(m => {
      const msgNumericId = cliIdToNumeric(m.id);

      // Merge thinking into content for assistant_think messages
      const contentText = m.source === 'assistant_think'
        ? (m.contentThinking || '')
        : (m.contentText || '');

      return {
        id: msgNumericId,
        conversation_id: conversationNumericId,
        role: (m.role === 'user' ? 'user' : 'ai') as 'user' | 'ai',
        content_text: contentText,
        content_ast: null,
        content_ast_version: null,
        degraded_nodes_count: 0,
        citations: [] as never[],
        attachments: [] as never[],
        artifacts: [] as never[],
        normalized_html_snapshot: null,
        created_at: m.timestamp,
        _source: 'local_terminal' as const,
        _thinking: m.contentThinking || undefined,
        _tool_name: m.contentToolName || undefined,
        _tool_input: m.contentToolInput || undefined,
        _tool_output: m.contentToolOutput || undefined,
        _message_source: m.source,
      };
    });
}
