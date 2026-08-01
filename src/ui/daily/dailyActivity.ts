// P4c daily log: pure core — local-date math, per-day activity aggregation,
// and streak/overview helpers for the log view. No Dexie/IO here; the caller
// (dailyService) gathers conversations, digests and summaries and passes them
// in, so everything stays deterministic and unit-testable. The journal
// rendering itself (fork merging, cluster extraction, deterministic anchors,
// local template) lives in ./dailyJournal; the two-pass LLM orchestration in
// ./dailyPipeline.

import type { DailyLogStats } from "../db/types";

/** Total context budget handed to the daily/weekly agent (~20K chars). The
 * main process caps transcriptOverride at 30K, so this always fits. */
export const DAILY_CONTEXT_BUDGET_CHARS = 20_000;

/** Window event fired after a daily log is (re)generated, so an open log
 * view refreshes itself. */
export const DAILY_UPDATED_EVENT = "vesti:daily-updated";

/** Locale for the deterministic journal renderers. */
export type DailyLocale = "zh" | "en";

// ---- Local-date helpers ----------------------------------------------------
// Everything runs on the local clock (the user's calendar day), never on UTC,
// so day boundaries survive timezone offsets and DST transitions.

export function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** Epoch ms → local calendar day "YYYY-MM-DD". */
export function toLocalDateString(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** Validate + decompose "YYYY-MM-DD"; null when malformed. */
export function parseLocalDateString(
  date: string
): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year, month, day };
}

/** [start, end) epoch-ms bounds of a local calendar day. DST-safe: the end is
 * computed by the Date constructor rolling to the next day, not by adding
 * 86_400_000 ms. */
export function localDayRange(date: string): { start: number; end: number } | null {
  const parsed = parseLocalDateString(date);
  if (!parsed) return null;
  const start = new Date(parsed.year, parsed.month - 1, parsed.day).getTime();
  const end = new Date(parsed.year, parsed.month - 1, parsed.day + 1).getTime();
  return { start, end };
}

/** Shift a local date by whole days (negative = backwards); null when the
 * input is malformed. */
export function addDaysToDateString(date: string, days: number): string | null {
  const parsed = parseLocalDateString(date);
  if (!parsed) return null;
  return toLocalDateString(
    new Date(parsed.year, parsed.month - 1, parsed.day + days).getTime()
  );
}

export function todayDateString(now: number = Date.now()): string {
  return toLocalDateString(now);
}

/** The `count` local days ending at `endDate`, ascending (oldest first). */
export function lastNDates(count: number, endDate: string): string[] {
  const dates: string[] = [];
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    const date = addDaysToDateString(endDate, -offset);
    if (date) dates.push(date);
  }
  return dates;
}

// ---- Activity collection ---------------------------------------------------

/** Minimal conversation shape the aggregation needs (mapped from Dexie). */
export interface DailyConversationInput {
  id: number;
  title: string;
  platform: string;
  updatedAt: number;
  messageCount: number;
  source: "cli" | "browser";
  projectLabel: string | null;
}

/** Per-conversation digest (P1.5 conversation tree index). */
export interface DailyDigestInput {
  conversationId: number;
  oneLiner: string;
  keyTopics: string[];
  keyFiles: string[];
  decisions: string[];
}

/** Browser-conversation summary record (latest per conversation wins). */
export interface DailySummaryInput {
  conversationId: number;
  content: string;
  createdAt: number;
}

export interface DailyActivityItem {
  id: number;
  title: string;
  platform: string;
  source: "cli" | "browser";
  projectLabel: string | null;
  messageCount: number;
  /** Last-activity epoch ms (the day filter's ordering key). */
  updatedAt: number;
  digest: DailyDigestInput | null;
  summary: string | null;
}

export interface DailyActivity {
  date: string;
  /** Conversations active that day, chronological (oldest first). */
  items: DailyActivityItem[];
  stats: DailyLogStats;
}

export function emptyDailyLogStats(): DailyLogStats {
  return { cliSessions: 0, browserConversations: 0, platforms: [], projects: [], messages: 0 };
}

/**
 * Everything active on one local day: conversations whose last update falls
 * inside the day's local [start, end) bounds, each joined with its digest
 * (CLI side) and latest summary (browser side), plus aggregate stats. Days
 * with no activity return an empty `items` list and zeroed stats.
 */
export function collectDailyActivity(
  date: string,
  input: {
    conversations: DailyConversationInput[];
    digests: DailyDigestInput[];
    summaries: DailySummaryInput[];
  }
): DailyActivity {
  const range = localDayRange(date);
  const stats = emptyDailyLogStats();
  if (!range) return { date, items: [], stats };

  const digestById = new Map<number, DailyDigestInput>();
  for (const digest of input.digests) {
    if (!digestById.has(digest.conversationId)) digestById.set(digest.conversationId, digest);
  }
  const summaryById = new Map<number, DailySummaryInput>();
  for (const summary of input.summaries) {
    const existing = summaryById.get(summary.conversationId);
    if (!existing || summary.createdAt > existing.createdAt) {
      summaryById.set(summary.conversationId, summary);
    }
  }

  const items = input.conversations
    .filter(
      (conversation) =>
        conversation.updatedAt >= range.start && conversation.updatedAt < range.end
    )
    .sort((a, b) => a.updatedAt - b.updatedAt)
    .map((conversation): DailyActivityItem => {
      const summary = summaryById.get(conversation.id)?.content.trim();
      return {
        id: conversation.id,
        title: conversation.title,
        platform: conversation.platform,
        source: conversation.source,
        projectLabel: conversation.projectLabel,
        messageCount: conversation.messageCount,
        updatedAt: conversation.updatedAt,
        digest: digestById.get(conversation.id) ?? null,
        summary: summary || null,
      };
    });

  const platforms = new Set<string>();
  const projects = new Set<string>();
  for (const item of items) {
    if (item.source === "cli") stats.cliSessions += 1;
    else stats.browserConversations += 1;
    if (item.platform) platforms.add(item.platform);
    if (item.projectLabel) projects.add(item.projectLabel);
    stats.messages += item.messageCount;
  }
  stats.platforms = [...platforms];
  stats.projects = [...projects];
  return { date, items, stats };
}

// ---- Streak / overview helpers (log view stats header) ---------------------

/**
 * Consecutive logged days ending today — or ending yesterday when today has
 * no log yet (the day may still be in progress).
 */
export function computeDailyStreak(
  logDates: Iterable<string>,
  today: string = todayDateString()
): number {
  const dates = new Set(logDates);
  let cursor = dates.has(today) ? today : addDaysToDateString(today, -1);
  if (!cursor || !dates.has(cursor)) return 0;
  let streak = 0;
  while (cursor && dates.has(cursor)) {
    streak += 1;
    cursor = addDaysToDateString(cursor, -1);
  }
  return streak;
}

export interface DailyLogOverview {
  totalDays: number;
  streak: number;
  /** The last 7 local days, ascending, each with its logged message count
   * (0 for days without a log). Drives the week-activity visualization. */
  week: Array<{ date: string; messages: number; hasLog: boolean }>;
}

export function computeDailyOverview(
  logs: Array<{ date: string; stats: DailyLogStats }>,
  today: string = todayDateString()
): DailyLogOverview {
  const byDate = new Map(logs.map((log) => [log.date, log]));
  return {
    totalDays: byDate.size,
    streak: computeDailyStreak(byDate.keys(), today),
    week: lastNDates(7, today).map((date) => {
      const log = byDate.get(date);
      return { date, messages: log?.stats.messages ?? 0, hasLog: Boolean(log) };
    }),
  };
}
