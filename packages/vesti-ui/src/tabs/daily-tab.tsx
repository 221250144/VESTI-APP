"use client";

// Daily log area (P4c) — per-day AI activity reports plus the weekly report.
// Left: streak/week stats, the weekly section and the daily timeline. Right:
// the selected log/report (Markdown body, regenerate, multi-format export).
// Generation and persistence go through optional StorageApi methods;
// platforms without the desktop bridge see the empty state with everything
// disabled. When no LLM is configured, generation silently uses the local
// template — the view only shows a hint.

import { useEffect, useMemo, useState } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import {
  BookText,
  CalendarDays,
  ChevronDown,
  Download,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { SendToMenu } from "../components/SendToMenu";
import { sanitizeFileBaseName } from "../lib/extractMarkdown";
import type {
  DailyLog,
  DailyLogOverview,
  RelayAvailability,
  StorageApi,
  WeeklyReport,
} from "../types";

type DailyTabProps = {
  storage: StorageApi;
  /** labels.daily group (Record<string,string>); English fallbacks inline. */
  labels?: Record<string, string>;
  /** Library labels for the SendToMenu (Notion/Obsidian export). */
  sendToLabels?: Record<string, any>;
};

type ViewSelection =
  | { kind: "daily"; id: number }
  | { kind: "weekly"; id: number };

// Fired by the desktop daily service after an auto (re)generation.
const DAILY_UPDATED_EVENT = "vesti:daily-updated";

function downloadTextFile(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

/** Plain-text preview of a Markdown body: headings/quotes/list markers
 * stripped, first meaningful line kept. */
function previewOf(markdown: string, maxChars = 120): string {
  const line = markdown
    .split(/\r?\n/)
    .map((item) => item.replace(/^[#>\s\-*]+/, "").trim())
    .find((item) => item.length > 0);
  if (!line) return "";
  return line.length <= maxChars ? line : `${line.slice(0, maxChars - 1)}…`;
}

function formatRange(rangeStart: number, rangeEnd: number): string {
  const start = new Date(rangeStart).toLocaleDateString();
  // rangeEnd is exclusive (next day 00:00); show the last included day.
  const end = new Date(rangeEnd - 1).toLocaleDateString();
  return `${start} ~ ${end}`;
}

/** Today as a local "YYYY-MM-DD" string (same convention as the log rows). */
function todayLocalDateString(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function DailyTab({ storage, labels, sendToLabels }: DailyTabProps) {
  const l = (key: string, fallback: string) => labels?.[key] ?? fallback;

  const [logs, setLogs] = useState<DailyLog[] | null>(null);
  const [overview, setOverview] = useState<DailyLogOverview | null>(null);
  const [weeklyReports, setWeeklyReports] = useState<WeeklyReport[] | null>(null);
  const [pendingDates, setPendingDates] = useState<string[]>([]);
  const [selection, setSelection] = useState<ViewSelection | null>(null);
  const [availability, setAvailability] = useState<RelayAvailability | null>(null);
  const [generating, setGenerating] = useState(false);
  const [weeklyGenerating, setWeeklyGenerating] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [exporting, setExporting] = useState(false);

  const available = Boolean(storage.listDailyLogs && storage.generateDailyLog);
  const llmMissing = availability !== null && !availability.llmConfigured;

  const refresh = async () => {
    if (!storage.listDailyLogs) return;
    const [items, stats, reports, pending] = await Promise.all([
      storage.listDailyLogs().catch(() => []),
      storage.getDailyLogOverview?.().catch(() => null) ?? Promise.resolve(null),
      storage.listWeeklyReports?.().catch(() => []) ?? Promise.resolve([]),
      storage.getPendingDailyDates?.().catch(() => []) ?? Promise.resolve([]),
    ]);
    setLogs(items);
    setOverview(stats);
    setWeeklyReports(reports);
    setPendingDates(pending);
  };

  useEffect(() => {
    void refresh();
    void storage.getRelayAvailability?.().then(setAvailability);
    const onUpdated = () => void refresh();
    window.addEventListener(DAILY_UPDATED_EVENT, onUpdated);
    return () => window.removeEventListener(DAILY_UPDATED_EVENT, onUpdated);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storage]);

  const viewLog = useMemo(
    () =>
      selection?.kind === "daily"
        ? (logs ?? []).find((log) => log.id === selection.id) ?? null
        : null,
    [logs, selection],
  );
  const viewWeekly = useMemo(
    () =>
      selection?.kind === "weekly"
        ? (weeklyReports ?? []).find((report) => report.id === selection.id) ?? null
        : null,
    [weeklyReports, selection],
  );

  const viewHtml = useMemo(() => {
    const markdown = viewLog?.contentMarkdown ?? viewWeekly?.content ?? null;
    if (!markdown) return "";
    return DOMPurify.sanitize(
      marked.parse(markdown, { gfm: true, breaks: false }) as string,
    );
  }, [viewLog, viewWeekly]);

  const weekMaxMessages = useMemo(
    () => Math.max(1, ...(overview?.week ?? []).map((day) => day.messages)),
    [overview],
  );

  const selectDaily = (id: number) => {
    setSelection({ kind: "daily", id });
    setExportOpen(false);
    setNotice(null);
  };

  const selectWeekly = (id: number) => {
    setSelection({ kind: "weekly", id });
    setExportOpen(false);
    setNotice(null);
  };

  const handleGenerateDates = async (dates: string[]) => {
    if (!storage.generateDailyLog || dates.length === 0) return;
    setGenerating(true);
    setNotice(null);
    try {
      let generated = 0;
      for (const date of dates) {
        const log = await storage.generateDailyLog({ date });
        if (log) generated += 1;
      }
      if (generated === 0) {
        setNotice(l("noActivity", "No activity to record for the selected day(s)."));
      }
      await refresh();
    } catch (error) {
      setNotice((error as Error)?.message ?? String(error));
    } finally {
      setGenerating(false);
    }
  };

  const handleGenerateWeekly = async () => {
    if (!storage.generateWeeklyReport) return;
    setWeeklyGenerating(true);
    setNotice(null);
    try {
      const report = await storage.generateWeeklyReport();
      await refresh();
      setSelection({ kind: "weekly", id: report.id });
    } catch (error) {
      setNotice((error as Error)?.message ?? String(error));
    } finally {
      setWeeklyGenerating(false);
    }
  };

  const handleDownload = () => {
    if (viewLog) {
      downloadTextFile(`daily-${viewLog.date}.md`, viewLog.contentMarkdown, "text/markdown");
    } else if (viewWeekly) {
      downloadTextFile(
        `weekly-${sanitizeFileBaseName(formatRange(viewWeekly.rangeStart, viewWeekly.rangeEnd))}.md`,
        viewWeekly.content,
        "text/markdown",
      );
    }
    setExportOpen(false);
  };

  const handleExportToDirectory = async () => {
    if (!storage.exportDailyLogMarkdown || !viewLog) return;
    setExporting(true);
    setExportOpen(false);
    setNotice(null);
    try {
      const result = await storage.exportDailyLogMarkdown(viewLog.id);
      if (result) {
        setNotice(
          l("exportedTo", "Exported to {path}").replace("{path}", result.relativePath),
        );
      }
    } catch (error) {
      setNotice((error as Error)?.message ?? String(error));
    } finally {
      setExporting(false);
    }
  };

  if (!available) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 bg-bg-app">
        <BookText strokeWidth={1.75} className="h-8 w-8 text-text-tertiary" />
        <p className="text-vesti-lg font-serif text-text-primary">
          {l("title", "Daily log")}
        </p>
        <p className="text-vesti-base font-sans text-text-tertiary">
          {l("unavailable", "Daily log is unavailable in the current environment.")}
        </p>
      </div>
    );
  }

  const todayPending = pendingDates.length > 0;

  return (
    <div className="flex h-full overflow-hidden bg-bg-app">
      {/* Left column: stats + weekly + timeline */}
      <aside className="flex w-[340px] shrink-0 flex-col border-r border-border-subtle bg-bg-tertiary">
        <div className="border-b border-border-subtle px-4 py-3">
          <h1 className="text-vesti-lg font-serif text-text-primary">
            {l("title", "Daily log")}
          </h1>
          <p className="mt-0.5 text-vesti-sm font-sans text-text-tertiary">
            {l("subtitle", "Your AI activity, summarized every day.")}
          </p>
        </div>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
          {/* Stats header */}
          {overview ? (
            <section className="rounded-lg border border-border-subtle bg-bg-surface-card px-3 py-2.5">
              <div className="flex items-baseline gap-4">
                <span className="text-vesti-sm font-sans text-text-secondary">
                  {l("statsTotalDays", "Total {count} days").replace(
                    "{count}",
                    String(overview.totalDays),
                  )}
                </span>
                <span className="text-vesti-sm font-sans text-text-secondary">
                  {l("statsStreak", "Streak {count} days").replace(
                    "{count}",
                    String(overview.streak),
                  )}
                </span>
              </div>
              <div
                className="mt-2 flex h-10 items-end gap-1"
                role="img"
                aria-label={l("statsWeekActivity", "Messages per day, last 7 days")}
              >
                {overview.week.map((day) => (
                  <div
                    key={day.date}
                    title={`${day.date} · ${day.messages}`}
                    className={`flex-1 rounded-sm ${
                      day.hasLog ? "bg-accent-primary" : "bg-border-subtle"
                    }`}
                    style={{
                      height: `${Math.max(8, Math.round((day.messages / weekMaxMessages) * 100))}%`,
                      opacity: day.hasLog ? 0.45 + (0.55 * day.messages) / weekMaxMessages : 1,
                    }}
                  />
                ))}
              </div>
            </section>
          ) : null}

          {/* Generate controls */}
          <section className="space-y-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={() => void handleGenerateDates([todayLocalDateString()])}
                disabled={generating}
                className="inline-flex items-center gap-1.5 rounded-md bg-accent-primary px-3 py-1.5 text-vesti-base font-sans text-text-inverse transition-colors hover:bg-accent-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                {generating ? (
                  <RefreshCw strokeWidth={1.75} className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Sparkles strokeWidth={1.75} className="h-3.5 w-3.5" />
                )}
                {generating ? l("generating", "Generating…") : l("generateNow", "Generate now")}
              </button>
              {todayPending ? (
                <button
                  type="button"
                  onClick={() => void handleGenerateDates(pendingDates)}
                  disabled={generating}
                  className="inline-flex items-center gap-1 rounded-md border border-border-subtle px-2.5 py-1.5 text-vesti-sm font-sans text-text-secondary transition-colors hover:bg-bg-surface-card disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <CalendarDays strokeWidth={1.75} className="h-3.5 w-3.5" />
                  {l("catchUp", "Catch up {count} day(s)").replace(
                    "{count}",
                    String(pendingDates.length),
                  )}
                </button>
              ) : null}
            </div>
            {llmMissing ? (
              <p className="text-vesti-sm font-sans text-text-tertiary">
                {l(
                  "llmLocalHint",
                  "No model configured — logs are generated from the local template.",
                )}
              </p>
            ) : null}
            {notice ? (
              <p className="text-vesti-sm font-sans text-danger">{notice}</p>
            ) : null}
          </section>

          {/* Weekly section */}
          {storage.listWeeklyReports && storage.generateWeeklyReport ? (
            <section>
              <div className="mb-1.5 flex items-center justify-between px-1">
                <h2 className="text-vesti-sm font-sans font-medium uppercase tracking-wide text-text-tertiary">
                  {l("weeklyTitle", "Weekly report")}
                </h2>
                <button
                  type="button"
                  onClick={() => void handleGenerateWeekly()}
                  disabled={weeklyGenerating}
                  className="inline-flex items-center gap-1 rounded-md border border-border-subtle px-2 py-0.5 text-vesti-sm font-sans text-text-secondary transition-colors hover:bg-bg-surface-card disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {weeklyGenerating ? (
                    <RefreshCw strokeWidth={1.75} className="h-3 w-3 animate-spin" />
                  ) : (
                    <Sparkles strokeWidth={1.75} className="h-3 w-3" />
                  )}
                  {weeklyGenerating
                    ? l("generating", "Generating…")
                    : l("weeklyGenerate", "Generate")}
                </button>
              </div>
              {(weeklyReports ?? []).length === 0 ? (
                <p className="px-1 py-2 text-vesti-sm font-sans text-text-tertiary">
                  {l("weeklyEmpty", "No weekly report yet. Generate one from the last 7 days.")}
                </p>
              ) : (
                <div className="space-y-1">
                  {(weeklyReports ?? []).slice(0, 4).map((report) => (
                    <button
                      key={report.id}
                      type="button"
                      onClick={() => selectWeekly(report.id)}
                      className={`flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left transition-colors ${
                        selection?.kind === "weekly" && selection.id === report.id
                          ? "border-accent-primary bg-bg-surface-card-active"
                          : "border-transparent hover:bg-bg-surface-card"
                      }`}
                    >
                      <BookText strokeWidth={1.75} className="h-4 w-4 shrink-0 text-text-tertiary" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-vesti-base font-sans text-text-primary">
                          {formatRange(report.rangeStart, report.rangeEnd)}
                        </span>
                        <span className="block text-vesti-sm font-sans text-text-tertiary">
                          {previewOf(report.content, 60)}
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </section>
          ) : null}

          {/* Daily timeline */}
          <section>
            <h2 className="mb-1.5 px-1 text-vesti-sm font-sans font-medium uppercase tracking-wide text-text-tertiary">
              {l("timeline", "Timeline")}
            </h2>
            {logs === null ? (
              <div className="flex items-center justify-center gap-2 py-6 text-text-secondary">
                <RefreshCw strokeWidth={1.75} className="h-4 w-4 animate-spin" />
              </div>
            ) : logs.length === 0 ? (
              <p className="px-1 py-2 text-vesti-sm font-sans text-text-tertiary">
                {l("timelineEmpty", "No logs yet. They generate automatically every evening.")}
              </p>
            ) : (
              <div className="space-y-1">
                {logs.map((log) => (
                  <button
                    key={log.id}
                    type="button"
                    onClick={() => selectDaily(log.id)}
                    className={`flex w-full flex-col gap-1 rounded-lg border px-3 py-2 text-left transition-colors ${
                      selection?.kind === "daily" && selection.id === log.id
                        ? "border-accent-primary bg-bg-surface-card-active"
                        : "border-transparent hover:bg-bg-surface-card"
                    }`}
                  >
                    <span className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-vesti-base font-sans font-medium text-text-primary">
                        {log.date}
                      </span>
                      <span className="shrink-0 rounded-full bg-bg-secondary px-1.5 py-0.5 text-vesti-sm font-sans text-text-tertiary">
                        {log.source === "auto"
                          ? l("sourceAuto", "auto")
                          : l("sourceManual", "manual")}
                      </span>
                    </span>
                    <span className="flex flex-wrap gap-1">
                      <span className="rounded-full bg-bg-secondary px-1.5 py-0.5 text-vesti-sm font-sans text-text-tertiary">
                        {l("chipCli", "CLI {count}").replace("{count}", String(log.stats.cliSessions))}
                      </span>
                      <span className="rounded-full bg-bg-secondary px-1.5 py-0.5 text-vesti-sm font-sans text-text-tertiary">
                        {l("chipBrowser", "Web {count}").replace(
                          "{count}",
                          String(log.stats.browserConversations),
                        )}
                      </span>
                      <span className="rounded-full bg-bg-secondary px-1.5 py-0.5 text-vesti-sm font-sans text-text-tertiary">
                        {l("chipMessages", "{count} msgs").replace(
                          "{count}",
                          String(log.stats.messages),
                        )}
                      </span>
                    </span>
                    <span className="block truncate text-vesti-sm font-sans text-text-tertiary">
                      {previewOf(log.contentMarkdown)}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </section>
        </div>
      </aside>

      {/* Right pane: selected log / weekly report */}
      <main className="min-w-0 flex-1 overflow-y-auto">
        {viewLog || viewWeekly ? (
          <div className="mx-auto max-w-3xl px-6 py-6">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <h2 className="text-vesti-xl font-serif text-text-primary">
                  {viewLog
                    ? viewLog.date
                    : viewWeekly
                      ? formatRange(viewWeekly.rangeStart, viewWeekly.rangeEnd)
                      : ""}
                </h2>
                <p className="mt-1 text-vesti-sm font-sans text-text-tertiary">
                  {viewLog
                    ? `${l("chipCli", "CLI {count}").replace("{count}", String(viewLog.stats.cliSessions))} · ${l("chipBrowser", "Web {count}").replace("{count}", String(viewLog.stats.browserConversations))} · ${l("chipMessages", "{count} msgs").replace("{count}", String(viewLog.stats.messages))}${
                        viewLog.stats.platforms.length > 0
                          ? ` · ${viewLog.stats.platforms.join(" / ")}`
                          : ""
                      }`
                    : l("weeklySubtitle", "Aggregated from the last 7 days of daily logs.")}
                </p>
                {viewLog?.vaultPath ? (
                  <p className="mt-1 text-vesti-sm font-sans text-text-tertiary">
                    {l("vaultSynced", "Saved to vault: {path}").replace(
                      "{path}",
                      viewLog.vaultPath,
                    )}
                  </p>
                ) : null}
              </div>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              {viewLog ? (
                <button
                  type="button"
                  onClick={() => void handleGenerateDates([viewLog.date])}
                  disabled={generating}
                  className="inline-flex items-center gap-1 rounded-md border border-border-subtle px-2.5 py-1 text-vesti-sm font-sans text-text-secondary transition-colors hover:bg-bg-surface-card disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <RefreshCw
                    strokeWidth={1.75}
                    className={`h-3.5 w-3.5 ${generating ? "animate-spin" : ""}`}
                  />
                  {generating ? l("generating", "Generating…") : l("regenerate", "Regenerate")}
                </button>
              ) : null}
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setExportOpen((open) => !open)}
                  disabled={exporting}
                  className="inline-flex items-center gap-1 rounded-md border border-border-subtle px-2.5 py-1 text-vesti-sm font-sans text-text-secondary transition-colors hover:bg-bg-surface-card disabled:opacity-50"
                >
                  <Download strokeWidth={1.75} className="h-3.5 w-3.5" />
                  {exporting ? l("exporting", "Exporting…") : l("export", "Export")}
                  <ChevronDown strokeWidth={1.75} className="h-3 w-3" />
                </button>
                {exportOpen ? (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setExportOpen(false)} />
                    <div className="absolute left-0 z-50 mt-1 min-w-[180px] overflow-hidden rounded-lg border border-border-subtle bg-bg-surface-card py-1 shadow-lg">
                      <button
                        type="button"
                        onClick={handleDownload}
                        className="block w-full px-3 py-2 text-left text-vesti-sm font-sans text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
                      >
                        {l("downloadMarkdown", "Download Markdown")}
                      </button>
                      {viewLog && storage.exportDailyLogMarkdown ? (
                        <button
                          type="button"
                          onClick={() => void handleExportToDirectory()}
                          className="block w-full px-3 py-2 text-left text-vesti-sm font-sans text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
                        >
                          {l("exportMarkdown", "Export .md to folder…")}
                        </button>
                      ) : null}
                    </div>
                  </>
                ) : null}
              </div>
              <SendToMenu
                storage={storage}
                labels={sendToLabels ?? {}}
                payload={
                  viewLog
                    ? { title: `${l("title", "Daily log")} ${viewLog.date}`, markdown: viewLog.contentMarkdown }
                    : viewWeekly
                      ? {
                          title: `${l("weeklyTitle", "Weekly report")} ${formatRange(viewWeekly.rangeStart, viewWeekly.rangeEnd)}`,
                          markdown: viewWeekly.content,
                        }
                      : undefined
                }
              />
            </div>

            <div
              className="prose prose-slate dark:prose-invert mt-4 max-w-none prose-headings:text-text-primary prose-p:leading-relaxed prose-p:text-text-primary prose-li:leading-relaxed prose-li:text-text-primary prose-strong:text-text-primary prose-em:text-text-primary prose-code:text-text-primary prose-a:text-accent-primary prose-blockquote:text-text-secondary"
              dangerouslySetInnerHTML={{ __html: viewHtml }}
            />
          </div>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6">
            <BookText strokeWidth={1.75} className="h-8 w-8 text-text-tertiary" />
            <p className="text-vesti-lg font-serif text-text-primary">
              {l("emptyTitle", "Pick a day or a weekly report")}
            </p>
            <p className="max-w-md text-center text-vesti-base font-sans text-text-tertiary">
              {l(
                "emptyHint",
                "Logs generate automatically every evening; use “Generate now” for today, or review the timeline on the left.",
              )}
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
