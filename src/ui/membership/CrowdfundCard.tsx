import { ExternalLink, HandHeart, LoaderCircle } from "lucide-react";
import { useState } from "react";
import type {
  CrowdfundRedeemError,
  CrowdfundRedeemResult,
  VestiMembershipApi,
} from "../../shared/contracts";
import type { SupportedLocale } from "../i18n/locales";
import { CROWDFUND_PAGE_URL, formatCreditCount, MEMBERSHIP_COPY } from "./copy";

export interface CrowdfundCardProps {
  locale: SupportedLocale;
}

/** Narrow bridge surface the card needs (fakeable in tests). */
export type CrowdfundRedeemApi = Pick<VestiMembershipApi, "redeemCrowdfundCode">;

/**
 * 兑换提交的可测包装:IPC 层抛错或返回意外形状时统一归为 network_error,
 * 三类结果(invalid_code / already_redeemed / 网络错误)与 copy 一一对应。
 */
export async function submitCrowdfundRedeem(
  code: string,
  api: CrowdfundRedeemApi,
): Promise<CrowdfundRedeemResult> {
  try {
    const result = await api.redeemCrowdfundCode(code);
    if (result && typeof result === "object" && "ok" in result) return result;
    return { ok: false, error: "network_error" };
  } catch {
    return { ok: false, error: "network_error" };
  }
}

type RedeemState =
  | { kind: "success"; credits: number }
  | { kind: "error"; error: CrowdfundRedeemError }
  | null;

/**
 * 支持众筹 (settings → 会员与账号):三档展示 + 一次性「众筹码」兑换入口。
 * 兑换成功后积分打入本地奖励池,积分卡余额经 creditChanged 广播自动刷新。
 */
export function CrowdfundCard({ locale }: CrowdfundCardProps) {
  const copy = MEMBERSHIP_COPY[locale] ?? MEMBERSHIP_COPY.en;
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<RedeemState>(null);

  const errorText = (error: CrowdfundRedeemError): string =>
    error === "invalid_code"
      ? copy.crowdfundErrorInvalid
      : error === "already_redeemed"
        ? copy.crowdfundErrorUsed
        : copy.crowdfundErrorNetwork;

  const handleRedeem = async () => {
    const api = window.vestiMembership;
    if (busy || !code.trim() || !api?.redeemCrowdfundCode) return;
    setBusy(true);
    setResult(null);
    const outcome = await submitCrowdfundRedeem(code, api);
    if (outcome.ok) {
      setResult({ kind: "success", credits: outcome.credits });
      setCode("");
    } else {
      setResult({ kind: "error", error: outcome.error });
    }
    setBusy(false);
  };

  return (
    <section className="rounded-card border border-border-subtle bg-bg-surface-card p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="font-mono text-[11px] font-medium uppercase tracking-[0.2em] text-text-tertiary">
            CROWDFUND
          </p>
          <h2 className="mt-1 font-vesti-serif text-[22px] text-text-primary">
            {copy.crowdfundTitle}
          </h2>
          <p className="mt-2 text-[13px] font-sans leading-relaxed text-text-secondary">
            {copy.crowdfundDescription}
          </p>
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-border-subtle bg-bg-primary px-3 py-1.5 text-[11px] font-sans font-semibold text-text-tertiary">
          <HandHeart className="h-3.5 w-3.5" strokeWidth={1.8} aria-hidden="true" />
          VESTI
        </span>
      </div>

      <div className="mt-5 flex flex-col gap-2">
        {copy.crowdfundTiers.map((tier) => (
          <div
            key={tier.name}
            className="flex items-baseline justify-between gap-3 rounded-xl border border-border-subtle bg-bg-primary px-4 py-3"
          >
            <div className="min-w-0">
              <p className="text-[13px] font-sans font-semibold text-text-primary">{tier.name}</p>
              <p className="mt-0.5 text-[12px] font-sans leading-relaxed text-text-tertiary">
                {tier.perk}
              </p>
            </div>
            <p className="shrink-0 font-vesti-serif text-[18px] text-text-primary">{tier.price}</p>
          </div>
        ))}
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <p className="min-w-0 flex-1 text-[11px] font-sans leading-5 text-text-tertiary">
          {copy.crowdfundPaymentHint}
        </p>
        <a
          href={CROWDFUND_PAGE_URL}
          target="_blank"
          rel="noreferrer"
          className="inline-flex min-h-10 shrink-0 items-center justify-center gap-2 rounded-lg border border-border-default bg-bg-primary px-3.5 py-2 text-[12px] font-sans font-semibold text-text-primary transition-colors hover:bg-bg-surface-card-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus"
        >
          <ExternalLink className="h-4 w-4" strokeWidth={1.7} aria-hidden="true" />
          {copy.crowdfundPageButton}
        </a>
      </div>

      <div className="mt-4 border-t border-border-subtle pt-4">
        <label
          htmlFor="crowdfund-code-input"
          className="text-[12px] font-sans font-medium text-text-secondary"
        >
          {copy.crowdfundRedeemLabel}
        </label>
        <div className="mt-2 flex gap-2">
          <input
            id="crowdfund-code-input"
            type="text"
            value={code}
            disabled={busy}
            placeholder={copy.crowdfundCodePlaceholder}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setCode(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void handleRedeem();
            }}
            className="min-w-0 flex-1 rounded-lg border border-border-default bg-bg-primary px-3 py-2 font-mono text-[12px] tracking-wide text-text-primary placeholder:text-text-tertiary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus disabled:opacity-50"
          />
          <button
            type="button"
            onClick={() => void handleRedeem()}
            disabled={busy || !code.trim()}
            className="inline-flex min-h-10 shrink-0 items-center justify-center gap-2 rounded-lg bg-accent-primary px-4 py-2 text-[12px] font-sans font-semibold text-text-inverse transition-colors hover:bg-accent-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? (
              <>
                <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
                {copy.crowdfundRedeeming}
              </>
            ) : (
              copy.crowdfundRedeemSubmit
            )}
          </button>
        </div>
      </div>

      <div className="min-h-5 pt-2" aria-live="polite">
        {result?.kind === "success" ? (
          <p role="status" className="text-[12px] font-sans leading-5 text-success">
            {copy.crowdfundRedeemSuccess.replace(
              "{credits}",
              formatCreditCount(result.credits, locale),
            )}
            {" · "}
            {copy.crowdfundThanks}
          </p>
        ) : null}
        {result?.kind === "error" ? (
          <p role="alert" className="text-[11px] font-sans text-danger">
            {errorText(result.error)}
          </p>
        ) : null}
      </div>
    </section>
  );
}
