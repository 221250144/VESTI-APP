import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { CrowdfundRedeemResult } from "../../shared/contracts";
import { MEMBERSHIP_COPY, CROWDFUND_PAGE_URL } from "./copy";
import { CrowdfundCard, submitCrowdfundRedeem } from "./CrowdfundCard";

describe("CrowdfundCard", () => {
  it("renders the three tiers, payment hint and redeem entry (zh)", () => {
    const html = renderToStaticMarkup(<CrowdfundCard locale="zh" />);
    const copy = MEMBERSHIP_COPY.zh;
    expect(html).toContain(copy.crowdfundTitle);
    expect(html).toContain(copy.crowdfundDescription);
    for (const tier of copy.crowdfundTiers) {
      expect(html).toContain(tier.name);
      expect(html).toContain(tier.price);
      expect(html).toContain(tier.perk);
    }
    expect(html).toContain(copy.crowdfundPaymentHint);
    expect(html).toContain(CROWDFUND_PAGE_URL);
    expect(html).toContain(copy.crowdfundRedeemLabel);
    expect(html).toContain(copy.crowdfundCodePlaceholder);
    expect(html).toContain(copy.crowdfundRedeemSubmit);
  });

  it("renders the localized copy (en)", () => {
    const html = renderToStaticMarkup(<CrowdfundCard locale="en" />);
    const copy = MEMBERSHIP_COPY.en;
    expect(html).toContain(copy.crowdfundTitle);
    for (const tier of copy.crowdfundTiers) {
      expect(html).toContain(tier.name);
    }
    expect(html).toContain(copy.crowdfundRedeemLabel);
  });

  it("shows the placeholder instead of a real payment QR (pre-launch)", () => {
    // 占位期:卡片只引导到公开页,二维码占位图在网页端;App 内不放真收款码。
    const html = renderToStaticMarkup(<CrowdfundCard locale="zh" />);
    expect(html).toContain(CROWDFUND_PAGE_URL);
    expect(html).not.toContain("<img");
  });
});

describe("crowdfund copy coverage", () => {
  it("provides all crowdfund keys and three tiers in every locale", () => {
    for (const locale of ["zh", "en", "ja", "ko"] as const) {
      const copy = MEMBERSHIP_COPY[locale];
      expect(copy.crowdfundTitle.length).toBeGreaterThan(0);
      expect(copy.crowdfundDescription.length).toBeGreaterThan(0);
      expect(copy.crowdfundTiers).toHaveLength(3);
      for (const tier of copy.crowdfundTiers) {
        expect(tier.name.length).toBeGreaterThan(0);
        expect(tier.price).toMatch(/^¥/);
        expect(tier.perk.length).toBeGreaterThan(0);
      }
      expect(copy.crowdfundPaymentHint.length).toBeGreaterThan(0);
      expect(copy.crowdfundRedeemSuccess).toContain("{credits}");
      expect(copy.crowdfundErrorInvalid.length).toBeGreaterThan(0);
      expect(copy.crowdfundErrorUsed.length).toBeGreaterThan(0);
      expect(copy.crowdfundErrorNetwork.length).toBeGreaterThan(0);
    }
  });

  it("mentions crowdfunding in the membership & credits guide", () => {
    for (const locale of ["zh", "en", "ja", "ko"] as const) {
      const headings = MEMBERSHIP_COPY[locale].creditsDocSections.map((s) => s.heading);
      expect(headings.some((h) => /众筹|crowdfund|クラウドファンディング|크라우드펀딩/i.test(h))).toBe(true);
    }
  });
});

describe("submitCrowdfundRedeem", () => {
  const success: CrowdfundRedeemResult = {
    ok: true,
    tier: "warm",
    credits: 6_000,
    balance: {
      tier: "free",
      quota: 300,
      used: 0,
      remaining: 6_300,
      resetsAt: 0,
      lifetimeUsed: 0,
      recent: [],
    },
  };

  it("passes a successful redemption through", async () => {
    const api = { redeemCrowdfundCode: vi.fn(async () => success) };
    const outcome = await submitCrowdfundRedeem("VESTI-7K2M-9QXD-4TBN", api);
    expect(api.redeemCrowdfundCode).toHaveBeenCalledWith("VESTI-7K2M-9QXD-4TBN");
    expect(outcome).toEqual(success);
  });

  it("passes invalid_code and already_redeemed failures through", async () => {
    const invalid: CrowdfundRedeemResult = { ok: false, error: "invalid_code" };
    const used: CrowdfundRedeemResult = { ok: false, error: "already_redeemed" };
    expect(
      await submitCrowdfundRedeem("x", { redeemCrowdfundCode: vi.fn(async () => invalid) }),
    ).toEqual(invalid);
    expect(
      await submitCrowdfundRedeem("x", { redeemCrowdfundCode: vi.fn(async () => used) }),
    ).toEqual(used);
  });

  it("maps IPC-level throws and malformed payloads to network_error", async () => {
    const throwing = {
      redeemCrowdfundCode: vi.fn(async () => {
        throw new Error("ipc channel gone");
      }),
    };
    expect(await submitCrowdfundRedeem("x", throwing)).toEqual({ ok: false, error: "network_error" });

    const malformed = {
      redeemCrowdfundCode: vi.fn(async () => null as unknown as CrowdfundRedeemResult),
    };
    expect(await submitCrowdfundRedeem("x", malformed)).toEqual({ ok: false, error: "network_error" });
  });
});
