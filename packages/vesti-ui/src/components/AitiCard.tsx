import { useCallback, useEffect, useState } from "react";
import { Download, Loader2, Quote, RotateCcw, Sparkles, Square } from "lucide-react";
import type {
  AitiAxisScore,
  AitiImagery,
  AitiProfile,
  DashboardLabels,
  StorageApi,
  SummaryBatchState,
  SummaryCoverage,
} from "../types";
import { SendToMenu } from "./SendToMenu";
import { AitiIntro, aitiLocalCopy } from "./AitiIntro";
import { buildAitiMarkdown } from "../lib/exploreMarkdown";
import { renderAitiCardImage } from "../lib/aitiCardImage";
import { renderQrDataUrl, VESTI_REPO_SHORT, VESTI_REPO_URL } from "../lib/repoQr";
import { AITI_MIN_STRUCTURED_SUMMARIES } from "../lib/summaryCoverage";

// Session-scoped: the intro auto-plays on the first open of the AITI panel per
// app session (module load). It is only marked played when the intro finishes
// or is skipped (StrictMode double-mounts must not consume the one shot), and
// the 重看 button / radar click replays it on demand.
let aitiIntroPlayedThisSession = false;

// Lightweight, dependency-free SVG radar of the four AITI axes — a consistent
// accent-styled overview to complement the per-axis sliders. Degrades to null if
// the axis set isn't the expected four.
function AitiRadar({
  axes,
  axisMeta,
  weakAxes,
}: {
  axes: AitiAxisScore[];
  axisMeta: Record<string, { label: string; left: string; right: string }>;
  weakAxes: Set<string>;
}) {
  if (axes.length !== 4) return null;
  const cx = 100;
  const cy = 100;
  const maxR = 60;
  const deg = [-90, 0, 90, 180]; // top, right, bottom, left
  const rad = (d: number) => (d * Math.PI) / 180;
  const at = (frac: number, i: number) => ({
    x: cx + frac * maxR * Math.cos(rad(deg[i])),
    y: cy + frac * maxR * Math.sin(rad(deg[i])),
  });
  const ring = (frac: number) =>
    axes.map((_, i) => { const p = at(frac, i); return `${p.x.toFixed(1)},${p.y.toFixed(1)}`; }).join(" ");
  const clampFrac = (score: number) => Math.max(0.04, Math.min(1, (score ?? 0) / 100));
  // No-signal axes sit at the neutral mid-ring (and carry no pole label) so the
  // shape doesn't assert a lean the data doesn't support.
  const fracFor = (a: AitiAxisScore) => (a.hasSignal === false ? 0.5 : clampFrac(a.score));
  const scorePts = axes
    .map((a, i) => { const p = at(fracFor(a), i); return `${p.x.toFixed(1)},${p.y.toFixed(1)}`; })
    .join(" ");
  const dots = axes.map((a, i) => at(fracFor(a), i));
  const labelsArr = axes.map((a, i) => {
    const meta = axisMeta[a.key];
    const p = at(1.22, i);
    const anchor: "start" | "middle" | "end" = i === 1 ? "start" : i === 3 ? "end" : "middle";
    return {
      x: p.x,
      y: p.y + (i === 0 ? -2 : i === 2 ? 7 : 3),
      text: meta && a.hasSignal !== false ? (a.score >= 50 ? meta.right : meta.left) : "",
      anchor,
    };
  });
  return (
    <svg viewBox="-30 0 260 200" className="h-44 w-52" aria-hidden="true">
      {[0.33, 0.66, 1].map((f, gi) => (
        <polygon key={gi} points={ring(f)} fill="none" stroke="currentColor" strokeWidth={0.6} className="text-border-subtle" />
      ))}
      {axes.map((_, i) => {
        const p = at(1, i);
        return <line key={i} x1={cx} y1={cy} x2={p.x} y2={p.y} stroke="currentColor" strokeWidth={0.6} className="text-border-subtle" />;
      })}
      <polygon points={scorePts} fill="currentColor" fillOpacity={0.22} stroke="currentColor" strokeWidth={1.5} className="text-accent-primary" />
      {dots.map((p, i) => (
        <circle
          key={i}
          cx={p.x}
          cy={p.y}
          r={2.5}
          fill="currentColor"
          className={weakAxes.has(axes[i].key) ? "text-text-tertiary" : "text-accent-primary"}
        />
      ))}
      {labelsArr.map((l, i) => (
        <text key={i} x={l.x} y={l.y} fontSize={8.5} textAnchor={l.anchor} fill="currentColor" className="text-text-secondary">
          {l.text}
        </text>
      ))}
    </svg>
  );
}

