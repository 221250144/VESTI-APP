// P4c daily log: unit tests for the pure cores — per-day activity
// aggregation, scheduler decision logic, weekly aggregation and the daily
// agent prompt. The journal model/two-pass pipeline/local template live in
// dailyJournal/dailyPipeline with their own test files. Node environment, no
// Dexie/IPC involved. All timestamps are built with the local Date
// constructor, so the tests are timezone-independent.

import { describe, expect, it } from "vitest";
import { getAgentKindDefinition } from "../../main/agentPrompts";
import {
  addDaysToDateString,
  collectDailyActivity,
  computeDailyOverview,
  computeDailyStreak,
  lastNDates,
  localDayRange,
  toLocalDateString,
  type DailyConversationInput,
  type DailyDigestInput,
  type DailySummaryInput,
} from "./dailyActivity";
import { computePendingDailyDates, normalizeDailyTime } from "./dailyScheduler";
import {
  aggregateWeekly,
  buildLocalWeeklyMarkdown,
  buildWeeklyTranscript,
  dailyLogAccomplishments,
  excerptDailyLog,
  extractDailyLogSection,
  type WeeklyDayInput,
} from "./weekly";

function localTs(
  year: number,
  month: number,
  day: number,
  hours = 12,
  minutes = 0
): number {
  return new Date(year, month - 1, day, hours, minutes, 0).getTime();
}

function makeConversation(
  overrides: Partial<DailyConversationInput> & { id: number }
): DailyConversationInput {
  return {
    title: `会话 ${overrides.id}`,
    platform: "Codex",
    updatedAt: 0,
    messageCount: 10,
    source: "cli",
    projectLabel: "vesti-app",
    ...overrides,
  };
}

function makeDigest(
  conversationId: number,
  overrides: Partial<DailyDigestInput> = {}
): DailyDigestInput {
  return {
    conversationId,
    oneLiner: "实现了日报功能",
    keyTopics: ["日报"],
    keyFiles: ["src/ui/daily/dailyService.ts"],
    decisions: ["采用本地模板降级"],
    ...overrides,
  };
}

// ---- Local-date helpers ------------------------------------------------------

describe("toLocalDateString / localDayRange / addDaysToDateString", () => {
  it("round-trips a local timestamp through the date string", () => {
    const ts = localTs(2026, 7, 18, 15, 30);
    expect(toLocalDateString(ts)).toBe("2026-07-18");
  });

  it("bounds a local day at local midnight, next day excluded", () => {
    const range = localDayRange("2026-07-18");
    expect(range).not.toBeNull();
    expect(toLocalDateString(range!.start)).toBe("2026-07-18");
    expect(range!.end).toBeGreaterThan(range!.start);
    // Start is local midnight.
    expect(new Date(range!.start).getHours()).toBe(0);
    // 23:59 inside, next day 00:00 outside.
    expect(localTs(2026, 7, 18, 23, 59)).toBeLessThan(range!.end);
    expect(localTs(2026, 7, 19, 0, 0)).toBeGreaterThanOrEqual(range!.end);
  });

  it("rejects malformed dates", () => {
    expect(localDayRange("2026/07/18")).toBeNull();
    expect(localDayRange("2026-13-01")).toBeNull();
    expect(addDaysToDateString("not-a-date", -1)).toBeNull();
  });

  it("shifts dates across month boundaries", () => {
    expect(addDaysToDateString("2026-07-01", -1)).toBe("2026-06-30");
    expect(addDaysToDateString("2026-12-31", 1)).toBe("2027-01-01");
  });

  it("lists the last N dates ascending", () => {
    expect(lastNDates(3, "2026-07-18")).toEqual([
      "2026-07-16",
      "2026-07-17",
      "2026-07-18",
    ]);
  });
});

// ---- collectDailyActivity ----------------------------------------------------

