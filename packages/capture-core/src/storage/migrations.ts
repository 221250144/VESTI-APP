/**
 * Schema Migrations
 * Ordered, transactional migrations tracked in the schema_migrations table.
 * Add new entries at the end with the next version number — never edit
 * shipped migrations. Each `up` must be idempotent-safe: it runs exactly
 * once per database, but should still re-check state (e.g. PRAGMA
 * table_info) so databases created by newer code stay compatible.
 */

type Database = import('better-sqlite3').Database;

export interface Migration {
  version: number;
  name: string;
  /**
   * Returns an optional note recorded in schema_migrations.note — used when a
   * migration detects at runtime that it cannot apply (e.g. the SQLite build
   * lacks a feature) and skips itself instead of failing the whole startup.
   */
  up(db: Database): string | void;
}

export function hasColumn(db: Database, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some(row => row.name === column);
}

/**
 * Probe whether this SQLite build actually supports an FTS5 tokenizer.
 * sqlite_version() / compile options don't prove a tokenizer is linked in —
 * trigram is built into SQLite ≥ 3.34, but the only trustworthy check is to
 * create a throwaway table with it.
 */
export function probeFtsTokenizer(db: Database, tokenizer: string): boolean {
  try {
    db.exec(`CREATE VIRTUAL TABLE _fts_tokenizer_probe USING fts5(x, tokenize='${tokenizer}')`);
    db.exec('DROP TABLE _fts_tokenizer_probe');
    return true;
  } catch {
    try { db.exec('DROP TABLE IF EXISTS _fts_tokenizer_probe'); } catch { /* probe best-effort */ }
    return false;
  }
}

/**
 * Rebuild messages_fts / sessions_fts with the trigram tokenizer (migration
 * 5). unicode61 treats a whole unspaced CJK run as ONE token, so Chinese
 * facts written without spaces were invisible to FTS; trigram indexes
 * 3-character sliding windows, making CJK substrings of length ≥ 3 matchable
 * (and Latin matching substring-lenient as a side effect). Column layout is
 * unchanged; the content tables are re-indexed via the FTS5 'rebuild'
 * command. Runs inside the caller's migration transaction.
 */
