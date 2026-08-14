import {
  buildSemanticEdges,
  deserializeVector,
  serializeVector,
  type SessionDigest,
} from '@vesti/capture-core';
import type { ThinkingMapSemanticIpcSnapshot } from '../shared/contracts';
import type { EmbeddingBatchResult } from './embeddingService';

const SMALL_GRAPH_THRESHOLD = 0.4;
const LARGE_GRAPH_THRESHOLD = 0.5;
const LARGE_GRAPH_NODE_COUNT = 600;
const NEIGHBORS_PER_NODE = 6;
const MAX_EDGES = 900;
const MAX_EXACT_VECTORS = 2_000;
const BACKFILL_BATCH_SIZE = 32;
const MAX_ISOLATED_WRITE_FAILURES = 3;
const MAX_ISOLATED_WRITE_FAILURE_RATE = 0.05;
const DEFAULT_RETRY_DELAYS_MS = [30_000, 120_000, 600_000] as const;

export interface ThinkingMapSemanticStore {
  listEmbeddableSessionDigests(): SessionDigest[];
  getEmbeddingIndexState(): {
    activeVersion: string | null;
    revision: number;
    promotedAt: string | null;
  };
  listDigestEmbeddingSessionIds(indexVersion: string): string[];
  listThinkingMapEmbeddings(
    indexVersion: string,
    sessionIds: string[],
  ): Array<{ sessionId: string; dimensions: number; embedding: Buffer }>;
  upsertDigestEmbedding(input: {
    sessionId: string;
    provider: string;
    model: string;
    dimensions: number;
    indexVersion: string;
    embedding: Buffer;
    createdAt: string;
  }): void;
  promoteEmbeddingIndex(indexVersion: string): void;
}

export interface ThinkingMapSemanticEmbedder {
  embedWithMetadata(texts: string[]): Promise<EmbeddingBatchResult>;
  invalidateStatus?(): void;
}

function digestText(digest: SessionDigest): string {
  return [digest.oneLiner, ...digest.keyTopics].join('\n');
}

function emptySnapshot(
  phase: ThinkingMapSemanticIpcSnapshot['phase'],
): ThinkingMapSemanticIpcSnapshot {
  return {
    phase,
    edges: [],
    indexedSessionIds: [],
    activeIndexVersion: null,
  };
}

/**
 * Owns the graph policy and embedding-index lifecycle. Raw vectors stay in
 * the main process; renderer callers receive only session-id edges and state.
 */
export class ThinkingMapSemanticService {
  private running = false;
  private building = false;
  private rerunRequested = false;
  private drainPromise: Promise<void> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryAttempt = 0;
  private cache: {
    key: string;
    value: Promise<ThinkingMapSemanticIpcSnapshot>;
  } | null = null;

  constructor(
    private readonly store: ThinkingMapSemanticStore,
    private readonly embedding: ThinkingMapSemanticEmbedder,
    private readonly retryDelaysMs: readonly number[] = DEFAULT_RETRY_DELAYS_MS,
  ) {}

  start(): void {
    this.running = true;
    this.requestScan();
  }

  stop(): void {
    this.running = false;
    this.rerunRequested = false;
    this.cache = null;
    this.clearRetry();
  }

  requestScan(): void {
    if (!this.running) return;
    this.clearRetry();
    this.retryAttempt = 0;
    this.rerunRequested = true;
    this.kick();
  }

  isBuilding(): boolean {
    return this.building;
  }

  async getSnapshot(
    sessionIds: string[],
    totalConversationCount: number,
  ): Promise<ThinkingMapSemanticIpcSnapshot> {
    const uniqueIds = [...new Set(sessionIds)].sort((left, right) => left.localeCompare(right));
    let state: ReturnType<ThinkingMapSemanticStore['getEmbeddingIndexState']>;
    try {
      state = this.store.getEmbeddingIndexState();
    } catch {
      return emptySnapshot('unavailable');
    }
    if (!state.activeVersion) {
      return emptySnapshot(this.building || this.retryTimer ? 'building' : 'unavailable');
    }

    const key = [
      state.activeVersion,
      state.revision,
      Math.max(0, Math.floor(totalConversationCount)),
      uniqueIds.join('\u001f'),
    ].join('|');
    if (this.cache?.key === key) return this.cache.value;

    const value = this.computeSnapshot(
      state.activeVersion,
      uniqueIds,
      totalConversationCount,
    ).catch(() => {
      if (this.cache?.key === key) this.cache = null;
      return emptySnapshot('unavailable');
    });
    this.cache = { key, value };
    return value;
  }

  private kick(): void {
    if (this.drainPromise) return;
    this.drainPromise = this.drain().finally(() => {
      this.drainPromise = null;
      if (this.running && this.rerunRequested) this.kick();
    });
  }

  private async drain(): Promise<void> {
    while (this.running && this.rerunRequested) {
      this.rerunRequested = false;
      await this.backfillFixedSnapshot();
    }
  }

