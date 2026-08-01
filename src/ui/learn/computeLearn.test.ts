import { describe, expect, it } from "vitest";
import { computeLearn } from "./computeLearn";
import type { Conversation, SummaryRecord, Topic } from "../db/types";

function conv(
  id: number,
  topicId: number | null,
  updatedAt: number,
  flags?: {
    archived?: boolean;
    trash?: boolean;
    platform?: Conversation["platform"];
    projectPath?: string;
    source?: string;
    url?: string;
  },
): Conversation {
  return {
    id,
    uuid: `uuid-${id}`,
    platform: flags?.platform ?? "ChatGPT",
    title: `会话 ${id}`,
    snippet: "",
    url: flags?.url ?? "",
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
    // Non-indexed capture fields computeLearn reads structurally (V3).
    ...(flags?.projectPath ? { _project_path: flags.projectPath } : {}),
    ...(flags?.source ? { _source: flags.source } : {}),
  } as Conversation;
}

function topic(id: number, name: string, parentId: number | null = null): Topic {
  return { id, name, parent_id: parentId, created_at: 0, updated_at: 0 };
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
      ? ({
          core_question: "q",
          thinking_journey: [],
          key_insights: keyInsights.map(ki =>
            typeof ki === 'string' ? ki : ({ term: ki.term, definition: ki.definition })
          ) as unknown[],
          unresolved_threads: unresolvedThreads,
          meta_observations: { thinking_style: "s", emotional_tone: "e", depth_level: depthLevel },
          actionable_next_steps: [],
        } as unknown as SummaryRecord["structured"])
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

// ---- V3: Route aggregation --------------------------------------------------

describe("computeLearn V3 route aggregation", () => {
  it("clusters unclassified conversations by project, never into a nameless bucket", () => {
    const conversations = [
      conv(1, null, 100, { projectPath: "C:/work/VESTI-APP" }),
      conv(2, null, 200, { projectPath: "C:/work/VESTI-APP" }),
      conv(3, null, 300, { projectPath: "D:/sites/blog" }),
      conv(4, null, 400, { projectPath: "D:/sites/blog" }),
    ];
    const profile = computeLearn([], [], conversations);
    expect(profile.available).toBe(true);
    expect(profile.domains.length).toBe(2);
    expect(profile.domains.every((d) => d.name.trim().length > 0)).toBe(true);
    expect(profile.domains.map((d) => d.name).sort()).toEqual(["VESTI-APP", "blog"]);
  });

  it("folds a singleton project into its platform cluster", () => {
    const conversations = [
      conv(1, null, 100, { projectPath: "C:/work/VESTI-APP" }),
      conv(2, null, 200, { projectPath: "C:/work/VESTI-APP" }),
      conv(3, null, 300, { projectPath: "D:/sites/blog" }), // alone → platform
    ];
    const profile = computeLearn([], [], conversations);
    const vesti = profile.domains.find((d) => d.name === "VESTI-APP")!;
    expect(vesti.count).toBe(2);
    const platform = profile.domains.find((d) => d.name === "ChatGPT · 综合探索")!;
    expect(platform.count).toBe(1);
    expect(platform.representatives.map((r) => r.conversationId)).toEqual([3]);
  });

  it("clusters browser-extension captures by site hostname", () => {
    const conversations = [
      conv(1, null, 100, { source: "browser_extension", url: "https://github.com/a/b" }),
      conv(2, null, 200, { source: "browser_extension", url: "https://github.com/c/d" }),
      conv(3, null, 300),
    ];
    const profile = computeLearn([], [], conversations);
    expect(profile.domains.some((d) => d.name === "github.com" && d.count === 2)).toBe(true);
  });

  it("groups leaf topics under their root topic", () => {
    const conversations = [conv(1, 2, 100), conv(2, 2, 200), conv(3, 1, 300)];
    const profile = computeLearn([], [topic(1, "前端"), topic(2, "React", 1)], conversations);
    expect(profile.domains.length).toBe(1);
    const domain = profile.domains[0];
    expect(domain.topicId).toBe(1);
    expect(domain.name).toBe("前端");
    expect(domain.count).toBe(3);
  });

  it("treats a dangling topic_id as unclassified instead of a nameless domain", () => {
    const conversations = [conv(1, 99, 100), conv(2, 99, 200), conv(3, 99, 300)];
    const profile = computeLearn([], [], conversations);
    expect(profile.domains.every((d) => d.name.trim().length > 0)).toBe(true);
    expect(profile.domains.map((d) => d.name)).toEqual(["ChatGPT · 综合探索"]);
  });

  it("produces structured routes when nothing is classified at all (no-LLM fallback)", () => {
    const conversations = [
      conv(1, null, 100),
      conv(2, null, 200),
      conv(3, null, 300),
      conv(4, null, 400, { platform: "Kimi" }),
      conv(5, null, 500, { platform: "Kimi" }),
    ];
    const profile = computeLearn([], [], conversations);
    expect(profile.available).toBe(true);
    expect(profile.domains.every((d) => d.name.trim().length > 0)).toBe(true);
    expect(profile.domains.map((d) => d.name)).toEqual([
      "ChatGPT · 综合探索",
      "Kimi · 综合探索",
    ]);
    expect(profile.domains.every((d) => d.representatives.length > 0)).toBe(true);
  });

  it("keeps the fallback route at or below one third of conversations by promoting tail clusters", () => {
    // 12 root topics × 2 conversations each = 24 conversations.
    const topics: Topic[] = [];
    const conversations: Conversation[] = [];
    for (let t = 1; t <= 12; t += 1) {
      topics.push(topic(t, `话题${t}`));
      conversations.push(conv(t * 2 - 1, t, 100 + t), conv(t * 2, t, 200 + t));
    }
    const profile = computeLearn([], topics, conversations);
    // 7 named soft cap → tail of 5 (10 conversations = 42%) → one promotion
    // brings the fallback to 8/24 = one third: 8 named + 1 fallback.
    expect(profile.domains.length).toBe(9);
    const misc = profile.domains[profile.domains.length - 1];
    expect(misc.topicId).toBe(null);
    expect(misc.count * 3).toBeLessThanOrEqual(24);
    expect(misc.count).toBe(8);
    expect(misc.name).toContain("零散探索");
  });

  it("gives the fallback route a descriptive name and sorts it last", () => {
    // 9 root topics × 2 conversations: tail of 2 → fallback 4/18 ≈ 22%, no promotion.
    const topics: Topic[] = [];
    const conversations: Conversation[] = [];
    for (let t = 1; t <= 9; t += 1) {
      topics.push(topic(t, `话题${t}`));
      conversations.push(conv(t * 2 - 1, t, 100 + t), conv(t * 2, t, 200 + t));
    }
    const profile = computeLearn([], topics, conversations);
    expect(profile.domains.length).toBe(8);
    const misc = profile.domains[profile.domains.length - 1];
    expect(misc.topicId).toBe(null);
    expect(misc.count).toBe(4);
    expect(misc.name.startsWith("零散探索：")).toBe(true);
    expect(misc.name).toContain("话题");
    expect(misc.representatives.length).toBeGreaterThan(0);
  });

  it("localizes synthesized route names with the lang parameter", () => {
    const topics: Topic[] = [];
    const conversations: Conversation[] = [];
    for (let t = 1; t <= 9; t += 1) {
      topics.push(topic(t, `Topic${t}`));
      conversations.push(conv(t * 2 - 1, t, 100 + t), conv(t * 2, t, 200 + t));
    }
    conversations.push(conv(100, null, 500), conv(101, null, 600));
    const profile = computeLearn([], topics, conversations, undefined, undefined, "en");
    const misc = profile.domains[profile.domains.length - 1];
    expect(misc.name.startsWith("Assorted: ")).toBe(true);
    const platform = profile.domains.find((d) => d.name === "ChatGPT · General exploration");
    expect(platform).toBeDefined();
  });
});
