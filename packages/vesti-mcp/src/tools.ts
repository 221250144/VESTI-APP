/**
 * The three-layer progressive-disclosure tools exposed over MCP:
 *
 *   1. vesti_search    — session-level index entries (~100 tokens each)
 *   2. vesti_timeline  — per-session turn outline to locate a passage
 *   3. vesti_get_turns — full message content for a handful of turns
 *
 * Pure SQL + string logic over a read-only database handle; every function
 * is unit-testable against a temporary database file.
 */

import type { VestiDatabase } from './db.js';
import { recallSessions } from './recall.js';

// ==================== shared helpers ====================

interface SessionRow {
  id: string;
  session_id: string;
  title: string;
  platform: string;
  host: string | null;
  project_path: string;
  started_at: number;
  ended_at: number | null;
  turn_count: number | null;
  message_count: number | null;
}

function getSession(db: VestiDatabase, id: string): SessionRow | undefined {
  return db
    .prepare(
      `SELECT id, session_id, title, platform, host, project_path,
              started_at, ended_at, turn_count, message_count
       FROM work_sessions WHERE id = ?`,
    )
    .get(id) as unknown as SessionRow | undefined;
}

/** Accept either the internal work_sessions.id or the platform session_id. */
export function resolveSession(db: VestiDatabase, sessionIdOrPlatformId: string): SessionRow | undefined {
  const byId = getSession(db, sessionIdOrPlatformId);
  if (byId) return byId;
  return db
    .prepare(
      `SELECT id, session_id, title, platform, host, project_path,
              started_at, ended_at, turn_count, message_count
       FROM work_sessions WHERE session_id = ? ORDER BY started_at DESC LIMIT 1`,
    )
    .get(sessionIdOrPlatformId) as unknown as SessionRow | undefined;
}

function iso(ms: number | null | undefined): string | null {
  return ms == null ? null : new Date(ms).toISOString();
}

