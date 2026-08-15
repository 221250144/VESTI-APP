/**
 * SessionRecall Tests
 * FTS5 session recall with hit snippets, the pure-FTS path (no embeddings),
 * and RRF fusion with digest embedding vectors.
 */

import os from 'os';
import path from 'path';
import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseManager } from '../src/storage/DatabaseManager.js';
import { serializeVector } from '../src/search/VectorSearch.js';
import {
  buildQueryPlan,
  buildSnippet,
  confidenceForCoverage,
  detectFtsTokenizer,
  effectiveTokens,
  recencyFactor,
  RECENCY_TAU_DAYS,
  toFtsQuery,
} from '../src/search/SessionRecall.js';
import type { SessionMessage, WorkSession } from '../src/types/unified.js';

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => fs.remove(dir)));
});

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
    messageCount: 2,
    userInputCount: 1,
    assistantMessageCount: 1,
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

function makeMessage(id: string, sessionId: string, text: string): SessionMessage {
  return {
    id,
    sessionId,
    source: 'assistant_text',
    sequence: 0,
    role: 'assistant',
    contentText: text,
    depth: 0,
    timestamp: 1500,
    createdAt: 1500,
  };
}

async function withManager<T>(fn: (manager: DatabaseManager) => T | Promise<T>): Promise<T> {
  const dir = await makeTempDir('vesti-recall-');
  const manager = new DatabaseManager(path.join(dir, 'vesti.db'));
  await manager.initialize();
  try {
    return await fn(manager);
  } finally {
    await manager.close();
  }
}

describe('toFtsQuery / buildSnippet', () => {
  it('quotes tokens and OR-combines them for safe MATCH input', () => {
    expect(toFtsQuery('login page')).toBe('"login" OR "page"');
    expect(toFtsQuery('weird "quoted" input')).toBe('"weird" OR "quoted" OR "input"');
    expect(toFtsQuery('!!!')).toBe('');
  });

  it('centers the snippet on the first token hit', () => {
    const text = `${'x'.repeat(200)} keyword appears here ${'y'.repeat(200)}`;
    const snippet = buildSnippet(text, ['keyword']);
    expect(snippet).toContain('keyword');
    expect(snippet.startsWith('…')).toBe(true);
    expect(snippet.length).toBeLessThan(text.length);
  });
});

