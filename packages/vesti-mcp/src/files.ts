/**
 * vesti_search_files — the file-level index layer.
 *
 * Answers "which local files does past work about X live in?" so an agent
 * asked to "fill / update this document from memory" can go straight to the
 * right paths and read them with its own filesystem tools. Two evidence
 * channels, both deterministic:
 *
 *   A. session-content: sessions recalled by the keyword (same FTS pipeline
 *      as vesti_search) contribute their digest key_files plus every file
 *      path extracted from their tool_executions input summaries.
 *   B. name: the keyword appears in the file path itself (digest key_files
 *      and tool-input paths scanned with LIKE, then filtered to paths that
 *      actually contain the keyword).
 *
 * Pure SQL + string logic, read-only, unit-testable against a fixture db.
 */

import type { VestiDatabase } from './db.js';
import { recallSessions } from './recall.js';

// ---- path extraction (mirrors capture-core projectState.extractFilePaths) ----

const PATH_JSON_KEYS = new Set([
  'path',
  'file',
  'filepath',
  'file_path',
  'filename',
  'target_file',
  'notebook_path',
  'abs_path',
  'absolute_path',
]);

function looksLikeFilePath(candidate: string): boolean {
  // Real files carry a directory separator AND a final extension segment;
  // this rejects code-fragment junk like `t.text` / `EXPERTS.map`.
  if (candidate.length < 3 || !candidate.includes('/')) return false;
  const base = candidate.slice(candidate.lastIndexOf('/') + 1);
  if (!/^[\p{L}\p{N}_.@+-]+\.[\p{L}\p{N}]{1,10}$/u.test(base)) return false;
  if (/^\d+\.\d+/.test(base)) return false; // version strings
  if (/^https?:/i.test(candidate)) return false;
  return true;
}

/** Pull plausible file paths out of a tool input summary. Deterministic. */
export function extractFilePaths(text: string): string[] {
  if (!text) return [];
  // Strip URLs first — the path regex would otherwise promote the tail of
  // 'https://example.com/a.png' into a "/example.com/a.png" candidate.
  const cleanedText = text.replace(/https?:\/\/\S+/gi, ' ');
  const out = new Set<string>();
  const add = (value: string) => {
    const candidate = value.replace(/\\/g, '/').replace(/[.,;:)\]]+$/, '');
    if (looksLikeFilePath(candidate)) out.add(candidate);
  };
  const pattern =
    /(?:[A-Za-z]:[\\/]|~?[\\/]|\.{1,2}[\\/])?(?:[\p{L}\p{N}_.@+-]+[\\/])+[\p{L}\p{N}_.@+-]+\.[\p{L}\p{N}]{1,10}/gu;
  if (cleanedText.trimStart().startsWith('{')) {
    try {
      const parsed = JSON.parse(cleanedText) as Record<string, unknown>;
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value !== 'string') continue;
        if (PATH_JSON_KEYS.has(key.toLowerCase())) {
          add(value);
        } else if (key.toLowerCase() === 'command') {
          for (const match of value.matchAll(pattern)) add(match[0]);
        }
      }
      return [...out];
    } catch {
      /* not valid JSON — fall through to the regex */
    }
  }
  for (const match of cleanedText.matchAll(pattern)) add(match[0]);
  return [...out];
}

// ---- aggregation ----

export interface FileHit {
  path: string;
  /** Project roots (work_sessions.project_path) the touches belong to. */
  projects: string[];
  touches: number;
  last_touched: string | null;
  /** Up to 5 sessions behind the touches, most recent first. */
  sessions: Array<{ session_id: string; title: string }>;
  /** How the file was matched: by its name, or by the content of sessions that touched it. */
  matched_via: Array<'name' | 'session-content'>;
  score: number;
}

interface Accumulator {
  path: string;
  projects: Set<string>;
  sessions: Map<string, { title: string; lastMs: number }>;
  touches: number;
  lastMs: number;
  via: Set<'name' | 'session-content'>;
  recallScore: number;
}

function iso(ms: number | null | undefined): string | null {
  return ms == null ? null : new Date(ms).toISOString();
}

