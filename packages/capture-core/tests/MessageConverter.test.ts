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
});
