// P4c weekly report: pure aggregation core — merge the last 7 days of daily
// activity + daily logs into one weekly view, build the condensed context
// for the `daily` agent kind (template 'weekly'), and render the no-LLM
// local fallback. No Dexie/IO here; the caller (dailyService) gathers the
// inputs and passes them in.

import type { DailyLogStats } from "../db/types";
import { DAILY_CONTEXT_BUDGET_CHARS, emptyDailyLogStats, type DailyLocale } from "./dailyActivity";

/** One day's contribution to the week. */
export interface WeeklyDayInput {
  date: string;
  stats: DailyLogStats;
  hasActivity: boolean;
  /** Daily log markdown when one exists for the date (excerpted later). */
  logMarkdown: string | null;
}

export interface WeeklyAggregate {
  startDate: string;
  endDate: string;
  /** Ascending (oldest first). */
  days: WeeklyDayInput[];
  totals: DailyLogStats;
  activeDays: number;
}

const DAY_LOG_EXCERPT_MAX_CHARS = 1_200;

function mergeStats(target: DailyLogStats, stats: DailyLogStats): void {
  target.cliSessions += stats.cliSessions;
  target.browserConversations += stats.browserConversations;
  target.messages += stats.messages;
  for (const platform of stats.platforms) {
    if (!target.platforms.includes(platform)) target.platforms.push(platform);
  }
  for (const project of stats.projects) {
    if (!target.projects.includes(project)) target.projects.push(project);
  }
}

/**
 * Merge one week of per-day activity into totals. Days without activity stay
 * in `days` (the report shows them as quiet days) but add nothing.
 */
export function aggregateWeekly(days: WeeklyDayInput[]): WeeklyAggregate {
  const totals = emptyDailyLogStats();
  let activeDays = 0;
  for (const day of days) {
    if (!day.hasActivity) continue;
    activeDays += 1;
    mergeStats(totals, day.stats);
  }
  return {
    startDate: days[0]?.date ?? "",
    endDate: days[days.length - 1]?.date ?? "",
    days,
    totals,
    activeDays,
  };
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncateText(value: string, maxChars: number): string {
  const collapsed = collapseWhitespace(value);
  if (collapsed.length <= maxChars) return collapsed;
  return `${collapsed.slice(0, Math.max(0, maxChars - 1))}…`;
}

function formatDayStats(stats: DailyLogStats): string {
  return `CLI ${stats.cliSessions} · 网页 ${stats.browserConversations} · 消息 ${stats.messages}`;
}

/**
 * First meaningful lines of a daily log for the weekly context: headings and
 * the boilerplate local-template note are skipped, the rest is excerpted.
 */
export function excerptDailyLog(markdown: string, maxChars: number): string {
  const lines = markdown
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && !line.startsWith(">"));
  return truncateText(lines.join(" "), maxChars);
}

/**
 * Assemble the weekly context for the `daily` agent kind (template
 * 'weekly'): a totals header, then one block per day with its stats and a
 * daily-log excerpt. Days without a log but with activity get a stats-only
 * block; quiet days are listed as such. Fits the daily budget.
 */
export function buildWeeklyTranscript(
  aggregate: WeeklyAggregate,
  budgetChars: number = DAILY_CONTEXT_BUDGET_CHARS
): string {
  const totals = aggregate.totals;
  const header = [
    `周期：${aggregate.startDate} ~ ${aggregate.endDate}（本地时区，最近 7 天）`,
    `本周统计：活跃 ${aggregate.activeDays} 天 · CLI 会话 ${totals.cliSessions} 个 · 网页会话 ${totals.browserConversations} 个 · 消息 ${totals.messages} 条` +
      (totals.platforms.length > 0 ? ` · 平台 ${totals.platforms.join("、")}` : "") +
      (totals.projects.length > 0 ? ` · 项目 ${totals.projects.join("、")}` : ""),
  ].join("\n");

  const blocks = aggregate.days.map((day) => {
    const title = `### ${day.date}（${formatDayStats(day.stats)}）`;
    if (!day.hasActivity) return `${title}\n无活动`;
    if (day.logMarkdown) return `${title}\n${excerptDailyLog(day.logMarkdown, DAY_LOG_EXCERPT_MAX_CHARS)}`;
    const platforms = day.stats.platforms.join("、");
    return `${title}\n当日有活动但未生成日报${platforms ? `（平台：${platforms}）` : ""}`;
  });

  const assembled = [header, "每日记录：", ...blocks].join("\n\n");
  if (assembled.length <= budgetChars) return assembled;
  return `${assembled.slice(0, Math.max(0, budgetChars - 12))}\n[上下文已截断]`;
}

