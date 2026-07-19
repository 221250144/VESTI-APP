import { describe, expect, it } from 'vitest';
import {
  buildDistillDirective,
  getAgentKindDefinition,
  parseClassifyPayload,
  parseDigestPayload,
  parseExtractPayload,
  parseRelayPayload,
  registerAgentKind,
  RELAY_HANDOFF_RULE_EN,
  RELAY_HANDOFF_RULE_ZH,
} from './agentPrompts';
import { parseDepositMaintainPayload } from '../shared/depositMaintain';
import type { RuntimeAgentSettings } from './settingsService';

const zhPreferences: RuntimeAgentSettings = {
  outputLanguage: 'zh-CN',
  includeThinking: true,
  includeToolDetails: true,
  customInstructions: '',
};

describe('agent kind registry', () => {
  it('builds the summary prompt with the ConversationSummaryV2 JSON contract (zh-CN)', () => {
    const messages = getAgentKindDefinition('summary').buildPrompt({
      transcript: 'TRANSCRIPT',
      preferences: zhPreferences,
    });
    expect(messages[0]).toEqual({
      role: 'system',
      content: '你是 Vesti 的会话总结助手。只能依据提供的会话，不补造事实。使用清晰、简洁的中文 Markdown。',
    });
    expect(messages[1].role).toBe('user');
    expect(messages[1].content).toContain('core_question');
    expect(messages[1].content).toContain('thinking_journey');
    expect(messages[1].content).toContain('meta_observations');
    expect(messages[1].content).toContain('JSON');
    expect(messages[1].content).toContain('TRANSCRIPT');
  });

  it('honors en-US output and appends custom instructions', () => {
    const messages = getAgentKindDefinition('summary').buildPrompt({
      transcript: 'T',
      preferences: { ...zhPreferences, outputLanguage: 'en-US', customInstructions: '只关注架构决策' },
    });
    expect(messages[0].content).toContain('Respond in clear English Markdown.');
    expect(messages[0].content).toContain('\n用户的长期分析偏好：只关注架构决策');
  });

  it('builds the explore prompt with the question or its default', () => {
    const withQuestion = getAgentKindDefinition('explore').buildPrompt({
      transcript: 'TRANSCRIPT',
      question: '还有哪些风险？',
      preferences: zhPreferences,
    });
    expect(withQuestion[0].content).toBe('你是 Vesti 的会话探索助手。仅依据提供的会话回答；区分事实、推断和建议，无法判断时明确说明。使用清晰、简洁的中文 Markdown。');
    expect(withQuestion[1].content).toBe('探索问题：还有哪些风险？\n\n会话内容：\nTRANSCRIPT');

    const withoutQuestion = getAgentKindDefinition('explore').buildPrompt({
      transcript: 'TRANSCRIPT',
      question: '',
      preferences: zhPreferences,
    });
    expect(withoutQuestion[1].content).toBe('探索问题：这段会话中还有哪些值得继续探索的方向？\n\n会话内容：\nTRANSCRIPT');
  });

  it('passes content through unparsed for the built-in kinds', () => {
    expect(getAgentKindDefinition('summary').parse).toBeUndefined();
    expect(getAgentKindDefinition('explore').parse).toBeUndefined();
  });

  it('throws for an unknown kind', () => {
    expect(() => getAgentKindDefinition('no-such-kind')).toThrow('未知的分析类型：no-such-kind');
  });

  it('allows registering a new kind', () => {
    registerAgentKind('test-kind', {
      buildPrompt: () => [{ role: 'user', content: 'hi' }],
      parse: raw => raw.toUpperCase(),
    });
    const definition = getAgentKindDefinition('test-kind');
    expect(definition.buildPrompt({ transcript: 'x', preferences: zhPreferences })).toEqual([{ role: 'user', content: 'hi' }]);
    expect(definition.parse?.('ok')).toBe('OK');
  });
});

