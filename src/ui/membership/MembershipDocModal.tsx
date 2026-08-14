import { X } from "lucide-react";
import { useEffect } from "react";
import type { SupportedLocale } from "../i18n/locales";
import { MEMBERSHIP_COPY } from "./copy";

export interface MembershipDocModalProps {
  open: boolean;
  onClose: () => void;
  locale: SupportedLocale;
}

/**
 * 会员与积分说明 — the membership/credits explainer as a card-aesthetic
 * overlay (vesti-serif headings, rounded-card, subtle borders).
 */
export function MembershipDocModal({ open, onClose, locale }: MembershipDocModalProps) {
  const copy = MEMBERSHIP_COPY[locale] ?? MEMBERSHIP_COPY.en;

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      role="presentation"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4"
      onClick={onClose}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label={copy.creditsDocTitle}
        className="flex max-h-[82vh] w-full max-w-[560px] flex-col overflow-hidden rounded-card border border-border-subtle bg-bg-surface-card shadow-paper"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-border-subtle px-7 py-5">
          <div>
            <p className="font-mono text-[11px] font-medium uppercase tracking-[0.2em] text-text-tertiary">
              MEMBERSHIP &amp; CREDITS
            </p>
            <h2 className="mt-1 font-vesti-serif text-[24px] text-text-primary">
              {copy.creditsDocTitle}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={copy.creditsDocClose}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border-subtle bg-bg-primary text-text-secondary transition-colors hover:bg-bg-surface-card-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus"
          >
            <X className="h-4 w-4" strokeWidth={1.8} aria-hidden="true" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-7 py-5">
          {copy.creditsDocGreeting.split(/\n+/).map((line) => (
            <p key={line} className="mb-2 text-[13.5px] font-sans leading-6 text-text-primary">
              {line}
            </p>
          ))}
          <div className="mt-5 space-y-5">
            {copy.creditsDocSections.map((section) => (
              <section key={section.heading}>
                <h3 className="font-vesti-serif text-[16px] text-text-primary">
                  【{section.heading}】
                </h3>
                <p className="mt-1.5 text-[13px] font-sans leading-6 text-text-secondary">
                  {section.body}
                </p>
              </section>
            ))}
          </div>
        </div>

        <footer className="shrink-0 border-t border-border-subtle px-7 py-4">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex min-h-10 items-center justify-center rounded-lg border border-border-default bg-bg-primary px-4 py-2 text-[12px] font-sans font-semibold text-text-primary transition-colors hover:bg-bg-surface-card-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus"
          >
            {copy.creditsDocClose}
          </button>
        </footer>
      </section>
    </div>
  );
}
