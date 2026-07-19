/**
 * Conversation Tree Index
 * Builds the lightweight hierarchy 来源(platform+host) → 项目(project) →
 * 会话(session + digest) from a single SQL read plus in-memory assembly.
 * O(sessions); the result is plain JSON for IPC transfer. Browser-source
 * sessions are not stored in this database — the renderer merges its own
 * "browser" subtree on top of this tree.
 */

import { deriveProjectKey } from '../storage/projectRegistry.js';

type Database = import('better-sqlite3').Database;

export interface ConversationTreeSession {
  id: string;
  title: string;
  messageCount: number;
  lastActivityAt: number;
  oneLiner: string | null;
  keyTopics: string[];
  keyFiles: string[];
  decisions: string[];
}

export interface ConversationTreeProject {
  projectKey: string;
  label: string;
  pathOrDomain: string;
  sessions: ConversationTreeSession[];
}

export interface ConversationTreeSource {
  platform: string;
  host: string;
  projects: ConversationTreeProject[];
}

export interface ConversationTree {
  generatedAt: string;
  sources: ConversationTreeSource[];
}

interface SessionRow {
  id: string;
  platform: string;
  host: string;
  project_path: string;
  git_remote: string | null;
  title: string;
  message_count: number;
  last_activity_at: number;
  one_liner: string | null;
  key_topics: string | null;
  key_files: string | null;
  decisions: string | null;
}

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
 * Read work_sessions LEFT JOIN session_digests once and assemble the tree.
 * Project keys are re-derived per session with the same pure function the
 * sync pipeline uses, so sessions appear even when their digest or registry
 * row is missing; registry labels enrich the nodes when present.
 */
export function buildConversationTree(db: Database): ConversationTree {
  const sessions = db.prepare(`
    SELECT ws.id, ws.platform, ws.host, ws.project_path, ws.git_remote,
           ws.title, ws.message_count, ws.last_activity_at,
           sd.one_liner, sd.key_topics, sd.key_files, sd.decisions
    FROM work_sessions ws
    LEFT JOIN session_digests sd ON sd.session_id = ws.id
    WHERE ws.session_type = 'conversation'
    ORDER BY ws.last_activity_at DESC
  `).all() as SessionRow[];

  const registry = new Map<string, { label: string; pathOrDomain: string }>();
  for (const row of db.prepare('SELECT project_key, label, path_or_domain FROM project_registry').all() as Array<{
    project_key: string;
    label: string | null;
    path_or_domain: string | null;
  }>) {
    registry.set(row.project_key, { label: row.label ?? 'unknown', pathOrDomain: row.path_or_domain ?? '' });
  }

  const sources = new Map<string, ConversationTreeSource>();
  for (const row of sessions) {
    const host = row.host || 'native';
    const sourceKey = `${row.platform}|${host}`;
    let source = sources.get(sourceKey);
    if (!source) {
      source = { platform: row.platform, host, projects: [] };
      sources.set(sourceKey, source);
    }

    const projectKey = deriveProjectKey({
      platform: row.platform,
      host,
      projectPath: row.project_path,
      gitRemote: row.git_remote ?? undefined,
    });
    let project = source.projects.find(candidate => candidate.projectKey === projectKey);
    if (!project) {
      const entry = registry.get(projectKey);
      project = {
        projectKey,
        label: entry?.label ?? 'unknown',
        pathOrDomain: entry?.pathOrDomain ?? '',
        sessions: [],
      };
      source.projects.push(project);
    }

    project.sessions.push({
      id: row.id,
      title: row.title,
      messageCount: row.message_count,
      lastActivityAt: row.last_activity_at,
      oneLiner: row.one_liner,
      keyTopics: parseJsonArray(row.key_topics),
      keyFiles: parseJsonArray(row.key_files),
      decisions: parseJsonArray(row.decisions),
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    sources: [...sources.values()],
  };
}