describe("collectDailyActivity", () => {
  const date = "2026-07-18";
  const conversations = [
    makeConversation({ id: 1, updatedAt: localTs(2026, 7, 18, 9), messageCount: 12 }),
    makeConversation({
      id: 2,
      updatedAt: localTs(2026, 7, 18, 23, 59),
      messageCount: 5,
      source: "browser",
      platform: "ChatGPT",
      projectLabel: "chatgpt.com",
    }),
    // Previous day — excluded.
    makeConversation({ id: 3, updatedAt: localTs(2026, 7, 17, 23, 59), messageCount: 99 }),
    // Next day — excluded.
    makeConversation({ id: 4, updatedAt: localTs(2026, 7, 19, 0, 1), messageCount: 99 }),
  ];
  const digests = [makeDigest(1)];
  const summaries: DailySummaryInput[] = [
    { conversationId: 2, content: "旧的摘要", createdAt: 100 },
    { conversationId: 2, content: "最新的摘要", createdAt: 200 },
  ];

  it("collects only the conversations active inside the local day bounds", () => {
    const activity = collectDailyActivity(date, { conversations, digests, summaries });
    expect(activity.items.map((item) => item.id)).toEqual([1, 2]);
  });

  it("joins digests and the latest summary per conversation", () => {
    const activity = collectDailyActivity(date, { conversations, digests, summaries });
    const cli = activity.items.find((item) => item.id === 1);
    const browser = activity.items.find((item) => item.id === 2);
    expect(cli?.digest?.oneLiner).toBe("实现了日报功能");
    expect(browser?.summary).toBe("最新的摘要");
  });

  it("aggregates cross-source stats", () => {
    const activity = collectDailyActivity(date, { conversations, digests, summaries });
    expect(activity.stats).toEqual({
      cliSessions: 1,
      browserConversations: 1,
      platforms: ["Codex", "ChatGPT"],
      projects: ["vesti-app", "chatgpt.com"],
      messages: 17,
    });
  });

  it("returns an empty day when nothing was active", () => {
    const activity = collectDailyActivity("2026-07-20", { conversations, digests, summaries });
    expect(activity.items).toEqual([]);
    expect(activity.stats.messages).toBe(0);
    expect(activity.stats.platforms).toEqual([]);
  });

  it("keeps items chronological", () => {
    const shuffled = [
      makeConversation({ id: 2, updatedAt: localTs(2026, 7, 18, 20) }),
      makeConversation({ id: 1, updatedAt: localTs(2026, 7, 18, 9) }),
    ];
    const activity = collectDailyActivity(date, {
      conversations: shuffled,
      digests: [],
      summaries: [],
    });
    expect(activity.items.map((item) => item.id)).toEqual([1, 2]);
  });
});

// ---- Scheduler decision logic --------------------------------------------------

describe("normalizeDailyTime", () => {
  it("accepts and pads valid HH:MM values", () => {
    expect(normalizeDailyTime("9:05")).toBe("09:05");
    expect(normalizeDailyTime("23:59")).toBe("23:59");
  });

  it("falls back to the default on malformed input", () => {
    expect(normalizeDailyTime("25:00")).toBe("21:30");
    expect(normalizeDailyTime("abc")).toBe("21:30");
    expect(normalizeDailyTime(null)).toBe("21:30");
    expect(normalizeDailyTime(undefined)).toBe("21:30");
  });
});

describe("computePendingDailyDates", () => {
  const scheduledTime = "21:30";

  it("offers only yesterday before the scheduled time", () => {
    const now = localTs(2026, 7, 18, 10, 0);
    expect(
      computePendingDailyDates({ now, scheduledTime, existingDates: [] })
    ).toEqual(["2026-07-17"]);
  });

  it("offers yesterday and today once the scheduled time has passed", () => {
    const now = localTs(2026, 7, 18, 22, 0);
    expect(
      computePendingDailyDates({ now, scheduledTime, existingDates: [] })
    ).toEqual(["2026-07-17", "2026-07-18"]);
  });

  it("skips dates that already have a log (no duplicates)", () => {
    const now = localTs(2026, 7, 18, 22, 0);
    expect(
      computePendingDailyDates({
        now,
        scheduledTime,
        existingDates: ["2026-07-17", "2026-07-18"],
      })
    ).toEqual([]);
    expect(
      computePendingDailyDates({ now, scheduledTime, existingDates: ["2026-07-17"] })
    ).toEqual(["2026-07-18"]);
  });

  it("respects a custom scheduled time", () => {
    const morning = localTs(2026, 7, 18, 8, 0);
    expect(
      computePendingDailyDates({ now: morning, scheduledTime: "07:00", existingDates: ["2026-07-17"] })
    ).toEqual(["2026-07-18"]);
  });
});

// ---- Streak / overview ---------------------------------------------------------