describe('digest agent kind', () => {
  it('builds a strict-JSON prompt carrying the transcript', () => {
    const messages = getAgentKindDefinition('digest').buildPrompt({
      transcript: 'TRANSCRIPT',
      preferences: zhPreferences,
    });
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain('严格 JSON');
    expect(messages[1].content).toContain('one_liner');
    expect(messages[1].content).toContain('TRANSCRIPT');
  });

  it('parses and normalizes a valid payload', () => {
    const parsed = parseDigestPayload(JSON.stringify({
      one_liner: '  实现登录功能  ',
      key_topics: ['认证', ' ', 42],
      key_files: ['src/Login.tsx'],
      decisions: ['用 JWT'],
      open_questions: [],
      extra: 'ignored',
    }));
    expect(parsed).toEqual({
      one_liner: '实现登录功能',
      key_topics: ['认证'],
      key_files: ['src/Login.tsx'],
      decisions: ['用 JWT'],
      open_questions: [],
    });
  });

  it('accepts fenced JSON and surrounding prose', () => {
    const parsed = parseDigestPayload('结果如下：\n```json\n{"one_liner":"会话摘要","key_topics":[],"key_files":[],"decisions":[],"open_questions":[]}\n```');
    expect(parsed.one_liner).toBe('会话摘要');
  });

  it('rejects non-JSON output and missing one_liner', () => {
    expect(() => parseDigestPayload('完全不是 JSON')).toThrow('digest 输出不是 JSON');
    expect(() => parseDigestPayload('{"key_topics":[]}')).toThrow('digest 输出缺少 one_liner');
  });

  it('the kind parse returns a normalized JSON string', () => {
    const definition = getAgentKindDefinition('digest');
    const normalized = definition.parse?.('{"one_liner":" 摘要 ","key_topics":["a"],"key_files":[],"decisions":[],"open_questions":[]}');
    expect(JSON.parse(normalized ?? '')).toEqual({
      one_liner: '摘要',
      key_topics: ['a'],
      key_files: [],
      decisions: [],
      open_questions: [],
    });
    expect(() => definition.parse?.('坏输出')).toThrow();
  });
});

describe('classify agent kind', () => {
  it('builds a strict-JSON prompt that prefers existing topics', () => {
    const messages = getAgentKindDefinition('classify').buildPrompt({
      transcript: 'TRANSCRIPT',
      preferences: zhPreferences,
    });
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain('严格 JSON');
    expect(messages[1].content).toContain('优先归入现有主题');
    expect(messages[1].content).toContain('topicPath');
    expect(messages[1].content).toContain('confidence');
    expect(messages[1].content).toContain('TRANSCRIPT');
  });

  it('parses and normalizes a valid payload', () => {
    const parsed = parseClassifyPayload(JSON.stringify([
      { ref: 1, topicPath: [' 前端 ', 'React'], newTopic: true, confidence: 0.9 },
      { ref: 2, topicPath: ['工具'], confidence: 7 },
      { ref: 3, topicPath: ['杂项'] },
    ]));
    expect(parsed).toEqual([
      { ref: 1, topicPath: ['前端', 'React'], newTopic: true, confidence: 0.9 },
      // out-of-range confidence is clamped, missing confidence defaults to 0.5
      { ref: 2, topicPath: ['工具'], newTopic: false, confidence: 1 },
      { ref: 3, topicPath: ['杂项'], newTopic: false, confidence: 0.5 },
    ]);
  });

  it('accepts fenced JSON', () => {
    const parsed = parseClassifyPayload('```json\n[{"ref":1,"topicPath":["前端"]}]\n```');
    expect(parsed).toEqual([{ ref: 1, topicPath: ['前端'], newTopic: false, confidence: 0.5 }]);
  });

  it('rejects non-JSON output', () => {
    expect(() => parseClassifyPayload('完全不是 JSON')).toThrow('classify 输出不是 JSON 数组');
    expect(() => parseClassifyPayload('{"ref":1}')).toThrow('classify 输出不是 JSON 数组');
  });

  it('rejects illegal refs', () => {
    expect(() => parseClassifyPayload('[{"ref":0,"topicPath":["a"]}]')).toThrow('classify 输出包含非法 ref');
    expect(() => parseClassifyPayload('[{"ref":1.5,"topicPath":["a"]}]')).toThrow('classify 输出包含非法 ref');
    expect(() => parseClassifyPayload('[{"ref":"1","topicPath":["a"]}]')).toThrow('classify 输出包含非法 ref');
  });

  it('rejects empty or too-deep topic paths', () => {
    expect(() => parseClassifyPayload('[{"ref":1,"topicPath":[]}]')).toThrow('topicPath');
    expect(() => parseClassifyPayload('[{"ref":1,"topicPath":["a","b","c","d"]}]')).toThrow('1-3 层');
    expect(() => parseClassifyPayload('[{"ref":1,"topicPath":["a","  "]}]')).toThrow('topicPath');
  });

  it('the kind parse returns a normalized JSON string', () => {
    const definition = getAgentKindDefinition('classify');
    const normalized = definition.parse?.('[{"ref":2,"topicPath":[" 前端 "],"confidence":"high"}]');
    expect(JSON.parse(normalized ?? '')).toEqual([
      { ref: 2, topicPath: ['前端'], newTopic: false, confidence: 0.5 },
    ]);
    expect(() => definition.parse?.('坏输出')).toThrow();
  });
});

