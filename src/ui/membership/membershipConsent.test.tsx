import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type {
  MembershipActionResult,
  MembershipStatus,
} from "../../shared/contracts";
import { MEMBERSHIP_COPY } from "./copy";
import { formatConsentDay } from "./DataContributionCard";
import { PrivacyAgreementModal } from "./PrivacyAgreementModal";
import {
  submitMembershipAuth,
  type MembershipSubmitApi,
  type MembershipSubmitInput,
} from "./submitMembershipAuth";

function statusFixture(overrides: Partial<MembershipStatus> = {}): MembershipStatus {
  return {
    state: "unregistered",
    plan: null,
    registered: false,
    authenticated: false,
    active: false,
    username: null,
    memberSince: null,
    expiresAt: null,
    daysRemaining: 0,
    ...overrides,
  };
}

function inputFixture(overrides: Partial<MembershipSubmitInput> = {}): MembershipSubmitInput {
  return {
    state: "unregistered",
    username: "  tester  ",
    password: "password123",
    confirmPassword: "password123",
    consentChecked: true,
    ...overrides,
  };
}

function apiFixture(result?: Partial<Extract<MembershipActionResult, { ok: true }>>) {
  const status = statusFixture({
    registered: true,
    authenticated: true,
    active: true,
    username: "tester",
  });
  return {
    register: vi.fn(async () => ({ ok: true as const, status, ...result })),
    login: vi.fn(async () => ({ ok: true as const, status })),
  } satisfies MembershipSubmitApi;
}

describe("submitMembershipAuth", () => {
  it("registers without consent when the optional contribution box is unchecked", async () => {
    const api = apiFixture();
    const outcome = await submitMembershipAuth(
      inputFixture({ consentChecked: false }),
      api,
    );
    // Data contribution is optional: an unchecked box no longer blocks
    // registration — it just flows through as dataConsent=false.
    expect(api.register).toHaveBeenCalledWith(
      { username: "tester", password: "password123" },
      false,
    );
    expect(api.login).not.toHaveBeenCalled();
    expect(outcome.succeeded).toBe(true);
    expect(outcome.error).toBeNull();
    expect(outcome.status?.authenticated).toBe(true);
  });

  it("registers with dataConsent=true when the contribution box is checked", async () => {
    const api = apiFixture();
    const outcome = await submitMembershipAuth(inputFixture(), api);
    expect(api.register).toHaveBeenCalledWith(
      { username: "tester", password: "password123" },
      true,
    );
    expect(api.login).not.toHaveBeenCalled();
    expect(outcome.succeeded).toBe(true);
    expect(outcome.error).toBeNull();
    expect(outcome.status?.authenticated).toBe(true);
  });

  it("blocks registration on password mismatch before any API call", async () => {
    const api = apiFixture();
    const outcome = await submitMembershipAuth(
      inputFixture({ confirmPassword: "different123" }),
      api,
    );
    expect(outcome.error).toBe("password_mismatch");
    expect(api.register).not.toHaveBeenCalled();
  });

  it("surfaces a rejection from the service", async () => {
    const status = statusFixture();
    const api: MembershipSubmitApi = {
      register: vi.fn(async () => ({
        ok: false as const,
        status,
        error: "ALREADY_REGISTERED" as const,
      })),
      login: vi.fn(),
    };
    const outcome = await submitMembershipAuth(inputFixture(), api);
    expect(outcome.error).toBe("ALREADY_REGISTERED");
    expect(outcome.succeeded).toBe(false);
    expect(outcome.status).toEqual(status);
  });

  it("logs in without requiring consent outside the unregistered state", async () => {
    const api = apiFixture();
    const outcome = await submitMembershipAuth(
      inputFixture({ state: "signed_out", consentChecked: false }),
      api,
    );
    expect(api.login).toHaveBeenCalledWith({
      username: "tester",
      password: "password123",
    });
    expect(api.register).not.toHaveBeenCalled();
    expect(outcome.succeeded).toBe(true);
  });
});

describe("PrivacyAgreementModal", () => {
  it("renders nothing when closed", () => {
    const html = renderToStaticMarkup(
      <PrivacyAgreementModal open={false} onClose={() => {}} locale="zh" />,
    );
    expect(html).toBe("");
  });

  it("renders every key agreement section (zh)", () => {
    const html = renderToStaticMarkup(
      <PrivacyAgreementModal open={true} onClose={() => {}} locale="zh" />,
    );
    const copy = MEMBERSHIP_COPY.zh;
    expect(html).toContain(copy.privacyTitle);
    expect(html).toContain("v1.0");
    for (const section of copy.privacySections) {
      expect(html).toContain(section.heading);
    }
    // Key sections required by the agreement doc:
    expect(html).toContain("我们收集什么");
    expect(html).toContain("我们不收集什么");
    expect(html).toContain("匿名性");
    expect(html).toContain("数据存储与安全");
    expect(html).toContain("你的权利与退出");
    expect(html).toContain("风险提示");
    // Read-only mode: the close button exists, the consent button does not.
    expect(html).toContain(copy.privacyReadButton);
    expect(html).not.toContain(copy.privacyAgreeButton);
  });

  it("renders every key agreement section (en)", () => {
    const html = renderToStaticMarkup(
      <PrivacyAgreementModal open={true} onClose={() => {}} locale="en" />,
    );
    // Static markup HTML-escapes "&" in the English title.
    const text = html.replaceAll("&amp;", "&");
    const copy = MEMBERSHIP_COPY.en;
    expect(text).toContain(copy.privacyTitle);
    for (const section of copy.privacySections) {
      expect(text).toContain(section.heading);
    }
  });

  it("shows the consent button when onAgree is provided (settings enable flow)", () => {
    const html = renderToStaticMarkup(
      <PrivacyAgreementModal
        open={true}
        onClose={() => {}}
        onAgree={() => {}}
        locale="zh"
      />,
    );
    expect(html).toContain(MEMBERSHIP_COPY.zh.privacyAgreeButton);
  });
});

describe("formatConsentDay", () => {
  it("formats a timestamp as local YYYY-MM-DD", () => {
    expect(formatConsentDay(new Date(2026, 7, 14, 9, 30).getTime())).toBe("2026-08-14");
    expect(formatConsentDay(new Date(2026, 0, 5, 0, 1).getTime())).toBe("2026-01-05");
  });
});

describe("optional-but-rewarded contribution copy", () => {
  it("frames consent as optional and mentions the one-time 2,000-credit gift in every locale", () => {
    for (const locale of ["zh", "en", "ja", "ko"] as const) {
      const copy = MEMBERSHIP_COPY[locale];
      // Registration checkbox, agreement intro and settings card all carry
      // the optional framing plus the gift amount.
      const consentLine = `${copy.consentPrefix}${copy.privacyAgreementName}${copy.consentSuffix}`;
      expect(consentLine).toContain("2,000");
      expect(copy.privacyIntro).toContain("2,000");
      expect(copy.dataContributionHint).toContain("2,000");
      expect(copy.dataContributionDescription).toContain("2,000");
    }
  });

  it("no longer frames contribution consent as mandatory for registration", () => {
    // zh previously read "不同意则无法领取免费会员"; the en/ja/ko variants
    // carried the same claim. The framing must be gone in every locale.
    expect(MEMBERSHIP_COPY.zh.privacyIntro).not.toContain("不同意则无法");
    expect(MEMBERSHIP_COPY.en.privacyIntro).not.toContain("cannot be claimed");
  });
});
