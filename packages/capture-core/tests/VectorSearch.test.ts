/**
 * VectorSearch Tests
 */

import { describe, it, expect } from 'vitest';
import {
  serializeVector,
  deserializeVector,
  cosineSimilarity,
  cosineScoreFromNorms,
  dotProduct,
  rankScoredCandidates,
  searchByVector,
  vectorNormSq,
} from '../src/search/VectorSearch.js';

// ---------------------------------------------------------------------------
// Reference implementations: the exact pre-optimization algorithms. The
// optimized paths must produce bit-identical results (verified with toEqual,
// which compares floats exactly and distinguishes -0 from +0).
// ---------------------------------------------------------------------------

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

function referenceSearchByVector(
  query: Float32Array,
  candidates: Array<{ id: string; vector: Float32Array }>,
  topK: number,
): Array<{ id: string; score: number }> {
  if (topK <= 0 || candidates.length === 0) return [];
  return candidates
    .map(candidate => ({ id: candidate.id, score: referenceCosineSimilarity(query, candidate.vector) }))
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, topK);
}

/** Deterministic PRNG so equivalence tests are reproducible. */
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

describe('serializeVector / deserializeVector', () => {
  it('round-trips a Float32Array through a Buffer', () => {
    const original = new Float32Array([0, 1, -1, 3.14159, 1e-7, 12345.678]);
    const restored = deserializeVector(serializeVector(original));
    expect(restored).toBeInstanceOf(Float32Array);
    expect(Array.from(restored)).toEqual(Array.from(original));
  });

  it('round-trips an empty vector', () => {
    const restored = deserializeVector(serializeVector(new Float32Array(0)));
    expect(restored.length).toBe(0);
  });

  it('produces 4 bytes per element', () => {
    expect(serializeVector(new Float32Array(3)).byteLength).toBe(12);
  });

  it('rejects buffers not aligned to 4 bytes', () => {
    expect(() => deserializeVector(Buffer.alloc(6))).toThrow(/multiple of 4/);
  });
});

describe('cosineSimilarity', () => {
  it('scores identical vectors as 1', () => {
    const v = new Float32Array([1, 2, 3]);
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 6);
  });

  it('scores orthogonal vectors as 0', () => {
    expect(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([0, 1]))).toBe(0);
  });

  it('scores opposite vectors as -1', () => {
    expect(cosineSimilarity(new Float32Array([1, 1]), new Float32Array([-1, -1]))).toBeCloseTo(-1, 6);
  });

  it('is scale-invariant', () => {
    expect(cosineSimilarity(new Float32Array([1, 2]), new Float32Array([10, 20]))).toBeCloseTo(1, 6);
  });

  it('returns 0 when either vector has zero norm', () => {
    expect(cosineSimilarity(new Float32Array([0, 0]), new Float32Array([1, 2]))).toBe(0);
  });

  it('throws on dimension mismatch', () => {
    expect(() => cosineSimilarity(new Float32Array(2), new Float32Array(3))).toThrow(/dimension mismatch/);
  });
});

