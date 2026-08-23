import {
  AdapterManager,
  DatabaseManager,
  SyncEngine,
  VaultManager,
  VestiConfig,
  WslDetector,
  cliIdToNumeric,
  hostFromPath,
  firstVisibleUserSnippet,
  projectSessionTurnsToVesti,
  workSessionToVestiConversation,
  type ConversationTree,
  type FileTimelineEvent,
  type MemoryEntry,
  type ProjectBrief,
  type ProjectState,
  type SessionDigest,
  type SessionDigestStats,
  type SessionRecallHit,
  type SyncResult,
  type WslDetection,
} from '@vesti/capture-core';
import type {
  AgentActivityPayload,
  CapturePlatform,
  ConversationExportBundle,
  ConversationExportResult,
  Overview,
  RelaySessionContext,
  RelayFileTouchRow,
  SessionDetail,
  SessionSummary,
  SourceStatus,
  SyncSummary,
  WslStatusView,
} from '../shared/contracts';
import { computeBundleFingerprint } from '../shared/exportFingerprint';

const PRIMARY_PLATFORMS: CapturePlatform[] = ['codex', 'cursor', 'kimi-code', 'claude-code', 'trae', 'coder', 'workbuddy'];
const SOURCE_LABELS: Record<CapturePlatform, string> = {
  codex: 'Codex',
  cursor: 'Cursor',
  'kimi-code': 'Kimi Code',
  'claude-code': 'Claude Code',
  trae: 'Trae',
  coder: 'Qoder',
  workbuddy: 'WorkBuddy',
};

/**
 * 完工提醒 (agent activity): the file watch keeps storing new content while an
 * agent works. Once a session stays quiet for this long we consider the run
 * finished and notify the renderer so the owl can surface a gentle bubble.
 */
export const AGENT_ACTIVITY_QUIET_MS = 90_000;
const AGENT_ACTIVITY_CHECK_MS = 15_000;
const AGENT_ACTIVITY_EVICT_MS = 30 * 60_000;

export class CaptureService {
  private db!: DatabaseManager;
  private adapters!: AdapterManager;
  private syncEngine!: SyncEngine;
  private watching = false;
  private syncing = false;
  private notify?: () => void;
  private syncCompleted?: () => void;
  private agentActivityListener?: (payload: AgentActivityPayload) => void;
  // Latest watch-path activity; a session goes "quiet" QUIET_MS after the last
  // store, at which point we emit one completion notification per active streak.
  private lastWatchActivity: { at: number; platform: CapturePlatform } | null = null;
  private watchActivityNotified = false;
  private agentActivityTimer: NodeJS.Timeout | null = null;
  // Epoch bumped every time captured session data (or a digest) is stored;
  // backs the conversation-tree cache so repeated getConversationTree calls
  // don't rebuild the full tree when nothing changed.
  private dataEpoch = 0;
  private conversationTreeCache: { epoch: number; tree: ConversationTree } | null = null;
  private fileQueue = new Map<string, Promise<void>>();
  // Per-session fingerprint of the last exported bundle (process-lifetime).
  // exportConversations diffs against this so unchanged sessions — the vast
  // majority on a watch tick — never cross IPC to the renderer.
  private exportFingerprints = new Map<string, number>();
  private basePath = '';
  private enabledPlatforms = new Set<CapturePlatform>(PRIMARY_PLATFORMS);
  private wslDetection: WslDetection | null = null;
  private wslDetectedAt: number | null = null;
  private wslPollTimer: NodeJS.Timeout | null = null;
  private wslPollIntervalMs: number;

  constructor(options?: { wslPollIntervalMs?: number }) {
    // Polling fallback for WSL UNC sources; 0 disables it (tests).
    this.wslPollIntervalMs = options?.wslPollIntervalMs ?? 60_000;
  }

  async initialize(notify: () => void, basePath: string, enabledPlatforms = PRIMARY_PLATFORMS): Promise<void> {
    this.notify = notify;
    this.basePath = basePath;
    this.setEnabledPlatforms(enabledPlatforms);
    const config = new VestiConfig({ storage: { basePath } });
    await config.ensureDirectories();
    this.db = new DatabaseManager(config.dbPath);
    await this.db.initialize();
    this.adapters = new AdapterManager();
    const vault = new VaultManager(config.vaultPath);
    await vault.initialize();
    this.syncEngine = new SyncEngine(this.adapters, this.db, vault);
    await this.refreshWslDetection();
  }

