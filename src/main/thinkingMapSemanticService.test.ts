import { describe, expect, it, vi } from 'vitest';
import {
  deserializeVector,
  serializeVector,
  type SessionDigest,
} from '@vesti/capture-core';
import type { EmbeddingBatchResult } from './embeddingService';
import {
  ThinkingMapSemanticService,
  type ThinkingMapSemanticStore,
} from './thinkingMapSemanticService';

function digest(sessionId: string, oneLiner: string): SessionDigest {
  return {
    sessionId,
    host: 'native',
    platform: 'codex',
    projectKey: 'cli_test',
    oneLiner,
    keyTopics: ['test'],
    keyFiles: [],
    decisions: [],
    openQuestions: [],
    embedding: null,
    embeddingStatus: 'skipped',
    digestVersion: 1,
    messageCount: 2,
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function batch(
  vectors: Float32Array[],
  version = 'provider:model:2',
): EmbeddingBatchResult {
  return {
    vectors,
    metadata: {
      provider: 'provider',
      model: 'model',
      dimensions: 2,
      version,
    },
  };
}

class FakeStore implements ThinkingMapSemanticStore {
  sources: SessionDigest[] = [];
  activeVersion: string | null = null;
  revision = 0;
  promotedAt: string | null = null;
  reads = 0;
  failWrites = false;
  private readonly indexes = new Map<
    string,
    Map<string, { dimensions: number; embedding: Buffer }>
  >();

  listEmbeddableSessionDigests(): SessionDigest[] {
    return [...this.sources];
  }

  getEmbeddingIndexState() {
    return {
      activeVersion: this.activeVersion,
      revision: this.revision,
      promotedAt: this.promotedAt,
    };
  }

  listDigestEmbeddingSessionIds(indexVersion: string): string[] {
    return [...(this.indexes.get(indexVersion)?.keys() ?? [])];
  }

  listThinkingMapEmbeddings(indexVersion: string, sessionIds: string[]) {
    this.reads += 1;
    const allowed = new Set(sessionIds);
    return [...(this.indexes.get(indexVersion)?.entries() ?? [])]
      .filter(([sessionId]) => allowed.has(sessionId))
      .map(([sessionId, row]) => ({ sessionId, ...row }));
  }

  upsertDigestEmbedding(input: {
    sessionId: string;
    dimensions: number;
    indexVersion: string;
    embedding: Buffer;
  }): void {
    if (this.failWrites) throw new Error('database is locked');
    const index = this.indexes.get(input.indexVersion) ?? new Map();
    index.set(input.sessionId, {
      dimensions: input.dimensions,
      embedding: input.embedding,
    });
    this.indexes.set(input.indexVersion, index);
    this.revision += 1;
  }

  promoteEmbeddingIndex(indexVersion: string): void {
    this.activeVersion = indexVersion;
    this.promotedAt = '2026-01-01T00:00:00.000Z';
    this.revision += 1;
  }

  seed(indexVersion: string, sessionId: string, vector: Float32Array): void {
    this.upsertDigestEmbedding({
      sessionId,
      dimensions: vector.length,
      indexVersion,
      embedding: serializeVector(vector),
    });
  }

  vector(indexVersion: string, sessionId: string): Float32Array | null {
    const row = this.indexes.get(indexVersion)?.get(sessionId);
    return row ? deserializeVector(row.embedding) : null;
  }
}

describe('ThinkingMapSemanticService', () => {
  it('backfills only missing rows, promotes the candidate, and returns bounded edges', async () => {
    const store = new FakeStore();
    store.sources = [digest('s1', 'alpha'), digest('s2', 'alpha nearby'), digest('s3', 'beta')];
    store.seed('provider:model:2', 's2', new Float32Array([0.9, 0.1]));
    const embedding = {
      embedWithMetadata: vi.fn(async (texts: string[]) =>
        batch(texts.map((text) => text.includes('beta')
          ? new Float32Array([0, 1])
          : new Float32Array([1, 0])))
      ),
    };
    const service = new ThinkingMapSemanticService(store, embedding, [1]);

    service.start();
    await vi.waitFor(() => expect(store.activeVersion).toBe('provider:model:2'));

    expect(embedding.embedWithMetadata).toHaveBeenCalledTimes(2);
    expect(store.vector('provider:model:2', 's1')).not.toBeNull();
    expect(store.vector('provider:model:2', 's2')).not.toBeNull();
    expect(store.vector('provider:model:2', 's3')).not.toBeNull();
    const snapshot = await service.getSnapshot(['s1', 's2', 's3'], 3);
    expect(snapshot.phase).toBe('ready');
    expect(snapshot.activeIndexVersion).toBe('provider:model:2');
    expect(snapshot.indexedSessionIds).toEqual(['s1', 's2', 's3']);
    expect(snapshot.edges).toEqual([
      expect.objectContaining({ sourceSessionId: 's1', targetSessionId: 's2' }),
    ]);
    service.stop();
  });

  it('serves the old active index while a candidate probe is pending', async () => {
    const store = new FakeStore();
    store.sources = [digest('s1', 'alpha'), digest('s2', 'alpha nearby')];
    store.seed('old', 's1', new Float32Array([1, 0]));
    store.seed('old', 's2', new Float32Array([0.9, 0.1]));
    store.activeVersion = 'old';
    let resolveProbe!: (value: EmbeddingBatchResult) => void;
    const probe = new Promise<EmbeddingBatchResult>((resolve) => {
      resolveProbe = resolve;
    });
    const embedding = { embedWithMetadata: vi.fn(() => probe) };
    const service = new ThinkingMapSemanticService(store, embedding, [1]);

    service.start();
    await vi.waitFor(() => expect(service.isBuilding()).toBe(true));
    const duringBuild = await service.getSnapshot(['s1', 's2'], 2);
    expect(duringBuild.phase).toBe('ready');
    expect(duringBuild.activeIndexVersion).toBe('old');

    resolveProbe(batch([new Float32Array([1, 0])], 'new'));
    await vi.waitFor(() => expect(store.activeVersion).toBe('new'));
    service.stop();
  });

  it('automatically retries a systemic failure with bounded backoff', async () => {
    const store = new FakeStore();
    store.sources = [digest('s1', 'alpha')];
    let attempts = 0;
    const embedding = {
      embedWithMetadata: vi.fn(async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('temporary endpoint failure');
        return batch([new Float32Array([1, 0])]);
      }),
      invalidateStatus: vi.fn(),
    };
    const service = new ThinkingMapSemanticService(store, embedding, [1]);

    service.start();
    await vi.waitFor(() => expect(store.activeVersion).toBe('provider:model:2'));
    expect(embedding.embedWithMetadata).toHaveBeenCalledTimes(2);
    expect(embedding.invalidateStatus).toHaveBeenCalledTimes(1);
    service.stop();
  });

  it('does not promote an empty candidate when all vector writes fail', async () => {
    const store = new FakeStore();
    store.seed('old', 's1', new Float32Array([1, 0]));
    store.activeVersion = 'old';
    store.sources = [digest('s1', 'alpha')];
    store.failWrites = true;
    const embedding = {
      embedWithMetadata: vi.fn(async () =>
        batch([new Float32Array([1, 0])], 'new')
      ),
    };
    const service = new ThinkingMapSemanticService(store, embedding, []);

    service.start();
    await vi.waitFor(() => expect(embedding.embedWithMetadata).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(service.isBuilding()).toBe(false));
    expect(store.activeVersion).toBe('old');
    const snapshot = await service.getSnapshot(['s1'], 1);
    expect(snapshot.activeIndexVersion).toBe('old');
    service.stop();
  });

  it('caches snapshots until the embedding-index revision changes', async () => {
    const store = new FakeStore();
    store.seed('active', 's1', new Float32Array([1, 0]));
    store.seed('active', 's2', new Float32Array([0.9, 0.1]));
    store.activeVersion = 'active';
    const service = new ThinkingMapSemanticService(
      store,
      { embedWithMetadata: vi.fn() },
      [],
    );

    await service.getSnapshot(['s1', 's2'], 2);
    await service.getSnapshot(['s2', 's1'], 2);
    expect(store.reads).toBe(1);

    store.revision += 1;
    await service.getSnapshot(['s1', 's2'], 2);
    expect(store.reads).toBe(2);
  });
});
