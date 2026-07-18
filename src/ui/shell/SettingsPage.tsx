import { useCallback, useEffect, useState, type ReactNode } from "react";
import type {
  AppSettingsUpdate,
  AppSettingsView,
  CapturePlatform,
  Overview,
} from "../../shared/contracts";
import { useI18n } from "../i18n";
import type { SupportedLocale } from "../i18n/locales";
import { useUiPreference } from "./useUiPreference";

type SettingsDraft = AppSettingsUpdate & { apiKeyConfigured: boolean };

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
    aboutTitle: "关于 Vesti",
    aboutDesc: "本地优先的 AI 会话采集、归档与洞察工具。当前支持 Codex、Cursor 和 Kimi Code。",
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
    aboutTitle: "About Vesti",
    aboutDesc: "A local-first AI conversation capture, archive, and insight tool. Currently supports Codex, Cursor, and Kimi Code.",
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
    apiKeyConfigured: settings.llm.apiKeyConfigured,
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

  const [settings, setSettings] = useState<AppSettingsView | null>(null);
  const [draft, setDraft] = useState<SettingsDraft | null>(null);
  const [overview, setOverview] = useState<Overview>(EMPTY_OVERVIEW);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    const [settingsValue, overviewValue] = await Promise.all([
      window.vesti.getSettings(),
      window.vesti.getOverview(),
    ]);
    setSettings(settingsValue);
    setDraft(toDraft(settingsValue));
    setOverview(overviewValue);
  }, []);

  useEffect(() => {
    void load();
    return window.vesti.onCaptureChanged(() => void load());
  }, [load]);

  async function chooseDirectory() {
    const directory = await window.vesti.chooseDataDirectory();
    if (directory) {
      setDraft((current) => (current ? { ...current, dataDirectory: directory } : current));
    }
  }

  async function saveSettings(testAfterSave = false) {
    if (!draft) return;
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
      });
      setSettings(result.settings);
      setDraft(toDraft(result.settings));
      setMessage(result.restartRequired ? copy.savedRestart : copy.saved);
      if (testAfterSave) {
        const tested = await window.vesti.testLlm();
        setMessage(tested.message);
      }
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
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
                    <span className="block truncate text-[13px] font-sans font-medium text-text-primary">
                      {source.label}
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