describe('relay agent kind', () => {
  it('builds a strict-JSON prompt describing the handoff schema', () => {
    const messages = getAgentKindDefinition('relay').buildPrompt({
      transcript: 'TRANSCRIPT',
      preferences: zhPreferences,
    });
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain('严格 JSON');
    expect(messages[1].content).toContain('suggested_prompt');
    expect(messages[1].content).toContain('key_files');
    expect(messages[1].content).toContain('800 字以内');
    // schema v2 fields
    expect(messages[1].content).toContain('completed');
    expect(messages[1].content).toContain('in_progress');
    expect(messages[1].content).toContain('git_state');
    expect(messages[1].content).toContain('failed_paths');
    expect(messages[1].content).toContain('verification');
    expect(messages[1].content).toContain('confidence');
    expect(messages[1].content).toContain('TRANSCRIPT');
  });

  it('pins the verify-first handoff rule into the prompt (zh and en)', () => {
    const zh = getAgentKindDefinition('relay').buildPrompt({
      transcript: 'T',
      preferences: zhPreferences,
    });
    expect(zh[1].content).toContain(RELAY_HANDOFF_RULE_ZH);
    expect(zh[1].content).toContain('原样结尾');
    const en = getAgentKindDefinition('relay').buildPrompt({
      transcript: 'T',
      preferences: { ...zhPreferences, outputLanguage: 'en-US' },
    });
    expect(en[1].content).toContain(RELAY_HANDOFF_RULE_EN);
    expect(en[1].content).toContain('MUST end with this exact fixed sentence');
  });

  it('parses and normalizes a valid v2 payload', () => {
    const parsed = parseRelayPayload(JSON.stringify({
      title: '  播放器重构交接  ',
      goal: '把播放器迁移到新架构',
      completed: ['解码层拆分', ' ', 42],
      in_progress: ['渲染层接入（卡在字幕同步）'],
      git_state: { branch: ' feature/player ', dirty_files: ['src/player/render.ts'], last_commits: ['拆分解码层'] },
      key_decisions: ['采用插件化解码'],
      key_files: [
        { path: ' src/player/decoder.ts ', why: '解码入口', last_state: '已拆分', extra: 'ignored' },
        { path: '   ', why: 'x', last_state: 'y' },
        'not-an-object',
      ],
      failed_paths: [{ approach: '直接重写渲染线程', why_failed: '丢帧严重' }, { approach: '', why_failed: 'x' }],
      open_issues: ['字幕同步偶发漂移'],
      verification: { commands: ['pnpm test'], last_results: ['通过 42 项'] },
      next_steps: ['接入新渲染层'],
      confidence: { overall: 1.4, low_areas: ['字幕同步'] },
      suggested_prompt: '背景：正在重构播放器……',
      extra: 'ignored',
    }));
    expect(parsed).toEqual({
      title: '播放器重构交接',
      goal: '把播放器迁移到新架构',
      current_state: '',
      completed: ['解码层拆分'],
      in_progress: ['渲染层接入（卡在字幕同步）'],
      git_state: { branch: 'feature/player', dirty_files: ['src/player/render.ts'], last_commits: ['拆分解码层'] },
      key_decisions: ['采用插件化解码'],
      key_files: [{ path: 'src/player/decoder.ts', why: '解码入口', last_state: '已拆分' }],
      failed_paths: [{ approach: '直接重写渲染线程', why_failed: '丢帧严重' }],
      open_issues: ['字幕同步偶发漂移'],
      verification: { commands: ['pnpm test'], last_results: ['通过 42 项'] },
      next_steps: ['接入新渲染层'],
      confidence: { overall: 1, low_areas: ['字幕同步'] },
      suggested_prompt: '背景：正在重构播放器……',
    });
  });

  it('stays backward compatible: v1 payloads parse with empty v2 defaults', () => {
    const parsed = parseRelayPayload(JSON.stringify({
      title: '交接',
      goal: 'g',
      current_state: '已完成解码层拆分',
      key_decisions: ['采用插件化解码'],
      key_files: [],
      open_issues: [],
      next_steps: [],
      suggested_prompt: 'p',
    }));
    expect(parsed).toEqual({
      title: '交接',
      goal: 'g',
      current_state: '已完成解码层拆分',
      completed: [],
      in_progress: [],
      git_state: { dirty_files: [], last_commits: [] },
      key_decisions: ['采用插件化解码'],
      key_files: [],
      failed_paths: [],
      open_issues: [],
      verification: { commands: [], last_results: [] },
      next_steps: [],
      suggested_prompt: 'p',
    });
    // confidence stays absent without a usable number (no misleading badge)
    expect(parsed.confidence).toBeUndefined();
    expect(parseRelayPayload(JSON.stringify({
      title: 't', goal: 'g', suggested_prompt: 'p', confidence: { low_areas: ['x'] },
    })).confidence).toBeUndefined();
  });

  it('accepts fenced JSON and surrounding prose', () => {
    const parsed = parseRelayPayload('结果：\n```json\n{"title":"交接","goal":"g","suggested_prompt":"p"}\n```');
    expect(parsed.title).toBe('交接');
    expect(parsed.completed).toEqual([]);
    expect(parsed.verification).toEqual({ commands: [], last_results: [] });
  });

  it('caps the suggested prompt at 800 chars', () => {
    const parsed = parseRelayPayload(JSON.stringify({
      title: 't',
      goal: 'g',
      current_state: 'c',
      suggested_prompt: ` ${'长'.repeat(1_000)} `,
    }));
    expect(parsed.suggested_prompt).toHaveLength(800);
  });

  it('rejects non-JSON output and missing required fields', () => {
    expect(() => parseRelayPayload('完全不是 JSON')).toThrow('relay 输出不是 JSON');
    expect(() => parseRelayPayload('{"goal":"g","current_state":"c","suggested_prompt":"p"}')).toThrow('relay 输出缺少 title');
    expect(() => parseRelayPayload('{"title":"t","current_state":"c","suggested_prompt":"p"}')).toThrow('relay 输出缺少 goal');
    expect(() => parseRelayPayload('{"title":"t","goal":"g","current_state":"c","suggested_prompt":"  "}')).toThrow('relay 输出缺少 suggested_prompt');
    expect(() => parseRelayPayload('[1,2,3]')).toThrow();
  });

  it('the kind parse returns a normalized JSON string', () => {
    const definition = getAgentKindDefinition('relay');
    const normalized = definition.parse?.('{"title":" t ","goal":"g","current_state":"c","suggested_prompt":"p","key_decisions":[" a ",1]}');
    expect(JSON.parse(normalized ?? '')).toEqual({
      title: 't',
      goal: 'g',
      current_state: 'c',
      completed: [],
      in_progress: [],
      git_state: { dirty_files: [], last_commits: [] },
      key_decisions: ['a'],
      key_files: [],
      failed_paths: [],
      open_issues: [],
      verification: { commands: [], last_results: [] },
      next_steps: [],
      suggested_prompt: 'p',
    });
    expect(() => definition.parse?.('坏输出')).toThrow();
  });
});

