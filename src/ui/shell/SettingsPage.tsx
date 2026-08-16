import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type {
  AgentMcpTargetId,
  AgentMcpTargetStatus,
  AppSettingsUpdate,
  AppSettingsView,
  AgentOutputLanguage,
  CapturePlatform,
  CustomOwlAsset,
  ExtensionBridgeStatusView,
  ExtensionPairCodeView,
  MembershipStatus,
  Overview,
  WslStatusView,
} from "../../shared/contracts";
import { useI18n } from "../i18n";
import { InfoTip } from "@vesti/ui";
import type { SupportedLocale } from "../i18n/locales";
import { MembershipAccountCard } from "../membership/MembershipAccountCard";
import { DataContributionCard } from "../membership/DataContributionCard";
import { CreditCard } from "../membership/CreditCard";
import { useUiPreference } from "./useUiPreference";
import { AGENT_NOTIFY_PREF_KEY, AMBIENT_BUBBLE_PREF_KEY } from "../companion/ambientBubble";
import { CUSTOM_SKIN_ID, DEFAULT_SKIN_ID, SKINS, resolveSkin } from "../../capsule/skins";
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
import {
  applyTopicGovernance,
  runTopicGovernance,
  type TopicGovernancePlan,
} from "../organize/topicGovernance";
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

const PLATFORM_TONES: Record<string, string> = {
  codex: "#5069df",
  cursor: "#161b22",
  "kimi-code": "#8459c8",
  "claude-code": "#c7663b",
};

