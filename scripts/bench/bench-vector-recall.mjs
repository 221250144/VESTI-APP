/**
 * Bench — vector recall snapshot cache (SessionRecall rankVectorHits).
 *
 * Builds a synthetic database of --rows (default 5000) session digest
 * embeddings at --dims (default 1024) dimensions, then times a single
 * vector-driven recall (candidateLimit 30) three ways:
 *
 *   before : faithful inline replica of the pre-optimization algorithm
 *            (full BLOB scan + per-element readFloatLE decode + per-candidate
 *            cosine incl. ||B|| norms + full Array#sort);
 *   cold   : first recallSessions call — probe miss, snapshot build;
 *   warm   : steady-state recallSessions — probe hit, cached snapshot;
 *   direct : recallSessions forced past the snapshot row cap (uncached
 *            zero-copy scan — the over-cap fallback path).
 *
 * Correctness guard: the id lists of every path must equal the `before`
 * replica's, so the numbers below never trade recall semantics for speed.
 *
 * Run (from VESTI-APP root, after `pnpm core:build`):
 *   node scripts/bench/bench-vector-recall.mjs            (plain node, node-ABI better-sqlite3)
 *   ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe scripts/bench/bench-vector-recall.mjs
 * Options: --rows 5000 --dims 1024 --queries 25
 */
import path from 'node:path';
import fs from 'node:fs';
import {
  CACHE_DIR, ensureDirs, makeRng, parseArgs,
} from './common.mjs';
import { CAPTURE_CORE_DIST } from './common.mjs';

const BetterSqlite3 = (await import('better-sqlite3')).default;
const { DatabaseManager } = await import(CAPTURE_CORE_DIST);

const args = parseArgs(process.argv, { rows: 5000, dims: 1024, queries: 25 });
ensureDirs();

const INDEX_VERSION = `bench:${args.dims}`;
const dbPath = path.join(CACHE_DIR, 'bench-vector-recall.db');
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true });

const manager = new DatabaseManager(dbPath);
await manager.initialize();
// TS-private but a plain property at runtime (same access pattern as tests).
const db = manager.db;

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------
const rng = makeRng(20260911);
function randomVector(dimensions) {
  const vector = new Float32Array(dimensions);
  for (let i = 0; i < dimensions; i += 1) vector[i] = rng() * 2 - 1;
  return vector;
}
function serialize(vector) {
  const buffer = Buffer.alloc(vector.length * 4);
  for (let i = 0; i < vector.length; i += 1) buffer.writeFloatLE(vector[i], i * 4);
  return buffer;
}

console.log(`[bench-vector-recall] seeding ${args.rows} rows × ${args.dims} dims…`);
const seedStart = process.hrtime.bigint();
const insert = db.prepare(`
  INSERT INTO session_digests (
    session_id, host, platform, project_key, one_liner,
    key_topics, key_files, decisions, open_questions,
    embedding, embedding_provider, embedding_model, embedding_dimensions,
    embedding_version, embedding_status, digest_version, message_count, updated_at
  ) VALUES (?, 'native', 'bench', 'bench', 'bench digest', '[]', '[]', '[]', '[]',
            NULL, 'bench', 'bench-model', ?, ?, 'ok', 1, 0, ?)
`);
const insertEmbedding = db.prepare(`
  INSERT INTO session_digest_embeddings (
    session_id, provider, model, dimensions, index_version, embedding, created_at
  ) VALUES (?, 'bench', 'bench-model', ?, ?, ?, ?)
`);
db.transaction(() => {
  for (let index = 0; index < args.rows; index += 1) {
    const sessionId = `bench:s${index}`;
    insert.run(sessionId, args.dims, INDEX_VERSION, new Date(2000 + index).toISOString());
    insertEmbedding.run(sessionId, args.dims, INDEX_VERSION, serialize(randomVector(args.dims)),
      new Date(2000 + index).toISOString());
  }
})();
console.log(`[bench-vector-recall] seeded in ${Number(process.hrtime.bigint() - seedStart) / 1e6 | 0} ms`);

