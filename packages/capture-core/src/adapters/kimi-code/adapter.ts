/**
 * Kimi Code Adapter
 * Detects Kimi Code installation and parses wire.jsonl sessions
 */

import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import type { AgentAdapter, AgentDetectResult, ParsedSession } from '../../types/agent.js';
import { KimiCodeParser } from './parser.js';
import type { KimiConfig } from './types.js';

export class KimiCodeAdapter implements AgentAdapter {
  readonly platform = 'kimi-code' as const;
  readonly name = 'Kimi Code';

  private parser = new KimiCodeParser();
  private kimiDir = path.join(os.homedir(), '.kimi');

  async detect(): Promise<AgentDetectResult> {
    const configFile = path.join(this.kimiDir, 'kimi.json');
    if (!await fs.pathExists(configFile)) {
      return { installed: false };
    }

    const sessionsDir = path.join(this.kimiDir, 'sessions');
    let sessionCount = 0;
    if (await fs.pathExists(sessionsDir)) {
      const hashes = await fs.readdir(sessionsDir);
      for (const hash of hashes) {
        const hashDir = path.join(sessionsDir, hash);
        const stat = await fs.stat(hashDir);
        if (stat.isDirectory()) {
          const uuids = await fs.readdir(hashDir);
          sessionCount += uuids.filter(u => {
            try {
              return fs.statSync(path.join(hashDir, u)).isDirectory();
            } catch { return false; }
          }).length;
        }
      }
    }

    return {
      installed: true,
      installPath: this.kimiDir,
      sessionCount,
    };
  }

  async parseSession(filePath: string): Promise<ParsedSession> {
    // filePath points to the session directory (containing wire.jsonl)
    const sessionDir = filePath.endsWith('wire.jsonl') ? path.dirname(filePath) : filePath;
    const session = await this.parser.parseSessionDir(sessionDir);

    // Fill model from config.toml if not set
    if (!session.model) {
      session.model = await this.getDefaultModel();
    }

    // Read archived status from metadata.json
    const metaFile = path.join(sessionDir, 'metadata.json');
    if (await fs.pathExists(metaFile)) {
      try {
        const raw = await fs.readFile(metaFile, 'utf-8');
        if (raw.trim()) {
          const meta = JSON.parse(raw);
          if (meta.archived) {
            if (!session.meta) session.meta = {};
            session.meta.archived = true;
            if (meta.archived_at) session.meta.archived_at = meta.archived_at;
          }
        }
      } catch { /* ignore */ }
    }

    return session;
  }

  /**
   * Read default model from ~/.kimi/config.toml
   */
  private async getDefaultModel(): Promise<string | undefined> {
    try {
      const configPath = path.join(this.kimiDir, 'config.toml');
      if (!await fs.pathExists(configPath)) return undefined;
      const content = await fs.readFile(configPath, 'utf-8');
      const match = content.match(/default_model\s*=\s*"([^"]+)"/);
      return match ? match[1] : undefined;
    } catch {
      return undefined;
    }
  }

  async getSessionFiles(): Promise<string[]> {
    const sessionsDir = path.join(this.kimiDir, 'sessions');
    if (!await fs.pathExists(sessionsDir)) return [];

    const files: string[] = [];
    try {
      const hashes = await fs.readdir(sessionsDir);
      for (const hash of hashes) {
        const hashDir = path.join(sessionsDir, hash);
        const stat = await fs.stat(hashDir);
        if (!stat.isDirectory()) continue;

        const uuids = await fs.readdir(hashDir);
        for (const uuid of uuids) {
          const sessionDir = path.join(hashDir, uuid);
          const wireFile = path.join(sessionDir, 'wire.jsonl');
          if (await fs.pathExists(wireFile)) {
            files.push(wireFile);
          }
        }
      }
    } catch { /* ignore */ }

    return files;
  }

  getWatchPatterns(): string[] {
    return [
      path.join(this.kimiDir, 'sessions', '**', 'wire.jsonl'),
    ];
  }
}