// AITI (个人内向探索) + P5 思维意象: renders the locally-computed "thinking
// fingerprint" as a 16-imagery card — emblem, imagery name, type-code chip,
// origin, the fixed verdict (plus an optional LLM persona footnote), the four
// evidence-backed axis sliders with clickable evidence chips, and the user's
// top obsessions. Presentational: the host resolves the imagery, fetches the
// footnote, maps the emblem asset, and passes localized labels.

interface AitiCardProps {
  profile?: AitiProfile;
  labels: DashboardLabels["aiti"];
  imagery?: AitiImagery | null;
  /** resolved URL of src/ui/assets/emblems/<emblemId>.png; undefined → placeholder */
  emblemUrl?: string;
  personaNote?: string | null;
  onOpenConversation?: (conversationId: number) => void;
  storage?: StorageApi;
  sendToLabels?: DashboardLabels["library"];
  /** 摘要覆盖率 header: undefined → host doesn't support the coverage API
   * (header hidden); null → loading. */
  coverage?: SummaryCoverage | null;
  /** false → batch button disabled with the configure-LLM hint. */
  llmConfigured?: boolean;
  /** Live batch progress for the 立即生成摘要 run (null → idle). */
  summaryBatch?: SummaryBatchState | null;
  onGenerateSummaries?: () => void;
  onCancelSummaryBatch?: () => void;
  /** 会员门控: true → generation entry disabled with the member-only hint. */
  memberLocked?: boolean;
  /** UI locale for the component-side intro/preliminary copy ("zh" | "en" |
   * "ja" | "ko" or any BCP-47 tag); falls back to navigator.language. */
  locale?: string;
}

