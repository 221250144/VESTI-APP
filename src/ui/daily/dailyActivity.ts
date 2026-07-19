// P4c daily log: pure core — local-date math, per-day activity aggregation,
// condensed context assembly for the `daily` agent kind, the no-LLM local
// template, and streak/overview helpers for the log view. No Dexie/IO here;
// the caller (dailyService) gathers conversations, digests and summaries and
// passes them in, so everything stays deterministic and unit-testable.

import type { DailyLogStats } from "../db/types";

/** Total context budget handed to the daily/weekly agent (~20K chars). The
 * main process caps transcriptOverride at 30K, so this always fits. */
export const DAILY_CONTEXT_BUDGET_CHARS = 20_000;

/** Window event fired after a daily log is (re)generated, so an open log
 * view refreshes itself. */
export const DAILY_UPDATED_EVENT = "vesti:daily-updated";

const SUMMARY_EXCERPT_MAX_CHARS = 600;
const LOG_EXCERPT_MAX_CHARS = 200;

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

// ---- Condensed context for the `daily` agent kind --------------------------

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncateText(value: string, maxChars: number): string {
  const collapsed = collapseWhitespace(value);
  if (collapsed.length <= maxChars) return collapsed;
  return `${collapsed.slice(0, Math.max(0, maxChars - 1))}…`;
}

function joinList(items: string[] | undefined, maxItems: number): string {
  return (items ?? [])
    .map((item) => collapseWhitespace(item))
    .filter(Boolean)
    .slice(0, maxItems)
    .join("、");
}

function buildCliSessionBlock(item: DailyActivityItem, index: number): string {
  const project = item.projectLabel ? ` · ${item.projectLabel}` : "";
  const lines = [`[${index + 1}] 《${truncateText(item.title || "未命名会话", 80)}》（${item.platform}${project} · ${item.messageCount} 条消息）`];
  const digest = item.digest;
  if (digest?.oneLiner) lines.push(`一句话：${truncateText(digest.oneLiner, 200)}`);
  const topics = joinList(digest?.keyTopics, 6);
  if (topics) lines.push(`关键主题：${topics}`);
  const files = joinList(digest?.keyFiles, 6);
  if (files) lines.push(`关键文件：${files}`);
  const decisions = joinList(digest?.decisions, 6);
  if (decisions) lines.push(`关键决策：${decisions}`);
  if (!digest?.oneLiner && !topics && !files && !decisions && item.summary) {
    lines.push(`摘要：${truncateText(item.summary, SUMMARY_EXCERPT_MAX_CHARS)}`);
  }
  return lines.join("\n");
}

function buildBrowserConversationBlock(item: DailyActivityItem, index: number): string {
  const project = item.projectLabel ? ` · ${item.projectLabel}` : "";
  const lines = [`[${index + 1}] 《${truncateText(item.title || "未命名会话", 80)}》（${item.platform}${project} · ${item.messageCount} 条消息）`];
  if (item.summary) {
    lines.push(`摘要要点：${truncateText(item.summary, SUMMARY_EXCERPT_MAX_CHARS)}`);
  } else if (item.digest?.oneLiner) {
    lines.push(`摘要要点：${truncateText(item.digest.oneLiner, 200)}`);
  }
  return lines.join("\n");
}

/**
 * Assemble the condensed daily context for the `daily` agent kind: a stats
 * header, then CLI session blocks (digest-driven) and browser conversation
 * blocks (title + summary excerpt). Items are admitted in chronological
 * order until the budget runs out; the remainder is reported as a count so
 * the model knows the list is partial.
 */
export function buildDailyTranscript(
  activity: DailyActivity,
  budgetChars: number = DAILY_CONTEXT_BUDGET_CHARS
): string {
  const stats = activity.stats;
  const header = [
    `日期：${activity.date}（本地时区）`,
    `统计：CLI 会话 ${stats.cliSessions} 个 · 网页会话 ${stats.browserConversations} 个 · 消息 ${stats.messages} 条` +
      (stats.platforms.length > 0 ? ` · 平台 ${stats.platforms.join("、")}` : "") +
      (stats.projects.length > 0 ? ` · 项目 ${stats.projects.join("、")}` : ""),
  ].join("\n");

  const cliItems = activity.items.filter((item) => item.source === "cli");
  const browserItems = activity.items.filter((item) => item.source === "browser");

  const sections: string[] = [header];
  let used = header.length;
  let omitted = 0;
  const admitGroup = (label: string, blocks: string[]): void => {
    const admitted: string[] = [];
    for (const block of blocks) {
      // Reserve room for the group label and the omission note.
      if (used + block.length + label.length + 42 > budgetChars) {
        omitted += 1;
        continue;
      }
      admitted.push(block);
      used += block.length + 2;
    }
    if (admitted.length > 0) sections.push(label, ...admitted);
  };

  admitGroup("CLI 会话：", cliItems.map((item, index) => buildCliSessionBlock(item, index)));
  admitGroup("网页会话：", browserItems.map((item, index) => buildBrowserConversationBlock(item, index)));
  if (omitted > 0) sections.push(`（另有 ${omitted} 个会话因长度限制未列出）`);
  return sections.join("\n\n");
}

