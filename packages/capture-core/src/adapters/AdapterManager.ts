/**
 * Adapter Manager
 * Registry + file watching for all agent adapters
 */

import { EventEmitter } from 'events';
import chokidar from 'chokidar';
import type { AgentAdapter, AgentDetectResult, ParsedSession } from '../types/agent.js';
import type { AgentPlatform } from '../types/index.js';
import { nativeHomeRoot, type HomeRoot } from '../platform/PathResolver.js';
import { AiderAdapter } from './aider/adapter.js';
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
    this.register(new AiderAdapter());
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
   * Push WSL homes discovered by WslDetector into every adapter that
   * supports multi-root capture. The native home always stays first.
   */
  setWslHomes(wslHomes: Array<{ distro: string; homeUnc: string }>): void {
    const homes: HomeRoot[] = [
      nativeHomeRoot(),
      ...wslHomes.map(home => ({ host: `wsl:${home.distro}`, homeDir: home.homeUnc })),
    ];
    for (const adapter of this.adapters.values()) {
      adapter.setHomeRoots?.(homes);
    }
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

      // UNC (WSL) roots are excluded: Node fs.watch cannot watch UNC
      // directories (EISDIR), so WSL sources rely on the polling fallback in
      // CaptureService instead of chokidar events.
      const patterns = adapter
        .getWatchPatterns()
        .filter((p) => !p.startsWith('\\\\') && !p.startsWith('//'));
      if (patterns.length === 0) continue;

      const watcher = chokidar.watch(patterns, {
        persistent: true,
        ignoreInitial: true,
        // Subagent files are watched too so subagent_links resolve; they are
        // append-heavy like main transcripts, and awaitWriteFinish already
        // debounces events until writes settle.
        awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
      });

      watcher.on('add', (fp) => onChange(platform, fp));
      watcher.on('change', (fp) => onChange(platform, fp));
      // A watcher error must never surface as an unhandled rejection — the
      // sync/polling paths remain the source of truth.
      watcher.on('error', () => {});

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
