import { describe, expect, it } from "vitest";
import {
  AMBIENT_BUBBLE_MAX_GAP_MS,
  AMBIENT_BUBBLE_MIN_GAP_MS,
  dreamLogBubbleText,
  firstDailyLogLine,
  randomGapMs,
} from "./ambientBubble";
import type { MemoryEntryView } from "../../shared/contracts";

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
