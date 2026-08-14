import { BookOpenText, Database, LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import type { DataContributionState } from "../../shared/contracts";
import type { SupportedLocale } from "../i18n/locales";
import { MEMBERSHIP_COPY } from "./copy";
import { PrivacyAgreementModal } from "./PrivacyAgreementModal";

export interface DataContributionCardProps {
  locale: SupportedLocale;
}

/** Consent date rendered as a local-time YYYY-MM-DD. */
export function formatConsentDay(timestamp: number): string {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * 数据贡献 (settings → 会员与账号): on/off switch for the RL training-data
 * upload. Turning it off applies immediately; turning it on first re-shows
 * the privacy agreement (PrivacyAgreementModal in consent mode) so the
 * fresh consentedAt timestamp recorded by setDataContribution(true) always
 * follows an explicit re-read.
 */
export function DataContributionCard({ locale }: DataContributionCardProps) {
  const copy = MEMBERSHIP_COPY[locale] ?? MEMBERSHIP_COPY.en;
  const [state, setState] = useState<DataContributionState | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [modalMode, setModalMode] = useState<"view" | "consent" | null>(null);

  useEffect(() => {
    let cancelled = false;
    const api = window.vestiMembership;
    if (!api?.getDataContribution) {
      setFailed(true);
      return;
    }
    api
      .getDataContribution()
      .then((next) => {
        if (cancelled) return;
        setState(next);
        setFailed(false);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    // Registration/login broadcasts carry the consent recorded with the
    // account; keep the card in sync without a manual reload.
    const unsubscribe = api.onStatusChanged?.((status) => {
      if (cancelled || !status.dataContribution) return;
      setState(status.dataContribution);
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  const applyChange = async (enabled: boolean) => {
    if (busy || !window.vestiMembership?.setDataContribution) return;
    setBusy(true);
    try {
      const next = await window.vestiMembership.setDataContribution(enabled);
      setState(next);
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  const handleToggle = (checked: boolean) => {
    if (checked) {
      // Enabling requires re-reading the agreement before consenting.
      setModalMode("consent");
    } else {
      void applyChange(false);
    }
  };

  const enabled = state?.enabled ?? false;
  const unavailable = state === null;

  return (
    <section className="rounded-card border border-border-subtle bg-bg-surface-card p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="font-mono text-[11px] font-medium uppercase tracking-[0.2em] text-text-tertiary">
            DATA CONTRIBUTION
          </p>
          <h2 className="mt-1 font-vesti-serif text-[22px] text-text-primary">
            {copy.dataContributionTitle}
          </h2>
          <p className="mt-2 text-[13px] font-sans leading-relaxed text-text-secondary">
            {copy.dataContributionDescription}
          </p>
        </div>
        <span
          className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[11px] font-sans font-semibold ${
            enabled
              ? "border-success/25 bg-success/10 text-success"
              : "border-border-subtle bg-bg-primary text-text-tertiary"
          }`}
        >
          <Database className="h-3.5 w-3.5" strokeWidth={1.8} aria-hidden="true" />
          {enabled ? copy.dataContributionEnabled : copy.dataContributionDisabled}
        </span>
      </div>

      <div className="mt-5 rounded-xl border border-border-subtle bg-bg-primary p-2">
        <label
          className={`flex items-center justify-between gap-4 rounded-lg border border-transparent px-3 py-2.5 transition-colors [transition-duration:140ms] ${
            unavailable || busy
              ? "cursor-not-allowed opacity-50"
              : "cursor-pointer hover:border-border-subtle hover:bg-bg-surface-card-hover"
          }`}
        >
          <span className="min-w-0">
            <span className="block text-[13px] font-sans font-medium text-text-primary">
              {copy.dataContributionTitle}
            </span>
            <span className="mt-0.5 block text-[12px] font-sans leading-relaxed text-text-tertiary">
              {copy.dataContributionHint}
            </span>
          </span>
          {unavailable ? (
            <LoaderCircle className="h-4 w-4 shrink-0 animate-spin text-text-tertiary" aria-hidden="true" />
          ) : (
            <>
              <input
                type="checkbox"
                className="peer sr-only"
                checked={enabled}
                disabled={busy}
                aria-label={copy.dataContributionTitle}
                onChange={(event) => handleToggle(event.target.checked)}
              />
              <span
                aria-hidden="true"
                className="relative h-[22px] w-[38px] shrink-0 rounded-full border border-border-default bg-bg-secondary transition-colors [transition-duration:160ms] after:absolute after:left-[3px] after:top-[3px] after:h-4 after:w-4 after:rounded-full after:bg-text-tertiary after:shadow-sm after:transition-[transform,background-color] after:[transition-duration:160ms] peer-focus-visible:ring-2 peer-focus-visible:ring-border-focus peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-bg-surface-card peer-checked:border-accent-primary peer-checked:bg-accent-primary peer-checked:after:translate-x-4 peer-checked:after:bg-text-inverse"
              />
            </>
          )}
        </label>
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-[11px] font-sans leading-5 text-text-tertiary">
          {enabled && state?.consentedAt
            ? copy.dataContributionConsentedAt.replace(
                "{date}",
                formatConsentDay(state.consentedAt),
              )
            : " "}
        </p>
        <button
          type="button"
          onClick={() => setModalMode("view")}
          className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-border-default bg-bg-primary px-3.5 py-2 text-[12px] font-sans font-semibold text-text-primary transition-colors hover:bg-bg-surface-card-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus"
        >
          <BookOpenText className="h-4 w-4" strokeWidth={1.7} aria-hidden="true" />
          {copy.dataContributionViewAgreement}
        </button>
      </div>
      <div className="min-h-5 pt-2" aria-live="polite">
        {failed ? (
          <p role="alert" className="text-[11px] font-sans text-danger">
            {copy.errors.unexpected}
          </p>
        ) : null}
      </div>

      <PrivacyAgreementModal
        open={modalMode !== null}
        onClose={() => setModalMode(null)}
        locale={locale}
        onAgree={
          modalMode === "consent"
            ? () => {
                setModalMode(null);
                void applyChange(true);
              }
            : undefined
        }
      />
    </section>
  );
}
