import { describe, expect, it } from "vitest";
import {
  buildClassifyRules,
  resolveClassifyLanguage,
} from "./autoClassify";
import {
  buildTopicGovernanceRequest,
  filterTopicGovernancePlan,
  parseTopicGovernance,
  type TopicGovernanceRaw,
} from "./topicGovernance";
import type { ClassifyTopicNode } from "./autoClassify";

describe("resolveClassifyLanguage", () => {
  it("lets the output-language setting win", () => {
    expect(resolveClassifyLanguage("en-US", "zh")).toBe("en");
    expect(resolveClassifyLanguage("zh-CN", "en")).toBe("zh");
  });

  it("falls back to the UI locale, then to Chinese", () => {
    expect(resolveClassifyLanguage(null, "zh")).toBe("zh");
    expect(resolveClassifyLanguage(undefined, "en")).toBe("en");
    expect(resolveClassifyLanguage(null, "ja")).toBe("en");
    expect(resolveClassifyLanguage(null, null)).toBe("zh");
  });
});

describe("buildClassifyRules", () => {
  it("returns zh/en variants of the same constraints", () => {
    expect(buildClassifyRules("zh")).toContain("话题名一律使用简体中文");
    expect(buildClassifyRules("en")).toContain("must be written in English");
    expect(buildClassifyRules()).toBe(buildClassifyRules("zh"));
  });
});

describe("parseTopicGovernance", () => {
  it("parses a clean payload", () => {
    const raw = parseTopicGovernance(
      '{"merges":[{"targetId":1,"sourceIds":[2,3],"name":"前端"}],"renames":[{"id":4,"name":"数据库"}]}'
    );
    expect(raw).toEqual({
      merges: [{ targetId: 1, sourceIds: [2, 3], name: "前端" }],
      renames: [{ id: 4, name: "数据库" }],
    });
  });

  it("tolerates code fences and surrounding prose", () => {
    const raw = parseTopicGovernance(
      '好的，建议如下：\n```json\n{"merges":[],"renames":[{"id":2,"name":"React"}]}\n```\n以上。'
    );
    expect(raw.merges).toEqual([]);
    expect(raw.renames).toEqual([{ id: 2, name: "React" }]);
  });

  it("drops malformed entries individually", () => {
    const raw = parseTopicGovernance(
      JSON.stringify({
        merges: [
          { targetId: "x", sourceIds: [2] }, // bad target id
          { targetId: 1, sourceIds: [] }, // nothing to merge
          { targetId: 1, sourceIds: [1] }, // self-merge
          { targetId: 1, sourceIds: [2, 2, 3], name: 42 }, // dupes + bad name
        ],
        renames: [
          { id: -1, name: "负数" },
          { id: 5, name: "   " },
          { id: 6, name: "  有效  名字  " },
        ],
      })
    );
    expect(raw.merges).toEqual([{ targetId: 1, sourceIds: [2, 3], name: null }]);
    expect(raw.renames).toEqual([{ id: 6, name: "有效 名字" }]);
  });

  it("throws when the output is not a JSON object", () => {
    expect(() => parseTopicGovernance("完全没有 JSON")).toThrow("话题整理输出不是 JSON 对象");
    expect(() => parseTopicGovernance("[1,2,3]")).toThrow();
  });
});

