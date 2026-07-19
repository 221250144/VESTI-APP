// Organizer assistant panel (P2b) — local rule-engine cleanup actions over the
// library: empty-conversation cleanup, cross-source duplicate merge, batch
// tagging, batch archive-to-topic. Flow: pick an action → preview the affected
// set → confirm → result feedback. All mutations go through StorageApi methods
// (soft trash / bulk tag / per-conversation topic move) that the capture
// re-sync merge preserves.

import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Archive,
  ChevronLeft,
  Copy,
  RefreshCw,
  Sparkles,
  Tag,
  Trash2,
  X,
} from "lucide-react";
import type { Conversation, StorageApi, Topic } from "../../types";
import type {
  ConversationTreeLookup,
  SourceSelection,
} from "./sourceTree";
import { filterConversationsBySelection } from "./sourceTree";
import {
  buildArchivePlan,
  buildBatchTagPlan,
  filterOlderThan,
  findDuplicateGroups,
  findEmptyConversations,
  type OrganizerConversation,
} from "./organizeRules";

type OrganizeAction = "empty" | "duplicates" | "tag" | "archive";
type ArchiveScope = "selection" | "older30" | "older90";
type Phase = "actions" | "preview" | "running" | "done" | "error";

const DAY_MS = 24 * 60 * 60 * 1000;
const SAMPLE_LIMIT = 8;

type OrganizePanelProps = {
  open: boolean;
  onClose: () => void;
  storage: StorageApi;
  conversations: Conversation[];
  topics: Topic[];
  /** Current source-tree selection, offered as the default scope for the
   * batch tag / archive actions. */
  sourceSelection: SourceSelection | null;
  selectionLabel?: string;
  treeLookup: ConversationTreeLookup;
  /** labels.organize group (Record<string,string>); English fallbacks inline. */
  labels: Record<string, string>;
  onApplied: () => void | Promise<void>;
};

type FlatTopic = { id: number; name: string; depth: number };

function flattenTopics(topics: Topic[], depth = 0): FlatTopic[] {
  return topics.flatMap((topic) => [
    { id: topic.id, name: topic.name, depth },
    ...flattenTopics(topic.children ?? [], depth + 1),
  ]);
}

