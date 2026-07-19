/**
 * Build a temporary vesti.db-shaped fixture: the same tables/triggers the
 * capture engine creates (subset relevant to the MCP tools), seeded with two
 * sessions so FTS recall has something to find.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DatabaseSync } from '../../src/node-sqlite.js';

export interface Fixture {
  dbPath: string;
  cleanup: () => void;
}

const SCHEMA = `
CREATE TABLE work_sessions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  project_path TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT 'Untitled',
  summary TEXT,
  host TEXT NOT NULL DEFAULT 'native',
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  last_activity_at INTEGER NOT NULL,
  message_count INTEGER DEFAULT 0,
  turn_count INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE turns (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  user_input TEXT,
  assistant_response TEXT,
  message_count INTEGER DEFAULT 0,
  tool_execution_count INTEGER DEFAULT 0,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  duration_ms INTEGER DEFAULT 0
);
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  turn_id TEXT,
  source TEXT NOT NULL DEFAULT 'assistant_text',
  sequence INTEGER DEFAULT 0,
  role TEXT NOT NULL,
  content_text TEXT,
  content_thinking TEXT,
  content_tool_name TEXT,
  content_tool_input TEXT,
  content_tool_output TEXT,
  is_sidechain INTEGER DEFAULT 0,
  timestamp INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE tool_executions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  turn_id TEXT,
  sequence INTEGER DEFAULT 0,
  tool_use_message_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  outcome TEXT DEFAULT 'pending',
  input_summary TEXT,
  output_summary TEXT,
  is_error INTEGER DEFAULT 0,
  timestamp INTEGER NOT NULL
);
CREATE TABLE session_digests (
  session_id TEXT PRIMARY KEY,
  host TEXT,
  platform TEXT,
  one_liner TEXT,
  key_topics TEXT,
  key_files TEXT,
  decisions TEXT,
  open_questions TEXT,
  embedding BLOB,
  embedding_status TEXT NOT NULL DEFAULT 'none',
  updated_at TEXT
);
CREATE VIRTUAL TABLE messages_fts USING fts5(
  content_text, content_thinking, content_tool_name, content_tool_input, content_tool_output,
  content='messages', content_rowid='rowid'
);
CREATE VIRTUAL TABLE sessions_fts USING fts5(
  title, summary, content='work_sessions', content_rowid='rowid'
);
CREATE TRIGGER msg_fts_insert AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content_text, content_thinking, content_tool_name, content_tool_input, content_tool_output)
  VALUES (new.rowid, new.content_text, new.content_thinking, new.content_tool_name, new.content_tool_input, new.content_tool_output);
END;
CREATE TRIGGER ws_fts_insert AFTER INSERT ON work_sessions BEGIN
  INSERT INTO sessions_fts(rowid, title, summary) VALUES (new.rowid, new.title, new.summary);
END;
`;

export const SESSION_A = 'ws-aaa-001';
export const SESSION_B = 'ws-bbb-002';

export function createFixtureDb(): Fixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vesti-mcp-test-'));
  const dbPath = path.join(dir, 'vesti.db');
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);

  const now = Date.UTC(2026, 0, 10, 12, 0, 0);

  const insertSession = db.prepare(
    `INSERT INTO work_sessions (id, session_id, platform, project_path, title, summary, host, started_at, ended_at, last_activity_at, message_count, turn_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'native', ?, ?, ?, ?, ?, ?, ?)`,
  );
  insertSession.run(
    SESSION_A, 'platform-a-1', 'claude-code', 'C:/work/vesti',
    'Refactoring the sqlite storage layer', 'Storage refactor session',
    now, now + 3_600_000, now + 3_600_000, 6, 3, now, now,
  );
  insertSession.run(
    SESSION_B, 'platform-b-1', 'codex', 'C:/work/blog',
    'Deploying a static site', 'Deploy session',
    now + 86_400_000, null, now + 86_400_000, 2, 1, now + 86_400_000, now + 86_400_000,
  );

  const insertTurn = db.prepare(
    `INSERT INTO turns (id, session_id, sequence, user_input, assistant_response, message_count, tool_execution_count, input_tokens, output_tokens, started_at, duration_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (let i = 1; i <= 3; i++) {
    insertTurn.run(
      `${SESSION_A}-t${i}`, SESSION_A, i,
      i === 1 ? 'please refactor the database migrations to be transactional' : `follow-up question ${i}`,
      `assistant response ${i}`, 2, i === 1 ? 1 : 0, 1200 * i, 340 * i, now + i * 60_000, 45_000,
    );
  }
  insertTurn.run(
    `${SESSION_B}-t1`, SESSION_B, 1,
    'help me deploy the blog to gh-pages', 'sure, here is the plan', 2, 1, 900, 210,
    now + 86_400_000, 30_000,
  );

  const insertMessage = db.prepare(
    `INSERT INTO messages (id, session_id, turn_id, source, sequence, role, content_text, content_thinking, timestamp, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insertMessage.run(
    'm-a1-u', SESSION_A, `${SESSION_A}-t1`, 'user_input', 1, 'user',
    'please refactor the database migrations to be transactional', null, now + 60_000, now + 60_000,
  );
  insertMessage.run(
    'm-a1-think', SESSION_A, `${SESSION_A}-t1`, 'assistant_think', 2, 'assistant',
    null, 'the migration runner should wrap each step in BEGIN/COMMIT', now + 61_000, now + 61_000,
  );
  insertMessage.run(
    'm-a1-a', SESSION_A, `${SESSION_A}-t1`, 'assistant_text', 3, 'assistant',
    'I wrapped every migration step in a transaction and added rollback handling.', null, now + 62_000, now + 62_000,
  );
  insertMessage.run(
    'm-a2-u', SESSION_A, `${SESSION_A}-t2`, 'user_input', 1, 'user',
    'follow-up question 2', null, now + 120_000, now + 120_000,
  );
  insertMessage.run(
    'm-a2-a', SESSION_A, `${SESSION_A}-t2`, 'assistant_text', 2, 'assistant',
    'answer two', null, now + 121_000, now + 121_000,
  );
  insertMessage.run(
    'm-a3-u', SESSION_A, `${SESSION_A}-t3`, 'user_input', 1, 'user',
    'follow-up question 3', null, now + 180_000, now + 180_000,
  );
  insertMessage.run(
    'm-a3-a', SESSION_A, `${SESSION_A}-t3`, 'assistant_text', 2, 'assistant',
    `a very long answer three. ${'detail '.repeat(300)}`, null, now + 181_000, now + 181_000,
  );
  insertMessage.run(
    'm-b1-u', SESSION_B, `${SESSION_B}-t1`, 'user_input', 1, 'user',
    'help me deploy the blog to gh-pages', null, now + 86_400_000, now + 86_400_000,
  );
  insertMessage.run(
    'm-b1-a', SESSION_B, `${SESSION_B}-t1`, 'assistant_text', 2, 'assistant',
    'sure, here is the plan', null, now + 86_401_000, now + 86_401_000,
  );

  const insertTool = db.prepare(
    `INSERT INTO tool_executions (id, session_id, turn_id, sequence, tool_use_message_id, tool_name, outcome, input_summary, output_summary, is_error, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insertTool.run(
    'te-a1-1', SESSION_A, `${SESSION_A}-t1`, 1, 'm-a1-a', 'Edit', 'success',
    'packages/capture-core/src/storage/migrations.ts', 'wrapped migration in transaction', 0, now + 62_500,
  );
  insertTool.run(
    'te-b1-1', SESSION_B, `${SESSION_B}-t1`, 1, 'm-b1-a', 'Bash', 'error',
    'npm run deploy', 'npm ERR! missing script: deploy', 1, now + 86_402_000,
  );

  const insertDigest = db.prepare(
    `INSERT INTO session_digests (session_id, host, platform, one_liner, key_topics, key_files, embedding_status, updated_at)
     VALUES (?, 'native', ?, ?, ?, ?, 'none', ?)`,
  );
  insertDigest.run(
    SESSION_A, 'claude-code',
    'Made the sqlite migration runner transactional',
    JSON.stringify(['sqlite', 'migrations', 'transactions']),
    JSON.stringify(['packages/capture-core/src/storage/migrations.ts']),
    new Date(now + 3_600_000).toISOString(),
  );
  // SESSION_B intentionally has no digest row: search must still work.

  db.close();
  return {
    dbPath,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}
