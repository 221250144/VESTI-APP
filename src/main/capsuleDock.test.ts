import { describe, expect, it } from 'vitest';
import {
  appendQuickAskHistory,
  assembleCapsuleRelayDraft,
  buildQuickAskTranscript,
  CAPSULE_DRAFT_BUDGET_CHARS,
  normalizePromptSnapshot,
  normalizeRelayDraftRequest,
  PROMPT_SNAPSHOT_MAX_ENTRIES,
  searchCapsulePrompts,
  type CapsuleDraftSessionInput,
} from './capsuleDock';
import { DEMO_PROXY_MODEL_IDS, type CapsulePromptSnapshot } from '../shared/contracts';

function session(overrides: Partial<CapsuleDraftSessionInput> = {}): CapsuleDraftSessionInput {
  return {
    sessionId: 'codex:abc-1',
    title: '修复登录重定向',
    platform: 'codex',
    projectLabel: 'vesti-app',
    lastActivityAt: Date.UTC(2026, 6, 18),
    gitBranch: 'main',
    gitRemote: null,
    digest: {
      oneLiner: '定位并修复 302 循环',
      keyTopics: ['auth', 'redirect'],
      keyFiles: ['src/auth.ts', 'src/router.ts'],
      decisions: ['改用 server-side redirect'],
      openQuestions: ['移动端是否也有同样问题？'],
    },
    recentMessages: [],
    ...overrides,
  };
}

describe('normalizeRelayDraftRequest', () => {
  it('accepts a project-only request', () => {
    expect(normalizeRelayDraftRequest({ platform: 'codex', host: 'native', projectKey: '/repo' }))
      .toEqual({ platform: 'codex', host: 'native', projectKey: '/repo' });
  });

  it('accepts explicit session ids and dedupes them', () => {
    expect(normalizeRelayDraftRequest({
      platform: 'codex',
      host: 'native',
      projectKey: '/repo',
      sessionIds: ['codex:a-1', 'codex:a-1', 'kimi-code:b_2'],
    })).toEqual({
      platform: 'codex',
      host: 'native',
      projectKey: '/repo',
      sessionIds: ['codex:a-1', 'kimi-code:b_2'],
    });
  });

  it('rejects malformed shapes', () => {
    expect(normalizeRelayDraftRequest(null)).toBeNull();
    expect(normalizeRelayDraftRequest({ platform: '', host: 'native', projectKey: '/repo' })).toBeNull();
    expect(normalizeRelayDraftRequest({ platform: 'codex', host: 'native', projectKey: '/repo', sessionIds: 'x' })).toBeNull();
    expect(normalizeRelayDraftRequest({
      platform: 'codex',
      host: 'native',
      projectKey: '/repo',
      sessionIds: ['bad id with spaces'],
    })).toBeNull();
    expect(normalizeRelayDraftRequest({
      platform: 'codex',
      host: 'native',
      projectKey: '/repo',
      sessionIds: Array.from({ length: 21 }, (_, index) => `codex:s-${index}`),
    })).toBeNull();
  });
});

