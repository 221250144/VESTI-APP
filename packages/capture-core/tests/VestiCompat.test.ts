import { describe, expect, it } from 'vitest';
import { workSessionToVestiConversation } from '../src/api/vestiCompat.js';
import type { WorkSession } from '../src/types/unified.js';

function workSession(overrides: Partial<WorkSession> = {}): WorkSession {
  return {
    id: 'codex:compat-1',
    sessionId: 'compat-1',
    platform: 'codex',
    projectPath: 'C:/work/demo',
    title: 'Visible title',
    tags: [],
    status: 'active',
    sessionType: 'conversation',
    startedAt: 1_000,
    lastActivityAt: 2_000,
    durationMs: 1_000,
    messageCount: 1,
    userInputCount: 1,
    assistantMessageCount: 0,
    thinkingCount: 0,
    toolCallCount: 0,
    codeBlockCount: 0,
    turnCount: 1,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheCreationTokens: 0,
    totalCacheReadTokens: 0,
    hasSubagents: false,
    hasContextCompaction: false,
    createdAt: 1_000,
    updatedAt: 2_000,
    ...overrides,
  };
}

describe('workSessionToVestiConversation', () => {
  it('sanitizes stale CLI titles and snippets at the API boundary', () => {
    const conversation = workSessionToVestiConversation(
      workSession({
        title: '<recommended_plugins>generated</recommended_plugins>',
      }),
      '<environment_context>generated</environment_context>\n\n可见摘要',
    );

    expect(conversation.title).toBe('可见摘要');
    expect(conversation.snippet).toBe('可见摘要');
  });

  it('uses the visible snippet when a legacy title is a truncated system block', () => {
    const conversation = workSessionToVestiConversation(
      workSession({
        title: '<recommended_plugins> Here is a list of plugins that are available but not insta',
      }),
      '还是这个样子啊',
    );

    expect(conversation.title).toBe('还是这个样子啊');
    expect(conversation.snippet).toBe('还是这个样子啊');
  });

  it.each([
    '<git-context branch="main"',
    '<timestamp>2026-08-18',
    '<user_info>generated',
    '<system_notification>generated',
    '<system_reminder>generated',
    '<user_query>truncated wrapper',
  ])('replaces a truncated shared-system title: %s', title => {
    const conversation = workSessionToVestiConversation(
      workSession({ platform: 'claude-code', title }),
      '可见问题',
    );

    expect(conversation.title).toBe('可见问题');
  });
});
