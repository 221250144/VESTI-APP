import { useCallback, useEffect, useState, type ReactNode } from "react";
import type {
  AppSettingsUpdate,
  AppSettingsView,
  CapturePlatform,
  ExtensionBridgeStatusView,
  ExtensionPairCodeView,
  Overview,
  WslStatusView,
} from "../../shared/contracts";
import { useI18n } from "../i18n";
import type { SupportedLocale } from "../i18n/locales";
import { useUiPreference } from "./useUiPreference";
import { DEFAULT_SKIN_ID, SKINS, resolveSkin } from "../../capsule/skins";
import {
  DAILY_TIME_PREF_KEY,
  DEFAULT_DAILY_TIME,
  normalizeDailyTime,
} from "../daily/dailyScheduler";
import {
  acceptAllClassifySuggestions,
  acceptClassifySuggestion,
  getAutoClassifyState,
  ignoreClassifySuggestion,
  listClassifySuggestions,
  loadAutoClassifyState,
  runAutoClassify,
  subscribeAutoClassify,
  type ClassifySuggestion,
} from "../organize/autoClassify";
import { scheduleUpstreamAutoExport } from "../upstream/autoExport";
import {
  exportAllToMarkdownDirectory,
  exportConversationsToObsidian,
  getUpstreamExportStats,
  type UpstreamExportStats,
} from "../upstream/obsidianExport";

type SettingsDraft = AppSettingsUpdate & { apiKeyConfigured: boolean; notionTokenConfigured: boolean };

const EMPTY_OVERVIEW: Overview = {
  sources: [],
  sessions: [],
  totals: { conversations: 0, messages: 0, inputTokens: 0, outputTokens: 0, storageSize: 0 },
  watching: false,
  syncing: false,
};

const PLATFORM_TONES: Record<string, string> = {
  codex: "#5069df",
  cursor: "#161b22",
  "kimi-code": "#8459c8",
  "claude-code": "#c7663b",
};