  /**
   * Fired after a sync actually stored session data (full sync, file watch,
   * WSL poll). The digest pipeline hooks here; unlike `notify`, state-only
   * changes (watch toggles, sync start) do not trigger it.
   */
  setSyncCompletedListener(listener: () => void): void {
    this.syncCompleted = listener;
  }

  /** 完工提醒: renderer policy (cooldown, bubble copy) lives in the companion
   * module; the service only reports "this platform went quiet after work". */
  setAgentActivityListener(listener: (payload: AgentActivityPayload) => void): void {
    this.agentActivityListener = listener;
  }

  private noteWatchActivity(platform: CapturePlatform): void {
    this.lastWatchActivity = { at: Date.now(), platform };
    this.watchActivityNotified = false;
    if (!this.agentActivityTimer) {
      this.agentActivityTimer = setInterval(() => this.checkAgentActivityQuiet(), AGENT_ACTIVITY_CHECK_MS);
      this.agentActivityTimer.unref();
    }
  }

  private checkAgentActivityQuiet(): void {
    const record = this.lastWatchActivity;
    if (!record) {
      if (this.agentActivityTimer) {
        clearInterval(this.agentActivityTimer);
        this.agentActivityTimer = null;
      }
      return;
    }
    const now = Date.now();
    if (!this.watchActivityNotified && now - record.at >= AGENT_ACTIVITY_QUIET_MS) {
      this.watchActivityNotified = true;
      const latest = this.getSessions(1)[0];
      if (latest) {
        this.agentActivityListener?.({
          platform: record.platform,
          sessionId: latest.id,
          title: latest.title ?? '',
          at: record.at,
        });
      }
    }
    if (now - record.at >= AGENT_ACTIVITY_EVICT_MS) {
      this.lastWatchActivity = null;
    }
  }

  get activeDataDirectory(): string {
    return this.basePath;
  }

  get isWatching(): boolean {
    return this.watching;
  }

  /**
   * Run WSL detection and push discovered homes into the adapters.
   * Detection is best-effort: any failure keeps the previous result.
   */
  private async refreshWslDetection(): Promise<void> {
    try {
      const detection = await new WslDetector().detect();
      this.wslDetection = detection;
      this.wslDetectedAt = Date.now();
      const wslHomes = detection.homes
        .filter(home => Object.keys(home.roots).length > 0)
        .map(home => ({ distro: home.distro, homeUnc: home.homeUnc }));
      this.adapters.setWslHomes(wslHomes);
    } catch { /* WSL is an optional source — stay native-only */ }
  }

  getWslStatus(): WslStatusView {
    const detection = this.wslDetection;
    return {
      supported: detection?.supported ?? process.platform === 'win32',
      distros: detection?.distros ?? [],
      platforms: PRIMARY_PLATFORMS.map(platform => ({
        platform,
        installed: Boolean(detection?.homes.some(home => home.roots[platform])),
      })),
      detectedAt: this.wslDetectedAt,
    };
  }

  async redetectWsl(): Promise<WslStatusView> {
    await this.refreshWslDetection();
    this.notify?.();
    // Newly discovered sources should flow in without waiting for a file event.
    void this.syncAll().catch(() => undefined);
    return this.getWslStatus();
  }

  /** Polling fallback for WSL UNC sources: chokidar events over the 9P
   * share are unreliable, so WSL files are re-synced on a fixed interval.
   * sync_state makes unchanged files a cheap stat + skip. */
  private startWslPolling(): void {
    if (this.wslPollTimer || this.wslPollIntervalMs <= 0) return;
    this.wslPollTimer = setInterval(() => {
      void this.pollWslOnce().catch(() => undefined);
    }, this.wslPollIntervalMs);
    this.wslPollTimer.unref();
  }

  private stopWslPolling(): void {
    if (this.wslPollTimer) {
      clearInterval(this.wslPollTimer);
      this.wslPollTimer = null;
    }
  }

