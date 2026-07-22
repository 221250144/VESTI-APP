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

describe('DatabaseManager subagent folding (A1)', () => {
  async function seedParentAndChild(manager: DatabaseManager): Promise<void> {
    manager.upsertWorkSession(session({
      id: 'codex:parent',
      sessionId: 'parent',
      title: 'Parent session',
      totalInputTokens: 100,
      totalOutputTokens: 10,
      totalCacheReadTokens: 0,
    }));
    manager.upsertWorkSession(session({
      id: 'codex:child',
      sessionId: 'child',
      title: 'Review the renderer',
      messageCount: 7,
      totalInputTokens: 50,
      totalOutputTokens: 5,
      totalCacheReadTokens: 0,
    }));
    manager.insertSubagentLink({
      id: 'link-1',
      parentSessionId: 'codex:parent',
      childSessionId: 'codex:child',
      agentId: 'child',
      agentRole: 'bugbot',
      slug: null as unknown as string,
      filePath: 'C:/x/child.jsonl',
      messageCount: 7,
      spawnedAt: 1_500,
    });
  }

  it('counts only main sessions as conversations but keeps full token sums', async () => {
    const manager = await createManager();
    await seedParentAndChild(manager);

    const stats = manager.getStats();
    expect(stats.totalConversations).toBe(1);
    expect(stats.totalInputTokens).toBe(150);
    expect(stats.totalOutputTokens).toBe(15);
    expect(stats.platformBreakdown.codex).toBe(1);
    expect(stats.platformTokenBreakdown.codex).toMatchObject({
      conversations: 1,
      inputTokens: 150,
      outputTokens: 15,
    });

    await manager.close();
  });

  it('exposes child ids, lineage and briefs for downstream folding', async () => {
    const manager = await createManager();
    await seedParentAndChild(manager);

    expect([...manager.getSubagentChildIds()]).toEqual(['codex:child']);
    expect(manager.getSubagentLineageByChild().get('codex:child')).toEqual({
      parentSessionId: 'codex:parent',
      agentRole: 'bugbot',
    });
    expect(manager.getSubagentBriefs('codex:parent')).toEqual([
      {
        childSessionId: 'codex:child',
        agentRole: 'bugbot',
        title: 'Review the renderer',
        messageCount: 7,
        oneLiner: null,
      },
    ]);

    await manager.close();
  });
});