describe('deposit-maintain agent kind', () => {
  it('builds a strict-JSON prompt referencing both documents', () => {
    const messages = getAgentKindDefinition('deposit-maintain').buildPrompt({
      transcript: '【旧版本沉淀内容】\nOLD\n\n【新提炼内容】\nNEW',
      preferences: zhPreferences,
    });
    expect(messages[0].content).toContain('严格 JSON');
    expect(messages[1].content).toContain('ADD|UPDATE|DELETE|NOOP');
    expect(messages[1].content).toContain('merged_markdown');
    expect(messages[1].content).toContain('OLD');
    expect(messages[1].content).toContain('NEW');
  });

  it('parses and normalizes a valid payload', () => {
    const parsed = parseDepositMaintainPayload(JSON.stringify({
      ops: [
        { op: 'ADD', section: ' 技能栈 ', new_text: '熟悉 pnpm monorepo', reason: '新会话提到' },
        { op: 'UPDATE', section: '偏好', old_text: '喜欢简洁回复', new_text: '喜欢简洁、带例子的回复', reason: '偏好细化' },
        { op: 'DELETE', section: '工具', old_text: '使用 yarn', reason: '已迁移 pnpm' },
        { op: 'NOOP', section: '禁忌', reason: '仍然成立' },
      ],
      merged_markdown: '# 背景知识\n\n……',
    }));
    expect(parsed.ops).toHaveLength(4);
    expect(parsed.ops[0]).toEqual({
      op: 'ADD',
      section: '技能栈',
      old_text: undefined,
      new_text: '熟悉 pnpm monorepo',
      reason: '新会话提到',
    });
    expect(parsed.merged_markdown).toBe('# 背景知识\n\n……');
  });

  it('rejects a bad op enum and an empty section', () => {
    expect(() => parseDepositMaintainPayload(JSON.stringify({
      ops: [{ op: 'MERGE', section: 'x', reason: 'r' }],
      merged_markdown: 'm',
    }))).toThrow('未知 op');
    expect(() => parseDepositMaintainPayload(JSON.stringify({
      ops: [{ op: 'ADD', section: '  ', reason: 'r' }],
      merged_markdown: 'm',
    }))).toThrow('缺少 section');
  });

  it('rejects missing or empty merged_markdown and non-JSON output', () => {
    expect(() => parseDepositMaintainPayload(JSON.stringify({ ops: [] })))
      .toThrow('缺少 merged_markdown');
    expect(() => parseDepositMaintainPayload(JSON.stringify({ ops: [], merged_markdown: '  ' })))
      .toThrow('缺少 merged_markdown');
    expect(() => parseDepositMaintainPayload('不是 JSON')).toThrow('不是 JSON');
  });

  it('the kind parse returns a normalized JSON string', () => {
    const definition = getAgentKindDefinition('deposit-maintain');
    const normalized = definition.parse?.('```json\n{"ops":[{"op":"ADD","section":"s","reason":"r"}],"merged_markdown":" body "}\n```');
    expect(JSON.parse(normalized ?? '')).toEqual({
      ops: [{ op: 'ADD', section: 's', old_text: undefined, new_text: undefined, reason: 'r' }],
      merged_markdown: 'body',
    });
    expect(() => definition.parse?.('坏输出')).toThrow();
  });
});