  private async pollWslOnce(): Promise<void> {
    if (this.syncing) return;
    if (!this.wslDetection?.homes.some(home => Object.keys(home.roots).length > 0)) return;
    let changed = false;
    for (const platform of PRIMARY_PLATFORMS) {
      if (!this.enabledPlatforms.has(platform)) continue;
      const adapter = this.adapters.getAdapter(platform);
      if (!adapter) continue;
      let files: string[];
      try {
        files = (await adapter.getSessionFiles()).filter(file => hostFromPath(file) !== 'native');
      } catch {
        continue; // WSL share unreachable — retry on the next tick
      }
      for (const filePath of files) {
        try {
          const stored = await this.syncEngine.syncFile(platform, filePath);
          changed = changed || stored !== null;
        } catch { /* keep the poll loop resilient */ }
      }
    }
    if (changed) {
      await this.resolveSubagentLinksSafe();
      this.syncCompleted?.();
      this.notify?.();
    }
  }

  /**
   * Subagent link resolution (A1): link rows are written when the parent
   * session syncs, but child ids only resolve against sync_state — so every
   * sync path (full scan, file watch, WSL poll) must run this or subagents
   * degrade to standalone conversations in the tree. Cheap when there is
   * nothing to do (single SELECT over unresolved links).
   */
  private async resolveSubagentLinksSafe(): Promise<number> {
    try {
      return await this.syncEngine.resolveSubagentLinks();
    } catch {
      return 0; // resolution must never break a sync path
    }
  }

  async getOverview(): Promise<Overview> {
    const detected = await this.adapters.detectAll();
    const sources: SourceStatus[] = PRIMARY_PLATFORMS.map(platform => {
      const result = detected.get(platform);
      return {
        platform,
        label: SOURCE_LABELS[platform],
        enabled: this.enabledPlatforms.has(platform),
        installed: result?.installed ?? false,
        version: result?.version,
        installPath: result?.installPath,
        sessionCount: result?.sessionCount ?? 0,
      };
    });
    const stats = this.db.getStats();
    return {
      sources,
      sessions: this.getSessions(80),
      totals: {
        conversations: stats.totalConversations,
        messages: stats.totalMessages,
        inputTokens: stats.totalInputTokens,
        outputTokens: stats.totalOutputTokens,
        storageSize: stats.storageSize,
      },
      analytics: {
        cacheTokens: stats.totalCacheTokens,
        platformBreakdown: stats.platformBreakdown,
        platformTokenBreakdown: stats.platformTokenBreakdown,
        modelBreakdown: stats.modelBreakdown,
        modelTokenBreakdown: stats.modelTokenBreakdown,
        dailyActivity: stats.dailyActivity,
        dailyTokenUsage: stats.dailyTokenUsage,
        topProjects: stats.topProjects,
        toolCategoryBreakdown: stats.toolCategoryBreakdown ?? {},
      },
      watching: this.watching,
      syncing: this.syncing,
    };
  }

  getSessions(limit = 200): SessionSummary[] {
    // A1: folded subagent runs never surface as standalone "recent
    // conversations" — they live under their parent in the tree view.
    const subagentIds = this.db.getSubagentChildIds();
    return (this.db.listWorkSessions({ sessionType: 'conversation', limit: limit + subagentIds.size }) as SessionSummary[])
      .filter(session => !subagentIds.has(session.id))
      .slice(0, limit);
  }

  /** A1 progressive disclosure: compact briefs of a session's subagent runs
   * (role, title, one-liner) for downstream context assembly. */
  getSubagentBriefs(sessionId: string): Array<{
    childSessionId: string;
    agentRole: string | null;
    title: string;
    messageCount: number;
    oneLiner: string | null;
  }> {
    return this.db.getSubagentBriefs(sessionId);
  }

  getSession(id: string): SessionDetail | null {
    const session = this.db.getWorkSession(id);
    if (!session) return null;
    return {
      session: session as SessionSummary,
      messages: this.db.getSessionMessages(id),
    };
  }

