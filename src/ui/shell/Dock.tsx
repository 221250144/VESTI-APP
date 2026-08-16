import {
  Archive,
  Compass,
  LibraryBig,
  Moon,
  Network,
  ScrollText,
  Settings,
  Sun,
} from "lucide-react";
import type { ReactNode } from "react";
import type { DashboardTab } from "@vesti/ui";
import { LOGO_BASE64 } from "../logo";
import { useI18n } from "../i18n";
import type { SupportedLocale } from "../i18n/locales";
import { DockTooltip } from "./DockTooltip";

export type ShellPage = "home" | DashboardTab | "settings";

// Localized dock labels, kept next to the component (same pattern as the
// capsule's embedded dictionaries) so the shared translation files stay
// untouched.
// 日报已并入记忆空间（deposits 总览的"日志"卡片），Dock 不再单列。
const DOCK_COPY: Record<
  SupportedLocale,
  Record<Exclude<ShellPage, "daily"> | "backToLibrary" | "toggleTheme", string>
> = {
  en: {
    home: "Dashboard",
    library: "Library",
    explore: "Explore",
    network: "Knowledge Graph",
    prompts: "Prompts",
    deposits: "Memory Space",
    settings: "Settings",
    backToLibrary: "Back to Library",
    toggleTheme: "Toggle theme",
  },
  zh: {
    home: "数据概览",
    library: "会话库",
    explore: "探索",
    network: "知识图谱",
    prompts: "提示词",
    deposits: "记忆空间",
    settings: "设置",
    backToLibrary: "回到会话库",
    toggleTheme: "切换主题",
  },
  ja: {
    home: "ダッシュボード",
    library: "ライブラリ",
    explore: "探索",
    network: "ナレッジグラフ",
    prompts: "プロンプト",
    deposits: "メモリースペース",
    settings: "設定",
    backToLibrary: "ライブラリに戻る",
    toggleTheme: "テーマ切替",
  },
  ko: {
    home: "대시보드",
    library: "라이브러리",
    explore: "탐색",
    network: "지식 그래프",
    prompts: "프롬프트",
    deposits: "메모리 스페이스",
    settings: "설정",
    backToLibrary: "라이브러리로 돌아가기",
    toggleTheme: "테마 전환",
  },
};

// One-sentence functional intro per dock page, shown in the hover tooltip
// under the page label (the "what is this module" layer of the dock).
const DOCK_DESC: Record<SupportedLocale, Record<Exclude<ShellPage, "daily">, string>> = {
  en: {
    home: "Capture volume, activity trends, and source breakdown at a glance.",
    library:
      "Every conversation captured on desktop and the browser extension, browsed by source, project, and topic.",
    explore:
      "Reflect over your corpus: grounded Q&A night talks, the AITI self-portrait, learning synthesis, and the roundtable.",
    network: "Your conversations linked into a graph by project and topic, growing over time.",
    prompts:
      "Scan archived sessions to surface the prompts you reuse, and curate them into your library.",
    deposits:
      "Dreams distill each day's sessions into long-term memories; deposits keep distilled knowledge documents.",
    settings: "Model, capture, membership, pairing, and appearance settings.",
  },
  zh: {
    home: "一览捕获总量、活跃趋势与来源分布的仪表盘。",
    library: "桌面端与浏览器扩展捕获的全部会话，按来源、项目、话题浏览与管理。",
    explore: "基于你的语料反思：夜话问答、AITI 自我画像、学习综合与圆桌讨论。",
    network: "会话按项目与话题连成的图谱，随时间生长。",
    prompts: "扫描本机归档会话，发现你反复使用的提示词并沉淀成库。",
    deposits: "梦境把每天的会话蒸馏成长期记忆；沉淀保存提炼的知识文档。",
    settings: "模型、捕获、会员、配对与外观等应用设置。",
  },
  ja: {
    home: "キャプチャ量・活動傾向・ソース内訳を一望するダッシュボード。",
    library:
      "デスクトップとブラウザ拡張でキャプチャした全会話を、ソース・プロジェクト・トピックで閲覧・管理。",
    explore:
      "語料を振り返る：夜話 Q&A、AITI 自己画像、学習サマリー、円卓ディスカッション。",
    network: "会話がプロジェクトとトピックでつながるグラフ。時間とともに育ちます。",
    prompts: "保存済みセッションをスキャンし、よく使うプロンプトを発見してライブラリ化。",
    deposits:
      "夢が毎日のセッションを長期記憶に蒸留し、デポジットが蒸留済みナレッジ文書を保管。",
    settings: "モデル、キャプチャ、メンバーシップ、ペアリング、外観などの設定。",
  },
  ko: {
    home: "캡처량, 활동 추세, 소스 분포를 한눈에 보는 대시보드.",
    library: "데스크톱과 브라우저 확장에서 캡처한 모든 대화를 소스·프로젝트·토픽별로 탐색·관리.",
    explore: "코퍼스 성찰: 밤의 대화 Q&A, AITI 자기 초상, 학습 종합, 원탁 토론.",
    network: "대화가 프로젝트와 토픽으로 연결된 그래프. 시간이 지날수록 자랍니다.",
    prompts: "보관된 세션을 스캔해 자주 쓰는 프롬프트를 찾아 라이브러리에 정리.",
    deposits: "꿈이 매일의 세션을 장기 기억으로 증류하고, 디파짓이 증류된 지식 문서를 보관.",
    settings: "모델, 캡처, 멤버십, 페어링, 외관 등 앱 설정.",
  },
};

