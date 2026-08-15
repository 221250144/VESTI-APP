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

  return (
    <nav
      aria-label={t.dock.navigation}
      className="flex w-[52px] shrink-0 flex-col items-center justify-between border-r border-border-subtle bg-bg-sidebar px-1 py-4"
    >
      <div className="flex flex-col items-center gap-2">
        <DockTooltip label={copy.home}>
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
  isActive,
  onClick,
}: {
  item: DockItem;
  label: string;
  isActive: boolean;
  onClick: () => void;
}) {
  return (
    <DockTooltip label={label}>
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