  /**
   * Incremental snapshot of captured conversations in VESTI-dashboard format.
   * Every session is rebuilt and fingerprinted here in main, but only bundles
   * whose fingerprint moved since the previous export cross IPC (the first
   * export after process start is a full snapshot). `sessionIds` always lists
   * every current session's durable id so the renderer can reconcile upstream
   * deletions without receiving unchanged payloads. The renderer mirror
   * upserts idempotently because numeric IDs are stable hashes of the CLI
   * session/message IDs.
   */
  exportConversations(): ConversationExportResult {
    const { all, sessionIds } = this.buildConversationBundles();
    const seenIds = new Set<string>(sessionIds);
    const bundles: ConversationExportBundle[] = [];
    for (const bundle of all) {
      const sessionId = bundle.conversation._cli_id;
      const fingerprint = computeBundleFingerprint(bundle.conversation, bundle.messages);
      if (this.exportFingerprints.get(sessionId) !== fingerprint) {
        this.exportFingerprints.set(sessionId, fingerprint);
        bundles.push(bundle);
      }
    }
    // Sessions deleted upstream leave the running list; drop their cache
    // entries so a same-id session created later exports in full again.
    for (const cachedId of [...this.exportFingerprints.keys()]) {
      if (!seenIds.has(cachedId)) this.exportFingerprints.delete(cachedId);
    }
    return { bundles, sessionIds };
  }

  /**
   * Full bundle snapshot with no incremental filtering. The data-contribution
   * uploader (contributionService) tracks its own persisted fingerprints, so
   * it must neither disturb nor depend on the process-lifetime export cache
   * that exportConversations uses to keep unchanged sessions off IPC.
   */
  exportAllConversationBundles(): ConversationExportBundle[] {
    return this.buildConversationBundles().all;
  }

  /** Rebuilds every captured session as a VESTI-dashboard export bundle. */
  private buildConversationBundles(): { all: ConversationExportBundle[]; sessionIds: string[] } {
    const sessions = this.db.listWorkSessions({ sessionType: 'conversation', limit: 10000 });
    // A1: stamp subagent lineage on the export so renderer-side consumers
    // (library list, learn/explore modules, classification, coverage) can
    // fold child runs under their parent without loading the tree.
    const lineage = this.db.getSubagentLineageByChild();
    const all: ConversationExportBundle[] = [];
    const sessionIds: string[] = [];
    for (const session of sessions) {
      sessionIds.push(session.id);
      const messages = this.db.getSessionMessages(session.id);
      const projection = projectSessionTurnsToVesti(
        messages,
        cliIdToNumeric(session.id),
        session.platform,
      );
      const conversation = workSessionToVestiConversation(
        session,
        firstVisibleUserSnippet(messages, 200, session.platform),
        {
          messageCount: projection.messages.length,
          turnCount: projection.turnCount,
        },
      );
      const link = lineage.get(session.id);
      if (link) {
        conversation._subagent_of = link.parentSessionId;
        if (link.agentRole) conversation._agent_role = link.agentRole;
      }
      all.push({
        conversation,
        messages: projection.messages,
      });
    }
    return { all, sessionIds };
  }

  // ---- P1.5: digest store surface + conversation tree + session recall ----

  listSessionsNeedingDigest(digestVersion: number): Array<{ id: string; messageCount: number }> {
    return this.db.listSessionsNeedingDigest(digestVersion);
  }

  getSessionDigest(sessionId: string): SessionDigest | null {
    return this.db.getSessionDigest(sessionId);
  }

  listDegradedDigestCandidates(): SessionDigest[] {
    return this.db.listDegradedDigestCandidates();
  }

  getSessionDigestStats(): SessionDigestStats {
    return this.db.getSessionDigestStats();
  }

  upsertSessionDigest(digest: SessionDigest): void {
    this.db.upsertSessionDigest(digest);
    this.dataEpoch += 1;
  }

  listEmbeddableSessionDigests(): SessionDigest[] {
    return this.db.listEmbeddableSessionDigests();
  }

  getEmbeddingIndexState(): {
    activeVersion: string | null;
    revision: number;
    promotedAt: string | null;
  } {
    return this.db.getEmbeddingIndexState();
  }

  listDigestEmbeddingSessionIds(indexVersion: string): string[] {
    return this.db.listDigestEmbeddingSessionIds(indexVersion);
  }

  listThinkingMapEmbeddings(
    indexVersion: string,
    sessionIds: string[],
  ): Array<{ sessionId: string; dimensions: number; embedding: Buffer }> {
    return this.db.listThinkingMapEmbeddings(indexVersion, sessionIds);
  }

