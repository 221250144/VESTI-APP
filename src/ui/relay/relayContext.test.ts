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
});
