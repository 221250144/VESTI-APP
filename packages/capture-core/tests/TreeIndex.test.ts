/**
 * TreeIndex Tests
 * Builds the 来源(platform+host) → 项目 → 会话 hierarchy from a database with
 * multiple platforms, hosts and projects, with and without digest rows.
 */

import os from 'os';
import path from 'path';
import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseManager } from '../src/storage/DatabaseManager.js';
import { deriveProjectKey } from '../src/storage/projectRegistry.js';
import type { WorkSession } from '../src/types/unified.js';

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => fs.remove(dir)));
});

function makeSession(overrides: Partial<WorkSession>): WorkSession {
  return {
    id: 'codex:s1',
    sessionId: 's1',
    platform: 'codex',
    projectPath: 'C:\\work\\alpha',
    title: 'Session',
    tags: [],
    status: 'active',
    sessionType: 'conversation',
    startedAt: 1000,
    lastActivityAt: 2000,
    durationMs: 0,
    messageCount: 5,
    userInputCount: 2,
    assistantMessageCount: 3,
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
    ...overrides,
  };
}

async function withManager<T>(fn: (manager: DatabaseManager) => T | Promise<T>): Promise<T> {
  const dir = await makeTempDir('vesti-tree-');
  const manager = new DatabaseManager(path.join(dir, 'vesti.db'));
  await manager.initialize();
  try {
    return await fn(manager);
  } finally {
    await manager.close();
  }
}

describe('buildConversationTree', () => {
  it('groups sessions by platform+host, then project, with digest fields', async () => {
    await withManager(async manager => {
      // codex / native / alpha (with digest)
      manager.upsertWorkSession(makeSession({}));
      manager.upsertSessionDigest({
        sessionId: 'codex:s1',
        host: 'native',
        platform: 'codex',
        projectKey: deriveProjectKey({ platform: 'codex', host: 'native', projectPath: 'C:\\work\\alpha' }),
        oneLiner: '实现登录页',
        keyTopics: ['认证', 'UI'],
        keyFiles: ['src/Login.tsx'],
        decisions: ['用 JWT'],
        openQuestions: [],
        embedding: null,
        embeddingStatus: 'skipped',
        digestVersion: 1,
        messageCount: 5,
        updatedAt: new Date(2000).toISOString(),
      });
      // codex / native / beta (no digest)
      manager.upsertWorkSession(makeSession({
        id: 'codex:s2',
        sessionId: 's2',
        projectPath: 'C:\\work\\beta',
        title: 'Beta session',
        lastActivityAt: 3000,
      }));
      // claude-code / wsl:Ubuntu / alpha-path (same path, different platform+host)
      manager.upsertWorkSession(makeSession({
        id: 'claude-code:wsl-Ubuntu-s3',
        sessionId: 'wsl-Ubuntu-s3',
        platform: 'claude-code',
        host: 'wsl:Ubuntu',
        title: 'WSL session',
        lastActivityAt: 1500,
      }));

      const tree = manager.buildConversationTree();
      expect(tree.generatedAt).toBeTruthy();
      expect(tree.sources).toHaveLength(2);

      const codexNative = tree.sources.find(
        source => source.platform === 'codex' && source.host === 'native',
      );
      expect(codexNative).toBeDefined();
      expect(codexNative!.projects).toHaveLength(2);

      const alpha = codexNative!.projects.find(project => project.label === 'alpha');
      const beta = codexNative!.projects.find(project => project.label === 'beta');
      expect(alpha?.pathOrDomain).toBe('c:/work/alpha');
      expect(beta?.sessions.map(session => session.id)).toEqual(['codex:s2']);

      expect(alpha?.sessions).toHaveLength(1);
      const digested = alpha!.sessions[0];
      expect(digested.oneLiner).toBe('实现登录页');
      expect(digested.keyTopics).toEqual(['认证', 'UI']);
      expect(digested.keyFiles).toEqual(['src/Login.tsx']);
      expect(digested.decisions).toEqual(['用 JWT']);
      expect(digested.messageCount).toBe(5);

      const undigested = beta!.sessions[0];
      expect(undigested.oneLiner).toBeNull();
      expect(undigested.keyTopics).toEqual([]);

      const wslSource = tree.sources.find(
        source => source.platform === 'claude-code' && source.host === 'wsl:Ubuntu',
      );
      expect(wslSource?.projects).toHaveLength(1);
      expect(wslSource?.projects[0].sessions[0].title).toBe('WSL session');
      // Same path but different platform+host → different project key.
      expect(wslSource!.projects[0].projectKey).not.toBe(alpha!.projectKey);
    });
  });

  it('orders sessions by last activity, newest first', async () => {
    await withManager(async manager => {
      manager.upsertWorkSession(makeSession({ id: 'codex:old', sessionId: 'old', lastActivityAt: 1000 }));
      manager.upsertWorkSession(makeSession({ id: 'codex:new', sessionId: 'new', lastActivityAt: 9000 }));

      const tree = manager.buildConversationTree();
      expect(tree.sources[0].projects[0].sessions.map(session => session.id))
        .toEqual(['codex:new', 'codex:old']);
    });
  });

  it('returns an empty source list for an empty database', async () => {
    await withManager(async manager => {
      expect(manager.buildConversationTree().sources).toEqual([]);
    });
  });
});