  private async backfillFixedSnapshot(): Promise<void> {
    this.building = true;
    try {
      const sources = this.store.listEmbeddableSessionDigests();
      if (sources.length === 0) {
        this.retryAttempt = 0;
        this.clearRetry();
        return;
      }
      // The first digest doubles as the route/model probe. Its vector is
      // persisted only when missing from the discovered candidate version.
      const first = sources[0];
      const probe = await this.embedding.embedWithMetadata([digestText(first)]);
      if (!this.running) return;
      const candidateVersion = probe.metadata.version;
      const existing = new Set(this.store.listDigestEmbeddingSessionIds(candidateVersion));
      let writeAttempts = 0;
      let writeFailures = 0;
      if (!existing.has(first.sessionId)) {
        writeAttempts += 1;
        const vector = probe.vectors[0];
        if (!vector) {
          writeFailures += 1;
        } else {
          try {
            this.persistVector(first.sessionId, vector, probe);
            existing.add(first.sessionId);
          } catch {
            writeFailures += 1;
          }
        }
      }

      const missing = sources
        .slice(1)
        .filter(source => !existing.has(source.sessionId));
      for (let start = 0; start < missing.length; start += BACKFILL_BATCH_SIZE) {
        if (!this.running) return;
        const batch = missing.slice(start, start + BACKFILL_BATCH_SIZE);
        const result = await this.embedding.embedWithMetadata(batch.map(digestText));
        if (result.metadata.version !== candidateVersion) {
          throw new Error('embedding candidate version changed during backfill');
        }
        batch.forEach((source, index) => {
          const vector = result.vectors[index];
          writeAttempts += 1;
          if (!vector) {
            writeFailures += 1;
            return;
          }
          // A single SQLite row failure reduces coverage but must not discard
          // an otherwise completed candidate index.
          try {
            this.persistVector(source.sessionId, vector, result);
          } catch {
            writeFailures += 1;
          }
        });
      }

      if (!this.running) return;
      const candidateIds = new Set(
        this.store.listDigestEmbeddingSessionIds(candidateVersion),
      );
      const candidateCoverage = sources.filter(source => candidateIds.has(source.sessionId)).length;
      const allowedWriteFailures = Math.min(
        MAX_ISOLATED_WRITE_FAILURES,
        Math.max(1, Math.floor(sources.length * MAX_ISOLATED_WRITE_FAILURE_RATE)),
      );
      if (
        candidateCoverage === 0
        || (writeAttempts > 0 && writeFailures > allowedWriteFailures)
      ) {
        throw new Error('embedding candidate exceeded isolated row failure budget');
      }
      const active = this.store.getEmbeddingIndexState().activeVersion;
      if (active !== candidateVersion) {
        this.store.promoteEmbeddingIndex(candidateVersion);
      }
      this.retryAttempt = 0;
      this.clearRetry();
      this.cache = null;
    } catch {
      // Systemic endpoint/config failures leave the previous active version
      // untouched. Retry with bounded backoff; startup/settings/sync triggers
      // can request an earlier retry through requestScan().
      this.scheduleRetry();
    } finally {
      this.building = false;
    }
  }

  private persistVector(
    sessionId: string,
    vector: Float32Array,
    result: EmbeddingBatchResult,
  ): void {
    this.store.upsertDigestEmbedding({
      sessionId,
      provider: result.metadata.provider,
      model: result.metadata.model,
      dimensions: result.metadata.dimensions,
      indexVersion: result.metadata.version,
      embedding: serializeVector(vector),
      createdAt: new Date().toISOString(),
    });
  }

  private scheduleRetry(): void {
    if (
      !this.running
      || this.retryTimer
      || this.retryAttempt >= this.retryDelaysMs.length
    ) return;
    const delay = Math.max(0, this.retryDelaysMs[this.retryAttempt]);
    this.retryAttempt += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.running) return;
      this.embedding.invalidateStatus?.();
      this.rerunRequested = true;
      this.kick();
    }, delay);
    this.retryTimer.unref?.();
  }

  private clearRetry(): void {
    if (!this.retryTimer) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private async computeSnapshot(
    activeVersion: string,
    sessionIds: string[],
    totalConversationCount: number,
  ): Promise<ThinkingMapSemanticIpcSnapshot> {
    const rows = this.store.listThinkingMapEmbeddings(activeVersion, sessionIds);
    const vectors = rows.flatMap(row => {
      try {
        const vector = deserializeVector(row.embedding);
        return vector.length === row.dimensions
          ? [{ id: row.sessionId, vector }]
          : [];
      } catch {
        return [];
      }
    });
    const result = await buildSemanticEdges(vectors, {
      threshold: totalConversationCount > LARGE_GRAPH_NODE_COUNT
        ? LARGE_GRAPH_THRESHOLD
        : SMALL_GRAPH_THRESHOLD,
      neighborsPerNode: NEIGHBORS_PER_NODE,
      maxEdges: MAX_EDGES,
      maxVectors: MAX_EXACT_VECTORS,
    });
    return {
      phase: result.status,
      edges: result.edges.map(edge => ({
        sourceSessionId: edge.source,
        targetSessionId: edge.target,
        weight: edge.weight,
      })),
      indexedSessionIds: result.indexedIds,
      activeIndexVersion: activeVersion,
    };
  }
}
