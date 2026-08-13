import { useEffect, useMemo, useState } from "react";
import {
  OnboardingWizard,
  VestiDashboard,
  type AitiImagery,
  type AitiProfile,
  type DashboardTab,
  type LearnProfile,
} from "@vesti/ui";
import { I18nProvider, useI18n } from "./ui/i18n";
import type { SupportedLocale } from "./ui/i18n/locales";
import { Dock, type ShellPage } from "./ui/shell/Dock";
import { HomeDashboard } from "./ui/shell/HomeDashboard";
import { SettingsPage } from "./ui/shell/SettingsPage";
import { TitleBar } from "./ui/shell/TitleBar";
import { useUiTheme } from "./ui/shell/useUiTheme";
import { useOnboarding } from "./ui/shell/useOnboarding";
import { MembershipGate } from "./ui/membership/MembershipGate";
import { MAIN_SHELL_TABS, type MembershipStatus } from "./shared/contracts";
import { LOGO_BASE64 } from "./ui/logo";
import { desktopStorage } from "./ui/storage/desktopStorage";
import { OWL_MOOD_ICONS } from "./ui/companion/owlIcons";
import {
  getCaptureSyncState,
  startCaptureSync,
  subscribeCaptureSync,
  type CaptureSyncState,
} from "./ui/sync/captureSync";
import { resolveClassifyLanguage, startAutoClassifyTrigger } from "./ui/organize/autoClassify";
import { startUpstreamAutoExport } from "./ui/upstream/autoExport";
import { startDailyScheduler } from "./ui/daily/dailyScheduler";
import { startDreamScheduler } from "./ui/memory/dreamScheduler";
import { startAgentActivityNotifier, startAmbientBubbleScheduler } from "./ui/companion/ambientBubble";
import { migrateDepositsToMemory } from "./ui/deposits/migrateDeposits";
import { startPromptSnapshotSync } from "./ui/sync/promptSnapshot";
import { getAllSummaries, getTopics, listConversations } from "./ui/db/repository";
import { computeAiti } from "./ui/aiti/computeAiti";
import { localizeImagery, resolveImagery } from "./ui/aiti/imagery";
import { emblemUrl } from "./ui/aiti/emblems";
import { getPersonaNote } from "./ui/aiti/personaNote";
import { computeLearn } from "./ui/learn/computeLearn";
import {
  buildPlazaPrompts,
  getCuratedCategories,
  resolveCuratedPrompts,
} from "./ui/promptPlaza/commonPrompts";
import {
  getAdoptedPlazaIds,
  setPlazaAdopted,
  subscribeAdoptedPlazaIds,
} from "./ui/promptPlaza/plazaCollectionService";

const LOADING_COPY: Record<SupportedLocale, { title: string; hint: string }> = {
  zh: { title: "正在同步你的 AI 会话…", hint: "首次启动需要扫描本地数据源,稍候片刻。" },
  en: { title: "Syncing your AI conversations…", hint: "The first launch scans local data sources; this takes a moment." },
  ja: { title: "AI セッションを同期しています…", hint: "初回起動時はローカルデータソースをスキャンします。" },
  ko: { title: "AI 대화를 동기화하는 중…", hint: "첫 실행 시 로컬 데이터 소스를 스캔합니다." },
};

function LoadingState({ copy }: { copy: { title: string; hint: string } }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 bg-bg-app">
      <img src={LOGO_BASE64} alt="Vesti" className="h-14 w-14 animate-pulse" />
      <p className="font-serif text-[18px] text-text-primary">{copy.title}</p>
      <p className="text-[13px] font-sans text-text-tertiary">{copy.hint}</p>
    </div>
  );
}

