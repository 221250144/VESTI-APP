/** Cursor desktop adapter (read-only access to Cursor's local state database). */

import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { glob } from 'glob';
import type { AgentAdapter, AgentDetectResult, ParsedSession } from '../../types/agent.js';
import { CursorParser } from './parser.js';

function cursorUserDir(): string {
  if (process.platform === 'win32' && process.env.APPDATA) {
    return path.join(process.env.APPDATA, 'Cursor', 'User');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Cursor', 'User');
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'Cursor', 'User');
}

export class CursorAdapter implements AgentAdapter {
  readonly platform = 'cursor' as const;
  readonly name = 'Cursor';
  readonly shouldBackupSource = false;

  private readonly userDir = cursorUserDir();
  private readonly parser = new CursorParser();

  async detect(): Promise<AgentDetectResult> {
    const files = await this.getSessionFiles();
    if (files.length === 0) return { installed: false };

    let sessionCount = 0;
    try { sessionCount = await this.parser.countSessions(files[0]); } catch { /* Cursor may hold a short write lock */ }
    return {
      installed: true,
      installPath: this.userDir,
      sessionCount,
    };
  }

  async parseSession(filePath: string): Promise<ParsedSession> {
    const sessions = await this.parseSessions(filePath);
    if (sessions.length === 0) throw new Error(`No Cursor conversations found in ${filePath}`);
    return sessions[0];
  }

  parseSessions(filePath: string): Promise<ParsedSession[]> {
    return this.parser.parseDatabase(filePath);
  }

  async getSessionFiles(): Promise<string[]> {
    const globalDb = path.join(this.userDir, 'globalStorage', 'state.vscdb');
    if (await fs.pathExists(globalDb)) return [globalDb];

    const workspaceStorage = path.join(this.userDir, 'workspaceStorage');
    if (!(await fs.pathExists(workspaceStorage))) return [];
    return glob('*/state.vscdb', { cwd: workspaceStorage, absolute: true });
  }

  getWatchPatterns(): string[] {
    return [
      path.join(this.userDir, 'globalStorage', 'state.vscdb'),
      path.join(this.userDir, 'workspaceStorage', '*', 'state.vscdb'),
    ];
  }
}
