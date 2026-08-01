// Daily journal + weekly report: IO orchestration. Gathers the renderer-side
// inputs (Dexie conversations, P1.5 digests, browser summaries, fork lineage
// + subagent briefs from the conversation tree, capture-store open questions,
// raw file-tool touches, project memory), builds the deterministic work model
// (dailyJournal), runs the two-pass LLM pipeline (dailyPipeline) when a model
// is configured — deterministic local journal otherwise — persists via the
// repository and mirrors the result into the Obsidian vault as a long-term
// journal (journalVault). Everything budget/decision-related lives in the
// pure modules; this file only moves data.

import { db } from "../db/schema";
import type { ConversationRecord } from "../db/schema";
import type { DailyLog, WeeklyRecapV1, WeeklyReportRecord } from "../db/types";
import {
  getAllSummaries,
  listDailyLogs,
  saveWeeklyReport,
  setDailyLogVaultPath,
  upsertDailyLog,
} from "../db/repository";
import type {
  ConversationTreeSession,
  RelayFileTouchRow,
  VestiDesktopApi,
} from "../../shared/contracts";
import { listConversationDigests } from "../sync/conversationDigests";
import { loadConversationTree } from "../sync/conversationTree";
import { getLanguageSettings } from "../services/languageSettingsService";
import type { RelayProjectMemory } from "../relay/relayContext";
import {
  DAILY_UPDATED_EVENT,
  addDaysToDateString,
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
  buildDailyWorkModel,
  type DailySessionEnrichment,
} from "./dailyJournal";
import { runDailyTwoPassPipeline, type DailyLlmRunner } from "./dailyPipeline";
import { exportDailyJournalToVault } from "./journalVault";
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

/**
 * Dexie → the minimal shapes the pure aggregation core expects.
 *
 * Source classification: capture-sync records are stamped "local_terminal";
 * EVERYTHING else (extension-bridge imports, JSON restores — older import
 * paths never stamped a source) is browser-side. The previous inverse check
 * (`_source === "browser_extension"`) silently bucketed un-stamped web
 * conversations as CLI, which is how 1700+ browser conversations fell out of
 * the daily data source.
 */
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
    // A1: folded subagent runs roll up into their parent conversation's day.
    if ((record as { _subagent_of?: unknown })._subagent_of) continue;
    const isCli = record._source === "local_terminal";
    conversations.push({
      id: record.id,
      title: record.title,
      platform: record.platform,
      updatedAt: record.updated_at ?? 0,
      messageCount: record.message_count ?? 0,
      source: isCli ? "cli" : "browser",
      projectLabel: isCli
        ? typeof record._project_path === "string" && record._project_path
          ? record._project_path
          : null
        : domainOf(record.url ?? ""),
    });
  }
  return { conversations, digests, summaries };
}

function notifyDailyUpdated(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(DAILY_UPDATED_EVENT));
  }
}

// ---- Journal enrichment (tree lineage, capture extras, anchors, memory) ------

interface DailyJournalBundle {
  activity: DailyActivity;
  enrichments: DailySessionEnrichment[];
  fileTouches: RelayFileTouchRow[];
  resolveTouchConversationId: (sessionId: string) => number | null;
  projectMemory: RelayProjectMemory[];
  previousLogMarkdown: string | null;
}

/** Collect every tree session (main + subagent descendants) into a flat map. */
function indexTreeSessions(
  sessions: ConversationTreeSession[],
  into: Map<string, ConversationTreeSession>
): void {
  for (const session of sessions) {
    into.set(session.id, session);
    if (session.children?.length) indexTreeSessions(session.children, into);
  }
}

/**
 * Gather everything the work model needs beyond the Dexie activity: fork
 * lineage + fork-deduped counts + subagent briefs from the conversation tree,
 * capture-store open questions, raw file-tool touches (subagent descendants
 * fold into their parent conversation, A1), L0/L2 project memory for the
 * day's projects, and yesterday's log for continuity. Every piece is
 * best-effort — a missing bridge or tree simply narrows the model.
 */
