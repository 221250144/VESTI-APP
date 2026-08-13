import {
  ArrowRight,
  CalendarDays,
  HardDrive,
  Languages,
  LoaderCircle,
  LockKeyhole,
  LogOut,
  Moon,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Sun,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import type {
  MembershipActionResult,
  MembershipErrorCode,
  MembershipStatus,
} from "../../shared/contracts";
import { useI18n } from "../i18n";
import {
  LOCALE_META,
  SUPPORTED_LOCALES,
  type SupportedLocale,
} from "../i18n/locales";
import { LOGO_BASE64 } from "../logo";
import { TitleBar } from "../shell/TitleBar";
import { useUiTheme } from "../shell/useUiTheme";
import {
  formatMembershipDate,
  MEMBERSHIP_COPY,
  type MembershipUiError,
} from "./copy";

export interface MembershipGateContext {
  status: MembershipStatus;
  logout: () => Promise<void>;
  themeMode: "light" | "dark";
  toggleTheme: () => Promise<void>;
}

export interface MembershipGateProps {
  children: (context: MembershipGateContext) => ReactNode;
}

const inputClass =
  "mt-1.5 w-full rounded-xl border border-border-subtle bg-bg-primary px-3.5 py-3 text-[14px] font-sans text-text-primary outline-none transition-colors placeholder:text-text-tertiary focus:border-border-focus focus:ring-2 focus:ring-border-focus/25 disabled:cursor-not-allowed disabled:opacity-60";

const secondaryButtonClass =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-border-default bg-bg-primary px-4 py-2.5 text-[13px] font-sans font-semibold text-text-primary transition-colors hover:bg-bg-surface-card-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus disabled:cursor-not-allowed disabled:opacity-55";

function errorCodeFromUnknown(error: unknown): MembershipUiError {
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
    "STORAGE_ERROR",
  ];
  return known.find((code) => normalized.includes(code.toLowerCase())) ?? "unexpected";
}

