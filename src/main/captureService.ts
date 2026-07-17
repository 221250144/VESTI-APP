import {
  AdapterManager,
  DatabaseManager,
  SyncEngine,
  VaultManager,
  VestiConfig,
  sessionMessagesToVestiMessages,
  workSessionToVestiConversation,
  type SyncResult,
} from '@vesti/capture-core';
import type {
  CapturePlatform,
  ConversationExportBundle,
  Overview,
  SessionDetail,
  SessionSummary,
  SourceStatus,
  SyncSummary,
} from '../shared/contracts';

const PRIMARY_PLATFORMS: CapturePlatform[] = ['codex', 'cursor', 'kimi-code'];
const SOURCE_LABELS: Record<CapturePlatform, string> = {
  codex: 'Codex',
  cursor: 'Cursor',
  'kimi-code': 'Kimi Code',
  'claude-code': 'Claude Code',
};

export class CaptureService {
  private db!: DatabaseManager;
  private adapters!: AdapterManager;
  private syncEngine!: SyncEngine;
  private watching = false;
  private syncing = false;
  private notify?: () => void;
  private fileQueue = new Map<string, Promise<void>>();
  private basePath = '';
  private enabledPlatforms = new Set<CapturePlatform>(PRIMARY_PLATFORMS);

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
  }

  get activeDataDirectory(): string {
    return this.basePath;
  }

  get isWatching(): boolean {
    return this.watching;
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
      watching: this.watching,
      syncing: this.syncing,
    };
  }

  getSessions(limit = 200): SessionSummary[] {
    return this.db.listWorkSessions({ sessionType: 'conversation', limit }) as SessionSummary[];
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
   * Full snapshot of every captured conversation in VESTI-dashboard format.
   * The renderer mirrors this into its Dexie store; upserts are idempotent
   * because numeric IDs are stable hashes of the CLI session/message IDs.
   */
  exportConversations(): ConversationExportBundle[] {
    const sessions = this.db.listWorkSessions({ sessionType: 'conversation', limit: 10000 });
    return sessions.map(session => {
      const messages = this.db.getSessionMessages(session.id);
      const firstUserMessage = messages.find(message => message.source === 'user_input');
      const conversation = workSessionToVestiConversation(session, firstUserMessage?.contentText?.slice(0, 200));
      return {
        conversation,
        messages: sessionMessagesToVestiMessages(messages, conversation.id),
      };
    });
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
        if (platformFiles?.length) results.push(await this.syncEngine.syncPlatform(platform, platformFiles));
      }
      return this.summarize(results);
    } finally {
      this.syncing = false;
      this.notify?.();
    }
  }

  async setWatching(enabled: boolean): Promise<boolean> {
    if (enabled === this.watching) return this.watching;
    if (!enabled) {
      await this.adapters.stopWatching();
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
          await this.syncEngine.syncFile(platform, filePath);
          this.notify?.();
        })
        .finally(() => {
          if (this.fileQueue.get(key) === next) this.fileQueue.delete(key);
        });
      this.fileQueue.set(key, next);
    });
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