describe('extract agent kind', () => {
  it('builds a strict-JSON prompt describing the extract schema', () => {
    const messages = getAgentKindDefinition('extract').buildPrompt({
      transcript: 'TRANSCRIPT',
      preferences: zhPreferences,
    });
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain('严格 JSON');
    expect(messages[1].content).toContain('knowledge_points');
    expect(messages[1].content).toContain('code_snippets');
    expect(messages[1].content).toContain('decisions');
    expect(messages[1].content).toContain('prompts');
    expect(messages[1].content).toContain('TRANSCRIPT');
  });

  it('parses and normalizes a valid payload, filtering bad entries', () => {
    const parsed = parseExtractPayload(JSON.stringify({
      knowledge_points: ['  SQLite 事务要包住批量写入 ', ' ', 42],
      code_snippets: [
        { language: ' ts ', code: 'await db.transaction(...)', why: '批量写入范式', extra: 'ignored' },
        { language: 'ts', code: '   ', why: '空代码应被过滤' },
        'not-an-object',
      ],
      decisions: [
        { title: ' 用 Dexie 版本链 ', context: '需要历史版本', decision: 'prev_id 链', consequences: '可回看', extra: 'ignored' },
        { title: ' ', context: 'x', decision: ' ', consequences: 'y' },
      ],
      prompts: [' 提炼这些会话的架构决策 '],
      extra: 'ignored',
    }));
    expect(parsed).toEqual({
      knowledge_points: ['SQLite 事务要包住批量写入'],
      code_snippets: [{ language: 'ts', code: 'await db.transaction(...)', why: '批量写入范式' }],
      decisions: [{ title: '用 Dexie 版本链', context: '需要历史版本', decision: 'prev_id 链', consequences: '可回看' }],
      prompts: ['提炼这些会话的架构决策'],
    });
  });

  it('accepts fenced JSON and surrounding prose', () => {
    const parsed = parseExtractPayload('结果：\n```json\n{"knowledge_points":["要点"]}\n```');
    expect(parsed).toEqual({
      knowledge_points: ['要点'],
      code_snippets: [],
      decisions: [],
      prompts: [],
    });
  });

  it('rejects non-JSON output, non-object JSON and all-empty payloads', () => {
    expect(() => parseExtractPayload('完全不是 JSON')).toThrow('extract 输出不是 JSON');
    expect(() => parseExtractPayload('[1,2,3]')).toThrow();
    expect(() => parseExtractPayload('{"knowledge_points":[],"code_snippets":[]}')).toThrow(
      'extract 输出没有任何有效内容',
    );
    expect(() => parseExtractPayload('{}')).toThrow('extract 输出没有任何有效内容');
  });

  it('the kind parse returns a normalized JSON string', () => {
    const definition = getAgentKindDefinition('extract');
    const normalized = definition.parse?.('{"knowledge_points":[" a ",1]}');
    expect(JSON.parse(normalized ?? '')).toEqual({
      knowledge_points: ['a'],
      code_snippets: [],
      decisions: [],
      prompts: [],
    });
    expect(() => definition.parse?.('坏输出')).toThrow();
  });
});