// Page copy, zh-first. ja/ko fall back to English for now.
const COPY: Record<SupportedLocale, Record<string, string>> = {
  zh: {
    loading: "正在读取设置…",
    generalTitle: "应用行为",
    generalDesc: "控制 Vesti 如何随 Windows 启动,以及关闭窗口后的后台行为。",
    launchAtLogin: "开机时启动 Vesti",
    launchAtLoginDesc: "登录 Windows 后自动启动采集服务。",
    startMinimized: "开机启动时隐藏窗口",
    startMinimizedDesc: "只显示托盘图标,不主动打断当前工作。",
    closeToTray: "关闭窗口时留在托盘",
    closeToTrayDesc: "点击窗口关闭按钮后继续在后台捕获;可从托盘菜单彻底退出。",
    showCapsule: "显示桌面悬浮球",
    showCapsuleDesc: "小猫头鹰常驻屏幕边缘,随时同步或打开主界面。",
    captureTitle: "采集引擎",
    captureDesc: "只读取已启用工具保存在本机的会话文件。停用来源不会删除已经归档的数据。",
    watchOnStartup: "启动后自动实时采集",
    watchOnStartupDesc: "监听新建和更新的会话文件;也可在托盘菜单临时暂停。",
    syncNow: "立即同步",
    syncing: "采集中…",
    liveCapture: "实时采集",
    detected: "检测到",
    notDetected: "本机暂未检测到",
    sessions: "个会话",
    enabled: "已启用",
    disabled: "已停用",
    wslSources: "WSL 来源",
    wslSourcesDesc: "自动检测 WSL 发行版中的工具数据,纳入同步与定时轮询。",
    wslNoDistros: "未检测到 WSL 发行版",
    wslRedetect: "重新检测",
    wslDetecting: "检测中…",
    bridgeTitle: "连接 VESTI 扩展",
    bridgeDesc: "浏览器扩展通过本机回环服务把网页端会话导入 Vesti。生成配对码并在扩展中输入即可完成连接。",
    bridgeRunning: "服务运行中",
    bridgeStopped: "服务未运行",
    bridgeError: "端口冲突,扩展暂不可用",
    bridgeGenerate: "生成配对码",
    bridgeCodeHint: "在浏览器扩展中输入此配对码",
    bridgeCodeExpired: "配对码已过期,请重新生成。",
    bridgeClients: "已连接客户端",
    bridgeNoClients: "还没有已连接的客户端。",
    bridgePairedAt: "配对于",
    bridgeLastSync: "最近同步",
    bridgeNeverSynced: "尚未同步",
    bridgeDisconnect: "断开",
    bridgeDisconnectConfirm: "确定断开该客户端吗?扩展需要重新配对才能继续同步。",
    dataTitle: "内容数据与隐私",
    dataDesc: "会话数据库、标准化文本和 Agent 结果保存在这里。程序安装目录与内容数据目录相互独立。",
    dataDirectory: "数据目录",
    chooseFolder: "选择文件夹",
    activeDir: "当前正在使用:",
    restartNeeded: "更改数据目录后需要重启 App 才会生效。Vesti 不会自动搬移旧目录中的数据。",
    restartNow: "立即重启",
    openDataDir: "打开当前数据目录",
    clearAgent: "清空 Agent 历史结果",
    clearAgentConfirm: "确定删除全部 Summary / Explore 历史结果吗?已捕获的原始会话不会被删除。",
    clearAgentDone: "Agent 历史结果已清空。",
    clearAgentNote: "清空 Agent 结果不会删除原始会话、SQLite 数据库或来源工具中的任何文件。",
    llmTitle: "模型服务",
    llmDesc: "配置方式与浏览器插件一致:可使用 Vesti Demo Proxy,或连接 OpenAI 兼容接口并使用自己的 API Key。",
    demoProxy: "Demo Proxy",
    demoProxyDesc: "用于快速体验,默认 qwen-plus",
    byok: "自定义 / BYOK",
    byokDesc: "OpenAI 兼容 API",
    baseUrl: "Base URL",
    model: "模型",
    temperature: "Temperature",
    maxTokens: "最大输出 Token",
    apiKeySaved: "(已安全保存,留空则不修改)",
    deleteApiKey: "删除已保存的 API Key",
    apiKeyNote: "API Key 由操作系统安全存储加密,前端页面不会读取已保存的明文。",
    agentTitle: "洞察偏好",
    agentDesc: "决定 Summary / Explore 发送哪些内容,以及结果使用的默认语言。",
    outputLanguage: "输出语言",
    customInstructions: "自定义分析偏好(可选)",
    customInstructionsPlaceholder: "例如:优先提取产品决策和技术风险;所有下一步都给出负责人和验收标准。",
    includeThinking: "包含可见思考摘要",
    includeThinkingDesc: "如果来源提供思考摘要,将其一并交给分析模型。",
    includeToolDetails: "包含工具调用详情",
    includeToolDetailsDesc: "发送工具名称、输入、输出与错误,以获得更完整的技术分析。",
    organizeTitle: "整理",
    organizeDesc: "把未分类会话自动归入主题树。低置信度的结果进入待确认队列;绝不会覆盖你的手动分类。",
    organizeAuto: "自动分类",
    organizeAutoDesc: "新会话同步完成后自动运行(延迟约 10 秒)。",
    organizeUnavailable: "需先在下方「模型服务」配置可用的模型,才能使用自动分类。",
    organizeModeAuto: "自动落库",
    organizeModeAutoDesc: "置信度 ≥ 60% 直接归入主题",
    organizeModeSuggest: "仅建议",
    organizeModeSuggestDesc: "全部结果进入待确认队列",
    organizeNow: "立即整理",
    organizeRunning: "整理中…",
    organizeNever: "尚未运行过。",
    organizeLastRun: "最近运行",
    organizeStatsClassified: "新分类",
    organizeStatsTopics: "新建主题",
    organizeStatsQueued: "待确认",
    organizeStatsFailed: "失败批次",
    organizeQueue: "待确认队列",
    organizeQueueEmpty: "没有待确认的建议。",
    organizeAccept: "接受",
    organizeIgnore: "忽略",
    organizeAcceptAll: "全部接受",
    dailyTitle: "日志",
    dailyDesc: "每天固定时间自动生成当天日报;启动 App 时会补上错过的昨天。未配置模型时使用本地模板生成。",
    dailyTime: "每日生成时间",
    dailyTimeDesc: "默认 21:30。到点自动生成;当天没有活动则跳过。",
    upstreamTitle: "上游导出",
    upstreamDesc: "把会话导出到 Obsidian 库或 Notion。Obsidian 写入你选择的本地目录;Notion 通过 Integration Token 连接,Token 由系统安全存储加密。",
    obsidianSection: "Obsidian",
    vaultPath: "库目录(Vault)",
    vaultNotChosen: "尚未选择",
    vaultChoose: "选择目录",
    autoExport: "新会话自动导出到 Obsidian",
    autoExportDesc: "每次同步完成后约 15 秒,自动把未导出的新会话写入库目录。",
    exportAllObsidian: "导出全部到 Obsidian",
    exportAllMarkdown: "导出全部到 Markdown 目录",
    notionSection: "Notion",
    notionToken: "Integration Token",
    notionTokenSaved: "(已安全保存,留空则不修改)",
    deleteNotionToken: "删除已保存的 Token",
    notionParent: "目标 Page ID / Database ID",
    notionParentHint: "并在 Notion 目标页「··· → 连接」中授权给该 Integration。",
    notionParentTypePage: "已识别:页面",
    notionParentTypeDatabase: "已识别:数据库",
    notionVerify: "保存并验证连接",
    notionVerifying: "验证中…",
    statsExported: "已导出",
    statsFailed: "失败",
    statsPending: "待导出",
    statsLastAt: "最近导出",
    statsLastError: "最近错误",
    statsNever: "尚未导出。",
    exportRunning: "导出中",
    exportDone: "导出完成",
    exportFailedCount: "失败",
    exportNeedVault: "请先选择并保存库目录。",
    networkTitle: "网络与代理",
    networkDesc: "模型请求默认跟随 Windows 系统代理。修改后立即应用,无需重启。",
    proxySystem: "跟随系统",
    proxySystemDesc: "推荐;使用 Windows / VPN 代理",
    proxyDirect: "直接连接",
    proxyDirectDesc: "忽略系统代理",
    proxyCustom: "自定义代理",
    proxyCustomDesc: "HTTP / HTTPS / SOCKS",
    proxyUrl: "代理地址",
    appearanceTitle: "外观与语言",
    appearanceDesc: "主题与界面语言,立即生效并在所有窗口同步。",
    darkMode: "深色模式",
    darkModeDesc: "切换后立即应用到所有窗口。",
    language: "界面语言",
    owlSkinTitle: "悬浮球皮肤",
    owlSkinDesc: "选择小猫头鹰悬浮球的外观,点击立即生效。",
    aboutTitle: "关于 Vesti",
    aboutDesc: "本地优先的 AI 会话采集、归档与洞察工具。当前支持 Codex、Cursor、Kimi Code 和 Claude Code。",
    settingsDir: "设置目录",
    contentDir: "内容目录",
    openSettingsDir: "打开设置目录",
    restartApp: "重启 Vesti",
    saveAndTest: "保存并测试模型",
    save: "保存设置",
    saving: "保存中…",
    saved: "设置已保存。",
    savedRestart: "设置已保存。数据目录将在重启后切换。",
  },
  en: {
    loading: "Loading settings…",
    generalTitle: "Application",
    generalDesc: "Control how Vesti starts with Windows and behaves when the window is closed.",
    launchAtLogin: "Launch Vesti at login",
    launchAtLoginDesc: "Start the capture service automatically when you sign in.",
    startMinimized: "Start hidden",
    startMinimizedDesc: "Only show the tray icon; don't interrupt your work.",
    closeToTray: "Keep running in tray on close",
    closeToTrayDesc: "Closing the window keeps capturing in the background; quit from the tray menu.",
    showCapsule: "Show desktop floating ball",
    showCapsuleDesc: "The little owl stays at the screen edge for quick sync and access.",
    captureTitle: "Capture Engine",
    captureDesc: "Only reads session files stored locally by the enabled tools. Disabling a source never deletes archived data.",
    watchOnStartup: "Watch in real time after launch",
    watchOnStartupDesc: "Listen for new and updated session files; pause anytime from the tray.",
    syncNow: "Sync now",
    syncing: "Syncing…",
    liveCapture: "Live capture",
    detected: "Detected",
    notDetected: "Not detected",
    sessions: "sessions",
    enabled: "Enabled",
    disabled: "Disabled",
    wslSources: "WSL sources",
    wslSourcesDesc: "Tool data found inside WSL distributions is synced and polled automatically.",
    wslNoDistros: "No WSL distributions detected",
    wslRedetect: "Re-detect",
    wslDetecting: "Detecting…",
    bridgeTitle: "Connect the VESTI extension",
    bridgeDesc: "The browser extension imports web conversations into Vesti over a loopback service. Generate a pair code and enter it in the extension to connect.",
    bridgeRunning: "Service running",
    bridgeStopped: "Service stopped",
    bridgeError: "Port conflict; extension bridge unavailable",
    bridgeGenerate: "Generate pair code",
    bridgeCodeHint: "Enter this code in the browser extension",
    bridgeCodeExpired: "Code expired. Generate a new one.",
    bridgeClients: "Connected clients",
    bridgeNoClients: "No clients connected yet.",
    bridgePairedAt: "Paired",
    bridgeLastSync: "Last sync",
    bridgeNeverSynced: "Never synced",
    bridgeDisconnect: "Disconnect",
    bridgeDisconnectConfirm: "Disconnect this client? The extension must pair again to keep syncing.",
    dataTitle: "Data & Privacy",
    dataDesc: "The session database, normalized text, and agent results live here. The install directory and content directory are independent.",
    dataDirectory: "Data directory",
    chooseFolder: "Choose folder",
    activeDir: "Currently in use:",
    restartNeeded: "Changing the data directory requires a restart. Vesti does not move existing data automatically.",
    restartNow: "Restart now",
    openDataDir: "Open data directory",
    clearAgent: "Clear agent history",
    clearAgentConfirm: "Delete all Summary / Explore results? Captured raw conversations are not affected.",
    clearAgentDone: "Agent history cleared.",
    clearAgentNote: "Clearing agent results never touches raw conversations, the SQLite database, or source tools.",
    llmTitle: "Model Service",
    llmDesc: "Same as the browser extension: use the Vesti Demo Proxy, or bring your own OpenAI-compatible API key.",
    demoProxy: "Demo Proxy",
    demoProxyDesc: "Quick start, defaults to qwen-plus",
    byok: "Custom / BYOK",
    byokDesc: "OpenAI-compatible API",
    baseUrl: "Base URL",
    model: "Model",
    temperature: "Temperature",
    maxTokens: "Max output tokens",
    apiKeySaved: "(saved securely; leave blank to keep)",
    deleteApiKey: "Delete the saved API Key",
    apiKeyNote: "The API key is encrypted by the OS secure storage; the page never reads it back.",
    agentTitle: "Insight Preferences",
    agentDesc: "Choose what Summary / Explore sends and the default output language.",
    outputLanguage: "Output language",
    customInstructions: "Custom analysis instructions (optional)",
    customInstructionsPlaceholder: "e.g. Prioritize product decisions and technical risks; every next step needs an owner and acceptance criteria.",
    includeThinking: "Include visible thinking",
    includeThinkingDesc: "Forward source-provided thinking summaries to the analysis model.",
    includeToolDetails: "Include tool call details",
    includeToolDetailsDesc: "Send tool names, inputs, outputs, and errors for deeper technical analysis.",
    organizeTitle: "Organize",
    organizeDesc: "Automatically files unclassified conversations into your topic tree. Low-confidence results go to a review queue; manual assignments are never overwritten.",
    organizeAuto: "Auto-classify",
    organizeAutoDesc: "Runs automatically about 10s after new conversations finish syncing.",
    organizeUnavailable: "Configure a working model under Model Service below to enable auto-classify.",
    organizeModeAuto: "Apply automatically",
    organizeModeAutoDesc: "Confidence ≥ 60% is filed directly",
    organizeModeSuggest: "Suggest only",
    organizeModeSuggestDesc: "Everything goes to the review queue",
    organizeNow: "Organize now",
    organizeRunning: "Organizing…",
    organizeNever: "No runs yet.",
    organizeLastRun: "Last run",
    organizeStatsClassified: "classified",
    organizeStatsTopics: "topics created",
    organizeStatsQueued: "pending",
    organizeStatsFailed: "failed batches",
    organizeQueue: "Review queue",
    organizeQueueEmpty: "No pending suggestions.",
    organizeAccept: "Accept",
    organizeIgnore: "Ignore",
    organizeAcceptAll: "Accept all",
    dailyTitle: "Daily log",
    dailyDesc: "Generates the day's report at a fixed time every evening; a missed yesterday is caught up at launch. Without a configured model the local template is used.",
    dailyTime: "Daily generation time",
    dailyTimeDesc: "Default 21:30. Days without any activity are skipped.",
    upstreamTitle: "Upstream Export",
    upstreamDesc: "Export conversations to an Obsidian vault or Notion. Obsidian writes into a local folder you choose; Notion connects via an Integration Token encrypted by the OS secure storage.",
    obsidianSection: "Obsidian",
    vaultPath: "Vault folder",
    vaultNotChosen: "Not chosen",
    vaultChoose: "Choose folder",
    autoExport: "Auto-export new conversations",
    autoExportDesc: "About 15s after each sync, unexported new conversations are written into the vault.",
    exportAllObsidian: "Export all to Obsidian",
    exportAllMarkdown: "Export all to a Markdown folder",
    notionSection: "Notion",
    notionToken: "Integration Token",
    notionTokenSaved: "(saved securely; leave blank to keep)",
    deleteNotionToken: "Delete the saved token",
    notionParent: "Target Page ID / Database ID",
    notionParentHint: "Also share the target with the integration in Notion (··· → Connections).",
    notionParentTypePage: "Resolved: page",
    notionParentTypeDatabase: "Resolved: database",
    notionVerify: "Save & verify connection",
    notionVerifying: "Verifying…",
    statsExported: "exported",
    statsFailed: "failed",
    statsPending: "pending",
    statsLastAt: "last export",
    statsLastError: "last error",
    statsNever: "Nothing exported yet.",
    exportRunning: "Exporting",
    exportDone: "Export finished",
    exportFailedCount: "failed",
    exportNeedVault: "Choose and save a vault folder first.",
    networkTitle: "Network & Proxy",
    networkDesc: "Model requests follow the Windows system proxy by default. Changes apply immediately.",
    proxySystem: "Follow system",
    proxySystemDesc: "Recommended; use Windows / VPN proxy",
    proxyDirect: "Direct connection",
    proxyDirectDesc: "Bypass the system proxy",
    proxyCustom: "Custom proxy",
    proxyCustomDesc: "HTTP / HTTPS / SOCKS",
    proxyUrl: "Proxy URL",
    appearanceTitle: "Appearance & Language",
    appearanceDesc: "Theme and UI language, applied instantly across all windows.",
    darkMode: "Dark mode",
    darkModeDesc: "Applies to every window immediately.",
    language: "Language",
    owlSkinTitle: "Floating ball skin",
    owlSkinDesc: "Pick a look for the owl floating ball; applies instantly.",
    aboutTitle: "About Vesti",
    aboutDesc: "A local-first AI conversation capture, archive, and insight tool. Currently supports Codex, Cursor, Kimi Code, and Claude Code.",
    settingsDir: "Settings directory",
    contentDir: "Content directory",
    openSettingsDir: "Open settings directory",
    restartApp: "Restart Vesti",
    saveAndTest: "Save & test model",
    save: "Save settings",
    saving: "Saving…",
    saved: "Settings saved.",
    savedRestart: "Settings saved. The data directory changes after a restart.",
  },
  ja: {},
  ko: {},
};

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, "");
}