describe('recallSessions', () => {
  it('recalls sessions by message content with a hit snippet (pure FTS)', async () => {
    await withManager(async manager => {
      manager.upsertWorkSession(makeSession('codex:s1', 'Auth work'));
      manager.upsertWorkSession(makeSession('codex:s2', 'Styling work'));
      manager.insertSessionMessages([
        makeMessage('m1', 'codex:s1', 'Implementing the login redirect with jwt tokens'),
        makeMessage('m2', 'codex:s2', 'Adjusting the color palette and spacing'),
      ]);

      const hits = manager.recallSessions('login redirect', { topK: 5 });
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0].sessionId).toBe('codex:s1');
      expect(hits[0].title).toBe('Auth work');
      expect(hits[0].snippet.toLowerCase()).toContain('login');
    });
  });

  it('matches session titles through sessions_fts', async () => {
    await withManager(async manager => {
      manager.upsertWorkSession(makeSession('codex:s1', 'Database migration planning'));
      manager.insertSessionMessages([
        makeMessage('m1', 'codex:s1', 'some unrelated content'),
      ]);

      const hits = manager.recallSessions('migration', { topK: 5 });
      expect(hits.map(hit => hit.sessionId)).toContain('codex:s1');
    });
  });

  it('returns an empty list when nothing matches', async () => {
    await withManager(async manager => {
      manager.upsertWorkSession(makeSession('codex:s1', 'Auth work'));
      manager.insertSessionMessages([
        makeMessage('m1', 'codex:s1', 'Implementing the login redirect'),
      ]);

      expect(manager.recallSessions('nonexistentterm', { topK: 5 })).toEqual([]);
    });
  });

  it('falls back to the one-liner when the FTS hit has no text snippet', async () => {
    await withManager(async manager => {
      // Hit lands on the content_thinking FTS column; content_text is empty,
      // so buildSnippet yields '' and the digest one-liner must take over.
      manager.upsertWorkSession(makeSession('codex:s1', 'Thinking session'));
      const thinkingOnly: SessionMessage = {
        ...makeMessage('m1', 'codex:s1', ''),
        contentThinking: 'quixotic pondering about zephyrs',
      };
      manager.insertSessionMessages([thinkingOnly]);
      manager.upsertSessionDigest({
        sessionId: 'codex:s1',
        host: 'native',
        platform: 'codex',
        projectKey: 'cli_test',
        oneLiner: 'digest one-liner fallback',
        keyTopics: [],
        keyFiles: [],
        decisions: [],
        openQuestions: [],
        embeddingStatus: 'none',
        digestVersion: 1,
        messageCount: 1,
        updatedAt: new Date(2000).toISOString(),
      });

      const hits = manager.recallSessions('zephyrs', { topK: 5 });
      expect(hits).toHaveLength(1);
      expect(hits[0].snippet).toBe('digest one-liner fallback');
    });
  });

  it('fuses digest embedding similarity via RRF when a query vector is given', async () => {
    await withManager(async manager => {
      // s1: FTS hit only. s2: vector hit only (no lexical overlap at all).
      manager.upsertWorkSession(makeSession('codex:s1', 'FTS session'));
      manager.upsertWorkSession(makeSession('codex:s2', 'Vector session'));
      manager.insertSessionMessages([
        makeMessage('m1', 'codex:s1', 'kubernetes deployment notes'),
        makeMessage('m2', 'codex:s2', 'completely different words here'),
      ]);

      const digestVector = new Float32Array([1, 0, 0, 0]);
      manager.upsertSessionDigest({
        sessionId: 'codex:s2',
        host: 'native',
        platform: 'codex',
        projectKey: 'cli_test',
        oneLiner: 'vector-only digest',
        keyTopics: [],
        keyFiles: [],
        decisions: [],
        openQuestions: [],
        embedding: serializeVector(digestVector),
        embeddingStatus: 'ok',
        digestVersion: 1,
        messageCount: 2,
        updatedAt: new Date(2000).toISOString(),
      });

      const ftsOnly = manager.recallSessions('kubernetes', { topK: 5 });
      expect(ftsOnly.map(hit => hit.sessionId)).toEqual(['codex:s1']);

      const fused = manager.recallSessions('kubernetes', {
        topK: 5,
        queryVector: new Float32Array([0.9, 0.1, 0, 0]),
      });
      const ids = fused.map(hit => hit.sessionId);
      expect(ids).toContain('codex:s1');
      expect(ids).toContain('codex:s2');
      const vectorHit = fused.find(hit => hit.sessionId === 'codex:s2');
      expect(vectorHit?.oneLiner).toBe('vector-only digest');
      // Fused scores are RRF sums — positive and comparable across signals.
      expect(fused.every(hit => hit.score > 0)).toBe(true);
    });
  });

  it('caps results at topK', async () => {
    await withManager(async manager => {
      for (let index = 0; index < 4; index += 1) {
        manager.upsertWorkSession(makeSession(`codex:s${index}`, `Session ${index}`));
        manager.insertSessionMessages([
          makeMessage(`m${index}`, `codex:s${index}`, 'shared topic content'),
        ]);
      }

      const hits = manager.recallSessions('shared', { topK: 2 });
      expect(hits).toHaveLength(2);
    });
  });
});

