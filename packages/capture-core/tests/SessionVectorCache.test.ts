/**
 * Session Vector Snapshot Cache Tests
 * The vector recall path (rankVectorHits) is backed by a per-handle snapshot
 * cache with an aggregate invalidation probe. These tests pin:
 * - bit-exact equivalence with the pre-optimization brute-force algorithm
 *   (scalar BLOB decode + per-pair cosine + full sort), including order;
 * - cache reuse vs rebuild accounting (vectorSnapshotStats);
 * - invalidation on insert / delete / in-place replace (the replace case is
 *   why the fingerprint carries the embedding_index_state revision: the
 *   shipped writers upsert ON CONFLICT DO UPDATE, keeping the rowid stable);
 * - the snapshot row cap (uncached direct scan above it);
 * - the legacy (session_digests.embedding) path.
 */

import os from 'os';
import path from 'path';
import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseManager } from '../src/storage/DatabaseManager.js';
import { serializeVector } from '../src/search/VectorSearch.js';
import {
  probeVectorIndexFingerprint,
  vectorSnapshotStats,
} from '../src/search/SessionRecall.js';
import type { SessionDigest } from '../src/types/unified.js';
import type { WorkSession } from '../src/types/unified.js';

type Database = import('better-sqlite3').Database;

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  delete process.env.VESTI_RECALL_SNAPSHOT_MAX_ROWS;
  await Promise.all(tempDirs.splice(0).map(dir => fs.remove(dir)));
});

async function withManager<T>(fn: (manager: DatabaseManager, db: Database) => T | Promise<T>): Promise<T> {
  const dir = await makeTempDir('vesti-vector-cache-');
  const manager = new DatabaseManager(path.join(dir, 'vesti.db'));
  await manager.initialize();
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return await fn(manager, (manager as any).db as Database);
  } finally {
    await manager.close();
  }
}

function makeSession(id: string, title: string): WorkSession {
  return {
    id,
    sessionId: id.split(':')[1],
    platform: 'codex',
    projectPath: 'C:\\work\\alpha',
    title,
    tags: [],
    status: 'active',
    sessionType: 'conversation',
    startedAt: 1000,
    lastActivityAt: 2000,
    durationMs: 0,
    messageCount: 0,
    userInputCount: 0,
    assistantMessageCount: 0,
    thinkingCount: 0,
    toolCallCount: 0,
    codeBlockCount: 0,
    turnCount: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheCreationTokens: 0,
    totalCacheReadTokens: 0,
    hasSubagents: false,
    hasContextCompaction: false,
    createdAt: 1000,
    updatedAt: 2000,
  };
}

const INDEX_VERSION = 'v:test:16';
const UPDATED_AT = new Date(2000).toISOString();

function makeDigest(sessionId: string, embedding: Buffer | null, version: string | null = INDEX_VERSION): SessionDigest {
  return {
    sessionId,
    host: 'native',
    platform: 'codex',
    projectKey: 'cli_test',
    oneLiner: `digest for ${sessionId}`,
    keyTopics: [],
    keyFiles: [],
    decisions: [],
    openQuestions: [],
    embedding: embedding ?? undefined,
    embeddingProvider: version ? 'test' : undefined,
    embeddingModel: version ? 'test-model' : undefined,
    embeddingDimensions: embedding ? Math.floor(embedding.byteLength / 4) : undefined,
    embeddingVersion: version ?? undefined,
    embeddingStatus: embedding ? 'ok' : 'none',
    digestVersion: 1,
    messageCount: 0,
    updatedAt: UPDATED_AT,
  };
}