function parseKeyFiles(text: string | null | undefined): string[] {
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed.filter(item => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Find local files related to a topic. Read-only; never throws on a missing
 * column (older schemas degrade to fewer evidence channels).
 */
export function vestiSearchFiles(
  db: VestiDatabase,
  args: { query: string; topK?: number },
): { query: string; count: number; results: FileHit[] } {
  const query = (args.query ?? '').trim();
  if (!query) throw new Error('query is required');
  const topK = Math.max(1, Math.min(args.topK ?? 10, 25));

  const files = new Map<string, Accumulator>();
  const acc = (rawPath: string): Accumulator => {
    const normalized = rawPath.replace(/\\/g, '/');
    let entry = files.get(normalized);
    if (!entry) {
      entry = {
        path: normalized,
        projects: new Set(),
        sessions: new Map(),
        touches: 0,
        lastMs: 0,
        via: new Set(),
        recallScore: 0,
      };
      files.set(normalized, entry);
    }
    return entry;
  };
  const note = (
    rawPath: string,
    via: 'name' | 'session-content',
    meta: { sessionId?: string; title?: string; projectPath?: string; timeMs?: number; recallScore?: number },
  ) => {
    const entry = acc(rawPath);
    entry.via.add(via);
    entry.touches += 1;
    if (meta.projectPath) entry.projects.add(meta.projectPath);
    if (meta.timeMs && meta.timeMs > entry.lastMs) entry.lastMs = meta.timeMs;
    if (meta.sessionId) {
      const prev = entry.sessions.get(meta.sessionId);
      const at = meta.timeMs ?? 0;
      if (!prev || at > prev.lastMs) {
        entry.sessions.set(meta.sessionId, { title: meta.title ?? '', lastMs: at });
      }
    }
    if (meta.recallScore) entry.recallScore = Math.max(entry.recallScore, meta.recallScore);
  };

  // Channel A: sessions recalled by content → their key_files + tool paths.
  const hits = recallSessions(db, query, { topK: 12 });
  const sessionMeta = db.prepare(
    `SELECT id, title, project_path, started_at FROM work_sessions WHERE id = ?`,
  );
  const digestFiles = db.prepare(
    `SELECT key_files FROM session_digests WHERE session_id = ?`,
  );
  const toolPaths = db.prepare(
    `SELECT input_summary, timestamp FROM tool_executions WHERE session_id = ?`,
  );
  for (const hit of hits) {
    const session = sessionMeta.get(hit.sessionId) as unknown as
      | { id: string; title: string; project_path: string; started_at: number }
      | undefined;
    if (!session) continue;
    const meta = {
      sessionId: session.id,
      title: session.title,
      projectPath: session.project_path,
      recallScore: hit.score,
    };
    let keyFiles: string[] = [];
    try {
      const row = digestFiles.get(session.id) as unknown as { key_files: string | null } | undefined;
      keyFiles = parseKeyFiles(row?.key_files);
    } catch {
      /* pre-v3 schema without key_files — tool extraction still applies */
    }
    for (const file of keyFiles) note(file, 'session-content', { ...meta, timeMs: session.started_at });
    try {
      const rows = toolPaths.all(session.id) as unknown as Array<{
        input_summary: string | null;
        timestamp: number | null;
      }>;
      for (const row of rows) {
        for (const file of extractFilePaths(row.input_summary ?? '')) {
          note(file, 'session-content', { ...meta, timeMs: row.timestamp ?? session.started_at });
        }
      }
    } catch {
      /* very old schema without tool_executions — digest channel stands */
    }
  }

  // Channel B: a query token inside the file path itself. Multi-word queries
  // match per token (a BP file is named "…BP…", not "请通过记忆 BP").
  const tokens = [...new Set(
    query
      .split(/[\s,，、/\\:：*?"'<>|]+/)
      .map(token => token.replace(/[%_]/g, '').trim())
      .filter(token => token.length >= 2),
  )].slice(0, 4);
  const hitToken = (file: string): boolean => {
    const path = file.toLowerCase();
    return tokens.some(token => path.includes(token.toLowerCase()));
  };
  try {
    const rows = db
      .prepare(
        `SELECT te.input_summary, te.timestamp, ws.id AS session_id, ws.title, ws.project_path
         FROM tool_executions te JOIN work_sessions ws ON ws.id = te.session_id
         WHERE ${tokens.map(() => 'te.input_summary LIKE ?').join(' OR ') || '0'}`,
      )
      .all(...tokens.map(token => `%${token}%`)) as unknown as Array<{
        input_summary: string | null;
        timestamp: number | null;
        session_id: string;
        title: string;
        project_path: string;
      }>;
    for (const row of rows) {
      for (const file of extractFilePaths(row.input_summary ?? '')) {
        if (!hitToken(file)) continue;
        note(file, 'name', {
          sessionId: row.session_id,
          title: row.title,
          projectPath: row.project_path,
          timeMs: row.timestamp ?? undefined,
        });
      }
    }
  } catch {
    /* schema without tool_executions */
  }
  try {
    const rows = db
      .prepare(
        `SELECT sd.session_id, sd.key_files, ws.title, ws.project_path, ws.started_at
         FROM session_digests sd JOIN work_sessions ws ON ws.id = sd.session_id
         WHERE ${tokens.map(() => 'sd.key_files LIKE ?').join(' OR ') || '0'}`,
      )
      .all(...tokens.map(token => `%${token}%`)) as unknown as Array<{
        session_id: string;
        key_files: string | null;
        title: string;
        project_path: string;
        started_at: number;
      }>;
    for (const row of rows) {
      for (const file of parseKeyFiles(row.key_files)) {
        if (!hitToken(file)) continue;
        note(file, 'name', {
          sessionId: row.session_id,
          title: row.title,
          projectPath: row.project_path,
          timeMs: row.started_at,
        });
      }
    }
  } catch {
    /* schema without key_files */
  }

  const results: FileHit[] = [...files.values()]
    .map(entry => {
      // Name matches are the strongest signal ("the file IS about the topic");
      // session-content evidence scales with the best recall score behind it.
      const score =
        (entry.via.has('name') ? 3 : 0) +
        entry.recallScore * 2 +
        Math.min(entry.sessions.size, 3) * 0.5;
      const sessions = [...entry.sessions.entries()]
        .sort((a, b) => b[1].lastMs - a[1].lastMs)
        .slice(0, 5)
        .map(([session_id, s]) => ({ session_id, title: s.title }));
      return {
        path: entry.path,
        projects: [...entry.projects],
        touches: entry.touches,
        last_touched: iso(entry.lastMs || null),
        sessions,
        matched_via: [...entry.via],
        score: Number(score.toFixed(6)),
      };
    })
    .sort((a, b) => b.score - a.score || b.touches - a.touches)
    .slice(0, topK);

  return { query, count: results.length, results };
}
