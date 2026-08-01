/**
 * Sync Engine v2
 * Orchestrates: detect → parse → convert → store → checkpoint → queued vault backup
 */

import fs from 'fs-extra';
import path from 'path';
import type { AgentPlatform } from '../types/index.js';
import type { AdapterManager } from '../adapters/AdapterManager.js';
import type { DatabaseManager } from '../storage/DatabaseManager.js';
import type { VaultManager } from '../storage/VaultManager.js';
import type { ClaudeCodeAdapter } from '../adapters/claude-code/adapter.js';
import { hostFromPath, rewriteSessionIdForHost } from '../platform/PathResolver.js';
import { MessageConverter } from '../storage/MessageConverter.js';
import type { TokenUsageEvent } from '../types/unified.js';

/** Stable replacement key for one physical sync candidate. */
export function sourceFileKey(platform: AgentPlatform, filePath: string, host: string): string {
  let normalized = path.resolve(filePath).replace(/\\/g, '/');
  if (process.platform === 'win32' && host === 'native') normalized = normalized.toLowerCase();
  return `${platform}:${host}:${normalized}`;
}

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
    // Fork lineage (memory v2): codex rollouts copy the parent's history into
    // the child, so forks are detected post-sync by message-id overlap.
    try {
      this.db.refreshForkLineage();
    } catch { /* lineage detection must never break the sync */ }

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

    const host = hostFromPath(filePath);
    const physicalSourceScope = sourceFileKey(platform, filePath, host);
    const sessions = await this.adapters.parseSessions(platform, filePath);
    if (sessions.length === 0) {
      this.db.replaceTokenUsageEvents(physicalSourceScope, []);
      this.db.setSyncState(filePath, platform, size, mtimeMs);
      return null;
    }

    // Source host ('native' or 'wsl:<distro>'), derived from the file path.

    const adapter = this.adapters.getAdapter(platform);

    const totals: SyncFileResult = {
      sessions: 0,
      messages: 0,
      toolExecutions: 0,
      turns: 0,
    };
    const sourceTokenUsageEvents: TokenUsageEvent[] = [];

    for (const session of sessions) {
      // Some agents can report a completed model invocation even when no
      // displayable text message was persisted (for example a tool-only or
      // interrupted turn). Keep those usage events in the time series.
      if (session.messages.length === 0 && (session.tokenUsageEvents?.length ?? 0) === 0) continue;

      // Load supplemental session-meta for Claude Code.
      if (platform === 'claude-code') {
        try {
          const claudeAdapter = adapter as ClaudeCodeAdapter;
          const meta = await claudeAdapter.getSessionMeta(session.sessionId);
          if (meta) session.meta = meta as Record<string, unknown>;
        } catch { /* non-fatal */ }
      }

      // Tag the host and give WSL sessions a distinct id so the same
      // sessionId captured natively and inside WSL never collides in
      // work_sessions. Done after the meta lookup, which keys on the
      // original sessionId.
      session.host = host;
      session.sourceFileKey = physicalSourceScope;
      if (host !== 'native') {
        session.sessionId = rewriteSessionIdForHost(session.sessionId, host);
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
      sourceTokenUsageEvents.push(...converted.tokenUsageEvents);

      for (const link of converted.subagentLinks) {
        this.db.insertSubagentLink(link);
      }

      totals.sessions++;
      totals.messages += Math.max(0, converted.messages.length - previousMessageCount);
      totals.toolExecutions += Math.max(0, converted.toolExecutions.length - previousToolCount);
      totals.turns += Math.max(0, converted.turns.length - previousTurnCount);
    }

    // One physical candidate can yield several logical sessions. Replace its
    // complete event snapshot once so those sessions cannot erase each other.
    this.db.replaceTokenUsageEvents(physicalSourceScope, sourceTokenUsageEvents);

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

    // Captured data and its checkpoint are durable before archival work starts.
    // VaultManager serializes compression globally; intentionally do not await
    // this promise so a growing JSONL or a failed archive cannot delay capture.
    if (this.vault && adapter?.shouldBackupSource !== false) {
      void this.vault.backup(
        filePath,
        platform,
        onlySession?.sessionId,
        host,
      ).catch(() => undefined);
    }

    return totals.sessions > 0 ? totals : null;
  }

  /**
   * Resolve unlinked subagent links by matching file_path to sync_state.
   * Link file paths come from parsers (path.join style) while sync_state keys
   * come from enumeration (glob forward-slash style on Windows), so the
   * lookup tries the raw path plus both separator variants.
   */
  private resolveSubagentLinks(): void {
    const unresolved = this.db.getUnresolvedSubagentLinks();
    for (const link of unresolved) {
      const candidates = [
        link.filePath,
        link.filePath.replace(/\\/g, '/'),
        link.filePath.replace(/\//g, path.sep),
      ];
      for (const candidate of candidates) {
        const syncState = this.db.getSyncState(candidate);
        if (syncState?.conversationId) {
          this.db.updateSubagentLinkChild(link.id, syncState.conversationId);
          break;
        }
      }
    }
  }
}
