import { describe, expect, it } from "vitest";
import {
  buildCandidateLine,
  buildClassifyRules,
  buildClassifyTranscript,
  createMemorySuggestionStore,
  formatTopicTree,
  mapClassifyAssignments,
  normalizePathSegment,
  resolveClassifyLanguage,
  resolveTopicPath,
  selectClassifyCandidates,
  type ClassifyBrief,
  type ClassifyCandidateRecord,
  type ClassifySuggestion,
  type ClassifyTopicNode,
} from "./autoClassify";

function candidate(overrides: Partial<ClassifyCandidateRecord>): ClassifyCandidateRecord {
  return { id: 1, topic_id: null, ...overrides };
}

describe("selectClassifyCandidates", () => {
  it("keeps unclassified conversations", () => {
    const records = [candidate({ id: 1, topic_id: null })];
    expect(selectClassifyCandidates(records).map((record) => record.id)).toEqual([1]);
  });

  it("re-runs previously auto-classified conversations", () => {
    const records = [candidate({ id: 2, topic_id: 5, auto_classified: 1 })];
    expect(selectClassifyCandidates(records).map((record) => record.id)).toEqual([2]);
  });

  it("never touches manual assignments, archived/trash, or queued records", () => {
    const records = [
      candidate({ id: 1, topic_id: 5 }), // manual assignment
      candidate({ id: 2, topic_id: 5, auto_classified: 0 }), // explicit manual marker
      candidate({ id: 3, topic_id: null, is_archived: true }),
      candidate({ id: 4, topic_id: null, is_trash: true }),
      candidate({
        id: 5,
        topic_id: null,
        classify_suggestion: { topicPath: ["a"], confidence: 0.4, createdAt: 1 },
      }),
      candidate({ id: undefined, topic_id: null }), // no id yet
      candidate({ id: 6, topic_id: null }), // eligible
    ];
    expect(selectClassifyCandidates(records).map((record) => record.id)).toEqual([6]);
  });

  it("skips folded subagent runs (A1) — they classify with their parent", () => {
    const records = [
      candidate({ id: 1, topic_id: null, _subagent_of: "cursor:parent" }),
      candidate({ id: 2, topic_id: null }),
    ];
    expect(selectClassifyCandidates(records).map((record) => record.id)).toEqual([2]);
  });
});

describe("resolveTopicPath", () => {
  const topics: ClassifyTopicNode[] = [
    { id: 1, name: "前端", parent_id: null },
    { id: 2, name: "React", parent_id: 1 },
    { id: 3, name: "后端", parent_id: null },
    // Same name under a different parent must not collide.
    { id: 4, name: "React", parent_id: 3 },
  ];

  it("reuses an existing node by exact path", () => {
    expect(resolveTopicPath(["前端", "React"], topics)).toEqual({ kind: "existing", topicId: 2 });
  });

  it("matches segments case/whitespace-insensitively", () => {
    expect(normalizePathSegment("  React   JS ")).toBe("react js");
    expect(resolveTopicPath([" 前端 ", "react"], topics)).toEqual({ kind: "existing", topicId: 2 });
  });

  it("scopes the match to the current parent", () => {
    expect(resolveTopicPath(["后端", "React"], topics)).toEqual({ kind: "existing", topicId: 4 });
  });

  it("plans a full creation chain when nothing matches", () => {
    expect(resolveTopicPath(["产品", "设计"], topics)).toEqual({
      kind: "create",
      parentId: null,
      names: ["产品", "设计"],
    });
  });

  it("plans a partial creation under the deepest matched node", () => {
    expect(resolveTopicPath(["前端", "Vue", "组合式 API"], topics)).toEqual({
      kind: "create",
      parentId: 1,
      names: ["Vue", "组合式 API"],
    });
  });

  it("normalizes whitespace inside planned segment names", () => {
    expect(resolveTopicPath(["  产品  设计 "], topics)).toEqual({
      kind: "create",
      parentId: null,
      names: ["产品 设计"],
    });
  });

  it("throws on an empty path", () => {
    expect(() => resolveTopicPath([" ", ""], topics)).toThrow("topicPath 为空");
  });
});

describe("formatTopicTree", () => {
  it("flattens the tree into #id path lines", () => {
    const topics: ClassifyTopicNode[] = [
      { id: 1, name: "前端", parent_id: null },
      { id: 2, name: "React", parent_id: 1 },
    ];
    expect(formatTopicTree(topics)).toBe("#1 前端\n#2 前端 / React");
  });

  it("renders an empty tree as a placeholder", () => {
    expect(formatTopicTree([])).toBe("（空）");
  });
});

