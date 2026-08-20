import { describe, expect, it } from "vitest";
import { getTurnMessageAnalysisText } from "./turnMessageText";

describe("getTurnMessageAnalysisText", () => {
  it("includes follow-ups by default and process only on request", () => {
    const message = {
      id: 1,
      conversation_id: 1,
      role: "user" as const,
      content_text: "主提示",
      created_at: 1,
      _followups: [{ id: 2, content_text: "跟进", created_at: 2 }],
      _progress_segments: [{ id: 3, content_text: "进度", created_at: 3 }],
      _thinking_segments: [{ id: 4, content_text: "思考", created_at: 4 }],
    };

    expect(getTurnMessageAnalysisText(message)).toBe("主提示\n\n跟进 1：跟进");
    expect(getTurnMessageAnalysisText(message, { includeProcess: true }))
      .toContain("过程（进度）：\n进度");
    expect(getTurnMessageAnalysisText(message, { includeProcess: true }))
      .toContain("过程（思考）：\n思考");
  });
});
