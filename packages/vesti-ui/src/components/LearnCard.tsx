import { useCallback, useEffect, useRef, useState } from "react";
import { BookOpen, ChevronDown, ChevronRight, Compass, Loader2, MessagesSquare, RefreshCw, Sparkles } from "lucide-react";
import type { DashboardLabels, LearnDeepenResult, LearnDomain, LearnProfile, LearnRouteSynthesis, StorageApi } from "../types";
import { learnRouteFingerprint } from "../lib/learnSynthesis";
import { SendToMenu } from "./SendToMenu";
import { buildLearnMarkdown } from "../lib/exploreMarkdown";
import {
  ExploreBulletSection,
  ExploreEmptyState,
  ExploreGateNote,
  ExploreInfoBar,
  ExploreSourceChips,
} from "./ExploreBits";

// "学习 Learn": presentational view of the locally-computed learning map —
// knowledge domains (with a depth mix + representative conversations + a
// "继续深入" jump into Ask), a glossary of things learned, and open loops.
// The host computes the profile + passes localized labels; `profile`
// undefined means the host is still computing (loading state).
//
// AI 深化 (borrowed from the roundtable): when the host implements
// storage.runLearnDeepen and an LLM is configured, each named domain card
// also offers an "AI 深化" run — one recall-grounded LLM pass (current
// mastery / blind spots / suggested path) rendered inside the domain card,
// with the roundtable's progress-row + grounded-sources + saved-hint
// patterns. Without a configured LLM the gate note explains instead of
// offering a dead button. The uncategorized bucket gets no AI 深化 — a
// "uncategorized" recall query would ground on nothing meaningful.
//
// 路线级 LLM 合成 (V4): when the host implements storage.runLearnSynthesis
// and an LLM is configured, each route gets one synthesized reading — a
// full-sentence title + interpretation + next steps, fingerprint-cached by
// the host. Synthesized routes render the LLM title with the deterministic
// label as caption, plus the summary and next-step bullets; anything missing
// (no LLM / run failed / unusable output) falls back to the deterministic
// display with zero regression. A "重新生成" control clears the cache and
// re-runs every route.

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
  /** "发起圆桌": hand this domain to the roundtable as a seeded topic. */
  onRoundtableTopic?: (question: string) => void;
  storage?: StorageApi;
  sendToLabels?: DashboardLabels["library"];
  /** Transcript/analysis language for AI 深化 runs; defaults to "zh". */
  lang?: "zh" | "en";
}

