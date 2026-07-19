import { describe, expect, it } from "vitest";
import { basename, fillDailyUsage, rankUsage } from "./homeDashboardData";

describe("homeDashboardData", () => {
  it("ranks real usage by total tokens", () => {
    expect(
      rankUsage({
        cursor: { conversations: 3, inputTokens: 200, outputTokens: 40 },
        codex: { conversations: 1, inputTokens: 800, outputTokens: 120 },
      }).map((row) => row.id),
    ).toEqual(["codex", "cursor"]);
  });

  it("fills missing calendar days without inventing token usage", () => {
    const rows = fillDailyUsage(
      [{ date: "2026-07-18", inputTokens: 120, outputTokens: 30 }],
      3,
      new Date(2026, 6, 19, 12),
    );
    expect(rows).toEqual([
      { date: "2026-07-17", inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      { date: "2026-07-18", inputTokens: 120, outputTokens: 30, totalTokens: 150 },
      { date: "2026-07-19", inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    ]);
  });

  it("extracts project names from Windows and POSIX paths", () => {
    expect(basename("C:\\work\\vesti")).toBe("vesti");
    expect(basename("/home/me/project/")).toBe("project");
  });
});