// Desktop-only settings copy. Keep every supported locale complete so this
// page never falls back to a different language than the rest of the shell.
const BYOK_BASE_URL_REQUIRED: Record<SupportedLocale, string> = {
  zh: "使用自定义 / BYOK 时必须填写 Base URL。",
  en: "A Base URL is required for Custom / BYOK mode.",
  ja: "カスタム / BYOK を使用するには Base URL が必要です。",
  ko: "사용자 지정 / BYOK 모드에는 Base URL이 필요합니다.",
};

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
    capsuleTitle: "悬浮球",
    capsuleDesc: "桌面悬浮球的显示、搭话与完工提醒,以及小猫头鹰皮肤。",
    ambientBubble: "猫头鹰环境气泡",
    ambientBubbleDesc: "空闲时小猫头鹰会偶尔冒泡,聊聊你的梦境整理与最新对话。",
    agentNotify: "Agent 完工提醒",
    agentNotifyDesc: "当 Kimi Code、Claude Code 等 agent 完成一轮工作时,悬浮球会冒泡提示。",
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
    bridgeDesc: "浏览器扩展通过本机回环服务把网页端会话导入 Vesti。打开扩展侧栏即可自动连接（首次需确认一次），也可使用配对码手动连接。",
    bridgeRunning: "服务运行中",
    bridgeStopped: "服务未运行",
    bridgeError: "端口冲突,扩展暂不可用",
    bridgeAutoTitle: "自动连接（推荐）",
    bridgeAutoDesc: "安装 VESTI 浏览器扩展后，打开扩展侧栏即自动连接；首次连接本设备会弹出一次确认，之后长期免交互。配对窗口关闭时扩展无法发起连接。",
    bridgeOpenWindow: "打开配对窗口",
    bridgeWindowOpen: "配对窗口开启中",
    bridgeWindowClosed: "配对窗口已关闭，打开后扩展才能自动连接。",
    bridgeManualTitle: "使用配对码连接（兜底）",
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
    demoProxyDesc: "开箱即用，模型名称原样透传",
    byok: "自定义 / BYOK",
    byokDesc: "OpenAI 兼容 API",
    baseUrl: "Base URL",
    model: "模型",
    temperature: "Temperature",
    maxTokens: "最大输出 Token",
    maxTokensHint: "0 = 不限（按模型默认上限），长文档不会被截断",
    apiKeySaved: "(已安全保存,留空则不修改)",
    deleteApiKey: "删除已保存的 API Key",
    apiKeyNote: "API Key 由操作系统安全存储加密,前端页面不会读取已保存的明文。",
    modelTestHint: "模型配置会自动保存;点击按钮可立即验证当前连接。",
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
    organizeTidy: "整理现有话题",
    organizeTidyDesc: "让 AI 审查现有主题树,建议合并同义主题、重命名低质名称;确认后批量执行。",
    organizeTidyRunning: "审查中…",
    organizeTidyEmpty: "AI 审查完成:现有主题树无需整理。",
    organizeTidyFailed: "整理审查失败,请稍后重试。",
    organizeTidySuggestions: "整理建议(确认后执行)",
    organizeTidyMerge: "合并",
    organizeTidyRename: "改名",
    organizeTidyApply: "应用整理",
    organizeTidyApplying: "应用中…",
    organizeTidyCancel: "取消",
    organizeTidyDone: "已应用整理:合并 {merged} 组、重命名 {renamed} 个主题。",
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
    customOwlSlot: "自定义",
    customOwlDiyTitle: "DIY 你的猫头鹰",
    customOwlDiyDesc: "用一句话描述想要的风格，AI 会按统一的猫头鹰形象绘制专属皮肤，同时应用到悬浮球与夜话头像。",
    customOwlPlaceholder: "例如：青花瓷纹样，淡雅蓝色",
    customOwlGenerate: "生成皮肤",
    customOwlGenerating: "绘制中…",
    customOwlMemberHint: "DIY 皮肤为会员专属，每次生成消耗 20 积分。",
    customOwlEmptyHint: "先描述一下想要的风格吧。",
    customOwlFailed: "生成失败，请稍后再试。",
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
    mcpTitle: "连接到 Agent",
    mcpDesc: "把 Vesti 记忆服务（vesti-mcp）一键写入本机各 Agent 的 MCP 配置。注册后,Agent 在项目里开新会话时可自动拉取该项目的状态卡、简报与最近会话,无需重复交代背景。写入前备份原配置,不影响已有的其他 MCP server。",
    mcpDetected: "已检测到",
    mcpNotDetected: "未检测到",
    mcpRegistered: "已注册",
    mcpOutdated: "配置过旧,点注册更新",
    mcpRegister: "一键注册",
    mcpRemove: "移除",
    mcpWorking: "写入中…",
    mcpServerMissing: "未找到 vesti-mcp 构建产物,请先在仓库根目录运行 pnpm mcp:build。",
    mcpBackupAt: "原配置已备份:",
    mcpFailed: "写入失败:",
    mcpGuideOk: "开工指引已写入",
    mcpGuideOutdated: "开工指引过旧,点注册更新",
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
    capsuleTitle: "Floating Ball",
    capsuleDesc: "Show or hide the desktop floating ball, control its bubbles, and pick the owl skin.",
    ambientBubble: "Owl ambient bubbles",
    ambientBubbleDesc: "When idle, the owl occasionally surfaces a gentle line about your dreams and latest conversations.",
    agentNotify: "Agent completion alerts",
    agentNotifyDesc: "When Kimi Code, Claude Code, or another agent finishes a run, the floating ball lets you know.",
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
    bridgeDesc: "The browser extension imports web conversations into Vesti over a loopback service. Open the extension side panel to auto-connect (one-time confirmation), or use a pair code.",
    bridgeRunning: "Service running",
    bridgeStopped: "Service stopped",
    bridgeError: "Port conflict; extension bridge unavailable",
    bridgeAutoTitle: "Auto-connect (recommended)",
    bridgeAutoDesc: "With the VESTI browser extension installed, open its side panel to connect automatically. This device shows a one-time confirmation on first connect, then stays hands-free. The extension can only connect while the pairing window is open.",
    bridgeOpenWindow: "Open pairing window",
    bridgeWindowOpen: "Pairing window open",
    bridgeWindowClosed: "Pairing window closed. Open it so the extension can auto-connect.",
    bridgeManualTitle: "Connect with a pair code (fallback)",
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
    demoProxyDesc: "Ready to use; model names pass through unchanged",
    byok: "Custom / BYOK",
    byokDesc: "OpenAI-compatible API",
    baseUrl: "Base URL",
    model: "Model",
    temperature: "Temperature",
    maxTokens: "Max output tokens",
    maxTokensHint: "0 = uncapped (model default); long documents won't be truncated",
    apiKeySaved: "(saved securely; leave blank to keep)",
    deleteApiKey: "Delete the saved API Key",
    apiKeyNote: "The API key is encrypted by the OS secure storage; the page never reads it back.",
    modelTestHint: "Model settings save automatically. Use the button to verify the current connection.",
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
    organizeTidy: "Tidy existing topics",
    organizeTidyDesc: "Let AI review the topic tree and propose synonym merges and better names; applied only after your confirmation.",
    organizeTidyRunning: "Reviewing…",
    organizeTidyEmpty: "Review finished: the topic tree needs no tidy-up.",
    organizeTidyFailed: "Tidy-up review failed. Please try again later.",
    organizeTidySuggestions: "Tidy-up suggestions (applied on confirm)",
    organizeTidyMerge: "Merge",
    organizeTidyRename: "Rename",
    organizeTidyApply: "Apply tidy-up",
    organizeTidyApplying: "Applying…",
    organizeTidyCancel: "Cancel",
    organizeTidyDone: "Tidy-up applied: {merged} merge groups, {renamed} renames.",
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
    customOwlSlot: "Custom",
    customOwlDiyTitle: "DIY your owl",
    customOwlDiyDesc: "Describe a style in one line and AI draws your exclusive owl skin — applied to the floating ball and Night Talk avatar at once.",
    customOwlPlaceholder: "e.g. blue-and-white porcelain, soft indigo",
    customOwlGenerate: "Generate",
    customOwlGenerating: "Drawing…",
    customOwlMemberHint: "DIY skins are a member feature; each generation costs 20 credits.",
    customOwlEmptyHint: "Describe the style you want first.",
    customOwlFailed: "Generation failed. Please try again later.",
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
    mcpTitle: "Connect to agents",
    mcpDesc: "Write the Vesti memory server (vesti-mcp) into each installed agent's MCP config in one click. Once registered, an agent starting a new session in a project automatically pulls that project's state card, brief and recent sessions — no need to repeat the background. The original config is backed up before writing; other MCP servers stay untouched.",
    mcpDetected: "Detected",
    mcpNotDetected: "Not detected",
    mcpRegistered: "Registered",
    mcpOutdated: "Outdated — register to update",
    mcpRegister: "Register",
    mcpRemove: "Remove",
    mcpWorking: "Writing…",
    mcpServerMissing: "vesti-mcp build output not found — run pnpm mcp:build at the repo root first.",
    mcpBackupAt: "Original config backed up:",
    mcpFailed: "Write failed:",
    mcpGuideOk: "Session-start guide installed",
    mcpGuideOutdated: "Session-start guide outdated, re-register",
  },
  ja: {
    loading: "設定を読み込み中…",
    generalTitle: "アプリの動作",
    generalDesc: "Windows へのサインイン時の起動方法と、ウィンドウを閉じた後の動作を設定します。",
    launchAtLogin: "サインイン時に Vesti を起動",
    launchAtLoginDesc: "Windows へのサインイン後、収集サービスを自動的に開始します。",
    startMinimized: "起動時にウィンドウを隠す",
    startMinimizedDesc: "トレイアイコンだけを表示し、作業を中断しません。",
    closeToTray: "閉じてもトレイで実行を継続",
    closeToTrayDesc: "ウィンドウを閉じてもバックグラウンド収集を続けます。終了はトレイメニューから行えます。",
    showCapsule: "デスクトップのフローティングボールを表示",
    showCapsuleDesc: "小さなフクロウを画面端に常駐させ、同期やメイン画面をすぐ開けます。",
    capsuleTitle: "フローティングボール",
    capsuleDesc: "デスクトップのフローティングボールの表示、話しかけ・完了通知、フクロウのスキンを設定します。",
    ambientBubble: "フクロウの環境バブル",
    ambientBubbleDesc: "アイドル時にフクロウが夢の整理や最新の会話についてそっと話しかけます。",
    agentNotify: "エージェント完了通知",
    agentNotifyDesc: "Kimi Code や Claude Code などのエージェントが作業を終えると、フローティングボールがお知らせします。",
    captureTitle: "収集エンジン",
    captureDesc: "有効なツールがローカルに保存した会話ファイルだけを読み取ります。無効にしても保存済みデータは削除されません。",
    watchOnStartup: "起動後にリアルタイム収集を開始",
    watchOnStartupDesc: "新規・更新された会話ファイルを監視します。トレイからいつでも一時停止できます。",
    syncNow: "今すぐ同期",
    syncing: "同期中…",
    liveCapture: "リアルタイム収集",
    detected: "検出済み",
    notDetected: "未検出",
    sessions: "件の会話",
    enabled: "有効",
    disabled: "無効",
    wslSources: "WSL ソース",
    wslSourcesDesc: "WSL ディストリビューション内のツールデータも自動検出し、同期と定期監視の対象にします。",
    wslNoDistros: "WSL ディストリビューションが見つかりません",
    wslRedetect: "再検出",
    wslDetecting: "検出中…",
    bridgeTitle: "VESTI 拡張機能を接続",
    bridgeDesc: "ブラウザー拡張機能はローカルのループバックサービス経由で Web 会話を Vesti に取り込みます。ペアリングコードを生成して拡張機能に入力してください。",
    bridgeRunning: "サービス実行中",
    bridgeStopped: "サービス停止中",
    bridgeError: "ポート競合のため拡張機能に接続できません",
    bridgeGenerate: "ペアリングコードを生成",
    bridgeCodeHint: "このコードをブラウザー拡張機能に入力",
    bridgeCodeExpired: "コードの有効期限が切れました。再生成してください。",
    bridgeClients: "接続済みクライアント",
    bridgeNoClients: "接続済みクライアントはありません。",
    bridgePairedAt: "ペアリング日時",
    bridgeLastSync: "最終同期",
    bridgeNeverSynced: "未同期",
    bridgeDisconnect: "切断",
    bridgeDisconnectConfirm: "このクライアントを切断しますか？再度同期するには拡張機能のペアリングが必要です。",
    dataTitle: "データとプライバシー",
    dataDesc: "会話データベース、正規化テキスト、Agent の結果を保存する場所です。アプリのインストール先とは独立しています。",
    dataDirectory: "データ保存先",
    chooseFolder: "フォルダーを選択",
    activeDir: "現在使用中:",
    restartNeeded: "データ保存先の変更は再起動後に反映されます。既存データは自動移動されません。",
    restartNow: "今すぐ再起動",
    openDataDir: "現在のデータフォルダーを開く",
    clearAgent: "Agent の履歴を消去",
    clearAgentConfirm: "Summary / Explore の結果をすべて削除しますか？収集済みの元会話は削除されません。",
    clearAgentDone: "Agent の履歴を消去しました。",
    clearAgentNote: "Agent の結果を消去しても、元会話、SQLite データベース、ソースツールのファイルには影響しません。",
    llmTitle: "モデルサービス",
    llmDesc: "ブラウザー拡張機能と同様に、Vesti Demo Proxy または独自の OpenAI 互換 API キーを使用できます。",
    demoProxy: "Demo Proxy",
    demoProxyDesc: "すぐに利用可能。モデル名はそのまま送信",
    byok: "カスタム / BYOK",
    byokDesc: "OpenAI 互換 API",
    baseUrl: "Base URL",
    model: "モデル",
    temperature: "Temperature",
    maxTokens: "最大出力 Token",
    maxTokensHint: "0 = 無制限（モデルのデフォルト上限）、長文が途中で切れません",
    apiKeySaved: "（安全に保存済み。空欄なら維持）",
    deleteApiKey: "保存済み API キーを削除",
    apiKeyNote: "API キーは OS の安全なストレージで暗号化され、この画面から平文を読み取ることはありません。",
    modelTestHint: "モデル設定は自動保存されます。ボタンを押すと現在の接続を確認できます。",
    agentTitle: "インサイト設定",
    agentDesc: "Summary / Explore に渡す内容と、既定の出力言語を設定します。",
    outputLanguage: "出力言語",
    customInstructions: "分析時の追加指示（任意）",
    customInstructionsPlaceholder: "例：製品上の決定と技術リスクを優先し、次の手順には担当者と受け入れ基準を付ける。",
    includeThinking: "表示可能な思考要約を含める",
    includeThinkingDesc: "ソースに思考の要約がある場合、分析モデルにも渡します。",
    includeToolDetails: "ツール呼び出しの詳細を含める",
    includeToolDetailsDesc: "ツール名、入力、出力、エラーを送信し、より詳しく分析します。",
    organizeTitle: "整理",
    organizeDesc: "未分類の会話をトピックツリーへ自動整理します。確信度が低い結果は確認待ちになり、手動分類は上書きしません。",
    organizeAuto: "自動分類",
    organizeAutoDesc: "新しい会話の同期完了から約 10 秒後に自動実行します。",
    organizeUnavailable: "自動分類を使うには、下の「モデルサービス」で利用可能なモデルを設定してください。",
    organizeModeAuto: "自動で適用",
    organizeModeAutoDesc: "確信度 60% 以上を直接分類",
    organizeModeSuggest: "提案のみ",
    organizeModeSuggestDesc: "すべて確認待ちに追加",
    organizeNow: "今すぐ整理",
    organizeRunning: "整理中…",
    organizeNever: "まだ実行されていません。",
    organizeLastRun: "最終実行",
    organizeStatsClassified: "分類済み",
    organizeStatsTopics: "新規トピック",
    organizeStatsQueued: "確認待ち",
    organizeStatsFailed: "失敗したバッチ",
    organizeQueue: "確認待ち",
    organizeQueueEmpty: "確認待ちの提案はありません。",
    organizeAccept: "承認",
    organizeIgnore: "無視",
    organizeAcceptAll: "すべて承認",
    dailyTitle: "デイリーログ",
    dailyDesc: "毎日決まった時刻に当日のレポートを生成します。起動時には未生成の前日分を補完し、モデル未設定時はローカルテンプレートを使います。",
    dailyTime: "毎日の生成時刻",
    dailyTimeDesc: "既定は 21:30。活動がない日はスキップします。",
    upstreamTitle: "外部へのエクスポート",
    upstreamDesc: "会話を Obsidian Vault または Notion に出力します。Obsidian は選択したローカルフォルダーへ書き込み、Notion Token は OS の安全なストレージで暗号化します。",
    obsidianSection: "Obsidian",
    vaultPath: "Vault フォルダー",
    vaultNotChosen: "未選択",
    vaultChoose: "フォルダーを選択",
    autoExport: "新しい会話を Obsidian へ自動エクスポート",
    autoExportDesc: "同期の約 15 秒後、まだ出力していない新しい会話を Vault に書き込みます。",
    exportAllObsidian: "すべて Obsidian に出力",
    exportAllMarkdown: "すべて Markdown フォルダーに出力",
    notionSection: "Notion",
    notionToken: "Integration Token",
    notionTokenSaved: "（安全に保存済み。空欄なら維持）",
    deleteNotionToken: "保存済み Token を削除",
    notionParent: "対象 Page ID / Database ID",
    notionParentHint: "Notion の対象ページでも「··· → 接続」からこの Integration を許可してください。",
    notionParentTypePage: "確認済み: ページ",
    notionParentTypeDatabase: "確認済み: データベース",
    notionVerify: "保存して接続を確認",
    notionVerifying: "確認中…",
    statsExported: "出力済み",
    statsFailed: "失敗",
    statsPending: "待機中",
    statsLastAt: "最終出力",
    statsLastError: "最新のエラー",
    statsNever: "まだ出力されていません。",
    exportRunning: "出力中",
    exportDone: "出力完了",
    exportFailedCount: "失敗",
    exportNeedVault: "先に Vault フォルダーを選択して保存してください。",
    networkTitle: "ネットワークとプロキシ",
    networkDesc: "モデルへのリクエストは既定で Windows のシステムプロキシに従います。変更は再起動なしで反映されます。",
    proxySystem: "システム設定に従う",
    proxySystemDesc: "推奨。Windows / VPN のプロキシを使用",
    proxyDirect: "直接接続",
    proxyDirectDesc: "システムプロキシを使用しない",
    proxyCustom: "カスタムプロキシ",
    proxyCustomDesc: "HTTP / HTTPS / SOCKS",
    proxyUrl: "プロキシ URL",
    appearanceTitle: "外観と言語",
    appearanceDesc: "テーマと表示言語はすべてのウィンドウにすぐ反映されます。",
    darkMode: "ダークモード",
    darkModeDesc: "すべてのウィンドウへ即時に適用します。",
    language: "表示言語",
    owlSkinTitle: "フローティングボールのスキン",
    owlSkinDesc: "小さなフクロウの外観を選択します。クリックするとすぐ反映されます。",
    customOwlSlot: "カスタム",
    customOwlDiyTitle: "フクロウをDIYする",
    customOwlDiyDesc: "欲しいスタイルを一言で伝えると、AI が統一されたフクロウの形象で専用スキンを描きます。フローティングボールと夜話アバターの両方に適用されます。",
    customOwlPlaceholder: "例：青花瓷の模様、淡い藍色",
    customOwlGenerate: "スキンを生成",
    customOwlGenerating: "描画中…",
    customOwlMemberHint: "DIY スキンはメンバー限定です。生成ごとに 20 クレジットを消費します。",
    customOwlEmptyHint: "まず欲しいスタイルを教えてください。",
    customOwlFailed: "生成に失敗しました。後でもう一度お試しください。",
    aboutTitle: "Vesti について",
    aboutDesc: "ローカル優先の AI 会話収集・整理・インサイトツールです。Codex、Cursor、Kimi Code、Claude Code に対応しています。",
    settingsDir: "設定フォルダー",
    contentDir: "コンテンツフォルダー",
    openSettingsDir: "設定フォルダーを開く",
    restartApp: "Vesti を再起動",
    saveAndTest: "保存してモデルをテスト",
    save: "設定を保存",
    saving: "保存中…",
    saved: "設定を保存しました。",
    savedRestart: "設定を保存しました。データ保存先は再起動後に切り替わります。",
    mcpTitle: "エージェントに接続",
    mcpDesc: "Vesti の記憶サーバー（vesti-mcp）を各エージェントの MCP 設定にワンクリックで書き込みます。登録後、エージェントはプロジェクトで新しいセッションを始めるときに状態カード・ブリーフ・最近のセッションを自動で取得でき、背景を説明し直す必要がありません。書き込み前に元の設定をバックアップし、既存の他の MCP サーバーには触れません。",
    mcpDetected: "検出済み",
    mcpNotDetected: "未検出",
    mcpRegistered: "登録済み",
    mcpOutdated: "設定が古い — 登録で更新",
    mcpRegister: "ワンクリック登録",
    mcpRemove: "削除",
    mcpWorking: "書き込み中…",
    mcpServerMissing: "vesti-mcp のビルド成果物が見つかりません。リポジトリのルートで pnpm mcp:build を先に実行してください。",
    mcpBackupAt: "元の設定をバックアップ:",
    mcpGuideOk: "セッション開始ガイド導入済み",
    mcpGuideOutdated: "セッション開始ガイドが古い — 再登録で更新",
    mcpFailed: "書き込みに失敗:",
  },
  ko: {
    loading: "설정을 불러오는 중…",
    generalTitle: "앱 동작",
    generalDesc: "Windows 로그인 시 Vesti가 시작되는 방식과 창을 닫은 뒤의 동작을 설정합니다.",
    launchAtLogin: "로그인할 때 Vesti 시작",
    launchAtLoginDesc: "Windows에 로그인하면 수집 서비스를 자동으로 시작합니다.",
    startMinimized: "시작할 때 창 숨기기",
    startMinimizedDesc: "트레이 아이콘만 표시하여 현재 작업을 방해하지 않습니다.",
    closeToTray: "창을 닫아도 트레이에서 계속 실행",
    closeToTrayDesc: "창을 닫은 뒤에도 백그라운드 수집을 계속합니다. 트레이 메뉴에서 완전히 종료할 수 있습니다.",
    showCapsule: "데스크톱 플로팅 볼 표시",
    showCapsuleDesc: "작은 부엉이를 화면 가장자리에 두고 동기화하거나 메인 화면을 빠르게 엽니다.",
    capsuleTitle: "플로팅 볼",
    capsuleDesc: "바탕 화면 플로팅 볼의 표시, 말걸기·완료 알림과 부엉이 스킨을 설정합니다.",
    ambientBubble: "부엉이 앰비언트 버블",
    ambientBubbleDesc: "한가할 때 부엉이가 꿈 정리와 최근 대화에 대해 가볍게 말을 겁니다.",
    agentNotify: "에이전트 완료 알림",
    agentNotifyDesc: "Kimi Code, Claude Code 등 에이전트가 작업을 마치면 플로팅 볼이 알려줍니다.",
    captureTitle: "수집 엔진",
    captureDesc: "활성화한 도구가 로컬에 저장한 대화 파일만 읽습니다. 소스를 꺼도 이미 보관된 데이터는 삭제되지 않습니다.",
    watchOnStartup: "시작 후 실시간 수집",
    watchOnStartupDesc: "새로 만들거나 변경한 대화 파일을 감시합니다. 트레이 메뉴에서 언제든 일시 중지할 수 있습니다.",
    syncNow: "지금 동기화",
    syncing: "동기화 중…",
    liveCapture: "실시간 수집",
    detected: "감지됨",
    notDetected: "감지되지 않음",
    sessions: "개 대화",
    enabled: "활성화",
    disabled: "비활성화",
    wslSources: "WSL 소스",
    wslSourcesDesc: "WSL 배포판 안의 도구 데이터를 자동으로 감지하여 동기화와 주기적 감시에 포함합니다.",
    wslNoDistros: "WSL 배포판을 찾지 못했습니다",
    wslRedetect: "다시 감지",
    wslDetecting: "감지 중…",
    bridgeTitle: "VESTI 확장 프로그램 연결",
    bridgeDesc: "브라우저 확장 프로그램은 로컬 루프백 서비스를 통해 웹 대화를 Vesti로 가져옵니다. 페어링 코드를 생성해 확장 프로그램에 입력하세요.",
    bridgeRunning: "서비스 실행 중",
    bridgeStopped: "서비스 중지됨",
    bridgeError: "포트 충돌로 확장 프로그램 연결을 사용할 수 없습니다",
    bridgeGenerate: "페어링 코드 생성",
    bridgeCodeHint: "이 코드를 브라우저 확장 프로그램에 입력",
    bridgeCodeExpired: "코드가 만료되었습니다. 새로 생성하세요.",
    bridgeClients: "연결된 클라이언트",
    bridgeNoClients: "아직 연결된 클라이언트가 없습니다.",
    bridgePairedAt: "페어링 시간",
    bridgeLastSync: "마지막 동기화",
    bridgeNeverSynced: "동기화한 적 없음",
    bridgeDisconnect: "연결 해제",
    bridgeDisconnectConfirm: "이 클라이언트의 연결을 해제할까요? 계속 동기화하려면 확장 프로그램을 다시 페어링해야 합니다.",
    dataTitle: "데이터 및 개인정보",
    dataDesc: "대화 데이터베이스, 정규화된 텍스트와 Agent 결과가 저장되는 위치입니다. 앱 설치 위치와 콘텐츠 저장 위치는 서로 독립적입니다.",
    dataDirectory: "데이터 폴더",
    chooseFolder: "폴더 선택",
    activeDir: "현재 사용 중:",
    restartNeeded: "데이터 폴더 변경은 앱을 다시 시작한 뒤 적용됩니다. 기존 데이터는 자동으로 이동하지 않습니다.",
    restartNow: "지금 다시 시작",
    openDataDir: "현재 데이터 폴더 열기",
    clearAgent: "Agent 기록 지우기",
    clearAgentConfirm: "Summary / Explore 결과를 모두 삭제할까요? 수집한 원본 대화는 삭제되지 않습니다.",
    clearAgentDone: "Agent 기록을 지웠습니다.",
    clearAgentNote: "Agent 결과를 지워도 원본 대화, SQLite 데이터베이스 또는 소스 도구의 파일에는 영향을 주지 않습니다.",
    llmTitle: "모델 서비스",
    llmDesc: "브라우저 확장 프로그램과 동일하게 Vesti Demo Proxy를 사용하거나 OpenAI 호환 API 키를 직접 연결할 수 있습니다.",
    demoProxy: "Demo Proxy",
    demoProxyDesc: "바로 사용 가능, 모델 이름을 그대로 전달",
    byok: "사용자 지정 / BYOK",
    byokDesc: "OpenAI 호환 API",
    baseUrl: "Base URL",
    model: "모델",
    temperature: "Temperature",
    maxTokens: "최대 출력 토큰",
    maxTokensHint: "0 = 제한 없음(모델 기본 상한) — 긴 문서가 잘리지 않습니다",
    apiKeySaved: "(안전하게 저장됨, 비워 두면 유지)",
    deleteApiKey: "저장된 API 키 삭제",
    apiKeyNote: "API 키는 운영체제의 보안 저장소로 암호화되며 이 화면에서는 평문을 다시 읽지 않습니다.",
    modelTestHint: "모델 설정은 자동 저장됩니다. 버튼을 눌러 현재 연결을 확인할 수 있습니다.",
    agentTitle: "인사이트 설정",
    agentDesc: "Summary / Explore에 보낼 내용과 기본 출력 언어를 설정합니다.",
    outputLanguage: "출력 언어",
    customInstructions: "분석 지침 추가(선택 사항)",
    customInstructionsPlaceholder: "예: 제품 결정과 기술 위험을 우선하고, 다음 단계마다 담당자와 승인 기준을 제시하세요.",
    includeThinking: "표시 가능한 사고 요약 포함",
    includeThinkingDesc: "소스가 사고 요약을 제공하면 분석 모델에도 함께 전달합니다.",
    includeToolDetails: "도구 호출 상세 정보 포함",
    includeToolDetailsDesc: "도구 이름, 입력, 출력과 오류를 보내 더 완전한 기술 분석을 받습니다.",
    organizeTitle: "정리",
    organizeDesc: "분류되지 않은 대화를 주제 트리에 자동으로 정리합니다. 신뢰도가 낮은 결과는 검토 대기열로 이동하며 수동 분류는 덮어쓰지 않습니다.",
    organizeAuto: "자동 분류",
    organizeAutoDesc: "새 대화의 동기화가 끝난 약 10초 뒤 자동으로 실행됩니다.",
    organizeUnavailable: "자동 분류를 사용하려면 아래의 모델 서비스에서 작동하는 모델을 먼저 설정하세요.",
    organizeModeAuto: "자동 적용",
    organizeModeAutoDesc: "신뢰도 60% 이상이면 바로 분류",
    organizeModeSuggest: "제안만",
    organizeModeSuggestDesc: "모든 결과를 검토 대기열에 추가",
    organizeNow: "지금 정리",
    organizeRunning: "정리 중…",
    organizeNever: "아직 실행한 적이 없습니다.",
    organizeLastRun: "마지막 실행",
    organizeStatsClassified: "분류됨",
    organizeStatsTopics: "새 주제",
    organizeStatsQueued: "검토 대기",
    organizeStatsFailed: "실패한 배치",
    organizeQueue: "검토 대기열",
    organizeQueueEmpty: "검토할 제안이 없습니다.",
    organizeAccept: "수락",
    organizeIgnore: "무시",
    organizeAcceptAll: "모두 수락",
    dailyTitle: "일일 로그",
    dailyDesc: "매일 정해진 시간에 그날의 보고서를 생성합니다. 앱 시작 시 놓친 전날 보고서를 보완하며, 모델이 없으면 로컬 템플릿을 사용합니다.",
    dailyTime: "매일 생성 시간",
    dailyTimeDesc: "기본값은 21:30이며 활동이 없는 날은 건너뜁니다.",
    upstreamTitle: "외부 내보내기",
    upstreamDesc: "대화를 Obsidian Vault 또는 Notion으로 내보냅니다. Obsidian은 선택한 로컬 폴더에 쓰고, Notion Token은 운영체제 보안 저장소로 암호화합니다.",
    obsidianSection: "Obsidian",
    vaultPath: "Vault 폴더",
    vaultNotChosen: "선택하지 않음",
    vaultChoose: "폴더 선택",
    autoExport: "새 대화를 Obsidian으로 자동 내보내기",
    autoExportDesc: "동기화가 끝난 약 15초 뒤 아직 내보내지 않은 새 대화를 Vault에 기록합니다.",
    exportAllObsidian: "모두 Obsidian으로 내보내기",
    exportAllMarkdown: "모두 Markdown 폴더로 내보내기",
    notionSection: "Notion",
    notionToken: "Integration Token",
    notionTokenSaved: "(안전하게 저장됨, 비워 두면 유지)",
    deleteNotionToken: "저장된 Token 삭제",
    notionParent: "대상 Page ID / Database ID",
    notionParentHint: "Notion 대상 페이지의 ‘··· → 연결’에서도 이 Integration을 허용하세요.",
    notionParentTypePage: "확인됨: 페이지",
    notionParentTypeDatabase: "확인됨: 데이터베이스",
    notionVerify: "저장하고 연결 확인",
    notionVerifying: "확인 중…",
    statsExported: "내보냄",
    statsFailed: "실패",
    statsPending: "대기 중",
    statsLastAt: "마지막 내보내기",
    statsLastError: "최근 오류",
    statsNever: "아직 내보낸 항목이 없습니다.",
    exportRunning: "내보내는 중",
    exportDone: "내보내기 완료",
    exportFailedCount: "실패",
    exportNeedVault: "먼저 Vault 폴더를 선택하고 저장하세요.",
    networkTitle: "네트워크 및 프록시",
    networkDesc: "모델 요청은 기본적으로 Windows 시스템 프록시를 따릅니다. 변경 사항은 다시 시작하지 않아도 바로 적용됩니다.",
    proxySystem: "시스템 설정 따르기",
    proxySystemDesc: "권장, Windows / VPN 프록시 사용",
    proxyDirect: "직접 연결",
    proxyDirectDesc: "시스템 프록시 우회",
    proxyCustom: "사용자 지정 프록시",
    proxyCustomDesc: "HTTP / HTTPS / SOCKS",
    proxyUrl: "프록시 URL",
    appearanceTitle: "모양 및 언어",
    appearanceDesc: "테마와 화면 언어가 모든 창에 즉시 적용됩니다.",
    darkMode: "다크 모드",
    darkModeDesc: "모든 창에 즉시 적용합니다.",
    language: "화면 언어",
    owlSkinTitle: "플로팅 볼 스킨",
    owlSkinDesc: "작은 부엉이 플로팅 볼의 모양을 선택합니다. 클릭하면 바로 적용됩니다.",
    customOwlSlot: "사용자 지정",
    customOwlDiyTitle: "나만의 부엉이 DIY",
    customOwlDiyDesc: "원하는 스타일을 한 문장으로 설명하면 AI가 통일된 부엉이 이미지로 전용 스킨을 그립니다. 플로팅 볼과 밤의 대화 아바타에 동시에 적용됩니다.",
    customOwlPlaceholder: "예: 청화백자 무늬, 은은한 남색",
    customOwlGenerate: "스킨 생성",
    customOwlGenerating: "그리는 중…",
    customOwlMemberHint: "DIY 스킨은 멤버 전용이며, 생성할 때마다 20 크레딧이 차감됩니다.",
    customOwlEmptyHint: "먼저 원하는 스타일을 알려 주세요.",
    customOwlFailed: "생성에 실패했습니다. 잠시 후 다시 시도해 주세요.",
    aboutTitle: "Vesti 정보",
    aboutDesc: "로컬 우선 AI 대화 수집, 보관 및 인사이트 도구입니다. Codex, Cursor, Kimi Code와 Claude Code를 지원합니다.",
    settingsDir: "설정 폴더",
    contentDir: "콘텐츠 폴더",
    openSettingsDir: "설정 폴더 열기",
    restartApp: "Vesti 다시 시작",
    saveAndTest: "저장하고 모델 테스트",
    save: "설정 저장",
    saving: "저장 중…",
    saved: "설정을 저장했습니다.",
    savedRestart: "설정을 저장했습니다. 데이터 폴더는 다시 시작한 뒤 변경됩니다.",
    mcpTitle: "에이전트에 연결",
    mcpDesc: "Vesti 메모리 서버(vesti-mcp)를 설치된 각 에이전트의 MCP 설정에 원클릭으로 등록합니다. 등록 후 에이전트가 프로젝트에서 새 세션을 시작할 때 해당 프로젝트의 상태 카드, 브리프, 최근 세션을 자동으로 가져오므로 배경을 다시 설명할 필요가 없습니다. 쓰기 전에 원본 설정을 백업하며 기존 다른 MCP 서버는 그대로 둡니다.",
    mcpDetected: "감지됨",
    mcpNotDetected: "감지되지 않음",
    mcpRegistered: "등록됨",
    mcpOutdated: "구성이 오래됨 — 등록으로 업데이트",
    mcpRegister: "원클릭 등록",
    mcpRemove: "제거",
    mcpWorking: "쓰는 중…",
    mcpServerMissing: "vesti-mcp 빌드 산출물을 찾을 수 없습니다. 저장소 루트에서 pnpm mcp:build를 먼저 실행하세요.",
    mcpBackupAt: "원본 설정 백업:",
    mcpGuideOk: "세션 시작 가이드 설치됨",
    mcpGuideOutdated: "세션 시작 가이드가 오래됨 — 재등록으로 업데이트",
    mcpFailed: "쓰기 실패:",
  },
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

