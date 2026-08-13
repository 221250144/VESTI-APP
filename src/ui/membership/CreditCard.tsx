import { BookOpenText, Coins, LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import type { CreditBalance, LlmAccessMode, MembershipStatus } from "../../shared/contracts";
import type { SupportedLocale } from "../i18n/locales";
import {
  formatCreditCount,
  formatCreditReset,
  MEMBERSHIP_COPY,
} from "./copy";
import { MembershipDocModal } from "./MembershipDocModal";

export interface CreditCardProps {
  membership: MembershipStatus;
  llmMode: LlmAccessMode;
  locale: SupportedLocale;
}

/**
 * 积分卡 (settings): current plan, credit balance with a progress bar, cycle
 * reset, the BYOK note, and the 会员与积分说明 doc modal.
 */
export function CreditCard({ membership, llmMode, locale }: CreditCardProps) {
  const copy = MEMBERSHIP_COPY[locale] ?? MEMBERSHIP_COPY.en;
  const [balance, setBalance] = useState<CreditBalance | null>(null);
  const [failed, setFailed] = useState(false);
  const [docOpen, setDocOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      window.vestiCredits
        .getBalance()
        .then((next) => {
          if (cancelled) return;
          setBalance(next);
          setFailed(false);
        })
        .catch(() => {
          if (!cancelled) setFailed(true);
        });
    };
    load();
    const unsubscribe = window.vestiCredits.onChanged((next) => {
      if (!cancelled) setBalance(next);
    });
    // Membership flips (expiry downgrade) re-derive the tier main-side; poll
    // once here so an open settings page picks it up without a broadcast.
    const poll = window.setInterval(load, 60_000);
    return () => {
      cancelled = true;
      unsubscribe();
      window.clearInterval(poll);
    };
  }, []);

  const byok = llmMode === "custom_byok";
  const remaining = balance?.remaining ?? 0;
  const quota = balance?.quota ?? 0;
  const percent = quota > 0 ? Math.min(100, Math.max(0, (remaining / quota) * 100)) : 0;

  return (
    <section className="rounded-card border border-border-subtle bg-bg-surface-card p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="font-mono text-[11px] font-medium uppercase tracking-[0.2em] text-text-tertiary">
            CREDITS
          </p>
          <h2 className="mt-1 font-vesti-serif text-[22px] text-text-primary">{copy.creditsTitle}</h2>
          <p className="mt-2 text-[13px] font-sans leading-relaxed text-text-secondary">
            {copy.creditsDescription}
          </p>
        </div>
        <span
          className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[11px] font-sans font-semibold ${
            membership.active
              ? "border-success/25 bg-success/10 text-success"
              : "border-warning/28 bg-warning/10 text-warning"
          }`}
        >
          <Coins className="h-3.5 w-3.5" strokeWidth={1.8} aria-hidden="true" />
          {membership.active ? copy.betaMember : copy.freePlan}
        </span>
      </div>

      {byok ? (
        <p className="mt-5 rounded-xl border border-border-subtle bg-bg-primary px-4 py-3.5 text-[13px] font-sans leading-relaxed text-text-secondary">
          {copy.creditsByok}
        </p>
      ) : balance === null ? (
        <div className="mt-5 flex items-center gap-2 rounded-xl border border-border-subtle bg-bg-primary px-4 py-3.5 text-[12px] font-sans text-text-tertiary">
          {failed ? (
            copy.errors.unexpected
          ) : (
            <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
          )}
        </div>
      ) : (
        <div className="mt-5 rounded-xl border border-border-subtle bg-bg-primary p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="font-vesti-serif text-[24px] text-text-primary">
              {copy.creditsRemaining.replace("{remaining}", formatCreditCount(remaining, locale))}
            </p>
            <p className="text-[12px] font-sans text-text-tertiary">
              {copy.creditsQuota.replace("{quota}", formatCreditCount(quota, locale))}
            </p>
          </div>
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={quota}
            aria-valuenow={remaining}
            className="mt-3 h-2 overflow-hidden rounded-full bg-bg-surface-hover"
          >
            <div
              className={`h-full rounded-full transition-[width] ${
                remaining === 0 ? "bg-danger" : "bg-accent-primary"
              }`}
              style={{ width: `${percent}%` }}
            />
          </div>
          <p className="mt-2 text-[11px] font-sans text-text-tertiary">
            {copy.creditsReset.replace("{date}", formatCreditReset(balance.resetsAt, locale))}
          </p>
          {remaining === 0 ? (
            <p role="status" className="mt-2 text-[12px] font-sans leading-5 text-warning">
              {copy.creditsExhausted}
            </p>
          ) : null}
        </div>
      )}

      <div className="mt-5 border-t border-border-subtle pt-4">
        <button
          type="button"
          onClick={() => setDocOpen(true)}
          className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-border-default bg-bg-primary px-3.5 py-2 text-[12px] font-sans font-semibold text-text-primary transition-colors hover:bg-bg-surface-card-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus"
        >
          <BookOpenText className="h-4 w-4" strokeWidth={1.7} aria-hidden="true" />
          {copy.creditsDocButton}
        </button>
      </div>

      <MembershipDocModal open={docOpen} onClose={() => setDocOpen(false)} locale={locale} />
    </section>
  );
}