export function rebuildFtsWithTrigram(db: Database): void {
  // Triggers reference the FTS tables — drop them first.
  for (const trigger of [
    'msg_fts_insert', 'msg_fts_delete', 'msg_fts_update',
    'ws_fts_insert', 'ws_fts_delete', 'ws_fts_update',
  ]) {
    db.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
  }
  db.exec('DROP TABLE IF EXISTS messages_fts');
  db.exec('DROP TABLE IF EXISTS sessions_fts');

  db.exec(`
    CREATE VIRTUAL TABLE messages_fts USING fts5(
      content_text, content_thinking, content_tool_name, content_tool_input, content_tool_output,
      content='messages',
      content_rowid='rowid',
      tokenize='trigram'
    )
  `);
  db.exec(`
    CREATE VIRTUAL TABLE sessions_fts USING fts5(
      title, summary,
      content='work_sessions',
      content_rowid='rowid',
      tokenize='trigram'
    )
  `);

  // Same trigger bodies as DatabaseManager.createFTS (kept IF NOT EXISTS
  // there so both paths coexist: migration creates them on trigram builds,
  // createFTS is the fallback on builds without trigram).
  db.exec(`
    CREATE TRIGGER msg_fts_insert AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, content_text, content_thinking, content_tool_name, content_tool_input, content_tool_output)
      VALUES (new.rowid, new.content_text, new.content_thinking, new.content_tool_name, new.content_tool_input, new.content_tool_output);
    END
  `);
  db.exec(`
    CREATE TRIGGER msg_fts_delete AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content_text, content_thinking, content_tool_name, content_tool_input, content_tool_output)
      VALUES ('delete', old.rowid, old.content_text, old.content_thinking, old.content_tool_name, old.content_tool_input, old.content_tool_output);
    END
  `);
  db.exec(`
    CREATE TRIGGER msg_fts_update AFTER UPDATE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content_text, content_thinking, content_tool_name, content_tool_input, content_tool_output)
      VALUES ('delete', old.rowid, old.content_text, old.content_thinking, old.content_tool_name, old.content_tool_input, old.content_tool_output);
      INSERT INTO messages_fts(rowid, content_text, content_thinking, content_tool_name, content_tool_input, content_tool_output)
      VALUES (new.rowid, new.content_text, new.content_thinking, new.content_tool_name, new.content_tool_input, new.content_tool_output);
    END
  `);
  db.exec(`
    CREATE TRIGGER ws_fts_insert AFTER INSERT ON work_sessions BEGIN
      INSERT INTO sessions_fts(rowid, title, summary)
      VALUES (new.rowid, new.title, new.summary);
    END
  `);
  db.exec(`
    CREATE TRIGGER ws_fts_delete AFTER DELETE ON work_sessions BEGIN
      INSERT INTO sessions_fts(sessions_fts, rowid, title, summary)
      VALUES ('delete', old.rowid, old.title, old.summary);
    END
  `);
  db.exec(`
    CREATE TRIGGER ws_fts_update AFTER UPDATE ON work_sessions BEGIN
      INSERT INTO sessions_fts(sessions_fts, rowid, title, summary)
      VALUES ('delete', old.rowid, old.title, old.summary);
      INSERT INTO sessions_fts(rowid, title, summary)
      VALUES (new.rowid, new.title, new.summary);
    END
  `);

  // Full backfill from the external content tables. 'rebuild' drops and
  // re-reads the whole index; thousands of messages rebuild in seconds.
  db.exec(`INSERT INTO messages_fts(messages_fts) VALUES('rebuild')`);
  db.exec(`INSERT INTO sessions_fts(sessions_fts) VALUES('rebuild')`);
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'add_work_sessions_session_type',
    up(db) {
      // Absorbs the old "ALTER TABLE ... catch" fallback: databases created
      // before session_type existed get the column, fresh databases already
      // have it from CREATE TABLE and skip.
      if (hasColumn(db, 'work_sessions', 'session_type')) return;
      db.exec(`ALTER TABLE work_sessions ADD COLUMN session_type TEXT DEFAULT 'conversation'`);
    },
  },
  {
    version: 2,
    name: 'add_work_sessions_host',
    up(db) {
      // WSL capture (P1.2): tags each session with its source host —
      // 'native' or 'wsl:<distro>'. Existing rows are native by definition.
      if (hasColumn(db, 'work_sessions', 'host')) return;
      db.exec(`ALTER TABLE work_sessions ADD COLUMN host TEXT NOT NULL DEFAULT 'native'`);
    },
  },
  {
    version: 3,
    name: 'add_session_digests_and_project_registry',
    up(db) {
      // P1.5 conversation-tree index: per-session LLM digests (with optional
      // embedding) and the deterministic project registry the sync pipeline
      // maintains from work_sessions rows.
      db.exec(`
        CREATE TABLE IF NOT EXISTS session_digests (
          session_id TEXT PRIMARY KEY,
          host TEXT,
          platform TEXT,
          project_key TEXT,
          one_liner TEXT,
          key_topics TEXT,
          key_files TEXT,
          decisions TEXT,
          open_questions TEXT,
          embedding BLOB,
          embedding_status TEXT NOT NULL DEFAULT 'none',
          digest_version INTEGER NOT NULL DEFAULT 1,
          message_count INTEGER,
          updated_at TEXT
        )
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS project_registry (
          project_key TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          label TEXT,
          path_or_domain TEXT,
          first_seen TEXT,
          last_seen TEXT
        )
      `);
    },
  },
  {
    version: 4,
    name: 'add_memory_v2_fork_lineage_and_project_layers',
    up(db) {
      // Memory v2 (fork lineage + L0-L3 layered project memory):
      // - work_sessions.forked_from: explicit fork lineage (kimi state.json
      //   forkedFrom, codex rollout overlap detection). NULL = not a fork.
      // - session_digests validity semantics (L1): valid_from/valid_to mark
      //   the interval a digest describes; superseded_by points at the digest
      //   that replaced it; access_count feeds recency ranking (MCP bumps it
      //   on search hits).
      // - project_state (L0): one deterministic "current state card" per
      //   project, rewritten wholesale on every rebuild — never invalidated.
      // - project_briefs (L2): LLM-maintained cross-session brief with a
      //   version counter and the ops log of the last deposit-maintain merge.
      if (!hasColumn(db, 'work_sessions', 'forked_from')) {
        db.exec(`ALTER TABLE work_sessions ADD COLUMN forked_from TEXT`);
      }
      if (!hasColumn(db, 'session_digests', 'valid_from')) {
        db.exec(`ALTER TABLE session_digests ADD COLUMN valid_from TEXT`);
      }
      if (!hasColumn(db, 'session_digests', 'valid_to')) {
        db.exec(`ALTER TABLE session_digests ADD COLUMN valid_to TEXT`);
      }
      if (!hasColumn(db, 'session_digests', 'superseded_by')) {
        db.exec(`ALTER TABLE session_digests ADD COLUMN superseded_by TEXT`);
      }
      if (!hasColumn(db, 'session_digests', 'access_count')) {
        db.exec(`ALTER TABLE session_digests ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0`);
      }
      db.exec(`
        CREATE TABLE IF NOT EXISTS project_state (
          project_key TEXT PRIMARY KEY,
          one_liner TEXT,
          active_files TEXT,
          open_questions TEXT,
          session_count INTEGER,
          last_active TEXT,
          updated_at TEXT
        )
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS project_briefs (
          project_key TEXT PRIMARY KEY,
          content_markdown TEXT,
          version INTEGER NOT NULL DEFAULT 0,
          last_ops TEXT,
          updated_at TEXT
        )
      `);
    },
  },
  {
    version: 5,
    name: 'fts5_trigram_tokenizer',
    // Optional probe override exists only for tests (simulate a SQLite build
    // without trigram); runMigrations calls up(db) with the real probe.
    up(db, probe: () => boolean = () => probeFtsTokenizer(db, 'trigram')) {
      if (!probe()) {
        const { v } = db.prepare('SELECT sqlite_version() AS v').get() as { v: string };
        return `skipped: SQLite ${v} has no usable FTS5 trigram tokenizer; messages_fts/sessions_fts kept the default unicode61 tokenizer`;
      }
      rebuildFtsWithTrigram(db);
    },
  },
];