describe('searchByVector', () => {
  const candidates = [
    { id: 'aligned', vector: new Float32Array([1, 0, 0]) },
    { id: 'orthogonal', vector: new Float32Array([0, 1, 0]) },
    { id: 'opposite', vector: new Float32Array([-1, 0, 0]) },
    { id: 'close', vector: new Float32Array([1, 0.1, 0]) },
  ];
  const query = new Float32Array([1, 0, 0]);

  it('ranks candidates by descending similarity', () => {
    const matches = searchByVector(query, candidates, 4);
    expect(matches.map(m => m.id)).toEqual(['aligned', 'close', 'orthogonal', 'opposite']);
    expect(matches[0].score).toBeCloseTo(1, 6);
    expect(matches[3].score).toBeCloseTo(-1, 6);
  });

  it('limits results to topK', () => {
    const matches = searchByVector(query, candidates, 2);
    expect(matches.map(m => m.id)).toEqual(['aligned', 'close']);
  });

  it('returns all candidates when topK exceeds the candidate count', () => {
    expect(searchByVector(query, candidates, 100)).toHaveLength(4);
  });

  it('returns empty for empty candidates or non-positive topK', () => {
    expect(searchByVector(query, [], 5)).toEqual([]);
    expect(searchByVector(query, candidates, 0)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Zero-copy deserialization
// ---------------------------------------------------------------------------

describe('deserializeVector zero-copy path', () => {
  it('returns a view over the Buffer backing store when 4-byte aligned', () => {
    const original = new Float32Array([1.5, -2.25, 3.125, 0, 1e-7]);
    const buffer = serializeVector(original);
    expect(buffer.byteOffset % 4).toBe(0);
    const restored = deserializeVector(buffer);
    // Zero-copy: the result aliases the same ArrayBuffer instead of copying.
    expect(restored.buffer).toBe(buffer.buffer);
    expect(Array.from(restored)).toEqual(Array.from(referenceDeserialize(buffer)));
  });

  it('decodes unaligned Buffer slices bit-identically (via one memcpy)', () => {
    const original = new Float32Array([1.5, -2.25, 3.125, 12345.678]);
    const blob = serializeVector(original);
    // Deterministic odd offset: own ArrayBuffer (alloc) + subarray(3).
    const store = Buffer.alloc(3 + blob.length);
    blob.copy(store, 3);
    const sliced = store.subarray(3);
    expect(sliced.byteOffset % 4).not.toBe(0);
    const restored = deserializeVector(sliced);
    expect(Array.from(restored)).toEqual(Array.from(referenceDeserialize(sliced)));
    // Unaligned input cannot be viewed directly; the result owns its copy.
    expect(restored.buffer).not.toBe(store.buffer);
  });

  it('is bit-identical to the scalar decoder on random and special values', () => {
    const withOffset = (vector: Float32Array, offset: number): Buffer => {
      const blob = serializeVector(vector);
      const store = Buffer.alloc(offset + blob.length);
      blob.copy(store, offset);
      return store.subarray(offset);
    };
    const special = new Float32Array([-0, Number.NaN, Infinity, -Infinity, 1e-40, -3.14159]);
    for (const offset of [0, 1, 2, 3]) {
      const sliced = withOffset(special, offset);
      expect(sliced.byteOffset % 4).toBe(offset % 4);
      expect(Array.from(deserializeVector(sliced))).toEqual(Array.from(referenceDeserialize(sliced)));
    }
    const rand = mulberry32(42);
    for (let trial = 0; trial < 200; trial += 1) {
      const vector = randomVector(rand, 1 + Math.floor(rand() * 64));
      const sliced = withOffset(vector, Math.floor(rand() * 4));
      expect(Array.from(deserializeVector(sliced))).toEqual(Array.from(referenceDeserialize(sliced)));
    }
  });
});

// ---------------------------------------------------------------------------
// Precomputed-norm scoring helpers
// ---------------------------------------------------------------------------

describe('vectorNormSq / dotProduct / cosineScoreFromNorms', () => {
  it('computes squared norms and dot products in index order', () => {
    expect(vectorNormSq(new Float32Array([3, 4]))).toBe(25);
    expect(vectorNormSq(new Float32Array(0))).toBe(0);
    expect(dotProduct(new Float32Array([1, 2]), new Float32Array([3, 4]))).toBe(11);
  });

  it('reproduces cosineSimilarity scores bit-for-bit from precomputed parts', () => {
    const rand = mulberry32(7);
    for (let trial = 0; trial < 200; trial += 1) {
      const a = randomVector(rand, 16);
      const b = randomVector(rand, 16);
      const rebuilt = cosineScoreFromNorms(dotProduct(a, b), vectorNormSq(a), vectorNormSq(b));
      expect(rebuilt).toBe(referenceCosineSimilarity(a, b));
    }
    // Zero-norm handling matches: 0 score regardless of the dot product.
    expect(cosineScoreFromNorms(0, 0, 5)).toBe(0);
    expect(cosineScoreFromNorms(0, 5, 0)).toBe(0);
  });

  it('dotProduct throws the cosineSimilarity dimension-mismatch error', () => {
    expect(() => dotProduct(new Float32Array(2), new Float32Array(3))).toThrow(/dimension mismatch/);
  });
});

// ---------------------------------------------------------------------------
// Heap top-K selection vs the historical full sort
// ---------------------------------------------------------------------------

describe('rankScoredCandidates', () => {
  it('matches sort+slice on random scores, exactly and in order', () => {
    const rand = mulberry32(1337);
    for (let trial = 0; trial < 50; trial += 1) {
      const count = 1 + Math.floor(rand() * 300);
      const entries = Array.from({ length: count }, (_, index) => ({
        id: `id-${index}`,
        score: Math.round(rand() * 40 - 20) / 4, // quantized: forces score ties
      }));
      for (const topK of [1, 3, 17, count, count + 10]) {
        const expected = [...entries]
          .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
          .slice(0, topK);
        expect(rankScoredCandidates(entries, topK)).toEqual(expected);
      }
    }
  });

  it('preserves insertion order for exact (score, id) ties like stable sort', () => {
    const entries = [
      { id: 'dup', score: 0.5 },
      { id: 'aaa', score: 0.5 },
      { id: 'dup', score: 0.5 },
      { id: 'dup', score: 0.25 },
      { id: 'zzz', score: 0.5 },
    ];
    expect(rankScoredCandidates(entries, 5).map(match => match.id))
      .toEqual(['aaa', 'dup', 'dup', 'zzz', 'dup']);
    expect(rankScoredCandidates(entries, 2).map(match => match.id)).toEqual(['aaa', 'dup']);
    // -0 and +0 compare equal and fall through to the id tie-break.
    expect(rankScoredCandidates([{ id: 'b', score: -0 }, { id: 'a', score: 0 }], 2)
      .map(match => match.id)).toEqual(['a', 'b']);
  });

  it('returns empty for empty input or non-positive topK', () => {
    expect(rankScoredCandidates([], 5)).toEqual([]);
    expect(rankScoredCandidates([{ id: 'a', score: 1 }], 0)).toEqual([]);
    expect(rankScoredCandidates([{ id: 'a', score: 1 }], -3)).toEqual([]);
  });
});

describe('searchByVector — equivalence with the reference brute force', () => {
  it('is bit-identical (ids, order and scores) on random candidates', () => {
    const rand = mulberry32(2026);
    for (let trial = 0; trial < 20; trial += 1) {
      const dimensions = 1 + Math.floor(rand() * 16);
      const count = 1 + Math.floor(rand() * 250);
      const query = randomVector(rand, dimensions);
      const candidates = Array.from({ length: count }, (_, index) => ({
        id: `c${index % Math.max(1, count - 3)}`, // a few duplicate ids
        vector: randomVector(rand, dimensions),
      }));
      if (count > 3) {
        // Duplicate id AND vector: identical scores must keep insertion order.
        candidates[2] = { id: candidates[0].id, vector: candidates[0].vector };
        // Zero-norm candidates score 0.
        candidates[1] = { id: 'zero-norm', vector: new Float32Array(dimensions) };
      }
      for (const topK of [1, 5, 30, count + 50]) {
        expect(searchByVector(query, candidates, topK))
          .toEqual(referenceSearchByVector(query, candidates, topK));
      }
    }
  });
});
