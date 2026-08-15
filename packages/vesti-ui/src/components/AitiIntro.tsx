// AITI 开场动画 — "开启你的 AI 人格 / Unfold your AI persona". A short,
// dependency-free CSS/SVG sequence shown over the AITI panel: the four-axis
// radar draws itself from nothing, the persona emblem surfaces, then the
// tagline rises. ~2.2s total, click anywhere (or the 跳过 pill) to skip,
// collapses to a quick fade under prefers-reduced-motion. The AitiCard owns
// when it appears (once per session, or on explicit replay); this component
// only plays and reports `onDone`.
//
// Copy lives in the component-side dictionary below (DOCK_COPY pattern,
// zh/en/ja/ko) — the card resolves it via aitiLocalCopy(locale).

import { useEffect, useRef, useState } from "react";
import { Sparkles, X } from "lucide-react";

export interface AitiLocalCopy {
  /** intro headline, e.g. "开启你的 AI 人格" */
  introTitle: string;
  /** intro tagline under the headline */
  introSubtitle: string;
  /** skip affordance */
  introSkip: string;
  /** replay button on the card header */
  introReplay: string;
  /** badge on a preliminary (local-signal) profile */
  preliminaryBadge: string;
}

const AITI_LOCAL_COPY: Record<"zh" | "en" | "ja" | "ko", AitiLocalCopy> = {
  zh: {
    introTitle: "开启你的 AI 人格",
    introSubtitle: "Unfold your AI persona — 四轴思维指纹，由你的对话显形",
    introSkip: "跳过",
    introReplay: "重看开场",
    preliminaryBadge: "初步画像 · 随着摘要增多会更准",
  },
  en: {
    introTitle: "Unfold your AI persona",
    introSubtitle: "Four axes of your thinking, drawn from your own conversations",
    introSkip: "Skip",
    introReplay: "Replay intro",
    preliminaryBadge: "Preliminary profile · sharpens as summaries grow",
  },
  ja: {
    introTitle: "AI ペルソナを開く",
    introSubtitle: "Unfold your AI persona — 4 軸の思考指紋が浮かび上がる",
    introSkip: "スキップ",
    introReplay: "イントロを再生",
    preliminaryBadge: "予備プロファイル · 要約が増えると精度が上がります",
  },
  ko: {
    introTitle: "AI 페르소나를 펼쳐보세요",
    introSubtitle: "Unfold your AI persona — 네 개의 축으로 그려지는 사고 지문",
    introSkip: "건너뛰기",
    introReplay: "인트로 다시 보기",
    preliminaryBadge: "예비 프로필 · 요약이 늘어나면 더 정확해집니다",
  },
};

/** Resolve the component-side copy: explicit locale first, then
 * navigator.language, English as the floor. */
export function aitiLocalCopy(locale?: string): AitiLocalCopy {
  const raw = (locale ?? (typeof navigator !== "undefined" ? navigator.language : "en")).toLowerCase();
  if (raw.startsWith("zh")) return AITI_LOCAL_COPY.zh;
  if (raw.startsWith("ja")) return AITI_LOCAL_COPY.ja;
  if (raw.startsWith("ko")) return AITI_LOCAL_COPY.ko;
  return AITI_LOCAL_COPY.en;
}

// Keyframes are injected once with the component — scoped names, no global
// theme edits. All animations use `both` fill so elements hold their pre/
// post state through the staggered delays.
const AITI_INTRO_CSS = `
@keyframes aiti-intro-draw { to { stroke-dashoffset: 0; } }
@keyframes aiti-intro-unfold {
  0% { opacity: 0; transform: scale(0); }
  100% { opacity: 1; transform: scale(1); }
}
@keyframes aiti-intro-fade { to { opacity: 1; } }
@keyframes aiti-intro-rise {
  from { opacity: 0; transform: translateY(10px); }
  to { opacity: 1; transform: translateY(0); }
}
.aiti-intro-ring { stroke-dasharray: 400; stroke-dashoffset: 400; animation: aiti-intro-draw 0.8s ease-out both; }
.aiti-intro-spoke { stroke-dasharray: 130; stroke-dashoffset: 130; animation: aiti-intro-draw 0.5s ease-out both; }
.aiti-intro-shape { opacity: 0; transform: scale(0); transform-box: fill-box; transform-origin: center; animation: aiti-intro-unfold 0.7s cubic-bezier(0.2, 0.9, 0.3, 1.15) both; }
.aiti-intro-dot { opacity: 0; animation: aiti-intro-fade 0.3s ease-out both; }
.aiti-intro-rise { opacity: 0; animation: aiti-intro-rise 0.55s ease-out both; }
@media (prefers-reduced-motion: reduce) {
  .aiti-intro-ring, .aiti-intro-spoke, .aiti-intro-shape, .aiti-intro-dot, .aiti-intro-rise {
    animation-duration: 0.01s !important; animation-delay: 0s !important;
  }
}
`;

const TOTAL_MS = 2200;
const LEAVE_MS = 250;
const REDUCED_MS = 350;

export interface AitiIntroProps {
  /** "zh" | "en" | "ja" | "ko" or any BCP-47 tag; navigator fallback */
  locale?: string;
  /** persona emblem URL; undefined → accent placeholder with a spark */
  emblemUrl?: string;
  /** fired once, on completion or skip */
  onDone: () => void;
}

