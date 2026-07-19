import { BookOpen, Compass, Loader2, MessagesSquare, Sparkles } from "lucide-react";
import type { DashboardLabels, LearnProfile, StorageApi } from "../types";
import { SendToMenu } from "./SendToMenu";
import { buildLearnMarkdown } from "../lib/exploreMarkdown";

// "学习 Learn": presentational view of the locally-computed learning map —
// knowledge domains (with a depth mix + representative conversations + a
// "继续深入" jump into Ask), a glossary of things learned, and open loops.
// The host computes the profile + passes localized labels; `profile`
// undefined means the host is still computing (loading state).

/** Below this many analyzed summaries the map is technically available but
 * thin — say so and point at generating more (same guidance as AITI). */
const WEAK_SAMPLE_THRESHOLD = 5;

interface LearnCardProps {
  profile?: LearnProfile;
  labels: DashboardLabels["learn"];
  onOpenConversation?: (conversationId: number) => void;
  /** Weak-data next step: jump to the AITI pane to generate more summaries. */
  onOpenAiti?: () => void;
  /** "继续深入": jump to Ask with a prefilled follow-up about this domain. */
  onExploreTopic?: (question: string) => void;
  storage?: StorageApi;
  sendToLabels?: DashboardLabels["library"];
}

/** Weak-data call-to-action, shared by the empty state and the thin-sample
 * hint: the way forward is always "generate more summaries on the AITI pane". */
function WeakAction({ labels, onOpenAiti }: { labels: DashboardLabels["learn"]; onOpenAiti?: () => void }) {
  if (!onOpenAiti) return null;
  return (
    <button
      type="button"
      onClick={onOpenAiti}
      className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-border-subtle px-2.5 py-1 text-[11.5px] font-medium text-accent-primary transition-colors hover:bg-accent-primary-light"
    >
      <Sparkles className="h-3.5 w-3.5" strokeWidth={1.75} />
      {labels.weakAction}
    </button>
  );
}

