import { describe, expect, it } from "vitest";
import {
  aggregateLearnDeepen,
  buildLearnDeepenRecordMarkdown,
  buildLearnDeepenTranscript,
  buildLearnRecallContext,
  parseLearnDeepen,
} from "./learnDeepen";
import type { LearnDomain } from "@vesti/ui";

function domain(overrides?: Partial<LearnDomain>): LearnDomain {
  return {
    topicId: 1,
    name: "前端",
    count: 8,
    deep: 3,
    moderate: 4,
    superficial: 1,
    representatives: [
      { conversationId: 11, title: "React 渲染优化" },
      { conversationId: 12, title: "Vite 构建原理" },
    ],
    ...overrides,
  };
}

describe("buildLearnRecallContext", () => {
  it("assembles hits into the shared Ask/roundtable context shape", () => {
    const context = buildLearnRecallContext([
      { title: "会话 A", oneLiner: "关于渲染", snippet: "useMemo 命中" },
      { title: "会话 B", oneLiner: null, snippet: "" },
    ]);
    expect(context).toBe(
      "[会话 1] 会话 A\n摘要：关于渲染\n命中片段：useMemo 命中\n\n[会话 2] 会话 B",
    );
  });

  it("returns an empty string for no hits", () => {
    expect(buildLearnRecallContext([])).toBe("");
  });
});

describe("buildLearnDeepenTranscript", () => {
  it("packs the domain stats, representatives and grounding context (zh)", () => {
    const transcript = buildLearnDeepenTranscript({
      domain: domain(),
      context: "[会话 1] 会话 A\n摘要：关于渲染",
      lang: "zh",
    });
    expect(transcript).toContain("学习领域：前端");
    expect(transcript).toContain("共 8 段对话；其中深入 3 段、适中 4 段、浅层 1 段");
    expect(transcript).toContain("- React 渲染优化");
    expect(transcript).toContain("- Vite 构建原理");
    expect(transcript).toContain("背景资料");
    expect(transcript).toContain("[会话 1] 会话 A");
    expect(transcript).toContain('"mastered"');
    expect(transcript).toContain('"blind_spots"');
    expect(transcript).toContain('"path"');
  });

  it("omits the context and representatives blocks when absent, and localizes (en)", () => {
    const transcript = buildLearnDeepenTranscript({
      domain: domain({ representatives: [] }),
      context: "  ",
      lang: "en",
    });
    expect(transcript).toContain("Learning domain: 前端");
    expect(transcript).toContain("8 conversations in this domain — 3 deep, 4 moderate, 1 superficial");
    expect(transcript).not.toContain("Background");
    expect(transcript).not.toContain("best represent");
  });
});

describe("parseLearnDeepen", () => {
  it("parses clean JSON output", () => {
    const parsed = parseLearnDeepen(
      JSON.stringify({
        mastered: ["hooks 基础"],
        blind_spots: ["并发渲染"],
        path: ["先读官方文档", "再做一个小项目"],
      }),
    );
    expect(parsed).toEqual({
      mastered: ["hooks 基础"],
      blindSpots: ["并发渲染"],
      path: ["先读官方文档", "再做一个小项目"],
    });
  });

  it("tolerates code fences and surrounding prose; filters non-strings", () => {
    const parsed = parseLearnDeepen(
      '好的，分析如下：\n```json\n{"mastered": ["a", 1, " "], "blind_spots": [], "path": ["b"]}\n```\n以上。',
    );
    expect(parsed).toEqual({ mastered: ["a"], blindSpots: [], path: ["b"] });
  });

  it("returns null when every field is empty or the output is not JSON", () => {
    expect(parseLearnDeepen('{"mastered": [], "blind_spots": [], "path": []}')).toBeNull();
    expect(parseLearnDeepen("完全不是 JSON")).toBeNull();
    expect(parseLearnDeepen("[1,2,3]")).toBeNull();
  });
});

describe("aggregateLearnDeepen", () => {
  it("carries the parsed analysis and keeps the raw output", () => {
    const raw = '{"mastered": ["a"], "blind_spots": [], "path": []}';
    const result = aggregateLearnDeepen({
      domain: "前端",
      lang: "zh",
      grounded: true,
      raw,
      sources: [],
      durationMs: 42,
    });
    expect(result.analysis?.mastered).toEqual(["a"]);
    expect(result.raw).toBe(raw);
    expect(result.grounded).toBe(true);
  });
});

describe("buildLearnDeepenRecordMarkdown", () => {
  it("renders the three sections in zh, and falls back to raw when unparseable", () => {
    const withAnalysis = aggregateLearnDeepen({
      domain: "前端",
      lang: "zh",
      grounded: false,
      raw: '{"mastered": ["a"], "blind_spots": ["b"], "path": ["c"]}',
      sources: [],
      durationMs: 1,
    });
    const markdown = buildLearnDeepenRecordMarkdown(withAnalysis);
    expect(markdown).toContain("## 学习脉络分析：前端");
    expect(markdown).toContain("**当前掌握点**\n\n- a");
    expect(markdown).toContain("**理解盲区**\n\n- b");
    expect(markdown).toContain("**建议学习路径**\n\n- c");

    const rawOnly = aggregateLearnDeepen({
      domain: "Rust",
      lang: "en",
      grounded: false,
      raw: "not json at all",
      sources: [],
      durationMs: 1,
    });
    expect(buildLearnDeepenRecordMarkdown(rawOnly)).toContain("not json at all");
  });
});
