import {
  Activity,
  ArrowRight,
  Bot,
  Database,
  FolderGit2,
  MessageSquareText,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import type { Overview } from "../../shared/contracts";
import { useI18n } from "../i18n";
import type { SupportedLocale } from "../i18n/locales";
import { basename, fillDailyUsage, rankUsage, type DailyUsagePoint } from "./homeDashboardData";

const EMPTY_OVERVIEW: Overview = {
  sources: [],
  sessions: [],
  totals: { conversations: 0, messages: 0, inputTokens: 0, outputTokens: 0, storageSize: 0 },
  analytics: {
    cacheTokens: 0,
    platformBreakdown: {},
    platformTokenBreakdown: {},
    modelBreakdown: {},
    modelTokenBreakdown: {},
    dailyActivity: [],
    dailyTokenUsage: [],
    topProjects: [],
    toolCategoryBreakdown: {},
  },
  watching: false,
  syncing: false,
};

interface HomeCopy {
  eyebrow: string;
  title: string;
  subtitle: string;
  openLibrary: string;
  refreshing: string;
  refresh: string;
  capturing: string;
  paused: string;
  totalTokens: string;
  totalTokensHint: string;
  conversations: string;
  conversationsHint: string;
  messages: string;
  messagesHint: string;
  sources: string;
  sourcesHint: string;
  tokenTrend: string;
  tokenTrendHint: string;
  input: string;
  output: string;
  noTokenData: string;
  platformUsage: string;
  platformUsageHint: string;
  viewSource: string;
  conversationsUnit: string;
  modelUsage: string;
  modelUsageHint: string;
  recent: string;
  recentHint: string;
  projects: string;
  projectsHint: string;
  untitled: string;
  unknownModel: string;
  noData: string;
  loadFailed: string;
  retry: string;
}

const HOME_COPY: Record<SupportedLocale, HomeCopy> = {
  zh: {
    eyebrow: "VESTI / OVERVIEW",
    title: "你的 AI 工作概览",
    subtitle: "基于本地捕获记录生成，Token、会话和模型数据均来自真实会话。",
    openLibrary: "查看对话库",
    refreshing: "刷新中",
    refresh: "刷新数据",
    capturing: "实时捕获中",
    paused: "捕获已暂停",
    totalTokens: "累计 Token",
    totalTokensHint: "输入与输出 Token 合计",
    conversations: "对话总数",
    conversationsHint: "已进入本地知识库",
    messages: "消息总数",
    messagesHint: "用户、AI 与工具消息",
    sources: "数据来源",
    sourcesHint: "已检测 / 已启用",
    tokenTrend: "Token 消耗趋势",
    tokenTrendHint: "最近 30 天；按每次模型调用的真实发生时间统计",
    input: "输入 Token",
    output: "输出 Token",
    noTokenData: "捕获到真实 Token 后，趋势会显示在这里。",
    platformUsage: "Agent 分布",
    platformUsageHint: "各平台的对话和 Token 占比",
    viewSource: "在会话库中查看 {label}",
    conversationsUnit: "个对话",
    modelUsage: "模型消耗",
    modelUsageHint: "按照真实 Token 使用量排序",
    recent: "最近对话",
    recentHint: "按最后活动时间排列",
    projects: "活跃项目",
    projectsHint: "对话数量最多的本地项目",
    untitled: "未命名对话",
    unknownModel: "未报告模型",
    noData: "暂无数据",
    loadFailed: "无法读取本地统计数据。",
    retry: "重试",
  },
  en: {
    eyebrow: "VESTI / OVERVIEW",
    title: "Your AI work at a glance",
    subtitle: "Built from locally captured sessions. Token, session, and model metrics are real data.",
    openLibrary: "Open library",
    refreshing: "Refreshing",
    refresh: "Refresh data",
    capturing: "Capture active",
    paused: "Capture paused",
    totalTokens: "Total tokens",
    totalTokensHint: "Input and output combined",
    conversations: "Conversations",
    conversationsHint: "Stored in your local library",
    messages: "Messages",
    messagesHint: "User, AI, and tool messages",
    sources: "Sources",
    sourcesHint: "Detected / enabled",
    tokenTrend: "Token usage trend",
    tokenTrendHint: "Last 30 days, grouped by each model call's actual time",
    input: "Input tokens",
    output: "Output tokens",
    noTokenData: "The trend will appear after real token usage is captured.",
    platformUsage: "Agent distribution",
    platformUsageHint: "Conversation and token share by platform",
    viewSource: "View {label} in the library",
    conversationsUnit: "conversations",
    modelUsage: "Model usage",
    modelUsageHint: "Ranked by reported token usage",
    recent: "Recent conversations",
    recentHint: "Ordered by last activity",
    projects: "Active projects",
    projectsHint: "Local projects with the most conversations",
    untitled: "Untitled conversation",
    unknownModel: "Model not reported",
    noData: "No data yet",
    loadFailed: "Could not read local analytics.",
    retry: "Retry",
  },
  ja: {
    eyebrow: "VESTI / OVERVIEW",
    title: "AI ワークの概要",
    subtitle: "ローカルでキャプチャした実際のセッション、トークン、モデル情報から生成されます。",
    openLibrary: "ライブラリを開く",
    refreshing: "更新中",
    refresh: "データを更新",
    capturing: "キャプチャ中",
    paused: "キャプチャ停止中",
    totalTokens: "合計トークン",
    totalTokensHint: "入力と出力の合計",
    conversations: "会話数",
    conversationsHint: "ローカルに保存済み",
    messages: "メッセージ数",
    messagesHint: "ユーザー、AI、ツール",
    sources: "データソース",
    sourcesHint: "検出 / 有効",
    tokenTrend: "トークン使用推移",
    tokenTrendHint: "直近 30 日。各モデル呼び出しの実際の時刻で集計",
    input: "入力トークン",
    output: "出力トークン",
    noTokenData: "トークンを取得すると推移が表示されます。",
    platformUsage: "エージェント分布",
    platformUsageHint: "プラットフォーム別の会話とトークン",
    viewSource: "ライブラリで {label} を表示",
    conversationsUnit: "件",
    modelUsage: "モデル使用量",
    modelUsageHint: "実際のトークン使用量順",
    recent: "最近の会話",
    recentHint: "最終活動順",
    projects: "アクティブプロジェクト",
    projectsHint: "会話数の多いローカルプロジェクト",
    untitled: "無題の会話",
    unknownModel: "モデル未報告",
    noData: "データがありません",
    loadFailed: "ローカル統計を読み込めませんでした。",
    retry: "再試行",
  },
  ko: {
    eyebrow: "VESTI / OVERVIEW",
    title: "AI 작업 개요",
    subtitle: "로컬에서 캡처한 실제 세션, 토큰 및 모델 데이터로 생성됩니다.",
    openLibrary: "대화 라이브러리",
    refreshing: "새로고침 중",
    refresh: "데이터 새로고침",
    capturing: "캡처 중",
    paused: "캡처 일시 중지",
    totalTokens: "총 토큰",
    totalTokensHint: "입력 및 출력 합계",
    conversations: "대화",
    conversationsHint: "로컬 라이브러리에 저장됨",
    messages: "메시지",
    messagesHint: "사용자, AI 및 도구 메시지",
    sources: "데이터 소스",
    sourcesHint: "감지 / 활성화",
    tokenTrend: "토큰 사용 추세",
    tokenTrendHint: "최근 30일, 각 모델 호출이 실제 발생한 시간으로 집계",
    input: "입력 토큰",
    output: "출력 토큰",
    noTokenData: "실제 토큰이 캡처되면 추세가 표시됩니다.",
    platformUsage: "에이전트 분포",
    platformUsageHint: "플랫폼별 대화 및 토큰 비율",
    viewSource: "라이브러리에서 {label} 보기",
    conversationsUnit: "개 대화",
    modelUsage: "모델 사용량",
    modelUsageHint: "실제 토큰 사용량순",
    recent: "최근 대화",
    recentHint: "마지막 활동순",
    projects: "활성 프로젝트",
    projectsHint: "대화가 가장 많은 로컬 프로젝트",
    untitled: "제목 없는 대화",
    unknownModel: "보고되지 않은 모델",
    noData: "데이터 없음",
    loadFailed: "로컬 통계를 읽을 수 없습니다.",
    retry: "다시 시도",
  },
};

const PLATFORM_META: Record<string, { label: string; color: string }> = {
  codex: { label: "Codex", color: "#5269d9" },
  cursor: { label: "Cursor", color: "#20252d" },
  "kimi-code": { label: "Kimi Code", color: "#8a62c7" },
  "claude-code": { label: "Claude Code", color: "#c96c46" },
  aider: { label: "Aider", color: "#2f8f76" },
};

function numberLocale(locale: SupportedLocale): string {
  if (locale === "zh") return "zh-CN";
  if (locale === "ja") return "ja-JP";
  if (locale === "ko") return "ko-KR";
  return "en-US";
}

function compact(value: number, locale: SupportedLocale): string {
  return new Intl.NumberFormat(numberLocale(locale), {
    notation: "compact",
    maximumFractionDigits: value >= 1_000_000 ? 1 : 0,
  }).format(value);
}

function exact(value: number, locale: SupportedLocale): string {
  return new Intl.NumberFormat(numberLocale(locale)).format(value);
}

function relativeTime(timestamp: number, locale: SupportedLocale): string {
  const deltaMinutes = Math.round((timestamp - Date.now()) / 60_000);
  const formatter = new Intl.RelativeTimeFormat(numberLocale(locale), { numeric: "auto" });
  if (Math.abs(deltaMinutes) < 60) return formatter.format(deltaMinutes, "minute");
  const hours = Math.round(deltaMinutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
  return formatter.format(Math.round(hours / 24), "day");
}

export function HomeDashboard({
  onOpenLibrary,
  onOpenSource,
}: {
  onOpenLibrary: () => void;
  /** Source deep link: open the library filtered to this platform. */
  onOpenSource: (platform: string) => void;
}) {
  const { locale } = useI18n();
  const copy = HOME_COPY[locale] ?? HOME_COPY.en;
  const [overview, setOverview] = useState<Overview>(EMPTY_OVERVIEW);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setOverview(await window.vesti.getOverview());
      setError(null);
    } catch (loadError) {
      console.error("[home-dashboard] Failed to load overview", loadError);
      setError(copy.loadFailed);
    } finally {
      setLoading(false);
    }
  }, [copy.loadFailed]);

  const syncAndLoad = useCallback(async () => {
    setLoading(true);
    try {
      const summary = await window.vesti.sync();
      if (summary.errors.length > 0) {
        console.warn("[home-dashboard] Capture refresh completed with errors", summary.errors);
      }
      setOverview(await window.vesti.getOverview());
      // A source-level parse error is reported in the console, but it must not
      // hide a successfully refreshed overview from every other source.
      setError(null);
    } catch (syncError) {
      console.error("[home-dashboard] Failed to refresh capture data", syncError);
      setError(copy.loadFailed);
    } finally {
      setLoading(false);
    }
  }, [copy.loadFailed]);

  useEffect(() => {
    void load();
    // Capture ticks fire per stored file and in bursts during a full sync;
    // coalesce them so a burst costs one getOverview IPC instead of one per
    // tick (mirrors captureSync's debounce).
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = window.vesti.onCaptureChanged(() => {
      if (debounceTimer !== null) {
        clearTimeout(debounceTimer);
      }
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        void load();
      }, 500);
    });
    const onDataUpdated = () => void load();
    window.addEventListener("vesti:data-updated", onDataUpdated);
    return () => {
      if (debounceTimer !== null) {
        clearTimeout(debounceTimer);
      }
      unsubscribe();
      window.removeEventListener("vesti:data-updated", onDataUpdated);
    };
  }, [load]);

  const totalTokens = overview.totals.inputTokens + overview.totals.outputTokens;
  const detectedSources = overview.sources.filter((source) => source.installed).length;
  const enabledSources = overview.sources.filter((source) => source.enabled).length;
  const platformUsage = useMemo(
    () => rankUsage(overview.analytics.platformTokenBreakdown),
    [overview.analytics.platformTokenBreakdown],
  );
  const modelUsage = useMemo(
    () => rankUsage(overview.analytics.modelTokenBreakdown).slice(0, 7),
    [overview.analytics.modelTokenBreakdown],
  );
  const dailyUsage = useMemo(
    () => fillDailyUsage(overview.analytics.dailyTokenUsage, 30),
    [overview.analytics.dailyTokenUsage],
  );
  const visibleTokenTotals = useMemo(
    () => dailyUsage.reduce(
      (sum, point) => ({
        inputTokens: sum.inputTokens + point.inputTokens,
        outputTokens: sum.outputTokens + point.outputTokens,
      }),
      { inputTokens: 0, outputTokens: 0 },
    ),
    [dailyUsage],
  );
  const recentSessions = useMemo(
    () => [...overview.sessions].sort((a, b) => b.lastActivityAt - a.lastActivityAt).slice(0, 6),
    [overview.sessions],
  );
  const topProjects = overview.analytics.topProjects.slice(0, 6);

  return (
    <div className="h-full overflow-y-auto bg-bg-app">
      <div className="mx-auto w-full max-w-[1500px] px-6 pb-12 pt-8 xl:px-10">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.24em] text-accent-primary">
              {copy.eyebrow}
            </p>
            <h1 className="mt-2 font-serif text-[32px] font-medium tracking-[-0.025em] text-text-primary xl:text-[38px]">
              {copy.title}
            </h1>
            <p className="mt-2 max-w-2xl text-[13px] leading-6 text-text-tertiary">{copy.subtitle}</p>
          </div>
          <div className="flex items-center gap-2">
            <div className="mr-1 inline-flex h-9 items-center gap-2 rounded-full border border-border-subtle bg-bg-primary px-3 text-[12px] text-text-secondary">
              <span className={`h-2 w-2 rounded-full ${overview.watching ? "bg-success" : "bg-text-tertiary"}`} />
              {overview.watching ? copy.capturing : copy.paused}
            </div>
            <button
              type="button"
              onClick={() => void syncAndLoad()}
              disabled={loading}
              aria-label={copy.refresh}
              className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-border-subtle bg-bg-primary text-text-secondary transition-colors hover:border-border-default hover:text-text-primary disabled:opacity-50"
            >
              <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} strokeWidth={1.7} />
            </button>
            <button
              type="button"
              onClick={onOpenLibrary}
              className="inline-flex h-9 items-center gap-2 rounded-lg bg-accent-primary px-4 text-[12px] font-medium text-text-inverse transition-colors hover:bg-accent-primary-hover"
            >
              {copy.openLibrary}
              <ArrowRight className="h-3.5 w-3.5" strokeWidth={1.8} />
            </button>
          </div>
        </div>

        {error ? (
          <div className="mt-8 flex items-center justify-between rounded-card border border-danger/30 bg-danger/5 p-4 text-[13px] text-danger">
            <span>{error}</span>
            <button type="button" onClick={() => void syncAndLoad()} className="font-medium underline underline-offset-4">
              {copy.retry}
            </button>
          </div>
        ) : null}

        <div className="mt-8 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <MetricCard
            icon={<Sparkles className="h-5 w-5" strokeWidth={1.65} />}
            label={copy.totalTokens}
            value={compact(totalTokens, locale)}
            exactValue={exact(totalTokens, locale)}
            hint={copy.totalTokensHint}
            accent
          />
          <MetricCard
            icon={<Database className="h-5 w-5" strokeWidth={1.65} />}
            label={copy.conversations}
            value={exact(overview.totals.conversations, locale)}
            hint={copy.conversationsHint}
          />
          <MetricCard
            icon={<MessageSquareText className="h-5 w-5" strokeWidth={1.65} />}
            label={copy.messages}
            value={compact(overview.totals.messages, locale)}
            exactValue={exact(overview.totals.messages, locale)}
            hint={copy.messagesHint}
          />
          <MetricCard
            icon={<Bot className="h-5 w-5" strokeWidth={1.65} />}
            label={copy.sources}
            value={`${detectedSources} / ${enabledSources}`}
            hint={copy.sourcesHint}
          />
        </div>

        <div className="mt-4 grid min-h-[390px] gap-4 xl:grid-cols-[minmax(0,1.8fr)_minmax(320px,0.7fr)]">
          <Panel title={copy.tokenTrend} hint={copy.tokenTrendHint}>
            <div className="mb-4 flex items-center gap-5 text-[11px] text-text-tertiary">
              <Legend color="#5269d9" label={copy.input} value={visibleTokenTotals.inputTokens} locale={locale} />
              <Legend color="#c98548" label={copy.output} value={visibleTokenTotals.outputTokens} locale={locale} />
            </div>
            <TokenTrendChart
              points={dailyUsage}
              locale={locale}
              emptyLabel={copy.noTokenData}
              inputLabel={copy.input}
              outputLabel={copy.output}
            />
          </Panel>

          <Panel title={copy.platformUsage} hint={copy.platformUsageHint}>
            <div className="mt-1 space-y-5">
              {platformUsage.length === 0 ? (
                <Empty label={copy.noData} />
              ) : (
                platformUsage.map((row) => {
                  const meta = PLATFORM_META[row.id] ?? { label: row.id, color: "#7a8190" };
                  const share = totalTokens > 0 ? (row.totalTokens / totalTokens) * 100 : 0;
                  const viewLabel = copy.viewSource.replace("{label}", meta.label);
                  return (
                    <button
                      key={row.id}
                      type="button"
                      onClick={() => onOpenSource(row.id)}
                      aria-label={viewLabel}
                      title={viewLabel}
                      className="-mx-2 block w-[calc(100%+1rem)] rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-accent-primary-light focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus"
                    >
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex min-w-0 items-center gap-2.5">
                          <span className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: meta.color }} />
                          <div className="min-w-0">
                            <p className="truncate text-[13px] font-semibold text-text-primary">{meta.label}</p>
                            <p className="mt-0.5 text-[11px] text-text-tertiary">
                              {row.conversations} {copy.conversationsUnit}
                            </p>
                          </div>
                        </div>
                        <div className="text-right">
                          <p className="font-mono text-[13px] font-semibold text-text-primary">{compact(row.totalTokens, locale)}</p>
                          <p className="mt-0.5 text-[10px] text-text-tertiary">{share.toFixed(1)}%</p>
                        </div>
                      </div>
                      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-bg-surface-hover">
                        <div
                          className="h-full rounded-full transition-[width] duration-500"
                          style={{ width: `${Math.max(share, row.totalTokens > 0 ? 2 : 0)}%`, backgroundColor: meta.color }}
                        />
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          </Panel>
        </div>

        <div className="mt-4 grid gap-4 xl:grid-cols-3">
          <Panel title={copy.modelUsage} hint={copy.modelUsageHint} compactPanel>
            <RankedList
              rows={modelUsage.map((row) => ({
                id: row.id,
                label: row.id || copy.unknownModel,
                meta: `${row.conversations} ${copy.conversationsUnit}`,
                value: compact(row.totalTokens, locale),
                weight: row.totalTokens,
              }))}
              emptyLabel={copy.noData}
            />
          </Panel>

          <Panel title={copy.recent} hint={copy.recentHint} compactPanel>
            <div className="divide-y divide-border-subtle">
              {recentSessions.length === 0 ? (
                <Empty label={copy.noData} />
              ) : (
                recentSessions.map((session) => (
                  <div key={session.id} className="flex items-center gap-3 py-3 first:pt-1">
                    <div
                      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[10px] font-semibold text-white"
                      style={{ backgroundColor: PLATFORM_META[session.platform]?.color ?? "#7a8190" }}
                    >
                      {(PLATFORM_META[session.platform]?.label ?? session.platform).slice(0, 1)}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[12px] font-medium text-text-primary">{session.title || copy.untitled}</p>
                      <p className="mt-1 truncate text-[10px] text-text-tertiary">
                        {session.model || copy.unknownModel} · {relativeTime(session.lastActivityAt, locale)}
                      </p>
                    </div>
                    <span className="font-mono text-[11px] text-text-secondary">
                      {compact(session.totalInputTokens + session.totalOutputTokens, locale)}
                    </span>
                  </div>
                ))
              )}
            </div>
          </Panel>

          <Panel title={copy.projects} hint={copy.projectsHint} compactPanel>
            <RankedList
              rows={topProjects.map((project) => ({
                id: project.path,
                label: basename(project.path),
                meta: project.path,
                value: exact(project.conversations, locale),
                weight: project.conversations,
              }))}
              emptyLabel={copy.noData}
              icon={<FolderGit2 className="h-3.5 w-3.5" strokeWidth={1.65} />}
            />
          </Panel>
        </div>
      </div>
    </div>
  );
}

function MetricCard({
  icon,
  label,
  value,
  exactValue,
  hint,
  accent = false,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  exactValue?: string;
  hint: string;
  accent?: boolean;
}) {
  return (
    <div className={`relative overflow-hidden rounded-card border p-5 ${accent ? "border-accent-primary/25 bg-accent-primary-light" : "border-border-subtle bg-bg-primary"}`}>
      <div className="flex items-center justify-between">
        <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-text-tertiary">{label}</p>
        <span className={accent ? "text-accent-primary" : "text-text-tertiary"}>{icon}</span>
      </div>
      <p className="mt-5 font-serif text-[30px] leading-none tracking-[-0.02em] text-text-primary" title={exactValue}>
        {value}
      </p>
      <p className="mt-3 text-[11px] text-text-tertiary">{hint}</p>
    </div>
  );
}

function Panel({
  title,
  hint,
  children,
  compactPanel = false,
}: {
  title: string;
  hint: string;
  children: ReactNode;
  compactPanel?: boolean;
}) {
  return (
    <section className={`rounded-card border border-border-subtle bg-bg-primary ${compactPanel ? "p-5" : "p-6"}`}>
      <div className="mb-5">
        <h2 className="font-serif text-[20px] font-medium text-text-primary">{title}</h2>
        <p className="mt-1 text-[11px] leading-5 text-text-tertiary">{hint}</p>
      </div>
      {children}
    </section>
  );
}

function Legend({ color, label, value, locale }: { color: string; label: string; value: number; locale: SupportedLocale }) {
  return (
    <div className="flex items-center gap-2">
      <span className="h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
      <span>{label}</span>
      <span className="font-mono font-semibold text-text-secondary">{compact(value, locale)}</span>
    </div>
  );
}

function TokenTrendChart({
  points,
  locale,
  emptyLabel,
  inputLabel,
  outputLabel,
}: {
  points: DailyUsagePoint[];
  locale: SupportedLocale;
  emptyLabel: string;
  inputLabel: string;
  outputLabel: string;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const width = 840;
  const height = 250;
  const padding = { top: 16, right: 14, bottom: 34, left: 54 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const maxValue = Math.max(0, ...points.flatMap((point) => [point.inputTokens, point.outputTokens]));
  const chartMax = maxValue > 0 ? maxValue * 1.08 : 1;
  const x = (index: number) => padding.left + (index / Math.max(1, points.length - 1)) * plotWidth;
  const y = (value: number) => padding.top + plotHeight - (value / chartMax) * plotHeight;
  const pathFor = (key: "inputTokens" | "outputTokens") =>
    points.map((point, index) => `${index === 0 ? "M" : "L"}${x(index).toFixed(1)},${y(point[key]).toFixed(1)}`).join(" ");
  const labelIndexes = new Set([0, 7, 14, 21, points.length - 1].filter((index) => index >= 0 && index < points.length));
  const hoveredPoint = hoveredIndex === null ? null : points[hoveredIndex];
  const tooltipWidth = 190;
  const tooltipHeight = 68;
  const tooltipX = hoveredIndex === null
    ? 0
    : Math.min(width - padding.right - tooltipWidth, Math.max(padding.left, x(hoveredIndex) - tooltipWidth / 2));

  const handlePointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    const bounds = svgRef.current?.getBoundingClientRect();
    if (!bounds || points.length === 0) return;
    const viewX = ((event.clientX - bounds.left) / Math.max(1, bounds.width)) * width;
    const ratio = Math.min(1, Math.max(0, (viewX - padding.left) / plotWidth));
    setHoveredIndex(Math.round(ratio * Math.max(0, points.length - 1)));
  };

  if (maxValue === 0) {
    return (
      <div className="flex h-[250px] items-center justify-center rounded-lg border border-dashed border-border-subtle bg-bg-app/60 text-center text-[12px] text-text-tertiary">
        {emptyLabel}
      </div>
    );
  }

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${width} ${height}`}
      className="h-[250px] w-full touch-none"
      role="img"
      aria-label="Token trend"
      onPointerMove={handlePointerMove}
      onPointerLeave={() => setHoveredIndex(null)}
    >
      {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
        const lineY = padding.top + plotHeight * ratio;
        const value = chartMax * (1 - ratio);
        return (
          <g key={ratio}>
            <line x1={padding.left} x2={width - padding.right} y1={lineY} y2={lineY} stroke="hsl(var(--border-subtle))" strokeWidth="1" />
            <text x={padding.left - 9} y={lineY + 4} textAnchor="end" fill="hsl(var(--text-tertiary))" fontSize="10">
              {compact(Math.round(value), locale)}
            </text>
          </g>
        );
      })}
      <path d={pathFor("inputTokens")} fill="none" stroke="#5269d9" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d={pathFor("outputTokens")} fill="none" stroke="#c98548" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      {points.map((point, index) => (
        <g key={point.date}>
          <circle cx={x(index)} cy={y(point.inputTokens)} r="2.6" fill="#5269d9">
            <title>{`${point.date}: ${exact(point.inputTokens, locale)}`}</title>
          </circle>
          <circle cx={x(index)} cy={y(point.outputTokens)} r="2.6" fill="#c98548">
            <title>{`${point.date}: ${exact(point.outputTokens, locale)}`}</title>
          </circle>
          {labelIndexes.has(index) ? (
            <text x={x(index)} y={height - 8} textAnchor={index === 0 ? "start" : index === points.length - 1 ? "end" : "middle"} fill="hsl(var(--text-tertiary))" fontSize="10">
              {point.date.slice(5).replace("-", "/")}
            </text>
          ) : null}
        </g>
      ))}
      <rect
        x={padding.left}
        y={padding.top}
        width={plotWidth}
        height={plotHeight}
        fill="transparent"
        pointerEvents="all"
      />
      {hoveredPoint && hoveredIndex !== null ? (
        <g pointerEvents="none">
          <line
            x1={x(hoveredIndex)}
            x2={x(hoveredIndex)}
            y1={padding.top}
            y2={padding.top + plotHeight}
            stroke="hsl(var(--text-tertiary) / 0.55)"
            strokeDasharray="4 4"
          />
          <circle cx={x(hoveredIndex)} cy={y(hoveredPoint.inputTokens)} r="5" fill="#5269d9" stroke="hsl(var(--bg-primary))" strokeWidth="2" />
          <circle cx={x(hoveredIndex)} cy={y(hoveredPoint.outputTokens)} r="5" fill="#c98548" stroke="hsl(var(--bg-primary))" strokeWidth="2" />
          <g transform={`translate(${tooltipX}, ${padding.top + 6})`}>
            <rect width={tooltipWidth} height={tooltipHeight} rx="8" fill="hsl(var(--bg-primary))" stroke="hsl(var(--border-default))" />
            <text x="11" y="17" fill="hsl(var(--text-primary))" fontSize="10.5" fontWeight="600">
              {new Date(`${hoveredPoint.date}T00:00:00`).toLocaleDateString(numberLocale(locale), { year: "numeric", month: "short", day: "numeric" })}
            </text>
            <circle cx="13" cy="35" r="3" fill="#5269d9" />
            <text x="22" y="39" fill="hsl(var(--text-secondary))" fontSize="10">
              {inputLabel}: {exact(hoveredPoint.inputTokens, locale)}
            </text>
            <circle cx="13" cy="54" r="3" fill="#c98548" />
            <text x="22" y="58" fill="hsl(var(--text-secondary))" fontSize="10">
              {outputLabel}: {exact(hoveredPoint.outputTokens, locale)}
            </text>
          </g>
        </g>
      ) : null}
    </svg>
  );
}

interface RankedRow {
  id: string;
  label: string;
  meta: string;
  value: string;
  weight: number;
}

function RankedList({ rows, emptyLabel, icon }: { rows: RankedRow[]; emptyLabel: string; icon?: ReactNode }) {
  const maxWeight = Math.max(1, ...rows.map((row) => row.weight));
  if (rows.length === 0) return <Empty label={emptyLabel} />;
  return (
    <div className="space-y-4">
      {rows.map((row, index) => (
        <div key={row.id}>
          <div className="flex items-center gap-3">
            <span className="w-5 shrink-0 font-mono text-[10px] text-text-tertiary">{String(index + 1).padStart(2, "0")}</span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                {icon ? <span className="shrink-0 text-text-tertiary">{icon}</span> : null}
                <p className="truncate text-[12px] font-semibold text-text-primary" title={row.label}>{row.label}</p>
              </div>
              <p className="mt-1 truncate text-[10px] text-text-tertiary" title={row.meta}>{row.meta}</p>
            </div>
            <span className="shrink-0 font-mono text-[12px] font-semibold text-text-primary">{row.value}</span>
          </div>
          <div className="ml-8 mt-2 h-1 overflow-hidden rounded-full bg-bg-surface-hover">
            <div className="h-full rounded-full bg-accent-primary" style={{ width: `${Math.max(2, (row.weight / maxWeight) * 100)}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function Empty({ label }: { label: string }) {
  return (
    <div className="flex min-h-32 flex-col items-center justify-center gap-2 text-center text-text-tertiary">
      <Activity className="h-5 w-5" strokeWidth={1.5} />
      <span className="text-[11px]">{label}</span>
    </div>
  );
}
