// Daily journal → Obsidian vault: every generated daily log also lands as a
// long-lived Markdown note under `journal/YYYY/YYYY-MM-DD.md`, plus a monthly
// index `journal/YYYY/YYYY-MM.md` linking the month's days. Both documents
// carry a stable frontmatter uuid, so regenerating a day (or re-indexing a
// month) overwrites the same note in place via the upstream writer's
// uuid-matching idempotence — no duplicate " (2)" files, no main-process
// changes. Vault failures are best-effort: generation itself never fails
// because the vault was unreachable.

import type { DailyLog } from "../db/types";
import type { DailyLocale } from "./dailyActivity";
import { getConfiguredObsidianVault } from "../upstream/obsidianExport";

/** Stable document ids — the vault writer matches on these to update in
 * place across regenerations. */
export function journalDayUuid(date: string): string {
  return `vesti-daily-${date}`;
}

export function journalIndexUuid(month: string): string {
  return `vesti-daily-index-${month}`;
}

/** `journal/2026/2026-07-18.md` */
export function journalDayRelativePath(date: string): string {
  const year = date.slice(0, 4);
  return `journal/${year}/${date}.md`;
}

/** `journal/2026/2026-07.md` */
export function journalIndexRelativePath(date: string): string {
  const year = date.slice(0, 4);
  const month = date.slice(0, 7);
  return `journal/${year}/${month}.md`;
}

/** The day's vault document: frontmatter identity + the log body. */
export function buildJournalDayDocument(log: {
  date: string;
  contentMarkdown: string;
  source: "auto" | "manual";
}): string {
  return [
    "---",
    `uuid: "${journalDayUuid(log.date)}"`,
    `date: ${log.date}`,
    "source: vesti-daily",
    "---",
    "",
    log.contentMarkdown.trim(),
    "",
  ].join("\n");
}

/** Month index document: a linked list of the month's day notes, newest
 * first. `dates` holds every logged day of the month ("YYYY-MM-DD"). */
export function buildJournalMonthIndexDocument(
  month: string,
  dates: string[],
  locale: DailyLocale = "zh"
): string {
  const year = month.slice(0, 4);
  const title =
    locale === "en" ? `# ${month} Work journal index` : `# ${month} 工作日志索引`;
  const sorted = [...dates].sort().reverse();
  const lines = sorted.map(
    (date) => `- [[journal/${year}/${date}|${date}]]`
  );
  return [
    "---",
    `uuid: "${journalIndexUuid(month)}"`,
    `month: ${month}`,
    "source: vesti-daily",
    "---",
    "",
    title,
    "",
    ...(lines.length > 0 ? lines : [locale === "en" ? "No entries yet." : "本月还没有日志。"]),
    "",
  ].join("\n");
}

/**
 * Write (or in-place update) the day's journal note and refresh the month
 * index. Resolves null when no Obsidian vault is configured — the journal
 * feature is simply off then. Throws the underlying error otherwise; the
 * caller (dailyService) treats it as best-effort.
 */
export async function exportDailyJournalToVault(input: {
  log: DailyLog;
  /** All logged dates of the log's month (for the index). */
  monthDates: string[];
  locale: DailyLocale;
}): Promise<{ relativePath: string } | null> {
  const settings = await window.vesti.getSettings().catch(() => null);
  if (!settings?.upstream.obsidianVaultPath.trim()) return null;
  const { vaultPath } = await getConfiguredObsidianVault();
  const api = window.vesti;

  const dayResult = await api.writeUpstreamFile({
    rootPath: vaultPath,
    relativePath: journalDayRelativePath(input.log.date),
    content: buildJournalDayDocument(input.log),
    expectedUuid: journalDayUuid(input.log.date),
  });

  const dates = input.monthDates.includes(input.log.date)
    ? input.monthDates
    : [...input.monthDates, input.log.date];
  await api
    .writeUpstreamFile({
      rootPath: vaultPath,
      relativePath: journalIndexRelativePath(input.log.date),
      content: buildJournalMonthIndexDocument(input.log.date.slice(0, 7), dates, input.locale),
      expectedUuid: journalIndexUuid(input.log.date.slice(0, 7)),
    })
    .catch(() => undefined); // the index is a convenience; the day note is the record

  return { relativePath: dayResult.relativePath };
}
