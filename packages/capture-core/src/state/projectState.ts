/**
 * L0 project_state generator (memory v2).
 *
 * One deterministic "current state card" per project — pure SQL + JS, no LLM.
 * The card is rewritten wholesale on every rebuild: it never expires and the
 * compression pipeline never touches it.
 *
 *   one_liner      newest session digest one-liner
 *   active_files   top-10 files from the last 30 days of tool_executions,
 *                  ranked by touch count then recency (ties: path asc)
 *   open_questions merged + deduped from the 5 newest digests (cap 8)
 *   session_count / last_active   plain aggregates
 */

import { deriveProjectKey } from '../storage/projectRegistry.js';
import type { ProjectActiveFile, ProjectState } from '../types/unified.js';

type Database = import('better-sqlite3').Database;

export const ACTIVE_FILES_WINDOW_DAYS = 30;
export const ACTIVE_FILES_LIMIT = 10;
export const OPEN_QUESTIONS_DIGEST_LIMIT = 5;
export const OPEN_QUESTIONS_LIMIT = 8;

function parseJsonArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Pull plausible file paths out of a tool input summary. Deterministic:
 * matches absolute-ish and relative paths carrying an extension. Paths are
 * normalized to forward slashes; surrounding quotes/punctuation are trimmed.
 */
export function extractFilePaths(text: string): string[] {
  if (!text) return [];
  const out = new Set<string>();
  const pattern = /(?:[A-Za-z]:[\\/]|~?[\\/]|\.{1,2}[\\/])?(?:[\p{L}\p{N}_.@+-]+[\\/])*[\p{L}\p{N}_.@+-]+\.[\p{L}\p{N}]{1,10}/gu;
  for (const match of text.matchAll(pattern)) {
    let candidate = match[0].replace(/\\/g, '/');
    // Skip bare words like "v1.2" or "file.ts" fragments shorter than a name.
    if (candidate.length < 3) continue;
    // Trim trailing punctuation the regex may have absorbed.
    candidate = candidate.replace(/[.,;:)\]]+$/, '');
    // Ignore obvious non-files (urls, version strings).
    if (/^\d+\.\d+/.test(candidate)) continue;
    out.add(candidate);
  }
  return [...out];
}

interface SessionRow {
  id: string;
  platform: string;
  host: string | null;
  project_path: string;
  git_remote: string | null;
  last_activity_at: number;
}

/** work_sessions ids belonging to a derived project key. */
function sessionRowsForProject(db: Database, projectKey: string): SessionRow[] {
  const rows = db.prepare(`
    SELECT id, platform, host, project_path, git_remote, last_activity_at
    FROM work_sessions
    WHERE session_type = 'conversation'
  `).all() as SessionRow[];
  return rows.filter(row => deriveProjectKey({
    platform: row.platform,
    host: row.host || 'native',
    projectPath: row.project_path,
    gitRemote: row.git_remote ?? undefined,
  }) === projectKey);
}

interface ActiveFileAccumulator {
  touches: number;
  lastTouchedMs: number;
}

/**
 * Rank files touched by the project's tool executions inside the lookback
 * window. Deterministic ordering: touches desc, last-touched desc, path asc.
 */
export function rankActiveFiles(
  touches: Array<{ timestampMs: number; paths: string[] }>,
  limit = ACTIVE_FILES_LIMIT,
): ProjectActiveFile[] {
  const byPath = new Map<string, ActiveFileAccumulator>();
  for (const touch of touches) {
    for (const path of touch.paths) {
      const entry = byPath.get(path) ?? { touches: 0, lastTouchedMs: 0 };
      entry.touches += 1;
      if (touch.timestampMs > entry.lastTouchedMs) entry.lastTouchedMs = touch.timestampMs;
      byPath.set(path, entry);
    }
  }
  return [...byPath.entries()]
    .sort((a, b) =>
      b[1].touches - a[1].touches
      || b[1].lastTouchedMs - a[1].lastTouchedMs
      || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, limit)
    .map(([path, entry]) => ({
      path,
      touches: entry.touches,
      lastTouched: new Date(entry.lastTouchedMs).toISOString(),
    }));
}

