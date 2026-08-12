"use client";

// 记忆空间 dream sections: dream memories (kind 'dream') and dream run logs
// (kind 'dream-log'), listed from the unified memory_entries store through
// StorageApi.listMemoryEntries. Both open entries in a shared Markdown reader
// modal (marked + DOMPurify — the same rendering path as the deposit reader).

import { useEffect, useMemo, useState } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { RefreshCw, X } from "lucide-react";
import type { MemoryEntryView, StorageApi } from "../../types";

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

function entryDateLabel(entry: MemoryEntryView): string {
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

/** Full-Markdown reader for one memory entry (backdrop / Esc closes). */
export function MemoryReaderModal({
  entry,
  onClose,
  l,
}: {
  entry: MemoryEntryView;
  onClose: () => void;
  l: MemoryLabelFn;
}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const html = useMemo(() => renderMarkdown(entry.contentMarkdown), [entry.contentMarkdown]);

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
          <div className="min-w-0">
            <h2 className="text-vesti-xl font-serif text-text-primary">
              {entry.title || l("untitled", "Untitled")}
            </h2>
            <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-vesti-sm font-sans text-text-tertiary">
              {entry.tags.map((tag) => (
                <span key={tag} className="inline-flex items-center gap-1">
                  <span className={`h-1.5 w-1.5 rounded-full ${tagDotClass(tag)}`} />
                  {tagLabel(l, tag)}
                </span>
              ))}
              <span>{entryDateLabel(entry)}</span>
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
        <div
          className="prose prose-slate dark:prose-invert mt-4 max-w-none prose-headings:text-text-primary prose-p:leading-relaxed prose-p:text-text-primary prose-li:leading-relaxed prose-li:text-text-primary prose-strong:text-text-primary prose-em:text-text-primary prose-code:text-text-primary prose-a:text-accent-primary prose-blockquote:text-text-secondary"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </div>
    </div>
  );
}

// ---- shared list plumbing -----------------------------------------------------------------

function useMemoryEntries(
  storage: StorageApi,
  kind: MemoryEntryView["kind"],
  refreshKey: number,
): { entries: MemoryEntryView[] | null; loadError: string | null } {
  const [entries, setEntries] = useState<MemoryEntryView[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

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
  }, [storage, kind, refreshKey]);

  return { entries, loadError };
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
  const { entries, loadError } = useMemoryEntries(storage, "dream", refreshKey);
  const [activeTag, setActiveTag] = useState<string>("all");
  const [reading, setReading] = useState<MemoryEntryView | null>(null);

  const presentTags = useMemo(
    () => KNOWN_TAGS.filter((tag) => (entries ?? []).some((entry) => entry.tags.includes(tag))),
    [entries],
  );

  const filtered = useMemo(() => {
    const list = entries ?? [];
    return activeTag === "all"
      ? list
      : list.filter((entry) => entry.tags.includes(activeTag));
  }, [entries, activeTag]);

  const showList = !loadError && entries !== null && filtered.length > 0;

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
          </div>
        ) : null}

        {showList ? (
          <div className="grid grid-cols-1 gap-2 xl:grid-cols-2">
            {filtered.map((entry) => {
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
        ) : (
          <SectionState
            entries={entries}
            loadError={loadError}
            emptyText={
              activeTag === "all"
                ? l("memoryEmpty", "No memories yet — sleep on it and have a dream.")
                : l("memoryTagEmpty", "No memories under this tag yet.")
            }
            l={l}
          />
        )}
      </div>
      {reading ? (
        <MemoryReaderModal entry={reading} onClose={() => setReading(null)} l={l} />
      ) : null}
    </div>
  );
}

// ---- 梦境日志 (dream run logs) --------------------------------------------------------------

export function DreamLogSection({ storage, l, refreshKey }: SectionProps) {
  const { entries, loadError } = useMemoryEntries(storage, "dream-log", refreshKey);
  const [reading, setReading] = useState<MemoryEntryView | null>(null);

  const sorted = useMemo(
    () =>
      [...(entries ?? [])].sort(
        (a, b) =>
          (b.entryDate ?? "").localeCompare(a.entryDate ?? "") || b.updatedAt - a.updatedAt,
      ),
    [entries],
  );

  const showList = !loadError && entries !== null && sorted.length > 0;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-6 py-5">
        {showList ? (
          <div className="space-y-1.5">
            {sorted.map((entry) => (
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
        <MemoryReaderModal entry={reading} onClose={() => setReading(null)} l={l} />
      ) : null}
    </div>
  );
}
