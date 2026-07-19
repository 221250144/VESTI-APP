/**
 * Schema Migration Tests
 * Covers: fresh-database migration, upgrade of a simulated legacy database
 * (data preserved, missing column backfilled) and restart idempotency.
 */

import os from 'os';
import path from 'path';
import fs from 'fs-extra';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseManager } from '../src/storage/DatabaseManager.js';
import type { WorkSession } from '../src/types/unified.js';

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => fs.remove(dir)));
});

function columnNames(dbPath: string, table: string): string[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(r => r.name);
  } finally {
    db.close();
  }
}

function appliedMigrations(dbPath: string): Array<{ version: number; name: string; applied_at: string }> {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare('SELECT version, name, applied_at FROM schema_migrations ORDER BY version').all() as Array<{
      version: number;
      name: string;
      applied_at: string;
    }>;
  } finally {
    db.close();
  }
}

function tableNames(dbPath: string): string[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>)
      .map(row => row.name);
  } finally {
    db.close();
  }
}

/** The work_sessions shape shipped before session_type was added. */
function createLegacyWorkSessions(db: Database.Database): void {
  db.exec(`
    CREATE TABLE work_sessions (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      platform_version TEXT,
      project_path TEXT NOT NULL DEFAULT '',
      git_branch TEXT,
      git_remote TEXT,
      model TEXT,
      models TEXT,
      title TEXT NOT NULL DEFAULT 'Untitled',
      summary TEXT,
      tags TEXT DEFAULT '[]',
      status TEXT DEFAULT 'active',
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      last_activity_at INTEGER NOT NULL,
      duration_ms INTEGER DEFAULT 0,
      message_count INTEGER DEFAULT 0,
      user_input_count INTEGER DEFAULT 0,
      assistant_message_count INTEGER DEFAULT 0,
      thinking_count INTEGER DEFAULT 0,
      tool_call_count INTEGER DEFAULT 0,
      code_block_count INTEGER DEFAULT 0,
      turn_count INTEGER DEFAULT 0,
      total_input_tokens INTEGER DEFAULT 0,
      total_output_tokens INTEGER DEFAULT 0,
      total_cache_creation_tokens INTEGER DEFAULT 0,
      total_cache_read_tokens INTEGER DEFAULT 0,
      has_subagents INTEGER DEFAULT 0,
      has_context_compaction INTEGER DEFAULT 0,
      agent_meta TEXT,
      claude_code_version TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
}

describe('schema migrations', () => {
  it('migrates a fresh database from zero and records all versions', async () => {
    const dir = await makeTempDir('vesti-migrations-fresh-');
    const dbPath = path.join(dir, 'vesti.db');

    const manager = new DatabaseManager(dbPath);
    await manager.initialize();
    await manager.close();

    const migrations = appliedMigrations(dbPath);
    expect(migrations.map(m => m.version)).toEqual([1, 2, 3]);
    expect(migrations[0].name).toBe('add_work_sessions_session_type');
    expect(migrations[1].name).toBe('add_work_sessions_host');
    expect(migrations[2].name).toBe('add_session_digests_and_project_registry');
    for (const migration of migrations) {
      expect(migration.applied_at).toBeTruthy();
    }
    expect(columnNames(dbPath, 'work_sessions')).toContain('session_type');
    expect(columnNames(dbPath, 'work_sessions')).toContain('host');
    // Migration 3: conversation-tree index tables.
    expect(columnNames(dbPath, 'session_digests')).toEqual(expect.arrayContaining([
      'session_id', 'host', 'platform', 'project_key', 'one_liner',
      'key_topics', 'key_files', 'decisions', 'open_questions',
      'embedding', 'embedding_status', 'digest_version', 'message_count', 'updated_at',
    ]));
    expect(columnNames(dbPath, 'project_registry')).toEqual(expect.arrayContaining([
      'project_key', 'kind', 'label', 'path_or_domain', 'first_seen', 'last_seen',
    ]));
  });

  it('upgrades a legacy database: data preserved and session_type backfilled', async () => {
    const dir = await makeTempDir('vesti-migrations-legacy-');
    const dbPath = path.join(dir, 'vesti.db');

    // Simulate a database created before the session_type column existed.
    const legacy = new Database(dbPath);
    createLegacyWorkSessions(legacy);
    legacy.prepare(`
      INSERT INTO work_sessions (id, session_id, platform, title, started_at, last_activity_at, created_at, updated_at)
      VALUES ('ws-legacy', 'session-legacy', 'codex', 'Legacy session', 1000, 2000, 1000, 2000)
    `).run();
    legacy.close();

    expect(columnNames(dbPath, 'work_sessions')).not.toContain('session_type');

    const manager = new DatabaseManager(dbPath);
    await manager.initialize();

    const preserved = manager.getWorkSession('ws-legacy');
    expect(preserved).not.toBeNull();
    expect(preserved!.title).toBe('Legacy session');
    expect(preserved!.sessionType).toBe('conversation');
    // Migration 2 backfills pre-WSL rows as native.
    expect(preserved!.host).toBe('native');

    // The backfilled column must accept writes through the normal upsert path.
    const fresh: WorkSession = {
      id: 'ws-new',
      sessionId: 'session-new',
      platform: 'codex',
      projectPath: '',
      title: 'New session',
      tags: [],
      status: 'active',
      sessionType: 'conversation',
      startedAt: 3000,
      lastActivityAt: 3000,
      durationMs: 0,
      messageCount: 0,
      userInputCount: 0,
      assistantMessageCount: 0,
      thinkingCount: 0,
      toolCallCount: 0,
      codeBlockCount: 0,
      turnCount: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheCreationTokens: 0,
      totalCacheReadTokens: 0,
      hasSubagents: false,
      hasContextCompaction: false,
      createdAt: 3000,
      updatedAt: 3000,
    };
    manager.upsertWorkSession(fresh);
    expect(manager.getWorkSession('ws-new')?.sessionType).toBe('conversation');
    expect(manager.getWorkSession('ws-new')?.host).toBe('native');
    await manager.close();

    expect(columnNames(dbPath, 'work_sessions')).toContain('session_type');
    expect(columnNames(dbPath, 'work_sessions')).toContain('host');
    expect(appliedMigrations(dbPath).map(m => m.version)).toEqual([1, 2, 3]);
    // Migration 3 creates the index tables on legacy databases too.
    expect(tableNames(dbPath)).toEqual(expect.arrayContaining(['session_digests', 'project_registry']));
    // Legacy rows get a project registry entry from the normal upsert path.
    const registry = new Database(dbPath, { readonly: true });
    try {
      const row = registry.prepare('SELECT * FROM project_registry').get() as { kind: string } | undefined;
      expect(row?.kind).toBe('cli_path');
    } finally {
      registry.close();
    }
  });

  it('is idempotent across restarts', async () => {
    const dir = await makeTempDir('vesti-migrations-idem-');
    const dbPath = path.join(dir, 'vesti.db');

    const first = new DatabaseManager(dbPath);
    await first.initialize();
    await first.close();

    const second = new DatabaseManager(dbPath);
    await second.initialize();
    await second.close();

    expect(appliedMigrations(dbPath)).toHaveLength(3);
  });
});
