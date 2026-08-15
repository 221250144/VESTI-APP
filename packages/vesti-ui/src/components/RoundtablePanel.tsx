import { useEffect, useRef, useState } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import {
  AlertTriangle,
  Check,
  Clipboard,
  Compass,
  Flame,
  GraduationCap,
  HelpCircle,
  Loader2,
  Sun,
  Users,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import type {
  DashboardLabels,
  RoundtablePersonaId,
  RoundtableResult,
  RoundtableSeatTurn,
  StorageApi,
  UiThemeMode,
} from "../types";
import { SendToMenu } from "./SendToMenu";
import { buildRoundtableMarkdown } from "../lib/exploreMarkdown";
import {
  ROUNDTABLE_SCENES,
  sceneMatchesSelection,
  type RoundtableSceneId,
} from "../lib/roundtableScenes";
import {
  ExploreBulletSection,
  ExploreEmptyState,
  ExploreGateNote,
  ExploreInfoBar,
  ExploreSourceChips,
} from "./ExploreBits";

// AI 圆桌 (Roundtable): a self-contained Explore sub-mode. The user brings a
// judgment-call question, picks 2-4 persona seats, and each seat speaks in
// turn on the configured LLM (kind 'roundtable-turn', serial, with per-seat
// progress); a moderator pass (kind 'roundtable-synthesis') then distills
// consensus / disagreements / a recommendation. The host's storage.runRoundtable
// owns orchestration + archiving into the Ask history; this component owns
// only its own UI state. Without a configured LLM the panel explains what's
// missing instead of offering a dead button.
//
// Borrowed from 学习 (Learn): the question box offers "从学习领域选题" chips
// (the host passes the learning map's top domains), and each seat's finished
// viewpoint carries a "继续深入" jump that seeds Ask with a follow-up on that
// viewpoint — the same handoff the Learn domains use.

interface RoundtablePanelProps {
  storage: StorageApi;
  themeMode?: UiThemeMode;
  labels: DashboardLabels["roundtable"];
  /** Localized "Send to…" labels (from the library block) for exporting the synthesis. */
  sendToLabels?: DashboardLabels["library"];
  /** Transcript/persona language for the run; defaults to "zh". */
  lang?: "zh" | "en";
  /** Jump target for the recalled-source chips. */
  onOpenConversation?: (conversationId: number) => void;
  /** 从学习领域选题: top learning domains offered as quick topic chips. */
  topicSuggestions?: string[];
  /** "继续深入": jump to Ask with a prefilled follow-up on a seat's viewpoint. */
  onExploreTopic?: (question: string) => void;
  /** 学习页发起的圆桌: the host hands a prefilled question; the box adopts it
   * once per nonce (same handoff pattern as the Ask composer's seedQuery). */
  seedQuestion?: { text: string; nonce: number } | null;
}

type SelectablePersonaId = Exclude<RoundtablePersonaId, "moderator">;

const SELECTABLE: SelectablePersonaId[] = [
  "skeptic",
  "optimist",
  "pragmatist",
  "domain_expert",
  "devils_advocate",
];
const MIN_SEATS = 2;
const MAX_SEATS = 4;

/** Seat identity: one lucide icon + one hue per persona so the result stream
 * reads as distinct speakers, not five identical bubbles. The tint uses a hex
 * alpha suffix so it survives both light and dark themes. */
const PERSONA_META: Record<SelectablePersonaId, { Icon: LucideIcon; color: string }> = {
  skeptic: { Icon: HelpCircle, color: "#d97706" },
  optimist: { Icon: Sun, color: "#059669" },
  pragmatist: { Icon: Wrench, color: "#2563eb" },
  domain_expert: { Icon: GraduationCap, color: "#7c3aed" },
  devils_advocate: { Icon: Flame, color: "#dc2626" },
};

// 猫头鹰席位名 (Owl seat names), kept next to the component in the DOCK_COPY
// pattern: the shared i18n files still carry the pre-rename labels and stay
// untouched, so the picker/progress/result names resolve from this local
// dictionary instead. The `lang` prop only distinguishes zh/en today; the
// ja/ko entries ride along for when the host starts passing them through.
const PERSONA_NAME_COPY: Record<"zh" | "en" | "ja" | "ko", Record<SelectablePersonaId, string>> = {
  zh: {
    skeptic: "怀疑猫头鹰",
    optimist: "乐观猫头鹰",
    pragmatist: "务实猫头鹰",
    domain_expert: "专家猫头鹰",
    devils_advocate: "抬杠猫头鹰",
  },
  en: {
    skeptic: "Skeptic Owl",
    optimist: "Optimist Owl",
    pragmatist: "Pragmatist Owl",
    domain_expert: "Expert Owl",
    devils_advocate: "Contrarian Owl",
  },
  ja: {
    skeptic: "懐疑フクロウ",
    optimist: "楽観フクロウ",
    pragmatist: "実務フクロウ",
    domain_expert: "専門家フクロウ",
    devils_advocate: "反論フクロウ",
  },
  ko: {
    skeptic: "회의파 올빼미",
    optimist: "낙관파 올빼미",
    pragmatist: "실무파 올빼미",
    domain_expert: "전문가 올빼미",
    devils_advocate: "반대파 올빼미",
  },
};

/** Excerpt length of a seat's viewpoint folded into the "继续深入" Ask seed. */
const DEEPEN_EXCERPT_MAX = 80;

function renderMarkdown(text: string): { __html: string } {
  try {
    return { __html: DOMPurify.sanitize(marked.parse(text) as string) };
  } catch {
    return { __html: "" };
  }
}

function PersonaAvatar({ id, size = "md" }: { id: RoundtablePersonaId; size?: "sm" | "md" }) {
  const meta = PERSONA_META[id as SelectablePersonaId] ?? PERSONA_META.skeptic;
  const { Icon, color } = meta;
  const box = size === "sm" ? "h-5 w-5" : "h-6 w-6";
  return (
    <span
      aria-hidden="true"
      className={`flex ${box} shrink-0 items-center justify-center rounded-full`}
      style={{ color, backgroundColor: `${color}1f` }}
    >
      <Icon className={size === "sm" ? "h-3 w-3" : "h-3.5 w-3.5"} strokeWidth={1.9} />
    </span>
  );
}

export function RoundtablePanel({
  storage,
  labels,
  sendToLabels,
  lang = "zh",
  onOpenConversation,
  topicSuggestions,
  onExploreTopic,
  seedQuestion,
}: RoundtablePanelProps) {
  const [question, setQuestion] = useState("");
  const [selected, setSelected] = useState<SelectablePersonaId[]>([
    "skeptic",
    "optimist",
    "pragmatist",
  ]);
  const [running, setRunning] = useState(false);
  const [liveTurns, setLiveTurns] = useState<RoundtableSeatTurn[]>([]);
  const [result, setResult] = useState<RoundtableResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  // undefined = still probing; false = gate the run and say why.
  const [llmConfigured, setLlmConfigured] = useState<boolean | undefined>(undefined);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

  // Adopt a host-seeded question (发起圆桌 from the Learn map) once per nonce.
  const seededNonceRef = useRef(0);
  useEffect(() => {
    if (!seedQuestion || seedQuestion.nonce === seededNonceRef.current) return;
    seededNonceRef.current = seedQuestion.nonce;
    setQuestion(seedQuestion.text);
  }, [seedQuestion]);

  useEffect(() => {
    let alive = true;
    if (!storage.getLlmConfigured) {
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

  // Seat names come from the local owl dictionary (see PERSONA_NAME_COPY);
  // the i18n-provided persona labels predate the rename.
  const nameOf = (id: RoundtablePersonaId): string =>
    id === "moderator"
      ? "Moderator"
      : (PERSONA_NAME_COPY[lang] ?? PERSONA_NAME_COPY.en)[id as SelectablePersonaId];

  const togglePersona = (id: SelectablePersonaId) => {
    setSelected((prev) => {
      if (prev.includes(id)) return prev.filter((p) => p !== id);
      if (prev.length >= MAX_SEATS) return prev;
      return [...prev, id];
    });
  };

  const sceneNameOf = (id: RoundtableSceneId): string =>
    ({
      tech_review: labels.sceneTechReview,
      study_qa: labels.sceneStudyQa,
      decision_debate: labels.sceneDecisionDebate,
    })[id];

  const copyResult = async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(buildRoundtableMarkdown(result, labels));
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
    window.setTimeout(() => setCopyState("idle"), 2200);
  };

  const run = async () => {
    const q = question.trim();
    if (!q) {
      setError(labels.needQuestion);
      return;
    }
    if (!storage.runRoundtable || running || selected.length < MIN_SEATS) return;
    setError(null);
    setRunning(true);
    setResult(null);
    setLiveTurns([]);
    setCopyState("idle");
    try {
      const res = await storage.runRoundtable(q, selected, {
        lang,
        onSeatComplete: (turn) => setLiveTurns((prev) => [...prev, turn]),
      });
      setResult(res);
    } catch (e) {
      setError((e as Error)?.message ?? "Failed");
    } finally {
      setRunning(false);
    }
  };

  // Seats run serially in selection order, so liveTurns[i] is seat i's
  // finished turn; the seat at index liveTurns.length is the one speaking.
  const allSeatsDone = liveTurns.length >= selected.length;
  const synthesisPending = running && allSeatsDone;
  const runDisabled =
    running || selected.length < MIN_SEATS || llmConfigured === false || !storage.runRoundtable;
  // A fully-failed run (model service down: quota, network…) gets one clear
  // failure note instead of a stack of identical per-seat errors and a
  // missing synthesis. Matches the storage layer, which archives nothing.
  const allSeatsFailed =
    result !== null && result.seatTurns.length > 0 && result.seatTurns.every((turn) => !turn.ok);
  const firstSeatError = allSeatsFailed
    ? result.seatTurns.find((turn) => !turn.ok && turn.error)?.error ?? null
    : null;

  return (
    <div className="h-full overflow-y-auto px-6 py-6">
      <div className="mx-auto max-w-2xl">
        <h3 className="flex items-center gap-2 text-[15px] font-medium text-text-primary">
          <Users className="h-4 w-4" strokeWidth={1.8} />
          {labels.title}
        </h3>
        <p className="mt-1 text-[12px] text-text-tertiary">{labels.subtitle}</p>

        {/* 这是什么: what the panel is and how a run works (same info bar as Learn). */}
        <ExploreInfoBar Icon={Users} intro={labels.intro} />

        {/* LLM gate: explain instead of offering a dead button. */}
        {llmConfigured === false ? <ExploreGateNote text={labels.llmMissing} /> : null}

        {/* Question */}
        <textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder={labels.questionPlaceholder}
          rows={3}
          className="mt-4 w-full resize-y rounded-xl border border-border-subtle bg-bg-primary px-3 py-2 text-[13px] text-text-primary outline-none focus:border-accent-primary"
        />

        {/* 从学习领域选题 (borrowed from Learn): one click seeds the question
         * box with a localized topic template. */}
        {topicSuggestions && topicSuggestions.length > 0 ? (
          <div className="mt-2.5">
            <div className="mb-1.5 text-[12px] text-text-secondary">{labels.topicsLabel}</div>
            <div className="flex flex-wrap gap-1.5">
              {topicSuggestions.map((topic) => (
                <button
                  key={topic}
                  type="button"
                  onClick={() => setQuestion(labels.topicPrompt.replace("{topic}", topic))}
                  title={topic}
                  className="max-w-[220px] truncate rounded-full border border-border-subtle px-2.5 py-1 text-[11.5px] text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-accent-primary"
                >
                  {topic}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {/* 场景模板: one click swaps in the seat lineup for a common use —
         * faster than reasoning about five personas one by one. */}
        <div className="mt-3">
          <div className="mb-1.5 text-[12px] text-text-secondary">{labels.scenesLabel}</div>
          <div className="flex flex-wrap gap-1.5">
            {ROUNDTABLE_SCENES.map((scene) => {
              const active = sceneMatchesSelection(scene, selected);
              return (
                <button
                  key={scene.id}
                  type="button"
                  onClick={() => setSelected([...scene.seats])}
                  className={`rounded-full border px-2.5 py-1 text-[11.5px] transition-colors ${
                    active
                      ? "border-accent-primary bg-accent-primary-light text-accent-primary"
                      : "border-border-subtle text-text-secondary hover:bg-bg-tertiary hover:text-accent-primary"
                  }`}
                >
                  {sceneNameOf(scene.id)}
                </button>
              );
            })}
          </div>
        </div>

        {/* Persona picker */}
        <div className="mt-3">
          <div className="mb-1.5 text-[12px] text-text-secondary">{labels.personasLabel}</div>
          <div className="flex flex-wrap gap-2">
            {SELECTABLE.map((id) => {
              const active = selected.includes(id);
              // At the seat cap, dim + disable the unselected personas so the
              // 5th click isn't silently ignored.
              const atCap = !active && selected.length >= MAX_SEATS;
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => togglePersona(id)}
                  disabled={atCap}
                  className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[12px] transition-colors ${
                    active
                      ? "border-accent-primary bg-accent-primary-light text-accent-primary"
                      : atCap
                        ? "cursor-not-allowed border-border-subtle text-text-tertiary opacity-40"
                        : "border-border-subtle text-text-secondary hover:bg-bg-tertiary"
                  }`}
                >
                  <PersonaAvatar id={id} size="sm" />
                  {nameOf(id)}
                </button>
              );
            })}
          </div>
        </div>

        <div className="mt-3 flex items-center gap-3">
          <button
            type="button"
            onClick={() => void run()}
            disabled={runDisabled}
            className="inline-flex items-center gap-2 rounded-lg bg-accent-primary px-4 py-2 text-[13px] font-medium text-text-inverse transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {running ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {running ? labels.running : result ? labels.rerun : labels.run}
          </button>
          {/* Keep the latency reassurance visible during the wait, not only before it. */}
          <span className="text-[11px] text-text-tertiary">{labels.latencyHint}</span>
        </div>

        {error ? <p className="mt-3 text-[12px] text-red-600">{error}</p> : null}

        {/* Per-seat progress while deliberating (serial: seats speak in
         * selection order, then the moderator synthesis runs). */}
        {running ? (
          <div className="mt-5 rounded-xl border border-border-subtle bg-bg-surface-card p-3.5">
            <div className="flex flex-col gap-2">
              {selected.map((id, index) => {
                const turn = liveTurns[index];
                const status = turn
                  ? turn.ok
                    ? "done"
                    : "failed"
                  : index === liveTurns.length
                    ? "active"
                    : "pending";
                return (
                  <div key={id} className="flex items-center gap-2.5">
                    <PersonaAvatar id={id} size="sm" />
                    <span
                      className={`text-[12.5px] ${
                        status === "pending" ? "text-text-tertiary" : "text-text-primary"
                      }`}
                    >
                      {nameOf(id)}
                    </span>
                    <span className="ml-auto">
                      {status === "active" ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin text-accent-primary" strokeWidth={1.75} />
                      ) : status === "done" ? (
                        <Check className="h-3.5 w-3.5 text-emerald-600" strokeWidth={2} />
                      ) : status === "failed" ? (
                        <AlertTriangle className="h-3.5 w-3.5 text-amber-600" strokeWidth={1.75} />
                      ) : (
                        <span className="block h-1.5 w-1.5 rounded-full bg-border-subtle" />
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
            <p className="mt-2.5 text-[11px] text-text-tertiary">
              {labels.seatsProgress
                .replace("{done}", String(Math.min(liveTurns.length, selected.length)))
                .replace("{total}", String(selected.length))}
              {synthesisPending ? ` · ${labels.synthesisRunning}` : ""}
            </p>
          </div>
        ) : null}

        {!result && !running && !error ? (
          <ExploreEmptyState Icon={Users} body={labels.empty} compact />
        ) : null}

        {/* Fully-failed run: one honest failure card (with the underlying
         * error) instead of N identical seat errors and no synthesis. */}
        {result && allSeatsFailed ? (
          <div className="mt-6 rounded-xl border border-border-subtle bg-bg-surface-card p-4">
            <div className="flex items-start gap-2.5">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" strokeWidth={1.75} />
              <div className="min-w-0">
                <p className="text-[12.5px] leading-relaxed text-text-primary">
                  {labels.allSeatsFailed}
                </p>
                {firstSeatError ? (
                  <p className="mt-1.5 break-all text-[11.5px] text-text-tertiary">{firstSeatError}</p>
                ) : null}
              </div>
            </div>
          </div>
        ) : null}

        {result && !allSeatsFailed ? (
          <div className="mt-6">
            {/* Grounding + export/copy row */}
            <div className="mb-2 flex items-center justify-between gap-3">
              {result.grounded && result.sources.length > 0 ? (
                <p className="text-[11px] text-text-tertiary">
                  {labels.groundedHint.replace("{n}", String(result.sources.length))}
                </p>
              ) : (
                <span />
              )}
              <div className="flex items-center gap-2">
                {/* 复制结论: whole run as Markdown — works even when neither
                 * Notion nor Obsidian is configured. */}
                <button
                  type="button"
                  onClick={() => void copyResult()}
                  className="inline-flex h-9 items-center gap-1.5 px-1 text-[11px] uppercase tracking-[0.14em] text-text-tertiary transition-colors hover:text-text-primary"
                >
                  {copyState === "copied" ? (
                    <Check className="h-4 w-4 shrink-0 text-accent-primary" strokeWidth={1.7} />
                  ) : (
                    <Clipboard className="h-4 w-4 shrink-0" strokeWidth={1.7} />
                  )}
                  {copyState === "copied"
                    ? labels.copied
                    : copyState === "failed"
                      ? labels.copyFailed
                      : labels.copyResult}
                </button>
                {sendToLabels ? (
                  <SendToMenu
                    storage={storage}
                    labels={sendToLabels}
                    payload={{
                      title: `${labels.title} — ${result.question}`.slice(0, 120),
                      markdown: buildRoundtableMarkdown(result, labels),
                    }}
                  />
                ) : null}
              </div>
            </div>

            {/* Seats */}
            <div className="mb-2 text-[12px] font-medium text-text-secondary">{labels.seatsTitle}</div>
            <div className="flex flex-col gap-3">
              {result.seatTurns.map((turn, i) => (
                <div
                  key={`${turn.personaId}-${i}`}
                  className="rounded-xl border border-border-subtle bg-bg-surface-card p-3.5"
                >
                  <div className="mb-1.5 flex items-center gap-2">
                    <PersonaAvatar id={turn.personaId} />
                    <span className="text-[12.5px] font-semibold text-text-primary">
                      {nameOf(turn.personaId)}
                    </span>
                  </div>
                  {turn.ok ? (
                    <>
                      <div
                        className="prose-vesti text-[13px] leading-relaxed text-text-secondary"
                        dangerouslySetInnerHTML={renderMarkdown(turn.content)}
                      />
                      {/* 继续深入 (borrowed from Learn): seed Ask with a
                       * follow-up on this seat's viewpoint. */}
                      {onExploreTopic ? (
                        <button
                          type="button"
                          onClick={() =>
                            onExploreTopic(
                              labels.deepenPrompt
                                .replace("{question}", result.question)
                                .replace("{persona}", nameOf(turn.personaId))
                                .replace(
                                  "{excerpt}",
                                  turn.content.replace(/\s+/g, " ").trim().slice(0, DEEPEN_EXCERPT_MAX),
                                ),
                            )
                          }
                          className="mt-2.5 inline-flex items-center gap-1.5 rounded-lg border border-border-subtle px-2.5 py-1 text-[11.5px] font-medium text-accent-primary transition-colors hover:bg-accent-primary-light"
                        >
                          <Compass className="h-3.5 w-3.5" strokeWidth={1.75} />
                          {labels.deepen}
                        </button>
                      ) : null}
                    </>
                  ) : (
                    <div className="text-[12px] text-red-600">
                      {labels.seatFailed}
                      {turn.error ? ` — ${turn.error}` : ""}
                    </div>
                  )}
                </div>
              ))}
            </div>

            {/* Synthesis */}
            {result.synthesis ? (
              <div className="mt-5 rounded-xl border border-border-subtle bg-bg-surface-card p-4">
                <div className="mb-3 text-[13px] font-semibold text-text-primary">
                  {labels.synthesisTitle}
                </div>
                <ExploreBulletSection title={labels.consensus} items={result.synthesis.consensus} />
                <ExploreBulletSection title={labels.disagreements} items={result.synthesis.disagreements} />
                {result.synthesis.recommendation ? (
                  <div className="mt-3">
                    <div className="text-[12px] font-medium text-text-secondary">
                      {labels.recommendation}
                    </div>
                    <p className="mt-1 text-[13px] leading-relaxed text-text-primary">
                      {result.synthesis.recommendation}
                    </p>
                  </div>
                ) : null}
                <ExploreBulletSection title={labels.openQuestions} items={result.synthesis.openQuestions} />
              </div>
            ) : result.synthesisRaw ? (
              <div className="mt-5 whitespace-pre-wrap rounded-xl border border-border-subtle bg-bg-surface-card p-4 text-[13px] text-text-secondary">
                {result.synthesisRaw}
              </div>
            ) : null}

            {/* Recalled sources */}
            {result.sources.length > 0 && onOpenConversation ? (
              <div className="mt-4">
                <ExploreSourceChips sources={result.sources} onOpenConversation={onOpenConversation} />
              </div>
            ) : null}

            {/* The run is archived into the Ask history for replay. */}
            <p className="mt-4 text-[11px] text-text-tertiary">{labels.savedHint}</p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
