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
import { SplashIntro } from "./ui/shell/SplashIntro";
import { TitleBar } from "./ui/shell/TitleBar";
import { useUiTheme } from "./ui/shell/useUiTheme";
import { useOnboarding } from "./ui/shell/useOnboarding";
import { MembershipGate } from "./ui/membership/MembershipGate";
import { MAIN_SHELL_TABS, type MembershipStatus, type UpdateStatusView } from "./shared/contracts";
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
import { getAllSummaries, getTopics, listConversations, listMessages } from "./ui/db/repository";
import { computeAiti } from "./ui/aiti/computeAiti";
import { computeLocalSignals, type AitiLocalConversationInput } from "./ui/aiti/localSignals";
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

// 更新横幅(轻量 toast,样式与设置页 message toast 一致):检测到新版本/下载完成
// 时出现,可关闭;点击文案跳转到设置页 About 卡片,按钮直接下载/重启安装。
const UPDATE_BANNER_COPY: Record<
  SupportedLocale,
  { available: string; download: string; downloading: string; downloaded: string; restart: string; dismiss: string }
> = {
  zh: {
    available: "发现新版本 v{version}",
    download: "下载更新",
    downloading: "下载中 {percent}%",
    downloaded: "更新已下载,重启后完成安装",
    restart: "重启安装",
    dismiss: "关闭",
  },
  en: {
    available: "New version v{version} available",
    download: "Download",
    downloading: "Downloading {percent}%",
    downloaded: "Update downloaded — restart to install",
    restart: "Restart & install",
    dismiss: "Dismiss",
  },
  ja: {
    available: "新しいバージョン v{version} があります",
    download: "ダウンロード",
    downloading: "ダウンロード中 {percent}%",
    downloaded: "ダウンロード済み — 再起動してインストール",
    restart: "再起動してインストール",
    dismiss: "閉じる",
  },
  ko: {
    available: "새 버전 v{version}을(를) 사용할 수 있습니다",
    download: "다운로드",
    downloading: "다운로드 중 {percent}%",
    downloaded: "다운로드 완료 — 재시작하면 설치됩니다",
    restart: "재시작하여 설치",
    dismiss: "닫기",
  },
};