function toDraft(settings: AppSettingsView): SettingsDraft {
  return {
    dataDirectory: settings.dataDirectory,
    general: { ...settings.general },
    capture: { ...settings.capture, enabledPlatforms: [...settings.capture.enabledPlatforms] },
    network: { ...settings.network },
    agent: { ...settings.agent },
    llm: {
      mode: settings.llm.mode,
      baseUrl: settings.llm.baseUrl,
      modelId: settings.llm.modelId,
      temperature: settings.llm.temperature,
      maxTokens: settings.llm.maxTokens,
      apiKey: "",
      clearApiKey: false,
    },
    upstream: {
      obsidianVaultPath: settings.upstream.obsidianVaultPath,
      obsidianAutoExport: settings.upstream.obsidianAutoExport,
      notionParentId: settings.upstream.notionParentId,
      notionParentType: settings.upstream.notionParentType,
      notionTitleProperty: settings.upstream.notionTitleProperty,
      notionToken: "",
      clearNotionToken: false,
    },
    apiKeyConfigured: settings.llm.apiKeyConfigured,
    notionTokenConfigured: settings.upstream.notionTokenConfigured,
  };
}

function Card({
  eyebrow,
  title,
  description,
  aside,
  children,
}: {
  eyebrow: string;
  title: string;
  description?: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-card border border-border-subtle bg-bg-surface-card p-6">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <span className="text-[11px] font-sans font-medium uppercase tracking-[0.16em] text-text-tertiary">
            {eyebrow}
          </span>
          <h2 className="mt-1 font-serif text-[18px] font-normal text-text-primary">{title}</h2>
        </div>
        {aside}
      </div>
      {description ? (
        <p className="mb-4 text-[13px] font-sans leading-relaxed text-text-secondary">{description}</p>
      ) : null}
      {children}
    </section>
  );
}

function Toggle({
  checked,
  title,
  description,
  disabled = false,
  onChange,
}: {
  checked: boolean;
  title: string;
  description: string;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label
      className={`flex cursor-pointer items-center justify-between gap-4 rounded-lg border border-transparent px-3 py-2.5 transition-colors [transition-duration:140ms] hover:border-border-subtle hover:bg-bg-surface-card-hover ${
        disabled ? "cursor-not-allowed opacity-50" : ""
      }`}
    >
      <span className="min-w-0">
        <span className="block text-[13px] font-sans font-medium text-text-primary">{title}</span>
        <span className="mt-0.5 block text-[12px] font-sans leading-relaxed text-text-tertiary">
          {description}
        </span>
      </span>
      <input
        type="checkbox"
        className="peer sr-only"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span
        aria-hidden="true"
        className="relative h-[22px] w-[38px] shrink-0 rounded-full bg-bg-tertiary transition-colors [transition-duration:160ms] after:absolute after:left-[3px] after:top-[3px] after:h-4 after:w-4 after:rounded-full after:bg-bg-primary after:shadow-sm after:ring-1 after:ring-black/5 after:transition-transform after:[transition-duration:160ms] peer-checked:bg-accent-primary peer-checked:after:translate-x-4"
      />
    </label>
  );
}

function Field({
  label,
  wide = false,
  children,
}: {
  label: string;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <label className={`block ${wide ? "md:col-span-2" : ""}`}>
      <span className="mb-1.5 block text-[12px] font-sans font-medium text-text-secondary">{label}</span>
      {children}
    </label>
  );
}

const inputClass =
  "w-full rounded-lg border border-border-subtle bg-bg-primary px-3 py-2 text-[13px] font-sans text-text-primary outline-none transition-colors [transition-duration:140ms] placeholder:text-text-tertiary focus:border-border-focus focus:ring-2 focus:ring-border-focus/30 read-only:text-text-tertiary";

const buttonSecondary =
  "rounded-lg border border-border-default bg-bg-primary px-3.5 py-2 text-[13px] font-sans font-medium text-text-primary transition-colors [transition-duration:140ms] hover:bg-bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus disabled:opacity-50";
