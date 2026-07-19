// P4c daily log + weekly report: IO orchestration. Gathers the renderer-side
// inputs (Dexie conversations, P1.5 digests, browser summaries), runs the
// pure aggregation (dailyActivity/weekly), calls the `daily` agent kind when
// an LLM is configured and falls back to the local template otherwise, then
// persists via the repository. Everything budget/decision-related lives in
// the pure modules; this file only moves data.

import { db } from "../db/schema";
import type { ConversationRecord } from "../db/schema";
import type { DailyLog, WeeklyRecapV1, WeeklyReportRecord } from "../db/types";
import {
  getAllSummaries,
  listDailyLogs,
  saveWeeklyReport,
  upsertDailyLog,
} from "../db/repository";
import type { VestiDesktopApi } from "../../shared/contracts";
import { listConversationDigests } from "../sync/conversationDigests";
import { getLanguageSettings } from "../services/languageSettingsService";
import {
  DAILY_UPDATED_EVENT,
  addDaysToDateString,
  buildDailyTranscript,
  buildLocalDailyMarkdown,
  collectDailyActivity,
  computeDailyOverview,
  lastNDates,
  localDayRange,
  todayDateString,
  type DailyActivity,
  type DailyConversationInput,
  type DailyDigestInput,
  type DailyLocale,
  type DailyLogOverview,
  type DailySummaryInput,
} from "./dailyActivity";
import {
  aggregateWeekly,
  buildLocalWeeklyMarkdown,
  buildWeeklyTranscript,
  excerptDailyLog,
  type WeeklyAggregate,
} from "./weekly";

// Extra fields the main process stamps on local-terminal capture records.
type LocalTerminalFields = {
  _source?: string;
  _cli_id?: string;
  _project_path?: string;
};

function vestiApi(): VestiDesktopApi | null {
  return typeof window !== "undefined" && window.vesti ? window.vesti : null;
}

async function isLlmConfigured(api: VestiDesktopApi): Promise<boolean> {
  const settingsView = await api.getSettings().catch(() => null);
  return settingsView
    ? settingsView.llm.mode === "demo_proxy" || settingsView.llm.apiKeyConfigured
    : false;
}

async function currentDailyLocale(): Promise<DailyLocale> {
  const settings = await getLanguageSettings().catch(() => null);
  return settings?.locale === "zh" ? "zh" : "en";
}

function domainOf(url: string): string | null {
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

interface DailyInputs {
  conversations: DailyConversationInput[];
  digests: DailyDigestInput[];
  summaries: DailySummaryInput[];
}

/** Dexie → the minimal shapes the pure aggregation core expects. */
async function gatherDailyInputs(): Promise<DailyInputs> {
  const records = (await db.conversations.toArray()) as Array<
    ConversationRecord & LocalTerminalFields
  >;
  const [digests, summaries] = await Promise.all([
    listConversationDigests().catch(() => []),
    getAllSummaries().catch(() => []),
  ]);
  const conversations: DailyConversationInput[] = [];
  for (const record of records) {
    if (typeof record.id !== "number" || record.is_trash) continue;
    const isBrowser = record._source === "browser_extension";
    conversations.push({
      id: record.id,
      title: record.title,
      platform: record.platform,
      updatedAt: record.updated_at ?? 0,
      messageCount: record.message_count ?? 0,
      source: isBrowser ? "browser" : "cli",
      projectLabel:
        typeof record._project_path === "string" && record._project_path
          ? record._project_path
          : isBrowser
            ? domainOf(record.url ?? "")
            : null,
    });
  }
  return { conversations, digests, summaries };
}

function notifyDailyUpdated(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(DAILY_UPDATED_EVENT));
  }
}

// ---- Daily log generation ----------------------------------------------------

const inFlightDates = new Set<string>();

/** Render the day's markdown: `daily` agent kind when the LLM is configured
 * (falling back to the local template on any agent failure), local template
 * otherwise. */