interface DockItem {
  id: Exclude<ShellPage, "daily">;
  icon: ReactNode;
}

const TOP_ITEMS: DockItem[] = [
  { id: "library", icon: <LibraryBig className="h-5 w-5" strokeWidth={1.75} /> },
  { id: "explore", icon: <Compass className="h-5 w-5" strokeWidth={1.75} /> },
  { id: "network", icon: <Network className="h-5 w-5" strokeWidth={1.75} /> },
  { id: "prompts", icon: <ScrollText className="h-5 w-5" strokeWidth={1.75} /> },
  { id: "deposits", icon: <Archive className="h-5 w-5" strokeWidth={1.75} /> },
];

interface DockProps {
  currentPage: ShellPage;
  onNavigate: (page: ShellPage) => void;
  themeMode: "light" | "dark";
  onToggleTheme: () => void;
}

export function Dock({ currentPage, onNavigate, themeMode, onToggleTheme }: DockProps) {
  const { t, locale } = useI18n();
  const copy = DOCK_COPY[locale] ?? DOCK_COPY.en;
  const desc = DOCK_DESC[locale] ?? DOCK_DESC.en;

  return (
    <nav
      aria-label={t.dock.navigation}
      className="flex w-[52px] shrink-0 flex-col items-center justify-between border-r border-border-subtle bg-bg-sidebar px-1 py-4"
    >
      <div className="flex flex-col items-center gap-2">
        <DockTooltip label={copy.home} description={desc.home}>
          <button
            type="button"
            aria-label={copy.home}
            aria-current={currentPage === "home" ? "page" : undefined}
            onClick={() => onNavigate("home")}
            className={`mb-1 flex h-10 w-10 items-center justify-center rounded-lg border transition-colors [transition-duration:140ms] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus ${
              currentPage === "home"
                ? "border-accent-primary/35 bg-accent-primary-light"
                : "border-border-subtle bg-bg-primary/70 hover:bg-accent-primary-light"
            }`}
          >
            <img src={LOGO_BASE64} alt="Vesti" width={20} height={20} />
          </button>
        </DockTooltip>
        {TOP_ITEMS.map((item) => (
          <DockButton
            key={item.id}
            item={item}
            label={copy[item.id]}
            description={desc[item.id]}
            isActive={currentPage === item.id}
            onClick={() => onNavigate(item.id)}
          />
        ))}
      </div>

      <div className="flex flex-col items-center gap-2">
        <DockTooltip label={copy.toggleTheme}>
          <button
            type="button"
            aria-label={copy.toggleTheme}
            onClick={onToggleTheme}
            className="flex h-10 w-10 items-center justify-center rounded-lg border border-transparent text-text-secondary transition-colors [transition-duration:140ms] hover:border-border-subtle hover:bg-accent-primary-light hover:text-accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus"
          >
            {themeMode === "dark" ? (
              <Sun className="h-5 w-5" strokeWidth={1.75} />
            ) : (
              <Moon className="h-5 w-5" strokeWidth={1.75} />
            )}
          </button>
        </DockTooltip>
        <DockButton
          item={{ id: "settings", icon: <Settings className="h-5 w-5" strokeWidth={1.75} /> }}
          label={copy.settings}
          description={desc.settings}
          isActive={currentPage === "settings"}
          onClick={() => onNavigate("settings")}
        />
      </div>
    </nav>
  );
}

function DockButton({
  item,
  label,
  description,
  isActive,
  onClick,
}: {
  item: DockItem;
  label: string;
  description?: string;
  isActive: boolean;
  onClick: () => void;
}) {
  return (
    <DockTooltip label={label} description={description}>
      <button
        type="button"
        aria-label={label}
        aria-current={isActive ? "page" : undefined}
        onClick={onClick}
        className={`flex h-10 w-10 items-center justify-center rounded-lg border transition-colors [transition-duration:140ms] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus ${
          isActive
            ? "border-border-default bg-accent-primary-light text-accent-primary"
            : "border-transparent text-text-secondary hover:border-border-subtle hover:bg-accent-primary-light hover:text-accent-primary"
        }`}
      >
        {item.icon}
      </button>
    </DockTooltip>
  );
}
