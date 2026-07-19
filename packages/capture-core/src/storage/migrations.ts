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
  up(db: Database): void;
}

export function hasColumn(db: Database, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some(row => row.name === column);
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
];