function UpdateBanner({
  status,
  copy,
  onOpenSettings,
  onDismiss,
}: {
  status: UpdateStatusView;
  copy: (typeof UPDATE_BANNER_COPY)[SupportedLocale];
  onOpenSettings: () => void;
  onDismiss: () => void;
}) {
  const percent = Math.round(status.percent ?? 0);
  const message =
    status.phase === "available"
      ? copy.available.replace("{version}", status.latestVersion ?? "")
      : status.phase === "downloading"
        ? copy.downloading.replace("{percent}", String(percent))
        : copy.downloaded;
  return (
    <div
      role="status"
      className="fixed bottom-4 right-6 z-40 flex max-w-[420px] items-center gap-3 rounded-xl border border-border-subtle bg-bg-primary px-4 py-3 shadow-popover"
    >
      <button
        type="button"
        onClick={onOpenSettings}
        title={message}
        className="min-w-0 flex-1 truncate text-left text-[12px] font-sans text-text-secondary transition-colors hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus"
      >
        {message}
      </button>
      {status.phase === "available" ? (
        <button
          type="button"
          className="shrink-0 rounded-lg bg-accent-primary px-3 py-1.5 text-[12px] font-sans font-medium text-text-inverse transition-colors hover:bg-accent-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus"
          onClick={() => void window.vesti?.downloadUpdate().catch(() => undefined)}
        >
          {copy.download}
        </button>
      ) : status.phase === "downloaded" ? (
        <button
          type="button"
          className="shrink-0 rounded-lg bg-accent-primary px-3 py-1.5 text-[12px] font-sans font-medium text-text-inverse transition-colors hover:bg-accent-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus"
          onClick={() => void window.vesti?.quitAndInstallUpdate().catch(() => undefined)}
        >
          {copy.restart}
        </button>
      ) : null}
      <button
        type="button"
        aria-label={copy.dismiss}
        onClick={onDismiss}
        className="shrink-0 rounded-md px-1.5 py-0.5 text-[13px] font-sans text-text-tertiary transition-colors hover:bg-bg-surface-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus"
      >
        ✕
      </button>
    </div>
  );
}

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
  // Once-per-launch intro splash; the shell mounts underneath while it plays.
  const [splashDone, setSplashDone] = useState(false);
  // Home → library source deep link: one-shot platform filter request, handed
  // to VestiDashboard/LibraryTab and cleared once applied.
  const [libraryPlatformFilter, setLibraryPlatformFilter] = useState<string | null>(null);
  const [syncState, setSyncState] = useState<CaptureSyncState>(getCaptureSyncState());
  const [adoptedIds, setAdoptedIds] = useState<string[]>([]);
  const [aiti, setAiti] = useState<AitiProfile | undefined>(undefined);
  const [learn, setLearn] = useState<LearnProfile | undefined>(undefined);
  const [aitiImagery, setAitiImagery] = useState<AitiImagery | null>(null);
  const [aitiPersonaNote, setAitiPersonaNote] = useState<string | null>(null);
  // 夜话头像:默认心情图标集;owlSkin==='custom' 时整套换成 DIY 皮肤。
  const [owlIcons, setOwlIcons] = useState(OWL_MOOD_ICONS);
  // 自动更新横幅:主进程状态机镜像;关闭状态按 phase+version 记忆,
  // 阶段推进(available→downloading→downloaded)会重新弹出对应提示。
  const [updateStatus, setUpdateStatus] = useState<UpdateStatusView | null>(null);
  const [updateBannerDismissed, setUpdateBannerDismissed] = useState<string | null>(null);

  useEffect(() => {
    const api = window.vesti;
    if (!api?.getUpdateStatus) return;
    let cancelled = false;
    void api
      .getUpdateStatus()
      .then((status) => {
        if (!cancelled) setUpdateStatus(status);
      })
      .catch(() => undefined);
    const off = api.onUpdateStatusChanged(setUpdateStatus);
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  // Follow the floating-ball skin pref: the custom DIY owl replaces every
  // mood icon (it has no mood variants of its own), built-in skins restore
  // the default set. Regeneration signals via owlCustomUpdatedAt.
  useEffect(() => {
    const bridge = window.vestiUi;
    if (!bridge) return;
    let cancelled = false;
    const apply = async () => {
      const skinPref = await bridge.getUiPreference("owlSkin").catch(() => null);
      if (skinPref === "custom") {
        const asset = await window.vesti?.readCustomOwl().catch(() => null);
        if (asset?.dataUrl) {
          const all = { ...OWL_MOOD_ICONS };
          for (const mood of Object.keys(all)) {
            all[mood as keyof typeof all] = asset.dataUrl;
          }
          if (!cancelled) setOwlIcons(all);
          return;
        }
      }
      if (!cancelled) setOwlIcons(OWL_MOOD_ICONS);
    };
    void apply();
    const off = bridge.onUiPreferenceChanged((key) => {
      if (key === "owlSkin" || key === "owlCustomUpdatedAt") void apply();
    });
    return () => {
      cancelled = true;
      off();
    };
  }, []);

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
      // Topic counts reuse the same conversation list (one Dexie scan);
      // getTopics falls back to its own scan if the list load fails.
      const conversationsPromise = listConversations();
      void Promise.all([
        getAllSummaries(),
        conversationsPromise.then(
          (conversations) => getTopics(conversations),
          () => getTopics()
        ),
        conversationsPromise,
        // Learn's synthesized route names follow the agent output-language
        // setting (UI locale as fallback), mirroring the classify pipeline.
        window.vesti?.getSettings().catch(() => null) ?? Promise.resolve(null),
        window.vestiUi?.getUiPreference("language").catch(() => null) ?? Promise.resolve(null),
      ])
        .then(async ([summaries, topics, conversations, settings, uiLanguage]) => {
          if (cancelled) return;
          const learnLang = resolveClassifyLanguage(
            settings?.agent?.outputLanguage,
            (uiLanguage as { locale?: string } | null)?.locale,
          );
          // 初步画像的本地信号: when structured summaries are scarce, stats
          // from raw user messages (recent 100 conversations) still produce a
          // preliminary portrait. Full-signal conversations are unaffected.
          const recent = conversations.slice(0, 100);
          const localInputs = await Promise.all(
            recent.map((conv) =>
              listMessages(conv.id)
                .then(
                  (msgs): AitiLocalConversationInput => ({
                    conversationId: conv.id,
                    updatedAt: conv.updated_at,
                    messages: msgs.map((m) => ({
                      role: m.role,
                      content: m.content_text,
                      createdAt: m.created_at,
                    })),
                  }),
                )
                .catch((): AitiLocalConversationInput => ({
                  conversationId: conv.id,
                  updatedAt: conv.updated_at,
                  messages: [],
                })),
            ),
          );
          if (cancelled) return;
          setAiti(computeAiti(summaries, computeLocalSignals(localInputs)));
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
  const updateBannerKey =
    updateStatus?.enabled &&
    (updateStatus.phase === "available" ||
      updateStatus.phase === "downloading" ||
      updateStatus.phase === "downloaded")
      ? `${updateStatus.phase}:${updateStatus.latestVersion ?? ""}`
      : null;
  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-bg-app text-text-primary">
      {!splashDone && <SplashIntro onDone={() => setSplashDone(true)} />}
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
              companionOwlIcons={owlIcons}
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
      {updateBannerKey !== null && updateBannerDismissed !== updateBannerKey && updateStatus ? (
        <UpdateBanner
          status={updateStatus}
          copy={UPDATE_BANNER_COPY[locale] ?? UPDATE_BANNER_COPY.en}
          onOpenSettings={() => setPage("settings")}
          onDismiss={() => setUpdateBannerDismissed(updateBannerKey)}
        />
      ) : null}
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
