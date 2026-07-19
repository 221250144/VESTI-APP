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
import { buildSnippet, toFtsQuery } from '../src/search/SessionRecall.js';
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