describe("filterTopicGovernancePlan", () => {
  const topics: ClassifyTopicNode[] = [
    { id: 1, name: "前端", parent_id: null },
    { id: 2, name: "前端开发", parent_id: null },
    { id: 3, name: "React", parent_id: 1 },
    { id: 4, name: "后端", parent_id: null },
    { id: 5, name: "数据库", parent_id: 4 },
    { id: 6, name: "其他", parent_id: null },
  ];

  function raw(overrides: Partial<TopicGovernanceRaw>): TopicGovernanceRaw {
    return { merges: [], renames: [], ...overrides };
  }

  it("enriches a valid merge with display names", () => {
    const plan = filterTopicGovernancePlan(
      raw({ merges: [{ targetId: 1, sourceIds: [2], name: null }] }),
      topics
    );
    expect(plan.merges).toEqual([
      { targetId: 1, targetName: "前端", sourceIds: [2], sourceNames: ["前端开发"], name: null },
    ]);
    expect(plan.renames).toEqual([]);
  });

  it("drops merges with unknown ids and no-ops", () => {
    const plan = filterTopicGovernancePlan(
      raw({
        merges: [
          { targetId: 99, sourceIds: [2], name: null }, // unknown target
          { targetId: 1, sourceIds: [98], name: null }, // unknown source
        ],
        renames: [
          { id: 99, name: "不存在" }, // unknown topic
          { id: 3, name: " react " }, // no-op after normalization
        ],
      }),
      topics
    );
    expect(plan.merges).toEqual([]);
    expect(plan.renames).toEqual([]);
  });

  it("drops ancestor sources that would create a cycle", () => {
    // #1 前端 is an ancestor of #3 React: merging 1 into 3 would cycle.
    const plan = filterTopicGovernancePlan(
      raw({ merges: [{ targetId: 3, sourceIds: [1, 6], name: null }] }),
      topics
    );
    expect(plan.merges).toHaveLength(1);
    expect(plan.merges[0].sourceIds).toEqual([6]);
  });

  it("keeps each topic in at most one merge and never merges a target away", () => {
    const plan = filterTopicGovernancePlan(
      raw({
        merges: [
          { targetId: 1, sourceIds: [2], name: null },
          { targetId: 4, sourceIds: [2, 6], name: null }, // 2 already taken
          { targetId: 2, sourceIds: [6], name: null }, // 2 is a merge source
        ],
      }),
      topics
    );
    expect(plan.merges).toHaveLength(2);
    expect(plan.merges[0].targetId).toBe(1);
    expect(plan.merges[1]).toMatchObject({ targetId: 4, sourceIds: [6] });
  });

  it("drops renames colliding with a sibling name or renaming a merged topic", () => {
    const plan = filterTopicGovernancePlan(
      raw({
        merges: [{ targetId: 1, sourceIds: [2], name: null }],
        renames: [
          { id: 3, name: "数据库" }, // different parent, fine
          { id: 5, name: "React" }, // collides with sibling under 后端? no — under 后端 only 数据库
          { id: 2, name: "改名" }, // #2 is merged away
        ],
      }),
      topics
    );
    expect(plan.renames).toEqual([
      { id: 3, from: "React", to: "数据库" },
      { id: 5, from: "数据库", to: "React" },
    ]);

    const collision = filterTopicGovernancePlan(
      raw({ renames: [{ id: 5, name: "前端" }] }),
      topics
    );
    // #5 lives under #4 后端, so renaming it to a *root* name is fine…
    expect(collision.renames).toEqual([{ id: 5, from: "数据库", to: "前端" }]);

    const sameParent = filterTopicGovernancePlan(
      raw({ renames: [{ id: 1, name: "其他" }] }),
      topics
    );
    // #1 and #6 其他 are both roots → collision dropped.
    expect(sameParent.renames).toEqual([]);
  });

  it("frees names of merged-away sources for renames", () => {
    const plan = filterTopicGovernancePlan(
      raw({
        merges: [{ targetId: 1, sourceIds: [2], name: null }],
        renames: [{ id: 6, name: "前端开发" }], // #2's name, freed by the merge
      }),
      topics
    );
    expect(plan.renames).toEqual([{ id: 6, from: "其他", to: "前端开发" }]);
  });

  it("nulls a post-merge name equal to the target name or claimed by a rename", () => {
    const sameName = filterTopicGovernancePlan(
      raw({ merges: [{ targetId: 1, sourceIds: [2], name: "前端" }] }),
      topics
    );
    expect(sameName.merges[0].name).toBeNull();

    const claimed = filterTopicGovernancePlan(
      raw({
        merges: [{ targetId: 1, sourceIds: [2], name: "Web 开发" }],
        renames: [{ id: 1, name: "网页开发" }],
      }),
      topics
    );
    expect(claimed.renames).toEqual([{ id: 1, from: "前端", to: "网页开发" }]);
    expect(claimed.merges[0].name).toBeNull();
  });
});

describe("buildTopicGovernanceRequest", () => {
  const topics: ClassifyTopicNode[] = [
    { id: 1, name: "前端", parent_id: null },
    { id: 2, name: "React", parent_id: 1 },
  ];

  it("builds a zh request with the tree as transcript", () => {
    const request = buildTopicGovernanceRequest(topics, "zh");
    expect(request.question).toContain("主题树整理助手");
    expect(request.question).toContain("简体中文");
    expect(request.transcript).toBe("当前主题树：\n#1 前端\n#2 前端 / React");
  });

  it("builds an en request with the naming-language rule", () => {
    const request = buildTopicGovernanceRequest(topics, "en");
    expect(request.question).toContain("must be in English");
    expect(request.question).toContain('"merges"');
    expect(request.transcript).toContain("#2 前端 / React");
  });
});
