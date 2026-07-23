import { describe, expect, it } from "vitest";
import { computeLearn } from "./computeLearn";
import type { Conversation, SummaryRecord, Topic } from "../db/types";

function conv(
  id: number,
  topicId: number | null,
  updatedAt: number,
  flags?: { archived?: boolean; trash?: boolean },
): Conversation {
  return {
    id,
    uuid: `uuid-${id}`,
    platform: "ChatGPT",
    title: `会话 ${id}`,
    snippet: "",
    url: "",
    source_created_at: updatedAt,
    first_captured_at: updatedAt,
    last_captured_at: updatedAt,
    created_at: updatedAt,
    updated_at: updatedAt,
    message_count: 4,
    turn_count: 2,
    is_archived: flags?.archived ?? false,
    is_trash: flags?.trash ?? false,
    tags: [],
    topic_id: topicId,
    is_starred: false,
  };
}

function topic(id: number, name: string): Topic {
  return { id, name, parent_id: null, created_at: 0, updated_at: 0 };
}

function summary(
  conversationId: number,
  depthLevel: "superficial" | "moderate" | "deep" | null,
  createdAt = conversationId,
  unresolvedThreads: string[] = [],
  keyInsights: Array<string | { term: string; definition: string }> = [],
): SummaryRecord {
  return {
    id: conversationId,
    conversationId,
    content: "",
    structured: depthLevel
      ? {
          core_question: "q",
          thinking_journey: [],
          key_insights: keyInsights.map(ki =>
            typeof ki === 'string' ? ki : ({ term: ki.term, definition: ki.definition })
          ) as unknown[],
          unresolved_threads: unresolvedThreads,
          meta_observations: { thinking_style: "s", emotional_tone: "e", depth_level: depthLevel },
          actionable_next_steps: [],
        }
      : null,
    modelId: "test-model",
    createdAt,
    sourceUpdatedAt: createdAt,
  };
}

describe("computeLearn representative conversations", () => {
  it("ranks representatives deepest-first, then most recent, capped at 3, with titles", () => {
    const conversations = [
      conv(1, 1, 100), // deep but older
      conv(2, 1, 400), // moderate
      conv(3, 1, 500), // superficial — dropped by the cap
      conv(4, 1, 600), // no summary — dropped by the cap
      conv(5, 1, 700), // deep and newest
    ];
    const summaries = [
      summary(1, "deep", 100),
      summary(5, "deep", 200),
      summary(2, "moderate"),
      summary(3, "superficial"),
    ];
    const profile = computeLearn(summaries, [topic(1, "前端")], conversations);
    expect(profile.available).toBe(true);
    const domain = profile.domains.find((d) => d.topicId === 1);
    expect(domain).toBeDefined();
    expect(domain!.representatives).toEqual([
      { conversationId: 5, title: "会话 5" },
      { conversationId: 1, title: "会话 1" },
      { conversationId: 2, title: "会话 2" },
    ]);
  });

  it("keeps archived and trashed conversations out of domains and representatives", () => {
    const conversations = [
      conv(1, 1, 100),
      conv(2, 1, 200, { archived: true }),
      conv(3, 1, 300, { trash: true }),
      conv(4, 1, 400),
    ];
    const summaries = [summary(1, "deep"), summary(2, "deep"), summary(3, "deep"), summary(4, "moderate")];
    const profile = computeLearn(summaries, [topic(1, "前端")], conversations);
    const domain = profile.domains.find((d) => d.topicId === 1);
    expect(domain!.count).toBe(2);
    expect(domain!.representatives.map((r) => r.conversationId)).toEqual([1, 4]);
  });

  it("stays unavailable below the minimum live-sample size", () => {
    const conversations = [conv(1, 1, 100), conv(2, 1, 200)];
    const summaries = [summary(1, "deep"), summary(2, "deep")];
    const profile = computeLearn(summaries, [topic(1, "前端")], conversations);
    expect(profile.available).toBe(false);
  });
});

describe("computeLearn domain recency", () => {
  const DAY = 86_400_000;
  const NOW = 100 * DAY;

  it("counts 7/30-day activity per domain against the injected clock", () => {
    const conversations = [
      conv(1, 1, NOW - 2 * DAY), // within 7d
      conv(2, 1, NOW - 20 * DAY), // within 30d only
      conv(3, 1, NOW - 60 * DAY), // dormant
      conv(4, 2, NOW - 90 * DAY), // dormant domain
    ];
    const summaries = [summary(1, "deep"), summary(2, "moderate")];
    const profile = computeLearn(summaries, [topic(1, "前端"), topic(2, "历史")], conversations, NOW);
    const frontend = profile.domains.find((d) => d.topicId === 1)!;
    expect(frontend.recent7).toBe(1);
    expect(frontend.recent30).toBe(2);
    expect(frontend.lastActiveAt).toBe(NOW - 2 * DAY);
    const history = profile.domains.find((d) => d.topicId === 2)!;
    expect(history.recent7).toBe(0);
    expect(history.recent30).toBe(0);
  });
});