export function AitiIntro({ locale, emblemUrl, onDone }: AitiIntroProps) {
  const copy = aitiLocalCopy(locale);
  const [leaving, setLeaving] = useState(false);
  const [emblemBroken, setEmblemBroken] = useState(false);
  // The parent re-renders while the intro plays; keep the latest onDone
  // without re-arming the timers.
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  const finishedRef = useRef(false);

  useEffect(() => {
    const reduced =
      typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    const total = reduced ? REDUCED_MS : TOTAL_MS;
    const leaveTimer = setTimeout(() => setLeaving(true), Math.max(0, total - LEAVE_MS));
    const doneTimer = setTimeout(() => {
      if (finishedRef.current) return;
      finishedRef.current = true;
      onDoneRef.current();
    }, total);
    return () => {
      clearTimeout(leaveTimer);
      clearTimeout(doneTimer);
    };
  }, []);

  const skip = () => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    setLeaving(true);
    onDoneRef.current();
  };

  // Four-axis radar geometry (same layout as the card's AitiRadar).
  const cx = 100;
  const cy = 100;
  const maxR = 60;
  const rad = (d: number) => (d * Math.PI) / 180;
  const at = (frac: number, i: number) => ({
    x: cx + frac * maxR * Math.cos(rad(-90 + i * 90)),
    y: cy + frac * maxR * Math.sin(rad(-90 + i * 90)),
  });
  const ring = (frac: number) =>
    [0, 1, 2, 3].map((i) => { const p = at(frac, i); return `${p.x.toFixed(1)},${p.y.toFixed(1)}`; }).join(" ");
  // Showcase persona shape for the reveal (neutral, mildly deep/maker).
  const showcase = [0.78, 0.58, 0.7, 0.62];
  const shapePts = showcase
    .map((f, i) => { const p = at(f, i); return `${p.x.toFixed(1)},${p.y.toFixed(1)}`; })
    .join(" ");

  return (
    <div
      role="button"
      tabIndex={-1}
      aria-label={copy.introSkip}
      onClick={skip}
      className={`absolute inset-0 z-20 flex cursor-pointer flex-col items-center justify-center bg-bg-app/95 backdrop-blur-sm transition-opacity duration-200 ${
        leaving ? "opacity-0" : "opacity-100"
      }`}
    >
      <style>{AITI_INTRO_CSS}</style>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          skip();
        }}
        className="absolute right-4 top-4 inline-flex items-center gap-1 rounded-full border border-border-subtle px-3 py-1 text-[12px] text-text-secondary transition-colors hover:text-text-primary"
      >
        <X className="h-3 w-3" strokeWidth={1.75} />
        {copy.introSkip}
      </button>

      <svg viewBox="0 0 200 200" className="h-44 w-44" aria-hidden="true">
        {[0.33, 0.66, 1].map((f, gi) => (
          <polygon
            key={gi}
            points={ring(f)}
            fill="none"
            stroke="currentColor"
            strokeWidth={0.6}
            className="aiti-intro-ring text-border-subtle"
            style={{ animationDelay: `${gi * 120}ms` }}
          />
        ))}
        {[0, 1, 2, 3].map((i) => {
          const p = at(1, i);
          return (
            <line
              key={i}
              x1={cx}
              y1={cy}
              x2={p.x}
              y2={p.y}
              stroke="currentColor"
              strokeWidth={0.6}
              className="aiti-intro-spoke text-border-subtle"
              style={{ animationDelay: `${300 + i * 80}ms` }}
            />
          );
        })}
        <polygon
          points={shapePts}
          fill="currentColor"
          fillOpacity={0.22}
          stroke="currentColor"
          strokeWidth={1.5}
          className="aiti-intro-shape text-accent-primary"
          style={{ animationDelay: "750ms" }}
        />
        {showcase.map((f, i) => {
          const p = at(f, i);
          return (
            <circle
              key={i}
              cx={p.x}
              cy={p.y}
              r={2.5}
              fill="currentColor"
              className="aiti-intro-dot text-accent-primary"
              style={{ animationDelay: `${1150 + i * 100}ms` }}
            />
          );
        })}
      </svg>

      <div
        className="aiti-intro-rise mt-5 flex items-center gap-3"
        style={{ animationDelay: "1250ms" }}
      >
        {emblemUrl && !emblemBroken ? (
          <img
            src={emblemUrl}
            alt=""
            onError={() => setEmblemBroken(true)}
            className="h-14 w-14 rounded-2xl object-cover"
          />
        ) : (
          <div
            className="flex h-14 w-14 items-center justify-center rounded-full bg-accent-primary-light text-accent-primary"
            aria-hidden="true"
          >
            <Sparkles className="h-6 w-6" strokeWidth={1.75} />
          </div>
        )}
        <h2 className="font-vesti-serif text-[24px] leading-tight tracking-tight text-text-primary">
          {copy.introTitle}
        </h2>
      </div>
      <p
        className="aiti-intro-rise mt-3 max-w-sm px-6 text-center text-[13px] leading-relaxed text-text-tertiary"
        style={{ animationDelay: "1650ms" }}
      >
        {copy.introSubtitle}
      </p>
    </div>
  );
}
