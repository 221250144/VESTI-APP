import type {
  MembershipErrorCode,
  MembershipState,
  MembershipStatus,
  VestiMembershipApi,
} from "../../shared/contracts";
import type { MembershipUiError } from "./copy";

export function errorCodeFromUnknown(error: unknown): MembershipUiError {
  const text = error instanceof Error ? error.message : String(error);
  const normalized = text.toLowerCase();
  const known: MembershipErrorCode[] = [
    "NOT_INITIALIZED",
    "ALREADY_REGISTERED",
    "INVALID_USERNAME",
    "WEAK_PASSWORD",
    "NOT_REGISTERED",
    "INVALID_CREDENTIALS",
    "AUTHENTICATION_REQUIRED",
    "MEMBERSHIP_EXPIRED",
    "MEMBERSHIP_DATA_CORRUPT",
    "CONSENT_REQUIRED",
    "STORAGE_ERROR",
  ];
  return known.find((code) => normalized.includes(code.toLowerCase())) ?? "unexpected";
}

export interface MembershipSubmitInput {
  state: MembershipState;
  username: string;
  password: string;
  confirmPassword: string;
  consentChecked: boolean;
}

/** Auth surface the submit handler needs (window.vestiMembership in prod). */
export type MembershipSubmitApi = Pick<VestiMembershipApi, "register" | "login">;

export interface MembershipSubmitOutcome {
  /** Latest status returned by the service; null when blocked client-side. */
  status: MembershipStatus | null;
  error: MembershipUiError | null;
  /** True only when the action succeeded (credentials should be cleared). */
  succeeded: boolean;
}

/**
 * Register/login submit decision, extracted so the flow is testable without a
 * DOM: unregistered submissions require matching passwords; data contribution
 * is optional, and the checkbox value flows through as the registration-time
 * opt-in (`dataConsent`).
 */
export async function submitMembershipAuth(
  input: MembershipSubmitInput,
  api: MembershipSubmitApi,
): Promise<MembershipSubmitOutcome> {
  const registering = input.state === "unregistered";
  if (registering && input.password !== input.confirmPassword) {
    return { status: null, error: "password_mismatch", succeeded: false };
  }
  try {
    const credentials = { username: input.username.trim(), password: input.password };
    const result = registering
      ? await api.register(credentials, input.consentChecked)
      : await api.login(credentials);
    return {
      status: result.status,
      error: result.ok ? null : result.error,
      succeeded: result.ok,
    };
  } catch (error) {
    return { status: null, error: errorCodeFromUnknown(error), succeeded: false };
  }
}
