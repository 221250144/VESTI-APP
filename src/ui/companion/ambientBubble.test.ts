import { describe, expect, it } from "vitest";
import {
  AGENT_NOTIFY_MIN_GAP_MS,
  AMBIENT_BUBBLE_MAX_GAP_MS,
  AMBIENT_BUBBLE_MIN_GAP_MS,
  agentActivityBubbleText,
  dreamLogBubbleText,
  firstDailyLogLine,
  randomGapMs,
  recentConversationBubbleText,
} from "./ambientBubble";
import type { AgentActivityPayload, MemoryEntryView } from "../../shared/contracts";

function dreamLog(summary: string | null): MemoryEntryView {
  return {
    id: "dream-log:2026-08-11",
    kind: "dream-log",
    title: "梦境 · 2026-08-11",
    contentMarkdown: "# 梦境",
    summary,
    scope: null,
    template: null,
    sourceSessionIds: [],
    tags: ["dream-log"],
    version: 1,
    prevId: null,
    lastOps: null,
    status: "active",
    entryDate: "2026-08-11",
    createdAt: 0,
    updatedAt: 0,
  };
}

describe("dreamLogBubbleText", () => {
  it("surfaces the touched-memory count from the journal summary", () => {
    expect(dreamLogBubbleText(dreamLog("整理 3 个会话：新增 2 / 更新 1 / 删除 0 / 跳过 0"))).toBe(
      "昨晚我整理了 3 条关于你的记忆",
    );
  });

  it("falls back to a quiet no-change line when nothing moved", () => {
    expect(dreamLogBubbleText(dreamLog("整理 2 个会话：新增 0 / 更新 0 / 删除 0 / 跳过 2"))).toBe(
      "昨晚的梦境整理好了，记忆都很安定",
    );
  });

  it("returns null without a summary", () => {
    expect(dreamLogBubbleText(dreamLog(null))).toBeNull();
    expect(dreamLogBubbleText(dreamLog("   "))).toBeNull();
  });
});

describe("firstDailyLogLine", () => {
  it("skips blank lines and strips heading marks", () => {
    expect(firstDailyLogLine("\n\n# 2026-08-11 日志\n\n继续在 VESTI 上工作")).toBe(
      "2026-08-11 日志",
    );
  });

  it("truncates long lines", () => {
    const line = "很".repeat(100);
    const result = firstDailyLogLine(line);
    expect(result).toHaveLength(80);
    expect(result?.endsWith("…")).toBe(true);
  });

  it("returns null for empty markdown", () => {
    expect(firstDailyLogLine("")).toBeNull();
    expect(firstDailyLogLine("\n \n")).toBeNull();
  });
});

describe("randomGapMs", () => {
  it("stays inside the 45-90 minute window", () => {
    expect(randomGapMs(() => 0)).toBe(AMBIENT_BUBBLE_MIN_GAP_MS);
    expect(randomGapMs(() => 0.9999)).toBeLessThanOrEqual(AMBIENT_BUBBLE_MAX_GAP_MS);
    expect(randomGapMs(() => 0.5)).toBeGreaterThan(AMBIENT_BUBBLE_MIN_GAP_MS);
  });
});

describe("recentConversationBubbleText", () => {
  it("mentions the platform and the truncated title", () => {
    expect(
      recentConversationBubbleText({ title: "重构捕获引擎的对话树", platform: "Kimi Code" }),
    ).toBe("看到你在 Kimi Code 聊了《重构捕获引擎的对话树》，进展顺利吗？");
  });

  it("works without a platform label", () => {
    expect(recentConversationBubbleText({ title: "写周记", platform: "" })).toBe(
      "看到你在聊《写周记》，进展顺利吗？",
    );
  });

  it("returns null for empty titles", () => {
    expect(recentConversationBubbleText({ title: "   ", platform: "Codex" })).toBeNull();
  });
});

describe("agentActivityBubbleText", () => {
  const payload: AgentActivityPayload = {
    platform: "kimi-code",
    sessionId: "s-1",
    title: "实现积分体系",
    at: 0,
  };

  it("composes a completion line with the platform label", () => {
    expect(agentActivityBubbleText(payload)).toBe(
      "Kimi Code 刚完成了《实现积分体系》的新进展，要去看看吗？",
    );
  });

  it("degrades gracefully without a title", () => {
    expect(agentActivityBubbleText({ ...payload, title: "" })).toBe(
      "Kimi Code 刚完成了新进展，要去看看吗？",
    );
  });

  it("truncates long titles", () => {
    const long = { ...payload, title: "很".repeat(60) };
    const text = agentActivityBubbleText(long);
    expect(text.length).toBeLessThan(60);
    expect(text).toContain("…");
  });

  it("falls back to the raw platform id for unknown platforms", () => {
    expect(agentActivityBubbleText({ ...payload, platform: "codex" })).toContain("Codex");
  });

  it("notify cooldown is shorter than the ambient gap", () => {
    expect(AGENT_NOTIFY_MIN_GAP_MS).toBeLessThan(AMBIENT_BUBBLE_MIN_GAP_MS);
  });
});