type DeepenState =
  | { status: "running" }
  | { status: "done"; result: LearnDeepenResult }
  | { status: "error"; message: string };

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
  onRoundtableTopic,
  storage,
  sendToLabels,
  lang = "zh",
}: LearnCardProps) {
  // undefined = still probing; false = gate AI 深化 and say why (same probe as
  // the roundtable panel).
  const [llmConfigured, setLlmConfigured] = useState<boolean | undefined>(undefined);
  const [deepenByDomain, setDeepenByDomain] = useState<Record<string, DeepenState>>({});
  const [showCompactDomains, setShowCompactDomains] = useState(false);
  // V4 route synthesis: fingerprint → reading. Routes without an entry keep
  // the deterministic display; progress is null while idle.
  const [synthesisByRoute, setSynthesisByRoute] = useState<Record<string, LearnRouteSynthesis>>({});
  const [synthesisProgress, setSynthesisProgress] = useState<{ done: number; total: number } | null>(null);
  const synthesisInFlightRef = useRef(false);
  const synthesisRunKeyRef = useRef<string | null>(null);

  useEffect(() => {
    let alive = true;
    if (!storage?.getLlmConfigured) {
      setLlmConfigured(undefined);
      return;
    }
    storage
      .getLlmConfigured()
      .then((configured) => {
        if (alive) setLlmConfigured(configured);
      })
      .catch(() => {
        if (alive) setLlmConfigured(false);
      });
    return () => {
      alive = false;
    };
  }, [storage]);

  const deepenSupported = Boolean(storage?.runLearnDeepen);
  const synthesisSupported = Boolean(storage?.runLearnSynthesis);

  // V4: run the route synthesis (sequential + fingerprint-cached host-side).
  // The run key freezes the (lang, fingerprint set) pair a run covered, so
  // profile recomputes that change nothing don't re-run; `force` bypasses it.
  const runSynthesis = useCallback(
    async (domains: LearnDomain[], force: boolean) => {
      if (!storage?.runLearnSynthesis || synthesisInFlightRef.current) return;
      synthesisInFlightRef.current = true;
      synthesisRunKeyRef.current = `${lang}:${domains.map((d) => learnRouteFingerprint(d)).join("|")}`;
      setSynthesisProgress({ done: 0, total: domains.length });
      try {
        const map = await storage.runLearnSynthesis(domains, {
          lang,
          force,
          onProgress: (done, total) => setSynthesisProgress({ done, total }),
        });
        setSynthesisByRoute(map);
      } catch {
        // Silent fallback: the cards keep their deterministic labels.
      } finally {
        synthesisInFlightRef.current = false;
        setSynthesisProgress(null);
      }
    },
    [storage, lang],
  );

  // Auto-synthesize once the LLM probe cleared; cache hits make repeat runs
  // cheap — only routes whose membership changed actually call the LLM.
  useEffect(() => {
    if (!profile?.available || llmConfigured !== true || !synthesisSupported) return;
    const domains = profile.domains;
    if (domains.length === 0) return;
    const runKey = `${lang}:${domains.map((d) => learnRouteFingerprint(d)).join("|")}`;
    if (synthesisRunKeyRef.current === runKey || synthesisInFlightRef.current) return;
    void runSynthesis(domains, false);
  }, [profile, llmConfigured, synthesisSupported, lang, runSynthesis]);

  // "重新生成": clear-match re-run of every route (the host force flag
  // ignores cached entries for this language).
  const regenerateSynthesis = () => {
    if (!profile?.available || synthesisProgress) return;
    void runSynthesis(profile.domains, true);
  };

  const runDeepen = async (key: string, domain: LearnDomain) => {
    if (!storage?.runLearnDeepen || deepenByDomain[key]?.status === "running") return;
    setDeepenByDomain((prev) => ({ ...prev, [key]: { status: "running" } }));
    try {
      const result = await storage.runLearnDeepen(domain, { lang });
      setDeepenByDomain((prev) => ({ ...prev, [key]: { status: "done", result } }));
    } catch (e) {
      setDeepenByDomain((prev) => ({
        ...prev,
        [key]: { status: "error", message: (e as Error)?.message ?? "Failed" },
      }));
    }
  };

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
      <ExploreEmptyState
        Icon={BookOpen}
        title={labels.title}
        body={labels.insufficient}
        action={<WeakAction labels={labels} onOpenAiti={onOpenAiti} />}
      />
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
        <ExploreInfoBar
          Icon={BookOpen}
          intro={labels.intro}
          sourceLine={labels.sourceLine
            .replace("{n}", String(profile.sampleSize))
            .replace("{m}", String(topicCount))}
        />

        {profile.sampleSize < WEAK_SAMPLE_THRESHOLD ? (
          <div className="mt-2 rounded-lg border border-border-subtle bg-bg-surface-card px-3 py-2">
            <p className="text-[11.5px] leading-relaxed text-text-tertiary">{labels.weakHint}</p>
            <WeakAction labels={labels} onOpenAiti={onOpenAiti} />
          </div>
        ) : null}

        {/* LLM gate (AI 深化 only — the local map itself works without one). */}
        {deepenSupported && llmConfigured === false ? (
          <ExploreGateNote text={labels.llmMissing} className="mt-2" />
        ) : null}

        {/* Domains — V2: expanded (key) domains render full cards;
             compact/dormant/uncategorized render in a single-row variant
             inside a collapsible section below. */}
        {profile.domains.length > 0 && (() => {
          const expandedDomains = profile.domains.filter((d) => !d.compact);
          const compactDomains = profile.domains.filter((d) => d.compact);
          return (
          <div className="mt-5">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="text-[12px] font-medium text-text-secondary">{labels.domainsTitle}</div>
              {/* V4 synthesis controls: progressive status while running,
               * otherwise the 重新生成 entry. Gated on LLM + host support. */}
              {synthesisSupported && llmConfigured === true ? (
                synthesisProgress ? (
                  <span className="inline-flex items-center gap-1.5 text-[11px] text-text-tertiary">
                    <Loader2 className="h-3 w-3 animate-spin" strokeWidth={1.75} />
                    {labels.synthesisRunning
                      .replace("{done}", String(synthesisProgress.done))
                      .replace("{total}", String(synthesisProgress.total))}
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={regenerateSynthesis}
                    className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-text-tertiary transition-colors hover:bg-bg-tertiary hover:text-accent-primary"
                  >
                    <RefreshCw className="h-3 w-3" strokeWidth={1.75} />
                    {labels.synthesisRegenerate}
                  </button>
                )
              ) : null}
            </div>
            {/* Expanded (key) domains */}
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {expandedDomains.map((d) => {
                const total = Math.max(1, d.deep + d.moderate + d.superficial);
                const deepPct = Math.round((d.deep / total) * 100);
                const modPct = Math.round((d.moderate / total) * 100);
                const domainName = d.name || labels.uncategorized;
                // Synthetic clusters (project / platform / assorted) all share
                // topicId null — the name disambiguates their keys.
                const domainKey = d.topicId !== null ? String(d.topicId) : `synthetic:${d.name}`;
                const deepenState = deepenByDomain[domainKey];
                // V4: the synthesized reading for this route, if any — its
                // full-sentence title leads, the deterministic label stays as
                // a caption; absent → the deterministic display as before.
                const synthesis = synthesisByRoute[learnRouteFingerprint(d)];
                // The uncategorized bucket gets no AI 深化 (see header note).
                const showDeepenAi =
                  deepenSupported && llmConfigured !== false && d.topicId !== null;
                return (
                  <div
                    key={domainKey}
                    className="rounded-xl border border-border-subtle bg-bg-surface-card p-3"
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <span
                        className="truncate text-[13px] font-medium text-text-primary"
                        title={synthesis ? synthesis.title : undefined}
                      >
                        {synthesis?.title ?? domainName}
                      </span>
                      <span className="shrink-0 text-[11px] text-text-tertiary">
                        {labels.domainConversations.replace("{n}", String(d.count))}
                      </span>
                    </div>
                    {synthesis ? (
                      <div className="mt-0.5 truncate text-[11px] text-text-tertiary">
                        {domainName}
                      </div>
                    ) : null}
                    {d.deep + d.moderate + d.superficial > 0 && (
                      <div className="mt-2 flex h-1.5 overflow-hidden rounded-full bg-bg-tertiary">
                        <div className="bg-accent-primary" style={{ width: `${deepPct}%` }} />
                        <div className="bg-accent-primary/50" style={{ width: `${modPct}%` }} />
                      </div>
                    )}

                    {/* V4 synthesis: the route interpretation paragraph. */}
                    {synthesis ? (
                      <p className="mt-2 text-[12px] leading-relaxed text-text-secondary">
                        {synthesis.summary}
                      </p>
                    ) : null}

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

                    {/* V4 synthesis: concrete next steps for this route. */}
                    {synthesis && synthesis.nextSteps.length > 0 ? (
                      <ExploreBulletSection
                        title={labels.synthesisNextSteps}
                        items={synthesis.nextSteps}
                      />
                    ) : null}

                    <div className="mt-2.5 flex flex-wrap items-center gap-2">
                      {/* 继续深入: seed Ask with a follow-up on this domain. */}
                      {onExploreTopic ? (
                        <button
                          type="button"
                          onClick={() =>
                            onExploreTopic(labels.deepenPrompt.replace("{topic}", domainName))
                          }
                          className="inline-flex items-center gap-1.5 rounded-lg border border-border-subtle px-2.5 py-1 text-[11.5px] font-medium text-accent-primary transition-colors hover:bg-accent-primary-light"
                        >
                          <Compass className="h-3.5 w-3.5" strokeWidth={1.75} />
                          {labels.deepen}
                        </button>
                      ) : null}
                      {/* AI 深化: one recall-grounded LLM pass, rendered in place. */}
                      {showDeepenAi ? (
                        <button
                          type="button"
                          onClick={() => void runDeepen(domainKey, d)}
                          disabled={deepenState?.status === "running"}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-border-subtle px-2.5 py-1 text-[11.5px] font-medium text-accent-primary transition-colors hover:bg-accent-primary-light disabled:opacity-50"
                        >
                          <Sparkles className="h-3.5 w-3.5" strokeWidth={1.75} />
                          {labels.deepenAi}
                        </button>
                      ) : null}
                      {/* 发起圆桌: seed the roundtable with this domain as topic. */}
                      {onRoundtableTopic ? (
                        <button
                          type="button"
                          onClick={() =>
                            onRoundtableTopic(labels.roundtablePrompt.replace("{topic}", domainName))
                          }
                          className="inline-flex items-center gap-1.5 rounded-lg border border-border-subtle px-2.5 py-1 text-[11.5px] font-medium text-accent-primary transition-colors hover:bg-accent-primary-light"
                        >
                          <MessagesSquare className="h-3.5 w-3.5" strokeWidth={1.75} />
                          {labels.toRoundtable}
                        </button>
                      ) : null}
                    </div>

                    {/* Progress row while the deep-dive runs (roundtable style). */}
                    {deepenState?.status === "running" ? (
                      <div className="mt-2.5 flex items-center gap-2.5">
                        <Loader2
                          className="h-3.5 w-3.5 animate-spin text-accent-primary"
                          strokeWidth={1.75}
                        />
                        <span className="text-[12.5px] text-text-primary">
                          {labels.deepenAiRunning.replace("{topic}", domainName)}
                        </span>
                      </div>
                    ) : null}

                    {deepenState?.status === "error" ? (
                      <p className="mt-2 text-[12px] text-red-600">
                        {labels.deepenAiFailed}
                        {deepenState.message ? ` — ${deepenState.message}` : ""}
                      </p>
                    ) : null}

                    {/* Deep-dive result: mastery / blind spots / path inside the
                     * domain card, with the roundtable's grounding + sources. */}
                    {deepenState?.status === "done" ? (
                      <div className="mt-2.5 border-t border-border-subtle pt-2.5">
                        <div className="text-[12px] font-medium text-text-secondary">
                          {labels.deepenAiTitle}
                        </div>
                        {deepenState.result.grounded && deepenState.result.sources.length > 0 ? (
                          <p className="mt-1 text-[11px] text-text-tertiary">
                            {labels.groundedHint.replace(
                              "{n}",
                              String(deepenState.result.sources.length),
                            )}
                          </p>
                        ) : null}
                        {deepenState.result.analysis ? (
                          <>
                            <ExploreBulletSection
                              title={labels.mastered}
                              items={deepenState.result.analysis.mastered}
                            />
                            <ExploreBulletSection
                              title={labels.blindSpots}
                              items={deepenState.result.analysis.blindSpots}
                            />
                            <ExploreBulletSection
                              title={labels.learningPath}
                              items={deepenState.result.analysis.path}
                            />
                          </>
                        ) : (
                          <div className="mt-2 whitespace-pre-wrap text-[12px] leading-relaxed text-text-secondary">
                            {deepenState.result.raw}
                          </div>
                        )}
                        {deepenState.result.sources.length > 0 ? (
                          <div className="mt-2">
                            <ExploreSourceChips
                              sources={deepenState.result.sources}
                              onOpenConversation={onOpenConversation}
                            />
                          </div>
                        ) : null}
                        <p className="mt-2 text-[11px] text-text-tertiary">{labels.savedHint}</p>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>

            {/* Compact domains: collapsed by default, shown as single-row chips */}
            {compactDomains.length > 0 && (
              <div className="mt-3">
                <button
                  type="button"
                  onClick={() => setShowCompactDomains((v) => !v)}
                  className="flex w-full items-center gap-1.5 rounded-lg border border-border-subtle px-3 py-2 text-[11.5px] text-text-tertiary transition-colors hover:bg-bg-tertiary"
                >
                  {showCompactDomains ? (
                    <ChevronDown className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
                  ) : (
                    <ChevronRight className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
                  )}
                  {labels.moreDomains?.replace("{n}", String(compactDomains.length)) ??
                    `+ ${compactDomains.length} more`}
                  {compactDomains.some((d) => d.topicId === null) && (
                    <span className="text-text-tertiary/60">
                      {labels.uncategorizedIncluded ?? "· includes uncategorized"}
                    </span>
                  )}
                </button>
                {showCompactDomains && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {compactDomains.map((d) => {
                      const domainName = d.name || labels.uncategorized;
                      return (
                        <div
                          key={d.topicId !== null ? `compact-${d.topicId}` : `compact-synthetic:${d.name}`}
                          className="flex items-center gap-1.5 rounded-md border border-border-subtle bg-bg-surface-card px-2.5 py-1 text-[11px] text-text-secondary"
                        >
                          <span className="max-w-[160px] truncate">{domainName}</span>
                          <span className="text-text-tertiary/60">{d.count}</span>
                          {onExploreTopic && d.topicId !== null ? (
                            <button
                              type="button"
                              onClick={() =>
                                onExploreTopic(labels.deepenPrompt.replace("{topic}", domainName))
                              }
                              className="ml-1 text-accent-primary hover:underline"
                            >
                              {labels.deepen ?? "→"}
                            </button>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        );
        })()}

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