/** Deterministic PRNG so equivalence data is reproducible. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomVector(rand: () => number, dimensions: number): Float32Array {
  const vector = new Float32Array(dimensions);
  for (let i = 0; i < dimensions; i += 1) {
    vector[i] = rand() * 2 - 1;
  }
  return vector;
}

// ---------------------------------------------------------------------------
// Reference: the exact pre-optimization rankVectorHits algorithm.
// ---------------------------------------------------------------------------

function referenceCosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}`);
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function referenceDeserialize(buffer: Buffer): Float32Array {
  if (buffer.byteLength % 4 !== 0) {
    throw new Error(`Invalid vector blob: ${buffer.byteLength} bytes is not a multiple of 4`);
  }
  const vector = new Float32Array(buffer.byteLength / 4);
  for (let i = 0; i < vector.length; i += 1) {
    vector[i] = buffer.readFloatLE(i * 4);
  }
  return vector;
}

function referenceVectorRank(
  db: Database,
  queryVector: Float32Array,
  limit: number,
  embeddingVersion?: string | null,
): string[] {
  const rows = embeddingVersion
    ? db.prepare(`
        SELECT session_id, embedding FROM session_digest_embeddings
        WHERE index_version = ? AND dimensions = ?
      `).all(embeddingVersion, queryVector.length) as Array<{ session_id: string; embedding: Buffer }>
    : db.prepare(`
        SELECT session_id, embedding FROM session_digests
        WHERE embedding_status = 'ok' AND embedding IS NOT NULL
      `).all() as Array<{ session_id: string; embedding: Buffer }>;
  const candidates = rows.flatMap(row => {
    try {
      return [{ id: row.session_id, vector: referenceDeserialize(row.embedding) }];
    } catch {
      return [];
    }
  });
  return candidates
    .map(candidate => ({ id: candidate.id, score: referenceCosineSimilarity(queryVector, candidate.vector) }))
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, limit)
    .map(match => match.id);
}

/**
 * Recall driven by the vector list only: the 2-char query token is inert
 * under the trigram tokenizer, so the FTS lists stay empty. All sessions
 * share lastActivityAt (or have no work_sessions row), so recency scaling is
 * uniform and the hit order equals the vector rank order.
 */
function recallVectorOnly(
  manager: DatabaseManager,
  queryVector: Float32Array,
  options: { topK?: number; version?: string | null; vectorSnapshotMaxRows?: number } = {},
): string[] {
  return manager.recallSessions('vv', {
    topK: options.topK ?? 10,
    queryVector,
    queryEmbeddingVersion: options.version === undefined ? INDEX_VERSION : options.version,
    ...(options.vectorSnapshotMaxRows !== undefined
      ? { vectorSnapshotMaxRows: options.vectorSnapshotMaxRows }
      : {}),
  }).map(hit => hit.sessionId);
}

function statsSnapshot(): typeof vectorSnapshotStats {
  return { ...vectorSnapshotStats };
}

/** Fingerprint with the monotone revision term stripped (compares c|m|s). */
function stripRevision(fingerprint: string | null): string | undefined {
  return fingerprint?.replace(/\|r\d+$/, '');
}

