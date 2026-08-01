/**
 * MessageConverter Tests
 * Tests MessageSource classification and Turn detection
 */

import { describe, it, expect } from 'vitest';
import { MessageConverter } from '../src/storage/MessageConverter.js';
import type { ParsedSession, ParsedMessage } from '../src/types/agent.js';

describe('MessageConverter', () => {
  describe('MessageSource Classification', () => {
    it('should classify real user input', () => {
      const session: ParsedSession = {
        sessionId: 'test-1',
        platform: 'claude-code',
        projectPath: '/test',
        messages: [
          {
            uuid: 'msg-1',
            type: 'user',
            role: 'user',
            timestamp: 1000,
            contentText: 'Hello',
            isToolResult: false,
            depth: 0,
          },
        ],
        toolExecutions: [],
        subagents: [],
        tokenUsage: {
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalCacheCreationTokens: 0,
          totalCacheReadTokens: 0,
          models: new Set(),
        },
        startTime: 1000,
      };

      const result = MessageConverter.convertV2(session);
      expect(result.messages[0].source).toBe('user_input');
    });

    it('should classify tool_result messages', () => {
      const session: ParsedSession = {
        sessionId: 'test-2',
        platform: 'claude-code',
        projectPath: '/test',
        messages: [
          {
            uuid: 'msg-1',
            type: 'user',
            role: 'user',
            timestamp: 1000,
            toolResults: [{ toolUseId: 'tool-1', content: 'output', isError: false }],
            isToolResult: true,
            depth: 0,
          },
        ],
        toolExecutions: [],
        subagents: [],
        tokenUsage: {
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalCacheCreationTokens: 0,
          totalCacheReadTokens: 0,
          models: new Set(),
        },
        startTime: 1000,
      };

      const result = MessageConverter.convertV2(session);
      expect(result.messages[0].source).toBe('tool_result');
    });

    it('should classify assistant text', () => {
      const session: ParsedSession = {
        sessionId: 'test-3',
        platform: 'claude-code',
        projectPath: '/test',
        messages: [
          {
            uuid: 'msg-1',
            type: 'assistant',
            role: 'assistant',
            timestamp: 1000,
            contentText: 'Response',
            isToolResult: false,
            depth: 0,
          },
        ],
        toolExecutions: [],
        subagents: [],
        tokenUsage: {
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalCacheCreationTokens: 0,
          totalCacheReadTokens: 0,
          models: new Set(),
        },
        startTime: 1000,
      };

      const result = MessageConverter.convertV2(session);
      expect(result.messages[0].source).toBe('assistant_text');
    });

    it('should classify tool_request', () => {
      const session: ParsedSession = {
        sessionId: 'test-4',
        platform: 'claude-code',
        projectPath: '/test',
        messages: [
          {
            uuid: 'msg-1',
            type: 'assistant',
            role: 'assistant',
            timestamp: 1000,
            toolCalls: [{ id: 'tool-1', name: 'Bash', input: 'ls' }],
            isToolResult: false,
            depth: 0,
          },
        ],
        toolExecutions: [],
        subagents: [],
        tokenUsage: {
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalCacheCreationTokens: 0,
          totalCacheReadTokens: 0,
          models: new Set(),
        },
        startTime: 1000,
      };

      const result = MessageConverter.convertV2(session);
      expect(result.messages[0].source).toBe('tool_request');
    });
  });

  describe('Token usage events', () => {
    const baseSession = (): ParsedSession => ({
      sessionId: 'token-session',
      platform: 'claude-code',
      projectPath: '/test',
      messages: [{
        uuid: 'assistant-1',
        type: 'assistant',
        role: 'assistant',
        timestamp: Date.UTC(2026, 6, 21, 23, 59),
        contentText: 'Response',
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          cacheCreationTokens: 3,
          cacheReadTokens: 40,
          model: 'claude-test',
        },
        isToolResult: false,
        depth: 0,
      }],
      toolExecutions: [],
      subagents: [],
      tokenUsage: {
        totalInputTokens: 100,
        totalOutputTokens: 20,
        totalCacheCreationTokens: 3,
        totalCacheReadTokens: 40,
        models: new Set(['claude-test']),
      },
      startTime: Date.UTC(2026, 6, 21, 23, 59),
    });

    it('derives timestamped events from message-level usage', () => {
      const result = MessageConverter.convertV2(baseSession());

      expect(result.tokenUsageEvents).toHaveLength(1);
      expect(result.tokenUsageEvents[0]).toMatchObject({
        sessionId: 'claude-code:token-session',
        timestamp: Date.UTC(2026, 6, 21, 23, 59),
        inputTokens: 100,
        outputTokens: 20,
        cacheCreationTokens: 3,
        cacheReadTokens: 40,
        model: 'claude-test',
        source: 'message_usage',
      });
    });

    it('prefers explicit adapter events instead of double-counting message usage', () => {
      const session = baseSession();
      session.tokenUsageEvents = [{
        id: 'reported-1',
        timestamp: Date.UTC(2026, 6, 22, 0, 1),
        inputTokens: 250,
        outputTokens: 30,
        cacheCreationTokens: 0,
        cacheReadTokens: 200,
        reasoningTokens: 9,
        model: 'explicit-model',
        source: 'reported_usage',
      }];

      const result = MessageConverter.convertV2(session);

      expect(result.tokenUsageEvents).toHaveLength(1);
      expect(result.tokenUsageEvents[0]).toMatchObject({
        inputTokens: 250,
        outputTokens: 30,
        reasoningTokens: 9,
        model: 'explicit-model',
        source: 'reported_usage',
      });
    });
  });
});