describe('distill agent kind', () => {
  it('parameterizes the prompt per template', () => {
    const background = getAgentKindDefinition('distill').buildPrompt({
      transcript: 'TRANSCRIPT',
      template: 'background_knowledge',
      preferences: zhPreferences,
    });
    expect(background[0].content).toContain('Markdown');
    expect(background[1].content).toContain('个人背景知识');
    expect(background[1].content).toContain('技能栈');
    expect(background[1].content).toContain('TRANSCRIPT');

    const project = getAgentKindDefinition('distill').buildPrompt({
      transcript: 'TRANSCRIPT',
      template: 'project_state',
      preferences: zhPreferences,
    });
    expect(project[1].content).toContain('项目的开发状态');
    expect(project[1].content).toContain('架构');

    const writing = getAgentKindDefinition('distill').buildPrompt({
      transcript: 'TRANSCRIPT',
      template: 'writing_style',
      preferences: zhPreferences,
    });
    expect(writing[1].content).toContain('写作风格');
    expect(writing[1].content).toContain('语气');
  });

  it('carries the custom instruction for the custom template', () => {
    const messages = getAgentKindDefinition('distill').buildPrompt({
      transcript: 'TRANSCRIPT',
      template: 'custom',
      question: '提炼关于理财的观点',
      preferences: zhPreferences,
    });
    expect(messages[1].content).toContain('提炼关于理财的观点');
    expect(messages[1].content).toContain('TRANSCRIPT');
  });

  it('honors en-US output language in the system prompt', () => {
    const messages = getAgentKindDefinition('distill').buildPrompt({
      transcript: 'T',
      template: 'background_knowledge',
      preferences: { ...zhPreferences, outputLanguage: 'en-US' },
    });
    expect(messages[0].content).toContain('Respond in clear English Markdown.');
  });

  it('rejects a custom template without instruction and unknown templates', () => {
    expect(() =>
      getAgentKindDefinition('distill').buildPrompt({
        transcript: 'T',
        template: 'custom',
        question: '  ',
        preferences: zhPreferences,
      }),
    ).toThrow('自定义提炼需要先填写提炼指令');
    expect(() => buildDistillDirective('no-such-template' as never)).toThrow('未知的沉淀模板');
  });

  it('parses leniently: any non-empty body passes, empty throws', () => {
    const definition = getAgentKindDefinition('distill');
    expect(definition.parse?.('\n\n# 项目状态\n\n正文……\n')).toBe('# 项目状态\n\n正文……');
    expect(() => definition.parse?.('   \n ')).toThrow('distill 输出为空');
  });
});

