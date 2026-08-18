/**
 * injectedBlocks utility tests
 */

import { describe, expect, it } from 'vitest';
import { sanitizeCapturedText, stripInjectedContextBlocks } from '../src/utils/injectedBlocks.js';

describe('injectedBlocks', () => {
  it('removes environment and instruction blocks and keeps the user question', () => {
    const input = [
      '<environment_context>',
      'repo=/tmp/demo',
      '</environment_context>',
      '<timestamp>Monday, Jan 1, 2026, 9:00 AM (UTC+8)</timestamp>',
      '<user_query>请写一个 hello world</user_query>',
      '<system_reminder>记得更新上下文</system_reminder>',
    ].join('\n');

    expect(sanitizeCapturedText(input)).toBe('请写一个 hello world');
  });

  it('strips self-closing git-context lines', () => {
    const input = 'prelude <git-context repo="demo" files="3" /> after';
    expect(sanitizeCapturedText(input)).toBe('prelude after');
  });

  it('removes full git-context blocks', () => {
    const input = [
      'before',
      '<git-context>',
      'repo: demo',
      '</git-context>',
      'after',
    ].join('\n');

    expect(sanitizeCapturedText(input)).toBe('before after');
  });

  it('strips timestamp/user_info/system_notification together', () => {
    const input = [
      '<timestamp>2026-08-01T00:00:00Z</timestamp>',
      '<user_info>user=alice</user_info>',
      '<system_notification>你有 1 条未读消息</system_notification>',
      '现在给我生成摘要',
    ].join('\n');

    expect(sanitizeCapturedText(input)).toBe('现在给我生成摘要');
  });

  it('keeps meaningful user text when no injected tags exist', () => {
    expect(sanitizeCapturedText('普通中文文本')).toBe('普通中文文本');
  });

  it('stripInjectedContextBlocks and sanitizeCapturedText keep parity', () => {
    const input = [
      '头部说明 <user_instructions>仅供调试</user_instructions>',
      '<user_query>正式问题</user_query>',
      '<system_reminder>忽略</system_reminder>',
    ].join('\n');

    expect(stripInjectedContextBlocks(input)).toBe(
      sanitizeCapturedText(input),
    );
  });
});