async function gatherDailyJournalBundle(
  date: string,
  inputs: DailyInputs
): Promise<DailyJournalBundle> {
  const activity = collectDailyActivity(date, inputs);
  const api = vestiApi();
  const cliItems = activity.items.filter((item) => item.source === "cli");

  const records = (await db.conversations.toArray()) as Array<
    ConversationRecord & LocalTerminalFields
  >;
  const cliIdByConversationId = new Map<number, string>();
  for (const record of records) {
    if (typeof record.id !== "number" || typeof record._cli_id !== "string") continue;
    cliIdByConversationId.set(record.id, record._cli_id);
  }

  const tree = await loadConversationTree().catch(() => null);
  const sessionByCliId = new Map<string, ConversationTreeSession>();
  for (const source of tree?.sources ?? []) {
    for (const project of source.projects) {
      indexTreeSessions(project.sessions, sessionByCliId);
    }
  }

  // Capture-store extras (open_questions never reach the tree digest).
  const dayCliIds = cliItems
    .map((item) => cliIdByConversationId.get(item.id))
    .filter((cliId): cliId is string => Boolean(cliId));
  const sessionContexts =
    api && dayCliIds.length > 0
      ? await api.getRelaySessionContexts(dayCliIds).catch(() => [])
      : [];
  const openQuestionsByCliId = new Map(
    sessionContexts.map((context) => [
      context.sessionId,
      context.digest?.openQuestions ?? [],
    ])
  );

  const enrichments: DailySessionEnrichment[] = cliItems.map((item) => {
    const cliId = cliIdByConversationId.get(item.id) ?? null;
    const treeSession = cliId ? sessionByCliId.get(cliId) : undefined;
    return {
      conversationId: item.id,
      cliId,
      forkedFrom: treeSession?.forkedFrom ?? null,
      uniqueMessageCount: treeSession?.uniqueMessageCount ?? null,
      openQuestions: (cliId && openQuestionsByCliId.get(cliId)) || [],
      subagents: (treeSession?.children ?? []).map((child) => ({
        role: child.subagentRole ?? null,
        title: child.title,
        oneLiner: child.oneLiner,
      })),
    };
  });

  // File touches: the day's CLI sessions plus their subagent descendants,
  // resolved back to the parent conversation id (A1 fold-in).
  const conversationIdByCliId = new Map<string, number>();
  for (const [conversationId, cliId] of cliIdByConversationId) {
    conversationIdByCliId.set(cliId, conversationId);
  }
  const dayCliIdSet = new Set(dayCliIds);
  const touchCliIds = new Set<string>(dayCliIds);
  for (const [cliId, treeSession] of sessionByCliId) {
    if (!dayCliIdSet.has(cliId)) continue;
    const parentConversationId = conversationIdByCliId.get(cliId);
    if (parentConversationId === undefined) continue;
    const descendants: string[] = [];
    const collect = (session: ConversationTreeSession): void => {
      for (const child of session.children ?? []) {
        descendants.push(child.id);
        collect(child);
      }
    };
    collect(treeSession);
    for (const descendantId of descendants) {
      touchCliIds.add(descendantId);
      if (!conversationIdByCliId.has(descendantId)) {
        conversationIdByCliId.set(descendantId, parentConversationId);
      }
    }
  }
  const fileTouches =
    api && touchCliIds.size > 0
      ? await api
          .getRelayFileTouches([...touchCliIds].slice(0, 200))
          .catch(() => [] as RelayFileTouchRow[])
      : [];
  const dayConversationIds = new Set(activity.items.map((item) => item.id));
  const resolveTouchConversationId = (sessionId: string): number | null => {
    const conversationId = conversationIdByCliId.get(sessionId) ?? null;
    return conversationId !== null && dayConversationIds.has(conversationId)
      ? conversationId
      : null;
  };

  // Project memory for the day's projects (cap 3 to bound the transcript).
  const projectMemory: RelayProjectMemory[] = [];
  if (api && dayCliIdSet.size > 0 && tree) {
    const projects: Array<{ projectKey: string; label: string }> = [];
    for (const source of tree.sources) {
      for (const project of source.projects) {
        const touchesDay = project.sessions.some(
          (session) =>
            dayCliIdSet.has(session.id) ||
            (session.children ?? []).some((child) => dayCliIdSet.has(child.id))
        );
        if (touchesDay) {
          projects.push({ projectKey: project.projectKey, label: project.label });
          if (projects.length >= 3) break;
        }
      }
      if (projects.length >= 3) break;
    }
    if (projects.length > 0) {
      const states = await api.getProjectStates().catch(() => []);
      const stateByKey = new Map(states.map((state) => [state.projectKey, state]));
      for (const project of projects) {
        const brief = await api.getProjectBrief(project.projectKey).catch(() => null);
        const state = stateByKey.get(project.projectKey) ?? null;
        if (!state && !brief?.contentMarkdown?.trim()) continue;
        projectMemory.push({
          label: project.label,
          state,
          briefMarkdown: brief?.contentMarkdown ?? null,
        });
      }
    }
  }

  // Yesterday's log: continuity context for tomorrow's-leads reasoning.
  const yesterday = addDaysToDateString(date, -1);
  const previousLogMarkdown = yesterday
    ? ((await listDailyLogs().catch(() => [])).find((log) => log.date === yesterday)
        ?.contentMarkdown ?? null)
    : null;

  return {
    activity,
    enrichments,
    fileTouches,
    resolveTouchConversationId,
    projectMemory,
    previousLogMarkdown,
  };
}