describe("computeDailyStreak / computeDailyOverview", () => {
  const stats = { cliSessions: 1, browserConversations: 0, platforms: [], projects: [], messages: 7 };

  it("counts consecutive days ending today", () => {
    const dates = ["2026-07-16", "2026-07-17", "2026-07-18"];
    expect(computeDailyStreak(dates, "2026-07-18")).toBe(3);
  });

  it("tolerates today still missing (day in progress)", () => {
    const dates = ["2026-07-16", "2026-07-17"];
    expect(computeDailyStreak(dates, "2026-07-18")).toBe(2);
  });

  it("breaks on gaps", () => {
    const dates = ["2026-07-15", "2026-07-17", "2026-07-18"];
    expect(computeDailyStreak(dates, "2026-07-18")).toBe(2);
    expect(computeDailyStreak([], "2026-07-18")).toBe(0);
  });

  it("builds the week activity view with zero-fill for missing days", () => {
    const overview = computeDailyOverview(
      [
        { date: "2026-07-17", stats },
        { date: "2026-07-18", stats: { ...stats, messages: 3 } },
      ],
      "2026-07-18"
    );
    expect(overview.totalDays).toBe(2);
    expect(overview.streak).toBe(2);
    expect(overview.week).toHaveLength(7);
    expect(overview.week[6]).toEqual({ date: "2026-07-18", messages: 3, hasLog: true });
    expect(overview.week[0]).toEqual({ date: "2026-07-12", messages: 0, hasLog: false });
  });
});

// ---- Weekly aggregation --------------------------------------------------------

function makeDay(date: string, overrides: Partial<WeeklyDayInput> = {}): WeeklyDayInput {
  return {
    date,
    stats: { cliSessions: 1, browserConversations: 1, platforms: ["Codex"], projects: ["vesti"], messages: 20 },
    hasActivity: true,
    logMarkdown: `# ${date} 日报\n\n## 今日概览\n今天完成了日报功能。`,
    ...overrides,
  };
}

describe("aggregateWeekly", () => {
  it("merges per-day stats and counts active days", () => {
    const aggregate = aggregateWeekly([
      makeDay("2026-07-16"),
      makeDay("2026-07-17", {
        hasActivity: false,
        logMarkdown: null,
        stats: { cliSessions: 0, browserConversations: 0, platforms: [], projects: [], messages: 0 },
      }),
      makeDay("2026-07-18", {
        stats: { cliSessions: 2, browserConversations: 0, platforms: ["Codex", "Cursor"], projects: ["vesti"], messages: 40 },
      }),
    ]);
    expect(aggregate.activeDays).toBe(2);
    expect(aggregate.totals.cliSessions).toBe(3);
    expect(aggregate.totals.browserConversations).toBe(1);
    expect(aggregate.totals.messages).toBe(60);
    expect(aggregate.totals.platforms).toEqual(["Codex", "Cursor"]);
    expect(aggregate.startDate).toBe("2026-07-16");
    expect(aggregate.endDate).toBe("2026-07-18");
  });
});

describe("excerptDailyLog", () => {
  it("skips headings and blockquotes, keeps body text", () => {
    expect(excerptDailyLog("# 标题\n\n> 模板说明\n正文内容。", 200)).toBe("正文内容。");
  });

  it("skips journal frontmatter", () => {
    expect(
      excerptDailyLog('---\nuuid: "vesti-daily-2026-07-18"\ndate: 2026-07-18\n---\n# 标题\n正文内容。', 200)
    ).toBe("正文内容。");
  });
});

describe("extractDailyLogSection / dailyLogAccomplishments", () => {
  const log = [
    "# 2026-07-18 日报",
    "",
    "## 今日完成",
    "- 实现了两遍日报管线并通过测试",
    "- 修复浏览器会话分类",
    "",
    "## 关键文件",
    "- `src/ui/daily/dailyJournal.ts`（修改）",
    "",
    "## 明日线索",
    "- 继续周报联调",
  ].join("\n");

  it("pulls exactly the requested section body", () => {
    expect(extractDailyLogSection(log, ["## 今日完成"])).toBe(
      "- 实现了两遍日报管线并通过测试\n- 修复浏览器会话分类"
    );
    expect(extractDailyLogSection(log, ["## 不存在的节"])).toBeNull();
  });

  it("summarizes from the 今日完成 section, falling back to the whole-log excerpt", () => {
    expect(dailyLogAccomplishments(log, 200)).toContain("实现了两遍日报管线");
    expect(dailyLogAccomplishments(log, 200)).not.toContain("关键文件");
    const legacy = "# 日报\n\n## 今日概览\n今天完成了日报功能。";
    expect(dailyLogAccomplishments(legacy, 200)).toBe("今天完成了日报功能。");
  });
});

