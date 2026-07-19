/**
 * Session Recall
 * Cross-session recall for the Explore agent: FTS5 over messages_fts and
 * sessions_fts produces ranked session candidates with a hit snippet; when
 * digest embeddings and a query vector are available, a vector ranking is
 * fused in with Reciprocal Rank Fusion (RRF, k=60) — simple and explainable.
 * Pure logic over a better-sqlite3 handle; fully unit-testable on an
 * in-memory database.
 */

import { deserializeVector, searchByVector } from './VectorSearch.js';

type Database = import('better-sqlite3').Database;

const RRF_K = 60;
const DEFAULT_CANDIDATE_LIMIT = 30;

export interface SessionRecallOptions {
  topK?: number;
  /** Query embedding; when absent the vector list is skipped (pure FTS). */
  queryVector?: Float32Array | null;
  /** Per-list FTS candidate cap before fusion. */
  candidateLimit?: number;
}

export interface SessionRecallHit {
  sessionId: string;
  title: string;
  platform: string;
  /** Fused RRF score; higher is better. */
  score: number;
  snippet: string;
  oneLiner: string | null;
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
  rank: number;
}

function rankMessageHits(db: Database, ftsQuery: string, limit: number): MessageHitRow[] {
  try {
    return db.prepare(`
      SELECT m.session_id, m.content_text, rank
      FROM messages_fts fts
      JOIN messages m ON m.rowid = fts.rowid
      WHERE messages_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(ftsQuery, limit) as MessageHitRow[];
  } catch {
    return [];
  }
}

function rankSessionHits(db: Database, ftsQuery: string, limit: number): Array<{ id: string }> {
  try {
    return db.prepare(`
      SELECT ws.id
      FROM sessions_fts fts
      JOIN work_sessions ws ON ws.rowid = fts.rowid
      WHERE sessions_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(ftsQuery, limit) as Array<{ id: string }>;
  } catch {
    return [];
  }
}

function rankVectorHits(db: Database, queryVector: Float32Array, limit: number): Array<{ id: string }> {
  const rows = db.prepare(`
    SELECT session_id, embedding FROM session_digests
    WHERE embedding_status = 'ok' AND embedding IS NOT NULL
  `).all() as Array<{ session_id: string; embedding: Buffer }>;
  const candidates = rows.flatMap(row => {
    try {
      return [{ id: row.session_id, vector: deserializeVector(row.embedding) }];
    } catch {
      return [];
    }
  });
  return searchByVector(queryVector, candidates, limit).map(match => ({ id: match.id }));
}

/**
 * Recall the top-K sessions for a query. FTS hit lists are fused with the
 * (optional) digest-embedding ranking via RRF; sessions are returned with a
 * snippet from their best-ranked message hit.
 */
export function recallSessions(db: Database, query: string, options: SessionRecallOptions = {}): SessionRecallHit[] {
  const topK = options.topK ?? 5;
  if (topK <= 0) return [];
  const candidateLimit = options.candidateLimit ?? DEFAULT_CANDIDATE_LIMIT;
  const tokens = recallTokens(query);
  const ftsQuery = toFtsQuery(query);

  // Ranked session id lists (best first) per signal.
  const lists: string[][] = [];
  const snippetBySession = new Map<string, string>();

  if (ftsQuery) {
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
  }

  if (options.queryVector && options.queryVector.length > 0) {
    lists.push(rankVectorHits(db, options.queryVector, candidateLimit).map(row => row.id));
  }

  if (lists.every(list => list.length === 0)) return [];

  // RRF fusion; ties break by session id for deterministic output.
  const scores = new Map<string, number>();
  for (const list of lists) {
    list.forEach((sessionId, index) => {
      scores.set(sessionId, (scores.get(sessionId) ?? 0) + 1 / (RRF_K + index + 1));
    });
  }
  const ranked = [...scores.entries()].sort(
    (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
  ).slice(0, topK);
  if (ranked.length === 0) return [];

  const metaStmt = db.prepare(`
    SELECT ws.id, ws.title, ws.platform, sd.one_liner
    FROM work_sessions ws
    LEFT JOIN session_digests sd ON sd.session_id = ws.id
    WHERE ws.id = ?
  `);

  return ranked.map(([sessionId, score]) => {
    const meta = metaStmt.get(sessionId) as { id: string; title: string; platform: string; one_liner: string | null } | undefined;
    // FTS may hit a thinking/tool column whose content_text is empty; a blank
    // snippet is worse than no snippet — fall back to the digest one-liner,
    // then to the session title.
    const hit = snippetBySession.get(sessionId);
    const snippet = hit && hit.trim()
      ? hit
      : meta?.one_liner?.trim() || meta?.title || '';
    return {
      sessionId,
      title: meta?.title ?? 'Untitled',
      platform: meta?.platform ?? '',
      score,
      snippet,
      oneLiner: meta?.one_liner ?? null,
    };
  });
}