// ---- Daily log generation ----------------------------------------------------

const inFlightDates = new Set<string>();

/** The api.runAgent surface adapted to the pipeline's runner interface. */
function makeDailyLlmRunner(api: VestiDesktopApi, date: string): DailyLlmRunner {
  return async ({ template, transcript }) => {
    const result = await api.runAgent({
      kind: "daily",
      sessionId: `daily:${date}:${template}`,
      template,
      transcriptOverride: transcript,
      persist: false,
    });
    if (!result.content.trim()) throw new Error("模型没有返回内容");
    return result.content;
  };
}

/** Mirror the freshly generated log into the Obsidian vault journal and
 * record the note path on the Dexie row. Best-effort: vault failures never
 * fail the generation itself. */
async function syncJournalToVault(log: DailyLog, locale: DailyLocale): Promise<void> {
  try {
    const logs = await listDailyLogs().catch(() => []);
    const month = log.date.slice(0, 7);
    const monthDates = logs
      .map((entry) => entry.date)
      .filter((entry) => entry.startsWith(month));
    const result = await exportDailyJournalToVault({ log, monthDates, locale });
    if (result) await setDailyLogVaultPath(log.date, result.relativePath);
  } catch {
    // The vault is an optional mirror — the Dexie log is the source of truth.
  }
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
    const bundle = await gatherDailyJournalBundle(date, inputs);
    if (bundle.activity.items.length === 0) return null;

    const locale = await currentDailyLocale();
    const api = vestiApi();
    const run = api && (await isLlmConfigured(api)) ? makeDailyLlmRunner(api, date) : null;
    const model = buildDailyWorkModel({
      activity: bundle.activity,
      enrichments: bundle.enrichments,
      fileTouches: bundle.fileTouches,
      resolveTouchConversationId: bundle.resolveTouchConversationId,
    });
    const { contentMarkdown } = await runDailyTwoPassPipeline({
      model,
      projectMemory: bundle.projectMemory,
      previousLogMarkdown: bundle.previousLogMarkdown,
      run,
      locale,
    });

    const log = await upsertDailyLog({
      date,
      contentMarkdown,
      stats: bundle.activity.stats,
      source,
    });
    await syncJournalToVault(log, locale);
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
 * Aggregate the last 7 local days into a weekly report, summarizing the
 * week's STORED DAILY LOGS (not re-deriving from raw conversations): days
 * with a log contribute their sections, days with activity but no log a
 * stats-only block. The `daily` agent kind with the 'weekly' template when an
 * LLM is configured, the local template otherwise. Upserts into
 * weekly_reports keyed by the (rangeStart, rangeEnd) pair.
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