describe('assembleCapsuleRelayDraft', () => {
  it('builds the zh template with roster, digests, deduped files and open questions', () => {
    const other = session({
      sessionId: 'kimi-code:xyz-2',
      title: '接入 Kimi 数据源',
      platform: 'kimi-code',
      digest: {
        oneLiner: '新增 kimi-code 适配器',
        keyTopics: ['capture'],
        // Duplicate on purpose (case differs): must be deduped away.
        keyFiles: ['SRC/AUTH.ts', 'src/kimi.ts'],
        decisions: [],
        openQuestions: [],
      },
    });
    const { text } = assembleCapsuleRelayDraft([session(), other], {
      language: 'zh-CN',
      projectLabel: 'vesti-app',
    });
    expect(text).toContain('# 交接上下文 · vesti-app（2 个会话）');
    expect(text).toContain('## 会话清单');
    expect(text).toContain('《修复登录重定向》');
    expect(text).toContain('一句话：定位并修复 302 循环');
    expect(text).toContain('Git：main');
    expect(text).toContain('关键主题：auth、redirect');
    expect(text).toContain('关键决策：改用 server-side redirect');
    // Cross-session dedupe: src/auth.ts appears once despite the case variant.
    expect(text).toContain('## 关键文件（跨会话去重）');
    expect(text.match(/src\/auth\.ts/gi)).toHaveLength(1);
    expect(text).toContain('src/kimi.ts');
    expect(text).toContain('## 未决事项汇总');
    expect(text).toContain('移动端是否也有同样问题？（来自《修复登录重定向》）');
  });

  it('falls back to recent message excerpts for sessions without a digest', () => {
    const noDigest = session({
      digest: null,
      recentMessages: [
        { role: 'user', content: '为什么构建又挂了？' },
        { role: 'assistant', content: '因为 lockfile 漂移。' },
      ],
    });
    const { text } = assembleCapsuleRelayDraft([noDigest], {
      language: 'zh-CN',
      projectLabel: 'vesti-app',
    });
    expect(text).toContain('最近消息');
    expect(text).toContain('[用户] 为什么构建又挂了？');
    expect(text).not.toContain('关键主题');
    expect(text).not.toContain('## 关键文件');
    expect(text).not.toContain('## 未决事项汇总');
  });

  it('honors the en-US language and the budget cap', () => {
    const huge = session({
      digest: {
        oneLiner: 'x'.repeat(500),
        keyTopics: Array.from({ length: 6 }, (_, index) => `topic-${index}-${'y'.repeat(400)}`),
        keyFiles: [],
        decisions: [],
        openQuestions: [],
      },
    });
    const { text } = assembleCapsuleRelayDraft([huge], {
      language: 'en-US',
      projectLabel: 'vesti-app',
      budgetChars: 400,
    });
    expect(text.length).toBeLessThanOrEqual(400);
    expect(text).toContain('[context truncated]');

    const { text: english } = assembleCapsuleRelayDraft([session()], {
      language: 'en-US',
      projectLabel: 'vesti-app',
    });
    expect(english).toContain('# Handoff context · vesti-app (1 session)');
    expect(english).toContain('## Session roster');
  });

  it('never exceeds the default budget', () => {
    const many = Array.from({ length: 20 }, (_, index) => session({
      sessionId: `codex:s-${index}`,
      title: `会话 ${index}`,
      digest: {
        oneLiner: '一句话'.repeat(80),
        keyTopics: Array.from({ length: 6 }, (_, topic) => `主题-${index}-${topic}-${'长'.repeat(300)}`),
        keyFiles: [`src/file-${index}.ts`],
        decisions: ['决定'.repeat(150)],
        openQuestions: ['未决'.repeat(150)],
      },
    }));
    const { text } = assembleCapsuleRelayDraft(many, {
      language: 'zh-CN',
      projectLabel: 'vesti-app',
    });
    expect(text.length).toBeLessThanOrEqual(CAPSULE_DRAFT_BUDGET_CHARS);
    expect(text).toContain('[上下文已截断]');
  });
});

describe('normalizePromptSnapshot', () => {
  it('normalizes a valid snapshot', () => {
    const snapshot = normalizePromptSnapshot({
      updatedAt: 123,
      prompts: [
        { id: '1', title: '润色', description: '写作', tags: ['writing'], body: '请润色', source: 'manual' },
        { id: '2', title: '无标签', body: '正文', source: 'extracted' },
      ],
    });
    expect(snapshot).toEqual({
      updatedAt: 123,
      prompts: [
        { id: '1', title: '润色', description: '写作', tags: ['writing'], body: '请润色', source: 'manual' },
        { id: '2', title: '无标签', description: '', tags: [], body: '正文', source: 'extracted' },
      ],
    });
  });

  it('drops entries without title/body and rejects non-snapshots', () => {
    expect(normalizePromptSnapshot(null)).toBeNull();
    expect(normalizePromptSnapshot({ prompts: 'nope' })).toBeNull();
    const snapshot = normalizePromptSnapshot({
      prompts: [
        { title: '', body: 'x' },
        { title: 'ok', body: 'y' },
      ],
    });
    expect(snapshot?.prompts).toHaveLength(1);
    expect(snapshot?.prompts[0].title).toBe('ok');
  });

  it('caps entry count and field lengths', () => {
    const snapshot = normalizePromptSnapshot({
      prompts: Array.from({ length: PROMPT_SNAPSHOT_MAX_ENTRIES + 50 }, (_, index) => ({
        id: `p-${index}`,
        title: `t-${index}`,
        body: 'b'.repeat(10_000),
        tags: Array.from({ length: 20 }, (_, tag) => `tag-${tag}`),
      })),
    });
    expect(snapshot?.prompts).toHaveLength(PROMPT_SNAPSHOT_MAX_ENTRIES);
    expect(snapshot?.prompts[0].body.length).toBeLessThanOrEqual(8_000);
    expect(snapshot?.prompts[0].tags.length).toBeLessThanOrEqual(10);
  });
});

