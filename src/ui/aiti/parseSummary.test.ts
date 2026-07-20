import { describe, expect, it } from "vitest";
import { parseConversationSummaryV2, renderSummaryPlainText } from "./parseSummary";

const VALID = {
  core_question: "如何把摘要管线结构化？",
  thinking_journey: [
    { step: 1, speaker: "User", assertion: "先盘点现有写入路径", real_world_anchor: "desktopStorage.ts" },
    { step: 2, speaker: "AI", assertion: "复用 ConversationSummaryV2 即可", real_world_anchor: null },
  ],
  key_insights: [
    { term: "结构化摘要", definition: "computeAiti 只统计 structured 非空的记录" },
  ],
  unresolved_threads: ["旧 fallback 记录是否需要回填？"],
  meta_observations: {
    thinking_style: "先查证再动手",
    emotional_tone: "冷静、目标导向",
    depth_level: "deep",
  },
  actionable_next_steps: ["给 summary agent 加 JSON 契约"],
};

describe("parseConversationSummaryV2", () => {
  it("parses and normalizes a valid payload", () => {
    const parsed = parseConversationSummaryV2(JSON.stringify(VALID));
    expect(parsed).not.toBeNull();
    expect(parsed?.core_question).toBe("如何把摘要管线结构化？");
    expect(parsed?.thinking_journey).toHaveLength(2);
    expect(parsed?.thinking_journey[0]).toEqual({
      step: 1,
      speaker: "User",
      assertion: "先盘点现有写入路径",
      real_world_anchor: "desktopStorage.ts",
    });
    expect(parsed?.meta_observations.depth_level).toBe("deep");
  });

  it("tolerates Markdown code fences around the JSON", () => {
    const fenced = `\`\`\`json\n${JSON.stringify(VALID)}\n\`\`\``;
    const parsed = parseConversationSummaryV2(fenced);
    expect(parsed?.core_question).toBe("如何把摘要管线结构化？");
  });

  it("renumbers journey steps and coerces unknown speakers to User", () => {
    const parsed = parseConversationSummaryV2(
      JSON.stringify({
        ...VALID,
        thinking_journey: [
          { step: 7, speaker: "robot", assertion: "a" },
          { step: 9, speaker: "AI", assertion: "b" },
          { step: 3, speaker: "User", assertion: "   " },
        ],
      })
    );
    expect(parsed?.thinking_journey).toEqual([
      { step: 1, speaker: "User", assertion: "a", real_world_anchor: null },
      { step: 2, speaker: "AI", assertion: "b", real_world_anchor: null },
    ]);
  });

  it("defaults an unknown depth_level to moderate", () => {
    const parsed = parseConversationSummaryV2(
      JSON.stringify({
        ...VALID,
        meta_observations: { ...VALID.meta_observations, depth_level: "profound" },
      })
    );
    expect(parsed?.meta_observations.depth_level).toBe("moderate");
  });

  it("caps lists at their maxima", () => {
    const parsed = parseConversationSummaryV2(
      JSON.stringify({
        ...VALID,
        thinking_journey: Array.from({ length: 15 }, (_, i) => ({
          step: i + 1,
          speaker: "User",
          assertion: `step ${i + 1}`,
        })),
        key_insights: Array.from({ length: 12 }, (_, i) => ({
          term: `t${i + 1}`,
          definition: `d${i + 1}`,
        })),
      })
    );
    expect(parsed?.thinking_journey).toHaveLength(10);
    expect(parsed?.key_insights).toHaveLength(8);
  });

  it("returns null for non-JSON output (plain-text fallback path)", () => {
    expect(parseConversationSummaryV2("这是一段普通的 Markdown 摘要。")).toBeNull();
  });

  it("returns null when core_question is missing or empty", () => {
    expect(parseConversationSummaryV2(JSON.stringify({ ...VALID, core_question: "  " }))).toBeNull();
    expect(parseConversationSummaryV2(JSON.stringify({ key_insights: [] }))).toBeNull();
  });

  it("handles truncated JSON gracefully", () => {
    expect(parseConversationSummaryV2('{"core_question": "abc", "key_ins')).toBeNull();
  });
});

describe("renderSummaryPlainText", () => {
  it("renders core question plus populated sections only", () => {
    const parsed = parseConversationSummaryV2(JSON.stringify(VALID));
    const text = renderSummaryPlainText(parsed!);
    expect(text).toContain("核心问题：如何把摘要管线结构化？");
    expect(text).toContain("关键结论：");
    expect(text).toContain("- 结构化摘要：computeAiti 只统计 structured 非空的记录");
    expect(text).toContain("未解决的问题：");
    expect(text).toContain("下一步建议：");
  });

  it("omits empty sections", () => {
    const parsed = parseConversationSummaryV2(
      JSON.stringify({ ...VALID, key_insights: [], unresolved_threads: [], actionable_next_steps: [] })
    );
    const text = renderSummaryPlainText(parsed!);
    expect(text).toBe("核心问题：如何把摘要管线结构化？");
  });
});