function parseJsonArray(text: string | null | undefined): string[] {
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed.filter(item => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function oneLine(text: string | null | undefined, max = 160): string {
  const cleaned = (text ?? '').replace(/\s+/g, ' ').trim();
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, max - 1)}…`;
}

// ==================== layer 1: vesti_search ====================

export interface SearchEntry {
  session_id: string;
  title: string;
  platform: string;
  host: string | null;
  project_path: string;
  started_at: string | null;
  one_liner: string | null;
  key_topics: string[];
  snippet: string;
  score: number;
}

export function vestiSearch(
  db: VestiDatabase,
  args: { query: string; topK?: number },
): { query: string; count: number; results: SearchEntry[] } {
  const topK = Math.max(1, Math.min(args.topK ?? 8, 50));
  const hits = recallSessions(db, args.query, { topK });

  const metaStmt = db.prepare(
    `SELECT ws.id, ws.title, ws.platform, ws.host, ws.project_path, ws.started_at,
            sd.one_liner, sd.key_topics
     FROM work_sessions ws
     LEFT JOIN session_digests sd ON sd.session_id = ws.id
     WHERE ws.id = ?`,
  );

  const results = hits.map(hit => {
    const meta = metaStmt.get(hit.sessionId) as unknown as
      | {
          id: string;
          title: string;
          platform: string;
          host: string | null;
          project_path: string;
          started_at: number;
          one_liner: string | null;
          key_topics: string | null;
        }
      | undefined;
    // FTS may hit a thinking/tool column whose content_text is empty; a blank
    // snippet is worse than no snippet — fall back to the digest one-liner,
    // then to the session title.
    const snippet = hit.snippet.trim() || meta?.one_liner?.trim() || meta?.title || '';
    return {
      session_id: hit.sessionId,
      title: meta?.title ?? 'Untitled',
      platform: meta?.platform ?? '',
      host: meta?.host ?? null,
      project_path: meta?.project_path ?? '',
      started_at: iso(meta?.started_at),
      one_liner: meta?.one_liner ?? null,
      key_topics: parseJsonArray(meta?.key_topics),
      snippet: oneLine(snippet, 200),
      score: Number(hit.score.toFixed(6)),
    };
  });

  return { query: args.query, count: results.length, results };
}

// ==================== layer 2: vesti_timeline ====================

export interface TimelineTurn {
  seq: number;
  started_at: string | null;
  duration_ms: number | null;
  user_intent: string;
  tool_count: number;
  input_tokens: number;
  output_tokens: number;
}

export function vestiTimeline(
  db: VestiDatabase,
  args: { session_id: string; around_turn?: number; window?: number },
): {
  session: {
    session_id: string;
    title: string;
    platform: string;
    host: string | null;
    project_path: string;
    started_at: string | null;
    ended_at: string | null;
    turn_count: number;
    message_count: number;
  };
  total_turns: number;
  showing: { from_seq: number; to_seq: number };
  turns: TimelineTurn[];
} {
  const session = resolveSession(db, args.session_id);
  if (!session) {
    throw new Error(`Session not found: ${args.session_id}`);
  }

  interface TurnRow {
    sequence: number;
    started_at: number;
    duration_ms: number | null;
    user_input: string | null;
    tool_execution_count: number | null;
    input_tokens: number | null;
    output_tokens: number | null;
  }

  const allTurns = db
    .prepare(
      `SELECT sequence, started_at, duration_ms, user_input,
              tool_execution_count, input_tokens, output_tokens
       FROM turns WHERE session_id = ? ORDER BY sequence`,
    )
    .all(session.id) as unknown as TurnRow[];

  let rows = allTurns;
  const window = Math.max(1, args.window ?? 10);
  if (args.around_turn != null && allTurns.length > window * 2 + 1) {
    const center = allTurns.findIndex(t => t.sequence === args.around_turn);
    const at = center === -1 ? 0 : center;
    const start = Math.max(0, Math.min(at - window, allTurns.length - (window * 2 + 1)));
    rows = allTurns.slice(start, start + window * 2 + 1);
  }

  return {
    session: {
      session_id: session.id,
      title: session.title,
      platform: session.platform,
      host: session.host,
      project_path: session.project_path,
      started_at: iso(session.started_at),
      ended_at: iso(session.ended_at),
      turn_count: session.turn_count ?? allTurns.length,
      message_count: session.message_count ?? 0,
    },
    total_turns: allTurns.length,
    showing: {
      from_seq: rows[0]?.sequence ?? 0,
      to_seq: rows[rows.length - 1]?.sequence ?? 0,
    },
    turns: rows.map(t => ({
      seq: t.sequence,
      started_at: iso(t.started_at),
      duration_ms: t.duration_ms,
      user_intent: oneLine(t.user_input) || '(no user input recorded)',
      tool_count: t.tool_execution_count ?? 0,
      input_tokens: t.input_tokens ?? 0,
      output_tokens: t.output_tokens ?? 0,
    })),
  };
}

// ==================== layer 3: vesti_get_turns ====================

export interface TurnToolExecution {
  tool: string;
  outcome: string;
  input_summary: string | null;
  output_summary: string | null;
  is_error: boolean;
}

export interface TurnContent {
  seq: number;
  started_at: string | null;
  user: string;
  assistant: string;
  thinking: string;
  tools: TurnToolExecution[];
}

export function vestiGetTurns(
  db: VestiDatabase,
  args: {
    session_id: string;
    turn_ids?: number[];
    range?: { from: number; to: number };
    max_chars?: number;
  },
): {
  session_id: string;
  requested: number;
  returned: number;
  truncated: boolean;
  char_count: number;
  max_chars: number;
  turns: TurnContent[];
} {
  const session = resolveSession(db, args.session_id);
  if (!session) {
    throw new Error(`Session not found: ${args.session_id}`);
  }
  const maxChars = Math.max(500, args.max_chars ?? 8000);

  interface TurnRow {
    id: string;
    sequence: number;
    started_at: number;
    user_input: string | null;
  }

  let turnRows: TurnRow[];
  if (args.turn_ids && args.turn_ids.length > 0) {
    const placeholders = args.turn_ids.map(() => '?').join(',');
    turnRows = db
      .prepare(
        `SELECT id, sequence, started_at, user_input FROM turns
         WHERE session_id = ? AND sequence IN (${placeholders}) ORDER BY sequence`,
      )
      .all(session.id, ...args.turn_ids) as unknown as TurnRow[];
  } else if (args.range) {
    turnRows = db
      .prepare(
        `SELECT id, sequence, started_at, user_input FROM turns
         WHERE session_id = ? AND sequence BETWEEN ? AND ? ORDER BY sequence`,
      )
      .all(session.id, args.range.from, args.range.to) as unknown as TurnRow[];
  } else {
    turnRows = db
      .prepare(
        `SELECT id, sequence, started_at, user_input FROM turns
         WHERE session_id = ? ORDER BY sequence`,
      )
      .all(session.id) as unknown as TurnRow[];
  }

  const messageStmt = db.prepare(
    `SELECT source, content_text, content_thinking FROM messages
     WHERE turn_id = ? AND is_sidechain = 0 ORDER BY sequence`,
  );
  const toolStmt = db.prepare(
    `SELECT tool_name, outcome, input_summary, output_summary, is_error
     FROM tool_executions WHERE turn_id = ? ORDER BY sequence`,
  );

  let charCount = 0;
  let truncated = false;
  const turns: TurnContent[] = [];

  const cut = (text: string, budget: number): string => {
    if (text.length <= budget) return text;
    truncated = true;
    return `${text.slice(0, Math.max(0, budget - 40))}\n… [truncated: ${text.length - budget} more chars]`;
  };

  for (const turn of turnRows) {
    if (truncated) break;

    const messages = messageStmt.all(turn.id) as unknown as Array<{
      source: string;
      content_text: string | null;
      content_thinking: string | null;
    }>;
    const tools = toolStmt.all(turn.id) as unknown as Array<{
      tool_name: string;
      outcome: string | null;
      input_summary: string | null;
      output_summary: string | null;
      is_error: number | null;
    }>;

    const joinParts = (parts: Array<string | null>): string =>
      parts.filter((p): p is string => !!p && p.trim().length > 0).join('\n\n');

    const user =
      turn.user_input?.trim() ||
      joinParts(messages.filter(m => m.source === 'user_input').map(m => m.content_text));
    const assistant = joinParts(
      messages.filter(m => m.source === 'assistant_text').map(m => m.content_text),
    );
    const thinking = joinParts(
      messages.filter(m => m.source === 'assistant_think').map(m => m.content_thinking),
    );
    const toolList: TurnToolExecution[] = tools.map(t => ({
      tool: t.tool_name,
      outcome: t.outcome ?? 'unknown',
      input_summary: t.input_summary,
      output_summary: t.output_summary ? oneLine(t.output_summary, 400) : null,
      is_error: t.is_error === 1,
    }));

    const turnChars =
      user.length +
      assistant.length +
      thinking.length +
      toolList.reduce(
        (sum, t) => sum + t.tool.length + (t.input_summary?.length ?? 0) + (t.output_summary?.length ?? 0),
        0,
      );

    if (turns.length > 0 && charCount + turnChars > maxChars) {
      truncated = true;
      break;
    }

    const budget = maxChars - charCount;
    const content: TurnContent = {
      seq: turn.sequence,
      started_at: iso(turn.started_at),
      user: cut(user, budget),
      assistant: cut(assistant, Math.max(0, budget - user.length)),
      thinking: cut(
        thinking,
        Math.max(0, budget - user.length - assistant.length),
      ),
      tools: toolList,
    };
    charCount += Math.min(turnChars, budget);
    turns.push(content);
  }

  return {
    session_id: session.id,
    requested: turnRows.length,
    returned: turns.length,
    truncated,
    char_count: charCount,
    max_chars: maxChars,
    turns,
  };
}
