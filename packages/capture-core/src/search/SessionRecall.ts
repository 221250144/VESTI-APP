/**
 * Session Recall
 * Cross-session recall for the Explore agent: FTS5 over messages_fts and
 * sessions_fts produces ranked session candidates with a hit snippet; when
 * digest embeddings and a query vector are available, a vector ranking is
 * fused in with Reciprocal Rank Fusion (RRF, k=60) — simple and explainable.
 * After fusion the score is scaled by an exponential recency decay
 * (τ = RECENCY_TAU_DAYS, floor 0.5) so updated facts outrank their stale
 * predecessors, and each hit carries a coverage-based confidence flag the
 * caller can use to abstain on decoy/scope-mismatched hits.
 * Pure logic over a better-sqlite3 handle; fully unit-testable on an
 * in-memory database.
 */

import { deserializeVector, searchByVector } from './VectorSearch.js';
import { messageDedupKey } from '../tree/forks.js';

type Database = import('better-sqlite3').Database;

const RRF_K = 60;
const DEFAULT_CANDIDATE_LIMIT = 30;

/** Recency decay time constant: fused score × (FLOOR + (1−FLOOR)·exp(−ageDays/τ)). */
export const RECENCY_TAU_DAYS = 90;
/**
 * Recency decay floor. Deliberately shallow: RRF k=60 compresses top ranks
 * to within ~2% of each other, so a deep floor lets a few days of age
 * outrank clearly better lexical matches (bench A regression evidence in
 * docs/bench/after-trigram-2026-07-19.md). A 0.9 floor bounds the recency
 * swing to ≤10% — enough to order same-fact update pairs, not enough to
 * bury a strong old hit under fresh noise.
 */
export const RECENCY_FLOOR = 0.9;
/**
 * The trigram tokenizer indexes 3-character sliding windows, so query tokens
 * shorter than 3 characters (e.g. "的", "CI", "v2") can never match — they
 * are inert in MATCH and must not count toward confidence coverage either.
 */
export const TRIGRAM_MIN_TOKEN_CHARS = 3;
/**
 * Merged short-token spans (see buildQueryPlan) count as coverage evidence
 * only when the short-token part has at least this many characters: a
 * single-character token is almost always a function word ("的"), and its
 * merge ("的 ma") is weak evidence that would inflate decoy coverage.
 * Two-character shorts ("CI", "M3") are content — their spans count.
 */
export const COVERAGE_MERGE_MIN_SHORT_CHARS = 2;
/**
 * Confidence calibration (bench A, docs/bench/after-trigram-2026-07-19.md):
 * a hit is 'low' when fewer than this fraction of the matchable query tokens
 * literally appear in its best matching message. RRF scores are flat by
 * design (k=60 compresses everything near 1/61) and cannot tell a decoy from
 * a real hit; token coverage is the usable signal.
 */
export const CONFIDENCE_COVERAGE_FLOOR = 0.5;

export type RecallConfidence = 'high' | 'low';

/**
 * Recency multiplier in (RECENCY_FLOOR, 1]: 1.0 for activity right now,
 * decaying exponentially toward the floor for very old sessions. Pure
 * function so tests can pin the math; recallSessions applies it after RRF
 * fusion.
 */
export function recencyFactor(lastActivityAt: number, now: number, tauDays: number = RECENCY_TAU_DAYS): number {
  const ageDays = Math.max(0, (now - lastActivityAt) / 86_400_000);
  return RECENCY_FLOOR + (1 - RECENCY_FLOOR) * Math.exp(-ageDays / tauDays);
}

/**
 * Detect the tokenizer of messages_fts ('trigram' after migration 5, the
 * unicode61 default otherwise). One cheap sqlite_master lookup per recall;
 * read-only consumers (vesti-mcp) use it to stay compatible with old DBs.
 */
export function detectFtsTokenizer(db: Database): string {
  try {
    const row = db.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'messages_fts'",
    ).get() as { sql?: string } | undefined;
    return row?.sql?.toLowerCase().includes('trigram') ? 'trigram' : 'unicode61';
  } catch {
    return 'unicode61';
  }
}

/**
 * Query tokens that can match on their own under the given tokenizer. With
 * trigram, tokens shorter than TRIGRAM_MIN_TOKEN_CHARS are dropped (counting
 * Unicode code points, not UTF-16 units); unicode61 can match any token.
 */
export function effectiveTokens(query: string, tokenizer: string): string[] {
  const tokens = recallTokens(query);
  if (tokenizer !== 'trigram') return tokens;
  return tokens.filter(token => [...token].length >= TRIGRAM_MIN_TOKEN_CHARS);
}