  upsertDigestEmbedding(input: {
    sessionId: string;
    provider: string;
    model: string;
    dimensions: number;
    indexVersion: string;
    embedding: Buffer;
    createdAt: string;
  }): void {
    this.db.upsertDigestEmbedding(input);
    this.dataEpoch += 1;
  }

  promoteEmbeddingIndex(indexVersion: string): void {
    this.db.promoteEmbeddingIndex(indexVersion);
    this.dataEpoch += 1;
  }

  getConversationTree(): ConversationTree {
    return this.db.buildConversationTree();
  }

  recallSessions(
    query: string,
    topK: number,
    queryVector: Float32Array | null,
    queryEmbeddingVersion?: string | null,
  ): SessionRecallHit[] {
    return this.db.recallSessions(query, { topK, queryVector, queryEmbeddingVersion });
  }

  // ---- Memory v2: fork lineage + L0 project_state + L2 project_briefs ----

  refreshForkLineage(): number {
    return this.db.refreshForkLineage();
  }

  rebuildProjectStates(): number {
    return this.db.rebuildProjectStates();
  }

  listProjectStates(): ProjectState[] {
    return this.db.listProjectStates();
  }

  getProjectState(projectKey: string): ProjectState | null {
    return this.db.getProjectState(projectKey);
  }

  getProjectBrief(projectKey: string): ProjectBrief | null {
    return this.db.getProjectBrief(projectKey);
  }

  upsertProjectBrief(brief: ProjectBrief): void {
    this.db.upsertProjectBrief(brief);
  }

  listSessionDigestsForProject(projectKey: string): SessionDigest[] {
    return this.db.listSessionDigestsForProject(projectKey);
  }

  projectLabel(projectKey: string): string {
    return this.db.getProjectLabel(projectKey) || projectKey;
  }

  getFileTimeline(query: { projectKey?: string; filePath: string; limit?: number }): FileTimelineEvent[] {
    return this.db.getFileTimeline(query);
  }

  // ---- 记忆空间 (memory_entries, v14): renderer bridge surface ----

  upsertMemoryEntry(entry: MemoryEntry): void {
    this.db.upsertMemoryEntry(entry);
  }

  getMemoryEntry(id: string): MemoryEntry | null {
    return this.db.getMemoryEntry(id);
  }

  /** Batch variant of getMemoryEntry: misses are dropped, order preserved. */
  getMemoryEntries(ids: string[]): MemoryEntry[] {
    return ids.flatMap(id => {
      const entry = this.db.getMemoryEntry(id);
      return entry ? [entry] : [];
    });
  }

  /** Bulk upsert for the one-shot Dexie deposit migration (keeps timestamps). */
  importMemoryEntries(entries: MemoryEntry[]): number {
    for (const entry of entries) this.db.upsertMemoryEntry(entry);
    return entries.length;
  }

  listMemoryEntries(opts?: { kind?: string; status?: string; limit?: number; offset?: number }): MemoryEntry[] {
    return this.db.listMemoryEntries(opts);
  }

  searchMemoryEntries(query: string, limit: number): MemoryEntry[] {
    return this.db.searchMemoryEntries(query, limit);
  }

  deleteMemoryEntry(id: string): void {
    this.db.deleteMemoryEntry(id);
  }

  getMemoryMeta(key: string): string | null {
    return this.db.getMemoryMeta(key);
  }

  setMemoryMeta(key: string, value: string): void {
    this.db.setMemoryMeta(key, value);
  }

  /**
   * P4a relay v2: per-session git fields (work_sessions) plus the full digest
   * (session_digests.open_questions never reaches the conversation tree, so
   * the relay pipeline reads it straight from the store).
   */
  getRelaySessionContexts(sessionIds: string[]): RelaySessionContext[] {
    const unique = [...new Set(sessionIds)];
    return unique.map((id) => {
      const session = this.db.getWorkSession(id);
      const digest = session ? this.db.getSessionDigest(id) : null;
      return {
        sessionId: id,
        gitBranch: session?.gitBranch ?? null,
        gitRemote: session?.gitRemote ?? null,
        digest: digest
          ? {
              oneLiner: digest.oneLiner || null,
              keyTopics: digest.keyTopics,
              keyFiles: digest.keyFiles,
              decisions: digest.decisions,
              openQuestions: digest.openQuestions,
            }
          : null,
      };
    });
  }

