"use client";

// 日志 (daily log) pieces of the memory-space overview: a summary card for the
// card grid (today's state + newest logs preview) and the drill-in section
// (recent logs + weekly reports, read-only master-detail). Data rides the same
// StorageApi surface the deposits tab already uses (listDailyLogs /
// listWeeklyReports) — generation stays in the dedicated daily tab.
//
// Rendering reuses the same marked + DOMPurify path as the deposit/daily
// readers.

import { useEffect, useMemo, useState } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { BookText, CalendarDays } from "lucide-react";
import type { DailyLog, StorageApi, WeeklyReport } from "../../types";
import type { MemorySpaceCopy } from "./memorySpaceCopy";
import { MemoryOverviewCard, CollapseChevron } from "./memorySections";

// Fired by the desktop daily service after an auto (re)generation — same event
// the daily tab listens to.
const DAILY_UPDATED_EVENT = "vesti:daily-updated";

/** Plain-text preview of a Markdown body: heading/quote lines skipped (the
 * canonical H1 is just the date — redundant next to the row label), list
 * markers stripped, first meaningful line kept. */
export function previewDailyLog(markdown: string, maxChars = 120): string {
  const line = markdown
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0 && !item.startsWith("#") && !item.startsWith(">"))
    .map((item) => item.replace(/^[-*]\s+/, "").trim())
    .find((item) => item.length > 0);
  if (!line) return "";
  return line.length <= maxChars ? line : `${line.slice(0, maxChars - 1)}…`;
}

/** Today as a local "YYYY-MM-DD" string (same convention as the log rows). */
export function todayLocalDateString(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function formatRange(rangeStart: number, rangeEnd: number): string {
  const start = new Date(rangeStart).toLocaleDateString();
  // rangeEnd is exclusive (next day 00:00); show the last included day.
  const end = new Date(rangeEnd - 1).toLocaleDateString();
  return `${start} ~ ${end}`;
}

/** Stored logs (newest date first) + weekly reports, refreshed on the daily
 * service's update event. Null while loading. */
function useDailyLogs(storage: StorageApi): {
  logs: DailyLog[] | null;
  weekly: WeeklyReport[] | null;
  loadError: string | null;
} {
  const [logs, setLogs] = useState<DailyLog[] | null>(null);
  const [weekly, setWeekly] = useState<WeeklyReport[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!storage.listDailyLogs) {
      setLogs([]);
      setWeekly([]);
      return;
    }
    let cancelled = false;
    const load = async () => {
      const [items, reports] = await Promise.all([
        storage.listDailyLogs?.().catch(() => [] as DailyLog[]) ?? Promise.resolve([]),
        storage.listWeeklyReports?.().catch(() => [] as WeeklyReport[]) ?? Promise.resolve([]),
      ]);
      if (cancelled) return;
      setLogs([...items].sort((a, b) => b.date.localeCompare(a.date)));
      setWeekly([...reports].sort((a, b) => b.rangeEnd - a.rangeEnd));
      setLoadError(null);
    };
    void load().catch((error) => {
      if (!cancelled) setLoadError((error as Error)?.message ?? String(error));
    });
    const onUpdated = () => void load();
    window.addEventListener(DAILY_UPDATED_EVENT, onUpdated);
    return () => {
      cancelled = true;
      window.removeEventListener(DAILY_UPDATED_EVENT, onUpdated);
    };
  }, [storage]);

  return { logs, weekly, loadError };
}

function todayStatusLine(copy: MemorySpaceCopy, logs: DailyLog[] | null) {
  if (logs === null) return null;
  const done = logs.some((log) => log.date === todayLocalDateString());
  return (
    <span className="inline-flex items-center gap-1.5 text-vesti-sm font-sans text-text-secondary">
      <span className={`h-1.5 w-1.5 rounded-full ${done ? "bg-success" : "bg-warning"}`} />
      {done ? copy.todayDone : copy.todayPending}
    </span>
  );
}

/** 日志 summary card for the memory-space overview grid. */
export function DailyLogCard({
  storage,
  copy,
  onOpen,
}: {
  storage: StorageApi;
  copy: MemorySpaceCopy;
  onOpen: () => void;
}) {
  const { logs } = useDailyLogs(storage);
  const previews = useMemo(
    () =>
      (logs ?? [])
        .slice(0, 2)
        .map((log) => `${log.date} · ${previewDailyLog(log.contentMarkdown, 48)}`),
    [logs],
  );
  return (
    <MemoryOverviewCard
      icon={<BookText strokeWidth={1.75} className="h-4 w-4" />}
      title={copy.daily.title}
      count={logs === null ? null : logs.length}
      description={copy.daily.desc}
      previews={previews}
      emptyText={copy.daily.empty}
      statusLine={todayStatusLine(copy, logs)}
      entryCountLabel={(count) => copy.entryCount.replace("{count}", String(count))}
      tip={copy.daily.tip}
      onOpen={onOpen}
    />
  );
}

type Selection = { kind: "daily"; id: number } | { kind: "weekly"; id: number };