describe('recallSessions — vector snapshot cache', () => {
  it('matches the brute-force reference exactly, then serves repeats from cache', async () => {
    await withManager(async (manager, db) => {
      const rand = mulberry32(99);
      const dimensions = 16;
      const count = 40;
      for (let index = 0; index < count; index += 1) {
        const sessionId = `codex:s${index}`;
        manager.upsertWorkSession(makeSession(sessionId, `Session ${index}`));
        // s3 gets a zero-norm embedding (scores 0 in both implementations).
        const vector = index === 3 ? new Float32Array(dimensions) : randomVector(rand, dimensions);
        manager.upsertSessionDigest(makeDigest(sessionId, serializeVector(vector)));
      }
      // A malformed BLOB (not a multiple of 4 bytes) is skipped by both paths.
      manager.upsertSessionDigest(makeDigest('codex:broken', null));
      db.prepare(`
        INSERT INTO session_digest_embeddings (
          session_id, provider, model, dimensions, index_version, embedding, created_at
        ) VALUES (?, 'test', 'test-model', ?, ?, ?, ?)
      `).run('codex:broken', dimensions, INDEX_VERSION, Buffer.alloc(6), UPDATED_AT);

      const queryVector = randomVector(rand, dimensions);
      const expected = referenceVectorRank(db, queryVector, 30, INDEX_VERSION).slice(0, 10);

      const before = statsSnapshot();
      const first = recallVectorOnly(manager, queryVector);
      expect(first).toEqual(expected);
      expect(first.length).toBeGreaterThan(5);
      expect(vectorSnapshotStats.builds).toBe(before.builds + 1);
      expect(vectorSnapshotStats.hits).toBe(before.hits);

      const second = recallVectorOnly(manager, queryVector);
      expect(second).toEqual(first);
      expect(vectorSnapshotStats.builds).toBe(before.builds + 1);
      expect(vectorSnapshotStats.hits).toBe(before.hits + 1);
    });
  });

  it('reflects inserts, deletes and in-place replacements', async () => {
    await withManager(async (manager, db) => {
      const rand = mulberry32(5);
      const dimensions = 16;
      const queryVector = randomVector(rand, dimensions);
      for (let index = 0; index < 6; index += 1) {
        manager.upsertSessionDigest(
          makeDigest(`codex:s${index}`, serializeVector(randomVector(rand, dimensions))),
        );
      }

      const baseline = recallVectorOnly(manager, queryVector);
      expect(baseline).toHaveLength(6);

      // Insert: a vector equal to the query must take rank 1 immediately.
      manager.upsertSessionDigest(makeDigest('codex:late', serializeVector(queryVector)));
      const afterInsert = recallVectorOnly(manager, queryVector);
      expect(afterInsert[0]).toBe('codex:late');
      expect(afterInsert).toHaveLength(7);

      // Delete: raw SQL removal is picked up by the count/sum probe terms.
      db.prepare('DELETE FROM session_digest_embeddings WHERE session_id = ?').run('codex:late');
      const afterDelete = recallVectorOnly(manager, queryVector);
      expect(afterDelete).toEqual(baseline);

      // Replace in place: upsertSessionDigest writes ON CONFLICT DO UPDATE,
      // so the rowid (and the COUNT/MAX/SUM probe terms) stay unchanged —
      // only the embedding_index_state revision exposes the new vector.
      const target = baseline[baseline.length - 1];
      const rowidBefore = (db.prepare(
        'SELECT rowid FROM session_digest_embeddings WHERE session_id = ? AND index_version = ?',
      ).get(target, INDEX_VERSION) as { rowid: number }).rowid;
      const probeBefore = probeVectorIndexFingerprint(db, INDEX_VERSION, dimensions);
      manager.upsertSessionDigest(makeDigest(target, serializeVector(queryVector)));
      const rowidAfter = (db.prepare(
        'SELECT rowid FROM session_digest_embeddings WHERE session_id = ? AND index_version = ?',
      ).get(target, INDEX_VERSION) as { rowid: number }).rowid;
      expect(rowidAfter).toBe(rowidBefore);
      expect(probeVectorIndexFingerprint(db, INDEX_VERSION, dimensions)).not.toBe(probeBefore);
      expect(stripRevision(probeVectorIndexFingerprint(db, INDEX_VERSION, dimensions)))
        .toBe(stripRevision(probeBefore)); // c|m|s unchanged, only the revision moved
      const afterReplace = recallVectorOnly(manager, queryVector);
      expect(afterReplace[0]).toBe(target);
    });
  });

  it('isolates snapshots per database handle and per index version', async () => {
    const rand = mulberry32(11);
    const dimensions = 16;
    const queryVector = randomVector(rand, dimensions);
    await withManager(async (firstManager) => {
      for (let index = 0; index < 4; index += 1) {
        firstManager.upsertSessionDigest(
          makeDigest(`codex:s${index}`, serializeVector(randomVector(rand, dimensions))),
        );
      }
      const before = statsSnapshot();
      recallVectorOnly(firstManager, queryVector);
      recallVectorOnly(firstManager, queryVector);
      expect(vectorSnapshotStats.builds).toBe(before.builds + 1);

      // Same handle, different index version: a separate cache entry.
      recallVectorOnly(firstManager, queryVector, { version: 'v:other:16' });
      expect(vectorSnapshotStats.builds).toBe(before.builds + 2);

      await withManager(async (secondManager) => {
        for (let index = 0; index < 4; index += 1) {
          secondManager.upsertSessionDigest(
            makeDigest(`codex:s${index}`, serializeVector(randomVector(rand, dimensions))),
          );
        }
        // A different handle (different data directory) builds its own
        // snapshot instead of reusing the first database's.
        recallVectorOnly(secondManager, queryVector);
        expect(vectorSnapshotStats.builds).toBe(before.builds + 3);
      });
    });
  });

  it('honours the snapshot row cap with a semantics-preserving direct scan', async () => {
    await withManager(async (manager, db) => {
      const rand = mulberry32(21);
      const dimensions = 16;
      const queryVector = randomVector(rand, dimensions);
      for (let index = 0; index < 5; index += 1) {
        manager.upsertSessionDigest(
          makeDigest(`codex:s${index}`, serializeVector(randomVector(rand, dimensions))),
        );
      }
      const expected = referenceVectorRank(db, queryVector, 30, INDEX_VERSION).slice(0, 10);

      const before = statsSnapshot();
      // 5 rows > cap 2: no snapshot is built, but results are unchanged.
      expect(recallVectorOnly(manager, queryVector, { vectorSnapshotMaxRows: 2 })).toEqual(expected);
      expect(vectorSnapshotStats.builds).toBe(before.builds);
      expect(vectorSnapshotStats.directScans).toBe(before.directScans + 1);
      // The environment variable overrides the default cap the same way.
      process.env.VESTI_RECALL_SNAPSHOT_MAX_ROWS = '2';
      expect(recallVectorOnly(manager, queryVector)).toEqual(expected);
      expect(vectorSnapshotStats.directScans).toBe(before.directScans + 2);
      delete process.env.VESTI_RECALL_SNAPSHOT_MAX_ROWS;
      // Under the default cap the snapshot is built and then reused.
      expect(recallVectorOnly(manager, queryVector)).toEqual(expected);
      expect(vectorSnapshotStats.builds).toBe(before.builds + 1);
      expect(recallVectorOnly(manager, queryVector)).toEqual(expected);
      expect(vectorSnapshotStats.hits).toBe(before.hits + 1);
    });
  });

  it('matches the reference on the legacy path and invalidates on digest writes', async () => {
    await withManager(async (manager, db) => {
      const rand = mulberry32(31);
      const dimensions = 16;
      const queryVector = randomVector(rand, dimensions);
      // Post-migration-9 shape: legacy rows carry an explicit legacy version.
      const legacyVersion = `legacy:unknown:${dimensions}`;
      for (let index = 0; index < 8; index += 1) {
        manager.upsertSessionDigest(
          makeDigest(`codex:l${index}`, serializeVector(randomVector(rand, dimensions)), legacyVersion),
        );
      }

      const expected = referenceVectorRank(db, queryVector, 30, null).slice(0, 10);
      const before = statsSnapshot();
      const first = recallVectorOnly(manager, queryVector, { version: null });
      expect(first).toEqual(expected);
      expect(vectorSnapshotStats.builds).toBe(before.builds + 1);
      expect(recallVectorOnly(manager, queryVector, { version: null })).toEqual(first);
      expect(vectorSnapshotStats.hits).toBe(before.hits + 1);

      // A digest rewrite (embedding upsert bumps the index revision) is seen.
      manager.upsertSessionDigest(makeDigest('codex:l7', serializeVector(queryVector), legacyVersion));
      const afterReplace = recallVectorOnly(manager, queryVector, { version: null });
      expect(afterReplace[0]).toBe('codex:l7');
      expect(vectorSnapshotStats.builds).toBe(before.builds + 2);
    });
  });

  it('keeps double-precision norms: near-tie ordering matches the reference exactly', async () => {
    await withManager(async (manager, db) => {
      // v2's squared norm is 1 + ~1e-8 — indistinguishable from 1.0 in
      // float32, so a float32 norm cache would tie the scores and flip the
      // order to id-ascending ('aaa' first). The double-precision reference
      // ranks 'zzz' strictly first; the snapshot must reproduce that.
      const queryVector = new Float32Array([1, 0]);
      manager.upsertSessionDigest(makeDigest('zzz', serializeVector(new Float32Array([1, 0]))));
      manager.upsertSessionDigest(makeDigest('aaa', serializeVector(new Float32Array([1, 1e-4]))));

      const expected = referenceVectorRank(db, queryVector, 30, INDEX_VERSION);
      expect(expected).toEqual(['zzz', 'aaa']);
      // First call builds the snapshot; second serves it from cache — both
      // must preserve the double-precision ordering.
      expect(recallVectorOnly(manager, queryVector, { topK: 2 })).toEqual(expected);
      expect(recallVectorOnly(manager, queryVector, { topK: 2 })).toEqual(expected);
    });
  });

  it('preserves the dimension-mismatch throw on inconsistent rows', async () => {
    await withManager(async (manager, db) => {
      manager.upsertSessionDigest(
        makeDigest('codex:d4', serializeVector(new Float32Array([1, 0, 0, 0])), 'legacy:unknown:4'),
      );
      manager.upsertSessionDigest(
        makeDigest('codex:d8', serializeVector(new Float32Array([1, 0, 0, 0, 0, 0, 0, 0])), 'legacy:unknown:8'),
      );
      // Legacy path: mixed-dimension rows reach cosine scoring and throw,
      // exactly as the pre-optimization implementation did.
      expect(() => recallVectorOnly(manager, new Float32Array([1, 0, 0, 0]), { version: null }))
        .toThrow(/dimension mismatch/);

      // Versioned path: the dimensions column claims 4 but the BLOB holds 8
      // floats — the same throw surfaces from the cached snapshot scoring.
      manager.upsertSessionDigest(makeDigest('codex:corrupt', null));
      db.prepare(`
        INSERT INTO session_digest_embeddings (
          session_id, provider, model, dimensions, index_version, embedding, created_at
        ) VALUES (?, 'test', 'test-model', 4, 'v:corrupt:4', ?, ?)
      `).run('codex:corrupt', serializeVector(new Float32Array(8)), UPDATED_AT);
      expect(() => recallVectorOnly(manager, new Float32Array([1, 0, 0, 0]), { version: 'v:corrupt:4' }))
        .toThrow(/dimension mismatch/);
    });
  });
});

