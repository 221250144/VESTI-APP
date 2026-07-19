import os from 'node:os';
import path from 'node:path';
import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseManager } from '../src/storage/DatabaseManager.js';
import type { WorkSession } from '../src/types/unified.js';

const tempDirs: string[] = [];

async function createManager(): Promise<DatabaseManager> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vesti-token-upsert-'));
  tempDirs.push(dir);
  const manager = new DatabaseManager(path.join(dir, 'vesti.db'));
  await manager.initialize();
  return manager;
}

function session(overrides: Partial<WorkSession> = {}): WorkSession {
  return {
    id: 'codex:active-session',
    sessionId: 'active-session',
    platform: 'codex',
    projectPath: 'C:/workspace/project',
    title: 'Active session',
    tags: [],
    status: 'active',
    sessionType: 'conversation',
    startedAt: 1_000,
    lastActivityAt: 2_000,
    durationMs: 1_000,
    messageCount: 20,
    userInputCount: 5,
    assistantMessageCount: 10,
    thinkingCount: 3,
    toolCallCount: 2,
    codeBlockCount: 1,
    turnCount: 5,
    totalInputTokens: 300_000_000,
    totalOutputTokens: 4_000_000,
    totalCacheCreationTokens: 0,
    totalCacheReadTokens: 290_000_000,
    hasSubagents: false,
    hasContextCompaction: false,
    createdAt: 1_000,
    updatedAt: 2_000,
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => fs.remove(dir)));
});

describe('DatabaseManager work-session token totals', () => {
  it('does not let an older concurrent parse reduce cumulative usage', async () => {
    const manager = await createManager();
    manager.upsertWorkSession(session());

    manager.upsertWorkSession(session({
      lastActivityAt: 1_500,
      durationMs: 500,
      messageCount: 8,
      userInputCount: 2,
      assistantMessageCount: 4,
      thinkingCount: 1,
      toolCallCount: 1,
      codeBlockCount: 0,
      turnCount: 2,
      totalInputTokens: 40_000_000,
      totalOutputTokens: 800_000,
      totalCacheReadTokens: 35_000_000,
      updatedAt: 1_500,
    }));

    const stored = manager.getWorkSession('codex:active-session');
    expect(stored).toMatchObject({
      lastActivityAt: 2_000,
      messageCount: 20,
      totalInputTokens: 300_000_000,
      totalOutputTokens: 4_000_000,
      totalCacheReadTokens: 290_000_000,
    });
    expect(manager.getStats().totalInputTokens).toBe(300_000_000);
    expect(manager.getStats().totalOutputTokens).toBe(4_000_000);

    await manager.close();
  });

  it('still accepts a newer larger cumulative total', async () => {
    const manager = await createManager();
    manager.upsertWorkSession(session());
    manager.upsertWorkSession(session({
      lastActivityAt: 3_000,
      messageCount: 25,
      totalInputTokens: 320_000_000,
      totalOutputTokens: 4_500_000,
      totalCacheReadTokens: 310_000_000,
      updatedAt: 3_000,
    }));

    expect(manager.getWorkSession('codex:active-session')).toMatchObject({
      lastActivityAt: 3_000,
      messageCount: 25,
      totalInputTokens: 320_000_000,
      totalOutputTokens: 4_500_000,
      totalCacheReadTokens: 310_000_000,
    });

    await manager.close();
  });
});
