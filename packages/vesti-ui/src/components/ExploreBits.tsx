import type { ReactNode } from "react";
import { AlertTriangle, type LucideIcon } from "lucide-react";
import type { RelatedConversation } from "../types";

// Explore 子页共享视觉件 — the 学习 (Learn) and 圆桌 (Roundtable) panes borrow
// each other's best patterns, so the recurring bits live here once instead of
// drifting apart in two copies: the "这是什么" info bar, the LLM-missing gate
// note, the icon-circle empty state, the recalled-source chips and the dotted
// bullet section used by both result views.

/** 说明条: one-sentence "what this is" + an optional data-provenance line. */
export function ExploreInfoBar({
  Icon,
  intro,
  sourceLine,
}: {
  Icon: LucideIcon;
  intro: string;
  sourceLine?: string;
}) {
  return (
    <div className="mt-3 flex items-start gap-2.5 rounded-xl border border-border-subtle bg-bg-surface-card px-3.5 py-3">
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-accent-primary" strokeWidth={1.75} />
      <div className="min-w-0">
        <p className="text-[12px] leading-relaxed text-text-secondary">{intro}</p>
        {sourceLine ? (
          <p className="mt-1 text-[11.5px] text-text-tertiary">{sourceLine}</p>
        ) : null}
      </div>
    </div>
  );
}

/** LLM 未配置引导: explain what's missing instead of offering a dead button.
 * The outer margin is the caller's (it differs per placement). */
export function ExploreGateNote({ text, className = "mt-4" }: { text: string; className?: string }) {
  return (
    <div
      className={`${className} flex items-start gap-2.5 rounded-xl border border-border-subtle bg-bg-surface-card px-3.5 py-3`}
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" strokeWidth={1.75} />
      <p className="text-[12px] leading-relaxed text-text-secondary">{text}</p>
    </div>
  );
}

/** Icon-circle empty/insufficient state. `compact` drops the full-height
 * centering for panes where the hint sits mid-flow (roundtable). */
export function ExploreEmptyState({
  Icon,
  title,
  body,
  action,
  compact = false,
}: {
  Icon: LucideIcon;
  title?: string;
  body: string;
  action?: React.ReactNode;
  compact?: boolean;
}) {
  return (
    <div
      className={
        compact
          ? "flex flex-col items-center px-6 py-10 text-center"
          : "flex h-full flex-col items-center justify-center p-10 text-center"
      }
    >
      <div
        className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-accent-primary-light text-accent-primary"
        aria-hidden="true"
      >
        <Icon className="h-5 w-5" strokeWidth={1.75} />
      </div>
      {title ? <h3 className="text-[15px] font-medium text-text-primary">{title}</h3> : null}
      <p className="mt-2 max-w-md text-[13px] text-text-tertiary">{body}</p>
      {action}
    </div>
  );
}

/** 召回来源 chips: the conversations a run was grounded on, as jump targets. */
export function ExploreSourceChips({
  sources,
  onOpenConversation,
}: {
  sources: RelatedConversation[];
  onOpenConversation?: (conversationId: number) => void;
}) {
  if (sources.length === 0 || !onOpenConversation) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {sources.map((source) => (
        <button
          key={source.id}
          type="button"
          onClick={() => onOpenConversation(source.id)}
          title={source.title}
          className="max-w-[220px] truncate rounded-full border border-border-subtle px-2.5 py-1 text-[11px] text-text-tertiary transition-colors hover:bg-bg-tertiary hover:text-accent-primary"
        >
          {source.title}
        </button>
      ))}
    </div>
  );
}

/** Dotted bullet section: a small caption over a list of dot-prefixed items
 * (roundtable synthesis sections, learn deep-dive sections). */
export function ExploreBulletSection({ title, items }: { title: string; items: string[] }) {
  if (!items || items.length === 0) return null;
  return (
    <div className="mt-3">
      <div className="text-[12px] font-medium text-text-secondary">{title}</div>
      <ul className="mt-1 flex flex-col gap-1">
        {items.map((it, i) => (
          <li key={i} className="flex items-start gap-2 text-[13px] leading-relaxed text-text-primary">
            <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent-primary/60" />
            <span>{it}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
