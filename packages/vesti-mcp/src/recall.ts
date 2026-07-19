/**
 * Cross-session recall — a port of capture-core's SessionRecall (FTS5 over
 * messages_fts and sessions_fts fused with Reciprocal Rank Fusion, k=60),
 * re-implemented here against `node:sqlite` so the MCP server has zero
 * dependency on the desktop app's better-sqlite3 native binary.
 *
 * The vector signal from SessionRecall is intentionally omitted: digest
 * embeddings require an embedding service that is only available inside the
 * running app. Without a query vector SessionRecall degrades to pure FTS as
 * well, so behavior matches its documented fallback path.
 */

import type { VestiDatabase } from './db.js';

const RRF_K = 60;
const DEFAULT_CANDIDATE_LIMIT = 30;

export interface RecallHit {
  sessionId: string;
  /** Fused RRF score; higher is better. */
  score: number;
  snippet: string;
}

/** Word tokens usable for FTS MATCH and snippet locating. */
export function recallTokens(query: string): string[] {
  return query.match(/[\p{L}\p{N}_]+/gu) ?? [];
}

/** Build a safe FTS5 MATCH expression: each token quoted, OR-combined. */
export function toFtsQuery(query: string): string {
  return recallTokens(query)
    .map(token => `"${token.replace(/"/g, '""')}"`)
    .join(' OR ');
}

/** Snippet centered on the first token hit; falls back to the text head. */
export function buildSnippet(text: string, tokens: string[], radius = 80): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (!cleaned) return '';
  const lower = cleaned.toLowerCase();
  let at = -1;
  for (const token of tokens) {
    const index = lower.indexOf(token.toLowerCase());
    if (index !== -1 && (at === -1 || index < at)) at = index;
  }
  if (at === -1) return cleaned.slice(0, radius * 2);
  const start = Math.max(0, at - radius);
  const end = Math.min(cleaned.length, at + radius);
  return `${start > 0 ? '…' : ''}${cleaned.slice(start, end)}${end < cleaned.length ? '…' : ''}`;
}

interface MessageHitRow {
  session_id: string;
  content_text: string | null;
}

function rankMessageHits(db: VestiDatabase, ftsQuery: string, limit: number): MessageHitRow[] {
  try {
    return db
      .prepare(
        `SELECT m.session_id, m.content_text
         FROM messages_fts fts
         JOIN messages m ON m.rowid = fts.rowid
         WHERE messages_fts MATCH ?
         ORDER BY rank
         LIMIT ?`,
      )
      .all(ftsQuery, limit) as unknown as MessageHitRow[];
  } catch {
    return [];
  }
}

function rankSessionHits(db: VestiDatabase, ftsQuery: string, limit: number): Array<{ id: string }> {
  try {
    return db
      .prepare(
        `SELECT ws.id
         FROM sessions_fts fts
         JOIN work_sessions ws ON ws.rowid = fts.rowid
         WHERE sessions_fts MATCH ?
         ORDER BY rank
         LIMIT ?`,
      )
      .all(ftsQuery, limit) as unknown as Array<{ id: string }>;
  } catch {
    return [];
  }
}

/**
 * Recall the top-K sessions for a query (pure FTS, RRF-fused across the
 * message and session-title indexes). Returns session ids with a snippet
 * from their best-ranked message hit.
 */
export function recallSessions(
  db: VestiDatabase,
  query: string,
  options: { topK?: number; candidateLimit?: number } = {},
): RecallHit[] {
  const topK = options.topK ?? 8;
  if (topK <= 0) return [];
  const candidateLimit = options.candidateLimit ?? DEFAULT_CANDIDATE_LIMIT;
  const tokens = recallTokens(query);
  const ftsQuery = toFtsQuery(query);
  if (!ftsQuery) return [];

  const lists: string[][] = [];
  const snippetBySession = new Map<string, string>();

  const messageSessionIds: string[] = [];
  for (const row of rankMessageHits(db, ftsQuery, candidateLimit * 4)) {
    if (!snippetBySession.has(row.session_id)) {
      snippetBySession.set(row.session_id, buildSnippet(row.content_text ?? '', tokens));
    }
    if (!messageSessionIds.includes(row.session_id)) {
      messageSessionIds.push(row.session_id);
    }
  }
  lists.push(messageSessionIds.slice(0, candidateLimit));
  lists.push(rankSessionHits(db, ftsQuery, candidateLimit).map(row => row.id));

  if (lists.every(list => list.length === 0)) return [];

  // RRF fusion; ties break by session id for deterministic output.
  const scores = new Map<string, number>();
  for (const list of lists) {
    list.forEach((sessionId, index) => {
      scores.set(sessionId, (scores.get(sessionId) ?? 0) + 1 / (RRF_K + index + 1));
    });
  }
  const ranked = [...scores.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, topK);

  return ranked.map(([sessionId, score]) => ({
    sessionId,
    score,
    snippet: snippetBySession.get(sessionId) ?? '',
  }));
}