describe("buildWeeklyTranscript", () => {
  it("carries the range header and per-day blocks", () => {
    const aggregate = aggregateWeekly([
      makeDay("2026-07-17"),
      makeDay("2026-07-18", { logMarkdown: null }),
    ]);
    const transcript = buildWeeklyTranscript(aggregate);
    expect(transcript).toContain("周期：2026-07-17 ~ 2026-07-18");
    expect(transcript).toContain("活跃 2 天");
    expect(transcript).toContain("### 2026-07-17");
    expect(transcript).toContain("今天完成了日报功能。");
    expect(transcript).toContain("当日有活动但未生成日报");
  });

  it("summarizes the stored log's 今日完成 section per day", () => {
    const aggregate = aggregateWeekly([
      makeDay("2026-07-17", {
        logMarkdown: [
          "# 2026-07-17 日报",
          "",
          "## 今日完成",
          "- 完成了文件锚点确定性提取",
          "",
          "## 决策与发现",
          "- 决定复用 relay 的锚点机制",
        ].join("\n"),
      }),
    ]);
    const transcript = buildWeeklyTranscript(aggregate);
    expect(transcript).toContain("完成了文件锚点确定性提取");
    expect(transcript).not.toContain("决定复用 relay 的锚点机制");
  });

  it("fits the budget with a truncation marker", () => {
    const days = Array.from({ length: 7 }, (_, index) =>
      makeDay(`2026-07-${12 + index}`, {
        logMarkdown: `# 日报\n${"很长的正文。".repeat(500)}`,
      })
    );
    const transcript = buildWeeklyTranscript(aggregateWeekly(days), 3_000);
    expect(transcript.length).toBeLessThanOrEqual(3_010);
    expect(transcript).toContain("[上下文已截断]");
  });
});

describe("buildLocalWeeklyMarkdown", () => {
  it("renders the weekly sections with per-day records", () => {
    const aggregate = aggregateWeekly([
      makeDay("2026-07-17"),
      makeDay("2026-07-18", {
        hasActivity: false,
        logMarkdown: null,
        stats: { cliSessions: 0, browserConversations: 0, platforms: [], projects: [], messages: 0 },
      }),
    ]);
    const markdown = buildLocalWeeklyMarkdown(aggregate, "zh");
    expect(markdown).toContain("# 2026-07-17 ~ 2026-07-18 周报");
    expect(markdown).toContain("## 本周完成");
    expect(markdown).toContain("## 关键进展");
    expect(markdown).toContain("## 模式观察");
    expect(markdown).toContain("## 下周线索");
    expect(markdown).toContain("## 每日记录");
    expect(markdown).toContain("2026-07-18：无活动");
  });
});

// ---- daily agent kind (main-process prompt registry) ---------------------------

describe("daily agent kind", () => {
  const preferences = {
    outputLanguage: "zh-CN",
    includeThinking: false,
    includeToolDetails: false,
    customInstructions: "",
  } as const;

  it("builds the synthesis prompt with the journal schema and the key-files marker", () => {
    const definition = getAgentKindDefinition("daily");
    const messages = definition.buildPrompt({
      transcript: "某日活动",
      template: "daily",
      preferences,
    });
    const user = messages.find((message) => message.role === "user");
    expect(user?.content).toContain("今日完成");
    expect(user?.content).toContain("项目工作流分解");
    expect(user?.content).toContain("{{KEY_FILES}}");
    expect(user?.content).toContain("决策与发现");
    expect(user?.content).toContain("网页端对话摘要");
    expect(user?.content).toContain("明日线索");
    expect(user?.content).toContain("某日活动");
    // Synthesis answers Markdown prose, not JSON.
    const system = messages.find((message) => message.role === "system");
    expect(system?.content).toContain("Markdown");
  });

  it("builds the pass-1 cluster prompt as strict JSON extraction", () => {
    const definition = getAgentKindDefinition("daily");
    const messages = definition.buildPrompt({
      transcript: "某簇上下文",
      template: "daily-cluster",
      preferences,
    });
    const user = messages.find((message) => message.role === "user");
    expect(user?.content).toContain('"theme"');
    expect(user?.content).toContain('"completed"');
    expect(user?.content).toContain('"open_questions"');
    expect(user?.content).toContain("严格 JSON");
    expect(user?.content).toContain("某簇上下文");
    const system = messages.find((message) => message.role === "system");
    expect(system?.content).toContain("严格 JSON");
    expect(system?.content).not.toContain("Markdown 正文");
  });

  it("switches to the weekly directive with template=weekly", () => {
    const definition = getAgentKindDefinition("daily");
    const messages = definition.buildPrompt({
      transcript: "一周记录",
      template: "weekly",
      preferences,
    });
    const user = messages.find((message) => message.role === "user");
    expect(user?.content).toContain("本周完成");
    expect(user?.content).toContain("模式观察");
    expect(user?.content).toContain("下周线索");
    expect(user?.content).not.toContain("明日线索");
    expect(user?.content).toContain("日报");
  });

  it("parses leniently: any non-empty body passes", () => {
    const definition = getAgentKindDefinition("daily");
    expect(definition.parse?.("  一些 Markdown 内容  ")).toBe("一些 Markdown 内容");
    expect(() => definition.parse?.("   ")).toThrow();
  });
});
