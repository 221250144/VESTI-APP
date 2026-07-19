import { describe, expect, it } from 'vitest';
import {
  getAgentKindDefinition,
  parsePromptImprovePayload,
  PROMPT_CONTINUE_MAX_CHARS,
  PROMPT_IMPROVE_MAX_NOTES,
} from './agentPrompts';
import type { RuntimeAgentSettings } from './settingsService';

const zhPreferences: RuntimeAgentSettings = {
  outputLanguage: 'zh-CN',
  includeThinking: true,
  includeToolDetails: true,
  customInstructions: '',
};

const SAMPLE_PROMPT = '请帮我总结下面的会议记录，要求分点输出。';

describe('prompt-improve kind', () => {
  it('builds a strict-JSON prompt carrying the original body', () => {
    const messages = getAgentKindDefinition('prompt-improve').buildPrompt({
      transcript: SAMPLE_PROMPT,
      preferences: zhPreferences,
    });
    expect(messages[0].role).toBe('system');
    expect(messages[1].role).toBe('user');
    expect(messages[1].content).toContain('improved');
    expect(messages[1].content).toContain('notes');
    expect(messages[1].content).toContain(SAMPLE_PROMPT);
  });

  it('parses clean JSON output and normalizes the shape', () => {
    const parsed = parsePromptImprovePayload(
      '{"improved": "  优化后的提示词  ", "notes": ["要点一", "要点二"]}',
    );
    expect(parsed).toEqual({ improved: '优化后的提示词', notes: ['要点一', '要点二'] });
  });

  it('tolerates Markdown code fences and surrounding prose', () => {
    const parsed = parsePromptImprovePayload(
      '好的，以下是结果：\n```json\n{"improved": "新提示词", "notes": ["改动"]}\n```\n希望对你有帮助。',
    );
    expect(parsed.improved).toBe('新提示词');
    expect(parsed.notes).toEqual(['改动']);
  });

  it('caps notes at 3 and drops non-string entries', () => {
    const parsed = parsePromptImprovePayload(
      JSON.stringify({
        improved: '新提示词',
        notes: ['一', '二', '三', '四', 42, null],
      }),
    );
    expect(parsed.notes).toHaveLength(PROMPT_IMPROVE_MAX_NOTES);
    expect(parsed.notes).toEqual(['一', '二', '三']);
  });

  it('accepts missing notes as an empty list', () => {
    const parsed = parsePromptImprovePayload('{"improved": "新提示词"}');
    expect(parsed).toEqual({ improved: '新提示词', notes: [] });
  });

  it('rejects output without a non-empty improved field', () => {
    expect(() => parsePromptImprovePayload('{"notes": ["只有要点"]}')).toThrow(/improved/);
    expect(() => parsePromptImprovePayload('{"improved": "   "}')).toThrow(/improved/);
    expect(() => parsePromptImprovePayload('完全不是 JSON')).toThrow(/JSON/);
  });

  it('kind parse() round-trips through normalized JSON', () => {
    const out = getAgentKindDefinition('prompt-improve').parse!(
      '```json\n{"improved": "新提示词", "notes": ["改动"]}\n```',
    );
    expect(JSON.parse(out)).toEqual({ improved: '新提示词', notes: ['改动'] });
  });
});

describe('prompt-continue kind', () => {
  it('builds a free-form continuation prompt carrying the original body', () => {
    const messages = getAgentKindDefinition('prompt-continue').buildPrompt({
      transcript: SAMPLE_PROMPT,
      preferences: zhPreferences,
    });
    expect(messages[1].role).toBe('user');
    expect(messages[1].content).toContain(SAMPLE_PROMPT);
  });

  it('parse passes through any non-empty text (lenient)', () => {
    const parse = getAgentKindDefinition('prompt-continue').parse!;
    const text = '请帮我总结下面的会议记录，要求分点输出。\n补充：每条不超过 50 字。';
    expect(parse(`  ${text}  `)).toBe(text);
  });

  it('parse rejects empty output', () => {
    const parse = getAgentKindDefinition('prompt-continue').parse!;
    expect(() => parse('   \n  ')).toThrow(/为空/);
  });

  it('parse caps runaway output', () => {
    const parse = getAgentKindDefinition('prompt-continue').parse!;
    const long = 'x'.repeat(PROMPT_CONTINUE_MAX_CHARS + 500);
    expect(parse(long)).toHaveLength(PROMPT_CONTINUE_MAX_CHARS);
  });
});
