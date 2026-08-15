import { describe, expect, it } from "vitest";
import {
  AITI_LOCAL_MIN_CONVERSATIONS,
  computeLocalSignals,
  hasEnoughLocalSignals,
  type AitiLocalConversationInput,
} from "./localSignals";

function conv(
  conversationId: number,
  messages: Array<{ role: string; content: string; createdAt?: number }>,
): AitiLocalConversationInput {
  return { conversationId, updatedAt: conversationId, messages };
}

describe("computeLocalSignals", () => {
  it("returns zeros for empty input", () => {
    const signals = computeLocalSignals([]);
    expect(signals.conversationCount).toBe(0);
    expect(signals.userMessageCount).toBe(0);
    expect(signals.questionRatio).toBe(0);
    expect(signals.avgUserChars).toBe(0);
    expect(signals.avgUserTurns).toBe(0);
    expect(signals.activeHours).toHaveLength(24);
    expect(signals.activeHours.every((n) => n === 0)).toBe(true);
    expect(signals.topTerms).toEqual([]);
    expect(signals.feats).toEqual([]);
    expect(hasEnoughLocalSignals(signals)).toBe(false);
  });

  it("derives question ratio, lengths, turns and active hours from user messages only", () => {
    const t = new Date(2026, 0, 15, 9, 0, 0).getTime(); // 09:00 local
    const signals = computeLocalSignals([
      conv(1, [
        { role: "user", content: "如何优化 sqlite 的查询性能？", createdAt: t },
        { role: "ai", content: "可以创建索引……" },
        { role: "user", content: "加了索引还是慢，EXPLAIN 输出如下……", createdAt: t + 60_000 },
      ]),
      conv(2, [
        { role: "user", content: "npm run build 报错：error TS2322 in app.ts", createdAt: t },
      ]),
      conv(3, [
        { role: "user", content: "函数式编程和面向对象的本质区别是什么", createdAt: t },
        { role: "ai", content: "……" },
        { role: "user", content: "太好了，完全理解了！谢谢！！", createdAt: t },
      ]),
    ]);

    expect(signals.conversationCount).toBe(3);
    expect(signals.userMessageCount).toBe(5);
    // questions: conv1 msg1 (？), conv3 msg1 (什么) → 2/5
    expect(signals.questionRatio).toBe(0.4);
    expect(signals.avgUserChars).toBeCloseTo(
      ("如何优化 sqlite 的查询性能？".length + "加了索引还是慢，EXPLAIN 输出如下……".length +
        "npm run build 报错：error TS2322 in app.ts".length +
        "函数式编程和面向对象的本质区别是什么".length + "太好了，完全理解了！谢谢！！".length) / 5,
    );
    expect(signals.avgUserTurns).toBeCloseTo(5 / 3);
    expect(signals.activeHours[new Date(t).getHours()]).toBe(5);
    expect(hasEnoughLocalSignals(signals)).toBe(false); // 5 user messages < 6
  });

  it("maps per-conversation cues onto the shared feat shape", () => {
    const signals = computeLocalSignals([
      // maker: command + file + error; ends on the AI → no open-end
      conv(1, [
        { role: "user", content: "git rebase 之后 pnpm build 失败，app.ts 报错" },
        { role: "ai", content: "……" },
      ]),
      // theorist + open end on a question
      conv(2, [{ role: "user", content: "索引的原理是什么？和哈希表有什么区别" }]),
      // spirited: two exclamations + 谢谢
      conv(3, [
        { role: "user", content: "太好了！终于跑通了！谢谢谢谢，真的开心" },
        { role: "ai", content: "……" },
      ]),
    ]);
    const byId = new Map(signals.feats.map((f) => [f.conversationId, f]));

    expect(byId.get(1)).toMatchObject({ maker: true, theorist: false, unresolved: 0 });
    expect(byId.get(2)).toMatchObject({ maker: false, theorist: true, unresolved: 3 });
    expect(byId.get(3)?.affect).toBe(1);
    // depth proxy: longer + more turns → deeper; all three are short, so low
    for (const f of signals.feats) expect(f.depth).toBeGreaterThanOrEqual(0);
  });

  it("collects recurring topic terms across conversations", () => {
    const signals = computeLocalSignals([
      conv(1, [{ role: "user", content: "帮我看看 database 迁移，sqlite 锁表了" }]),
      conv(2, [{ role: "user", content: "sqlite 的 WAL 模式和 database 备份" }]),
      conv(3, [{ role: "user", content: "今天天气不错" }]),
    ]);
    const terms = signals.topTerms.map((t) => t.term);
    expect(terms).toContain("sqlite");
    expect(terms).toContain("database");
    // single-conversation terms never surface
    expect(terms).not.toContain("WAL");
  });

  it("skips conversations without user messages and gates the minimum sample", () => {
    const signals = computeLocalSignals([
      conv(1, [{ role: "ai", content: "你好" }]),
      conv(2, [
        { role: "user", content: "问题一？" },
        { role: "user", content: "问题二？" },
        { role: "user", content: "问题三？" },
      ]),
    ]);
    expect(signals.conversationCount).toBe(1);
    expect(signals.feats.map((f) => f.conversationId)).toEqual([2]);
    expect(signals.conversationCount).toBeLessThan(AITI_LOCAL_MIN_CONVERSATIONS);
    expect(hasEnoughLocalSignals(signals)).toBe(false);
  });
});