/** 日志 drill-in: recent daily logs and weekly reports, read-only. */
export function DailyLogSection({
  storage,
  copy,
}: {
  storage: StorageApi;
  copy: MemorySpaceCopy;
}) {
  const { logs, weekly, loadError } = useDailyLogs(storage);
  const [selection, setSelection] = useState<Selection | null>(null);
  // Weekly reports are a secondary rollup — collapsed by default; the daily
  // timeline above stays directly usable.
  const [weeklyOpen, setWeeklyOpen] = useState(false);

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
        ? (weekly ?? []).find((report) => report.id === selection.id) ?? null
        : null,
    [weekly, selection],
  );

  const viewHtml = useMemo(() => {
    const markdown = viewLog?.contentMarkdown ?? viewWeekly?.content ?? null;
    if (!markdown) return "";
    return DOMPurify.sanitize(
      marked.parse(markdown, { gfm: true, breaks: false }) as string,
    );
  }, [viewLog, viewWeekly]);

  return (
    <div className="flex h-full overflow-hidden bg-bg-app">
      {/* Left column: today state + log timeline + weekly reports */}
      <aside className="flex w-[300px] shrink-0 flex-col border-r border-border-subtle bg-bg-tertiary">
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
          <section className="rounded-lg border border-border-subtle bg-bg-surface-card px-3 py-2.5">
            {todayStatusLine(copy, logs) ?? (
              <span className="text-vesti-sm font-sans text-text-tertiary">…</span>
            )}
          </section>

          <section>
            <h2 className="mb-1.5 px-1 text-vesti-sm font-sans font-medium uppercase tracking-wide text-text-tertiary">
              {copy.daily.title}
            </h2>
            {loadError ? (
              <p className="px-1 py-2 text-vesti-sm font-sans text-danger">{loadError}</p>
            ) : logs === null ? (
              <div className="flex items-center justify-center gap-2 py-6 text-text-secondary">
                <CalendarDays strokeWidth={1.75} className="h-4 w-4 animate-pulse" />
              </div>
            ) : logs.length === 0 ? (
              <p className="px-1 py-2 text-vesti-sm font-sans text-text-tertiary">
                {copy.dailyEmpty}
              </p>
            ) : (
              <div className="space-y-1">
                {logs.map((log) => (
                  <button
                    key={log.id}
                    type="button"
                    onClick={() => setSelection({ kind: "daily", id: log.id })}
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
                        {log.source}
                      </span>
                    </span>
                    <span className="block truncate text-vesti-sm font-sans text-text-tertiary">
                      {previewDailyLog(log.contentMarkdown)}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </section>

          {(weekly ?? []).length > 0 ? (
            <section>
              <button
                type="button"
                aria-expanded={weeklyOpen}
                aria-label={`${weeklyOpen ? copy.collapseSection : copy.expandSection}: ${copy.weeklyTitle}`}
                onClick={() => setWeeklyOpen((open) => !open)}
                className="mb-1.5 flex w-full items-center gap-1.5 px-1 text-left text-vesti-sm font-sans font-medium uppercase tracking-wide text-text-tertiary"
              >
                {copy.weeklyTitle}
                <span className="text-text-tertiary/60">({(weekly ?? []).length})</span>
                <CollapseChevron open={weeklyOpen} className="ml-auto" />
              </button>
              {weeklyOpen ? (
                <div className="space-y-1">
                  {(weekly ?? []).map((report) => (
                    <button
                      key={report.id}
                      type="button"
                      onClick={() => setSelection({ kind: "weekly", id: report.id })}
                      className={`flex w-full flex-col gap-1 rounded-lg border px-3 py-2 text-left transition-colors ${
                        selection?.kind === "weekly" && selection.id === report.id
                          ? "border-accent-primary bg-bg-surface-card-active"
                          : "border-transparent hover:bg-bg-surface-card"
                      }`}
                    >
                      <span className="block truncate text-vesti-base font-sans font-medium text-text-primary">
                        {formatRange(report.rangeStart, report.rangeEnd)}
                      </span>
                      <span className="block truncate text-vesti-sm font-sans text-text-tertiary">
                        {previewDailyLog(report.content, 60)}
                      </span>
                    </button>
                  ))}
                </div>
              ) : null}
            </section>
          ) : null}
        </div>
      </aside>

      {/* Right pane: selected log / weekly report */}
      <main className="min-w-0 flex-1 overflow-y-auto">
        {viewLog || viewWeekly ? (
          <div className="mx-auto max-w-3xl px-6 py-6">
            <h2 className="text-vesti-xl font-serif text-text-primary">
              {viewLog ? viewLog.date : formatRange(viewWeekly!.rangeStart, viewWeekly!.rangeEnd)}
            </h2>
            {viewLog ? (
              <p className="mt-1 text-vesti-sm font-sans text-text-tertiary">
                {`CLI ${viewLog.stats.cliSessions} · Web ${viewLog.stats.browserConversations} · ${viewLog.stats.messages} msgs`}
                {viewLog.stats.platforms.length > 0
                  ? ` · ${viewLog.stats.platforms.join(" / ")}`
                  : ""}
              </p>
            ) : null}
            <div
              className="prose prose-slate dark:prose-invert mt-4 max-w-none prose-headings:text-text-primary prose-p:leading-relaxed prose-p:text-text-primary prose-li:leading-relaxed prose-li:text-text-primary prose-strong:text-text-primary prose-em:text-text-primary prose-code:text-text-primary prose-a:text-accent-primary prose-blockquote:text-text-secondary"
              dangerouslySetInnerHTML={{ __html: viewHtml }}
            />
          </div>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6">
            <BookText strokeWidth={1.75} className="h-8 w-8 text-text-tertiary" />
            <p className="max-w-md text-center text-vesti-base font-sans text-text-tertiary">
              {copy.pickLogHint}
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
