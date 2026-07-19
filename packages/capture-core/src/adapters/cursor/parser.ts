/**
 * Cursor stores modern Composer conversations in global state.vscdb:
 *   composerHeaders -> composerData:<id> -> bubbleId:<composerId>:<bubbleId>
 * Values are read as JSON. Unknown fields are deliberately ignored so schema
 * additions do not break capture.
 */

import type { ParsedMessage, ParsedSession, SessionTokenUsage } from '../../types/agent.js';
import type { ToolExecution } from '../../types/index.js';

type SqliteDatabase = import('better-sqlite3').Database;
type JsonObject = Record<string, unknown>;

interface ComposerHeader extends JsonObject {
  composerId?: string;
  name?: string;
  createdAt?: unknown;
  lastUpdatedAt?: unknown;
  isArchived?: boolean;
  isSubagent?: boolean;
  workspaceIdentifier?: unknown;
}

function record(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function parseJson(value: unknown): JsonObject | null {
  if (value === null || value === undefined) return null;
  const text = Buffer.isBuffer(value) ? value.toString('utf8') : String(value);
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as JsonObject : null;
  } catch {
    return null;
  }
}

function toTimestamp(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 10_000_000_000 ? Math.round(value * 1000) : Math.round(value);
  }
  if (typeof value === 'string') {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && value.trim()) return toTimestamp(numeric, fallback);
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function textValue(value: unknown, max = 1_000_000): string {
  let text = '';
  if (typeof value === 'string') text = value;
  else if (value !== null && value !== undefined) {
    try { text = JSON.stringify(value); } catch { text = String(value); }
  }
  return text.length > max ? `${text.slice(0, max)}\n[truncated by Vesti]` : text;
}

function jsonish(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}

