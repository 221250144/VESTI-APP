"use client";

// 记忆空间 dream sections: dream memories (kind 'dream') and dream run logs
// (kind 'dream-log'), listed from the unified memory_entries store through
// StorageApi.listMemoryEntries. Both open entries in a shared Markdown reader
// modal (marked + DOMPurify — the same rendering path as the deposit reader).

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { BookOpen, ChevronRight, CloudMoon, RefreshCw, Sparkles, X } from "lucide-react";
import type { MemoryEntryView, StorageApi } from "../../types";
import type { MemorySpaceCopy } from "./memorySpaceCopy";

export type MemoryLabelFn = (key: string, fallback: string) => string;

interface SectionProps {
  storage: StorageApi;
  l: MemoryLabelFn;
  /** Bumped after a dream run completes, so the sections reload. */
  refreshKey: number;
}

// ---- tags ------------------------------------------------------------------------

const KNOWN_TAGS = ["profile", "preference", "goal", "emotion", "relationship", "event"] as const;
type KnownTag = (typeof KNOWN_TAGS)[number];

const TAG_LABEL_KEYS: Record<KnownTag, string> = {
  profile: "tagProfile",
  preference: "tagPreference",
  goal: "tagGoal",
  emotion: "tagEmotion",
  relationship: "tagRelationship",
  event: "tagEvent",
};

const TAG_FALLBACKS: Record<KnownTag, string> = {
  profile: "Profile",
  preference: "Preference",
  goal: "Goal",
  emotion: "Emotion",
  relationship: "Collaboration",
  event: "Event",
};

// Theme-token dot colors (see tokens.css); unknown tags fall back to neutral.
const TAG_DOT_CLASSES: Record<KnownTag, string> = {
  profile: "bg-kimi-text",
  preference: "bg-success",
  goal: "bg-warning",
  emotion: "bg-danger",
  relationship: "bg-claude-text",
  event: "bg-text-tertiary",
};

function isKnownTag(tag: string): tag is KnownTag {
  return (KNOWN_TAGS as readonly string[]).includes(tag);
}

function tagDotClass(tag: string): string {
  return isKnownTag(tag) ? TAG_DOT_CLASSES[tag] : "bg-text-tertiary";
}

function tagLabel(l: MemoryLabelFn, tag: string): string {
  return isKnownTag(tag) ? l(TAG_LABEL_KEYS[tag], TAG_FALLBACKS[tag]) : tag;
}

// ---- entry helpers -------------------------------------------------------------------

export function entryDateLabel(entry: MemoryEntryView): string {
  return entry.entryDate ?? new Date(entry.updatedAt).toLocaleDateString();
}

/** Card one-liner: the stored summary, else the first plain (non-heading)
 * line of the Markdown body. */
function entrySummaryLine(entry: MemoryEntryView): string {
  const summary = entry.summary?.trim();
  if (summary) return summary;
  for (const line of entry.contentMarkdown.split("\n")) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#")) {
      return trimmed.length > 80 ? `${trimmed.slice(0, 79)}…` : trimmed;
    }
  }
  return "";
}

function renderMarkdown(markdown: string): string {
  return DOMPurify.sanitize(marked.parse(markdown, { gfm: true, breaks: false }) as string);
}

// ---- shared reader modal ----------------------------------------------------------------

/**
 * Full-Markdown reader for one memory entry (backdrop / Esc closes), upgraded
 * to the 陈列/管理 surface: metadata footer (version, updated time, source
 * sessions), inline Markdown editing, and a two-step delete. Mutation IO is
 * injected — the modal stays storage-agnostic.
 */