/** Merge open_questions from newest-first digests: deduped, first-seen order. */
export function mergeOpenQuestions(digests: Array<{ openQuestions: string[] }>, limit = OPEN_QUESTIONS_LIMIT): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const digest of digests) {
    for (const question of digest.openQuestions) {
      const cleaned = question.trim();
      if (!cleaned || seen.has(cleaned)) continue;
      seen.add(cleaned);
      out.push(cleaned);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/** Rebuild the L0 card for one project. Pure read; the caller persists. */
export function buildProjectState(db: Database, projectKey: string, now: Date = new Date()): ProjectState {
  const sessions = sessionRowsForProject(db, projectKey);
  const sessionIds = sessions.map(row => row.id);

  const digests = sessionIds.length === 0 ? [] : (db.prepare(`
    SELECT one_liner, open_questions, updated_at
    FROM session_digests
    WHERE session_id IN (${sessionIds.map(() => '?').join(',')})
    ORDER BY updated_at DESC
  `).all(...sessionIds) as Array<{ one_liner: string | null; open_questions: string | null; updated_at: string | null }>);

  const sinceMs = now.getTime() - ACTIVE_FILES_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const touchRows = sessionIds.length === 0 ? [] : (db.prepare(`
    SELECT input_summary, timestamp
    FROM tool_executions
    WHERE session_id IN (${sessionIds.map(() => '?').join(',')})
      AND timestamp >= ?
      AND input_summary IS NOT NULL
  `).all(...sessionIds, sinceMs) as Array<{ input_summary: string | null; timestamp: number }>);

  const lastActiveMs = sessions.reduce((max, row) => Math.max(max, row.last_activity_at || 0), 0);

  return {
    projectKey,
    oneLiner: (digests[0]?.one_liner ?? '').trim(),
    activeFiles: rankActiveFiles(
      touchRows.map(row => ({ timestampMs: row.timestamp, paths: extractFilePaths(row.input_summary ?? '') })),
    ),
    openQuestions: mergeOpenQuestions(
      digests.slice(0, OPEN_QUESTIONS_DIGEST_LIMIT).map(row => ({ openQuestions: parseJsonArray(row.open_questions) })),
    ),
    sessionCount: sessions.length,
    lastActive: lastActiveMs > 0 ? new Date(lastActiveMs).toISOString() : '',
    updatedAt: now.toISOString(),
  };
}

/** Every project key known to the registry, in stable order. */
export function listProjectKeys(db: Database): string[] {
  return (db.prepare('SELECT project_key FROM project_registry ORDER BY project_key').all() as Array<{ project_key: string }>)
    .map(row => row.project_key);
}

/**
 * Render the L0 card as Markdown — the no-LLM fallback content for the L2
 * project brief, so the brief stays useful when the agent is unconfigured.
 */
export function renderProjectStateMarkdown(state: ProjectState, projectLabel?: string): string {
  const lines: string[] = [`# ${projectLabel ?? state.projectKey} — 当前状态`, ''];
  lines.push(`- 一句话：${state.oneLiner || '（暂无）'}`);
  lines.push(`- 会话数：${state.sessionCount}`);
  lines.push(`- 最近活跃：${state.lastActive || '（暂无）'}`);
  lines.push('', '## 活跃文件（近 30 天）');
  if (state.activeFiles.length === 0) {
    lines.push('- （暂无）');
  } else {
    for (const file of state.activeFiles) {
      lines.push(`- \`${file.path}\`（${file.touches} 次，最近 ${file.lastTouched.slice(0, 10)}）`);
    }
  }
  lines.push('', '## 未决问题');
  if (state.openQuestions.length === 0) {
    lines.push('- （暂无）');
  } else {
    for (const question of state.openQuestions) lines.push(`- ${question}`);
  }
  return lines.join('\n');
}