function tableExists(db: SqliteDatabase, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

function uriPath(value: unknown): string {
  const obj = record(value);
  const uri = record(obj.uri ?? value);
  for (const candidate of [uri.fsPath, uri.path, uri.external, obj.fsPath, obj.path]) {
    if (typeof candidate === 'string' && candidate) {
      if (candidate.startsWith('file://')) {
        try { return decodeURIComponent(new URL(candidate).pathname).replace(/^\/([A-Za-z]:)/, '$1'); } catch { /* fall through */ }
      }
      return candidate;
    }
  }
  return '';
}

function extractThinking(bubble: JsonObject): string {
  if (typeof bubble.thinking === 'string') return bubble.thinking;
  const thinking = record(bubble.thinking);
  return typeof thinking.text === 'string' ? thinking.text : '';
}

function extractModel(data: JsonObject, bubbles: JsonObject[]): string | undefined {
  const configured = record(data.modelConfig).modelName;
  if (typeof configured === 'string' && configured) return configured;
  for (const bubble of bubbles) {
    const name = record(bubble.modelInfo).modelName;
    if (typeof name === 'string' && name) return name;
  }
  return undefined;
}

export class CursorParser {
  private async open(filePath: string): Promise<SqliteDatabase> {
    const BetterSqlite3 = (await import('better-sqlite3')).default;
    const db = new BetterSqlite3(filePath, { readonly: true, fileMustExist: true }) as SqliteDatabase;
    db.pragma('busy_timeout = 2000');
    return db;
  }

  async countSessions(filePath: string): Promise<number> {
    const db = await this.open(filePath);
    try {
      if (tableExists(db, 'composerHeaders')) {
        const row = db.prepare('SELECT COUNT(*) AS count FROM composerHeaders').get() as { count?: number } | undefined;
        if (row?.count) return row.count;
      }
      if (!tableExists(db, 'cursorDiskKV')) return 0;
      const row = db.prepare("SELECT COUNT(*) AS count FROM cursorDiskKV WHERE key LIKE 'composerData:%' AND value IS NOT NULL").get() as { count?: number } | undefined;
      return row?.count ?? 0;
    } finally {
      db.close();
    }
  }

  async parseDatabase(filePath: string): Promise<ParsedSession[]> {
    const db = await this.open(filePath);
    try {
      if (!tableExists(db, 'cursorDiskKV')) return [];
      const headers = this.readHeaders(db);
      const rows = db.prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%' AND value IS NOT NULL").all() as Array<{ key: string; value: unknown }>;
      const sessions: ParsedSession[] = [];

      for (const row of rows) {
        const data = parseJson(row.value);
        if (!data) continue;
        const composerId = typeof data.composerId === 'string'
          ? data.composerId
          : row.key.slice('composerData:'.length);
        if (!composerId || composerId.length < 8) continue;
        const header = headers.get(composerId) ?? {};
        const parsed = this.parseComposer(db, filePath, composerId, data, header);
        if (parsed && parsed.messages.length > 0) sessions.push(parsed);
      }

      return sessions.sort((a, b) => b.startTime - a.startTime);
    } finally {
      db.close();
    }
  }

  private readHeaders(db: SqliteDatabase): Map<string, ComposerHeader> {
    const result = new Map<string, ComposerHeader>();
    if (tableExists(db, 'composerHeaders')) {
      const rows = db.prepare('SELECT composerId, createdAt, lastUpdatedAt, isArchived, isSubagent, value FROM composerHeaders').all() as Array<Record<string, unknown>>;
      for (const row of rows) {
        const value = parseJson(row.value) ?? {};
        const composerId = String(row.composerId ?? value.composerId ?? '');
        if (!composerId) continue;
        result.set(composerId, { ...value, ...row, composerId });
      }
    }

    if (tableExists(db, 'ItemTable')) {
      const row = db.prepare("SELECT value FROM ItemTable WHERE key='composer.composerHeaders'").get() as { value?: unknown } | undefined;
      const value = parseJson(row?.value);
      const all = Array.isArray(value?.allComposers) ? value.allComposers : [];
      for (const item of all) {
        const header = record(item) as ComposerHeader;
        if (typeof header.composerId !== 'string') continue;
        result.set(header.composerId, { ...(result.get(header.composerId) ?? {}), ...header });
      }
    }
    return result;
  }

  private parseComposer(
    db: SqliteDatabase,
    filePath: string,
    composerId: string,
    data: JsonObject,
    header: ComposerHeader,
  ): ParsedSession | null {
    const fallbackStart = toTimestamp(data.createdAt ?? header.createdAt, Date.now());
    const headerList = Array.isArray(data.fullConversationHeadersOnly)
      ? data.fullConversationHeadersOnly.map(record)
      : [];
    const bubbleEntries: Array<{ bubble: JsonObject; header: JsonObject }> = [];
    const bubbleStatement = db.prepare('SELECT value FROM cursorDiskKV WHERE key = ?');

    for (const bubbleHeader of headerList) {
      const bubbleId = typeof bubbleHeader.bubbleId === 'string' ? bubbleHeader.bubbleId : '';
      if (!bubbleId) continue;
      const row = bubbleStatement.get(`bubbleId:${composerId}:${bubbleId}`) as { value?: unknown } | undefined;
      const bubble = parseJson(row?.value);
      if (bubble) bubbleEntries.push({ bubble, header: bubbleHeader });
    }

    if (bubbleEntries.length === 0) {
      const conversationMap = record(data.conversationMap);
      for (const value of Object.values(conversationMap)) {
        const bubble = record(value);
        if (Object.keys(bubble).length) bubbleEntries.push({ bubble, header: bubble });
      }
    }

    const messages: ParsedMessage[] = [];
    const toolExecutions: ToolExecution[] = [];
    const bubbles = bubbleEntries.map(entry => entry.bubble);
    let firstPrompt = '';
    let sequence = 0;

    for (const { bubble, header: bubbleHeader } of bubbleEntries) {
      const bubbleId = typeof bubble.bubbleId === 'string'
        ? bubble.bubbleId
        : typeof bubbleHeader.bubbleId === 'string' ? bubbleHeader.bubbleId : `bubble-${sequence}`;
      const ts = toTimestamp(bubble.createdAt ?? bubbleHeader.createdAt, fallbackStart + sequence);
      const type = Number(bubble.type ?? bubbleHeader.type);
      const role = type === 1 ? 'user' : 'assistant';
      const text = typeof bubble.text === 'string' ? bubble.text.trim() : '';
      const thinking = extractThinking(bubble).trim();
      const tool = record(bubble.toolFormerData);

      if (role === 'user') {
        if (text) {
          if (!firstPrompt) firstPrompt = text;
          messages.push({
            uuid: `cursor-${composerId}-${bubbleId}`,
            type: 'user',
            role: 'user',
            timestamp: ts,
            contentText: text,
            isToolResult: false,
            depth: 0,
          });
        }
        sequence++;
        continue;
      }

      if (Object.keys(tool).length > 0) {
        const callId = String(tool.toolCallId ?? bubbleId);
        const name = String(tool.name ?? `cursor_tool_${String(tool.tool ?? 'unknown')}`);
        const input = jsonish(tool.params ?? tool.rawArgs ?? {});
        const callMessageId = `cursor-${composerId}-${bubbleId}-tool-call`;
        messages.push({
          uuid: callMessageId,
          type: 'assistant',
          role: 'assistant',
          timestamp: ts,
          contentText: text || undefined,
          contentThinking: thinking || undefined,
          toolCalls: [{ id: callId, name, input }],
          isToolResult: false,
          depth: 0,
        });

        const hasResult = tool.result !== undefined || tool.error !== undefined || String(tool.status ?? '').toLowerCase() !== 'running';
        let resultMessageId: string | undefined;
        let resultText = '';
        const isError = Boolean(tool.error) || /error|failed/i.test(String(tool.status ?? ''));
        if (hasResult) {
          resultText = textValue(tool.error ?? tool.result ?? tool.status ?? '');
          resultMessageId = `cursor-${composerId}-${bubbleId}-tool-result`;
          messages.push({
            uuid: resultMessageId,
            type: 'user',
            role: 'user',
            timestamp: ts + 1,
            toolResults: [{ toolUseId: callId, content: resultText, isError }],
            isToolResult: true,
            depth: 0,
          });
        }

        toolExecutions.push({
          id: `cursor-${composerId}-tool-${callId}`,
          conversationId: '',
          toolUseMessageId: callMessageId,
          toolResultMessageId: resultMessageId,
          toolUseId: callId,
          toolName: name,
          inputSummary: textValue(input, 500),
          outputSummary: resultText.slice(0, 500),
          isError,
          timestamp: ts,
        });
      } else if (text || thinking) {
        messages.push({
          uuid: `cursor-${composerId}-${bubbleId}`,
          type: 'assistant',
          role: 'assistant',
          timestamp: ts,
          contentText: text || undefined,
          contentThinking: thinking || undefined,
          isToolResult: false,
          depth: 0,
        });
      }
      sequence++;
    }

    if (messages.length === 0) return null;
    const timestamps = messages.map(message => message.timestamp).filter(value => value > 0);
    const startTime = timestamps.length ? Math.min(...timestamps) : fallbackStart;
    const endTime = timestamps.length ? Math.max(...timestamps) : toTimestamp(data.lastUpdatedAt ?? header.lastUpdatedAt, startTime);
    const model = extractModel(data, bubbles);
    const tokenUsage: SessionTokenUsage = {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheCreationTokens: 0,
      totalCacheReadTokens: 0,
      models: new Set(model ? [model] : []),
    };
    const title = typeof data.name === 'string' && data.name.trim()
      ? data.name.trim()
      : typeof header.name === 'string' ? header.name.trim() : '';

    // Empty-window composers genuinely have no workspace on disk; tag them so
    // consumers can distinguish "no folder was open" from "path not captured".
    const headerWs = record(header.workspaceIdentifier);
    const wsIdentifier = headerWs.id !== undefined ? headerWs : record(data.workspaceIdentifier);
    const isEmptyWindow = wsIdentifier.id === 'empty-window';

    return {
      sessionId: composerId,
      platform: 'cursor',
      projectPath: uriPath(header.workspaceIdentifier) || uriPath(data.workspaceIdentifier),
      model,
      messages,
      toolExecutions,
      subagents: [],
      tokenUsage,
      startTime,
      endTime,
      meta: {
        first_prompt: title || firstPrompt || undefined,
        composer_name: title || undefined,
        archived: header.isArchived === true || data.isArchived === true,
        is_subagent: header.isSubagent === true || data.isSubagent === true,
        empty_window: isEmptyWindow || undefined,
        source_database: filePath,
        unified_mode: data.unifiedMode,
        force_mode: data.forceMode,
      },
    };
  }
}