async function renderDailyContent(activity: DailyActivity): Promise<string> {
  const api = vestiApi();
  if (api && (await isLlmConfigured(api))) {
    try {
      const result = await api.runAgent({
        kind: "daily",
        sessionId: `daily:${activity.date}`,
        template: "daily",
        transcriptOverride: buildDailyTranscript(activity),
        persist: false,
      });
      if (result.content.trim()) return result.content;
    } catch {
      // Fall through to the local template — a failed agent call must never
      // lose the day's record.
    }
  }
  return buildLocalDailyMarkdown(activity, await currentDailyLocale());
}

/**
 * Generate (or regenerate) the log for one local day. Resolves null when the
 * day had no activity — the day simply stays unlogged. Concurrent calls for
 * the same date collapse; the unique `date` index plus upsert make the write
 * idempotent anyway.
 */
export async function generateDailyLog(
  date: string,
  source: "auto" | "manual"
): Promise<DailyLog | null> {
  if (inFlightDates.has(date)) return null;
  inFlightDates.add(date);
  try {
    const inputs = await gatherDailyInputs();
    const activity = collectDailyActivity(date, inputs);
    if (activity.items.length === 0) return null;
    const contentMarkdown = await renderDailyContent(activity);
    const log = await upsertDailyLog({
      date,
      contentMarkdown,
      stats: activity.stats,
      source,
    });
    notifyDailyUpdated();
    return log;
  } finally {
    inFlightDates.delete(date);
  }
}

/** Stats header for the log view: total logged days, current streak and the
 * last 7 days of message activity (pure core over the stored logs). */
export async function getDailyLogOverview(): Promise<DailyLogOverview> {
  const logs = await listDailyLogs().catch(() => []);
  return computeDailyOverview(logs, todayDateString());
}

// ---- Weekly report generation ------------------------------------------------

let weeklyInFlight = false;

function hashString(value: string): string {
  // djb2 — stable, dependency-free change detector for sourceHash.
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) + hash + value.charCodeAt(index)) >>> 0;
  }
  return hash.toString(16);
}

