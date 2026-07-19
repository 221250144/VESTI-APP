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
  /**
   * 'subagent' when this entry exists (partly) because a subagent session of
   * the displayed session matched. Main sessions fold their subagents' hits
   * in; a subagent is listed on its own only when its parent session is not
   * in the database.
   */
  hitSource?: 'main' | 'subagent';
  /** Parent session the hit is attributed to (== sessionId when attributed). */
  attributedSessionId?: string;
  /** The subagent session that produced the hit, when hitSource='subagent'. */
  subagentSessionId?: string;
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
 *
 * Subagent attribution (A1): a hit on a subagent session is attributed to its
 * parent session (subagent_links) — the parent entry absorbs the subagent's
 * score and snippet and is marked hitSource='subagent' with the child's id.
 * A subagent is listed on its own only when its parent session is missing.
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

  // child session id → parent session id, for hit attribution.
  const parentByChild = new Map<string, string>();
  for (const row of db.prepare(`
    SELECT parent_session_id, child_session_id FROM subagent_links
    WHERE child_session_id IS NOT NULL
  `).all() as Array<{ parent_session_id: string; child_session_id: string }>) {
    if (!parentByChild.has(row.child_session_id)) {
      parentByChild.set(row.child_session_id, row.parent_session_id);
    }
  }

  const metaStmt = db.prepare(`
    SELECT ws.id, ws.title, ws.platform, sd.one_liner
    FROM work_sessions ws
    LEFT JOIN session_digests sd ON sd.session_id = ws.id
    WHERE ws.id = ?
  `);
  type MetaRow = { id: string; title: string; platform: string; one_liner: string | null };
  const metaCache = new Map<string, MetaRow | null>();
  const metaOf = (sessionId: string): MetaRow | null => {
    if (!metaCache.has(sessionId)) {
      metaCache.set(sessionId, (metaStmt.get(sessionId) as MetaRow | undefined) ?? null);
    }
    return metaCache.get(sessionId) ?? null;
  };

  // Fold subagent scores into their parent entry. The display id is the
  // parent when it exists in the database, otherwise the subagent itself.
  interface Attribution {
    displayId: string;
    score: number;
    /** Best-scoring contributor, for snippet selection. */
    bestContributorId: string;
    bestContributorScore: number;
    directHit: boolean;
  }
  const byDisplay = new Map<string, Attribution>();
  for (const [sessionId, score] of scores) {
    const parentId = parentByChild.get(sessionId);
    const isSubagent = parentId !== undefined && metaOf(parentId) !== null;
    const displayId = isSubagent ? parentId : sessionId;
    let entry = byDisplay.get(displayId);
    if (!entry) {
      entry = { displayId, score: 0, bestContributorId: sessionId, bestContributorScore: 0, directHit: false };
      byDisplay.set(displayId, entry);
    }
    entry.score += score;
    if (score > entry.bestContributorScore) {
      entry.bestContributorScore = score;
      entry.bestContributorId = sessionId;
    }
    if (!isSubagent) {
      entry.directHit = true;
    }
  }

  const ranked = [...byDisplay.values()].sort(
    (a, b) => b.score - a.score || (a.displayId < b.displayId ? -1 : a.displayId > b.displayId ? 1 : 0),
  ).slice(0, topK);
  if (ranked.length === 0) return [];

  return ranked.map((entry) => {
    const meta = metaOf(entry.displayId);
    // FTS may hit a thinking/tool column whose content_text is empty; a blank
    // snippet is worse than no snippet — fall back to the digest one-liner,
    // then to the session title. The snippet comes from the best contributor,
    // which may be the subagent whose hit surfaced this parent entry.
    const hit = snippetBySession.get(entry.bestContributorId);
    const snippet = hit && hit.trim()
      ? hit
      : meta?.one_liner?.trim() || meta?.title || '';
    const attributed = !entry.directHit;
    return {
      sessionId: entry.displayId,
      title: meta?.title ?? 'Untitled',
      platform: meta?.platform ?? '',
      score: entry.score,
      snippet,
      oneLiner: meta?.one_liner ?? null,
      hitSource: attributed ? 'subagent' : 'main',
      ...(attributed
        ? { attributedSessionId: entry.displayId, subagentSessionId: entry.bestContributorId }
        : {}),
    };
  });
}