describe('searchCapsulePrompts', () => {
  const snapshot: CapsulePromptSnapshot = {
    updatedAt: 1,
    prompts: [
      { id: 'u1', title: '我的周报模板', description: '', tags: ['weekly'], body: '写一份周报', source: 'manual' },
      { id: 'u2', title: '代码审查', description: '', tags: [], body: 'review this diff', source: 'manual' },
    ],
  };
  const curated = [
    { id: 'c1', title: 'Structured summary', body: 'Summarize the content', source: 'Anthropic Prompt Library' },
    { id: 'c2', title: '周报助手', body: '汇总本周工作', source: 'Curated' },
  ];

  it('ranks user prompts before curated ones', () => {
    const hits = searchCapsulePrompts({ query: '周报', curated, snapshot });
    expect(hits.map(hit => hit.id)).toEqual(['u1', 'c2']);
    expect(hits[0].origin).toBe('user');
    expect(hits[1].origin).toBe('curated');
  });

  it('matches against tags and body, and caps the result list', () => {
    expect(searchCapsulePrompts({ query: 'weekly', curated, snapshot }).map(hit => hit.id)).toEqual(['u1']);
    expect(searchCapsulePrompts({ query: 'diff', curated, snapshot }).map(hit => hit.id)).toEqual(['u2']);
    const limited = searchCapsulePrompts({ query: '', curated, snapshot, limit: 3 });
    expect(limited).toHaveLength(3);
    expect(limited.map(hit => hit.id)).toEqual(['u1', 'u2', 'c1']);
  });

  it('works without a snapshot (graceful curated-only state)', () => {
    const hits = searchCapsulePrompts({ query: '', curated, snapshot: null });
    expect(hits.map(hit => hit.id)).toEqual(['c1', 'c2']);
    expect(hits.every(hit => hit.origin === 'curated')).toBe(true);
  });
});

describe('buildQuickAskTranscript', () => {
  it('returns an explicit empty marker without recall hits', () => {
    expect(buildQuickAskTranscript([], { language: 'zh-CN' })).toContain('没有为该问题召回');
    expect(buildQuickAskTranscript([], { language: 'en-US' })).toContain('No archived conversations');
  });

  it('compacts hits with one-liners and snippets, capped by the budget', () => {
    const text = buildQuickAskTranscript([
      { title: '会话 A', oneLiner: '聊了重定向', snippet: '细节……' },
      { title: '会话 B', oneLiner: null, snippet: 'x'.repeat(2_000) },
    ], { language: 'zh-CN', budgetChars: 300 });
    expect(text.length).toBeLessThanOrEqual(300);
    expect(text).toContain('[上下文已截断]');

    const full = buildQuickAskTranscript([
      { title: '会话 A', oneLiner: '聊了重定向', snippet: '细节……' },
    ], { language: 'zh-CN' });
    expect(full).toContain('召回的历史会话片段');
    expect(full).toContain('一句话：聊了重定向');
  });
});

describe('appendQuickAskHistory', () => {
  const base = buildQuickAskTranscript([
    { title: '会话 A', oneLiner: '聊了重定向', snippet: '细节……' },
  ], { language: 'zh-CN' });

  it('returns the transcript untouched without usable turns', () => {
    expect(appendQuickAskHistory(base, [], { language: 'zh-CN' })).toBe(base);
    expect(
      appendQuickAskHistory(base, [{ question: '  ', answer: '' }], { language: 'zh-CN' }),
    ).toBe(base);
  });

  it('appends recent turns after the recall context (zh + en)', () => {
    const zh = appendQuickAskHistory(base, [
      { question: '重定向为什么循环？', answer: '因为 302 相互指向。' },
    ], { language: 'zh-CN' });
    expect(zh).toContain('最近的快速问答');
    expect(zh).toContain('重定向为什么循环？');
    expect(zh).toContain('因为 302 相互指向。');

    const en = appendQuickAskHistory(base, [
      { question: 'why loop?', answer: 'mutual 302s.' },
    ], { language: 'en-US' });
    expect(en).toContain('Recent quick-ask exchanges');
    expect(en).toContain('why loop?');
  });

  it('keeps only the newest turns within the cap', () => {
    const turns = Array.from({ length: 6 }, (_, index) => ({
      question: `问题 ${index}`,
      answer: `回答 ${index}`,
    }));
    const text = appendQuickAskHistory(base, turns, { language: 'zh-CN', maxTurns: 2 });
    expect(text).toContain('问题 5');
    expect(text).toContain('问题 4');
    expect(text).not.toContain('问题 3');
  });
});

describe('DEMO_PROXY_MODEL_IDS', () => {
  // The gateway rejects anything off-whitelist with UNSUPPORTED_MODEL (and
  // maps qwen-turbo to qwen-plus); pin the list so an accidental edit ships
  // a picker that lies about which model answers.
  it('pins exactly the gateway whitelist, qwen-plus as the default first', () => {
    expect([...DEMO_PROXY_MODEL_IDS]).toEqual([
      'qwen-plus',
      'qwen-turbo',
    ]);
  });
});