const buttonPrimary =
  "rounded-lg bg-accent-primary px-4 py-2 text-[13px] font-sans font-medium text-text-inverse transition-colors [transition-duration:140ms] hover:bg-accent-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus disabled:opacity-50";
const buttonDanger =
  "rounded-lg border border-danger/40 bg-bg-primary px-3.5 py-2 text-[13px] font-sans font-medium text-danger transition-colors [transition-duration:140ms] hover:bg-danger/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus";

export function SettingsPage({
  themeMode,
  onToggleTheme,
}: {
  themeMode: "light" | "dark";
  onToggleTheme: () => void;
}) {
  const { locale, setLocale } = useI18n();
  const copy = { ...COPY.en, ...COPY[locale] };
  const [capsuleEnabled, setCapsuleEnabled] = useUiPreference("capsule.enabled", true, value => value !== false);
  const [owlSkin, setOwlSkin] = useUiPreference("owlSkin", DEFAULT_SKIN_ID, value => resolveSkin(value).id);
  const [classifyEnabled, setClassifyEnabled] = useUiPreference("classify.enabled", true, value => value !== false);
  const [classifyMode, setClassifyMode] = useUiPreference<"auto" | "suggest">(
    "classify.mode",
    "auto",
    value => (value === "suggest" ? "suggest" : "auto"),
  );
  const [dailyTime, setDailyTime] = useUiPreference(DAILY_TIME_PREF_KEY, DEFAULT_DAILY_TIME, normalizeDailyTime);

  const [settings, setSettings] = useState<AppSettingsView | null>(null);
  const [draft, setDraft] = useState<SettingsDraft | null>(null);
  const [overview, setOverview] = useState<Overview>(EMPTY_OVERVIEW);
  const [wslStatus, setWslStatus] = useState<WslStatusView | null>(null);
  const [wslBusy, setWslBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [bridge, setBridge] = useState<ExtensionBridgeStatusView | null>(null);
  const [pairCode, setPairCode] = useState<ExtensionPairCodeView | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [classifyState, setClassifyState] = useState(getAutoClassifyState());
  const [suggestions, setSuggestions] = useState<ClassifySuggestion[]>([]);
  const [upstreamStats, setUpstreamStats] = useState<UpstreamExportStats | null>(null);
  const [upstreamBusy, setUpstreamBusy] = useState<string | null>(null);
  const [upstreamNote, setUpstreamNote] = useState("");

  const load = useCallback(async () => {
    const [settingsValue, overviewValue, wslValue, bridgeValue, upstreamStatsValue] = await Promise.all([
      window.vesti.getSettings(),
      window.vesti.getOverview(),
      window.vesti.getWslStatus(),
      window.vesti.getExtensionBridgeStatus(),
      getUpstreamExportStats().catch(() => null),
    ]);
    setSettings(settingsValue);
    setDraft(toDraft(settingsValue));
    setOverview(overviewValue);
    setWslStatus(wslValue);
    setBridge(bridgeValue);
    setUpstreamStats(upstreamStatsValue);
  }, []);

  useEffect(() => {
    void load();
    const unsubscribeCapture = window.vesti.onCaptureChanged(() => void load());
    const unsubscribeBridge = window.vesti.onExtensionBridgeChanged(() => {
      void window.vesti.getExtensionBridgeStatus().then(setBridge);
    });
    return () => {
      unsubscribeCapture();
      unsubscribeBridge();
    };
  }, [load]);

  // 1s ticker for the pair-code countdown.
  useEffect(() => {
    if (!pairCode) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [pairCode]);

  // Auto-classify (P2a): run state + persisted review queue.
  useEffect(() => {
    void loadAutoClassifyState();
    const refreshQueue = () => {
      void listClassifySuggestions().then(setSuggestions).catch(() => {});
    };
    refreshQueue();
    const unsubscribe = subscribeAutoClassify((next) => {
      setClassifyState(next);
      if (!next.running) refreshQueue();
    });
    window.addEventListener("vesti:data-updated", refreshQueue);
    return () => {
      unsubscribe();
      window.removeEventListener("vesti:data-updated", refreshQueue);
    };
  }, []);

  async function organizeNow() {
    await runAutoClassify({ trigger: "manual" });
    setSuggestions(await listClassifySuggestions().catch(() => []));
  }

  async function acceptSuggestion(conversationId: number) {
    await acceptClassifySuggestion(conversationId);
    setSuggestions(await listClassifySuggestions().catch(() => []));
  }

  async function ignoreSuggestion(conversationId: number) {
    await ignoreClassifySuggestion(conversationId);
    setSuggestions(await listClassifySuggestions().catch(() => []));
  }

  async function acceptAllSuggestions() {
    await acceptAllClassifySuggestions();
    setSuggestions(await listClassifySuggestions().catch(() => []));
  }

  async function generatePairCode() {
    setPairCode(await window.vesti.createExtensionPairCode());
    setNow(Date.now());
  }

  async function disconnectClient(clientId: string) {
    if (!window.confirm(copy.bridgeDisconnectConfirm)) return;
    await window.vesti.disconnectExtensionClient(clientId);
    setBridge(await window.vesti.getExtensionBridgeStatus());
  }

  async function redetectWsl() {
    setWslBusy(true);
    try {
      setWslStatus(await window.vesti.redetectWsl());
      await load();
    } finally {
      setWslBusy(false);
    }
  }

  async function chooseDirectory() {
    const directory = await window.vesti.chooseDataDirectory();
    if (directory) {
      setDraft((current) => (current ? { ...current, dataDirectory: directory } : current));
    }
  }

  async function saveSettings(testAfterSave = false): Promise<boolean> {
    if (!draft) return false;
    setBusy(true);
    setMessage("");
    try {
      const result = await window.vesti.saveSettings({
        dataDirectory: draft.dataDirectory,
        general: draft.general,
        capture: draft.capture,
        network: draft.network,
        agent: draft.agent,
        llm: draft.llm,
        upstream: draft.upstream,
      });
      setSettings(result.settings);
      setDraft(toDraft(result.settings));
      setMessage(result.restartRequired ? copy.savedRestart : copy.saved);
      if (result.settings.upstream.obsidianAutoExport) scheduleUpstreamAutoExport();
      if (testAfterSave) {
        const tested = await window.vesti.testLlm();
        setMessage(tested.message);
      }
      return true;
    } catch (error) {
      setMessage(errorMessage(error));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function chooseVaultDirectory() {
    const directory = await window.vesti.chooseDirectory(copy.vaultPath);
    if (directory) {
      setDraft((current) =>
        current
          ? { ...current, upstream: { ...current.upstream, obsidianVaultPath: directory } }
          : current,
      );
    }
  }

  async function verifyNotion() {
    setUpstreamBusy("verify");
    try {
      if (!(await saveSettings())) return;
      const tested = await window.vesti.testNotionConnection();
      setMessage(tested.message);
      await load();
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setUpstreamBusy(null);
    }
  }

  async function exportAllToObsidian() {
    if (!settings?.upstream.obsidianVaultPath) {
      setUpstreamNote(copy.exportNeedVault);
      return;
    }
    setUpstreamBusy("obsidian");
    setUpstreamNote("");
    try {
      const result = await exportConversationsToObsidian((progress) =>
        setUpstreamNote(
          `${copy.exportRunning} ${progress.done}/${progress.total}` +
            (progress.failed > 0 ? ` · ${copy.exportFailedCount} ${progress.failed}` : ""),
        ),
      );
      const total = result.succeeded + result.failed.length;
      setUpstreamNote(
        `${copy.exportDone}: ${result.succeeded}/${total}` +
          (result.failed.length > 0
            ? ` · ${copy.exportFailedCount} ${result.failed.length}（${result.failed[0].error}）`
            : ""),
      );
      setUpstreamStats(await getUpstreamExportStats());
    } catch (error) {
      setUpstreamNote(errorMessage(error));
    } finally {
      setUpstreamBusy(null);
    }
  }

  async function exportAllToMarkdownFolder() {
    const directory = await window.vesti.chooseDirectory(copy.exportAllMarkdown);
    if (!directory) return;
    setUpstreamBusy("markdown");
    setUpstreamNote("");
    try {
      const result = await exportAllToMarkdownDirectory(directory, (progress) =>
        setUpstreamNote(
          `${copy.exportRunning} ${progress.done}/${progress.total}` +
            (progress.failed > 0 ? ` ${copy.exportFailedCount} ${progress.failed}` : ""),
        ),
      );
      const total = result.succeeded + result.failed.length;
      setUpstreamNote(
        `${copy.exportDone}: ${result.succeeded}/${total}` +
          (result.failed.length > 0
            ? ` · ${copy.exportFailedCount} ${result.failed.length}（${result.failed[0].error}）`
            : ""),
      );
    } catch (error) {
      setUpstreamNote(errorMessage(error));
    } finally {
      setUpstreamBusy(null);
    }
  }

  async function clearAgentResults() {
    if (!window.confirm(copy.clearAgentConfirm)) return;
    setMessage("");
    try {
      await window.vesti.clearAgentResults();
      setMessage(copy.clearAgentDone);
    } catch (error) {
      setMessage(errorMessage(error));
    }
  }

  function togglePlatform(platform: CapturePlatform) {
    setDraft((current) => {
      if (!current) return current;
      const enabled = current.capture.enabledPlatforms.includes(platform);
      return {
        ...current,
        capture: {
          ...current.capture,
          enabledPlatforms: enabled
            ? current.capture.enabledPlatforms.filter((item) => item !== platform)
            : [...current.capture.enabledPlatforms, platform],
        },
      };
    });
  }

  function setLlmMode(mode: "demo_proxy" | "custom_byok") {
    setDraft((current) =>
      current
        ? {
            ...current,
            llm: {
              ...current.llm,
              mode,
              baseUrl:
                mode === "demo_proxy"
                  ? "https://vesti-gate.vercel.app/api"
                  : current.llm.baseUrl.includes("vesti-gate.vercel.app")
                    ? "https://dashscope.aliyuncs.com/compatible-mode/v1"
                    : current.llm.baseUrl,
            },
          }
        : current,
    );
  }

  if (!draft || !settings) {
    return (
      <div className="flex h-full items-center justify-center text-[13px] font-sans text-text-tertiary">
        {copy.loading}
      </div>
    );
  }

  // demo_proxy works out of the box; BYOK needs a saved API key.
  const llmReady = settings.llm.mode === "demo_proxy" || settings.llm.apiKeyConfigured;

  return (
    <div className="h-full overflow-y-auto overflow-x-hidden bg-bg-app px-8 py-8">
      <div className="mx-auto flex max-w-[880px] flex-col gap-6 pb-24">
        <Card eyebrow="GENERAL" title={copy.generalTitle} description={copy.generalDesc}>
          <div className="-mx-3 flex flex-col">
            <Toggle
              checked={draft.general.launchAtLogin}
              title={copy.launchAtLogin}
              description={copy.launchAtLoginDesc}
              onChange={(checked) =>
                setDraft({ ...draft, general: { ...draft.general, launchAtLogin: checked } })
              }
            />
            <Toggle
              checked={draft.general.startMinimized}
              disabled={!draft.general.launchAtLogin}
              title={copy.startMinimized}
              description={copy.startMinimizedDesc}
              onChange={(checked) =>
                setDraft({ ...draft, general: { ...draft.general, startMinimized: checked } })
              }
            />
            <Toggle
              checked={draft.general.closeToTray}
              title={copy.closeToTray}
              description={copy.closeToTrayDesc}
              onChange={(checked) =>
                setDraft({ ...draft, general: { ...draft.general, closeToTray: checked } })
              }
            />
            <Toggle
              checked={capsuleEnabled}
              title={copy.showCapsule}
              description={copy.showCapsuleDesc}
              onChange={setCapsuleEnabled}
            />
          </div>
        </Card>

        <Card eyebrow="CAPTURE" title={copy.captureTitle} description={copy.captureDesc}>
          <div className="-mx-3 mb-4 flex flex-col">
            <Toggle
              checked={draft.capture.watchOnStartup}
              title={copy.watchOnStartup}
              description={copy.watchOnStartupDesc}
              onChange={(checked) =>
                setDraft({ ...draft, capture: { ...draft.capture, watchOnStartup: checked } })
              }
            />
          </div>
          <div className="grid gap-2 md:grid-cols-3">
            {overview.sources.map((source) => {
              const enabled = draft.capture.enabledPlatforms.includes(source.platform);
              const wslInstalled =
                wslStatus?.platforms.some(item => item.platform === source.platform && item.installed) ?? false;
              return (
                <button
                  type="button"
                  key={source.platform}
                  onClick={() => togglePlatform(source.platform)}
                  className={`flex items-center gap-3 rounded-xl border p-3 text-left transition-colors [transition-duration:140ms] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus ${
                    enabled
                      ? "border-accent-primary/40 bg-accent-primary-light"
                      : "border-border-subtle bg-bg-primary hover:bg-bg-surface-hover"
                  }`}
                >
                  <span
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[13px] font-semibold text-white"
                    style={{ background: PLATFORM_TONES[source.platform] ?? "#6d746f" }}
                  >
                    {source.label[0]}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5 text-[13px] font-sans font-medium text-text-primary">
                      <span className="truncate">{source.label}</span>
                      {wslInstalled && (
                        <span className="shrink-0 rounded bg-accent-primary-light px-1.5 py-px text-[10px] font-medium text-accent-primary">
                          WSL
                        </span>
                      )}
                    </span>
                    <span className="block truncate text-[11px] font-sans text-text-tertiary">
                      {source.installed
                        ? `${copy.detected} · ${source.sessionCount} ${copy.sessions}`
                        : copy.notDetected}
                    </span>
                  </span>
                  <span
                    className={`text-[11px] font-sans font-medium ${
                      enabled ? "text-accent-primary" : "text-text-tertiary"
                    }`}
                  >
                    {enabled ? copy.enabled : copy.disabled}
                  </span>
                </button>
              );
            })}
          </div>
          {wslStatus?.supported && (
            <div className="mt-3 rounded-xl border border-border-subtle bg-bg-primary px-4 py-3">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-[13px] font-sans font-medium text-text-primary">{copy.wslSources}</div>
                  <div className="text-[12px] font-sans text-text-tertiary">{copy.wslSourcesDesc}</div>
                </div>
                <button
                  type="button"
                  className={buttonSecondary}
                  disabled={wslBusy}
                  onClick={() => void redetectWsl()}
                >
                  {wslBusy ? copy.wslDetecting : copy.wslRedetect}
                </button>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                {wslStatus.distros.length === 0 ? (
                  <span className="text-[12px] font-sans text-text-tertiary">{copy.wslNoDistros}</span>
                ) : (
                  wslStatus.distros.map(distro => (
                    <span
                      key={distro}
                      className="rounded-md bg-bg-tertiary px-2 py-0.5 text-[11px] font-sans text-text-secondary"
                    >
                      {distro}
                    </span>
                  ))
                )}
              </div>
            </div>
          )}
          <div className="mt-4 flex items-center gap-3">
            <button
              type="button"
              className={buttonSecondary}
              disabled={overview.syncing}
              onClick={() => void window.vesti.sync().then(load)}
            >
              {overview.syncing ? copy.syncing : copy.syncNow}
            </button>
            <div className="flex items-center gap-2 text-[12px] font-sans text-text-secondary">
              <span
                className={`inline-block h-2 w-2 rounded-full ${
                  overview.watching ? "bg-success" : "bg-bg-tertiary"
                }`}
              />
              {copy.liveCapture}
              <input
                type="checkbox"
                className="peer sr-only"
                checked={overview.watching}
                onChange={(event) =>
                  void window.vesti.setWatching(event.target.checked).then(load)
                }
              />
            </div>
          </div>
        </Card>

        <Card eyebrow="CONNECT" title={copy.bridgeTitle} description={copy.bridgeDesc}>
          <div className="mb-4 flex items-center gap-2 text-[12px] font-sans text-text-secondary">
            <span
              className={`inline-block h-2 w-2 rounded-full ${
                bridge?.running ? "bg-success" : bridge?.error ? "bg-danger" : "bg-bg-tertiary"
              }`}
            />
            {bridge?.running
              ? `${copy.bridgeRunning} · 127.0.0.1:${bridge.port}`
              : bridge?.error
                ? copy.bridgeError
                : copy.bridgeStopped}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" className={buttonSecondary} onClick={() => void generatePairCode()}>
              {copy.bridgeGenerate}
            </button>
            {pairCode && (pairCode.expiresAt > now ? (
              <div className="flex items-baseline gap-3">
                <span className="font-mono text-[22px] font-semibold tracking-[0.3em] text-text-primary">
                  {pairCode.code}
                </span>
                <span className="text-[12px] font-sans text-text-tertiary">
                  {copy.bridgeCodeHint} · {Math.floor((pairCode.expiresAt - now) / 60000)}:
                  {String(Math.floor(((pairCode.expiresAt - now) % 60000) / 1000)).padStart(2, "0")}
                </span>
              </div>
            ) : (
              <span className="text-[12px] font-sans text-text-tertiary">{copy.bridgeCodeExpired}</span>
            ))}
          </div>
          <div className="mt-4">
            <div className="mb-2 text-[12px] font-sans font-medium text-text-secondary">{copy.bridgeClients}</div>
            {!bridge || bridge.clients.length === 0 ? (
              <p className="text-[12px] font-sans text-text-tertiary">{copy.bridgeNoClients}</p>
            ) : (
              <div className="flex flex-col gap-2">
                {bridge.clients.map((client) => (
                  <div
                    key={client.clientId}
                    className="flex items-center gap-3 rounded-xl border border-border-subtle bg-bg-primary px-4 py-3"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-sans font-medium text-text-primary">{client.client}</div>
                      <div className="truncate text-[11px] font-sans text-text-tertiary">
                        {copy.bridgePairedAt} {new Date(client.pairedAt).toLocaleString()} ·{" "}
                        {copy.bridgeLastSync}{" "}
                        {client.lastSyncAt ? new Date(client.lastSyncAt).toLocaleString() : copy.bridgeNeverSynced}
                      </div>
                    </div>
                    <button
                      type="button"
                      className={buttonDanger}
                      onClick={() => void disconnectClient(client.clientId)}
                    >
                      {copy.bridgeDisconnect}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </Card>

        <Card eyebrow="DATA & PRIVACY" title={copy.dataTitle} description={copy.dataDesc}>
          <Field label={copy.dataDirectory} wide>
            <div className="flex gap-2">
              <input className={inputClass} value={draft.dataDirectory} readOnly />
              <button type="button" className={buttonSecondary} onClick={() => void chooseDirectory()}>
                {copy.chooseFolder}
              </button>
            </div>
          </Field>
          <p className="mt-2 text-[12px] font-sans text-text-tertiary">
            {copy.activeDir} {settings.activeDataDirectory}
          </p>
          {(settings.restartRequired || draft.dataDirectory !== settings.activeDataDirectory) && (
            <div className="mt-3 flex items-center justify-between gap-3 rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-[13px] font-sans text-text-primary">
              <span>{copy.restartNeeded}</span>
              {settings.restartRequired && (
                <button type="button" className={buttonSecondary} onClick={() => void window.vesti.restartApp()}>
                  {copy.restartNow}
                </button>
              )}
            </div>
          )}
          <div className="mt-4 flex flex-wrap gap-2">
            <button type="button" className={buttonSecondary} onClick={() => void window.vesti.openDataDirectory()}>
              {copy.openDataDir}
            </button>
            <button type="button" className={buttonDanger} onClick={() => void clearAgentResults()}>
              {copy.clearAgent}
            </button>
          </div>
          <p className="mt-2 text-[12px] font-sans text-text-tertiary">{copy.clearAgentNote}</p>
        </Card>

        <Card eyebrow="UPSTREAM" title={copy.upstreamTitle} description={copy.upstreamDesc}>
          <div className="mb-2 text-[12px] font-sans font-medium text-text-secondary">
            {copy.obsidianSection}
          </div>
          <Field label={copy.vaultPath} wide>
            <div className="flex gap-2">
              <input
                className={inputClass}
                value={draft.upstream.obsidianVaultPath || copy.vaultNotChosen}
                readOnly
              />
              <button type="button" className={buttonSecondary} onClick={() => void chooseVaultDirectory()}>
                {copy.vaultChoose}
              </button>
            </div>
          </Field>
          <div className="-mx-3 mt-2 flex flex-col">
            <Toggle
              checked={draft.upstream.obsidianAutoExport}
              title={copy.autoExport}
              description={copy.autoExportDesc}
              onChange={(checked) =>
                setDraft({ ...draft, upstream: { ...draft.upstream, obsidianAutoExport: checked } })
              }
            />
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              className={buttonSecondary}
              disabled={upstreamBusy !== null || !settings.upstream.obsidianVaultPath}
              onClick={() => void exportAllToObsidian()}
            >
              {copy.exportAllObsidian}
            </button>
            <button
              type="button"
              className={buttonSecondary}
              disabled={upstreamBusy !== null}
              onClick={() => void exportAllToMarkdownFolder()}
            >
              {copy.exportAllMarkdown}
            </button>
          </div>

          <div className="mb-2 mt-6 text-[12px] font-sans font-medium text-text-secondary">
            {copy.notionSection}
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <Field
              label={`${copy.notionToken} ${draft.notionTokenConfigured ? copy.notionTokenSaved : ""}`}
              wide
            >
              <input
                className={inputClass}
                type="password"
                autoComplete="off"
                value={draft.upstream.notionToken ?? ""}
                placeholder={draft.notionTokenConfigured ? "••••••••••••" : "ntn_…"}
                onChange={(event) =>
                  setDraft({ ...draft, upstream: { ...draft.upstream, notionToken: event.target.value } })
                }
              />
            </Field>
            <Field label={copy.notionParent} wide>
              <input
                className={inputClass}
                value={draft.upstream.notionParentId}
                placeholder="01234567-89ab-cdef-…"
                onChange={(event) =>
                  setDraft({ ...draft, upstream: { ...draft.upstream, notionParentId: event.target.value } })
                }
              />
            </Field>
          </div>
          {draft.notionTokenConfigured && (
            <label className="mt-3 flex items-center gap-2 text-[13px] font-sans text-text-secondary">
              <input
                type="checkbox"
                className="h-4 w-4 accent-[hsl(var(--accent-primary))]"
                checked={Boolean(draft.upstream.clearNotionToken)}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    upstream: { ...draft.upstream, clearNotionToken: event.target.checked },
                  })
                }
              />
              {copy.deleteNotionToken}
            </label>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button
              type="button"
              className={buttonSecondary}
              disabled={upstreamBusy !== null}
              onClick={() => void verifyNotion()}
            >
              {upstreamBusy === "verify" ? copy.notionVerifying : copy.notionVerify}
            </button>
            {settings.upstream.notionParentId && (
              <span className="text-[12px] font-sans text-text-tertiary">
                {settings.upstream.notionParentType === "database"
                  ? copy.notionParentTypeDatabase
                  : copy.notionParentTypePage}
              </span>
            )}
          </div>
          <p className="mt-2 text-[12px] font-sans text-text-tertiary">{copy.notionParentHint}</p>

          <div className="mt-4 rounded-xl border border-border-subtle bg-bg-primary px-4 py-3 text-[12px] font-sans leading-relaxed text-text-secondary">
            {!upstreamStats ||
            (upstreamStats.obsidian.exported === 0 &&
              upstreamStats.obsidian.failed === 0 &&
              upstreamStats.notion.exported === 0 &&
              upstreamStats.notion.failed === 0) ? (
              <span className="text-text-tertiary">{copy.statsNever}</span>
            ) : (
              <div className="flex flex-col gap-1">
                <span>
                  Obsidian · {copy.statsExported} {upstreamStats.obsidian.exported}
                  {upstreamStats.obsidian.pending > 0
                    ? ` · ${copy.statsPending} ${upstreamStats.obsidian.pending}`
                    : ""}
                  {upstreamStats.obsidian.failed > 0
                    ? ` · ${copy.statsFailed} ${upstreamStats.obsidian.failed}`
                    : ""}
                  {upstreamStats.obsidian.lastExportedAt
                    ? ` · ${copy.statsLastAt} ${new Date(upstreamStats.obsidian.lastExportedAt).toLocaleString()}`
                    : ""}
                </span>
                <span>
                  Notion · {copy.statsExported} {upstreamStats.notion.exported}
                  {upstreamStats.notion.failed > 0
                    ? ` · ${copy.statsFailed} ${upstreamStats.notion.failed}`
                    : ""}
                  {upstreamStats.notion.lastExportedAt
                    ? ` · ${copy.statsLastAt} ${new Date(upstreamStats.notion.lastExportedAt).toLocaleString()}`
                    : ""}
                </span>
                {(upstreamStats.obsidian.lastError || upstreamStats.notion.lastError) && (
                  <span className="text-danger">
                    {copy.statsLastError}: {upstreamStats.obsidian.lastError ?? upstreamStats.notion.lastError}
                  </span>
                )}
              </div>
            )}
            {upstreamNote && <div className="mt-1 text-text-secondary">{upstreamNote}</div>}
          </div>
        </Card>

        <Card eyebrow="LLM ACCESS" title={copy.llmTitle} description={copy.llmDesc}>
          <div className="mb-4 grid gap-2 md:grid-cols-2">
            {(
              [
                ["demo_proxy", copy.demoProxy, copy.demoProxyDesc],
                ["custom_byok", copy.byok, copy.byokDesc],
              ] as const
            ).map(([mode, title, desc]) => (
              <button
                type="button"
                key={mode}
                onClick={() => setLlmMode(mode)}
                className={`rounded-xl border p-4 text-left transition-colors [transition-duration:140ms] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus ${
                  draft.llm.mode === mode
                    ? "border-accent-primary/40 bg-accent-primary-light"
                    : "border-border-subtle bg-bg-primary hover:bg-bg-surface-hover"
                }`}
              >
                <span className="block text-[13px] font-sans font-semibold text-text-primary">{title}</span>
                <span className="mt-0.5 block text-[12px] font-sans text-text-tertiary">{desc}</span>
              </button>
            ))}
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <Field label={copy.baseUrl} wide>
              <input
                className={inputClass}
                value={draft.llm.baseUrl}
                readOnly={draft.llm.mode === "demo_proxy"}
                onChange={(event) =>
                  setDraft({ ...draft, llm: { ...draft.llm, baseUrl: event.target.value } })
                }
              />
            </Field>
            <Field label={copy.model}>
              <input
                className={inputClass}
                value={draft.llm.modelId}
                onChange={(event) =>
                  setDraft({ ...draft, llm: { ...draft.llm, modelId: event.target.value } })
                }
              />
            </Field>
            <Field label={copy.temperature}>
              <input
                className={inputClass}
                type="number"
                min="0"
                max="2"
                step="0.1"
                value={draft.llm.temperature}
                onChange={(event) =>
                  setDraft({ ...draft, llm: { ...draft.llm, temperature: Number(event.target.value) } })
                }
              />
            </Field>
            <Field label={copy.maxTokens}>
              <input
                className={inputClass}
                type="number"
                min="128"
                max="16384"
                step="128"
                value={draft.llm.maxTokens}
                onChange={(event) =>
                  setDraft({ ...draft, llm: { ...draft.llm, maxTokens: Number(event.target.value) } })
                }
              />
            </Field>
            {draft.llm.mode === "custom_byok" && (
              <Field label={`API Key ${draft.apiKeyConfigured ? copy.apiKeySaved : ""}`} wide>
                <input
                  className={inputClass}
                  type="password"
                  autoComplete="off"
                  value={draft.llm.apiKey}
                  placeholder={draft.apiKeyConfigured ? "••••••••••••" : "sk-…"}
                  onChange={(event) =>
                    setDraft({ ...draft, llm: { ...draft.llm, apiKey: event.target.value } })
                  }
                />
              </Field>
            )}
          </div>
          {draft.llm.mode === "custom_byok" && draft.apiKeyConfigured && (
            <label className="mt-3 flex items-center gap-2 text-[13px] font-sans text-text-secondary">
              <input
                type="checkbox"
                className="h-4 w-4 accent-[hsl(var(--accent-primary))]"
                checked={Boolean(draft.llm.clearApiKey)}
                onChange={(event) =>
                  setDraft({ ...draft, llm: { ...draft.llm, clearApiKey: event.target.checked } })
                }
              />
              {copy.deleteApiKey}
            </label>
          )}
          <p className="mt-3 text-[12px] font-sans text-text-tertiary">{copy.apiKeyNote}</p>
        </Card>

        <Card eyebrow="AGENT" title={copy.agentTitle} description={copy.agentDesc}>
          <div className="grid gap-4 md:grid-cols-2">
            <Field label={copy.outputLanguage}>
              <select
                className={inputClass}
                value={draft.agent.outputLanguage}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    agent: {
                      ...draft.agent,
                      outputLanguage: event.target.value as "zh-CN" | "en-US",
                    },
                  })
                }
              >
                <option value="zh-CN">简体中文</option>
                <option value="en-US">English</option>
              </select>
            </Field>
            <div />
            <Field label={copy.customInstructions} wide>
              <textarea
                className={`${inputClass} min-h-[88px] resize-y`}
                maxLength={4000}
                value={draft.agent.customInstructions}
                placeholder={copy.customInstructionsPlaceholder}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    agent: { ...draft.agent, customInstructions: event.target.value },
                  })
                }
              />
            </Field>
          </div>
          <div className="-mx-3 mt-2 flex flex-col">
            <Toggle
              checked={draft.agent.includeThinking}
              title={copy.includeThinking}
              description={copy.includeThinkingDesc}
              onChange={(checked) =>
                setDraft({ ...draft, agent: { ...draft.agent, includeThinking: checked } })
              }
            />
            <Toggle
              checked={draft.agent.includeToolDetails}
              title={copy.includeToolDetails}
              description={copy.includeToolDetailsDesc}
              onChange={(checked) =>
                setDraft({ ...draft, agent: { ...draft.agent, includeToolDetails: checked } })
              }
            />
          </div>
        </Card>

        <Card eyebrow="ORGANIZE" title={copy.organizeTitle} description={copy.organizeDesc}>
          <div className="-mx-3 flex flex-col">
            <Toggle
              checked={classifyEnabled && llmReady}
              disabled={!llmReady}
              title={copy.organizeAuto}
              description={llmReady ? copy.organizeAutoDesc : copy.organizeUnavailable}
              onChange={setClassifyEnabled}
            />
          </div>
          <div className="mt-2 grid gap-2 md:grid-cols-2">
            {(
              [
                ["auto", copy.organizeModeAuto, copy.organizeModeAutoDesc],
                ["suggest", copy.organizeModeSuggest, copy.organizeModeSuggestDesc],
              ] as const
            ).map(([mode, title, desc]) => (
              <button
                type="button"
                key={mode}
                onClick={() => setClassifyMode(mode)}
                className={`rounded-xl border p-3 text-left transition-colors [transition-duration:140ms] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus ${
                  classifyMode === mode
                    ? "border-accent-primary/40 bg-accent-primary-light"
                    : "border-border-subtle bg-bg-primary hover:bg-bg-surface-hover"
                }`}
              >
                <span className="block text-[13px] font-sans font-semibold text-text-primary">{title}</span>
                <span className="mt-0.5 block text-[11px] font-sans text-text-tertiary">{desc}</span>
              </button>
            ))}
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button
              type="button"
              className={buttonSecondary}
              disabled={classifyState.running || !llmReady}
              onClick={() => void organizeNow()}
            >
              {classifyState.running ? copy.organizeRunning : copy.organizeNow}
            </button>
            <span className="text-[12px] font-sans text-text-tertiary">
              {classifyState.lastRun
                ? `${copy.organizeLastRun} ${new Date(classifyState.lastRun.ranAt).toLocaleString()} · ${copy.organizeStatsClassified} ${classifyState.lastRun.classified} · ${copy.organizeStatsTopics} ${classifyState.lastRun.topicsCreated} · ${copy.organizeStatsQueued} ${classifyState.lastRun.queued}${
                    classifyState.lastRun.failedBatches > 0
                      ? ` · ${copy.organizeStatsFailed} ${classifyState.lastRun.failedBatches}`
                      : ""
                  }`
                : copy.organizeNever}
            </span>
          </div>
          <div className="mt-4">
            <div className="mb-2 flex items-center justify-between gap-3">
              <span className="text-[12px] font-sans font-medium text-text-secondary">
                {copy.organizeQueue} ({suggestions.length})
              </span>
              {suggestions.length > 1 && (
                <button type="button" className={buttonSecondary} onClick={() => void acceptAllSuggestions()}>
                  {copy.organizeAcceptAll}
                </button>
              )}
            </div>
            {suggestions.length === 0 ? (
              <p className="text-[12px] font-sans text-text-tertiary">{copy.organizeQueueEmpty}</p>
            ) : (
              <div className="flex flex-col gap-2">
                {suggestions.map((suggestion) => (
                  <div
                    key={suggestion.conversationId}
                    className="flex items-center gap-3 rounded-xl border border-border-subtle bg-bg-primary px-4 py-3"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-sans font-medium text-text-primary">
                        {suggestion.title}
                      </div>
                      <div className="truncate text-[11px] font-sans text-text-tertiary">
                        {suggestion.topicPath.join(" / ")} · {Math.round(suggestion.confidence * 100)}%
                      </div>
                    </div>
                    <button
                      type="button"
                      className={buttonSecondary}
                      onClick={() => void acceptSuggestion(suggestion.conversationId)}
                    >
                      {copy.organizeAccept}
                    </button>
                    <button
                      type="button"
                      className={buttonSecondary}
                      onClick={() => void ignoreSuggestion(suggestion.conversationId)}
                    >
                      {copy.organizeIgnore}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </Card>

        <Card eyebrow="DAILY LOG" title={copy.dailyTitle} description={copy.dailyDesc}>
          <Field label={copy.dailyTime}>
            <input
              className={inputClass}
              type="time"
              value={dailyTime}
              onChange={(event) => setDailyTime(event.target.value)}
            />
          </Field>
          <p className="mt-2 text-[12px] font-sans text-text-tertiary">{copy.dailyTimeDesc}</p>
        </Card>

        <Card eyebrow="NETWORK" title={copy.networkTitle} description={copy.networkDesc}>
          <div className="mb-4 grid gap-2 md:grid-cols-3">
            {(
              [
                ["system", copy.proxySystem, copy.proxySystemDesc],
                ["direct", copy.proxyDirect, copy.proxyDirectDesc],
                ["custom", copy.proxyCustom, copy.proxyCustomDesc],
              ] as const
            ).map(([mode, title, desc]) => (
              <button
                type="button"
                key={mode}
                onClick={() =>
                  setDraft({ ...draft, network: { ...draft.network, proxyMode: mode } })
                }
                className={`rounded-xl border p-3 text-left transition-colors [transition-duration:140ms] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus ${
                  draft.network.proxyMode === mode
                    ? "border-accent-primary/40 bg-accent-primary-light"
                    : "border-border-subtle bg-bg-primary hover:bg-bg-surface-hover"
                }`}
              >
                <span className="block text-[13px] font-sans font-semibold text-text-primary">{title}</span>
                <span className="mt-0.5 block text-[11px] font-sans text-text-tertiary">{desc}</span>
              </button>
            ))}
          </div>
          {draft.network.proxyMode === "custom" && (
            <Field label={copy.proxyUrl}>
              <input
                className={inputClass}
                value={draft.network.proxyUrl}
                placeholder="http://127.0.0.1:7890"
                onChange={(event) =>
                  setDraft({ ...draft, network: { ...draft.network, proxyUrl: event.target.value } })
                }
              />
            </Field>
          )}
        </Card>

        <Card eyebrow="PERSONALIZATION" title={copy.appearanceTitle} description={copy.appearanceDesc}>
          <div className="-mx-3 flex flex-col">
            <Toggle
              checked={themeMode === "dark"}
              title={copy.darkMode}
              description={copy.darkModeDesc}
              onChange={() => onToggleTheme()}
            />
          </div>
          <Field label={copy.language}>
            <select
              className={inputClass}
              value={locale}
              onChange={(event) => void setLocale(event.target.value as SupportedLocale)}
            >
              <option value="zh">简体中文</option>
              <option value="en">English</option>
              <option value="ja">日本語</option>
              <option value="ko">한국어</option>
            </select>
          </Field>
        </Card>

        <Card eyebrow="PERSONALIZATION" title={copy.owlSkinTitle} description={copy.owlSkinDesc}>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {SKINS.map((skin) => {
              const selected = skin.id === owlSkin;
              return (
                <button
                  type="button"
                  key={skin.id}
                  aria-pressed={selected}
                  onClick={() => setOwlSkin(skin.id)}
                  className={`flex flex-col items-center gap-2 rounded-xl border p-3 transition-colors [transition-duration:140ms] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus ${
                    selected
                      ? "border-accent-primary/40 bg-accent-primary-light ring-2 ring-accent-primary/30"
                      : "border-border-subtle bg-bg-primary hover:bg-bg-surface-hover"
                  }`}
                >
                  <img src={skin.collapsed} alt="" draggable={false} className="h-14 w-14" />
                  <span className="text-[12px] font-sans font-medium text-text-primary">
                    {locale === "zh" ? skin.name.zh : skin.name.en}
                  </span>
                </button>
              );
            })}
          </div>
        </Card>

        <Card
          eyebrow="ABOUT"
          title={copy.aboutTitle}
          description={copy.aboutDesc}
          aside={
            <span className="rounded-full bg-bg-secondary px-2.5 py-1 text-[11px] font-sans font-medium text-text-secondary">
              v{settings.appVersion}
            </span>
          }
        >
          <dl className="mb-4 grid gap-2 text-[12px] font-sans">
            <div className="flex min-w-0 gap-2">
              <dt className="shrink-0 text-text-tertiary">{copy.settingsDir}</dt>
              <dd className="min-w-0 flex-1 truncate text-text-secondary">{settings.settingsDirectory}</dd>
            </div>
            <div className="flex min-w-0 gap-2">
              <dt className="shrink-0 text-text-tertiary">{copy.contentDir}</dt>
              <dd className="min-w-0 flex-1 truncate text-text-secondary">{settings.activeDataDirectory}</dd>
            </div>
          </dl>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={buttonSecondary} onClick={() => void window.vesti.openSettingsDirectory()}>
              {copy.openSettingsDir}
            </button>
            <button type="button" className={buttonSecondary} onClick={() => void window.vesti.restartApp()}>
              {copy.restartApp}
            </button>
          </div>
        </Card>
      </div>

      <div className="fixed bottom-0 left-[52px] right-0 border-t border-border-subtle bg-bg-app/90 px-8 py-3 backdrop-blur">
        <div className="mx-auto flex max-w-[880px] items-center justify-between gap-4">
          <p className="truncate text-[12px] font-sans text-text-secondary">{message}</p>
          <div className="flex shrink-0 gap-2">
            <button type="button" className={buttonSecondary} disabled={busy} onClick={() => void saveSettings(true)}>
              {copy.saveAndTest}
            </button>
            <button type="button" className={buttonPrimary} disabled={busy} onClick={() => void saveSettings()}>
              {busy ? copy.saving : copy.save}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