describe('persona kind (P5 思维意象)', () => {
  const transcript = [
    '型码：qTWS',
    '意象：马孔多的蝴蝶',
    '判词：黄色的蝴蝶成群而至——被纷飞的灵感环绕，所到之处皆绚烂',
    '近期关注：向量检索 (×4)、本地优先 (×3)',
    '样本：来自 12 段对话',
  ].join('\n');

  it('forbids re-typing and preaching, and feeds the imagery input through', () => {
    const messages = getAgentKindDefinition('persona').buildPrompt({
      transcript,
      preferences: zhPreferences,
    });
    expect(messages[0].content).toContain('严禁改变、重新选择或质疑意象与型码');
    expect(messages[0].content).toContain('无人称');
    expect(messages[0].content).toContain('1-2 句');
    expect(messages[1].content).toContain('马孔多的蝴蝶');
    expect(messages[1].content).toContain('向量检索');
  });

  it('follows the en-US output language', () => {
    const messages = getAgentKindDefinition('persona').buildPrompt({
      transcript,
      preferences: { ...zhPreferences, outputLanguage: 'en-US' },
    });
    expect(messages[0].content).toContain('Respond in clear English Markdown.');
  });

  it('parses leniently: trims, collapses whitespace, caps at 200 chars', () => {
    const definition = getAgentKindDefinition('persona');
    expect(definition.parse?.('  蝴蝶最近总绕着\n向量检索 飞。 \n')).toBe('蝴蝶最近总绕着 向量检索 飞。');
    expect(definition.parse?.('x'.repeat(260))).toHaveLength(200);
    expect(() => definition.parse?.('   \n ')).toThrow('persona 输出为空');
  });
});
