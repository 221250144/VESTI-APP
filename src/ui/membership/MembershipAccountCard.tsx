import { CalendarDays, Check, LoaderCircle, LogOut, UserRound } from "lucide-react";
import { useState } from "react";
import type { MembershipStatus } from "../../shared/contracts";
import type { SupportedLocale } from "../i18n/locales";
import {
  formatMembershipDate,
  formatRemainingDays,
  MEMBERSHIP_COPY,
} from "./copy";

export interface MembershipAccountCardProps {
  status: MembershipStatus;
  onLogout: () => void | Promise<void>;
  locale: SupportedLocale;
}

export function MembershipAccountCard({
  status,
  onLogout,
  locale,
}: MembershipAccountCardProps) {
  const copy = MEMBERSHIP_COPY[locale] ?? MEMBERSHIP_COPY.en;
  const [loggingOut, setLoggingOut] = useState(false);
  const [error, setError] = useState(false);

  const logout = async () => {
    if (loggingOut) return;
    setLoggingOut(true);
    setError(false);
    try {
      await onLogout();
    } catch {
      setError(true);
    } finally {
      setLoggingOut(false);
    }
  };

  return (
    <section className="rounded-card border border-border-subtle bg-bg-surface-card p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="font-mono text-[11px] font-medium uppercase tracking-[0.2em] text-text-tertiary">
            MEMBERSHIP
          </p>
          <h2 className="mt-1 font-vesti-serif text-[22px] text-text-primary">{copy.accountTitle}</h2>
          <p className="mt-2 text-[13px] font-sans leading-relaxed text-text-secondary">
            {copy.accountDescription}
          </p>
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-success/25 bg-success/10 px-3 py-1.5 text-[11px] font-sans font-semibold text-success">
          <Check className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
          {copy.active}
        </span>
      </div>

      <div className="mt-5 grid gap-3 sm:grid-cols-3">
        <AccountDetail
          icon={<UserRound className="h-4 w-4" strokeWidth={1.7} />}
          label={copy.accountUsername}
          value={status.username ?? "—"}
        />
        <AccountDetail
          icon={<CalendarDays className="h-4 w-4" strokeWidth={1.7} />}
          label={copy.memberSince}
          value={formatMembershipDate(status.memberSince, locale)}
        />
        <AccountDetail
          icon={<CalendarDays className="h-4 w-4" strokeWidth={1.7} />}
          label={copy.membershipExpires}
          value={formatMembershipDate(status.expiresAt, locale)}
          note={formatRemainingDays(copy, status.daysRemaining)}
        />
      </div>

      <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-border-subtle pt-4">
        <span className="inline-flex items-center gap-2 text-[12px] font-sans font-semibold text-text-primary">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent-primary text-[11px] text-text-inverse">
            β
          </span>
          {copy.betaMember}
        </span>
        <button
          type="button"
          disabled={loggingOut}
          onClick={() => void logout()}
          className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-border-default bg-bg-primary px-3.5 py-2 text-[12px] font-sans font-semibold text-text-primary transition-colors hover:bg-bg-surface-card-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus disabled:cursor-not-allowed disabled:opacity-55"
        >
          {loggingOut ? (
            <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <LogOut className="h-4 w-4" strokeWidth={1.7} aria-hidden="true" />
          )}
          {loggingOut ? copy.loggingOut : copy.logout}
        </button>
      </div>
      <div className="min-h-5 pt-2" aria-live="polite">
        {error ? (
          <p role="alert" className="text-[11px] font-sans text-danger">
            {copy.errors.unexpected}
          </p>
        ) : null}
      </div>
    </section>
  );
}

function AccountDetail({
  icon,
  label,
  value,
  note,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  note?: string;
}) {
  return (
    <div className="min-w-0 rounded-xl border border-border-subtle bg-bg-primary p-3.5">
      <div className="flex items-center gap-2 text-text-tertiary">
        {icon}
        <span className="truncate text-[11px] font-sans">{label}</span>
      </div>
      <p className="mt-2 truncate text-[13px] font-sans font-semibold text-text-primary" title={value}>
        {value}
      </p>
      {note ? <p className="mt-1 text-[10px] font-sans text-success">{note}</p> : null}
    </div>
  );
}