describe("buildCandidateLine / buildClassifyTranscript", () => {
  const base: ClassifyBrief = {
    id: 7,
    title: "调试登录流程",
    platform: "Kimi Code",
    project: "VESTI-APP",
    digest: null,
    summaryPoints: [],
    snippet: "",
  };

  it("prefers the digest one-liner and key topics", () => {
    const line = buildCandidateLine(1, {
      ...base,
      digest: { oneLiner: "修复登录重定向", keyTopics: ["认证", "路由"] },
      summaryPoints: ["被忽略的要点"],
      snippet: "被忽略的片段",
    });
    expect(line).toBe("[1] 标题：调试登录流程｜平台：Kimi Code｜项目：VESTI-APP｜摘要：修复登录重定向｜主题词：认证、路由");
  });

  it("falls back to summary points, then to the snippet", () => {
    const withSummary = buildCandidateLine(2, { ...base, summaryPoints: ["结论是改用 JWT"] });
    expect(withSummary).toContain("要点：结论是改用 JWT");
    expect(withSummary).not.toContain("片段：");

    const withSnippet = buildCandidateLine(3, { ...base, snippet: "用户问如何登录" });
    expect(withSnippet).toContain("片段：用户问如何登录");
  });

  it("builds the transcript with the tree and numbered candidates", () => {
    const transcript = buildClassifyTranscript([base], [{ id: 1, name: "前端", parent_id: null }]);
    expect(transcript).toContain("现有主题树：\n#1 前端");
    expect(transcript).toContain("待分类会话：\n[1] 标题：调试登录流程");
  });

  it("defaults to Chinese naming rules with budget, merge and layering constraints", () => {
    const transcript = buildClassifyTranscript([base], []);
    expect(transcript).toContain("话题名一律使用简体中文");
    expect(transcript).toContain("不超过 7 个");
    expect(transcript).toContain("禁止新建同义分支");
    expect(transcript).toContain("结构示范");
    expect(transcript).toContain('["前端", "React"]');
    expect(transcript).toContain("禁止直接用平台名");
  });

  it("switches the language directive and rules to English on demand", () => {
    const transcript = buildClassifyTranscript([base], [], { language: "en" });
    expect(transcript).toContain("must be written in English");
    expect(transcript).toContain("at most 7 child topics");
    expect(transcript).toContain("MUST be filed under the existing topic");
    expect(transcript).toContain("Structure examples");
    expect(transcript).toContain('["AI Engineering", "Prompting"]');
    expect(transcript).not.toContain("话题名一律使用简体中文");
    // Candidate lines and the tree keep their original labels.
    expect(transcript).toContain("待分类会话：");
  });

  it("clips overlong fields", () => {
    const line = buildCandidateLine(1, { ...base, title: "长".repeat(200) });
    expect(line.length).toBeLessThan(200);
    expect(line).toContain("…");
  });
});

describe("mapClassifyAssignments", () => {
  it("maps 1-based refs back to candidate ids", () => {
    const mapped = mapClassifyAssignments(
      [
        { ref: 2, topicPath: ["a"], newTopic: false, confidence: 0.9 },
        { ref: 1, topicPath: ["b"], newTopic: true, confidence: 0.4 },
      ],
      [101, 102]
    );
    expect(mapped).toEqual([
      { ref: 2, conversationId: 102, topicPath: ["a"], newTopic: false, confidence: 0.9 },
      { ref: 1, conversationId: 101, topicPath: ["b"], newTopic: true, confidence: 0.4 },
    ]);
  });

  it("throws on a ref that does not map to any candidate", () => {
    expect(() =>
      mapClassifyAssignments([{ ref: 3, topicPath: ["a"], newTopic: false, confidence: 0.9 }], [101, 102])
    ).toThrow("无法映射的 ref：3");
  });

  it("keeps the first occurrence of a duplicated ref", () => {
    const mapped = mapClassifyAssignments(
      [
        { ref: 1, topicPath: ["a"], newTopic: false, confidence: 0.9 },
        { ref: 1, topicPath: ["b"], newTopic: false, confidence: 0.2 },
      ],
      [101]
    );
    expect(mapped).toHaveLength(1);
    expect(mapped[0].topicPath).toEqual(["a"]);
  });
});

describe("suggestion queue store", () => {
  function item(overrides: Partial<ClassifySuggestion>): ClassifySuggestion {
    return {
      conversationId: 1,
      title: "会话",
      topicPath: ["前端"],
      confidence: 0.4,
      createdAt: 1,
      ...overrides,
    };
  }

  it("adds, lists (newest first), and removes suggestions", async () => {
    const store = createMemorySuggestionStore();
    await store.add([
      item({ conversationId: 1, createdAt: 100 }),
      item({ conversationId: 2, title: "另一个会话", createdAt: 200 }),
    ]);
    let listed = await store.list();
    expect(listed.map((entry) => entry.conversationId)).toEqual([2, 1]);

    await store.remove(1);
    listed = await store.list();
    expect(listed.map((entry) => entry.conversationId)).toEqual([2]);
  });

  it("re-adding the same conversation replaces the stale suggestion", async () => {
    const store = createMemorySuggestionStore();
    await store.add([item({ conversationId: 1, topicPath: ["旧"], createdAt: 100 })]);
    await store.add([item({ conversationId: 1, topicPath: ["新", "路径"], createdAt: 300 })]);
    const listed = await store.list();
    expect(listed).toHaveLength(1);
    expect(listed[0].topicPath).toEqual(["新", "路径"]);
    expect(listed[0].createdAt).toBe(300);
  });

  it("removing an unknown id is a no-op", async () => {
    const store = createMemorySuggestionStore();
    await store.remove(42);
    expect(await store.list()).toEqual([]);
  });
});