// ---------------------------------------------------------------------------
// "before": exact pre-optimization rankVectorHits replica
// ---------------------------------------------------------------------------
function beforeRank(queryVector, limit) {
  const rows = db.prepare(`
    SELECT session_id, embedding FROM session_digest_embeddings
    WHERE index_version = ? AND dimensions = ?
  `).all(INDEX_VERSION, queryVector.length);
  const candidates = [];
  for (const row of rows) {
    const vector = new Float32Array(row.embedding.byteLength / 4);
    for (let i = 0; i < vector.length; i += 1) vector[i] = row.embedding.readFloatLE(i * 4);
    candidates.push({ id: row.session_id, vector });
  }
  return candidates
    .map(candidate => {
      let dot = 0; let normA = 0; let normB = 0;
      for (let i = 0; i < queryVector.length; i += 1) {
        dot += queryVector[i] * candidate.vector[i];
        normA += queryVector[i] * queryVector[i];
        normB += candidate.vector[i] * candidate.vector[i];
      }
      const score = normA === 0 || normB === 0 ? 0 : dot / (Math.sqrt(normA) * Math.sqrt(normB));
      return { id: candidate.id, score };
    })
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, limit)
    .map(match => match.id);
}

function afterRank(queryVector, topK, extra = {}) {
  // A 2-char query token is inert under trigram, so only the vector list
  // drives the recall; the hit order equals the vector rank order.
  return manager.recallSessions('vv', {
    topK,
    queryVector,
    queryEmbeddingVersion: INDEX_VERSION,
    ...extra,
  }).map(hit => hit.sessionId);
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

const queries = Array.from({ length: args.queries }, () => randomVector(args.dims));

function timeAll(label, fn) {
  const times = [];
  for (const query of queries) {
    const start = process.hrtime.bigint();
    fn(query);
    times.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
  return { label, medianMs: median(times), meanMs: times.reduce((a, b) => a + b, 0) / times.length };
}

// Correctness guard first (also warms the snapshot).
const guardQuery = queries[0];
const expected = beforeRank(guardQuery, 30).slice(0, 5);
const warmIds = afterRank(guardQuery, 5);
const directIds = afterRank(guardQuery, 5, { vectorSnapshotMaxRows: 10 });
if (JSON.stringify(warmIds) !== JSON.stringify(expected)
  || JSON.stringify(directIds) !== JSON.stringify(expected)) {
  console.error('[bench-vector-recall] MISMATCH: optimized paths diverge from the reference');
  console.error({ expected, warmIds, directIds });
  process.exit(1);
}

const results = [];
results.push(timeAll('before (full scan, scalar decode)', query => beforeRank(query, 30)));
results.push(timeAll('warm (cached snapshot)', query => afterRank(query, 5)));
results.push(timeAll('direct scan (over row cap)', query => afterRank(query, 5, { vectorSnapshotMaxRows: 10 })));
// Cold build: measured on a fresh handle so the WeakMap cache is empty.
{
  const coldManager = new DatabaseManager(dbPath);
  await coldManager.initialize();
  const start = process.hrtime.bigint();
  coldManager.recallSessions('vv', { topK: 5, queryVector: queries[0], queryEmbeddingVersion: INDEX_VERSION });
  const coldMs = Number(process.hrtime.bigint() - start) / 1e6;
  await coldManager.close();
  results.push({ label: 'cold (probe miss + snapshot build)', medianMs: coldMs, meanMs: coldMs });
}

const beforeMedian = results[0].medianMs;
console.log(`\n[bench-vector-recall] ${args.rows} rows × ${args.dims} dims, ${args.queries} queries (median / mean ms)`);
for (const row of results) {
  const speedup = row === results[0] ? '' : `  (${(beforeMedian / row.medianMs).toFixed(1)}× vs before)`;
  console.log(`  ${row.label.padEnd(36)} ${row.medianMs.toFixed(2)} / ${row.meanMs.toFixed(2)}${speedup}`);
}

await manager.close();
