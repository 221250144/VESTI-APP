import { describe, expect, it } from 'vitest';
import { sanitizeCapturedText, stripInjectedContextBlocks } from '../src/injectedBlocks.js';

describe('captured-text sanitizer', () => {
  it('removes consecutive leading Codex envelopes and preserves the real request', () => {
    const input = [
      '<recommended_plugins>',
      '- Gmail (gmail@example)',
      '- Notion (notion@example)',
      '</recommended_plugins>',
      '<environment_context>',
      '  <cwd>D:\\Vesti-app</cwd>',
      '</environment_context>',
      '<user_instructions>Answer concisely.</user_instructions>',
      '',
      '请修复捕获到系统提示词的问题。',
      '',
      '保留这一段格式。',
    ].join('\n');

    expect(sanitizeCapturedText(input)).toBe([
      '请修复捕获到系统提示词的问题。',
      '',
      '保留这一段格式。',
    ].join('\n'));
  });

  it('removes trailing system notifications without flattening Markdown', () => {
    const input = [
      '第一段',
      '',
      '- 项目一',
      '- 项目二',
      '<system_reminder>generated reminder</system_reminder>',
    ].join('\n');

    expect(stripInjectedContextBlocks(input)).toBe('第一段\n\n- 项目一\n- 项目二');
  });

  it('unwraps a user_query envelope while keeping its content', () => {
    expect(sanitizeCapturedText('<user_query>\n真实问题\n</user_query>')).toBe('真实问题');
  });

  it('keeps similar tags when they are part of ordinary prose or code', () => {
    const input = '示例：`<environment_context>demo</environment_context>` 不应被删除。';
    expect(sanitizeCapturedText(input)).toBe(input);
  });

  it('returns an empty string for a system-only envelope', () => {
    expect(sanitizeCapturedText('<recommended_plugins>plugins</recommended_plugins>')).toBe('');
  });

  it('drops known whole-message control records used as user messages', () => {
    expect(sanitizeCapturedText('# AGENTS.md instructions for D:\\work\nGenerated rules')).toBe('');
    expect(sanitizeCapturedText('<turn_aborted reason="interrupted" />')).toBe('');
    expect(sanitizeCapturedText('<ide_opened_file>C:\\work\\app.ts</ide_opened_file>')).toBe('');
  });
});