describe("computeLearn domain open question", () => {
  it("picks the unresolved thread from the domain's most recently active conversation", () => {
    const conversations = [conv(1, 1, 100), conv(2, 1, 300), conv(3, 1, 200)];
    const summaries = [
      summary(1, "deep", 100, ["旧问题：什么是闭包？"]),
      summary(2, "moderate", 300, ["新问题：并发渲染怎么调度？", "另一个问题"]),
      summary(3, "deep", 200, []),
    ];
    const profile = computeLearn(summaries, [topic(1, "前端")], conversations);
    const domain = profile.domains.find((d) => d.topicId === 1)!;
    expect(domain.openQuestion).toEqual({
      text: "新问题：并发渲染怎么调度？",
      conversationId: 2,
    });
  });

  it("skips blank/too-short threads and stays absent when no conversation left one", () => {
    const conversations = [conv(1, 1, 100), conv(2, 1, 200), conv(3, 1, 300)];
    const summaries = [
      summary(1, "deep", 100, ["  ", "ab"]),
      summary(2, "deep", 200),
      summary(3, "deep", 300, ["   ", "短"]),
    ];
    const profile = computeLearn(summaries, [topic(1, "前端")], conversations);
    const domain = profile.domains.find((d) => d.topicId === 1)!;
    expect(domain.openQuestion).toBeUndefined();
  });
});

// ---- V2: User Corrections ---------------------------------------------------

import { type LearnCorrection } from "./computeLearn";

describe('computeLearn with user corrections', () => {
  const conversations = [
    conv(1, 1, 1_000_000),
    conv(2, 1, 1_000_001),
    conv(3, 2, 1_000_002),
    conv(4, 2, 1_000_003),
    conv(5, 2, 1_000_004),
  ];

  it('prepends user-added glossary entries at the top', () => {
    const summaries = [
      summary(1, "moderate", 100, [], ['React', 'TypeScript']),
      summary(2, "superficial", 200, [], ['Node.js']),
      summary(3, "moderate", 300, [], ['Docker']),
    ];
    const corrections: LearnCorrection[] = [
      { type: 'glossary_add', term: 'GraphQL', definition: '查询语言' },
      { type: 'glossary_add', term: 'WebSocket', definition: '' },
    ];
    const profile = computeLearn(summaries, [topic(1, "前端")], conversations, undefined, corrections);
    // User additions appear before auto-extracted entries.
    expect(profile.glossary[0].term).toBe('GraphQL');
    expect(profile.glossary[0].definition).toBe('查询语言');
    expect(profile.glossary[1].term).toBe('WebSocket');
  });

  it('edits existing glossary definitions', () => {
    const summaries = [
      summary(1, "moderate", 100, [], ['React', 'TypeScript']),
    ];
    const corrections: LearnCorrection[] = [
      { type: 'glossary_edit', term: 'React', definition: 'Facebook 的 UI 库（更正后的定义）' },
    ];
    const profile = computeLearn(summaries, [topic(1, "前端")], conversations, undefined, corrections);
    const react = profile.glossary.find(g => g.term === 'React');
    expect(react?.definition).toBe('Facebook 的 UI 库（更正后的定义）');
  });

  it('removes glossary entries', () => {
    const summaries = [
      summary(1, "moderate", 100, [], ['React', 'TypeScript', 'Node.js']),
    ];
    const corrections: LearnCorrection[] = [
      { type: 'glossary_remove', term: 'Node.js' },
    ];
    const profile = computeLearn(summaries, [topic(1, "前端")], conversations, undefined, corrections);
    const terms = profile.glossary.map(g => g.term);
    expect(terms).toContain('React');
    expect(terms).toContain('TypeScript');
    expect(terms).not.toContain('Node.js');
  });

  it('dismisses open loops', () => {
    const summaries = [
      summary(1, "deep", 100, ['still open A'], []),
      summary(3, "deep", 300, ['still open B'], []),
    ];
    const corrections: LearnCorrection[] = [
      { type: 'open_loop_dismiss', loopText: 'still open A' },
    ];
    const profile = computeLearn(summaries, [topic(1, "前端")], conversations, undefined, corrections);
    const loopTexts = profile.openLoops.map(l => l.text);
    expect(loopTexts).not.toContain('still open A');
    expect(loopTexts).toContain('still open B');
  });

  it('no corrections leaves everything untouched', () => {
    const summaries = [
      summary(1, "moderate", 100, [], ['React']),
    ];
    const withEmpty = computeLearn(summaries, [topic(1, "前端")], conversations, undefined, []);
    const withoutArgs = computeLearn(summaries, [topic(1, "前端")], conversations);
    expect(withEmpty.glossary).toEqual(withoutArgs.glossary);
    expect(withEmpty.openLoops).toEqual(withoutArgs.openLoops);
  });
});
