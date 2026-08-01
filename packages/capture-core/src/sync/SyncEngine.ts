/**
 * Sync Engine v2
 * Orchestrates: detect → parse → convert → vault backup → store
 */

import fs from 'fs-extra';
import path from 'path';
import type { AgentPlatform } from '../types/index.js';
import type { SubagentLink } from '../types/unified.js';
import type { AdapterManager } from '../adapters/AdapterManager.js';
import type { DatabaseManager } from '../storage/DatabaseManager.js';
import type { VaultManager } from '../storage/VaultManager.js';
import type { ClaudeCodeAdapter } from '../adapters/claude-code/adapter.js';
import { hostFromPath, rewriteSessionIdForHost } from '../platform/PathResolver.js';
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
  /**
   * Child-side links whose parent session was not stored yet (FK on
   * parent_session_id rejected them). Retried at the top of every
   * resolveSubagentLinks() call — each sync path runs one after storing
   * sessions, so a child-first event order still lands its link in the same
   * sync round.
   */
  private pendingSubagentLinks = new Map<string, SubagentLink>();

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
    await this.resolveSubagentLinks();
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
    const parserVersion = this.adapters.getAdapter(platform)?.parserVersion ?? 0;

    // Skip only when the file is unchanged AND it was last parsed by a
    // parser at least as capable as the current one — an adapter upgrade
    // (new lineage/usage extraction) must re-parse old files.
    const { size, mtimeMs } = await fs.stat(filePath);
    if (
      syncState &&
      syncState.lastPosition === size &&
      syncState.lastModified >= mtimeMs &&
      syncState.parserVersion >= parserVersion
    ) {
      return null; // No new data
    }

    const sessions = await this.adapters.parseSessions(platform, filePath);
    if (sessions.length === 0) {
      this.db.setSyncState(filePath, platform, size, mtimeMs, undefined, undefined, parserVersion);
      return null;
    }

    // Source host ('native' or 'wsl:<distro>'), derived from the file path.
    const host = hostFromPath(filePath);

    // Vault backup (Layer 1)
    const adapter = this.adapters.getAdapter(platform);
    if (this.vault && adapter?.shouldBackupSource !== false) {
      try {
        await this.vault.backup(
          filePath,
          platform,
          sessions.length === 1 ? sessions[0].sessionId : undefined,
          host,
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
    let linkDeferred = false;

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

      // Tag the host and give WSL sessions a distinct id so the same
      // sessionId captured natively and inside WSL never collides in
      // work_sessions. Done after the meta lookup, which keys on the
      // original sessionId.
      session.host = host;
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

      for (const link of converted.subagentLinks) {
        try {
          this.db.insertSubagentLink(link);
        } catch (err) {
          // Child-side lineage (kimi-code sub wire, Cursor background agent)
          // can arrive before the parent session is stored; the FK on
          // parent_session_id rejects the row. Queue it for the next
          // resolveSubagentLinks() run and leave sync_state unset so the
          // file re-parses (and retries) after a restart too.
          if ((err as { code?: string })?.code !== 'SQLITE_CONSTRAINT_FOREIGNKEY') throw err;
          this.pendingSubagentLinks.set(link.id, link);
          linkDeferred = true;
        }
      }

      totals.sessions++;
      totals.messages += Math.max(0, converted.messages.length - previousMessageCount);
      totals.toolExecutions += Math.max(0, converted.toolExecutions.length - previousToolCount);
      totals.turns += Math.max(0, converted.turns.length - previousTurnCount);
    }

    // Update sync state. Skipped while a subagent link is deferred: the file
    // must re-parse later so the link retries even without a file change.
    if (!linkDeferred) {
      const onlySession = sessions.length === 1 ? sessions[0] : undefined;
      this.db.setSyncState(
        filePath,
        platform,
        size,
        mtimeMs,
        onlySession?.sessionId,
        onlySession ? `${platform}:${onlySession.sessionId}` : undefined,
        parserVersion,
      );
    }

    return totals.sessions > 0 ? totals : null;
  }

  /**
   * Resolve unlinked subagent links by matching file_path to sync_state.
   * Link file paths come from parsers (path.join style) while sync_state keys
   * come from enumeration (glob forward-slash style on Windows), so the
   * lookup tries the raw path plus both separator variants.
   *
   * Public because every sync path must run it: link rows are written when
   * the *parent* session syncs, but the child side only resolves once the
   * subagent transcript itself is in sync_state. A transcript that exists on
   * disk but was never synced (e.g. the file watcher excludes subagent dirs)
   * is synced on demand here, so subagents mount into the tree without
   * waiting for the next full scan. Returns the number of links resolved.
   */
  async resolveSubagentLinks(): Promise<number> {
    let resolved = 0;
    // Retry child-side links that arrived before their parent session. A
    // still-missing parent keeps the link queued; any other failure drops
    // it (the parent-side ref + file-path resolution is the backstop).
    for (const [id, link] of this.pendingSubagentLinks) {
      try {
        this.db.insertSubagentLink(link);
        this.pendingSubagentLinks.delete(id);
        resolved += 1;
      } catch (err) {
        if ((err as { code?: string })?.code !== 'SQLITE_CONSTRAINT_FOREIGNKEY') {
          this.pendingSubagentLinks.delete(id);
        }
      }
    }
    // Pass 1: resolve from sync_state; collect links whose transcript was
    // never synced. Pass 2: sync those files, then resolve again.
    for (let pass = 0; pass < 2; pass += 1) {
      const unresolved = this.db.getUnresolvedSubagentLinks();
      if (unresolved.length === 0) break;
      const missing: Array<typeof unresolved[number]> = [];
      for (const link of unresolved) {
        if (this.tryResolveLink(link)) resolved += 1;
        else missing.push(link);
      }
      if (pass === 1 || missing.length === 0) break;
      let syncedAny = false;
      for (const link of missing) {
        const platform = link.parentSessionId.split(':')[0] as AgentPlatform;
        try {
          if (!link.filePath || !(await fs.pathExists(link.filePath))) continue;
          const stored = await this.syncFile(platform, link.filePath);
          syncedAny = syncedAny || stored !== null;
        } catch { /* a broken transcript must not block the others */ }
      }
      if (!syncedAny) break;
    }
    return resolved;
  }

  private tryResolveLink(link: { id: string; filePath: string }): boolean {
    const candidates = [
      link.filePath,
      link.filePath.replace(/\\/g, '/'),
      link.filePath.replace(/\//g, path.sep),
    ];
    for (const candidate of candidates) {
      const syncState = this.db.getSyncState(candidate);
      if (syncState?.conversationId) {
        this.db.updateSubagentLinkChild(link.id, syncState.conversationId);
        return true;
      }
    }
    return false;
  }
}