export function MemoryReaderModal({
  entry,
  onClose,
  l,
  onSave,
  onDelete,
}: {
  entry: MemoryEntryView;
  onClose: () => void;
  l: MemoryLabelFn;
  onSave?: (next: MemoryEntryView) => Promise<void>;
  onDelete?: (id: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState(entry.title);
  const [draftBody, setDraftBody] = useState(entry.contentMarkdown);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const html = useMemo(() => renderMarkdown(entry.contentMarkdown), [entry.contentMarkdown]);
  const sourceIds = entry.sourceSessionIds ?? [];

  const save = async (): Promise<void> => {
    if (!onSave || busy) return;
    setBusy(true);
    setActionError(null);
    try {
      await onSave({
        ...entry,
        title: draftTitle.trim() || entry.title,
        contentMarkdown: draftBody,
        version: entry.version + 1,
        updatedAt: Date.now(),
      });
      onClose();
    } catch (error) {
      setActionError((error as Error)?.message ?? String(error));
      setBusy(false);
    }
  };

  const remove = async (): Promise<void> => {
    if (!onDelete || busy) return;
    if (!confirmingDelete) {
      setConfirmingDelete(true);
      return;
    }
    setBusy(true);
    setActionError(null);
    try {
      await onDelete(entry.id);
      onClose();
    } catch (error) {
      setActionError((error as Error)?.message ?? String(error));
      setBusy(false);
      setConfirmingDelete(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="max-h-full w-full max-w-3xl overflow-y-auto rounded-xl border border-border-subtle bg-bg-app px-6 py-5 shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            {editing ? (
              <input
                value={draftTitle}
                onChange={(event) => setDraftTitle(event.target.value)}
                className="w-full rounded-md border border-border-subtle bg-bg-surface-card px-2.5 py-1.5 text-vesti-xl font-serif text-text-primary focus:border-accent-primary focus:outline-none"
                placeholder={l("untitled", "Untitled")}
              />
            ) : (
              <h2 className="text-vesti-xl font-serif text-text-primary">
                {entry.title || l("untitled", "Untitled")}
              </h2>
            )}
            <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-vesti-sm font-sans text-text-tertiary">
              {entry.tags.map((tag) => (
                <span key={tag} className="inline-flex items-center gap-1">
                  <span className={`h-1.5 w-1.5 rounded-full ${tagDotClass(tag)}`} />
                  {tagLabel(l, tag)}
                </span>
              ))}
              <span>{entryDateLabel(entry)}</span>
              <span>
                v{entry.version}
                {" · "}
                {l("updatedAt", "Updated {date}").replace(
                  "{date}",
                  new Date(entry.updatedAt).toLocaleString(),
                )}
              </span>
            </p>
          </div>
          <button
            type="button"
            aria-label={l("close", "Close")}
            onClick={onClose}
            className="shrink-0 rounded-md p-1.5 text-text-tertiary transition-colors hover:bg-bg-surface-card hover:text-text-secondary"
          >
            <X strokeWidth={1.75} className="h-4 w-4" />
          </button>
        </div>

        {editing ? (
          <textarea
            value={draftBody}
            onChange={(event) => setDraftBody(event.target.value)}
            rows={16}
            className="mt-4 w-full resize-y rounded-md border border-border-subtle bg-bg-surface-card px-3 py-2.5 font-mono text-vesti-sm leading-relaxed text-text-primary focus:border-accent-primary focus:outline-none"
          />
        ) : (
          <div
            className="prose prose-slate dark:prose-invert mt-4 max-w-none prose-headings:text-text-primary prose-p:leading-relaxed prose-p:text-text-primary prose-li:leading-relaxed prose-li:text-text-primary prose-strong:text-text-primary prose-em:text-text-primary prose-code:text-text-primary prose-a:text-accent-primary prose-blockquote:text-text-secondary"
            dangerouslySetInnerHTML={{ __html: html }}
          />
        )}

        {sourceIds.length > 0 ? (
          <div className="mt-4 border-t border-border-subtle pt-3">
            <p className="text-vesti-sm font-sans text-text-tertiary">
              {l("sourceSessions", "Source sessions")}
            </p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {sourceIds.slice(0, 8).map((id) => (
                <span
                  key={id}
                  className="max-w-56 truncate rounded-full bg-bg-surface-card px-2 py-0.5 font-mono text-[11px] text-text-tertiary"
                  title={id}
                >
                  {id}
                </span>
              ))}
              {sourceIds.length > 8 ? (
                <span className="rounded-full bg-bg-surface-card px-2 py-0.5 text-[11px] text-text-tertiary">
                  +{sourceIds.length - 8}
                </span>
              ) : null}
            </div>
          </div>
        ) : null}

        {actionError ? (
          <p role="alert" className="mt-3 text-vesti-sm font-sans text-danger">
            {l("failed", "Failed: {message}").replace("{message}", actionError)}
          </p>
        ) : null}

        {onSave || onDelete ? (
          <div className="mt-4 flex items-center justify-end gap-2 border-t border-border-subtle pt-3">
            {editing ? (
              <>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setEditing(false);
                    setDraftTitle(entry.title);
                    setDraftBody(entry.contentMarkdown);
                  }}
                  className="rounded-md px-3 py-1.5 text-vesti-sm font-sans text-text-secondary transition-colors hover:bg-bg-surface-card"
                >
                  {l("cancel", "Cancel")}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void save()}
                  className="rounded-md bg-accent-primary px-3 py-1.5 text-vesti-sm font-sans font-medium text-text-inverse transition-colors hover:opacity-90 disabled:opacity-50"
                >
                  {busy ? l("saving", "Saving…") : l("save", "Save")}
                </button>
              </>
            ) : (
              <>
                {onSave ? (
                  <button
                    type="button"
                    onClick={() => setEditing(true)}
                    className="rounded-md px-3 py-1.5 text-vesti-sm font-sans text-text-secondary transition-colors hover:bg-bg-surface-card"
                  >
                    {l("edit", "Edit")}
                  </button>
                ) : null}
                {onDelete ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void remove()}
                    className={`rounded-md px-3 py-1.5 text-vesti-sm font-sans transition-colors disabled:opacity-50 ${
                      confirmingDelete
                        ? "bg-danger/10 text-danger"
                        : "text-text-tertiary hover:bg-bg-surface-card hover:text-danger"
                    }`}
                  >
                    {confirmingDelete
                      ? l("memoryDeleteConfirm", "Click again to delete")
                      : l("delete", "Delete")}
                  </button>
                ) : null}
              </>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ---- shared list plumbing -----------------------------------------------------------------

export function useMemoryEntries(
  storage: StorageApi,
  kind: MemoryEntryView["kind"],
  refreshKey: number,
): { entries: MemoryEntryView[] | null; loadError: string | null; reload: () => void } {
  const [entries, setEntries] = useState<MemoryEntryView[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [localTick, setLocalTick] = useState(0);

  useEffect(() => {
    if (!storage.listMemoryEntries) {
      setEntries([]);
      return;
    }
    let cancelled = false;
    void storage
      .listMemoryEntries({ kind, limit: 500 })
      .then((items) => {
        if (cancelled) return;
        setEntries(items);
        setLoadError(null);
      })
      .catch((error) => {
        if (cancelled) return;
        setLoadError((error as Error)?.message ?? String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [storage, kind, refreshKey, localTick]);

  return { entries, loadError, reload: () => setLocalTick((tick) => tick + 1) };
}

function SectionState({
  entries,
  loadError,
  emptyText,
  l,
}: {
  entries: MemoryEntryView[] | null;
  loadError: string | null;
  emptyText: string;
  l: MemoryLabelFn;
}) {
  if (loadError) {
    return (
      <p className="py-8 text-center text-vesti-sm font-sans text-danger">
        {l("failed", "Failed: {message}").replace("{message}", loadError)}
      </p>
    );
  }
  if (entries === null) {
    return (
      <div className="flex items-center justify-center gap-2 py-10 text-text-secondary">
        <RefreshCw strokeWidth={1.75} className="h-4 w-4 animate-spin" />
      </div>
    );
  }
  return (
    <p className="py-10 text-center text-vesti-base font-sans text-text-tertiary">{emptyText}</p>
  );
}

// ---- 记忆 (dream memories) -----------------------------------------------------------------

export function DreamMemorySection({ storage, l, refreshKey }: SectionProps) {
  const { entries, loadError, reload } = useMemoryEntries(storage, "dream", refreshKey);
  const [activeTag, setActiveTag] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [reading, setReading] = useState<MemoryEntryView | null>(null);

  const presentTags = useMemo(
    () => KNOWN_TAGS.filter((tag) => (entries ?? []).some((entry) => entry.tags.includes(tag))),
    [entries],
  );

  const filtered = useMemo(() => {
    const list = entries ?? [];
    const byTag =
      activeTag === "all" ? list : list.filter((entry) => entry.tags.includes(activeTag));
    const q = query.trim().toLowerCase();
    if (!q) return byTag;
    return byTag.filter(
      (entry) =>
        entry.title.toLowerCase().includes(q) ||
        (entry.summary ?? "").toLowerCase().includes(q) ||
        entry.contentMarkdown.toLowerCase().includes(q),
    );
  }, [entries, activeTag, query]);

  const showList = !loadError && entries !== null && filtered.length > 0;

  const saveEntry = async (next: MemoryEntryView): Promise<void> => {
    if (!storage.upsertMemoryEntry) return;
    await storage.upsertMemoryEntry(next);
    reload();
  };

  const deleteEntry = async (id: string): Promise<void> => {
    if (!storage.deleteMemoryEntry) return;
    await storage.deleteMemoryEntry(id);
    reload();
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl px-6 py-5">
        {entries !== null && entries.length > 0 ? (
          <div className="mb-4 flex flex-wrap items-center gap-1">
            <button
              type="button"
              onClick={() => setActiveTag("all")}
              className={`rounded-full px-3 py-1 text-vesti-sm font-sans transition-colors ${
                activeTag === "all"
                  ? "bg-accent-primary-light text-accent-primary"
                  : "text-text-tertiary hover:text-text-secondary"
              }`}
            >
              {l("tagAll", "All")}
            </button>
            {presentTags.map((tag) => (
              <button
                key={tag}
                type="button"
                onClick={() => setActiveTag(tag)}
                className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-vesti-sm font-sans transition-colors ${
                  activeTag === tag
                    ? "bg-accent-primary-light text-accent-primary"
                    : "text-text-tertiary hover:text-text-secondary"
                }`}
              >
                <span className={`h-1.5 w-1.5 rounded-full ${TAG_DOT_CLASSES[tag]}`} />
                {tagLabel(l, tag)}
              </button>
            ))}
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={l("memorySearch", "Search memories…")}
              className="ml-auto w-48 rounded-full border border-border-subtle bg-bg-surface-card px-3 py-1 text-vesti-sm font-sans text-text-primary placeholder:text-text-tertiary focus:border-accent-primary focus:outline-none"
            />
          </div>
        ) : null}

        {showList ? (
          <div className="space-y-6">
            {(activeTag === "all" ? presentTags : [activeTag]).map((tag) => {
              const group =
                tag === "all"
                  ? filtered
                  : filtered.filter((entry) => entry.tags.includes(tag));
              if (group.length === 0) return null;
              return (
                <section key={tag}>
                  {activeTag === "all" ? (
                    <h3 className="mb-2 flex items-center gap-1.5 text-vesti-sm font-sans font-medium uppercase tracking-wide text-text-tertiary">
                      <span className={`h-1.5 w-1.5 rounded-full ${tagDotClass(tag)}`} />
                      {tag === "all" ? l("tagAll", "All") : tagLabel(l, tag)}
                      <span className="text-text-tertiary/60">({group.length})</span>
                    </h3>
                  ) : null}
                  <div className="grid grid-cols-1 gap-2 xl:grid-cols-2">
                    {group.map((entry) => {
                      const primaryTag = entry.tags[0] ?? "";
                      const summary = entrySummaryLine(entry);
                      return (
                        <button
                          key={entry.id}
                          type="button"
                          onClick={() => setReading(entry)}
                          className="flex items-start gap-2.5 rounded-lg border border-border-subtle bg-bg-surface-card px-3 py-2.5 text-left transition-colors hover:bg-bg-surface-card-hover"
                        >
                          <span
                            className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${tagDotClass(primaryTag)}`}
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-vesti-base font-sans font-medium text-text-primary">
                              {entry.title || l("untitled", "Untitled")}
                            </span>
                            {summary ? (
                              <span className="mt-0.5 block truncate text-vesti-sm font-sans text-text-tertiary">
                                {summary}
                              </span>
                            ) : null}
                            <span className="mt-1 block text-vesti-sm font-sans text-text-tertiary">
                              {tagLabel(l, primaryTag)}
                              {" · "}
                              {entryDateLabel(entry)}
                            </span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </section>
              );
            })}
          </div>
        ) : (
          <SectionState
            entries={entries}
            loadError={loadError}
            emptyText={
              query.trim()
                ? l("memorySearchEmpty", "No memories match this search.")
                : activeTag === "all"
                  ? l("memoryEmpty", "No memories yet — sleep on it and have a dream.")
                  : l("memoryTagEmpty", "No memories under this tag yet.")
            }
            l={l}
          />
        )}
      </div>
      {reading ? (
        <MemoryReaderModal
          entry={reading}
          onClose={() => setReading(null)}
          l={l}
          onSave={storage.upsertMemoryEntry ? saveEntry : undefined}
          onDelete={storage.deleteMemoryEntry ? deleteEntry : undefined}
        />
      ) : null}
    </div>
  );
}

// ---- 梦境日志 (dream run logs) --------------------------------------------------------------

export function DreamLogSection({ storage, l, refreshKey }: SectionProps) {
  const { entries, loadError, reload } = useMemoryEntries(storage, "dream-log", refreshKey);
  const [reading, setReading] = useState<MemoryEntryView | null>(null);

  const deleteEntry = async (id: string): Promise<void> => {
    if (!storage.deleteMemoryEntry) return;
    await storage.deleteMemoryEntry(id);
    reload();
  };

  const sorted = useMemo(
    () =>
      [...(entries ?? [])].sort(
        (a, b) =>
          (b.entryDate ?? "").localeCompare(a.entryDate ?? "") || b.updatedAt - a.updatedAt,
      ),
    [entries],
  );

  const owlEntries = useMemo(
    () => sorted.filter((entry) => entry.tags.includes("owl-diary")),
    [sorted],
  );
  const plainLogs = useMemo(
    () => sorted.filter((entry) => !entry.tags.includes("owl-diary")),
    [sorted],
  );

  const showList = !loadError && entries !== null && sorted.length > 0;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-6 py-5">
        {showList ? (
          <div className="space-y-5">
            {owlEntries.length > 0 ? (
              <section>
                <h3 className="mb-2 flex items-center gap-1.5 text-vesti-sm font-sans font-medium uppercase tracking-wide text-text-tertiary">
                  <BookOpen strokeWidth={1.75} className="h-3.5 w-3.5" />
                  {l("owlDiaryTitle", "Owl diary")}
                </h3>
                <div className="space-y-1.5">
                  {owlEntries.map((entry) => (
                    <button
                      key={entry.id}
                      type="button"
                      onClick={() => setReading(entry)}
                      className="flex w-full items-start gap-2.5 rounded-lg border border-border-subtle bg-bg-surface-card px-3 py-2.5 text-left transition-colors hover:bg-bg-surface-card-hover"
                    >
                      <BookOpen
                        strokeWidth={1.75}
                        className="mt-0.5 h-4 w-4 shrink-0 text-text-tertiary"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-vesti-base font-sans font-medium text-text-primary">
                          {entry.title || l("untitled", "Untitled")}
                        </span>
                        {entry.summary ? (
                          <span className="mt-0.5 block truncate text-vesti-sm font-sans text-text-tertiary">
                            {entry.summary}
                          </span>
                        ) : null}
                        <span className="mt-1 block text-vesti-sm font-sans text-text-tertiary">
                          {entryDateLabel(entry)}
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              </section>
            ) : null}
            {plainLogs.length > 0 ? (
              <section>
                <h3 className="mb-2 flex items-center gap-1.5 text-vesti-sm font-sans font-medium uppercase tracking-wide text-text-tertiary">
                  <CloudMoon strokeWidth={1.75} className="h-3.5 w-3.5" />
                  {l("dreamLogTitle", "Dream logs")}
                </h3>
                <div className="space-y-1.5">
                  {plainLogs.map((entry) => (
                    <button
                      key={entry.id}
                      type="button"
                      onClick={() => setReading(entry)}
                      className="flex w-full items-start gap-2.5 rounded-lg border border-border-subtle bg-bg-surface-card px-3 py-2.5 text-left transition-colors hover:bg-bg-surface-card-hover"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-vesti-base font-sans font-medium text-text-primary">
                          {entry.title || l("untitled", "Untitled")}
                        </span>
                        {entry.summary ? (
                          <span className="mt-0.5 block truncate text-vesti-sm font-sans text-text-tertiary">
                            {entry.summary}
                          </span>
                        ) : null}
                        <span className="mt-1 block text-vesti-sm font-sans text-text-tertiary">
                          {entryDateLabel(entry)}
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              </section>
            ) : null}
          </div>
        ) : (
          <SectionState
            entries={entries}
            loadError={loadError}
            emptyText={l(
              "dreamLogEmpty",
              "No dream logs yet — run a dream and one will be left here.",
            )}
            l={l}
          />
        )}
      </div>
      {reading ? (
        <MemoryReaderModal
          entry={reading}
          onClose={() => setReading(null)}
          l={l}
          onDelete={storage.deleteMemoryEntry ? deleteEntry : undefined}
        />
      ) : null}
    </div>
  );
}

// ---- 总览卡片 (memory-space overview) --------------------------------------------------------
//
// The tab's default view is a single page of summary cards — one per memory
// kind — instead of the old always-expanded sections. Each card shows a count
// plus a 1-2 line preview of the newest entries; clicking drills into the
// full section.

/** Presentational summary card: icon + title + count badge, one-line
 * description, then 1-2 preview lines (or the empty hint). */
export function MemoryOverviewCard({
  icon,
  title,
  count,
  description,
  previews,
  emptyText,
  statusLine,
  entryCountLabel,
  onOpen,
}: {
  icon: ReactNode;
  title: string;
  /** null while the underlying list is still loading. */
  count: number | null;
  description: string;
  previews: string[];
  emptyText: string;
  /** Optional status row above the previews (e.g. the daily card's today state). */
  statusLine?: ReactNode;
  entryCountLabel: (count: number) => string;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex flex-col rounded-xl border border-border-subtle bg-bg-surface-card p-4 text-left transition-colors hover:border-accent-primary/40 hover:bg-bg-surface-card-hover"
    >
      <span className="flex items-center gap-2">
        <span className="shrink-0 text-text-secondary transition-colors group-hover:text-accent-primary">
          {icon}
        </span>
        <span className="min-w-0 flex-1 truncate text-vesti-base font-sans font-medium text-text-primary">
          {title}
        </span>
        {count !== null ? (
          <span className="shrink-0 rounded-full bg-bg-tertiary px-2 py-0.5 text-vesti-sm font-sans text-text-tertiary">
            {entryCountLabel(count)}
          </span>
        ) : (
          <RefreshCw strokeWidth={1.75} className="h-3.5 w-3.5 shrink-0 animate-spin text-text-tertiary" />
        )}
        <ChevronRight
          strokeWidth={1.75}
          className="h-4 w-4 shrink-0 text-text-tertiary opacity-0 transition-opacity group-hover:opacity-100"
        />
      </span>
      <span className="mt-1 block text-vesti-sm font-sans text-text-tertiary">{description}</span>
      {statusLine ? <span className="mt-2 block">{statusLine}</span> : null}
      <span className="mt-2.5 block space-y-1 border-t border-border-subtle pt-2.5">
        {previews.length > 0 ? (
          previews.map((line, index) => (
            <span key={index} className="block truncate text-vesti-sm font-sans text-text-secondary">
              {line}
            </span>
          ))
        ) : (
          <span className="block truncate text-vesti-sm font-sans text-text-tertiary">
            {emptyText}
          </span>
        )}
      </span>
    </button>
  );
}

function entryPreviewLine(entry: MemoryEntryView, l: MemoryLabelFn): string {
  return `${entry.title || l("untitled", "Untitled")} · ${entryDateLabel(entry)}`;
}

/** 记忆 (dream memories) summary card. */
export function DreamMemoryCard({
  storage,
  l,
  refreshKey,
  copy,
  onOpen,
}: SectionProps & { copy: MemorySpaceCopy; onOpen: () => void }) {
  const { entries } = useMemoryEntries(storage, "dream", refreshKey);
  const latest = useMemo(
    () => [...(entries ?? [])].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 2),
    [entries],
  );
  return (
    <MemoryOverviewCard
      icon={<Sparkles strokeWidth={1.75} className="h-4 w-4" />}
      title={copy.memories.title}
      count={entries === null ? null : entries.length}
      description={copy.memories.desc}
      previews={latest.map((entry) => entryPreviewLine(entry, l))}
      emptyText={copy.memories.empty}
      entryCountLabel={(count) =>
        copy.entryCount.replace("{count}", String(count))
      }
      onOpen={onOpen}
    />
  );
}

/** 梦境 (dream run logs + owl diary) summary card. */
export function DreamLogCard({
  storage,
  l,
  refreshKey,
  copy,
  onOpen,
}: SectionProps & { copy: MemorySpaceCopy; onOpen: () => void }) {
  const { entries } = useMemoryEntries(storage, "dream-log", refreshKey);
  const latest = useMemo(
    () =>
      [...(entries ?? [])]
        .sort(
          (a, b) =>
            (b.entryDate ?? "").localeCompare(a.entryDate ?? "") || b.updatedAt - a.updatedAt,
        )
        .slice(0, 2),
    [entries],
  );
  return (
    <MemoryOverviewCard
      icon={<CloudMoon strokeWidth={1.75} className="h-4 w-4" />}
      title={copy.dreams.title}
      count={entries === null ? null : entries.length}
      description={copy.dreams.desc}
      previews={latest.map((entry) => entryPreviewLine(entry, l))}
      emptyText={copy.dreams.empty}
      entryCountLabel={(count) =>
        copy.entryCount.replace("{count}", String(count))
      }
      onOpen={onOpen}
    />
  );
}
