/**
 * Read-only access to the VESTI capture database.
 *
 * Uses the built-in `node:sqlite` driver (no native module, no ABI coupling
 * to the Electron-flavored better-sqlite3 binary in the desktop app).
 * The database is always opened with `readOnly: true` — this server never
 * writes to the user's memory store.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DatabaseSync } from './node-sqlite.js';

export type VestiDatabase = DatabaseSync;

export function defaultDbPath(): string {
  return path.join(os.homedir(), '.vesti', 'db', 'vesti.db');
}

/** VESTI_DB_PATH wins; otherwise the default `~/.vesti/db/vesti.db`. */
export function resolveDbPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.VESTI_DB_PATH?.trim();
  return override ? path.resolve(override) : defaultDbPath();
}

export class VestiDbNotFoundError extends Error {
  constructor(dbPath: string) {
    super(
      `VESTI database not found at ${dbPath}.\n` +
        'Run the VESTI desktop app (or CLI capture) first so it can collect sessions, ' +
        'or point VESTI_DB_PATH at an existing vesti.db.',
    );
    this.name = 'VestiDbNotFoundError';
  }
}

/**
 * Open the database read-only. Throws VestiDbNotFoundError when the file is
 * missing so the CLI can print actionable guidance instead of a stack trace.
 */
export function openVestiDb(dbPath: string): VestiDatabase {
  if (!fs.existsSync(dbPath)) throw new VestiDbNotFoundError(dbPath);
  // `readOnly` exists since Node 22.13 / 23.4; cast because @types/node 22
  // lags the runtime surface.
  const options = { readOnly: true } as ConstructorParameters<typeof DatabaseSync>[1];
  return new DatabaseSync(dbPath, options);
}
