import { describe, expect, it } from "vitest";
import {
  buildRelayTranscript,
  RELAY_CONTEXT_BUDGET_CHARS,
  type RelayContextConversation,
} from "./relayContext";

function conversation(
  overrides: Partial<RelayContextConversation>
): RelayContextConversation {
  return {
    id: 1,
    title: "示例会话",
    platform: "Kimi",
    digest: null,
    summary: null,
    snippet: null,
    messages: [],
    ...overrides,
  };
}

describe("buildRelayTranscript", () => {
  it("returns an empty string for no conversations", () => {
    expect(buildRelayTranscript([])).toBe("");
  });

  it("prefers the digest over summary and snippet", () => {
    const transcript = buildRelayTranscript([
      conversation({
        digest: {
          oneLiner: "实现登录功能",
          keyTopics: ["认证", "JWT"],
          keyFiles: ["src/Login.tsx"],
          decisions: ["用 JWT 做会话保持"],
          openQuestions: ["刷新令牌如何轮换"],
        },
        summary: "这是整段总结文本，不应出现",
        snippet: "片段也不应出现",
      }),
    ]);
    expect(transcript).toContain("一句话：实现登录功能");
    expect(transcript).toContain("关键主题：认证、JWT");
    expect(transcript).toContain("关键文件：src/Login.tsx");
    expect(transcript).toContain("关键决策：用 JWT 做会话保持");
    expect(transcript).toContain("未决问题：刷新令牌如何轮换");
    expect(transcript).not.toContain("这是整段总结文本");
    expect(transcript).not.toContain("片段也不应出现");
  });

  it("falls back to the summary when there is no digest", () => {
    const transcript = buildRelayTranscript([
      conversation({ summary: "总结了渲染层重构的方案", snippet: "片段" }),
    ]);
    expect(transcript).toContain("摘要：总结了渲染层重构的方案");
    expect(transcript).not.toContain("一句话：");
  });

  it("falls back to title + snippet when neither digest nor summary exists", () => {
    const transcript = buildRelayTranscript([
      conversation({ title: "讨论缓存策略", snippet: "最近聊到 LRU 缓存" }),
    ]);
    expect(transcript).toContain("讨论缓存策略");
    expect(transcript).toContain("LRU");
  });

  it("excerpts the most recent messages within budget, oldest first in output", () => {
    const messages = Array.from({ length: 10 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "ai",
      content: `第 ${index + 1} 条消息`,
    }));
    const transcript = buildRelayTranscript([
      conversation({ digest: { oneLiner: "x" }, messages }),
    ]);
    // The excerpt window keeps the newest messages (up to 6).
    expect(transcript).toContain("第 10 条消息");
    expect(transcript).toContain("第 5 条消息");
    expect(transcript).not.toContain("第 4 条消息");
    // Chronological order in the output: 用户 line of #5 before #10.
    expect(transcript.indexOf("第 5 条消息")).toBeLessThan(transcript.indexOf("第 10 条消息"));
    expect(transcript).toContain("[用户]");
    expect(transcript).toContain("[AI]");
  });

  it("keeps the total under budget while preserving every conversation head", () => {
    const many = Array.from({ length: 8 }, (_, index) =>
      conversation({
        id: index + 1,
        title: `会话${index + 1}`,
        digest: { oneLiner: `主题${index + 1}` },
        messages: [
          { role: "user", content: "很长的消息".repeat(200) },
          { role: "ai", content: "很长的回复".repeat(200) },
        ],
      })
    );
    const budget = 1_500;
    const transcript = buildRelayTranscript(many, budget);
    expect(transcript.length).toBeLessThanOrEqual(budget);
    for (let index = 0; index < 8; index += 1) {
      expect(transcript).toContain(`主题${index + 1}`);
    }
  });

  it("truncates hard when the heads alone exceed the budget", () => {
    const huge = conversation({
      title: "超长标题".repeat(50),
      digest: { oneLiner: "超长一句话".repeat(100) },
    });
    const budget = 300;
    const transcript = buildRelayTranscript([huge], budget);
    expect(transcript.length).toBeLessThanOrEqual(budget);
    expect(transcript).toContain("[上下文已截断]");
  });

  it("truncates over-long individual message excerpts", () => {
    const transcript = buildRelayTranscript([
      conversation({
        digest: { oneLiner: "x" },
        messages: [{ role: "user", content: "消".repeat(2_000) }],
      }),
    ]);
    // Single message excerpt is capped well below the raw 2000 chars.
    expect(transcript.length).toBeLessThan(1_000);
    expect(transcript).toContain("…");
  });

  it("the default budget constant stays under the main-process override cap", () => {
    expect(RELAY_CONTEXT_BUDGET_CHARS).toBeLessThanOrEqual(30_000);
  });

  it("rolls up subagent briefs under the head, bounded", () => {
    const transcript = buildRelayTranscript([
      conversation({
        digest: { oneLiner: "主任务" },
        subagents: [
          { role: "bugbot", title: "审查渲染层", oneLiner: "发现 2 个空指针问题" },
          { role: null, title: "并行探索缓存方案", oneLiner: null },
          { role: "tester", title: "跑回归", oneLiner: "全部通过" },
          { role: "d", title: "四", oneLiner: null },
          { role: "e", title: "五（超出上限，应折叠计数）", oneLiner: null },
        ],
      }),
    ]);
    expect(transcript).toContain("子代理（5）：");
    expect(transcript).toContain("[bugbot] 审查渲染层 — 发现 2 个空指针问题");
    expect(transcript).toContain("并行探索缓存方案");
    expect(transcript).toContain("…另有 1 个子代理运行");
    expect(transcript).not.toContain("五（超出上限");
  });

  it("subagent rollup also rides the summary/snippet fallbacks", () => {
    const transcript = buildRelayTranscript([
      conversation({
        summary: "总结文本",
        subagents: [{ role: "bugbot", title: "审查", oneLiner: "无阻塞问题" }],
      }),
    ]);
    expect(transcript).toContain("摘要：总结文本");
    expect(transcript).toContain("[bugbot] 审查 — 无阻塞问题");
  });

  it("omits the subagent block when the list is empty or content-free", () => {
    const transcript = buildRelayTranscript([
      conversation({ digest: { oneLiner: "x" }, subagents: [] }),
      conversation({ digest: { oneLiner: "y" } }),
    ]);
    expect(transcript).not.toContain("子代理（");
  });

  it("renders the git line when the capture carries git fields", () => {
    const transcript = buildRelayTranscript([
      conversation({
        digest: { oneLiner: "实现登录功能" },
        git: { branch: "feature/login", remote: "github.com/acme/app" },
      }),
    ]);
    expect(transcript).toContain("Git：feature/login · github.com/acme/app");
  });

  it("omits the git line when there is no git info", () => {
    const transcript = buildRelayTranscript([
      conversation({ digest: { oneLiner: "x" }, git: { branch: null, remote: null } }),
      conversation({ digest: { oneLiner: "y" } }),
    ]);
    expect(transcript).not.toContain("Git：");
  });

  it("aggregates digest key files across conversations, deduped", () => {
    const transcript = buildRelayTranscript([
      conversation({
        id: 1,
        digest: { oneLiner: "一", keyFiles: ["src/a.ts", "src/b.ts"] },
      }),
      conversation({
        id: 2,
        digest: { oneLiner: "二", keyFiles: ["src/b.ts", "src/c.ts"] },
      }),
    ]);
    expect(transcript).toContain("## 关键文件汇总（跨会话去重）");
    expect(transcript).toContain("src/a.ts、src/b.ts、src/c.ts");
    // Dedup: src/b.ts appears once in the aggregate line.
    const aggregateLine = transcript
      .split("\n")
      .find((line) => line.includes("src/a.ts"));
    expect(aggregateLine?.split("src/b.ts")).toHaveLength(2);
  });

  it("skips the aggregate block when no digest carries key files", () => {
    const transcript = buildRelayTranscript([
      conversation({ digest: { oneLiner: "x" } }),
      conversation({ summary: "没有 digest 的会话" }),
    ]);
    expect(transcript).not.toContain("关键文件汇总");
  });

  it("injects the program-extracted file anchor block at the very top", () => {
    const transcript = buildRelayTranscript(
      [
        conversation({ id: 11, digest: { oneLiner: "一" } }),
        conversation({ id: 22, digest: { oneLiner: "二" } }),
      ],
      RELAY_CONTEXT_BUDGET_CHARS,
      {
        fileAnchors: [
          {
            path: "src/player/decoder.ts",
            touches: 5,
            lastTouchedAt: Date.UTC(2023, 10, 14, 12, 0, 0),
            conversationIds: [11, 22],
          },
        ],
      }
    );
    expect(transcript.startsWith("## 关键文件（程序提取，带锚点）")).toBe(true);
    // Source anchors use the same numbering as the conversation heads.
    expect(transcript).toContain(
      "- src/player/decoder.ts（触碰 5 次，最近 2023-11-14，来源：会话 1、会话 2）"
    );
  });

  it("omits the anchor block when no anchors were extracted", () => {
    const transcript = buildRelayTranscript(
      [conversation({ digest: { oneLiner: "x" } })],
      RELAY_CONTEXT_BUDGET_CHARS,
      { fileAnchors: [] }
    );
    expect(transcript).not.toContain("程序提取");
  });

  it("counts the anchor block against the budget", () => {
    const anchors = Array.from({ length: 15 }, (_, index) => ({
      path: `src/${index}/file.ts`,
      touches: 10,
      lastTouchedAt: Date.UTC(2023, 10, 14, 12, 0, 0),
      conversationIds: [1],
    }));
    const budget = 600;
    const transcript = buildRelayTranscript(
      [
        conversation({
          id: 1,
          digest: { oneLiner: "x" },
          messages: [{ role: "user", content: "很长的消息".repeat(200) }],
        }),
      ],
      budget,
      { fileAnchors: anchors }
    );
    expect(transcript.length).toBeLessThanOrEqual(budget);
    expect(transcript).toContain("关键文件（程序提取，带锚点）");
  });
});