describe('probeVectorIndexFingerprint', () => {
  it('is deterministic and renders empty sets without NULL ambiguity', async () => {
    await withManager(async (_manager, db) => {
      const first = probeVectorIndexFingerprint(db, INDEX_VERSION, 16);
      expect(first).toBe('0|null|null|r0');
      expect(probeVectorIndexFingerprint(db, INDEX_VERSION, 16)).toBe(first);
      expect(probeVectorIndexFingerprint(db, null, 16)).toBe('0|null|null|r0');
    });
  });

  it('changes on insert and delete, per (index_version, dimensions) filter', async () => {
    await withManager(async (manager, db) => {
      const before = probeVectorIndexFingerprint(db, INDEX_VERSION, 16);
      manager.upsertSessionDigest(makeDigest('codex:p1', serializeVector(randomVector(mulberry32(1), 16))));
      const afterInsert = probeVectorIndexFingerprint(db, INDEX_VERSION, 16);
      expect(afterInsert).not.toBe(before);
      // The row is invisible to other filters: their c|m|s terms stay empty.
      // (The revision term is global — any embedding write moves it.)
      expect(stripRevision(probeVectorIndexFingerprint(db, 'v:other:16', 16))).toBe('0|null|null');
      expect(stripRevision(probeVectorIndexFingerprint(db, INDEX_VERSION, 32))).toBe('0|null|null');
      db.prepare('DELETE FROM session_digest_embeddings WHERE session_id = ?').run('codex:p1');
      const afterDelete = probeVectorIndexFingerprint(db, INDEX_VERSION, 16);
      expect(afterDelete).not.toBe(afterInsert);
      // count/max/sum are restored; the revision is monotone and never returns.
      expect(stripRevision(afterDelete)).toBe(stripRevision(before));
    });
  });

  it('exposes in-place BLOB replacement only through the revision term', async () => {
    await withManager(async (manager, db) => {
      manager.upsertSessionDigest(makeDigest('codex:p1', serializeVector(new Float32Array(16).fill(0.5))));
      const before = probeVectorIndexFingerprint(db, INDEX_VERSION, 16);
      expect(before).not.toBeNull();

      // Production writer: ON CONFLICT DO UPDATE (stable rowid) plus a
      // revision bump in the same transaction → fingerprint changes.
      manager.upsertSessionDigest(makeDigest('codex:p1', serializeVector(new Float32Array(16).fill(0.25))));
      const afterWriter = probeVectorIndexFingerprint(db, INDEX_VERSION, 16);
      expect(afterWriter).not.toBe(before);
      expect(stripRevision(afterWriter)).toBe(stripRevision(before));

      // Raw SQL that bypasses the revision bump is invisible to the probe —
      // documented limitation; every shipped writer goes through the bump.
      db.prepare('UPDATE session_digest_embeddings SET embedding = ? WHERE session_id = ?')
        .run(serializeVector(new Float32Array(16).fill(0.125)), 'codex:p1');
      expect(probeVectorIndexFingerprint(db, INDEX_VERSION, 16)).toBe(afterWriter);
    });
  });
});