const LOCAL_WEEKLY_COPY = {
  zh: {
    title: (start: string, end: string) => `# ${start} ~ ${end} 周报`,
    note: "> 未配置模型，以下为本地模板生成的结构化周报（未经 AI 润色）。",
    done: "## 本周完成",
    doneLine: (aggregate: WeeklyAggregate) =>
      `本周活跃 ${aggregate.activeDays} 天，共 ${aggregate.totals.cliSessions + aggregate.totals.browserConversations} 个 AI 会话、${aggregate.totals.messages} 条消息。`,
    platformsLine: (aggregate: WeeklyAggregate) =>
      aggregate.totals.platforms.length > 0 ? `- 平台：${aggregate.totals.platforms.join("、")}` : null,
    projectsLine: (aggregate: WeeklyAggregate) =>
      aggregate.totals.projects.length > 0 ? `- 项目/站点：${aggregate.totals.projects.join("、")}` : null,
    progress: "## 关键进展",
    patterns: "## 模式观察",
    next: "## 下周线索",
    days: "## 每日记录",
    quiet: "无活动",
    none: "无",
  },
  en: {
    title: (start: string, end: string) => `# ${start} ~ ${end} Weekly report`,
    note: "> No model configured — this is a structured weekly report from the local template (no AI polish).",
    done: "## Completed this week",
    doneLine: (aggregate: WeeklyAggregate) =>
      `Active ${aggregate.activeDays} day(s) this week: ${aggregate.totals.cliSessions + aggregate.totals.browserConversations} AI conversations, ${aggregate.totals.messages} messages.`,
    platformsLine: (aggregate: WeeklyAggregate) =>
      aggregate.totals.platforms.length > 0 ? `- Platforms: ${aggregate.totals.platforms.join(", ")}` : null,
    projectsLine: (aggregate: WeeklyAggregate) =>
      aggregate.totals.projects.length > 0 ? `- Projects/sites: ${aggregate.totals.projects.join(", ")}` : null,
    progress: "## Key progress",
    patterns: "## Pattern observations",
    next: "## Leads for next week",
    days: "## Daily records",
    quiet: "No activity",
    none: "None",
  },
} as const;

/**
 * Structured weekly report without any LLM: totals plus the per-day records,
 * in the same section structure the weekly agent prompt asks for. Sections
 * the template cannot infer (progress, patterns, next week) stay "none"
 * rather than fabricating content.
 */
export function buildLocalWeeklyMarkdown(
  aggregate: WeeklyAggregate,
  locale: DailyLocale = "zh"
): string {
  const copy = LOCAL_WEEKLY_COPY[locale] ?? LOCAL_WEEKLY_COPY.zh;
  const sections: string[] = [
    copy.title(aggregate.startDate, aggregate.endDate),
    copy.note,
  ];

  const doneLines = [
    copy.doneLine(aggregate),
    copy.platformsLine(aggregate),
    copy.projectsLine(aggregate),
  ].filter((line): line is string => Boolean(line));
  sections.push(`${copy.done}\n${doneLines.join("\n")}`);

  sections.push(`${copy.progress}\n${copy.none}`);
  sections.push(`${copy.patterns}\n${copy.none}`);
  sections.push(`${copy.next}\n${copy.none}`);

  const dayLines = aggregate.days.map((day) => {
    if (!day.hasActivity) return `- ${day.date}：${copy.quiet}`;
    const stats = formatDayStats(day.stats);
    const excerpt = day.logMarkdown ? ` — ${excerptDailyLog(day.logMarkdown, 160)}` : "";
    return `- ${day.date}（${stats}）${excerpt}`;
  });
  sections.push(`${copy.days}\n${dayLines.join("\n")}`);

  return sections.join("\n\n");
}
