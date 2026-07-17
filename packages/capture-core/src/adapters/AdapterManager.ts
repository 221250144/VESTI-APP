/**
 * Adapter Manager
 * Registry + file watching for all agent adapters
 */

import { EventEmitter } from 'events';
import chokidar from 'chokidar';
import type { AgentAdapter, AgentDetectResult, ParsedSession } from '../types/agent.js';
import type { AgentPlatform } from '../types/index.js';
import { ClaudeCodeAdapter } from './claude-code/adapter.js';
import { CodexAdapter } from './codex/adapter.js';
import { CursorAdapter } from './cursor/adapter.js';
import { KimiCodeAdapter } from './kimi-code/adapter.js';

interface WatchState {
  watcher: chokidar.FSWatcher;
  platform: AgentPlatform;
}

export class AdapterManager extends EventEmitter {
  private adapters = new Map<AgentPlatform, AgentAdapter>();
  private watchers: WatchState[] = [];

  constructor() {
    super();
    // Register built-in adapters
    this.register(new ClaudeCodeAdapter());
    this.register(new CodexAdapter());
    this.register(new CursorAdapter());
    this.register(new KimiCodeAdapter());
  }

  register(adapter: AgentAdapter): void {
    this.adapters.set(adapter.platform, adapter);
  }

  getAdapter(platform: AgentPlatform): AgentAdapter | undefined {
    return this.adapters.get(platform);
  }

  /**
   * Detect all installed agent platforms
   */
  async detectAll(): Promise<Map<AgentPlatform, AgentDetectResult>> {
    const results = new Map<AgentPlatform, AgentDetectResult>();
    for (const [platform, adapter] of this.adapters) {
      results.set(platform, await adapter.detect());
    }
    return results;
  }

  /**
   * Get all session files across all adapters
   */
  async getAllSessionFiles(): Promise<Array<{ platform: AgentPlatform; filePath: string }>> {
    const files: Array<{ platform: AgentPlatform; filePath: string }> = [];
    for (const [platform, adapter] of this.adapters) {
      const detected = await adapter.detect();
      if (detected.installed) {
        const sessionFiles = await adapter.getSessionFiles();
        for (const filePath of sessionFiles) {
          files.push({ platform, filePath });
        }
      }
    }
    return files;
  }

  /**
   * Parse a session file using the appropriate adapter
   */
  async parseSession(platform: AgentPlatform, filePath: string): Promise<ParsedSession> {
    const adapter = this.adapters.get(platform);
    if (!adapter) throw new Error(`No adapter for platform: ${platform}`);
    return adapter.parseSession(filePath);
  }

  async parseSessions(platform: AgentPlatform, filePath: string): Promise<ParsedSession[]> {
    const adapter = this.adapters.get(platform);
    if (!adapter) throw new Error(`No adapter for platform: ${platform}`);
    return adapter.parseSessions
      ? adapter.parseSessions(filePath)
      : [await adapter.parseSession(filePath)];
  }

  /**
   * Start watching all installed adapters for file changes
   */
  async startWatching(onChange: (platform: AgentPlatform, filePath: string) => void): Promise<void> {
    for (const [platform, adapter] of this.adapters) {
      const detected = await adapter.detect();
      if (!detected.installed) continue;

      const patterns = adapter.getWatchPatterns();
      if (patterns.length === 0) continue;

      const watcher = chokidar.watch(patterns, {
        persistent: true,
        ignoreInitial: true,
        ignored: ['**/subagents/**'],
        awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
      });

      watcher.on('add', (fp) => onChange(platform, fp));
      watcher.on('change', (fp) => onChange(platform, fp));

      this.watchers.push({ watcher, platform });
    }
  }

  /**
   * Stop all watchers
   */
  async stopWatching(): Promise<void> {
    for (const { watcher } of this.watchers) {
      await watcher.close();
    }
    this.watchers = [];
  }
}