export function MembershipGate({ children }: MembershipGateProps) {
  const { locale, setLocale } = useI18n();
  const copy = MEMBERSHIP_COPY[locale] ?? MEMBERSHIP_COPY.en;
  const { themeMode, toggleTheme } = useUiTheme();
  const [status, setStatus] = useState<MembershipStatus | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [checking, setChecking] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [errorCode, setErrorCode] = useState<MembershipUiError | null>(null);

  const refreshStatus = useCallback(async () => {
    setChecking(true);
    setLoadFailed(false);
    setErrorCode(null);
    try {
      const next = await window.vestiMembership.getStatus();
      setStatus(next);
    } catch {
      setLoadFailed(true);
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoadFailed(false);
    void window.vestiMembership
      .getStatus()
      .then((next) => {
        if (!cancelled) setStatus(next);
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      });
    const unsubscribe = window.vestiMembership.onStatusChanged((next) => {
      if (cancelled) return;
      setStatus(next);
      setLoadFailed(false);
      setErrorCode(null);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!status?.username || username) return;
    setUsername(status.username);
  }, [status?.username, username]);

  const logout = useCallback(async () => {
    if (loggingOut) return;
    setLoggingOut(true);
    setErrorCode(null);
    try {
      const next = await window.vestiMembership.logout();
      setStatus(next);
      setPassword("");
      setConfirmPassword("");
    } catch (error) {
      setErrorCode(errorCodeFromUnknown(error));
    } finally {
      setLoggingOut(false);
    }
  }, [loggingOut]);

  // Any signed-in account enters the shell: an active member gets the full
  // tier, an expired one continues as the free tier (the ExpiredView below is
  // kept but no longer reachable while authenticated).
  if (status?.authenticated) {
    return children({ status, logout, themeMode, toggleTheme });
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!status || submitting) return;
    setErrorCode(null);

    if (status.state === "unregistered" && password !== confirmPassword) {
      setErrorCode("password_mismatch");
      return;
    }

    setSubmitting(true);
    try {
      const credentials = { username: username.trim(), password };
      const result: MembershipActionResult =
        status.state === "unregistered"
          ? await window.vestiMembership.register(credentials)
          : await window.vestiMembership.login(credentials);
      setStatus(result.status);
      if (!result.ok) {
        setErrorCode(result.error);
        return;
      }
      setPassword("");
      setConfirmPassword("");
    } catch (error) {
      setErrorCode(errorCodeFromUnknown(error));
    } finally {
      setSubmitting(false);
    }
  };

  const controls = (
    <div className="flex items-center gap-2">
      <label className="relative flex items-center">
        <Languages className="pointer-events-none absolute left-3 h-4 w-4 text-text-tertiary" />
        <span className="sr-only">{copy.language}</span>
        <select
          aria-label={copy.language}
          value={locale}
          onChange={(event) => void setLocale(event.target.value as SupportedLocale)}
          className="h-10 appearance-none rounded-lg border border-border-subtle bg-bg-primary pl-9 pr-8 text-[12px] font-sans font-medium text-text-secondary outline-none transition-colors hover:bg-bg-surface-card-hover focus:border-border-focus focus:ring-2 focus:ring-border-focus/25"
        >
          {SUPPORTED_LOCALES.map((supportedLocale) => (
            <option key={supportedLocale} value={supportedLocale}>
              {LOCALE_META[supportedLocale].nativeName}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        aria-label={copy.toggleTheme}
        title={copy.toggleTheme}
        onClick={() => void toggleTheme()}
        className="flex h-10 w-10 items-center justify-center rounded-lg border border-border-subtle bg-bg-primary text-text-secondary transition-colors hover:bg-bg-surface-card-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus"
      >
        {themeMode === "dark" ? (
          <Sun className="h-4 w-4" strokeWidth={1.75} />
        ) : (
          <Moon className="h-4 w-4" strokeWidth={1.75} />
        )}
      </button>
    </div>
  );

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-bg-app text-text-primary">
      <TitleBar />
      <main className="relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden bg-bg-app">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -left-28 top-1/3 h-72 w-72 rounded-full bg-accent-primary-light blur-3xl"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -right-24 -top-24 h-80 w-80 rounded-full bg-accent-primary-muted opacity-40 blur-3xl"
        />
        <div className="relative mx-auto flex min-h-full max-w-[1120px] flex-col px-6 py-6 sm:px-10 sm:py-9">
          <div className="flex justify-end">{controls}</div>

          {status?.state === "expired" ? (
            <ExpiredView
              status={status}
              locale={locale}
              checking={checking}
              loggingOut={loggingOut}
              error={errorCode ? copy.errors[errorCode] : null}
              onRefresh={() => void refreshStatus()}
              onLogout={() => void logout()}
            />
          ) : loadFailed ? (
            <CenteredStatusCard
              icon={<RefreshCw className="h-7 w-7" strokeWidth={1.6} />}
              title={copy.loadFailedTitle}
              description={copy.loadFailedDescription}
            >
              <button
                type="button"
                disabled={checking}
                onClick={() => void refreshStatus()}
                className={secondaryButtonClass}
              >
                {checking ? (
                  <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
                ) : (
                  <RefreshCw className="h-4 w-4" aria-hidden="true" />
                )}
                {checking ? copy.checking : copy.retry}
              </button>
            </CenteredStatusCard>
          ) : !status ? (
            <CenteredStatusCard
              icon={<LoaderCircle className="h-7 w-7 animate-spin" strokeWidth={1.6} />}
              title={copy.loadingTitle}
              description={copy.loadingDescription}
            />
          ) : (
            <div className="my-auto grid items-center gap-10 py-8 lg:grid-cols-[minmax(0,1.05fr)_minmax(380px,0.8fr)] lg:gap-16">
              <section className="max-w-[590px]">
                <div className="mb-7 flex items-center gap-3">
                  <span className="flex h-12 w-12 items-center justify-center rounded-2xl border border-border-subtle bg-bg-primary shadow-paper">
                    <img src={LOGO_BASE64} alt="" className="h-7 w-7" draggable={false} />
                  </span>
                  <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.28em] text-text-tertiary">
                    {copy.heroEyebrow}
                  </p>
                </div>
                <h1 className="max-w-[570px] font-vesti-serif text-[clamp(36px,5vw,58px)] font-normal leading-[1.05] tracking-[-0.035em] text-text-primary">
                  {copy.heroTitle}
                </h1>
                <p className="mt-5 max-w-[540px] text-[15px] font-sans leading-7 text-text-secondary">
                  {copy.heroDescription}
                </p>
                <div className="mt-8 grid gap-3 sm:grid-cols-2">
                  <FeatureCard
                    icon={<HardDrive className="h-5 w-5" strokeWidth={1.7} />}
                    title={copy.localFirst}
                    description={copy.localFirstDescription}
                  />
                  <FeatureCard
                    icon={<Sparkles className="h-5 w-5" strokeWidth={1.7} />}
                    title={copy.trial}
                    description={copy.trialDescription}
                  />
                </div>
              </section>

              <section className="rounded-card border border-border-default bg-bg-surface-card p-6 shadow-paper sm:p-8">
                <div className="mb-6 flex h-11 w-11 items-center justify-center rounded-xl bg-accent-primary text-text-inverse">
                  {status.state === "unregistered" ? (
                    <ShieldCheck className="h-5 w-5" strokeWidth={1.8} />
                  ) : (
                    <LockKeyhole className="h-5 w-5" strokeWidth={1.8} />
                  )}
                </div>
                <h2 className="font-vesti-serif text-[28px] leading-tight text-text-primary">
                  {status.state === "unregistered" ? copy.registerTitle : copy.loginTitle}
                </h2>
                <p className="mt-2 text-[13px] font-sans leading-6 text-text-secondary">
                  {status.state === "unregistered"
                    ? copy.registerDescription
                    : copy.loginDescription}
                </p>

                <form
                  className="mt-6 space-y-4"
                  aria-busy={submitting}
                  onSubmit={(event) => void handleSubmit(event)}
                >
                  <label className="block" htmlFor="membership-username">
                    <span className="text-[12px] font-sans font-semibold text-text-secondary">
                      {copy.username}
                    </span>
                    <input
                      id="membership-username"
                      name="username"
                      type="text"
                      autoComplete="username"
                      autoFocus
                      required
                      minLength={3}
                      maxLength={32}
                      disabled={submitting}
                      value={username}
                      placeholder={copy.usernamePlaceholder}
                      onChange={(event) => {
                        setUsername(event.target.value);
                        setErrorCode(null);
                      }}
                      className={inputClass}
                    />
                  </label>
                  <label className="block" htmlFor="membership-password">
                    <span className="text-[12px] font-sans font-semibold text-text-secondary">
                      {copy.password}
                    </span>
                    <input
                      id="membership-password"
                      name="password"
                      type="password"
                      autoComplete={status.state === "unregistered" ? "new-password" : "current-password"}
                      required
                      minLength={8}
                      maxLength={256}
                      disabled={submitting}
                      value={password}
                      placeholder={copy.passwordPlaceholder}
                      onChange={(event) => {
                        setPassword(event.target.value);
                        setErrorCode(null);
                      }}
                      className={inputClass}
                    />
                  </label>
                  {status.state === "unregistered" ? (
                    <label className="block" htmlFor="membership-password-confirmation">
                      <span className="text-[12px] font-sans font-semibold text-text-secondary">
                        {copy.confirmPassword}
                      </span>
                      <input
                        id="membership-password-confirmation"
                        name="passwordConfirmation"
                        type="password"
                        autoComplete="new-password"
                        required
                        minLength={8}
                        maxLength={256}
                        disabled={submitting}
                        value={confirmPassword}
                        placeholder={copy.confirmPasswordPlaceholder}
                        onChange={(event) => {
                          setConfirmPassword(event.target.value);
                          setErrorCode(null);
                        }}
                        className={inputClass}
                      />
                    </label>
                  ) : null}

                  <div className="min-h-6" aria-live="polite">
                    {errorCode ? (
                      <p role="alert" className="text-[12px] font-sans leading-5 text-danger">
                        {copy.errors[errorCode]}
                      </p>
                    ) : null}
                  </div>

                  <button
                    type="submit"
                    disabled={submitting}
                    className="inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-accent-primary px-4 py-3 text-[13px] font-sans font-semibold text-text-inverse transition-colors hover:bg-accent-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus focus-visible:ring-offset-2 focus-visible:ring-offset-bg-surface-card disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {submitting ? (
                      <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
                    ) : (
                      <ArrowRight className="h-4 w-4" aria-hidden="true" />
                    )}
                    {status.state === "unregistered"
                      ? submitting
                        ? copy.registering
                        : copy.register
                      : submitting
                        ? copy.loggingIn
                        : copy.login}
                  </button>
                </form>
                <p className="mt-5 flex items-start gap-2 text-[11px] font-sans leading-5 text-text-tertiary">
                  <HardDrive className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  {copy.accountStoredLocally}
                </p>
              </section>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

function FeatureCard({
  icon,
  title,
  description,
}: {
  icon: ReactNode;
  title: string;
  description: string;
}) {
  return (
    <div className="rounded-2xl border border-border-subtle bg-bg-primary/75 p-4">
      <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent-primary-light text-text-primary">
        {icon}
      </span>
      <h2 className="mt-3 text-[13px] font-sans font-semibold text-text-primary">{title}</h2>
      <p className="mt-1 text-[12px] font-sans leading-5 text-text-tertiary">{description}</p>
    </div>
  );
}

function CenteredStatusCard({
  icon,
  title,
  description,
  children,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <section className="my-auto self-center rounded-card border border-border-default bg-bg-surface-card p-8 text-center shadow-paper sm:w-[430px]">
      <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-accent-primary-light text-text-primary">
        {icon}
      </span>
      <h1 className="mt-5 font-vesti-serif text-[26px] text-text-primary">{title}</h1>
      <p className="mx-auto mt-2 max-w-sm text-[13px] font-sans leading-6 text-text-secondary">
        {description}
      </p>
      {children ? <div className="mt-6 flex justify-center">{children}</div> : null}
    </section>
  );
}

function ExpiredView({
  status,
  locale,
  checking,
  loggingOut,
  error,
  onRefresh,
  onLogout,
}: {
  status: MembershipStatus;
  locale: SupportedLocale;
  checking: boolean;
  loggingOut: boolean;
  error: string | null;
  onRefresh: () => void;
  onLogout: () => void;
}) {
  const copy = MEMBERSHIP_COPY[locale] ?? MEMBERSHIP_COPY.en;
  return (
    <section className="my-auto self-center rounded-card border border-border-default bg-bg-surface-card p-7 shadow-paper sm:w-[520px] sm:p-9">
      <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-danger/10 text-danger">
        <LockKeyhole className="h-5 w-5" strokeWidth={1.7} aria-hidden="true" />
      </span>
      <p className="mt-6 font-mono text-[10px] font-semibold uppercase tracking-[0.24em] text-danger">
        {copy.expiredEyebrow}
      </p>
      <h1 className="mt-2 font-vesti-serif text-[32px] leading-tight text-text-primary">
        {copy.expiredTitle}
      </h1>
      <p className="mt-3 text-[13px] font-sans leading-6 text-text-secondary">
        {copy.expiredDescription}
      </p>
      <dl className="mt-6 divide-y divide-border-subtle rounded-xl border border-border-subtle bg-bg-primary px-4">
        <div className="flex items-center justify-between gap-4 py-3">
          <dt className="text-[12px] font-sans text-text-tertiary">{copy.expiredFor}</dt>
          <dd className="truncate text-[13px] font-sans font-semibold text-text-primary">
            {status.username ?? "—"}
          </dd>
        </div>
        <div className="flex items-center justify-between gap-4 py-3">
          <dt className="flex items-center gap-2 text-[12px] font-sans text-text-tertiary">
            <CalendarDays className="h-4 w-4" aria-hidden="true" />
            {copy.expiredAt}
          </dt>
          <dd className="text-[13px] font-sans font-medium text-text-primary">
            {formatMembershipDate(status.expiresAt, locale)}
          </dd>
        </div>
      </dl>
      <div className="mt-6 flex flex-wrap gap-3">
        <button type="button" disabled={checking} onClick={onRefresh} className={secondaryButtonClass}>
          <RefreshCw className={`h-4 w-4 ${checking ? "animate-spin" : ""}`} aria-hidden="true" />
          {checking ? copy.checking : copy.checkAgain}
        </button>
        <button type="button" disabled={loggingOut} onClick={onLogout} className={secondaryButtonClass}>
          {loggingOut ? (
            <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <LogOut className="h-4 w-4" aria-hidden="true" />
          )}
          {loggingOut ? copy.loggingOut : copy.logout}
        </button>
      </div>
      <div className="min-h-6 pt-3" aria-live="polite">
        {error ? (
          <p role="alert" className="text-[12px] font-sans leading-5 text-danger">
            {error}
          </p>
        ) : null}
      </div>
    </section>
  );
}