const charLen = (s: string): number => [...s].length;
const SHORT_FALLBACK_STOP_WORDS = new Set([
  'a', 'an', 'as', 'at', 'be', 'by', 'if', 'in', 'is', 'it', 'of', 'on',
  'or', 'to', '项目', '文件', '目录', '位置', '代码', '哪里', '哪个',
  '哪些', '什么', '怎么', '如何', '是否', '请问', '帮我', '一个',
  '相关', '内容', '信息', '记录', '对话', '会话', '历史', '最近',
  '目前', '现在', '最终', '找到', '查找', '定位', '查看', '看看',
]);
const CJK_WORD = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+$/u;
const MAX_SHORT_FALLBACK_TOKENS = 8;

interface SegmentLike {
  segment: string;
  isWordLike?: boolean;
}

/** Split a natural unspaced CJK run into conservative semantic words. */
function cjkSemanticUnits(token: string): string[] {
  if (!CJK_WORD.test(token) || charLen(token) < TRIGRAM_MIN_TOKEN_CHARS) return [token];
  try {
    const segments = [...new Intl.Segmenter('zh', { granularity: 'word' }).segment(token)] as SegmentLike[];
    const meaningful = segments
      .filter(segment => segment.isWordLike !== false)
      .map(segment => segment.segment.toLowerCase())
      .filter(segment => charLen(segment) >= 2)
      .filter(segment => !SHORT_FALLBACK_STOP_WORDS.has(segment));

    // ICU can split domain terms such as "重试" and "轮询" into separate
    // one-character words. Trigram FTS cannot search those characters, so
    // reconstruct adjacent bigrams inside each uninterrupted single-word run.
    const reconstructedBigrams: string[] = [];
    let singleRun: string[] = [];
    const flushSingleRun = (): void => {
      for (let i = 0; i + 1 < singleRun.length; i += 1) {
        const bigram = `${singleRun[i]}${singleRun[i + 1]}`.toLowerCase();
        if (!SHORT_FALLBACK_STOP_WORDS.has(bigram)) reconstructedBigrams.push(bigram);
      }
      singleRun = [];
    };
    for (const segment of segments) {
      const value = segment.segment.toLowerCase();
      if (segment.isWordLike !== false && CJK_WORD.test(value) && charLen(value) === 1) {
        singleRun.push(value);
      } else {
        flushSingleRun();
      }
    }
    flushSingleRun();

    const units = [...new Set([...meaningful, ...reconstructedBigrams])];
    return units.length > 0 ? units : [token];
  } catch {
    return [token];
  }
}

export interface QueryPlan {
  /**
   * FTS5 MATCH expression (quoted OR branches). Under trigram this contains
   * only independently matchable tokens (three or more Unicode code points).
   */
  ftsQuery: string;
  /**
   * Units that can literally appear in the matched text. Confidence coverage
   * includes independently queried two-character LIKE fallback terms.
   */
  matchUnits: string[];
  /** Meaningful two-character terms queried independently through LIKE. */
  shortFallbackTokens: string[];
}

/** Tokenizer-aware query construction; the unicode61 path is unchanged. */
export function buildQueryPlan(query: string, tokenizer: string): QueryPlan {
  const tokens = recallTokens(query);
  const quote = (s: string) => `"${s.replace(/"/g, '""')}"`;
  if (tokenizer !== 'trigram') {
    return {
      ftsQuery: tokens.map(quote).join(' OR '),
      matchUnits: tokens,
      shortFallbackTokens: [],
    };
  }
  const plannedUnits = tokens.flatMap(cjkSemanticUnits);
  // Preserve the original long phrase for exact trigram matches while adding
  // word-level branches for natural CJK queries without artificial spaces.
  const longTokens = [...new Set([...tokens, ...plannedUnits]
    .map(token => token.toLowerCase())
    .filter(token => charLen(token) >= TRIGRAM_MIN_TOKEN_CHARS))];
  const shortFallbackTokens = [...new Set(plannedUnits
    .map(token => token.toLowerCase())
    .filter(token => charLen(token) === 2 && !SHORT_FALLBACK_STOP_WORDS.has(token)))]
    .slice(0, MAX_SHORT_FALLBACK_TOKENS);
  return {
    ftsQuery: longTokens.map(quote).join(' OR '),
    matchUnits: [...longTokens, ...shortFallbackTokens],
    shortFallbackTokens,
  };
}

/**
 * Confidence from token coverage: 'low' when the query has no matchable
 * tokens at all, or when the hit's best message covers less than the
 * calibrated floor of them (title-only/vector hits have coverage 0).
 */
export function confidenceForCoverage(coverage: number, effectiveTokenCount: number): RecallConfidence {
  if (effectiveTokenCount === 0) return 'low';
  return coverage >= CONFIDENCE_COVERAGE_FLOOR ? 'high' : 'low';
}