export function OrganizePanel({
  open,
  onClose,
  storage,
  conversations,
  topics,
  sourceSelection,
  selectionLabel,
  treeLookup,
  labels,
  onApplied,
}: OrganizePanelProps) {
  const l = (key: string, fallback: string) => labels[key] ?? fallback;
  const [action, setAction] = useState<OrganizeAction | null>(null);
  const [phase, setPhase] = useState<Phase>("actions");
  const [tagInput, setTagInput] = useState("");
  const [archiveScope, setArchiveScope] = useState<ArchiveScope>("selection");
  const [archiveTopicId, setArchiveTopicId] = useState<number | null>(null);
  const [resultCount, setResultCount] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const organizerConversations = conversations as OrganizerConversation[];
  const flatTopics = useMemo(() => flattenTopics(topics), [topics]);

  const canTrash = Boolean(storage.trashConversations);
  const canTag = Boolean(storage.bulkAddTag ?? storage.updateConversation);
  const canArchive = Boolean(storage.updateConversation);

  // Reset the wizard whenever the panel is (re)opened.
  useEffect(() => {
    if (!open) return;
    setAction(null);
    setPhase("actions");
    setTagInput("");
    setArchiveScope("selection");
    setArchiveTopicId(null);
    setResultCount(0);
    setErrorMessage(null);
  }, [open]);

  // Esc closes (same idiom as the annotation surface in library-tab).
  useEffect(() => {
    if (!open) return;
    const handleKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  const selectionScoped = useMemo(
    () =>
      sourceSelection
        ? filterConversationsBySelection(
            organizerConversations,
            sourceSelection,
            treeLookup,
            topics,
          )
        : organizerConversations,
    [conversations, sourceSelection, treeLookup, topics], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // ---- Preview computation ---------------------------------------------------
  type PreviewState = {
    count: number;
    samples: string[];
    ids: number[];
    ready: boolean;
    groups?: ReturnType<typeof findDuplicateGroups>;
    plan?: ReturnType<typeof buildBatchTagPlan> | ReturnType<typeof buildArchivePlan>;
  };

  const preview = useMemo<PreviewState | null>(() => {
    if (!action) return null;
    if (action === "empty") {
      const items = findEmptyConversations(organizerConversations);
      return {
        count: items.length,
        samples: items.map((item) => item.title),
        ids: items.map((item) => item.id),
        ready: true,
      };
    }
    if (action === "duplicates") {
      const groups = findDuplicateGroups(organizerConversations);
      return {
        count: groups.reduce((sum, group) => sum + group.duplicateIds.length, 0),
        groups,
        samples: groups.map(
          (group) => group.conversations[0]?.title ?? group.key,
        ),
        ids: groups.flatMap((group) => group.duplicateIds),
        ready: true,
      };
    }
    if (action === "tag") {
      const plan = buildBatchTagPlan(selectionScoped, tagInput);
      return {
        count: plan.length,
        samples: plan.map((change) => change.title),
        ids: plan.map((change) => change.id),
        plan,
        ready: tagInput.trim().length > 0,
      };
    }
    // archive
    const scoped =
      archiveScope === "selection"
        ? selectionScoped
        : filterOlderThan(
            organizerConversations,
            Date.now() - (archiveScope === "older30" ? 30 : 90) * DAY_MS,
          );
    const plan = buildArchivePlan(scoped, archiveTopicId);
    return {
      count: plan.length,
      samples: plan.map((change) => change.title),
      ids: plan.map((change) => change.id),
      plan,
      ready: true,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [action, tagInput, archiveScope, archiveTopicId, selectionScoped, conversations]);

  if (!open) return null;

  const startAction = (next: OrganizeAction) => {
    setAction(next);
    setPhase("preview");
    setErrorMessage(null);
  };

  const execute = async () => {
    if (!action || !preview || !preview.ready) return;
    setPhase("running");
    try {
      let updated = 0;
      if (action === "empty" || action === "duplicates") {
        if (!storage.trashConversations) throw new Error("unavailable");
        updated = await storage.trashConversations(preview.ids);
      } else if (action === "tag") {
        const tag = tagInput.trim();
        if (storage.bulkAddTag) {
          updated = await storage.bulkAddTag(preview.ids, tag);
        } else if (storage.updateConversation) {
          const plan = preview.plan as ReturnType<typeof buildBatchTagPlan>;
          for (const change of plan) {
            const result = await storage.updateConversation(change.id, {
              tags: change.nextTags,
            });
            if (result.updated) updated += 1;
          }
        }
      } else {
        if (!storage.updateConversation) throw new Error("unavailable");
        const plan = preview.plan as ReturnType<typeof buildArchivePlan>;
        for (const change of plan) {
          const result = await storage.updateConversation(change.id, {
            topic_id: change.toTopicId,
          });
          if (result.updated) updated += 1;
        }
      }
      setResultCount(updated);
      await onApplied();
      setPhase("done");
    } catch (error) {
      setErrorMessage((error as Error)?.message ?? String(error));
      setPhase("error");
    }
  };

  const actionCards: Array<{
    key: OrganizeAction;
    icon: ReactNode;
    name: string;
    desc: string;
    enabled: boolean;
  }> = [
    {
      key: "empty",
      icon: <Trash2 strokeWidth={1.75} className="h-4 w-4" />,
      name: l("actionEmpty", "Clean empty conversations"),
      desc: l("actionEmptyDesc", "Trash conversations with no captured messages."),
      enabled: canTrash,
    },
    {
      key: "duplicates",
      icon: <Copy strokeWidth={1.75} className="h-4 w-4" />,
      name: l("actionDuplicates", "Merge duplicate candidates"),
      desc: l(
        "actionDuplicatesDesc",
        "Find cross-source duplicates; keep the most complete copy.",
      ),
      enabled: canTrash,
    },
    {
      key: "tag",
      icon: <Tag strokeWidth={1.75} className="h-4 w-4" />,
      name: l("actionTag", "Batch tag"),
      desc: l("actionTagDesc", "Add a tag to every conversation in a scope."),
      enabled: canTag,
    },
    {
      key: "archive",
      icon: <Archive strokeWidth={1.75} className="h-4 w-4" />,
      name: l("actionArchive", "Batch archive to topic"),
      desc: l(
        "actionArchiveDesc",
        "Move conversations in a project or time window into a topic.",
      ),
      enabled: canArchive,
    },
  ];

  const sampleList = preview?.samples.slice(0, SAMPLE_LIMIT) ?? [];
  const moreCount = Math.max(0, (preview?.samples.length ?? 0) - SAMPLE_LIMIT);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        type="button"
        onClick={onClose}
        className="absolute inset-0 bg-black/25"
        aria-label={l("close", "Close")}
      />
      <div
        role="dialog"
        aria-label={l("title", "Organize library")}
        className="relative flex max-h-[80vh] w-full max-w-lg flex-col rounded-xl border border-border-subtle bg-bg-primary p-4 shadow-[0_16px_48px_rgba(0,0,0,0.18)]"
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3 pb-3">
          <div className="flex items-center gap-2">
            <Sparkles
              strokeWidth={1.75}
              className="h-4 w-4 text-text-secondary"
            />
            <div>
              <h2 className="text-vesti-lg font-serif text-text-primary">
                {l("title", "Organize library")}
              </h2>
              <p className="text-vesti-sm font-sans text-text-tertiary">
                {l("subtitle", "Local rules only — nothing leaves this device.")}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={l("close", "Close")}
            className="flex h-6 w-6 items-center justify-center rounded-md text-text-tertiary transition-colors hover:bg-bg-surface-card hover:text-text-secondary"
          >
            <X strokeWidth={1.75} className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {phase === "actions" ? (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {actionCards.map((card) => (
                <button
                  key={card.key}
                  type="button"
                  disabled={!card.enabled}
                  onClick={() => startAction(card.key)}
                  title={card.enabled ? undefined : l("unavailable", "Not available in this build.")}
                  className={`flex items-start gap-2 rounded-lg border border-border-subtle p-3 text-left transition-colors ${
                    card.enabled
                      ? "hover:bg-bg-surface-card"
                      : "cursor-not-allowed opacity-50"
                  }`}
                >
                  <span className="mt-0.5 text-text-secondary">{card.icon}</span>
                  <span>
                    <span className="block text-vesti-base font-sans font-medium text-text-primary">
                      {card.name}
                    </span>
                    <span className="mt-0.5 block text-vesti-sm font-sans text-text-tertiary">
                      {card.desc}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          ) : null}

          {phase === "preview" && preview ? (
              <div className="flex flex-col gap-3">
              <button
                type="button"
                onClick={() => setPhase("actions")}
                className="inline-flex w-fit items-center gap-1 rounded-md px-1 py-0.5 text-vesti-sm font-sans text-text-tertiary transition-colors hover:text-text-secondary"
              >
                <ChevronLeft strokeWidth={1.75} className="h-3.5 w-3.5" />
                {l("back", "Back")}
              </button>

              <p className="text-vesti-base font-sans text-text-primary">
                {l("previewAffected", "{count} conversations affected").replace(
                  "{count}",
                  String(preview.count),
                )}
              </p>

              {action === "tag" ? (
                <div className="flex flex-col gap-1">
                  <label className="text-vesti-sm font-sans text-text-secondary">
                    {l("tagLabel", "Tag to add")}
                    {sourceSelection
                      ? ` · ${l("scopeSelection", "Scope: current selection")}${selectionLabel ? ` (${selectionLabel})` : ""}`
                      : ` · ${l("scopeAll", "Scope: all conversations")}`}
                  </label>
                  <input
                    value={tagInput}
                    onChange={(event) => setTagInput(event.target.value)}
                    placeholder={l("tagPlaceholder", "e.g. paper-reading")}
                    className="w-full rounded-md border border-border-subtle bg-bg-primary px-3 py-2 text-vesti-base font-sans text-text-primary outline-none focus:border-border-focus"
                  />
                </div>
              ) : null}

              {action === "archive" ? (
                <div className="flex flex-col gap-2">
                  <label className="text-vesti-sm font-sans text-text-secondary">
                    {l("archiveTarget", "Move into topic")}
                  </label>
                  <select
                    value={archiveTopicId === null ? "" : String(archiveTopicId)}
                    onChange={(event) =>
                      setArchiveTopicId(
                        event.target.value === ""
                          ? null
                          : Number(event.target.value),
                      )
                    }
                    className="w-full rounded-md border border-border-subtle bg-bg-primary px-3 py-2 text-vesti-base font-sans text-text-primary outline-none focus:border-border-focus"
                  >
                    <option value="">{l("archiveNoTopic", "No topic")}</option>
                    {flatTopics.map((topic) => (
                      <option key={topic.id} value={topic.id}>
                        {"\u00A0".repeat(topic.depth * 2)}
                        {topic.name}
                      </option>
                    ))}
                  </select>
                  <div className="flex flex-wrap gap-1.5">
                    {(
                      [
                        ["selection", sourceSelection ? `${l("scopeSelection", "Scope: current selection")}${selectionLabel ? ` (${selectionLabel})` : ""}` : null],
                        ["older30", l("scopeOlder30", "Inactive 30+ days")],
                        ["older90", l("scopeOlder90", "Inactive 90+ days")],
                      ] as Array<[ArchiveScope, string | null]>
                    )
                      .filter((entry): entry is [ArchiveScope, string] => entry[1] !== null)
                      .map(([scope, label]) => (
                        <button
                          key={scope}
                          type="button"
                          onClick={() => setArchiveScope(scope)}
                          className={`rounded-full px-2.5 py-1 text-vesti-sm font-sans transition-colors ${
                            archiveScope === scope
                              ? "bg-accent-primary-light text-accent-primary"
                              : "bg-bg-surface-card text-text-secondary hover:bg-bg-surface-card-hover"
                          }`}
                        >
                          {label}
                        </button>
                      ))}
                  </div>
                </div>
              ) : null}

              {preview.count === 0 ? (
                <p className="py-4 text-center text-vesti-base font-sans text-text-tertiary">
                  {l("previewEmpty", "Nothing matches this rule right now.")}
                </p>
              ) : (
                <div className="max-h-48 overflow-y-auto rounded-md border border-border-subtle">
                  {action === "duplicates" && preview.groups
                    ? preview.groups.slice(0, SAMPLE_LIMIT).map((group) => (
                        <div
                          key={`${group.reason}:${group.key}`}
                          className="border-b border-border-subtle px-3 py-2 last:border-b-0"
                        >
                          <div className="flex items-center gap-2">
                            <span className="min-w-0 flex-1 truncate text-vesti-base font-sans text-text-primary">
                              {group.conversations[0]?.title}
                            </span>
                            <span className="shrink-0 rounded bg-accent-primary-light px-1.5 py-0.5 text-vesti-xs font-sans text-accent-primary">
                              {l("keepLabel", "keep")}
                            </span>
                          </div>
                          <div className="mt-0.5 text-vesti-sm font-sans text-text-tertiary">
                            {group.reason === "same_source_id"
                              ? l("reasonSameSource", "Same capture id from multiple sources")
                              : l("reasonSameTitle", "Identical title from multiple sources")}
                            {" · "}
                            {l("dropLabel", "{count} to trash").replace(
                              "{count}",
                              String(group.duplicateIds.length),
                            )}
                          </div>
                        </div>
                      ))
                    : sampleList.map((title, index) => (
                        <div
                          key={`${preview.ids[index] ?? index}`}
                          className="truncate border-b border-border-subtle px-3 py-2 text-vesti-base font-sans text-text-secondary last:border-b-0"
                        >
                          {title}
                        </div>
                      ))}
                  {moreCount > 0 ? (
                    <div className="px-3 py-2 text-vesti-sm font-sans text-text-tertiary">
                      {l("previewMore", "…and {count} more").replace(
                        "{count}",
                        String(moreCount),
                      )}
                    </div>
                  ) : null}
                </div>
              )}
            </div>
          ) : null}

          {phase === "running" ? (
            <div className="flex items-center justify-center gap-2 py-8 text-vesti-base font-sans text-text-secondary">
              <RefreshCw strokeWidth={1.75} className="h-4 w-4 animate-spin" />
              {l("executing", "Applying…")}
            </div>
          ) : null}

          {phase === "done" ? (
            <p className="py-6 text-center text-vesti-base font-sans text-text-primary">
              {l("done", "Done — {count} conversations updated.").replace(
                "{count}",
                String(resultCount),
              )}
            </p>
          ) : null}

          {phase === "error" ? (
            <p className="py-6 text-center text-vesti-base font-sans text-danger">
              {l("failed", "Failed: {message}").replace(
                "{message}",
                errorMessage ?? "unknown",
              )}
            </p>
          ) : null}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 pt-3">
          {phase === "preview" ? (
            <>
              <button
                type="button"
                onClick={onClose}
                className="rounded-md px-3 py-1.5 text-vesti-base font-sans text-text-secondary transition-colors hover:bg-bg-surface-card"
              >
                {l("cancel", "Cancel")}
              </button>
              <button
                type="button"
                disabled={!preview?.ready || preview.count === 0}
                onClick={() => void execute()}
                className={`rounded-md px-3 py-1.5 text-vesti-base font-sans transition-colors ${
                  preview?.ready && preview.count > 0
                    ? "bg-accent-primary text-text-inverse hover:bg-accent-primary-hover"
                    : "cursor-not-allowed bg-bg-surface-card text-text-tertiary"
                }`}
              >
                {l("confirm", "Apply")}
              </button>
            </>
          ) : null}
          {phase === "done" || phase === "error" ? (
            <button
              type="button"
              onClick={onClose}
              className="rounded-md bg-accent-primary px-3 py-1.5 text-vesti-base font-sans text-text-inverse transition-colors hover:bg-accent-primary-hover"
            >
              {l("close", "Close")}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