function Shell({
  membership,
  onLogout,
  themeMode,
  toggleTheme,
}: {
  membership: MembershipStatus;
  onLogout: () => Promise<void>;
  themeMode: "light" | "dark";
  toggleTheme: () => Promise<void>;
}) {
  const { t, locale } = useI18n();
  const [page, setPage] = useState<ShellPage>("home");
  // Home → library source deep link: one-shot platform filter request, handed
  // to VestiDashboard/LibraryTab and cleared once applied.
  const [libraryPlatformFilter, setLibraryPlatformFilter] = useState<string | null>(null);
  const [syncState, setSyncState] = useState<CaptureSyncState>(getCaptureSyncState());
  const [adoptedIds, setAdoptedIds] = useState<string[]>([]);
  const [aiti, setAiti] = useState<AitiProfile | undefined>(undefined);
  const [learn, setLearn] = useState<LearnProfile | undefined>(undefined);
  const [aitiImagery, setAitiImagery] = useState<AitiImagery | null>(null);
  const [aitiPersonaNote, setAitiPersonaNote] = useState<string | null>(null);

  useEffect(() => {
    startCaptureSync();
    startAutoClassifyTrigger();
    startUpstreamAutoExport();
    startDailyScheduler();
    // 做梦为会员专属: the free tier never starts the auto-dream scheduler.
    if (membership.active) startDreamScheduler();
    startAmbientBubbleScheduler();
    startAgentActivityNotifier();
    // One-shot Dexie→memory_entries deposit migration; idempotent (same-id
    // upserts) and a no-op once the memory_meta watermark is stamped.
    void migrateDepositsToMemory().catch(() => undefined);
    startPromptSnapshotSync();
  }, []);

  // Capsule dock → shell navigation (e.g. the 夜话 entry opens Explore).
  useEffect(() => {
    const api = window.vesti;
    if (!api?.onMainTabNavigate) return;
    return api.onMainTabNavigate((tab) => {
      if ((MAIN_SHELL_TABS as readonly string[]).includes(tab)) {
        setPage(tab as ShellPage);
      }
    });
  }, []);

  useEffect(() => subscribeCaptureSync(setSyncState), []);

  useEffect(() => {
    void getAdoptedPlazaIds().then(setAdoptedIds);
    return subscribeAdoptedPlazaIds(setAdoptedIds);
  }, []);

  // AITI / Learn are computed locally from stored summaries; recompute after
  // every successful capture import (signalled by captureSync). Debounced:
  // data-updated arrives in storms and each recompute reads three tables.
  useEffect(() => {
    let cancelled = false;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const recompute = () => {
      void Promise.all([
        getAllSummaries(),
        getTopics(),
        listConversations(),
        // Learn's synthesized route names follow the agent output-language
        // setting (UI locale as fallback), mirroring the classify pipeline.
        window.vesti?.getSettings().catch(() => null) ?? Promise.resolve(null),
        window.vestiUi?.getUiPreference("language").catch(() => null) ?? Promise.resolve(null),
      ])
        .then(([summaries, topics, conversations, settings, uiLanguage]) => {
          if (cancelled) return;
          const learnLang = resolveClassifyLanguage(
            settings?.agent?.outputLanguage,
            (uiLanguage as { locale?: string } | null)?.locale,
          );
          setAiti(computeAiti(summaries));
          setLearn(computeLearn(summaries, topics, conversations, undefined, undefined, learnLang));
        })
        .catch(() => {
          if (cancelled) return;
          setAiti({ available: false, sampleSize: 0, axes: [], obsessions: [] });
          setLearn({ available: false, sampleSize: 0, domains: [], glossary: [], openLoops: [] });
        });
    };
    const scheduleRecompute = () => {
      if (debounce !== null) clearTimeout(debounce);
      debounce = setTimeout(() => {
        debounce = null;
        recompute();
      }, 300);
    };
    recompute();
    window.addEventListener("vesti:data-updated", scheduleRecompute);
    return () => {
      cancelled = true;
      if (debounce !== null) clearTimeout(debounce);
      window.removeEventListener("vesti:data-updated", scheduleRecompute);
    };
  }, []);

  const lang = locale === "zh" ? "zh" : "en";

  // P5 思维意象: resolve the 16-imagery card from the AITI axes (localized),
  // then fetch the LLM persona footnote — recomputed only when the profile or
  // locale changes; the note itself is cached in ui-prefs by personaNote.ts.
  // 会员门控: the persona footnote is an LLM call inside the member-only AITI
  // 画像 feature, so the free tier never requests it (the locally-computed
  // imagery card itself stays visible).
  useEffect(() => {
    if (!aiti?.available) {
      setAitiImagery(null);
      setAitiPersonaNote(null);
      return;
    }
    const resolved = resolveImagery(aiti.axes);
    const localized = resolved ? localizeImagery(resolved, lang) : null;
    setAitiImagery(localized);
    setAitiPersonaNote(null);
    // 会员门控: the persona footnote is a 'persona' agent LLM call; the free
    // tier keeps the locally-computed imagery but never fetches the note.
    if (!localized || !membership.active) return;
    let cancelled = false;
    const sampleLabel = t.dashboard.aiti.sample.replace("{n}", String(aiti.sampleSize));
    void getPersonaNote(localized, aiti, sampleLabel).then((note) => {
      if (!cancelled) setAitiPersonaNote(note);
    });
    return () => {
      cancelled = true;
    };
  }, [aiti, lang, t, membership.active]);
  const plaza = useMemo(() => {
    const daily = buildPlazaPrompts(lang, Date.now()).filter((prompt) => prompt.featured);
    const resolved = resolveCuratedPrompts(lang);
    const supermarket = getCuratedCategories(lang).map((category) => ({
      category,
      prompts: resolved.filter((prompt) => prompt.category === category),
    }));
    return { daily, supermarket, adoptedIds };
  }, [lang, adoptedIds]);

  const dashboardTab: DashboardTab = page === "settings" || page === "home" ? "library" : page;
  const showLoading =
    syncState.conversationCount === 0 && (syncState.syncing || syncState.lastSyncAt === null);
  const syncReady = !showLoading && syncState.conversationCount > 0;
  const onboarding = useOnboarding(locale as SupportedLocale, syncReady);
  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-bg-app text-text-primary">
      {onboarding.show && (
        <OnboardingWizard
          locale={locale as SupportedLocale}
          onComplete={onboarding.complete}
          onSkip={onboarding.skip}
        />
      )}
      <TitleBar />
      <div className="flex min-h-0 flex-1">
        <Dock
          currentPage={page}
          onNavigate={setPage}
          themeMode={themeMode}
          onToggleTheme={() => void toggleTheme()}
        />
        <main className="h-full min-w-0 flex-1">
          {page === "settings" ? (
            <SettingsPage
              themeMode={themeMode}
              onToggleTheme={() => void toggleTheme()}
              membership={membership}
              onLogout={onLogout}
            />
          ) : page === "home" ? (
            <HomeDashboard
              onOpenLibrary={() => setPage("library")}
              onOpenSource={(platform) => {
                setLibraryPlatformFilter(platform);
                setPage("library");
              }}
            />
          ) : showLoading ? (
            <LoadingState copy={LOADING_COPY[locale] ?? LOADING_COPY.en} />
          ) : (
            <VestiDashboard
              storage={desktopStorage}
              logoSrc={LOGO_BASE64}
              themeMode={themeMode}
              onToggleTheme={toggleTheme}
              labels={t.dashboard}
              plaza={plaza}
              onPlazaAdoptToggle={(id, adopt) => {
                void setPlazaAdopted(id, adopt).then(setAdoptedIds);
              }}
              aiti={aiti}
              aitiImagery={aitiImagery}
              aitiEmblemUrl={aitiImagery ? emblemUrl(aitiImagery.emblemId) : undefined}
              aitiPersonaNote={aitiPersonaNote}
              membershipActive={membership.active}
              companionOwlIcons={OWL_MOOD_ICONS}
              learn={learn}
              lang={lang}
              tab={dashboardTab}
              onTabChange={(tab) => setPage(tab)}
              libraryPlatformFilter={libraryPlatformFilter}
              onLibraryPlatformFilterApplied={() => setLibraryPlatformFilter(null)}
            />
          )}
        </main>
      </div>
    </div>
  );
}

export function App() {
  return (
    <I18nProvider>
      <MembershipGate>
        {({ status, logout, themeMode, toggleTheme }) => (
          <Shell
            membership={status}
            onLogout={logout}
            themeMode={themeMode}
            toggleTheme={toggleTheme}
          />
        )}
      </MembershipGate>
    </I18nProvider>
  );
}
