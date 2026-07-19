import { useEffect, useMemo, useState } from "react";
import {
  VestiDashboard,
  type AitiImagery,
  type AitiProfile,
  type DashboardTab,
  type LearnProfile,
} from "@vesti/ui";
import { I18nProvider, useI18n } from "./ui/i18n";
import type { SupportedLocale } from "./ui/i18n/locales";
import { Dock, type ShellPage } from "./ui/shell/Dock";
import { SettingsPage } from "./ui/shell/SettingsPage";
import { TitleBar } from "./ui/shell/TitleBar";
import { useUiTheme } from "./ui/shell/useUiTheme";
import { LOGO_BASE64 } from "./ui/logo";
import { desktopStorage } from "./ui/storage/desktopStorage";
import {
  getCaptureSyncState,
  startCaptureSync,
  subscribeCaptureSync,
  type CaptureSyncState,
} from "./ui/sync/captureSync";
import { startAutoClassifyTrigger } from "./ui/organize/autoClassify";
import { startUpstreamAutoExport } from "./ui/upstream/autoExport";
import { startDailyScheduler } from "./ui/daily/dailyScheduler";
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

function Shell() {
  const { t, locale } = useI18n();
  const { themeMode, toggleTheme } = useUiTheme();
  const [page, setPage] = useState<ShellPage>("library");
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
  }, []);

  useEffect(() => subscribeCaptureSync(setSyncState), []);

  useEffect(() => {
    void getAdoptedPlazaIds().then(setAdoptedIds);
    return subscribeAdoptedPlazaIds(setAdoptedIds);
  }, []);

  // AITI / Learn are computed locally from stored summaries; recompute after
  // every successful capture import (signalled by captureSync).
  useEffect(() => {
    let cancelled = false;
    const recompute = () => {
      void Promise.all([getAllSummaries(), getTopics(), listConversations()])
        .then(([summaries, topics, conversations]) => {
          if (cancelled) return;
          setAiti(computeAiti(summaries));
          setLearn(computeLearn(summaries, topics, conversations));
        })
        .catch(() => {
          if (cancelled) return;
          setAiti({ available: false, sampleSize: 0, axes: [], obsessions: [] });
          setLearn({ available: false, sampleSize: 0, domains: [], glossary: [], openLoops: [] });
        });
    };
    recompute();
    window.addEventListener("vesti:data-updated", recompute);
    return () => {
      cancelled = true;
      window.removeEventListener("vesti:data-updated", recompute);
    };
  }, []);

  const lang = locale === "zh" ? "zh" : "en";

  // P5 思维意象: resolve the 16-imagery card from the AITI axes (localized),
  // then fetch the LLM persona footnote — recomputed only when the profile or
  // locale changes; the note itself is cached in ui-prefs by personaNote.ts.
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
    if (!localized) return;
    let cancelled = false;
    const sampleLabel = t.dashboard.aiti.sample.replace("{n}", String(aiti.sampleSize));
    void getPersonaNote(localized, aiti, sampleLabel).then((note) => {
      if (!cancelled) setAitiPersonaNote(note);
    });
    return () => {
      cancelled = true;
    };
  }, [aiti, lang, t]);
  const plaza = useMemo(() => {
    const daily = buildPlazaPrompts(lang, Date.now()).filter((prompt) => prompt.featured);
    const resolved = resolveCuratedPrompts(lang);
    const supermarket = getCuratedCategories(lang).map((category) => ({
      category,
      prompts: resolved.filter((prompt) => prompt.category === category),
    }));
    return { daily, supermarket, adoptedIds };
  }, [lang, adoptedIds]);

  const dashboardTab: DashboardTab = page === "settings" ? "library" : page;
  const showLoading =
    syncState.conversationCount === 0 && (syncState.syncing || syncState.lastSyncAt === null);

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-bg-app text-text-primary">
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
            <SettingsPage themeMode={themeMode} onToggleTheme={() => void toggleTheme()} />
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
              learn={learn}
              tab={dashboardTab}
              onTabChange={(tab) => setPage(tab)}
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
      <Shell />
    </I18nProvider>
  );
}