export function AitiCard({
  profile,
  labels,
  imagery,
  emblemUrl,
  personaNote,
  onOpenConversation,
  storage,
  sendToLabels,
  coverage,
  llmConfigured,
  summaryBatch,
  onGenerateSummaries,
  onCancelSummaryBatch,
  memberLocked,
  locale,
}: AitiCardProps) {
  type AxisMeta = {
    label: string;
    left: string;
    right: string;
    leftStrength: string;
    rightStrength: string;
  };
  const axisMeta: Record<string, AxisMeta> = {
    depth: {
      label: labels.axisDepthLabel,
      left: labels.axisDepthLeft,
      right: labels.axisDepthRight,
      leftStrength: labels.axisDepthLeftStrength,
      rightStrength: labels.axisDepthRightStrength,
    },
    maker: {
      label: labels.axisMakerLabel,
      left: labels.axisMakerLeft,
      right: labels.axisMakerRight,
      leftStrength: labels.axisMakerLeftStrength,
      rightStrength: labels.axisMakerRightStrength,
    },
    focus: {
      label: labels.axisFocusLabel,
      left: labels.axisFocusLeft,
      right: labels.axisFocusRight,
      leftStrength: labels.axisFocusLeftStrength,
      rightStrength: labels.axisFocusRightStrength,
    },
    affect: {
      label: labels.axisAffectLabel,
      left: labels.axisAffectLeft,
      right: labels.axisAffectRight,
      leftStrength: labels.axisAffectLeftStrength,
      rightStrength: labels.axisAffectRightStrength,
    },
  };

  const [emblemBroken, setEmblemBroken] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [repoQrUrl, setRepoQrUrl] = useState<string | null>(null);
  const [introVisible, setIntroVisible] = useState(false);

  // Component-side copy (intro overlay, replay button, preliminary badge) —
  // labels.aiti is host-supplied and stays untouched.
  const localCopy = aitiLocalCopy(locale);

  // Auto-play the intro on the session's first open of this panel. The
  // played flag flips only when the intro completes or is skipped, so a
  // StrictMode remount or a quick tab switch can't burn the one shot.
  useEffect(() => {
    if (!aitiIntroPlayedThisSession) setIntroVisible(true);
  }, []);
  const closeIntro = useCallback(() => {
    aitiIntroPlayedThisSession = true;
    setIntroVisible(false);
  }, []);
  const replayIntro = useCallback(() => setIntroVisible(true), []);
  const introOverlay = introVisible ? (
    <AitiIntro locale={locale} emblemUrl={emblemUrl} onDone={closeIntro} />
  ) : null;

  // Repo QR for the card footer — dark-on-white tile, theme-independent so it
  // stays scannable; null while generating (footer simply hides it).
  useEffect(() => {
    let alive = true;
    void renderQrDataUrl(VESTI_REPO_URL, 144).then((url) => {
      if (alive) setRepoQrUrl(url);
    });
    return () => {
      alive = false;
    };
  }, []);

  // 摘要覆盖率 header — one slim status row pinned above either state. Only
  // rendered when the host wired the coverage API (undefined → hidden).
  const batchRunning = summaryBatch?.status === "running";
  const coverageHeader =
    coverage !== undefined ? (
      <div className="shrink-0 border-b border-border-subtle px-6 py-3">
        <div className="mx-auto flex max-w-2xl flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <div className="min-w-0">
            {coverage === null ? (
              <p className="flex items-center gap-2 text-[12px] text-text-tertiary">
                <Loader2 className="h-3.5 w-3.5 animate-spin text-accent-primary" strokeWidth={1.75} />
              </p>
            ) : coverage.totalConversations === 0 ? (
              <p className="text-[12px] text-text-tertiary">{labels.coverageEmpty}</p>
            ) : (
              <>
                <p className="text-[12px] text-text-secondary">
                  {labels.coverageSummary
                    .replace("{x}", String(coverage.summarizedCount))
                    .replace("{y}", String(coverage.totalConversations))
                    .replace("{z}", String(coverage.structuredCount))}
                </p>
                {coverage.structuredCount < AITI_MIN_STRUCTURED_SUMMARIES ? (
                  <p className="mt-0.5 text-[11.5px] text-text-tertiary">
                    {labels.coverageNeedMore.replace(
                      "{n}",
                      String(AITI_MIN_STRUCTURED_SUMMARIES - coverage.structuredCount)
                    )}
                  </p>
                ) : coverage.pendingConversationIds.length === 0 ? (
                  <p className="mt-0.5 text-[11.5px] text-text-tertiary">{labels.allSummarized}</p>
                ) : null}
              </>
            )}
          </div>
          {coverage && coverage.pendingConversationIds.length > 0 && onGenerateSummaries ? (
            <div className="flex shrink-0 items-center gap-2">
              {batchRunning && summaryBatch ? (
                <>
                  <span className="inline-flex items-center gap-1.5 text-[12px] text-text-secondary">
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-accent-primary" strokeWidth={1.75} />
                    {labels.generatingSummaries
                      .replace("{done}", String(summaryBatch.done + summaryBatch.failed))
                      .replace("{total}", String(summaryBatch.total))}
                  </span>
                  <button
                    type="button"
                    onClick={onCancelSummaryBatch}
                    className="inline-flex items-center gap-1 rounded-full border border-border-subtle px-3 py-1 text-[12px] text-text-secondary transition-colors hover:text-text-primary"
                  >
                    <Square className="h-3 w-3" strokeWidth={1.75} />
                    {labels.cancelGeneration}
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={onGenerateSummaries}
                  disabled={llmConfigured === false || memberLocked === true}
                  title={
                    memberLocked === true
                      ? labels.memberOnly
                      : llmConfigured === false
                        ? labels.llmMissing
                        : undefined
                  }
                  className="inline-flex items-center gap-1.5 rounded-full bg-accent-primary px-3 py-1.5 text-[12px] font-medium text-text-inverse transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Sparkles className="h-3.5 w-3.5" strokeWidth={1.75} />
                  {labels.generateSummaries}
                </button>
              )}
            </div>
          ) : null}
          {llmConfigured === false &&
          coverage &&
          coverage.pendingConversationIds.length > 0 &&
          !batchRunning ? (
            <p className="w-full text-[11.5px] text-text-tertiary">{labels.llmMissing}</p>
          ) : null}
          {memberLocked === true &&
          coverage &&
          coverage.pendingConversationIds.length > 0 &&
          !batchRunning ? (
            <p className="w-full text-[11.5px] text-text-tertiary">{labels.memberOnly}</p>
          ) : null}
          {!batchRunning && summaryBatch?.status === "done" ? (
            <p className="w-full text-[11.5px] text-text-tertiary">
              {labels.summariesResult
                .replace("{done}", String(summaryBatch.done))
                .replace("{failed}", String(summaryBatch.failed))}
            </p>
          ) : null}
        </div>
      </div>
    ) : null;

  if (!profile || !profile.available) {
    return (
      <div className="relative flex h-full flex-col">
        {introOverlay}
        {coverageHeader}
        <div className="flex flex-1 flex-col items-center justify-center p-10 text-center">
          <div
            className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-accent-primary-light text-accent-primary"
            aria-hidden="true"
          >
            <Sparkles className="h-5 w-5" strokeWidth={1.75} />
          </div>
          <h3 className="text-[15px] font-medium text-text-primary">{labels.title}</h3>
          <p className="mt-2 max-w-md text-[13px] text-text-tertiary">{labels.insufficient}</p>
          {profile ? (
            <p className="mt-2 text-[11.5px] text-text-tertiary">
              {labels.sample.replace("{n}", String(profile.sampleSize))}
            </p>
          ) : null}
        </div>
      </div>
    );
  }

  const weakAxes = new Set(imagery?.weakAxes ?? []);

  // The host's computeAiti (src/ui/aiti) marks profiles built from local
  // message-level signals with `preliminary: true` (初步画像). AitiProfile in
  // types.ts intentionally stays unchanged, so the flag is read structurally.
  const preliminary =
    (profile as AitiProfile & { preliminary?: boolean }).preliminary === true;

  // Legacy localized pole list, kept as the fallback heading when the host
  // couldn't resolve an imagery (unexpected axis set).
  const typeCode = profile.axes
    .map((a) => {
      const meta = axisMeta[a.key];
      // Don't fold an unsupported axis into the "type" — it would read as a
      // confident trait drawn from zero evidence.
      if (!meta || a.hasSignal === false) return null;
      return a.score >= 50 ? meta.right : meta.left;
    })
    .filter(Boolean)
    .join(labels.typeSeparator);

  const handleExport = () => {
    if (!imagery || exporting) return;
    setExporting(true);
    void renderAitiCardImage({
      name: imagery.name,
      code: imagery.code,
      origin: imagery.origin,
      verdict: imagery.verdict,
      personaNote,
      personaNoteLabel: labels.personaNoteLabel,
      mindMapTitle: labels.mindMapTitle,
      repoQrCaption: labels.repoQrCaption,
      obsessionsTitle: labels.obsessionsTitle,
      radarAxes: profile.axes.map((a) => {
        const meta = axisMeta[a.key];
        return {
          score: a.score,
          hasSignal: a.hasSignal,
          weak: weakAxes.has(a.key),
          pole: meta && a.hasSignal !== false ? (a.score >= 50 ? meta.right : meta.left) : "",
        };
      }),
      obsessions: profile.obsessions.map((o) => o.term),
      sampleText: labels.sample.replace("{n}", String(profile.sampleSize)),
      emblemUrl,
    })
      .then((blob) => {
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = `vesti-aiti-${imagery.code}.png`;
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 1_000);
      })
      .catch(() => undefined)
      .finally(() => setExporting(false));
  };

  return (
    <div className="relative flex h-full flex-col">
      {introOverlay}
      {coverageHeader}
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto max-w-2xl">
        {/* Header */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h3 className="text-[15px] font-medium text-text-primary">{labels.title}</h3>
            {preliminary ? (
              <span className="rounded-full border border-border-subtle bg-accent-primary-light px-2.5 py-0.5 text-[11px] text-accent-primary">
                {localCopy.preliminaryBadge}
              </span>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={replayIntro}
              title={localCopy.introReplay}
              className="inline-flex items-center gap-1.5 rounded-full border border-border-subtle px-3 py-1 text-[12px] text-text-secondary transition-colors hover:text-text-primary"
            >
              <RotateCcw strokeWidth={1.75} className="h-3.5 w-3.5" />
              {localCopy.introReplay}
            </button>
            {imagery ? (
              <button
                type="button"
                onClick={handleExport}
                disabled={exporting}
                className="inline-flex items-center gap-1.5 rounded-full border border-border-subtle px-3 py-1 text-[12px] text-text-secondary transition-colors hover:text-text-primary disabled:opacity-50"
              >
                <Download strokeWidth={1.75} className="h-3.5 w-3.5" />
                {labels.exportCard}
              </button>
            ) : null}
            {storage && sendToLabels ? (
              <SendToMenu
                storage={storage}
                labels={sendToLabels}
                payload={{
                  title: labels.title,
                  markdown: buildAitiMarkdown(profile, labels, { imagery, personaNote }),
                }}
              />
            ) : null}
          </div>
        </div>
        <p className="mt-1 text-[12px] text-text-tertiary">{labels.subtitle}</p>

        {/* Hero: emblem + imagery name + type-code chip + origin */}
        <div className="mt-5 rounded-2xl border border-border-subtle bg-bg-surface-card p-6">
          <div className="flex items-center gap-5">
            {imagery ? (
              emblemUrl && !emblemBroken ? (
                <img
                  key={emblemUrl}
                  src={emblemUrl}
                  alt=""
                  onError={() => setEmblemBroken(true)}
                  className="h-20 w-20 shrink-0 rounded-2xl object-cover"
                />
              ) : (
                <div
                  className="flex h-20 w-20 shrink-0 items-center justify-center rounded-full bg-accent-primary-light"
                  aria-hidden="true"
                >
                  <span className="font-vesti-serif text-[28px] leading-none text-accent-primary">
                    {imagery.name.charAt(0)}
                  </span>
                </div>
              )
            ) : null}
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <h2 className="font-vesti-serif text-[26px] leading-tight tracking-tight text-text-primary">
                  {imagery ? imagery.name : typeCode}
                </h2>
                {imagery ? (
                  <span className="rounded-full border border-border-subtle px-2.5 py-0.5 font-vesti-serif text-[12px] tracking-[0.2em] text-text-secondary">
                    {imagery.code}
                  </span>
                ) : null}
              </div>
              <div className="mt-1.5 text-[11.5px] text-text-tertiary">
                {imagery ? `${imagery.origin} · ` : ""}
                {labels.sample.replace("{n}", String(profile.sampleSize))}
              </div>
            </div>
          </div>
          {imagery?.faint ? (
            <p className="mt-4 border-t border-border-subtle pt-3 text-[11.5px] text-text-tertiary">
              {labels.imageryFaint}
            </p>
          ) : null}
        </div>

        {/* Verdict: the fixed 判词 is the visual weight; the LLM persona
            footnote (when available) gets its own quote-styled block — eyebrow
            label + divider + accent quote bar so it reads as a voiced note,
            not trailing metadata */}
        {imagery ? (
          <figure className="mt-5 rounded-2xl border border-border-subtle bg-bg-surface-card px-6 py-5">
            <blockquote className="font-serif text-[16px] italic leading-relaxed text-text-primary">
              {imagery.verdict}
            </blockquote>
            {personaNote ? (
              <figcaption className="mt-4 border-t border-border-subtle pt-4">
                <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-[0.16em] text-text-tertiary">
                  <Quote className="h-3.5 w-3.5 text-accent-primary" strokeWidth={1.75} aria-hidden="true" />
                  {labels.personaNoteLabel}
                </div>
                <blockquote className="mt-2 border-l-2 border-accent-primary pl-3 font-serif text-[14px] italic leading-relaxed text-text-primary">
                  {personaNote}
                </blockquote>
              </figcaption>
            ) : null}
          </figure>
        ) : null}

        {/* 思维图: radar overview of the four axes — clicking the panel
            replays the 开场动画 on demand */}
        <div
          className="mt-5 cursor-pointer rounded-2xl border border-border-subtle bg-bg-surface-card px-6 py-5"
          onClick={replayIntro}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") replayIntro();
          }}
          title={localCopy.introReplay}
        >
          <div className="text-[11px] uppercase tracking-[0.16em] text-text-tertiary">
            {labels.mindMapTitle}
          </div>
          <div className="mt-2 flex justify-center">
            <AitiRadar axes={profile.axes} axisMeta={axisMeta} weakAxes={weakAxes} />
          </div>
        </div>

        {/* Empowering strengths — the dominant pole of each axis, framed positively */}
        <div className="mt-5">
          <div className="text-[13px] font-medium text-text-primary">{labels.strengthsTitle}</div>
          <p className="mt-1 text-[12px] text-text-tertiary">{labels.empoweringIntro}</p>
          <ul className="mt-3 flex flex-col gap-2">
            {profile.axes.map((axis) => {
              const meta = axisMeta[axis.key];
              if (!meta) return null;
              if (axis.hasSignal === false) {
                return (
                  <li key={axis.key} className="flex items-start gap-2.5">
                    <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-text-tertiary/40" />
                    <span className="text-[13px] leading-relaxed text-text-tertiary">
                      {meta.label} — {labels.axisNeedsSignal}
                    </span>
                  </li>
                );
              }
              const strength = axis.score >= 50 ? meta.rightStrength : meta.leftStrength;
              return (
                <li key={axis.key} className="flex items-start gap-2.5">
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent-primary" />
                  <span className="text-[13px] leading-relaxed text-text-primary">{strength}</span>
                </li>
              );
            })}
          </ul>
        </div>

        {/* Axes: sliders + clickable evidence chips */}
        <div className="mt-5 flex flex-col gap-4">
          {profile.axes.map((axis) => {
            const meta = axisMeta[axis.key];
            if (!meta) return null;
            const muted = axis.hasSignal === false;
            const faint = !muted && weakAxes.has(axis.key);
            return (
              <div key={axis.key}>
                <div className="mb-1 flex items-baseline justify-between">
                  <span className="text-[12px] font-medium text-text-secondary">{meta.label}</span>
                  <span className="text-[11px] text-text-tertiary">
                    {muted
                      ? labels.axisNeedsSignal
                      : faint
                        ? labels.axisSignalFaint
                        : labels.evidence.replace("{n}", String(axis.evidenceConversationIds.length))}
                  </span>
                </div>
                <div className="relative h-1.5 rounded-full bg-bg-tertiary">
                  <div
                    className={`absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full ${
                      muted ? "bg-text-tertiary/40" : faint ? "bg-accent-primary/50" : "bg-accent-primary"
                    }`}
                    style={{ left: `${muted ? 50 : axis.score}%` }}
                  />
                </div>
                <div className="mt-1 flex justify-between text-[11px] text-text-tertiary">
                  <span className={!muted && axis.score < 50 ? "font-medium text-text-secondary" : ""}>
                    {meta.left}
                  </span>
                  <span className={!muted && axis.score >= 50 ? "font-medium text-text-secondary" : ""}>
                    {meta.right}
                  </span>
                </div>
                {!muted && axis.evidenceConversationIds.length > 0 ? (
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    <span className="text-[10.5px] text-text-tertiary">{labels.evidenceBecause}</span>
                    {axis.evidenceConversationIds.map((conversationId) =>
                      onOpenConversation ? (
                        <button
                          key={conversationId}
                          type="button"
                          onClick={() => onOpenConversation(conversationId)}
                          className="rounded-full border border-border-subtle px-2 py-0.5 text-[10.5px] text-text-tertiary transition-colors hover:border-border-default hover:text-text-secondary"
                        >
                          {labels.evidenceConversation.replace("{id}", String(conversationId))}
                        </button>
                      ) : (
                        <span
                          key={conversationId}
                          className="rounded-full border border-border-subtle px-2 py-0.5 text-[10.5px] text-text-tertiary"
                        >
                          {labels.evidenceConversation.replace("{id}", String(conversationId))}
                        </span>
                      ),
                    )}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>

        {/* Obsessions */}
        {profile.obsessions.length > 0 && (
          <div className="mt-6">
            <div className="mb-2 text-[12px] font-medium text-text-secondary">
              {labels.obsessionsTitle}
            </div>
            <div className="flex flex-wrap gap-2">
              {profile.obsessions.map((o) => (
                <span
                  key={o.term}
                  className="inline-flex items-center gap-1.5 rounded-full border border-border-subtle bg-bg-surface-card px-3 py-1 text-[12px] text-text-primary"
                >
                  {o.term}
                  <span className="text-[10.5px] text-text-tertiary">{o.count}</span>
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Footer: VESTI GitHub repo QR, bottom-right — dark-on-white tile so it
            scans in either theme */}
        <div className="mt-6 flex items-center justify-end gap-3 border-t border-border-subtle pt-4">
          <div className="text-right">
            <div className="text-[11px] text-text-tertiary">{labels.repoQrCaption}</div>
            <div className="mt-0.5 text-[10.5px] text-text-tertiary">{VESTI_REPO_SHORT}</div>
          </div>
          {repoQrUrl ? (
            <img
              src={repoQrUrl}
              alt={labels.repoQrCaption}
              className="h-16 w-16 shrink-0 rounded-lg border border-border-subtle bg-white p-1"
            />
          ) : null}
        </div>
        </div>
      </div>
    </div>
  );
}
