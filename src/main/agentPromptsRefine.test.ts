import { describe, expect, it } from 'vitest';
import {
  getAgentKindDefinition,
  parsePromptDistillPayload,
  parsePromptImprovePayload,
  PROMPT_CONTINUE_MAX_CHARS,
  PROMPT_DISTILL_MAX_FRAGMENTS,
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

  it('threads the user instruction into the refine prompt when provided', () => {
    const messages = getAgentKindDefinition('prompt-improve').buildPrompt({
      transcript: SAMPLE_PROMPT,
      question: '更简洁',
      preferences: zhPreferences,
    });
    expect(messages[1].content).toContain('更简洁');
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

describe('prompt-distill kind', () => {
  it('builds a prompt-engineer prompt carrying the candidate turns', () => {
    const messages = getAgentKindDefinition('prompt-distill').buildPrompt({
      transcript: '1. 总结会议纪要\n\n2. 审查这段代码',
      preferences: zhPreferences,
    });
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain('提示词工程师');
    expect(messages[0].content).toContain('{{变量}}');
    expect(messages[1].content).toContain('1. 总结会议纪要');
    expect(messages[1].content).toContain('JSON 数组');
  });

  it('parses a clean fragment array and normalizes the shape', () => {
    const parsed = parsePromptDistillPayload(
      JSON.stringify([
        { title: ' 会议纪要结构化 ', body: '请把下面的会议纪要结构化：{{纪要文本}}，分决议/待办/风险三段输出。', category: ' Writing ' },
        { title: '无分类', body: '请扮演资深代码审查员，逐行审查 {{代码}}，按严重级别列出问题。' },
      ]),
    );
    expect(parsed).toEqual([
      { title: '会议纪要结构化', body: '请把下面的会议纪要结构化：{{纪要文本}}，分决议/待办/风险三段输出。', category: 'Writing' },
      { title: '无分类', body: '请扮演资深代码审查员，逐行审查 {{代码}}，按严重级别列出问题。', category: null },
    ]);
  });

  it('tolerates code fences and drops invalid / too-short / duplicate fragments', () => {
    const parsed = parsePromptDistillPayload(
      '```json\n' + JSON.stringify([
        { title: '太短', body: '总结一下' },
        { title: '', body: 42 },
        'not-an-object',
        { title: '甲', body: '请把 {{文本}} 翻译成地道的英文，保持专业语气，术语前后一致。' },
        { title: '乙', body: '请把 {{文本}} 翻译成地道的英文，保持专业语气，术语前后一致。' },
      ]) + '\n```',
    );
    expect(parsed).toHaveLength(1);
    expect(parsed[0].title).toBe('甲');
  });

  it('degrades malformed output to an empty array (caller falls back to heuristics)', () => {
    expect(parsePromptDistillPayload('这不是 JSON')).toEqual([]);
    expect(parsePromptDistillPayload('{"not": "an array"}')).toEqual([]);
    expect(getAgentKindDefinition('prompt-distill').parse?.('这不是 JSON')).toBe('[]');
  });

  it('caps the fragment count', () => {
    const many = Array.from({ length: 10 }, (_, index) => ({
      title: `模板${index}`,
      body: `这是第 ${index} 条足够长的可复用提示词模板正文，包含 {{变量}}。`,
    }));
    expect(parsePromptDistillPayload(JSON.stringify(many))).toHaveLength(PROMPT_DISTILL_MAX_FRAGMENTS);
  });
});