function toSettingsUpdate(draft: SettingsDraft): AppSettingsUpdate {
  return {
    dataDirectory: draft.dataDirectory,
    general: draft.general,
    capture: draft.capture,
    network: draft.network,
    agent: draft.agent,
    llm: draft.llm,
    upstream: draft.upstream,
  };
}

function settingsFingerprint(draft: SettingsDraft): string {
  return JSON.stringify(toSettingsUpdate(draft));
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
  // Sections default to collapsed to keep the page light; the open state is
  // session-local (not persisted). While collapsed, hovering the header shows
  // the card's description as a tooltip so the intro stays discoverable.
  const [open, setOpen] = useState(false);
  const header = (
    <button
      type="button"
      aria-expanded={open}
      onClick={() => setOpen(current => !current)}
      className="flex min-w-0 flex-1 items-start justify-between gap-3 rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus"
    >
      <span className="min-w-0">
        <span className="block text-[11px] font-sans font-medium uppercase tracking-[0.16em] text-text-tertiary">
          {eyebrow}
        </span>
        <span className="mt-1 block font-serif text-[18px] font-normal text-text-primary">{title}</span>
      </span>
      <svg
        aria-hidden="true"
        viewBox="0 0 16 16"
        fill="none"
        className={`mt-1.5 h-3.5 w-3.5 shrink-0 text-text-tertiary transition-transform [transition-duration:160ms] ${open ? "rotate-180" : ""}`}
      >
        <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );
  return (
    <section className="rounded-card border border-border-subtle bg-bg-surface-card p-6">
      <div className={`flex items-start justify-between gap-4 ${open ? "mb-4" : ""}`}>
        {!open && description ? (
          <InfoTip title={title} description={description} className="min-w-0 flex-1">
            {header}
          </InfoTip>
        ) : (
          header
        )}
        {aside}
      </div>
      {open ? (
        <>
          {description ? (
            <p className="mb-4 text-[13px] font-sans leading-relaxed text-text-secondary">{description}</p>
          ) : null}
          {children}
        </>
      ) : null}
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
        className="relative h-[22px] w-[38px] shrink-0 rounded-full border border-border-default bg-bg-secondary transition-colors [transition-duration:160ms] after:absolute after:left-[3px] after:top-[3px] after:h-4 after:w-4 after:rounded-full after:bg-text-tertiary after:shadow-sm after:transition-[transform,background-color] after:[transition-duration:160ms] peer-focus-visible:ring-2 peer-focus-visible:ring-border-focus peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-bg-surface-card peer-checked:border-accent-primary peer-checked:bg-accent-primary peer-checked:after:translate-x-4 peer-checked:after:bg-text-inverse"
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
  membership,
  onLogout,
}: {
  themeMode: "light" | "dark";
  onToggleTheme: () => void;
  membership: MembershipStatus;
  onLogout: () => Promise<void>;
}) {
  const { locale, setLocale } = useI18n();
  const copy = { ...COPY.en, ...COPY[locale] };
  const [capsuleEnabled, setCapsuleEnabled] = useUiPreference("capsule.enabled", true, value => value !== false);
  const [ambientBubbleEnabled, setAmbientBubbleEnabled] = useUiPreference(AMBIENT_BUBBLE_PREF_KEY, true, value => value !== false);
  const [agentNotifyEnabled, setAgentNotifyEnabled] = useUiPreference(AGENT_NOTIFY_PREF_KEY, true, value => value !== false);
  const [owlSkin, setOwlSkin] = useUiPreference("owlSkin", DEFAULT_SKIN_ID, value =>
    value === CUSTOM_SKIN_ID ? CUSTOM_SKIN_ID : resolveSkin(value).id);
  // DIY 自定义皮肤：生成表单状态 + 当前自定义图预览。
  const [customOwlAsset, setCustomOwlAsset] = useState<CustomOwlAsset | null>(null);
  const [customPrompt, setCustomPrompt] = useState("");
  const [customBusy, setCustomBusy] = useState(false);
  const [customError, setCustomError] = useState("");
  const [classifyEnabled, setClassifyEnabled] = useUiPreference("classify.enabled", true, value => value !== false);
  const [classifyMode, setClassifyMode] = useUiPreference<"auto" | "suggest">(
    "classify.mode",
    "auto",
    value => (value === "suggest" ? "suggest" : "auto"),
  );
  const [dailyTime, setDailyTime] = useUiPreference(DAILY_TIME_PREF_KEY, DEFAULT_DAILY_TIME, normalizeDailyTime);

  // Load the current DIY skin once (the custom slot's preview + grid thumb).
  useEffect(() => {
    let cancelled = false;
    void window.vesti
      ?.readCustomOwl()
      .then((asset) => {
        if (!cancelled) setCustomOwlAsset(asset);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const handleGenerateCustomOwl = useCallback(async () => {
    if (customBusy || !window.vesti?.generateCustomOwl) return;
    const prompt = customPrompt.trim();
    if (!prompt) {
      setCustomError(copy.customOwlEmptyHint);
      return;
    }
    setCustomBusy(true);
    setCustomError("");
    try {
      const asset = await window.vesti.generateCustomOwl(prompt);
      setCustomOwlAsset(asset);
      setOwlSkin(CUSTOM_SKIN_ID);
      // 胶囊/夜话监听这个 pref 作为自定义图更新的刷新信号。
      void window.vestiUi?.setUiPreference("owlCustomUpdatedAt", asset.updatedAt);
    } catch (error) {
      setCustomError((error as Error)?.message || copy.customOwlFailed);
    } finally {
      setCustomBusy(false);
    }
  }, [customBusy, customPrompt, copy, setOwlSkin]);

  const [settings, setSettings] = useState<AppSettingsView | null>(null);
  const [draft, setDraft] = useState<SettingsDraft | null>(null);
  const [overview, setOverview] = useState<Overview>(EMPTY_OVERVIEW);
  const [wslStatus, setWslStatus] = useState<WslStatusView | null>(null);
  const [wslBusy, setWslBusy] = useState(false);
  const [modelBusy, setModelBusy] = useState(false);
  const [modelMessage, setModelMessage] = useState("");
  const [message, setMessage] = useState("");
  const [bridge, setBridge] = useState<ExtensionBridgeStatusView | null>(null);
  const [pairCode, setPairCode] = useState<ExtensionPairCodeView | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [classifyState, setClassifyState] = useState(getAutoClassifyState());
  const [suggestions, setSuggestions] = useState<ClassifySuggestion[]>([]);
  // Topic governance (one-shot tidy of the existing topic tree).
  const [tidy, setTidy] = useState<{
    running: boolean;
    applying: boolean;
    plan: TopicGovernancePlan | null;
    note: string;
  }>({ running: false, applying: false, plan: null, note: "" });
  const [upstreamStats, setUpstreamStats] = useState<UpstreamExportStats | null>(null);
  const [upstreamBusy, setUpstreamBusy] = useState<string | null>(null);
  const [upstreamNote, setUpstreamNote] = useState("");
  // Agent MCP registration (connect vesti-mcp to installed agents).
  const [mcpTargets, setMcpTargets] = useState<AgentMcpTargetStatus[] | null>(null);
  const [mcpBusy, setMcpBusy] = useState<AgentMcpTargetId | null>(null);
  const [mcpNote, setMcpNote] = useState("");

  const loadMcpTargets = useCallback(async () => {
    setMcpTargets(await window.vesti.getAgentMcpStatus().catch(() => null));
  }, []);

  async function toggleMcpRegistration(target: AgentMcpTargetStatus) {
    setMcpBusy(target.id);
    setMcpNote("");
    try {
      const result = target.registered
        ? await window.vesti.unregisterAgentMcp(target.id)
        : await window.vesti.registerAgentMcp(target.id);
      if (!result.ok) setMcpNote(result.error ?? "unknown error");
      else if (result.backupPath) setMcpNote(`${copy.mcpBackupAt} ${result.backupPath}`);
    } catch (error) {
      setMcpNote(errorMessage(error));
    } finally {
      setMcpBusy(null);
      void loadMcpTargets();
    }
  }
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSavedFingerprintRef = useRef("");
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());

  const load = useCallback(async () => {
    const [settingsValue, overviewValue, wslValue, bridgeValue, upstreamStatsValue] = await Promise.all([
      window.vesti.getSettings(),
      window.vesti.getOverview(),
      window.vesti.getWslStatus(),
      window.vesti.getExtensionBridgeStatus(),
      getUpstreamExportStats().catch(() => null),
    ]);
    const nextDraft = toDraft(settingsValue);
    lastSavedFingerprintRef.current = settingsFingerprint(nextDraft);
    setSettings(settingsValue);
    setDraft(nextDraft);
    setOverview(overviewValue);
    setWslStatus(wslValue);
    setBridge(bridgeValue);
    setUpstreamStats(upstreamStatsValue);
  }, []);

  useEffect(() => {
    void load();
    void loadMcpTargets();
    const unsubscribeCapture = window.vesti.onCaptureChanged(() => {
      void Promise.all([window.vesti.getOverview(), window.vesti.getWslStatus()])
        .then(([overviewValue, wslValue]) => {
          setOverview(overviewValue);
          setWslStatus(wslValue);
        });
    });
    const unsubscribeBridge = window.vesti.onExtensionBridgeChanged(() => {
      void window.vesti.getExtensionBridgeStatus().then(setBridge);
    });
    return () => {
      unsubscribeCapture();
      unsubscribeBridge();
    };
  }, [load, loadMcpTargets]);

  // App settings persist after a short idle period. Saving through a single
  // queue prevents an older request from finishing after a newer edit and
  // overwriting it. UI-only preferences (theme, language, skin, etc.) already
  // use their own immediate preference bridge.
  useEffect(() => {
    if (!draft) return;
    const fingerprint = settingsFingerprint(draft);
    if (fingerprint === lastSavedFingerprintRef.current) return;
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    autoSaveTimerRef.current = setTimeout(() => {
      autoSaveTimerRef.current = null;
      void queueSettingsSave(draft);
    }, 650);
    return () => {
      if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = null;
    };
  }, [draft]);

  // 1s ticker for the pair-code and pairing-window countdowns.
  const pairingWindowOpen = Boolean(
    bridge?.pairingWindow.open
    && bridge.pairingWindow.expiresAt !== null
    && bridge.pairingWindow.expiresAt > now,
  );
  useEffect(() => {
    if (!pairCode && !pairingWindowOpen) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [pairCode, pairingWindowOpen]);

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

  // Topic governance: review the tree, show the plan, apply on confirm.
  async function tidyTopicsNow() {
    setTidy({ running: true, applying: false, plan: null, note: "" });
    try {
      const plan = await runTopicGovernance();
      setTidy({
        running: false,
        applying: false,
        plan,
        note: plan ? "" : copy.organizeTidyFailed,
      });
    } catch {
      setTidy({ running: false, applying: false, plan: null, note: copy.organizeTidyFailed });
    }
  }

  async function applyTidyPlan() {
    if (!tidy.plan || tidy.applying) return;
    setTidy({ ...tidy, applying: true });
    const result = await applyTopicGovernance(tidy.plan);
    setTidy({
      running: false,
      applying: false,
      plan: null,
      note: copy.organizeTidyDone
        .replace("{merged}", String(result.merged))
        .replace("{renamed}", String(result.renamed)),
    });
  }

  function cancelTidyPlan() {
    setTidy({ running: false, applying: false, plan: null, note: "" });
  }

  async function generatePairCode() {
    setPairCode(await window.vesti.createExtensionPairCode());
    setNow(Date.now());
  }

  async function openPairingWindow() {
    await window.vesti.openExtensionPairingWindow();
    setBridge(await window.vesti.getExtensionBridgeStatus());
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

  function queueSettingsSave(
    snapshot: SettingsDraft,
    feedback: "auto" | "model" | "upstream" = "auto",
  ): Promise<boolean> {
    const run = async (): Promise<boolean> => {
      const snapshotFingerprint = settingsFingerprint(snapshot);
      if (snapshot.llm.mode === "custom_byok" && !snapshot.llm.baseUrl.trim()) {
        const text = BYOK_BASE_URL_REQUIRED[locale];
        if (feedback === "model") setModelMessage(text);
        else setMessage(text);
        return false;
      }
      try {
        const result = await window.vesti.saveSettings(toSettingsUpdate(snapshot));
        const normalized = toDraft(result.settings);
        lastSavedFingerprintRef.current = snapshotFingerprint;
        setSettings(result.settings);
        setDraft((current) => {
          if (!current || settingsFingerprint(current) !== snapshotFingerprint) return current;
          lastSavedFingerprintRef.current = settingsFingerprint(normalized);
          return normalized;
        });
        if (result.settings.upstream.obsidianAutoExport) scheduleUpstreamAutoExport();
        if (result.restartRequired) setMessage(copy.savedRestart);
        if (feedback === "model") {
          const tested = await window.vesti.testLlm();
          setModelMessage(tested.message);
        }
        return true;
      } catch (error) {
        const text = errorMessage(error);
        if (feedback === "model") setModelMessage(text);
        else if (feedback === "upstream") setUpstreamNote(text);
        else setMessage(text);
        return false;
      }
    };

    const queued = saveQueueRef.current.then(run, run);
    saveQueueRef.current = queued.then(() => undefined, () => undefined);
    return queued;
  }

  async function saveAndTestModel(): Promise<void> {
    if (!draft) return;
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    autoSaveTimerRef.current = null;
    setModelBusy(true);
    setModelMessage("");
    try {
      await queueSettingsSave(draft, "model");
    } finally {
      setModelBusy(false);
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
    setUpstreamNote("");
    try {
      if (!draft) return;
      if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = null;
      if (!(await queueSettingsSave(draft, "upstream"))) return;
      const tested = await window.vesti.testNotionConnection();
      setUpstreamNote(tested.message);
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
      <div className="mx-auto flex max-w-[880px] flex-col gap-6 pb-8">
        <MembershipAccountCard status={membership} onLogout={onLogout} locale={locale} />
        <DataContributionCard locale={locale} />
        <CreditCard membership={membership} llmMode={settings.llm.mode} locale={locale} />

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
          </div>
        </Card>

        <Card eyebrow="CAPSULE" title={copy.capsuleTitle} description={copy.capsuleDesc}>
          <div className="-mx-3 flex flex-col">
            <Toggle
              checked={capsuleEnabled}
              title={copy.showCapsule}
              description={copy.showCapsuleDesc}
              onChange={setCapsuleEnabled}
            />
            <Toggle
              checked={ambientBubbleEnabled}
              title={copy.ambientBubble}
              description={copy.ambientBubbleDesc}
              onChange={setAmbientBubbleEnabled}
            />
            <Toggle
              checked={agentNotifyEnabled}
              title={copy.agentNotify}
              description={copy.agentNotifyDesc}
              onChange={setAgentNotifyEnabled}
            />
          </div>

          {/* 皮肤选择并入本卡（原独立卡片收纳至此）。 */}
          <div className="mt-5 border-t border-border-subtle pt-4">
            <div className="mb-1 text-[13px] font-sans font-medium text-text-primary">{copy.owlSkinTitle}</div>
            <p className="mb-3 text-[12px] font-sans leading-relaxed text-text-tertiary">{copy.owlSkinDesc}</p>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
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
                      {skin.name[locale]}
                    </span>
                  </button>
                );
              })}
              {/* DIY 自定义槽位：有作品显示缩略图，没有显示引导占位。 */}
              <button
                type="button"
                aria-pressed={owlSkin === CUSTOM_SKIN_ID}
                onClick={() => setOwlSkin(CUSTOM_SKIN_ID)}
                className={`flex flex-col items-center gap-2 rounded-xl border p-3 transition-colors [transition-duration:140ms] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus ${
                  owlSkin === CUSTOM_SKIN_ID
                    ? "border-accent-primary/40 bg-accent-primary-light ring-2 ring-accent-primary/30"
                    : "border-dashed border-border-default bg-bg-primary hover:bg-bg-surface-hover"
                }`}
              >
                {customOwlAsset ? (
                  <img src={customOwlAsset.dataUrl} alt="" draggable={false} className="h-14 w-14" />
                ) : (
                  <span className="flex h-14 w-14 items-center justify-center text-2xl" aria-hidden="true">
                    ✨
                  </span>
                )}
                <span className="text-[12px] font-sans font-medium text-text-primary">
                  {copy.customOwlSlot}
                </span>
              </button>
            </div>

            {/* DIY 生成区：描述风格 → 网关绘图 → 同时应用到悬浮球与夜话头像。 */}
            <div className="mt-3 rounded-xl border border-border-subtle bg-bg-primary p-3">
              <p className="text-[12px] font-sans font-medium text-text-primary">{copy.customOwlDiyTitle}</p>
              <p className="mt-1 text-[11px] font-sans leading-relaxed text-text-tertiary">
                {copy.customOwlDiyDesc}
              </p>
              <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
                <input
                  type="text"
                  value={customPrompt}
                  onChange={(event) => setCustomPrompt(event.target.value)}
                  placeholder={copy.customOwlPlaceholder}
                  disabled={customBusy}
                  maxLength={400}
                  className={`${inputClass} flex-1`}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void handleGenerateCustomOwl();
                  }}
                />
                <button
                  type="button"
                  className={buttonPrimary}
                  disabled={customBusy}
                  onClick={() => void handleGenerateCustomOwl()}
                >
                  {customBusy ? copy.customOwlGenerating : copy.customOwlGenerate}
                </button>
              </div>
              {customError ? (
                <p className="mt-2 text-[12px] font-sans text-danger">{customError}</p>
              ) : null}
              <p className="mt-2 text-[11px] font-sans text-text-tertiary">{copy.customOwlMemberHint}</p>
            </div>
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
          <div className="mb-4 rounded-xl border border-border-subtle bg-bg-primary px-4 py-3">
            <div className="mb-1 text-[13px] font-sans font-medium text-text-primary">{copy.bridgeAutoTitle}</div>
            <p className="mb-3 text-[12px] font-sans text-text-tertiary">{copy.bridgeAutoDesc}</p>
            <div className="flex flex-wrap items-center gap-3">
              <button type="button" className={buttonSecondary} onClick={() => void openPairingWindow()}>
                {copy.bridgeOpenWindow}
              </button>
              {pairingWindowOpen && bridge?.pairingWindow.expiresAt ? (
                <span className="flex items-center gap-2 text-[12px] font-sans text-text-secondary">
                  <span className="inline-block h-2 w-2 rounded-full bg-success" />
                  {copy.bridgeWindowOpen} · {Math.floor((bridge.pairingWindow.expiresAt - now) / 60000)}:
                  {String(Math.floor(((bridge.pairingWindow.expiresAt - now) % 60000) / 1000)).padStart(2, "0")}
                </span>
              ) : (
                <span className="text-[12px] font-sans text-text-tertiary">{copy.bridgeWindowClosed}</span>
              )}
            </div>
          </div>
          <details className="mb-4">
            <summary className="cursor-pointer select-none text-[12px] font-sans font-medium text-text-secondary">
              {copy.bridgeManualTitle}
            </summary>
            <div className="mt-3 flex flex-wrap items-center gap-3">
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
          </details>
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

        <Card eyebrow="CONNECT" title={copy.mcpTitle} description={copy.mcpDesc}>
          {mcpTargets && !mcpTargets.some((target) => target.serverAvailable) ? (
            <p className="mb-4 text-[12px] font-sans text-danger">{copy.mcpServerMissing}</p>
          ) : null}
          <div className="flex flex-col gap-2">
            {(mcpTargets ?? []).map((target) => {
              const disabled = !target.serverAvailable || mcpBusy !== null;
              return (
                <div
                  key={target.id}
                  className="flex items-center gap-3 rounded-xl border border-border-subtle bg-bg-primary px-4 py-3"
                >
                  <span
                    className={`inline-block h-2 w-2 shrink-0 rounded-full ${
                      target.registered && target.upToDate
                        ? "bg-success"
                        : target.detected
                          ? "bg-warning"
                          : "bg-bg-tertiary"
                    }`}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2 text-[13px] font-sans font-medium text-text-primary">
                      {target.label}
                      <span className="text-[11px] font-normal text-text-tertiary">
                        {target.registered
                          ? target.upToDate
                            ? copy.mcpRegistered
                            : copy.mcpOutdated
                          : target.detected
                            ? copy.mcpDetected
                            : copy.mcpNotDetected}
                      </span>
                    </div>
                    <div className="truncate text-[11px] font-sans text-text-tertiary">
                      {target.error ?? target.configPath}
                    </div>
                    {target.instructionsPath && target.registered ? (
                      <div
                        className={`truncate text-[11px] font-sans ${
                          target.instructionsInstalled && target.instructionsUpToDate
                            ? "text-success"
                            : "text-warning"
                        }`}
                      >
                        {target.instructionsInstalled && target.instructionsUpToDate
                          ? copy.mcpGuideOk
                          : copy.mcpGuideOutdated}
                      </div>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    className={target.registered ? buttonSecondary : buttonPrimary}
                    disabled={disabled || (!target.detected && !target.registered)}
                    onClick={() => void toggleMcpRegistration(target)}
                  >
                    {mcpBusy === target.id
                      ? copy.mcpWorking
                      : target.registered
                        ? copy.mcpRemove
                        : copy.mcpRegister}
                  </button>
                </div>
              );
            })}
          </div>
          {mcpNote ? (
            <p className="mt-3 break-all text-[12px] font-sans text-text-secondary">{mcpNote}</p>
          ) : null}
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
            {draft.llm.mode === "custom_byok" && (
              <Field label={copy.baseUrl} wide>
                <input
                  className={inputClass}
                  value={draft.llm.baseUrl}
                  onChange={(event) =>
                    setDraft({ ...draft, llm: { ...draft.llm, baseUrl: event.target.value } })
                  }
                />
              </Field>
            )}
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
                min="0"
                max="16384"
                step="128"
                value={draft.llm.maxTokens}
                onChange={(event) =>
                  setDraft({ ...draft, llm: { ...draft.llm, maxTokens: Number(event.target.value) } })
                }
              />
              <p className="mt-1 text-[11px] font-sans text-text-tertiary">{copy.maxTokensHint}</p>
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
          <div className="mt-5 flex flex-col gap-3 border-t border-border-subtle pt-4 sm:flex-row sm:items-center sm:justify-between">
            <p className="min-w-0 text-[12px] font-sans leading-relaxed text-text-secondary" role="status">
              {modelMessage || copy.modelTestHint}
            </p>
            <button
              type="button"
              className={`${buttonPrimary} shrink-0`}
              disabled={modelBusy}
              onClick={() => void saveAndTestModel()}
            >
              {modelBusy ? copy.saving : copy.saveAndTest}
            </button>
          </div>
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
                      outputLanguage: event.target.value as AgentOutputLanguage,
                    },
                  })
                }
              >
                <option value="zh-CN">简体中文</option>
                <option value="en-US">English</option>
                <option value="ja-JP">日本語</option>
                <option value="ko-KR">한국어</option>
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
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button
              type="button"
              className={buttonSecondary}
              disabled={tidy.running || tidy.applying || !llmReady}
              onClick={() => void tidyTopicsNow()}
            >
              {tidy.running ? copy.organizeTidyRunning : copy.organizeTidy}
            </button>
            <span className="text-[12px] font-sans text-text-tertiary">{copy.organizeTidyDesc}</span>
          </div>
          {tidy.plan && tidy.plan.merges.length + tidy.plan.renames.length === 0 && (
            <p className="mt-3 text-[12px] font-sans text-text-tertiary">{copy.organizeTidyEmpty}</p>
          )}
          {tidy.plan && tidy.plan.merges.length + tidy.plan.renames.length > 0 && (
            <div className="mt-3 rounded-xl border border-border-subtle bg-bg-primary px-4 py-3">
              <div className="mb-2 text-[12px] font-sans font-medium text-text-secondary">
                {copy.organizeTidySuggestions}
              </div>
              <div className="flex flex-col gap-1.5">
                {tidy.plan.merges.map((merge) => (
                  <div key={`merge-${merge.targetId}`} className="text-[12px] font-sans text-text-primary">
                    <span className="mr-1.5 rounded bg-accent-primary-light px-1.5 py-0.5 text-[11px] font-medium text-accent-primary">
                      {copy.organizeTidyMerge}
                    </span>
                    {merge.sourceNames.join("、")} → {merge.name ?? merge.targetName}
                  </div>
                ))}
                {tidy.plan.renames.map((rename) => (
                  <div key={`rename-${rename.id}`} className="text-[12px] font-sans text-text-primary">
                    <span className="mr-1.5 rounded bg-accent-primary-light px-1.5 py-0.5 text-[11px] font-medium text-accent-primary">
                      {copy.organizeTidyRename}
                    </span>
                    {rename.from} → {rename.to}
                  </div>
                ))}
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  className={buttonSecondary}
                  disabled={tidy.applying}
                  onClick={() => void applyTidyPlan()}
                >
                  {tidy.applying ? copy.organizeTidyApplying : copy.organizeTidyApply}
                </button>
                <button
                  type="button"
                  className={buttonSecondary}
                  disabled={tidy.applying}
                  onClick={cancelTidyPlan}
                >
                  {copy.organizeTidyCancel}
                </button>
              </div>
            </div>
          )}
          {tidy.note && !tidy.plan && (
            <p className="mt-3 text-[12px] font-sans text-text-tertiary">{tidy.note}</p>
          )}
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

          {/* 每日日志设置并入本卡（原独立小卡收纳至此）。 */}
          <div className="mt-5 border-t border-border-subtle pt-4">
            <div className="mb-1 text-[13px] font-sans font-medium text-text-primary">{copy.dailyTitle}</div>
            <p className="mb-3 text-[12px] font-sans leading-relaxed text-text-tertiary">{copy.dailyDesc}</p>
            <Field label={copy.dailyTime}>
              <input
                className={inputClass}
                type="time"
                value={dailyTime}
                onChange={(event) => setDailyTime(event.target.value)}
              />
            </Field>
            <p className="mt-2 text-[12px] font-sans text-text-tertiary">{copy.dailyTimeDesc}</p>
          </div>
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

      {message ? (
        <div
          role="status"
          className="fixed bottom-4 right-6 z-30 max-w-[420px] rounded-xl border border-border-subtle bg-bg-primary px-4 py-3 text-[12px] font-sans text-text-secondary shadow-popover"
        >
          {message}
        </div>
      ) : null}
    </div>
  );
}
