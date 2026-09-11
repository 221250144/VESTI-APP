/**
 * Vector Search
 * Brute-force cosine similarity over Float32Array embeddings, plus
 * Buffer <-> Float32Array (little-endian) serialization for SQLite BLOB
 * storage. Pure functions with no database access; callers decide where
 * vectors are stored and how candidates are loaded.
 */

export interface VectorCandidate {
  id: string;
  vector: Float32Array;
}

export interface VectorMatch {
  id: string;
  score: number;
}

/** Serialize a Float32Array to a little-endian Buffer for BLOB storage. */
export function serializeVector(vector: Float32Array): Buffer {
  const buffer = Buffer.alloc(vector.length * 4);
  for (let i = 0; i < vector.length; i += 1) {
    buffer.writeFloatLE(vector[i], i * 4);
  }
  return buffer;
}

/** Scalar little-endian decode; the bit-exact reference every fast path must match. */
function deserializeVectorScalar(buffer: Buffer): Float32Array {
  const vector = new Float32Array(buffer.byteLength / 4);
  for (let i = 0; i < vector.length; i += 1) {
    vector[i] = buffer.readFloatLE(i * 4);
  }
  return vector;
}

/**
 * Inverse of serializeVector. Throws on buffers not aligned to 4 bytes.
 * Zero-copy when the backing store offset is 4-byte aligned (a Float32Array
 * view reinterprets the same bytes with platform endianness — little-endian
 * on every supported target, so the result is bit-identical to the scalar
 * readFloatLE loop). Unaligned slices of a pooled Buffer get one memcpy into
 * an aligned scratch buffer first; the scalar loop remains as the fallback
 * for buffers without an ArrayBuffer backing store.
 */
export function deserializeVector(buffer: Buffer): Float32Array {
  if (buffer.byteLength % 4 !== 0) {
    throw new Error(`Invalid vector blob: ${buffer.byteLength} bytes is not a multiple of 4`);
  }
  if (buffer.buffer instanceof ArrayBuffer) {
    if (buffer.byteOffset % 4 === 0) {
      return new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
    }
    const copy = new Uint8Array(buffer.byteLength);
    copy.set(buffer);
    return new Float32Array(copy.buffer, 0, buffer.byteLength / 4);
  }
  return deserializeVectorScalar(buffer);
}

/** Cosine similarity in [-1, 1]; zero-norm vectors score 0. */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
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

/**
 * Squared L2 norm, accumulated in ascending index order — the same order
 * cosineSimilarity accumulates its norm terms, so batch callers that
 * precompute norms stay bit-identical to per-pair cosineSimilarity calls.
 */
export function vectorNormSq(vector: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < vector.length; i += 1) {
    sum += vector[i] * vector[i];
  }
  return sum;
}

/**
 * Dot product, accumulated in ascending index order (the same order
 * cosineSimilarity accumulates its dot term). Throws on dimension mismatch
 * with the same message as cosineSimilarity.
 */
export function dotProduct(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}`);
  }
  let dot = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
  }
  return dot;
}

/**
 * Cosine score from a dot product and precomputed squared norms. The zero
 * check and the sqrt-multiply-divide order mirror cosineSimilarity exactly,
 * so scores are bit-identical to per-pair calls.
 */
export function cosineScoreFromNorms(dot: number, normSqA: number, normSqB: number): number {
  if (normSqA === 0 || normSqB === 0) return 0;
  return dot / (Math.sqrt(normSqA) * Math.sqrt(normSqB));
}

interface RankedEntry {
  id: string;
  score: number;
  /** Original position — the stability key for exact (score, id) ties. */
  index: number;
}

/**
 * Total order behind the historical output: score descending, id ascending,
 * original position ascending. The last key only fires on exact (score, id)
 * ties and reproduces Array#sort stability (duplicate ids keep insertion
 * order), making the heap selection below bit-exact against sort+slice.
 */
function compareRanked(a: RankedEntry, b: RankedEntry): number {
  return b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) || a.index - b.index;
}

/**
 * Select the topK best-scored entries with a size-K min-heap (O(N log K)
 * instead of the O(N log N) full sort). The heap holds the K entries that
 * are BEST under compareRanked, with the worst of them at the root; the
 * final sort of those ≤K entries uses the same total order, so the output
 * equals `.sort(byScoreDescIdAsc).slice(0, topK)` on the full list.
 */
export function rankScoredCandidates(
  entries: Array<{ id: string; score: number }>,
  topK: number,
): VectorMatch[] {
  if (topK <= 0 || entries.length === 0) return [];
  const heap: RankedEntry[] = [];
  const siftDown = (start: number): void => {
    let parent = start;
    for (;;) {
      const left = parent * 2 + 1;
      const right = left + 1;
      let worst = parent;
      // The heap orders by WORST at the root: a child replaces the parent
      // when it compares greater (worse) under compareRanked.
      if (left < heap.length && compareRanked(heap[left], heap[worst]) > 0) worst = left;
      if (right < heap.length && compareRanked(heap[right], heap[worst]) > 0) worst = right;
      if (worst === parent) return;
      [heap[parent], heap[worst]] = [heap[worst], heap[parent]];
      parent = worst;
    }
  };
  for (let index = 0; index < entries.length; index += 1) {
    const entry: RankedEntry = { id: entries[index].id, score: entries[index].score, index };
    if (heap.length < topK) {
      heap.push(entry);
      let child = heap.length - 1;
      while (child > 0) {
        const parent = (child - 1) >> 1;
        // Root is the WORST kept entry: bubble up while the child is worse
        // than its parent.
        if (compareRanked(heap[child], heap[parent]) <= 0) break;
        [heap[parent], heap[child]] = [heap[child], heap[parent]];
        child = parent;
      }
    } else if (compareRanked(entry, heap[0]) < 0) {
      // Better than the worst kept entry: replace and restore the heap.
      heap[0] = entry;
      siftDown(0);
    }
  }
  return heap
    .sort(compareRanked)
    .map(({ id, score }) => ({ id, score }));
}

/**
 * Rank candidates against the query vector by cosine similarity.
 * Returns at most topK matches, highest score first; ties break by id for
 * deterministic output. Selection uses a size-K heap (rankScoredCandidates)
 * whose total order reproduces the historical sort+slice bit-for-bit.
 */
export function searchByVector(
  query: Float32Array,
  candidates: VectorCandidate[],
  topK: number,
): VectorMatch[] {
  if (topK <= 0 || candidates.length === 0) return [];
  return rankScoredCandidates(
    candidates.map(candidate => ({
      id: candidate.id,
      score: cosineSimilarity(query, candidate.vector),
    })),
    topK,
  );
}