  /**
   * P4a relay quality: raw file-tool touch rows for the deterministic
   * key-file extraction (aggregated renderer-side into anchored lists).
   */
  getRelayFileTouches(sessionIds: string[]): RelayFileTouchRow[] {
    return this.db.listFileToolTouches(sessionIds);
  }

  async syncAll(): Promise<SyncSummary> {
    if (this.syncing) return { sessions: 0, messages: 0, tools: 0, errors: [] };
    this.syncing = true;
    this.notify?.();
    try {
      const files = await this.adapters.getAllSessionFiles();
      const byPlatform = new Map<CapturePlatform, string[]>();
      for (const { platform, filePath } of files) {
        const supported = platform as CapturePlatform;
        if (!this.enabledPlatforms.has(supported)) continue;
        const platformFiles = byPlatform.get(supported) ?? [];
        platformFiles.push(filePath);
        byPlatform.set(supported, platformFiles);
      }
      const results: SyncResult[] = [];
      for (const platform of PRIMARY_PLATFORMS) {
        const platformFiles = byPlatform.get(platform);
        if (!platformFiles?.length) continue;
        const result = await this.syncEngine.syncPlatform(platform, platformFiles);
        results.push(result);
        // A full scan is intentionally sequential. Publish each completed
        // platform instead of holding the first platform's fresh totals until
        // every other source has finished. This matters most on startup: the
        // active Codex session can contain most of the user's token history,
        // while Cursor/Claude scans may continue for several more seconds.
        if (result.sessionsProcessed > 0) this.notify?.();
      }
      const linksResolved = await this.resolveSubagentLinksSafe();
      if (linksResolved > 0) this.notify?.();
      const summary = this.summarize(results);
      if (summary.sessions > 0 || summary.messages > 0) this.syncCompleted?.();
      return summary;
    } finally {
      this.syncing = false;
      this.notify?.();
    }
  }

  async setWatching(enabled: boolean): Promise<boolean> {
    if (enabled === this.watching) return this.watching;
    if (!enabled) {
      await this.adapters.stopWatching();
      this.stopWslPolling();
      this.watching = false;
      this.notify?.();
      return false;
    }

    await this.adapters.startWatching((platform, filePath) => {
      if (!this.enabledPlatforms.has(platform as CapturePlatform)) return;
      const key = `${platform}:${filePath}`;
      const previous = this.fileQueue.get(key) ?? Promise.resolve();
      const next = previous
        .catch(() => undefined)
        .then(async () => {
          const stored = await this.syncEngine.syncFile(platform, filePath);
          if (stored) {
            await this.resolveSubagentLinksSafe();
            this.syncCompleted?.();
            this.noteWatchActivity(platform as CapturePlatform);
            // Only a real store justifies the renderer's full reload chain;
            // digest-only/no-change ticks must stay silent.
            this.notify?.();
          }
        })
        .finally(() => {
          if (this.fileQueue.get(key) === next) this.fileQueue.delete(key);
        });
      this.fileQueue.set(key, next);
    });
    this.startWslPolling();
    this.watching = true;
    this.notify?.();
    return true;
  }

  setEnabledPlatforms(platforms: CapturePlatform[]): void {
    this.enabledPlatforms = new Set(platforms.filter(platform => PRIMARY_PLATFORMS.includes(platform)));
    this.notify?.();
  }

  /** Cheap synchronous state for the floating capsule's status display. */
  getCaptureState(): { watching: boolean; syncing: boolean; conversationCount: number } {
    return {
      watching: this.watching,
      syncing: this.syncing,
      conversationCount: this.db.getStats().totalConversations,
    };
  }

  async close(): Promise<void> {
    await this.adapters.stopWatching();
    this.stopWslPolling();
    if (this.agentActivityTimer) {
      clearInterval(this.agentActivityTimer);
      this.agentActivityTimer = null;
    }
    await Promise.allSettled(this.fileQueue.values());
    await this.db.close();
  }

  private summarize(results: SyncResult[]): SyncSummary {
    return results.reduce<SyncSummary>((total, result) => ({
      sessions: total.sessions + result.sessionsProcessed,
      messages: total.messages + result.messagesStored,
      tools: total.tools + result.toolExecutionsStored,
      errors: [...total.errors, ...result.errors],
    }), { sessions: 0, messages: 0, tools: 0, errors: [] });
  }
}