describe('recallSessions — subagent attribution (A1)', () => {
  function link(manager: DatabaseManager, parentId: string, childId: string): void {
    manager.insertSubagentLink({
      id: `link:${childId}`,
      parentSessionId: parentId,
      childSessionId: childId,
      agentId: 'agent-1',
      filePath: 'C:\\work\\alpha\\sub.jsonl',
      messageCount: 1,
    });
  }

  it('attributes a subagent hit to its parent session entry', async () => {
    await withManager(async manager => {
      manager.upsertWorkSession(makeSession('codex:main', 'Parent session'));
      manager.upsertWorkSession(makeSession('codex:sub', 'Subagent session'));
      link(manager, 'codex:main', 'codex:sub');
      manager.insertSessionMessages([
        makeMessage('m1', 'codex:main', 'ordinary chatter about nothing relevant'),
        makeMessage('m2', 'codex:sub', 'the fluxgate calibrator benchmark results'),
      ]);

      const hits = manager.recallSessions('fluxgate', { topK: 5 });
      expect(hits).toHaveLength(1);
      const hit = hits[0];
      // The parent entry surfaces even though only the subagent matched.
      expect(hit.sessionId).toBe('codex:main');
      expect(hit.title).toBe('Parent session');
      expect(hit.hitSource).toBe('subagent');
      expect(hit.attributedSessionId).toBe('codex:main');
      expect(hit.subagentSessionId).toBe('codex:sub');
      expect(hit.snippet.toLowerCase()).toContain('fluxgate');
    });
  });

  it('folds a subagent hit into an already-recalled parent (single entry)', async () => {
    await withManager(async manager => {
      manager.upsertWorkSession(makeSession('codex:main', 'Parent session'));
      manager.upsertWorkSession(makeSession('codex:sub', 'Subagent session'));
      link(manager, 'codex:main', 'codex:sub');
      manager.insertSessionMessages([
        makeMessage('m1', 'codex:main', 'quicksilver in the main transcript'),
        makeMessage('m2', 'codex:sub', 'quicksilver measured by the subagent'),
      ]);

      const hits = manager.recallSessions('quicksilver', { topK: 5 });
      // Both matched, but the child folds into the parent: one entry only.
      expect(hits).toHaveLength(1);
      expect(hits[0].sessionId).toBe('codex:main');
      expect(hits[0].hitSource).toBe('main');
      expect(hits[0].subagentSessionId).toBeUndefined();
    });
  });

  it('marks plain main-session hits as hitSource main', async () => {
    await withManager(async manager => {
      manager.upsertWorkSession(makeSession('codex:solo', 'Solo session'));
      manager.insertSessionMessages([
        makeMessage('m1', 'codex:solo', 'lonesome pine on the hill'),
      ]);

      const hits = manager.recallSessions('lonesome', { topK: 5 });
      expect(hits).toHaveLength(1);
      expect(hits[0].sessionId).toBe('codex:solo');
      expect(hits[0].hitSource).toBe('main');
      expect(hits[0].attributedSessionId).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// Trigram tokenizer (migration 5), recency decay, confidence
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 3600 * 1000;

describe('recencyFactor', () => {
  const NOW = Date.UTC(2026, 6, 19);

  it('is 1 for a session active right now and clamps future timestamps', () => {
    expect(recencyFactor(NOW, NOW)).toBe(1);
    expect(recencyFactor(NOW + 10 * DAY_MS, NOW)).toBe(1);
  });

  it('decays exponentially with tau and floors at RECENCY_FLOOR (0.9)', () => {
    expect(recencyFactor(NOW - RECENCY_TAU_DAYS * DAY_MS, NOW)).toBeCloseTo(0.9 + 0.1 / Math.E, 6);
    expect(recencyFactor(NOW - 10 * RECENCY_TAU_DAYS * DAY_MS, NOW)).toBeCloseTo(0.9, 4);
    // Never below the floor: bounded swing keeps strong old hits findable.
    expect(recencyFactor(0, NOW)).toBeGreaterThanOrEqual(0.9);
  });
});

describe('effectiveTokens / confidenceForCoverage', () => {
  it('drops tokens shorter than 3 characters under trigram, keeps all under unicode61', () => {
    expect(effectiveTokens('生产环境 redis 的 maxmemory', 'trigram'))
      .toEqual(['生产环境', 'redis', 'maxmemory']);
    expect(effectiveTokens('生产环境 redis 的 maxmemory', 'unicode61'))
      .toEqual(['生产环境', 'redis', '的', 'maxmemory']);
    // Code points, not UTF-16 units; 2-char tokens (CI, v2, 平台) are inert.
    expect(effectiveTokens('CI 平台 v2', 'trigram')).toEqual([]);
  });

  it('marks low confidence on zero matchable tokens or sub-floor coverage', () => {
    expect(confidenceForCoverage(0, 0)).toBe('low');
    expect(confidenceForCoverage(1, 0)).toBe('low');
    expect(confidenceForCoverage(0.49, 3)).toBe('low');
    expect(confidenceForCoverage(0.5, 2)).toBe('high');
    expect(confidenceForCoverage(1, 4)).toBe('high');
  });
});

describe('buildQueryPlan', () => {
  it('keeps unicode61 token-OR and plans trigram two-character fallbacks independently', () => {
    expect(buildQueryPlan('login page', 'unicode61'))
      .toEqual({
        ftsQuery: '"login" OR "page"',
        matchUnits: ['login', 'page'],
        shortFallbackTokens: [],
      });
    expect(buildQueryPlan('采集 增量 防护在哪个文件', 'trigram')).toEqual({
      ftsQuery: '"防护在哪个文件"',
      matchUnits: ['防护在哪个文件', '采集', '增量', '防护'],
      shortFallbackTokens: ['采集', '增量', '防护'],
    });
    expect(buildQueryPlan('采集增量防护在哪个文件', 'trigram')).toEqual({
      ftsQuery: '"采集增量防护在哪个文件"',
      matchUnits: ['采集增量防护在哪个文件', '采集', '增量', '防护'],
      shortFallbackTokens: ['采集', '增量', '防护'],
    });
    expect(buildQueryPlan('代理重试防护在哪个文件', 'trigram').shortFallbackTokens)
      .toEqual(expect.arrayContaining(['代理', '重试', '防护']));
    expect(buildQueryPlan('采集轮询旧实现以前在哪里', 'trigram').shortFallbackTokens)
      .toEqual(expect.arrayContaining(['采集', '轮询', '实现']));
    // Short English stop words never become broad LIKE scans; meaningful
    // code/product abbreviations still do.
    expect(buildQueryPlan('in CI to', 'trigram')).toEqual({
      ftsQuery: '',
      matchUnits: ['ci'],
      shortFallbackTokens: ['ci'],
    });
    expect(buildQueryPlan('生产环境 redis 的 maxmemory', 'trigram')).toEqual({
      ftsQuery: '"生产环境" OR "redis" OR "maxmemory"',
      matchUnits: ['生产环境', 'redis', 'maxmemory', '生产', '环境'],
      shortFallbackTokens: ['生产', '环境'],
    });
    expect(buildQueryPlan('的', 'trigram')).toEqual({
      ftsQuery: '',
      matchUnits: [],
      shortFallbackTokens: [],
    });
  });
});

describe('recallSessions — trigram, recency decay, confidence', () => {
  it('detects the trigram tokenizer on migrated databases', async () => {
    await withManager(async manager => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(detectFtsTokenizer((manager as any).db)).toBe('trigram');
    });
  });

  it('recalls tight-CJK statements from spaced queries (baseline regression)', async () => {
    await withManager(async manager => {
      manager.upsertWorkSession(makeSession('codex:s1', '前端状态管理库选型讨论'));
      manager.insertSessionMessages([
        makeMessage('m1', 'codex:s1', '关于前端状态管理库，团队最终决定用Zustand了，后续不再讨论。'),
      ]);

      const hits = manager.recallSessions('前端状态管理库 最终选了什么方案？', { topK: 5 });
      expect(hits.map(hit => hit.sessionId)).toContain('codex:s1');
      expect(hits[0].confidence).toBe('high');
    });
  });

  it('recalls pure two-character queries and ranks full coverage above one-term distractors', async () => {
    await withManager(async manager => {
      manager.upsertWorkSession(makeSession('codex:target', '目标实现'));
      manager.upsertWorkSession(makeSession('codex:capture', '采集看板'));
      manager.upsertWorkSession(makeSession('codex:delta', '增量看板'));
      manager.insertSessionMessages([
        makeMessage('m1', 'codex:target', '采集流程针对增量完成校验，并补齐失败防护。'),
        makeMessage('m2', 'codex:capture', '采集页面只调整了视觉颜色。'),
        makeMessage('m3', 'codex:delta', '增量统计图只修改了坐标轴。'),
      ]);

      const hits = manager.recallSessions('采集 增量', { topK: 5 });
      expect(hits[0].sessionId).toBe('codex:target');
      expect(hits[0].confidence).toBe('high');
      const oneTermScore = Math.max(
        hits.find(hit => hit.sessionId === 'codex:capture')?.score ?? 0,
        hits.find(hit => hit.sessionId === 'codex:delta')?.score ?? 0,
      );
      expect(hits[0].score).toBeGreaterThan(oneTermScore * 1.25);
      expect(hits.map(hit => hit.sessionId)).toEqual(expect.arrayContaining([
        'codex:capture',
        'codex:delta',
      ]));
    });
  });

  it('recalls natural Chinese queries without artificial spaces', async () => {
    await withManager(async manager => {
      manager.upsertWorkSession(makeSession('codex:target', '目标实现'));
      manager.upsertWorkSession(makeSession('codex:decoy', '采集看板'));
      manager.insertSessionMessages([
        makeMessage('m-natural-target', 'codex:target', '采集流程针对增量完成校验，并补齐失败防护。'),
        makeMessage('m-natural-decoy', 'codex:decoy', '采集页面只调整了视觉颜色。'),
      ]);

      const hits = manager.recallSessions('采集增量防护在哪个文件', { topK: 5 });
      expect(hits[0].sessionId).toBe('codex:target');
      expect(hits[0].confidence).toBe('high');
    });
  });

  it('deduplicates matching messages by session before applying the candidate limit', async () => {
    await withManager(async manager => {
      manager.upsertWorkSession(makeSession('codex:flood', 'Long session'));
      manager.upsertWorkSession(makeSession('codex:independent', 'Independent session'));
      manager.insertSessionMessages([
        ...Array.from({ length: 80 }, (_, index) =>
          makeMessage(`m-flood-${index}`, 'codex:flood', `needlephrase repeated message ${index}`)),
        makeMessage('m-independent', 'codex:independent', 'needlephrase independent result'),
      ]);

      const hits = manager.recallSessions('needlephrase', { topK: 2, candidateLimit: 2 });
      expect(hits.map(hit => hit.sessionId)).toEqual(expect.arrayContaining([
        'codex:flood',
        'codex:independent',
      ]));
    });
  });

  it('ranks the newer statement of a fact above the stale one', async () => {
    await withManager(async manager => {
      const NOW = Date.UTC(2026, 6, 19);
      manager.upsertWorkSession({ ...makeSession('codex:old', 'timeout 旧值'), lastActivityAt: NOW - 40 * DAY_MS });
      manager.upsertWorkSession({ ...makeSession('codex:new', 'timeout 新值'), lastActivityAt: NOW - 3 * DAY_MS });
      manager.insertSessionMessages([
        makeMessage('m1', 'codex:old', '把 config.yaml 的 timeout 从默认值改成了 30s，先跑着看看。'),
        makeMessage('m2', 'codex:new', '决定把 config.yaml 的 timeout 最终定为 60s，压测大量超时。'),
      ]);

      const hits = manager.recallSessions('config.yaml 的 timeout 最终定为多少？', { topK: 5, now: NOW });
      expect(hits.map(hit => hit.sessionId)).toHaveLength(2);
      expect(hits[0].sessionId).toBe('codex:new');
      expect(hits[0].score).toBeGreaterThan(hits[1].score);
      // The stale statement is demoted, not hidden (floor 0.5).
      expect(hits[1].sessionId).toBe('codex:old');
    });
  });

  it('keeps lexical order when sessions are equally old', async () => {
    await withManager(async manager => {
      manager.upsertWorkSession(makeSession('codex:s1', 'Auth work'));
      manager.upsertWorkSession(makeSession('codex:s2', 'Styling work'));
      manager.insertSessionMessages([
        makeMessage('m1', 'codex:s1', 'Implementing the login redirect with jwt tokens'),
        makeMessage('m2', 'codex:s2', 'Adjusting the color palette and spacing'),
      ]);
      const hits = manager.recallSessions('login redirect', { topK: 5 });
      expect(hits[0].sessionId).toBe('codex:s1');
    });
  });

  it('marks decoy hits with partial token coverage as low confidence', async () => {
    await withManager(async manager => {
      manager.upsertWorkSession(makeSession('codex:decoy', 'postgres 本地配置'));
      manager.insertSessionMessages([
        makeMessage('m1', 'codex:decoy', '本地 docker 里 postgres 的 max_connections 保持默认 100，没动过。'),
      ]);

      const hits = manager.recallSessions('PostgreSQL 的 max_connections 被改成了多少？', { topK: 5 });
      expect(hits).toHaveLength(1);
      // Only 1 of 3 matchable tokens (max_connections) appears in the decoy.
      expect(hits[0].confidence).toBe('low');
    });
  });

  it('marks title-only (zero message coverage) hits as low confidence', async () => {
    await withManager(async manager => {
      manager.upsertWorkSession(makeSession('codex:s1', 'Database migration planning'));
      manager.insertSessionMessages([
        makeMessage('m1', 'codex:s1', 'some unrelated content'),
      ]);

      const hits = manager.recallSessions('migration', { topK: 5 });
      expect(hits).toHaveLength(1);
      expect(hits[0].confidence).toBe('low');
    });
  });
});
