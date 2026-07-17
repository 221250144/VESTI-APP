/** OpenAI Codex CLI / Codex app rollout adapter. */

import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { glob } from 'glob';
import type { AgentAdapter, AgentDetectResult, ParsedSession } from '../../types/agent.js';
import { CodexParser } from './parser.js';

export class CodexAdapter implements AgentAdapter {
  readonly platform = 'codex' as const;
  readonly name = 'Codex';

  private readonly parser = new CodexParser();
  private readonly codexDir = path.join(os.homedir(), '.codex');

  async detect(): Promise<AgentDetectResult> {
    if (!(await fs.pathExists(this.codexDir))) return { installed: false };

    const files = await this.getSessionFiles();
    let version: string | undefined;
    if (files.length > 0) {
      try {
        const firstLine = (await fs.readFile(files[0], 'utf8')).split(/\r?\n/, 1)[0];
        const row = JSON.parse(firstLine) as { type?: string; payload?: { cli_version?: string } };
        version = row.type === 'session_meta' ? row.payload?.cli_version : undefined;
      } catch { /* a rollout can be partially written */ }
    }

    return {
      installed: true,
      version,
      installPath: this.codexDir,
      sessionCount: files.length,
    };
  }

  parseSession(filePath: string): Promise<ParsedSession> {
    return this.parser.parseFile(filePath);
  }

  async getSessionFiles(): Promise<string[]> {
    const roots = [
      path.join(this.codexDir, 'sessions'),
      path.join(this.codexDir, 'archived_sessions'),
    ];
    const files: string[] = [];
    for (const root of roots) {
      if (!(await fs.pathExists(root))) continue;
      files.push(...await glob('**/*.jsonl', { cwd: root, absolute: true }));
    }
    const stats = await Promise.all(files.map(async file => ({ file, mtime: (await fs.stat(file)).mtimeMs })));
    return stats.sort((a, b) => b.mtime - a.mtime).map(item => item.file);
  }

  getWatchPatterns(): string[] {
    return [
      path.join(this.codexDir, 'sessions', '**', '*.jsonl'),
      path.join(this.codexDir, 'archived_sessions', '**', '*.jsonl'),
    ];
  }
}