export function LearnCard({
  profile,
  labels,
  onOpenConversation,
  onOpenAiti,
  onExploreTopic,
  storage,
  sendToLabels,
}: LearnCardProps) {
  // Loading: the host recomputes the profile after every data update; until
  // the first result arrives show a quiet spinner, not the empty state.
  if (!profile) {
    return (
      <div className="flex h-full flex-col items-center justify-center p-10 text-center">
        <Loader2 className="h-5 w-5 animate-spin text-accent-primary" strokeWidth={1.75} />
        <p className="mt-3 text-[12px] text-text-tertiary">{labels.loading}</p>
      </div>
    );
  }

  if (!profile.available) {
    return (
      <div className="flex h-full flex-col items-center justify-center p-10 text-center">
        <div
          className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-accent-primary-light text-accent-primary"
          aria-hidden="true"
        >
          <BookOpen className="h-5 w-5" strokeWidth={1.75} />
        </div>
        <h3 className="text-[15px] font-medium text-text-primary">{labels.title}</h3>
        <p className="mt-2 max-w-md text-[13px] text-text-tertiary">{labels.insufficient}</p>
        <WeakAction labels={labels} onOpenAiti={onOpenAiti} />
      </div>
    );
  }

  // "覆盖 M 个话题" counts real topics only — the uncategorized bucket is not
  // a topic. Hidden when everything is uncategorized (M = 0).
  const topicCount = profile.domains.filter((d) => d.topicId !== null).length;

  return (
    <div className="h-full overflow-y-auto px-6 py-6">
      <div className="mx-auto max-w-2xl">
        <div className="flex items-start justify-between gap-3">
          <h3 className="text-[15px] font-medium text-text-primary">{labels.title}</h3>
          {storage && sendToLabels ? (
            <SendToMenu
              storage={storage}
              labels={sendToLabels}
              payload={{ title: labels.title, markdown: buildLearnMarkdown(profile, labels) }}
            />
          ) : null}
        </div>
        <p className="mt-1 text-[12px] text-text-tertiary">{labels.subtitle}</p>

        {/* 这是什么 + 数据来源: what this map is, and what it is built from. */}
        <div className="mt-3 flex items-start gap-2.5 rounded-xl border border-border-subtle bg-bg-surface-card px-3.5 py-3">
          <BookOpen className="mt-0.5 h-4 w-4 shrink-0 text-accent-primary" strokeWidth={1.75} />
          <div className="min-w-0">
            <p className="text-[12px] leading-relaxed text-text-secondary">{labels.intro}</p>
            <p className="mt-1 text-[11.5px] text-text-tertiary">
              {labels.sourceLine
                .replace("{n}", String(profile.sampleSize))
                .replace("{m}", String(topicCount))}
            </p>
          </div>
        </div>

        {profile.sampleSize < WEAK_SAMPLE_THRESHOLD ? (
          <div className="mt-2 rounded-lg border border-border-subtle bg-bg-surface-card px-3 py-2">
            <p className="text-[11.5px] leading-relaxed text-text-tertiary">{labels.weakHint}</p>
            <WeakAction labels={labels} onOpenAiti={onOpenAiti} />
          </div>
        ) : null}

        {/* Domains */}
        {profile.domains.length > 0 && (
          <div className="mt-5">
            <div className="mb-2 text-[12px] font-medium text-text-secondary">{labels.domainsTitle}</div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {profile.domains.map((d) => {
                const total = Math.max(1, d.deep + d.moderate + d.superficial);
                const deepPct = Math.round((d.deep / total) * 100);
                const modPct = Math.round((d.moderate / total) * 100);
                const domainName = d.name || labels.uncategorized;
                return (
                  <div
                    key={`${d.topicId ?? "null"}`}
                    className="rounded-xl border border-border-subtle bg-bg-surface-card p-3"
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-[13px] font-medium text-text-primary">
                        {domainName}
                      </span>
                      <span className="shrink-0 text-[11px] text-text-tertiary">
                        {labels.domainConversations.replace("{n}", String(d.count))}
                      </span>
                    </div>
                    {d.deep + d.moderate + d.superficial > 0 && (
                      <div className="mt-2 flex h-1.5 overflow-hidden rounded-full bg-bg-tertiary">
                        <div className="bg-accent-primary" style={{ width: `${deepPct}%` }} />
                        <div className="bg-accent-primary/50" style={{ width: `${modPct}%` }} />
                      </div>
                    )}

                    {/* Representative conversations: evidence-chain jumps into
                     * the conversations this domain is built from. */}
                    {d.representatives.length > 0 && onOpenConversation ? (
                      <div className="mt-2.5">
                        <div className="text-[11px] text-text-tertiary">{labels.representativesTitle}</div>
                        <div className="mt-1 flex flex-col gap-1">
                          {d.representatives.map((rep) => (
                            <button
                              key={rep.conversationId}
                              type="button"
                              onClick={() => onOpenConversation(rep.conversationId)}
                              title={rep.title}
                              className="flex items-center gap-1.5 rounded-md px-1 py-0.5 text-left text-[11.5px] text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-accent-primary"
                            >
                              <MessagesSquare className="h-3 w-3 shrink-0 text-text-tertiary" strokeWidth={1.75} />
                              <span className="truncate">{rep.title}</span>
                            </button>
                          ))}
                        </div>
                      </div>
                    ) : null}

                    {/* 继续深入: seed Ask with a follow-up on this domain. */}
                    {onExploreTopic ? (
                      <button
                        type="button"
                        onClick={() =>
                          onExploreTopic(labels.deepenPrompt.replace("{topic}", domainName))
                        }
                        className="mt-2.5 inline-flex items-center gap-1.5 rounded-lg border border-border-subtle px-2.5 py-1 text-[11.5px] font-medium text-accent-primary transition-colors hover:bg-accent-primary-light"
                      >
                        <Compass className="h-3.5 w-3.5" strokeWidth={1.75} />
                        {labels.deepen}
                      </button>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Glossary */}
        {profile.glossary.length > 0 && (
          <div className="mt-6">
            <div className="mb-2 text-[12px] font-medium text-text-secondary">{labels.glossaryTitle}</div>
            <ul className="flex flex-col gap-2">
              {profile.glossary.map((g) => (
                <li
                  key={g.term}
                  className={`rounded-lg border border-border-subtle bg-bg-surface-card p-2.5 ${
                    g.conversationId && onOpenConversation ? "cursor-pointer hover:bg-bg-tertiary" : ""
                  }`}
                  onClick={
                    g.conversationId && onOpenConversation
                      ? () => onOpenConversation(g.conversationId as number)
                      : undefined
                  }
                >
                  <div className="text-[13px] font-medium text-text-primary">{g.term}</div>
                  {g.definition ? (
                    <div className="mt-0.5 line-clamp-2 text-[12px] leading-relaxed text-text-secondary">
                      {g.definition}
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Open loops */}
        <div className="mt-6">
          <div className="mb-2 text-[12px] font-medium text-text-secondary">{labels.openLoopsTitle}</div>
          {profile.openLoops.length === 0 ? (
            <p className="text-[11.5px] text-text-tertiary">{labels.openLoopsEmpty}</p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {profile.openLoops.map((loop, i) => (
                <li
                  key={`${loop.conversationId}-${i}`}
                  className={`flex items-start gap-2.5 text-[13px] leading-relaxed text-text-primary ${
                    onOpenConversation ? "cursor-pointer hover:text-accent-primary" : ""
                  }`}
                  onClick={onOpenConversation ? () => onOpenConversation(loop.conversationId) : undefined}
                >
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent-primary/60" />
                  <span>{loop.text}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