function buildWeeklyRecap(
  aggregate: WeeklyAggregate,
  activities: DailyActivity[],
  weeklyConversationCounts: WeeklyConversationCounts
): WeeklyRecapV1 {
  const totals = aggregate.totals;
  const conversationCount = totals.cliSessions + totals.browserConversations;

  const platformCounts = new Map<string, number>();
  for (const activity of activities) {
    for (const item of activity.items) {
      if (!item.platform) continue;
      platformCounts.set(item.platform, (platformCounts.get(item.platform) ?? 0) + 1);
    }
  }
  const topPlatform =
    [...platformCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";

  // Consecutive active weeks ending this week (scan back at most 12 weeks).
  let streakWeeks = 0;
  for (let weekOffset = 0; weekOffset < 12; weekOffset += 1) {
    const count = weeklyConversationCounts.byWeek[weekOffset] ?? 0;
    if (count === 0) break;
    streakWeeks += 1;
  }

  const narrative = aggregate.days
    .filter((day) => day.logMarkdown)
    .map((day) => excerptDailyLog(day.logMarkdown as string, 120))
    .filter(Boolean)
    .slice(0, 5);

  const busiest = aggregate.days
    .filter((day) => day.hasActivity && day.logMarkdown)
    .sort((a, b) => b.stats.messages - a.stats.messages)[0];

  return {
    schema: "weekly_recap.v1",
    greeting: `本周活跃 ${aggregate.activeDays} 天，共 ${conversationCount} 个 AI 会话。`,
    persona_tag: topPlatform ? `${topPlatform} 主力` : "多平台探索",
    mood_emoji: aggregate.activeDays >= 5 ? "🔥" : aggregate.activeDays >= 3 ? "🌤️" : "🌱",
    narrative,
    highlight: busiest
      ? { title: busiest.date, detail: excerptDailyLog(busiest.logMarkdown as string, 160) }
      : null,
    stats: {
      conversation_count: conversationCount,
      active_days: aggregate.activeDays,
      streak_weeks: streakWeeks,
      top_platform: topPlatform,
      week_over_week_delta:
        weeklyConversationCounts.previousWeek > 0
          ? Math.round(
              ((weeklyConversationCounts.thisWeek - weeklyConversationCounts.previousWeek) /
                weeklyConversationCounts.previousWeek) *
                100
            ) / 100
          : null,
    },
  };
}

interface WeeklyConversationCounts {
  thisWeek: number;
  previousWeek: number;
  /** Conversations per week, index 0 = this week, going backwards. */
  byWeek: number[];
}

function countWeeklyConversations(
  conversations: DailyConversationInput[],
  endDate: string,
  weeks: number
): WeeklyConversationCounts {
  // Week 0 is the 7-day report window ending on endDate (inclusive); earlier
  // weeks are contiguous 7-day windows shifted back — no overlaps, no gaps.
  const byWeek: number[] = [];
  for (let weekOffset = 0; weekOffset < weeks; weekOffset += 1) {
    const weekStartDate = addDaysToDateString(endDate, -6 - 7 * weekOffset);
    const weekEndDate = addDaysToDateString(endDate, -7 * weekOffset);
    const start = weekStartDate ? localDayRange(weekStartDate)?.start : null;
    const end = weekEndDate ? localDayRange(weekEndDate)?.end : null;
    if (start === null || start === undefined || end === null || end === undefined) {
      byWeek.push(0);
      continue;
    }
    byWeek.push(
      conversations.filter(
        (conversation) => conversation.updatedAt >= start && conversation.updatedAt < end
      ).length
    );
  }
  return {
    thisWeek: byWeek[0] ?? 0,
    previousWeek: byWeek[1] ?? 0,
    byWeek,
  };
}

/**
 * Aggregate the last 7 local days (daily logs where present, raw activity
 * stats otherwise) into a weekly report: the `daily` agent kind with the
 * 'weekly' template when an LLM is configured, the local template otherwise.
 * Upserts into weekly_reports keyed by the (rangeStart, rangeEnd) pair.
 */
export async function generateWeeklyReport(): Promise<WeeklyReportRecord> {
  if (weeklyInFlight) throw new Error("周报正在生成中，请稍候");
  weeklyInFlight = true;
  try {
    const today = todayDateString();
    const dates = lastNDates(7, today);
    const inputs = await gatherDailyInputs();
    const logs = await listDailyLogs().catch(() => []);
    const logByDate = new Map(logs.map((log) => [log.date, log.contentMarkdown]));

    const activities = dates.map((date) => collectDailyActivity(date, inputs));
    const aggregate = aggregateWeekly(
      dates.map((date, index) => ({
        date,
        stats: activities[index].stats,
        hasActivity: activities[index].items.length > 0,
        logMarkdown: logByDate.get(date) ?? null,
      }))
    );
    if (aggregate.activeDays === 0) {
      throw new Error("本周还没有可汇总的活动");
    }

    const api = vestiApi();
    let content: string | null = null;
    let modelId = "local-template";
    if (api && (await isLlmConfigured(api))) {
      try {
        const result = await api.runAgent({
          kind: "daily",
          sessionId: `daily-weekly:${aggregate.startDate}:${aggregate.endDate}`,
          template: "weekly",
          transcriptOverride: buildWeeklyTranscript(aggregate),
          persist: false,
        });
        if (result.content.trim()) {
          content = result.content;
          modelId = result.modelId;
        }
      } catch {
        // Fall through to the local template.
      }
    }
    let usedFallback = false;
    if (content === null) {
      usedFallback = true;
      content = buildLocalWeeklyMarkdown(aggregate, await currentDailyLocale());
    }

    const recap = buildWeeklyRecap(
      aggregate,
      activities,
      countWeeklyConversations(inputs.conversations, today, 12)
    );
    const rangeStart = localDayRange(aggregate.startDate)?.start ?? Date.now();
    const rangeEnd = localDayRange(aggregate.endDate)?.end ?? Date.now();
    return await saveWeeklyReport({
      rangeStart,
      rangeEnd,
      content,
      structured: recap,
      format: usedFallback ? "fallback_plain_text" : "structured_v1",
      status: usedFallback ? "fallback" : "ok",
      schemaVersion: "weekly_recap.v1",
      modelId,
      createdAt: Date.now(),
      sourceHash: hashString(
        `${aggregate.startDate}:${aggregate.endDate}:${aggregate.totals.messages}:${logs
          .map((log) => `${log.date}@${log.updatedAt}`)
          .join(",")}`
      ),
    });
  } finally {
    weeklyInFlight = false;
  }
}
