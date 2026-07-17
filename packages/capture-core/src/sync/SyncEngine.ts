/**
 * Sync Engine v2
 * Orchestrates: detect → parse → convert → vault backup → store
 */

import fs from 'fs-extra';
import type { AgentPlatform } from '../types/index.js';
import type { AdapterManager } from '../adapters/AdapterManager.js';
import type { DatabaseManager } from '../storage/DatabaseManager.js';
import type { VaultManager } from '../storage/VaultManager.js';
import type { ClaudeCodeAdapter } from '../adapters/claude-code/adapter.js';
import { MessageConverter } from '../storage/MessageConverter.js';

export interface SyncResult {
  platform: AgentPlatform;
  sessionsProcessed: number;
  messagesStored: number;
  toolExecutionsStored: number;
  turnsStored: number;
  errors: string[];
}

export interface SyncFileResult {
  sessions: number;
  messages: number;
  toolExecutions: number;
  turns: number;
}

export class SyncEngine {
  private vault?: VaultManager;

  constructor(
    private adapters: AdapterManager,
    private db: DatabaseManager,
    vault?: VaultManager,
  ) {
    this.vault = vault;
  }

  /**
   * Full sync: scan all session files and import new data
   */
  async syncAll(): Promise<SyncResult[]> {
    const results: SyncResult[] = [];
    const allFiles = await this.adapters.getAllSessionFiles();

    // Group by platform
    const byPlatform = new Map<AgentPlatform, string[]>();
    for (const { platform, filePath } of allFiles) {
      if (!byPlatform.has(platform)) byPlatform.set(platform, []);
      byPlatform.get(platform)!.push(filePath);
    }

    for (const [platform, files] of byPlatform) {
      const result = await this.syncPlatform(platform, files);
      results.push(result);
    }

    // Resolve subagent links after all sessions are synced
    this.resolveSubagentLinks();

    return results;
  }

  /**
   * Sync a single platform's files
   */
  async syncPlatform(platform: AgentPlatform, files: string[]): Promise<SyncResult> {
    const result: SyncResult = {
      platform,
      sessionsProcessed: 0,
      messagesStored: 0,
      toolExecutionsStored: 0,
      turnsStored: 0,
      errors: [],
    };

    for (const filePath of files) {
      try {
        const stored = await this.syncFile(platform, filePath);
        if (stored) {
          result.sessionsProcessed += stored.sessions;
          result.messagesStored += stored.messages;
          result.toolExecutionsStored += stored.toolExecutions;
          result.turnsStored += stored.turns;
        }
      } catch (err) {
        result.errors.push(`${filePath}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return result;
  }

  /**
   * Sync a single file, using incremental position tracking
   */
  async syncFile(platform: AgentPlatform, filePath: string): Promise<SyncFileResult | null> {
    const syncState = this.db.getSyncState(filePath);

    // Check if file has changed
    const { size, mtimeMs } = await fs.stat(filePath);
    if (
      syncState &&
      syncState.lastPosition === size &&
      syncState.lastModified >= mtimeMs
    ) {
      return null; // No new data
    }

    const sessions = await this.adapters.parseSessions(platform, filePath);
    if (sessions.length === 0) {
      this.db.setSyncState(filePath, platform, size, mtimeMs);
      return null;
    }

    // Vault backup (Layer 1)
    const adapter = this.adapters.getAdapter(platform);
    if (this.vault && adapter?.shouldBackupSource !== false) {
      try {
        await this.vault.backup(
          filePath,
          platform,
          sessions.length === 1 ? sessions[0].sessionId : undefined,
        );
      } catch {
        // Non-fatal: continue even if backup fails
      }
    }

    const totals: SyncFileResult = {
      sessions: 0,
      messages: 0,
      toolExecutions: 0,
      turns: 0,
    };

    for (const session of sessions) {
      if (session.messages.length === 0) continue;

      // Load supplemental session-meta for Claude Code.
      if (platform === 'claude-code') {
        try {
          const claudeAdapter = adapter as ClaudeCodeAdapter;
          const meta = await claudeAdapter.getSessionMeta(session.sessionId);
          if (meta) session.meta = meta as Record<string, unknown>;
        } catch { /* non-fatal */ }
      }

      const converted = MessageConverter.convertV2(session);
      const previousMessageCount = this.db.getSessionMessageCount(converted.session.id);
      const previousToolCount = this.db.getUnifiedToolExecutions(converted.session.id).length;
      const previousTurnCount = this.db.getTurns(converted.session.id).length;

      // Store everything (Layer 2). These operations are idempotent upserts so
      // streaming updates with stable message IDs are refreshed correctly.
      this.db.upsertWorkSession(converted.session);
      this.db.insertSessionMessages(converted.messages);
      this.db.insertUnifiedToolExecutions(converted.toolExecutions);
      this.db.insertTurns(converted.turns);
      this.db.insertSystemEvents(converted.systemEvents);
      this.db.insertContextCompactions(converted.contextCompactions);

      for (const link of converted.subagentLinks) {
        this.db.insertSubagentLink(link);
      }

      totals.sessions++;
      totals.messages += Math.max(0, converted.messages.length - previousMessageCount);
      totals.toolExecutions += Math.max(0, converted.toolExecutions.length - previousToolCount);
      totals.turns += Math.max(0, converted.turns.length - previousTurnCount);
    }

    // Update sync state
    const onlySession = sessions.length === 1 ? sessions[0] : undefined;
    this.db.setSyncState(
      filePath,
      platform,
      size,
      mtimeMs,
      onlySession?.sessionId,
      onlySession ? `${platform}:${onlySession.sessionId}` : undefined,
    );

    return totals.sessions > 0 ? totals : null;
  }

  /**
   * Resolve unlinked subagent links by matching file_path to sync_state
   */
  private resolveSubagentLinks(): void {
    const unresolved = this.db.getUnresolvedSubagentLinks();
    for (const link of unresolved) {
      const syncState = this.db.getSyncState(link.filePath);
      if (syncState?.conversationId) {
        this.db.updateSubagentLinkChild(link.id, syncState.conversationId);
      }
    }
  }
}