// ---- No-LLM local template -------------------------------------------------

export type DailyLocale = "zh" | "en";

const LOCAL_TEMPLATE_COPY = {
  zh: {
    title: (date: string) => `# ${date} 日报`,
    note: "> 未配置模型，以下为本地模板生成的结构化记录（未经 AI 润色）。",
    overview: "## 今日概览",
    overviewLine: (stats: DailyLogStats) =>
      `今日通过 ${stats.platforms.join("、") || "各平台"} 进行了 ${stats.cliSessions + stats.browserConversations} 个 AI 会话，共 ${stats.messages} 条消息。`,
    cliLine: (stats: DailyLogStats) =>
      stats.cliSessions > 0 ? `- CLI 编程会话 ${stats.cliSessions} 个` : null,
    browserLine: (stats: DailyLogStats) =>
      stats.browserConversations > 0 ? `- 网页端 AI 对话 ${stats.browserConversations} 个` : null,
    projectsLine: (stats: DailyLogStats) =>
      stats.projects.length > 0 ? `- 涉及项目/站点：${stats.projects.join("、")}` : null,
    files: "## 关键文件与状态",
    web: "## 网页端 AI 对话摘要",
    next: "## 明日待办线索",
    none: "无",
    cliSessions: "## CLI 会话清单",
    fromConversation: (title: string) => `（来自《${title}》）`,
  },
  en: {
    title: (date: string) => `# ${date} Daily log`,
    note: "> No model configured — this is a structured record from the local template (no AI polish).",
    overview: "## Today's overview",
    overviewLine: (stats: DailyLogStats) =>
      `${stats.cliSessions + stats.browserConversations} AI conversations across ${stats.platforms.join(", ") || "all platforms"}, ${stats.messages} messages in total.`,
    cliLine: (stats: DailyLogStats) =>
      stats.cliSessions > 0 ? `- ${stats.cliSessions} CLI coding session(s)` : null,
    browserLine: (stats: DailyLogStats) =>
      stats.browserConversations > 0 ? `- ${stats.browserConversations} browser AI conversation(s)` : null,
    projectsLine: (stats: DailyLogStats) =>
      stats.projects.length > 0 ? `- Projects/sites: ${stats.projects.join(", ")}` : null,
    files: "## Key files & status",
    web: "## Browser AI conversation digest",
    next: "## Leads for tomorrow",
    none: "None",
    cliSessions: "## CLI session list",
    fromConversation: (title: string) => ` (from "${title}")`,
  },
} as const;

/**
 * Structured daily log without any LLM: stats, the session listing and the
 * day's key files, laid out in the same section structure the agent prompt
 * asks for, so downstream views render both paths identically.
 */
export function buildLocalDailyMarkdown(
  activity: DailyActivity,
  locale: DailyLocale = "zh"
): string {
  const copy = LOCAL_TEMPLATE_COPY[locale] ?? LOCAL_TEMPLATE_COPY.zh;
  const stats = activity.stats;
  const sections: string[] = [copy.title(activity.date), copy.note];

  const overviewLines = [
    copy.overviewLine(stats),
    copy.cliLine(stats),
    copy.browserLine(stats),
    copy.projectsLine(stats),
  ].filter((line): line is string => Boolean(line));
  sections.push(`${copy.overview}\n${overviewLines.join("\n")}`);

  const cliItems = activity.items.filter((item) => item.source === "cli");
  const sessionLines = cliItems.map((item) => {
    const detail = item.digest?.oneLiner ? ` — ${truncateText(item.digest.oneLiner, 120)}` : "";
    const project = item.projectLabel ? ` · ${item.projectLabel}` : "";
    return `- 《${item.title}》（${item.platform}${project} · ${item.messageCount}）${detail}`;
  });
  if (sessionLines.length > 0) {
    sections.push(`${copy.cliSessions}\n${sessionLines.join("\n")}`);
  }

  const fileLines: string[] = [];
  for (const item of cliItems) {
    for (const file of item.digest?.keyFiles ?? []) {
      fileLines.push(`- \`${file}\`${copy.fromConversation(item.title)}`);
    }
  }
  sections.push(`${copy.files}\n${fileLines.length > 0 ? fileLines.join("\n") : copy.none}`);

  const browserItems = activity.items.filter((item) => item.source === "browser");
  const webLines = browserItems.map((item) => {
    const excerpt = item.summary
      ? `：${truncateText(item.summary, LOG_EXCERPT_MAX_CHARS)}`
      : item.digest?.oneLiner
        ? `：${truncateText(item.digest.oneLiner, 120)}`
        : "";
    return `- 《${item.title}》（${item.platform}）${excerpt}`;
  });
  sections.push(`${copy.web}\n${webLines.length > 0 ? webLines.join("\n") : copy.none}`);

  // The local template cannot infer tomorrow's todos without an LLM; it
  // surfaces "none" rather than fabricating leads.
  sections.push(`${copy.next}\n${copy.none}`);

  return sections.join("\n\n");
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