export interface SessionRecallOptions {
  topK?: number;
  /** Query embedding; when absent the vector list is skipped (pure FTS). */
  queryVector?: Float32Array | null;
  /** Exact provider/model/dimension index identity for queryVector. */
  queryEmbeddingVersion?: string | null;
  /** Per-list FTS candidate cap before fusion. */
  candidateLimit?: number;
  /** Reference time (ms epoch) for recency decay; tests inject a fixed now. */
  now?: number;
}

export interface SessionRecallHit {
  sessionId: string;
  title: string;
  platform: string;
  /** Fused RRF score scaled by recency decay; higher is better. */
  score: number;
  snippet: string;
  oneLiner: string | null;
  /**
   * Abstention signal for the caller: 'low' when the hit is weakly supported
   * (no matchable query tokens, or the best message covers less than
   * CONFIDENCE_COVERAGE_FLOOR of them). Decoy/scope-mismatched hits cluster
   * there; a 'low' top-1 means the answer is probably not in the archive.
   */
  confidence: RecallConfidence;
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
  message_id: string;
  session_id: string;
  raw_session_id: string;
  platform: string;
  content_text: string | null;
  rank: number;
}

function rankMessageHits(db: Database, ftsQuery: string, limit: number): MessageHitRow[] {
  try {
    return db.prepare(`
      WITH ranked_messages AS (
        SELECT m.id AS message_id, m.session_id, m.content_text,
               ws.session_id AS raw_session_id, ws.platform,
               m.timestamp, fts.rank AS rank,
               CASE WHEN ws.forked_from IS NULL THEN 0 ELSE 1 END AS fork_rank,
               ws.started_at AS session_started_at,
               ROW_NUMBER() OVER (
                 PARTITION BY m.session_id
                 ORDER BY fts.rank ASC, m.timestamp DESC, m.rowid DESC
               ) AS session_row
        FROM messages_fts fts
        JOIN messages m ON m.rowid = fts.rowid
        JOIN work_sessions ws ON ws.id = m.session_id
        WHERE messages_fts MATCH ?
      )
      SELECT message_id, session_id, content_text, rank, raw_session_id, platform
      FROM ranked_messages
      WHERE session_row = 1
      ORDER BY rank ASC, fork_rank ASC, session_started_at ASC, timestamp DESC, session_id
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

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, match => `\\${match}`);
}

function rankMessageLikeHits(db: Database, token: string, limit: number): MessageHitRow[] {
  try {
    return db.prepare(`
      WITH ranked_messages AS (
        SELECT m.id AS message_id, m.session_id, m.content_text,
               ws.session_id AS raw_session_id, ws.platform,
               m.timestamp, 0 AS rank,
               CASE WHEN ws.forked_from IS NULL THEN 0 ELSE 1 END AS fork_rank,
               ws.started_at AS session_started_at,
               ROW_NUMBER() OVER (
                 PARTITION BY m.session_id
                 ORDER BY m.timestamp DESC, m.rowid DESC
               ) AS session_row
        FROM messages m
        JOIN work_sessions ws ON ws.id = m.session_id
        WHERE m.content_text LIKE ? ESCAPE '\\'
      )
      SELECT message_id, session_id, content_text, rank, raw_session_id, platform
      FROM ranked_messages
      WHERE session_row = 1
      ORDER BY fork_rank ASC, session_started_at ASC, timestamp DESC, session_id
      LIMIT ?
    `).all(`%${escapeLike(token)}%`, limit) as MessageHitRow[];
  } catch {
    return [];
  }
}

function rankSessionLikeHits(db: Database, token: string, limit: number): Array<{ id: string }> {
  try {
    const pattern = `%${escapeLike(token)}%`;
    return db.prepare(`
      SELECT ws.id
      FROM work_sessions ws
      WHERE ws.title LIKE ? ESCAPE '\\'
         OR COALESCE(ws.summary, '') LIKE ? ESCAPE '\\'
      ORDER BY ws.last_activity_at DESC, ws.id
      LIMIT ?
    `).all(pattern, pattern, limit) as Array<{ id: string }>;
  } catch {
    return [];
  }
}

function rankVectorHits(
  db: Database,
  queryVector: Float32Array,
  limit: number,
  embeddingVersion?: string | null,
): Array<{ id: string }> {
  const rows = embeddingVersion
    ? db.prepare(`
        SELECT session_id, embedding FROM session_digest_embeddings
        WHERE index_version = ? AND dimensions = ?
      `).all(embeddingVersion, queryVector.length) as Array<{ session_id: string; embedding: Buffer }>
    : db.prepare(`
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
  // Tokenizer-aware query plan: which FTS branches to run and which units
  // can literally appear in matched text (confidence coverage basis).
  const tokenizer = detectFtsTokenizer(db);
  const { ftsQuery, matchUnits, shortFallbackTokens } = buildQueryPlan(query, tokenizer);
  const coverageBySession = new Map<string, number>();

  // Ranked session id lists (best first) per signal.
  const lists: string[][] = [];
  const snippetBySession = new Map<string, string>();
  const loweredUnits = matchUnits.map(unit => unit.toLowerCase());
  const collectMessageSessionIds = (rows: MessageHitRow[]): string[] => {
    const sessionIds: string[] = [];
    // Fork dedup (memory v2): a forked rollout copies the parent's history,
    // so the same message can hit once per fork-chain member. Deduplicate
    // within each signal, while allowing distinct short-token signals to
    // contribute independently to RRF.
    const seenMessageKeys = new Set<string>();
    for (const row of rows) {
      const dedupKey = messageDedupKey(row.platform, row.raw_session_id, row.message_id);
      if (seenMessageKeys.has(dedupKey)) continue;
      seenMessageKeys.add(dedupKey);
      if (!snippetBySession.has(row.session_id)) {
        snippetBySession.set(row.session_id, buildSnippet(row.content_text ?? '', tokens));
      }
      if (loweredUnits.length > 0 && row.content_text) {
        const text = row.content_text.toLowerCase();
        const covered = loweredUnits.reduce((n, unit) => n + (text.includes(unit) ? 1 : 0), 0);
        const ratio = covered / loweredUnits.length;
        if (ratio > (coverageBySession.get(row.session_id) ?? 0)) {
          coverageBySession.set(row.session_id, ratio);
        }
      }
      if (!sessionIds.includes(row.session_id)) sessionIds.push(row.session_id);
    }
    return sessionIds.slice(0, candidateLimit);
  };

  if (ftsQuery) {
    lists.push(collectMessageSessionIds(rankMessageHits(db, ftsQuery, candidateLimit)));
    lists.push(rankSessionHits(db, ftsQuery, candidateLimit).map(row => row.id));
  }

  for (const token of shortFallbackTokens) {
    lists.push(collectMessageSessionIds(rankMessageLikeHits(db, token, candidateLimit)));
    lists.push(rankSessionLikeHits(db, token, candidateLimit).map(row => row.id));
  }

  if (options.queryVector && options.queryVector.length > 0) {
    lists.push(
      rankVectorHits(
        db,
        options.queryVector,
        candidateLimit,
        options.queryEmbeddingVersion,
      ).map(row => row.id),
    );
  }

  if (lists.every(list => list.length === 0)) return [];

  // RRF fusion; ties break by session id for deterministic output.
  const scores = new Map<string, number>();
  for (const list of lists) {
    list.forEach((sessionId, index) => {
      scores.set(sessionId, (scores.get(sessionId) ?? 0) + 1 / (RRF_K + index + 1));
    });
  }
  // Reward evidence that covers more independent query units. The bounded
  // factor keeps vector-only and title-only candidates available, while a
  // session matching both two-character terms outranks one-term distractors.
  if (matchUnits.length > 1) {
    for (const [sessionId, score] of scores) {
      const coverage = coverageBySession.get(sessionId) ?? 0;
      scores.set(sessionId, score * (0.45 + 0.55 * coverage));
    }
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
    SELECT ws.id, ws.title, ws.platform, ws.last_activity_at, sd.one_liner
    FROM work_sessions ws
    LEFT JOIN session_digests sd ON sd.session_id = ws.id
    WHERE ws.id = ?
  `);
  type MetaRow = { id: string; title: string; platform: string; last_activity_at: number; one_liner: string | null };
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

  // Recency re-rank: fold the fused RRF score with a bounded exponential age
  // decay (floor RECENCY_FLOOR) so that near-equal matches — the update-pair
  // case — order newest first, while a clearly better lexical match keeps
  // its lead regardless of age.
  const now = options.now ?? Date.now();
  for (const entry of byDisplay.values()) {
    entry.score *= recencyFactor(metaOf(entry.displayId)?.last_activity_at ?? 0, now);
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
    const coverage = coverageBySession.get(entry.bestContributorId) ?? 0;
    return {
      sessionId: entry.displayId,
      title: meta?.title ?? 'Untitled',
      platform: meta?.platform ?? '',
      score: entry.score,
      snippet,
      oneLiner: meta?.one_liner ?? null,
      confidence: confidenceForCoverage(coverage, matchUnits.length),
      hitSource: attributed ? 'subagent' : 'main',
      ...(attributed
        ? { attributedSessionId: entry.displayId, subagentSessionId: entry.bestContributorId }
        : {}),
    };
  });
}
