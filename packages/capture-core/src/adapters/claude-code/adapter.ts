/**
 * Claude Code Adapter
 * Single entry point for Claude Code integration
 */

import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { glob } from 'glob';
import type { AgentAdapter, AgentDetectResult, ParsedSession } from '../../types/agent.js';
import { ClaudeCodeParser } from './parser.js';
import type { ClaudeSessionMeta } from './types.js';

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly platform = 'claude-code' as const;
  readonly name = 'Claude Code';

  private parser = new ClaudeCodeParser();
  private claudeDir = path.join(os.homedir(), '.claude');
  private projectsDir = path.join(os.homedir(), '.claude', 'projects');

  async detect(): Promise<AgentDetectResult> {
    const installed = await fs.pathExists(this.claudeDir);
    if (!installed) {
      return { installed: false };
    }

    let version: string | undefined;
    let sessionCount = 0;

    try {
      const files = await this.getSessionFiles();
      sessionCount = files.length;

      // Try to get version from most recent session
      if (files.length > 0) {
        const stats = await Promise.all(
          files.slice(0, 5).map(async f => ({ f, mtime: (await fs.stat(f)).mtimeMs }))
        );
        stats.sort((a, b) => b.mtime - a.mtime);
        const content = await fs.readFile(stats[0].f, 'utf-8');
        const firstLine = content.split('\n')[0];
        if (firstLine) {
          try {
            const parsed = JSON.parse(firstLine);
            version = parsed.version;
          } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }

    return {
      installed,
      version,
      installPath: this.claudeDir,
      sessionCount,
    };
  }

  async parseSession(filePath: string): Promise<ParsedSession> {
    return this.parser.parseFile(filePath);
  }

  async parseSessionIncremental(filePath: string, byteOffset: number): Promise<{ session: ParsedSession; newOffset: number }> {
    return this.parser.parseIncremental(filePath, byteOffset);
  }

  async getSessionFiles(): Promise<string[]> {
    if (!(await fs.pathExists(this.projectsDir))) return [];

    const files = await glob('**/*.jsonl', {
      cwd: this.projectsDir,
      absolute: true,
      ignore: ['**/subagents/**'],
    });

    return files;
  }

  getWatchPatterns(): string[] {
    return [
      path.join(this.projectsDir, '**', '*.jsonl'),
    ];
  }

  /**
   * Get all project directories under ~/.claude/projects/
   */
  async getProjectDirs(): Promise<string[]> {
    if (!(await fs.pathExists(this.projectsDir))) return [];
    const entries = await fs.readdir(this.projectsDir, { withFileTypes: true });
    return entries
      .filter(e => e.isDirectory())
      .map(e => path.join(this.projectsDir, e.name));
  }

  /**
   * Get session-meta data from ~/.claude/usage-data/session-meta/{sessionId}.json
   */
  async getSessionMeta(sessionId: string): Promise<ClaudeSessionMeta | null> {
    const metaFile = path.join(this.claudeDir, 'usage-data', 'session-meta', `${sessionId}.json`);
    try {
      if (await fs.pathExists(metaFile)) {
        return await fs.readJSON(metaFile) as ClaudeSessionMeta;
      }
    } catch { /* ignore */ }
    return null;
  }
}
