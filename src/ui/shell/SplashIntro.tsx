import { useEffect, useMemo, useState } from "react";
import { LOGO_BASE64 } from "../logo";
import { useI18n } from "../i18n";
import type { SupportedLocale } from "../i18n/locales";

/**
 * App-launch splash: a tiny knowledge-graph animation (nodes wake up, edges
 * draw themselves toward the owl) that plays once per launch while the shell
 * mounts underneath. Pure CSS/SVG — no animation dependency. Click skips.
 */

const SPLASH_COPY: Record<SupportedLocale, { tagline: string; skip: string }> = {
  zh: { tagline: "管理你和 AI 交互的一切", skip: "跳过" },
  en: { tagline: "Everything between you and your AI", skip: "Skip" },
  ja: { tagline: "あなたと AI のすべてをひとつに", skip: "スキップ" },
  ko: { tagline: "당신과 AI 사이의 모든 것", skip: "건너뛰기" },
};

/** Node layout around the center owl, viewBox 320x200. */
const NODES: Array<{ x: number; y: number; r: number; delay: number }> = [
  { x: 40, y: 46, r: 5, delay: 0.15 },
  { x: 84, y: 150, r: 4, delay: 0.35 },
  { x: 62, y: 104, r: 3.5, delay: 0.55 },
  { x: 278, y: 52, r: 5, delay: 0.3 },
  { x: 252, y: 146, r: 4, delay: 0.5 },
  { x: 288, y: 104, r: 3.5, delay: 0.7 },
  { x: 122, y: 34, r: 3.5, delay: 0.8 },
  { x: 200, y: 168, r: 3.5, delay: 0.9 },
];

const CENTER = { x: 160, y: 100 };
const HOLD_MS = 2_400;
const FADE_MS = 450;

export function SplashIntro({ onDone }: { onDone: () => void }) {
  const { locale } = useI18n();
  const copy = SPLASH_COPY[locale as SupportedLocale] ?? SPLASH_COPY.en;
  const [fading, setFading] = useState(false);

  useEffect(() => {
    const hold = window.setTimeout(() => setFading(true), HOLD_MS);
    return () => window.clearTimeout(hold);
  }, []);

  useEffect(() => {
    if (!fading) return;
    const done = window.setTimeout(onDone, FADE_MS);
    return () => window.clearTimeout(done);
  }, [fading, onDone]);

  const skip = () => {
    if (!fading) setFading(true);
  };

  const edges = useMemo(
    () =>
      NODES.map((node) => ({
        x1: node.x,
        y1: node.y,
        x2: CENTER.x,
        y2: CENTER.y,
        delay: node.delay + 0.25,
      })),
    [],
  );

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={copy.skip}
      onClick={skip}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " " || event.key === "Escape") {
          event.preventDefault();
          skip();
        }
      }}
      className={`fixed inset-0 z-[80] flex cursor-pointer flex-col items-center justify-center bg-bg-app transition-opacity ${
        fading ? "opacity-0" : "opacity-100"
      }`}
      style={{ transitionDuration: `${FADE_MS}ms` }}
    >
      <style>{`
        @keyframes vesti-splash-node {
          from { opacity: 0; transform: scale(0.4); }
          to { opacity: 1; transform: scale(1); }
        }
        @keyframes vesti-splash-edge {
          from { stroke-dashoffset: var(--edge-len); }
          to { stroke-dashoffset: 0; }
        }
        @keyframes vesti-splash-core {
          0% { opacity: 0; transform: scale(0.7); }
          60% { opacity: 1; transform: scale(1.06); }
          100% { opacity: 1; transform: scale(1); }
        }
        @keyframes vesti-splash-text {
          from { opacity: 0; transform: translateY(6px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>

      <svg
        width="320"
        height="200"
        viewBox="0 0 320 200"
        aria-hidden="true"
        className="mb-2"
      >
        {edges.map((edge, index) => {
          const length = Math.hypot(edge.x2 - edge.x1, edge.y2 - edge.y1);
          return (
            <line
              key={`edge-${index}`}
              x1={edge.x1}
              y1={edge.y1}
              x2={edge.x2}
              y2={edge.y2}
              className="stroke-accent-primary"
              strokeWidth={1}
              strokeDasharray={length}
              strokeDashoffset={length}
              opacity={0.35}
              style={{
                ["--edge-len" as string]: length,
                animation: `vesti-splash-edge 700ms ease-out ${edge.delay}s forwards`,
              }}
            />
          );
        })}
        {NODES.map((node, index) => (
          <circle
            key={`node-${index}`}
            cx={node.x}
            cy={node.y}
            r={node.r}
            className="fill-accent-primary"
            opacity={0}
            style={{
              transformOrigin: `${node.x}px ${node.y}px`,
              animation: `vesti-splash-node 420ms ease-out ${node.delay}s forwards`,
            }}
          />
        ))}
        <g
          style={{
            transformOrigin: `${CENTER.x}px ${CENTER.y}px`,
            animation: "vesti-splash-core 700ms ease-out 0s forwards",
            opacity: 0,
          }}
        >
          <circle
            cx={CENTER.x}
            cy={CENTER.y}
            r={30}
            className="fill-accent-primary-light stroke-accent-primary"
            strokeWidth={1.5}
          />
          <image
            href={LOGO_BASE64}
            x={CENTER.x - 17}
            y={CENTER.y - 17}
            width={34}
            height={34}
          />
        </g>
      </svg>

      <p
        className="font-serif text-[22px] tracking-wide text-text-primary"
        style={{ animation: "vesti-splash-text 600ms ease-out 0.9s both" }}
      >
        Vesti
      </p>
      <p
        className="mt-1 text-[13px] font-sans text-text-tertiary"
        style={{ animation: "vesti-splash-text 600ms ease-out 1.15s both" }}
      >
        {copy.tagline}
      </p>
    </div>
  );
}
