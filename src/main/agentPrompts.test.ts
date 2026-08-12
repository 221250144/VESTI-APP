import { describe, expect, it } from 'vitest';
import {
  buildDistillDirective,
  getAgentKindDefinition,
  parseClassifyPayload,
  parseDigestPayload,
  parseExtractPayload,
  parseRelayPayload,
  parseRelayPayloadV2,
  registerAgentKind,
  RELAY_HANDOFF_PREFIX_EN,
  RELAY_HANDOFF_PREFIX_ZH,
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

  it('pins numeric-fidelity rules with concrete counterexamples', () => {
    const messages = getAgentKindDefinition('digest').buildPrompt({
      transcript: 'TRANSCRIPT',
      preferences: zhPreferences,
    });
    const prompt = messages[1].content;
    // Hard rule: values/units must be kept verbatim, never generalized.
    expect(prompt).toContain('必须原样保留数值与单位');
    expect(prompt).toContain('版本号');
    // Counterexamples stay in the prompt (bench C: numeric coverage 6.4%).
    expect(prompt).toContain('超时时间定为 30s');
    expect(prompt).toContain('v2.5.0');
    expect(prompt).toContain('1500 元');
    // one_liner / key_topics / decisions are all named as in-scope.
    expect(prompt).toContain('one_liner、key_topics 和 decisions');
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
    // V2: field renamed from suggested_prompt to handoffPrompt.
    expect(messages[1].content).toContain('handoffPrompt');
    // V2: key_files → files (program-extracted anchors)
    expect(messages[1].content).toContain('files');
    expect(messages[1].content).toContain('1200 字以内');
    // schema v2 fields
    expect(messages[1].content).toContain('completed');
    expect(messages[1].content).toContain('inProgress');
    expect(messages[1].content).toContain('blocked');
    // V2: failed_paths → failedPaths (camelCase)
    expect(messages[1].content).toContain('failedPaths');
    expect(messages[1].content).toContain('verification');
    expect(messages[1].content).toContain('verifyFirst');
    expect(messages[1].content).toContain('confidence');
    // V2: new fields
    expect(messages[1].content).toContain('environment');
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

  it('pins the handoff framing prefix into the prompt (zh and en)', () => {
    const zh = getAgentKindDefinition('relay').buildPrompt({
      transcript: 'T',
      preferences: zhPreferences,
    });
    expect(zh[1].content).toContain(RELAY_HANDOFF_PREFIX_ZH);
    expect(zh[1].content).toContain('原样开头');
    const en = getAgentKindDefinition('relay').buildPrompt({
      transcript: 'T',
      preferences: { ...zhPreferences, outputLanguage: 'en-US' },
    });
    expect(en[1].content).toContain(RELAY_HANDOFF_PREFIX_EN);
    expect(en[1].content).toContain('MUST start with this exact fixed sentence');
  });

  it('pins key_files to the extracted anchor list and failed_paths to retention', () => {
    const zh = getAgentKindDefinition('relay').buildPrompt({
      transcript: 'T',
      preferences: zhPreferences,
    });
    expect(zh[1].content).toContain('关键文件（程序提取，带锚点）');
    expect(zh[1].content).toContain('不得虚构清单之外的文件');
    expect(zh[1].content).toContain('失败尝试与否决原因');
    const en = getAgentKindDefinition('relay').buildPrompt({
      transcript: 'T',
      preferences: { ...zhPreferences, outputLanguage: 'en-US' },
    });
    expect(en[1].content).toContain('never invent files beyond it');
    expect(en[1].content).toContain('failed attempt and rejection reason');
  });

  it('shows the schema with straight JSON quotes so the model echoes parseable JSON', () => {
    const zh = getAgentKindDefinition('relay').buildPrompt({
      transcript: 'T',
      preferences: zhPreferences,
    });
    // Curly quotes (“”) in the template invite the model to reproduce them,
    // which breaks JSON.parse downstream — the schema must stay ASCII-quoted.
    expect(zh[1].content).toContain('"meta"');
    expect(zh[1].content).toContain('"verifyFirst"');
    expect(zh[1].content).not.toContain('“meta”');
    const en = getAgentKindDefinition('relay').buildPrompt({
      transcript: 'T',
      preferences: { ...zhPreferences, outputLanguage: 'en-US' },
    });
    expect(en[1].content).toContain('"meta"');
    expect(en[1].content).not.toContain('“meta”');
  });

  it('pins the verify-first checklist and the project-memory precedence rules (zh and en)', () => {
    const zh = getAgentKindDefinition('relay').buildPrompt({
      transcript: 'T',
      preferences: zhPreferences,
    });
    expect(zh[1].content).toContain('接手先验证');
    expect(zh[1].content).toContain('## 项目记忆（跨会话状态，优先采信）');
    expect(zh[1].content).toContain('以项目记忆为准');
    // Per-conversation heads are the compressed summaries to synthesize from.
    expect(zh[1].content).toContain('压缩摘要');
    const en = getAgentKindDefinition('relay').buildPrompt({
      transcript: 'T',
      preferences: { ...zhPreferences, outputLanguage: 'en-US' },
    });
    expect(en[1].content).toContain('verify before acting');
    expect(en[1].content).toContain('project memory');
    expect(en[1].content).toContain('compressed summary');
  });

  it('parses a V2 payload, mapping verifyFirst and the structured sections', () => {
    const parsed = parseRelayPayloadV2(JSON.stringify({
      meta: { version: 2, createdAt: '2026-07-31T00:00:00Z', conversationCount: 2 },
      goal: '把播放器迁移到新架构',
      state: {
        completed: ['解码层拆分'],
        inProgress: ['渲染层接入'],
        blocked: ['字幕同步依赖解码器升级'],
      },
      files: [{ path: 'src/player/decoder.ts', why: '解码入口', last_state: '已拆分' }],
      decisions: [{ decision: '采用插件化解码', rationale: '否决了整体重写' }],
      failedPaths: [{ approach: '重写渲染线程', whyFailed: '丢帧严重', evidence: '会话 2 末尾' }],
      verification: { lastCommand: 'pnpm test', lastResult: '42 项通过', passed: true },
      verifyFirst: ['重跑 pnpm test 确认 42 项通过', '确认 src/player/decoder.ts 存在且已拆分'],
      nextSteps: ['接入新渲染层'],
      confidence: { overall: 0.8, lowAreas: ['字幕同步'] },
      environment: { gitBranch: 'feature/player', dirtyFiles: ['src/player/render.ts'] },
      handoffPrompt: '背景：正在重构播放器……',
    }));
    expect(parsed.goal).toBe('把播放器迁移到新架构');
    expect(parsed.completed).toEqual(['解码层拆分']);
    expect(parsed.in_progress).toEqual(['渲染层接入']);
    expect(parsed.open_issues).toEqual(['[阻塞] 字幕同步依赖解码器升级']);
    expect(parsed.key_decisions).toEqual(['采用插件化解码 — 否决了整体重写']);
    expect(parsed.key_files).toEqual([
      { path: 'src/player/decoder.ts', why: '解码入口', last_state: '已拆分' },
    ]);
    expect(parsed.failed_paths).toEqual([{ approach: '重写渲染线程', why_failed: '丢帧严重' }]);
    expect(parsed.verification).toEqual({ commands: ['pnpm test'], last_results: ['42 项通过'] });
    expect(parsed.verify_first).toEqual([
      '重跑 pnpm test 确认 42 项通过',
      '确认 src/player/decoder.ts 存在且已拆分',
    ]);
    expect(parsed.git_state.branch).toBe('feature/player');
    expect(parsed.git_state.dirty_files).toEqual(['src/player/render.ts']);
    expect(parsed.confidence).toEqual({ overall: 0.8, low_areas: ['字幕同步'] });
    expect(parsed.suggested_prompt).toBe('背景：正在重构播放器……');
  });

  it('keeps verify_first absent when the model gives no usable checklist', () => {
    const bare = parseRelayPayloadV2(JSON.stringify({
      meta: { version: 2 }, goal: 'g', state: {}, handoffPrompt: 'p',
    }));
    expect(bare.verify_first).toBeUndefined();
    // …and a v1 payload that happens to carry the field still passes it through.
    const v1 = parseRelayPayload(JSON.stringify({
      title: 't', goal: 'g', suggested_prompt: 'p', verify_first: [' 先跑测试 ', 42],
    }));
    expect(v1.verify_first).toEqual(['先跑测试']);
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

  it('caps the suggested prompt at 1200 chars', () => {
    const parsed = parseRelayPayload(JSON.stringify({
      title: 't',
      goal: 'g',
      current_state: 'c',
      suggested_prompt: ` ${'长'.repeat(1_500)} `,
    }));
    expect(parsed.suggested_prompt).toHaveLength(1_200);
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


describe('roundtable kinds (AI 圆桌)', () => {
  it('roundtable-turn wraps the prebuilt transcript with the roundtable preamble', () => {
    const messages = getAgentKindDefinition('roundtable-turn').buildPrompt({
      transcript: '你的角色设定：怀疑者……\n\n圆桌话题：要不要重写？',
      preferences: zhPreferences,
    });
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain('圆桌讨论助手');
    expect(messages[0].content).toContain('使用清晰、简洁的中文 Markdown。');
    expect(messages[1]).toEqual({
      role: 'user',
      content: '你的角色设定：怀疑者……\n\n圆桌话题：要不要重写？',
    });
  });

  it('roundtable-turn follows the en-US output language', () => {
    const messages = getAgentKindDefinition('roundtable-turn').buildPrompt({
      transcript: 'T',
      preferences: { ...zhPreferences, outputLanguage: 'en-US' },
    });
    expect(messages[0].content).toContain('Respond in clear English Markdown.');
  });

  it('roundtable-turn parses leniently: strips fences, trims, caps at 4000, rejects empty', () => {
    const definition = getAgentKindDefinition('roundtable-turn');
    expect(definition.parse?.('```markdown\n\n发言正文。\n```')).toBe('发言正文。');
    expect(definition.parse?.('x'.repeat(4100))).toHaveLength(4000);
    expect(() => definition.parse?.('  \n ')).toThrow('roundtable-turn 输出为空');
  });

  it('roundtable-synthesis demands JSON in the preamble and parses leniently', () => {
    const definition = getAgentKindDefinition('roundtable-synthesis');
    const messages = definition.buildPrompt({ transcript: 'T', preferences: zhPreferences });
    expect(messages[0].content).toContain('圆桌主持助手');
    expect(messages[0].content).toContain('严格 JSON');
    expect(messages[1]).toEqual({ role: 'user', content: 'T' });
    expect(definition.parse?.('```json\n{"consensus": []}\n```')).toBe('{"consensus": []}');
    expect(() => definition.parse?.('   ')).toThrow('roundtable-synthesis 输出为空');
  });

  it('learn-deepen wraps the prebuilt transcript with the learning-analysis preamble', () => {
    const definition = getAgentKindDefinition('learn-deepen');
    const messages = definition.buildPrompt({
      transcript: '学习领域：前端\n\n本地统计：……',
      preferences: zhPreferences,
    });
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain('学习脉络分析助手');
    expect(messages[0].content).toContain('严格 JSON');
    expect(messages[0].content).toContain('使用清晰、简洁的中文 Markdown。');
    expect(messages[1]).toEqual({ role: 'user', content: '学习领域：前端\n\n本地统计：……' });
  });

  it('learn-deepen parses leniently: strips fences, trims, caps at 4000, rejects empty', () => {
    const definition = getAgentKindDefinition('learn-deepen');
    expect(definition.parse?.('```json\n{"mastered": []}\n```')).toBe('{"mastered": []}');
    expect(definition.parse?.('x'.repeat(4100))).toHaveLength(4000);
    expect(() => definition.parse?.('  \n ')).toThrow('learn-deepen 输出为空');
  });
});

describe('dream-extract agent kind', () => {
  it('builds the extractor prompt with the six tags and the strict-JSON contract', () => {
    const messages = getAgentKindDefinition('dream-extract').buildPrompt({
      transcript: 'TRANSCRIPT',
      preferences: zhPreferences,
    });
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain('「梦境」记忆提取器');
    expect(messages[0].content).toContain('使用清晰、简洁的中文 Markdown。');
    const prompt = messages[1].content;
    expect(prompt).toContain('profile');
    expect(prompt).toContain('preference');
    expect(prompt).toContain('goal');
    expect(prompt).toContain('emotion');
    expect(prompt).toContain('relationship');
    expect(prompt).toContain('event');
    expect(prompt).toContain('{"memories"');
    expect(prompt.endsWith('TRANSCRIPT')).toBe(true);
  });

  it('parse round-trips through the shared validator and re-serializes', () => {
    const definition = getAgentKindDefinition('dream-extract');
    const raw = '```json\n' + JSON.stringify({
      memories: [
        { tag: 'preference', fact: '偏好 pnpm', evidence: '多次指定 corepack', session_ids: ['s1'] },
        { tag: 'bogus', fact: '会被丢弃', evidence: '', session_ids: [] },
      ],
    }) + '\n```';
    const parsed = definition.parse?.(raw);
    expect(JSON.parse(parsed ?? '')).toEqual([
      { tag: 'preference', fact: '偏好 pnpm', evidence: '多次指定 corepack', session_ids: ['s1'] },
    ]);
    expect(() => definition.parse?.('不是 JSON')).toThrow('dream-extract 输出不是 JSON');
  });
});

describe('dream-maintain agent kind', () => {
  it('renders the serialized existing/candidates JSON into readable lists', () => {
    const transcript = JSON.stringify({
      existing: [
        { id: 'dream:1', tag: 'preference', content: '偏好中文交流' },
        { id: 'dream:2', tag: 'goal', title: '推进记忆空间' },
      ],
      candidates: [
        { tag: 'goal', fact: '正在实现记忆空间存储层', evidence: '连续开发记录', session_ids: ['s1'] },
      ],
    });
    const messages = getAgentKindDefinition('dream-maintain').buildPrompt({
      transcript,
      preferences: zhPreferences,
    });
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain('记忆空间的维护者');
    const prompt = messages[1].content;
    expect(prompt).toContain('- dream:1 | preference | 偏好中文交流');
    expect(prompt).toContain('- dream:2 | goal | 推进记忆空间');
    expect(prompt).toContain('- [goal] 正在实现记忆空间存储层（依据：连续开发记录）');
    expect(prompt).toContain('{"ops"');
    expect(prompt).toContain('ADD：候选是全新事实');
  });

  it('falls back to embedding the transcript verbatim when it is not JSON', () => {
    const messages = getAgentKindDefinition('dream-maintain').buildPrompt({
      transcript: '随便一段原文',
      preferences: zhPreferences,
    });
    expect(messages[1]).toEqual({ role: 'user', content: '随便一段原文' });
  });

  it('parse round-trips through the shared validator and re-serializes', () => {
    const definition = getAgentKindDefinition('dream-maintain');
    const raw = JSON.stringify({
      ops: [
        { op: 'ADD', target_id: null, tag: 'goal', title: '推进记忆空间', content: '正在实现存储层', reason: '新事实' },
        { op: 'UPDATE', target_id: null, reason: '缺 target_id，丢弃' },
      ],
    });
    const parsed = definition.parse?.(raw);
    expect(JSON.parse(parsed ?? '')).toEqual([
      { op: 'ADD', target_id: null, tag: 'goal', title: '推进记忆空间', content: '正在实现存储层', reason: '新事实' },
    ]);
    expect(() => definition.parse?.('   ')).toThrow('dream-maintain 输出不是 JSON');
  });
});


describe('companion agent kind', () => {
  it('builds the listener prompt by default (template omitted)', () => {
    const messages = getAgentKindDefinition('companion').buildPrompt({
      transcript: 'CONTEXT',
      question: '最近有点累',
      preferences: zhPreferences,
    });
    expect(messages[0].role).toBe('system');
    expect(messages[0].content.startsWith('你是「夜话」，Vesti 里的猫头鹰伙伴')).toBe(true);
    expect(messages[0].content).toContain('温柔的倾听者');
    expect(messages[0].content.endsWith('使用清晰、简洁的中文 Markdown。')).toBe(true);
    expect(messages[1]).toEqual({
      role: 'user',
      content: 'CONTEXT\n\n用户现在说：最近有点累',
    });
  });

  it('builds the creator prompt when template selects it', () => {
    const messages = getAgentKindDefinition('companion').buildPrompt({
      transcript: 'CONTEXT',
      question: '给我点灵感',
      template: 'creator',
      preferences: zhPreferences,
    });
    expect(messages[0].content.startsWith('你是「夜话」的创造者人格')).toBe(true);
    expect(messages[0].content).toContain('高能量、有火花');
    expect(messages[0].content.endsWith('使用清晰、简洁的中文 Markdown。')).toBe(true);
    expect(messages[1].content).toBe('CONTEXT\n\n用户现在说：给我点灵感');
  });

  it('falls back to the greeting line when the question is empty', () => {
    const messages = getAgentKindDefinition('companion').buildPrompt({
      transcript: '',
      question: '',
      preferences: zhPreferences,
    });
    expect(messages[1].content).toBe('\n\n用户现在说：（用户没有说话，主动打个招呼吧）');
  });

  it('appends custom instructions after the language affix', () => {
    const messages = getAgentKindDefinition('companion').buildPrompt({
      transcript: 'T',
      preferences: { ...zhPreferences, customInstructions: '多用比喻' },
    });
    expect(messages[0].content).toContain('使用清晰、简洁的中文 Markdown。\n用户的长期分析偏好：多用比喻');
  });

  it('parse extracts the standard mood tag line', () => {
    const definition = getAgentKindDefinition('companion');
    expect(definition.parse?.('[mood:warm]\n正文第一行\n正文第二行')).toBe('warm\n正文第一行\n正文第二行');
  });

  it('parse defaults to calm when the tag is missing', () => {
    const definition = getAgentKindDefinition('companion');
    expect(definition.parse?.('没有标签的正文')).toBe('calm\n没有标签的正文');
  });

  it('parse drops an invalid tag and defaults to calm', () => {
    const definition = getAgentKindDefinition('companion');
    expect(definition.parse?.('[mood:excited]\n正文')).toBe('calm\n正文');
  });

  it('parse tolerates the fullwidth variant, casing and inner whitespace', () => {
    const definition = getAgentKindDefinition('companion');
    expect(definition.parse?.('【mood: SPARK 】\n正文')).toBe('spark\n正文');
    expect(definition.parse?.('[MOOD:Thinking]\n正文')).toBe('thinking\n正文');
  });

  it('parse accepts the tag on the second line', () => {
    const definition = getAgentKindDefinition('companion');
    expect(definition.parse?.('\n[mood:sleepy]\n正文')).toBe('sleepy\n正文');
  });

  it('parse leaves tags beyond the second line in the body', () => {
    const definition = getAgentKindDefinition('companion');
    expect(definition.parse?.('第一行\n第二行\n[mood:warm]\n正文')).toBe('calm\n第一行\n第二行\n[mood:warm]\n正文');
  });
});
