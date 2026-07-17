import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  AgentKind,
  AgentResult,
  AppSettingsUpdate,
  AppSettingsView,
  Overview,
  SessionDetail,
  SessionSummary,
  SourceStatus,
} from './shared/contracts';

type Page = 'overview' | 'library' | 'insights' | 'settings';
type SettingsDraft = AppSettingsUpdate & { apiKeyConfigured: boolean };

const EMPTY: Overview = {
  sources: [],
  sessions: [],
  totals: { conversations: 0, messages: 0, inputTokens: 0, outputTokens: 0, storageSize: 0 },
  watching: false,
  syncing: false,
};
const tones: Record<string, string> = {
  codex: '#5069df', cursor: '#161b22', 'kimi-code': '#8459c8', 'claude-code': '#c7663b',
};

function compact(value: number): string {
  return new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

function bytes(value: number): string {
  if (!value) return '0 MB';
  const units = ['B', 'KB', 'MB', 'GB'];
  const power = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / 1024 ** power).toFixed(power > 1 ? 1 : 0)} ${units[power]}`;
}

function ago(value: number): string {
  const minutes = Math.max(0, Math.round((Date.now() - value) / 60_000));
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} 小时前` : new Date(value).toLocaleDateString('zh-CN');
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '');
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
      apiKey: '',
      clearApiKey: false,
    },
    apiKeyConfigured: settings.llm.apiKeyConfigured,
  };
}

function SourceCard({ source }: { source: SourceStatus }) {
  return <article className="source-card">
    <div className="source-mark" style={{ background: tones[source.platform] }}>{source.label[0]}</div>
    <div className="source-copy">
      <div className="source-heading">
        <strong>{source.label}</strong>
        <span className={source.enabled && source.installed ? 'status good' : 'status quiet'}>
          {!source.enabled ? '已停用' : source.installed ? '已连接' : '未检测到'}
        </span>
      </div>
      <p>{!source.enabled ? '可在设置中重新启用' : source.installed ? `${source.sessionCount} 个本地会话` : '安装后会自动发现数据源'}</p>
    </div>
  </article>;
}

function SessionRow({ session, onOpen }: { session: SessionSummary; onOpen: () => void }) {
  return <button className="session-row" onClick={onOpen}>
    <span className="platform-dot" style={{ background: tones[session.platform] ?? '#6d746f' }} />
    <span className="session-main"><strong>{session.title}</strong><span>{session.projectPath || session.model || session.platform}</span></span>
    <span className="session-meta">{session.messageCount} 条 · {ago(session.lastActivityAt)}</span>
    <span className="chevron">›</span>
  </button>;
}

function DetailPanel({ detail, onClose }: { detail: SessionDetail; onClose: () => void }) {
  const visible = detail.messages.filter(message =>
    ['user_input', 'assistant_text', 'assistant_think', 'tool_request', 'tool_result'].includes(message.source));
  return <div className="detail-backdrop" onMouseDown={event => event.currentTarget === event.target && onClose()}>
    <aside className="detail-panel">
      <header className="detail-header">
        <div><span className="eyebrow">{detail.session.platform}</span><h2>{detail.session.title}</h2><p>{detail.session.projectPath || '未记录项目路径'}</p></div>
        <button className="icon-button" onClick={onClose}>×</button>
      </header>
      <div className="message-stream">{visible.map(message => <article className={`message ${message.role === 'user' && !message.contentToolOutput ? 'from-user' : ''}`} key={message.id}>
        <div className="message-label">
          <span>{message.source.startsWith('tool_') ? message.contentToolName || '工具' : message.role === 'user' ? '你' : message.source === 'assistant_think' ? '思考摘要' : 'AI'}</span>
          <time>{new Date(message.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time>
        </div>
        {message.contentText && <pre>{message.contentText}</pre>}
        {message.contentThinking && <details><summary>查看可见思考摘要</summary><pre>{message.contentThinking}</pre></details>}
        {message.contentToolInput && <pre className="tool-block">{message.contentToolInput}</pre>}
        {message.contentToolOutput && <pre className="tool-block">{message.contentToolOutput}</pre>}
      </article>)}</div>
    </aside>
  </div>;
}

function AgentResultCard({ result }: { result: AgentResult }) {
  return <article className="agent-result">
    <header><div><span className="result-kind">{result.kind === 'summary' ? 'SUMMARY' : 'EXPLORE'}</span><h3>{result.sessionTitle}</h3></div><time>{new Date(result.createdAt).toLocaleString('zh-CN')}</time></header>
    {result.question && <p className="result-question">问题：{result.question}</p>}
    <pre>{result.content}</pre>
    <footer>{result.modelId}</footer>
  </article>;
}

function SettingToggle({
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
  return <label className={`setting-toggle-row${disabled ? ' disabled' : ''}`}>
    <span><strong>{title}</strong><small>{description}</small></span>
    <input type="checkbox" checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)} />
    <i aria-hidden="true" />
  </label>;
}

export function App() {
  const [page, setPage] = useState<Page>('overview');
  const [overview, setOverview] = useState(EMPTY);
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [query, setQuery] = useState('');
  const [notice, setNotice] = useState('');
  const [selectedSessionId, setSelectedSessionId] = useState('');
  const [agentKind, setAgentKind] = useState<AgentKind>('summary');
  const [exploreQuestion, setExploreQuestion] = useState('');
  const [agentBusy, setAgentBusy] = useState(false);
  const [agentError, setAgentError] = useState('');
  const [results, setResults] = useState<AgentResult[]>([]);
  const [settings, setSettings] = useState<AppSettingsView | null>(null);
  const [draft, setDraft] = useState<SettingsDraft | null>(null);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [settingsMessage, setSettingsMessage] = useState('');

  const refresh = useCallback(async () => {
    setOverview(await window.vesti.getOverview());
    setLoading(false);
  }, []);

  const loadSettings = useCallback(async () => {
    const value = await window.vesti.getSettings();
    setSettings(value);
    setDraft(toDraft(value));
  }, []);

  useEffect(() => {
    void refresh();
    void window.vesti.getAgentResults().then(setResults);
    void loadSettings();
    return window.vesti.onCaptureChanged(() => void refresh());
  }, [loadSettings, refresh]);

  useEffect(() => {
    if (!selectedSessionId && overview.sessions[0]) setSelectedSessionId(overview.sessions[0].id);
  }, [overview.sessions, selectedSessionId]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return overview.sessions;
    return overview.sessions.filter(session => [session.title, session.projectPath, session.model, session.platform]
      .filter(Boolean).some(value => value!.toLowerCase().includes(needle)));
  }, [overview.sessions, query]);

  async function syncNow() {
    setNotice('正在扫描本地数据源…');
    const result = await window.vesti.sync();
    setNotice(result.errors.length
      ? `同步完成，${result.errors.length} 个数据源需要检查`
      : `同步完成：更新 ${result.sessions} 个会话，新增 ${result.messages} 条消息`);
    await refresh();
  }

  async function runAgent() {
    if (!selectedSessionId) return;
    setAgentBusy(true);
    setAgentError('');
    try {
      const result = await window.vesti.runAgent({
        kind: agentKind,
        sessionId: selectedSessionId,
        question: agentKind === 'explore' ? exploreQuestion : undefined,
      });
      setResults(current => [result, ...current.filter(item => item.id !== result.id)]);
    } catch (error) {
      setAgentError(errorMessage(error));
    } finally {
      setAgentBusy(false);
    }
  }

  async function chooseDirectory() {
    const directory = await window.vesti.chooseDataDirectory();
    if (directory) setDraft(current => current ? { ...current, dataDirectory: directory } : current);
  }

  async function saveSettings(testAfterSave = false) {
    if (!draft) return;
    setSettingsBusy(true);
    setSettingsMessage('');
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
      setSettingsMessage(result.restartRequired ? '设置已保存。数据目录将在重启后切换。' : '设置已保存。');
      if (testAfterSave) {
        const tested = await window.vesti.testLlm();
        setSettingsMessage(tested.message);
      }
    } catch (error) {
      setSettingsMessage(errorMessage(error));
    } finally {
      setSettingsBusy(false);
    }
  }

  async function clearAgentResults() {
    if (!window.confirm('确定删除全部 Summary / Explore 历史结果吗？已捕获的原始会话不会被删除。')) return;
    setSettingsMessage('');
    try {
      await window.vesti.clearAgentResults();
      setResults([]);
      setSettingsMessage('Agent 历史结果已清空。');
    } catch (error) {
      setSettingsMessage(errorMessage(error));
    }
  }

  function togglePlatform(platform: SourceStatus['platform']) {
    setDraft(current => {
      if (!current) return current;
      const enabled = current.capture.enabledPlatforms.includes(platform);
      return {
        ...current,
        capture: {
          ...current.capture,
          enabledPlatforms: enabled
            ? current.capture.enabledPlatforms.filter(item => item !== platform)
            : [...current.capture.enabledPlatforms, platform],
        },
      };
    });
  }

  function setLlmMode(mode: 'demo_proxy' | 'custom_byok') {
    setDraft(current => current ? {
      ...current,
      llm: {
        ...current.llm,
        mode,
        baseUrl: mode === 'demo_proxy'
          ? 'https://vesti-gate.vercel.app/api'
          : current.llm.baseUrl.includes('vesti-gate.vercel.app')
            ? 'https://dashscope.aliyuncs.com/compatible-mode/v1'
            : current.llm.baseUrl,
      },
    } : current);
  }

  const titles: Record<Page, string> = { overview: '晚上好', library: '会话库', insights: '洞察', settings: '设置' };
  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><span className="owl">◉</span><strong>Vesti</strong><small>心迹</small></div>
      <nav>{([
        ['overview', '⌂', '总览'], ['library', '≡', '会话库'], ['insights', '✦', '洞察'], ['settings', '⚙', '设置'],
      ] as Array<[Page, string, string]>).map(([id, icon, label]) => <button className={page === id ? 'active' : ''} onClick={() => setPage(id)} key={id}><span>{icon}</span>{label}</button>)}</nav>
      <div className="capture-state">
        <span className={overview.watching ? 'pulse' : 'pulse off'} />
        <div><strong>{overview.watching ? '实时采集中' : '采集已暂停'}</strong><small>仅访问本地会话文件</small></div>
        <button className={overview.watching ? 'toggle on' : 'toggle'} onClick={() => void window.vesti.setWatching(!overview.watching).then(refresh)}><span /></button>
      </div>
    </aside>

    <main>
      <header className="topbar">
        <div><span className="eyebrow">LOCAL-FIRST MEMORY</span><h1>{titles[page]}</h1></div>
        <button className="primary-button" disabled={overview.syncing} onClick={() => void syncNow()}>{overview.syncing ? '采集中…' : '立即同步'}</button>
      </header>
      {notice && <button className="notice" onClick={() => setNotice('')}>{notice}<span>×</span></button>}

      {(page === 'overview' || page === 'library') && <div className="content">
        {page === 'overview' && <>
          <section className="metric-grid">
            <article><span>已归档会话</span><strong>{compact(overview.totals.conversations)}</strong><small>跨平台统一归档</small></article>
            <article><span>消息总量</span><strong>{compact(overview.totals.messages)}</strong><small>含对话与工具事件</small></article>
            <article><span>Token 轨迹</span><strong>{compact(overview.totals.inputTokens + overview.totals.outputTokens)}</strong><small>以数据源可提供为准</small></article>
            <article><span>本地占用</span><strong>{bytes(overview.totals.storageSize)}</strong><small>Vesti 标准化数据库</small></article>
          </section>
          <section className="section-block"><div className="section-title"><div><span className="eyebrow">CAPTURE SOURCES</span><h2>数据源</h2></div></div><div className="source-grid">{overview.sources.map(source => <SourceCard source={source} key={source.platform} />)}</div></section>
        </>}
        <section className="section-block library-block">
          <div className="section-title"><div><span className="eyebrow">CONVERSATION MEMORY</span><h2>{page === 'library' ? '全部会话' : '最近捕获'}</h2></div><input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索标题、项目或模型" /></div>
          <div className="session-list">{loading ? <div className="empty">正在读取本地记忆…</div> : filtered.length === 0 ? <div className="empty">还没有匹配的会话</div> : filtered.slice(0, page === 'overview' ? 8 : 200).map(session => <SessionRow key={session.id} session={session} onOpen={() => void window.vesti.getSession(session.id).then(setDetail)} />)}</div>
        </section>
      </div>}

      {page === 'insights' && <div className="content agent-page">
        <section className="agent-composer">
          <div className="section-title"><div><span className="eyebrow">CONVERSATION AGENT</span><h2>从已有会话生成洞察</h2></div></div>
          <label className="field"><span>选择会话</span><select value={selectedSessionId} onChange={event => setSelectedSessionId(event.target.value)}>
            {overview.sessions.length === 0 && <option value="">还没有已捕获的会话</option>}
            {overview.sessions.map(session => <option value={session.id} key={session.id}>{session.title} · {session.platform}</option>)}
          </select></label>
          <div className="agent-modes">
            <button className={agentKind === 'summary' ? 'selected' : ''} onClick={() => setAgentKind('summary')}><strong>Summary</strong><span>提炼主题、结论和下一步</span></button>
            <button className={agentKind === 'explore' ? 'selected' : ''} onClick={() => setAgentKind('explore')}><strong>Explore</strong><span>围绕问题继续分析会话</span></button>
          </div>
          {agentKind === 'explore' && <label className="field"><span>你想探索什么？</span><textarea value={exploreQuestion} onChange={event => setExploreQuestion(event.target.value)} placeholder="例如：这次实现还存在哪些技术风险？留空则自动寻找值得继续探索的方向。" /></label>}
          <p className="privacy-note">运行后，所选会话内容会发送给“设置”中配置的模型服务；分析结果会保存到当前 Vesti 数据目录。</p>
          {agentError && <p className="form-message error">{agentError}</p>}
          <button className="primary-button agent-run" disabled={!selectedSessionId || agentBusy} onClick={() => void runAgent()}>{agentBusy ? '分析中…' : `运行 ${agentKind === 'summary' ? 'Summary' : 'Explore'}`}</button>
        </section>
        <section className="result-list"><div className="section-title"><div><span className="eyebrow">LOCAL RESULTS</span><h2>历史结果</h2></div></div>{results.length ? results.map(result => <AgentResultCard result={result} key={result.id} />) : <div className="empty result-empty">还没有 Agent 结果</div>}</section>
      </div>}

      {page === 'settings' && <div className="content settings-page">
        {!draft || !settings ? <div className="empty">正在读取设置…</div> : <>
          <section className="settings-card">
            <div className="section-title"><div><span className="eyebrow">GENERAL</span><h2>应用行为</h2></div></div>
            <p className="setting-description">控制 Vesti 如何随 Windows 启动，以及关闭窗口后的后台行为。</p>
            <div className="settings-list">
              <SettingToggle checked={draft.general.launchAtLogin} title="开机时启动 Vesti" description="登录 Windows 后自动启动采集服务。" onChange={checked => setDraft({ ...draft, general: { ...draft.general, launchAtLogin: checked } })} />
              <SettingToggle checked={draft.general.startMinimized} disabled={!draft.general.launchAtLogin} title="开机启动时隐藏窗口" description="只显示托盘图标，不主动打断当前工作。" onChange={checked => setDraft({ ...draft, general: { ...draft.general, startMinimized: checked } })} />
              <SettingToggle checked={draft.general.closeToTray} title="关闭窗口时留在托盘" description="点击窗口关闭按钮后继续在后台捕获；可从托盘菜单彻底退出。" onChange={checked => setDraft({ ...draft, general: { ...draft.general, closeToTray: checked } })} />
            </div>
          </section>

          <section className="settings-card">
            <div className="section-title"><div><span className="eyebrow">CAPTURE</span><h2>采集引擎</h2></div></div>
            <p className="setting-description">只读取已启用工具保存在本机的会话文件。停用来源不会删除已经归档的数据。</p>
            <SettingToggle checked={draft.capture.watchOnStartup} title="启动后自动实时采集" description="监听新建和更新的会话文件；仍可在左下角临时暂停。" onChange={checked => setDraft({ ...draft, capture: { ...draft.capture, watchOnStartup: checked } })} />
            <div className="source-control-grid">
              {overview.sources.map(source => {
                const enabled = draft.capture.enabledPlatforms.includes(source.platform);
                return <button type="button" className={enabled ? 'source-control enabled' : 'source-control'} onClick={() => togglePlatform(source.platform)} key={source.platform}>
                  <span className="source-mark" style={{ background: tones[source.platform] }}>{source.label[0]}</span>
                  <span><strong>{source.label}</strong><small>{source.installed ? `检测到 · ${source.sessionCount} 个会话` : '本机暂未检测到'}</small></span>
                  <i>{enabled ? '已启用' : '已停用'}</i>
                </button>;
              })}
            </div>
          </section>

          <section className="settings-card">
            <div className="section-title"><div><span className="eyebrow">DATA & PRIVACY</span><h2>内容数据与隐私</h2></div></div>
            <p className="setting-description">会话数据库、标准化文本和 Agent 结果保存在这里。程序安装目录与内容数据目录相互独立。</p>
            <label className="field"><span>数据目录</span><div className="directory-row"><input value={draft.dataDirectory} readOnly /><button className="secondary-button" onClick={() => void chooseDirectory()}>选择文件夹</button></div></label>
            <p className="path-status">当前正在使用：{settings.activeDataDirectory}</p>
            {(settings.restartRequired || draft.dataDirectory !== settings.activeDataDirectory) && <div className="restart-banner"><span>更改数据目录后需要重启 App 才会生效。Vesti 不会自动搬移旧目录中的数据。</span>{settings.restartRequired && <button onClick={() => void window.vesti.restartApp()}>立即重启</button>}</div>}
            <div className="inline-actions"><button className="secondary-button" onClick={() => void window.vesti.openDataDirectory()}>打开当前数据目录</button><button className="danger-button" onClick={() => void clearAgentResults()}>清空 Agent 历史结果</button></div>
            <p className="privacy-note">清空 Agent 结果不会删除原始会话、SQLite 数据库或来源工具中的任何文件。</p>
          </section>

          <section className="settings-card">
            <div className="section-title"><div><span className="eyebrow">LLM ACCESS</span><h2>模型服务</h2></div></div>
            <p className="setting-description">配置方式与浏览器插件一致：可使用 Vesti Demo Proxy，或连接 OpenAI 兼容接口并使用自己的 API Key。</p>
            <div className="mode-picker">
              <button className={draft.llm.mode === 'demo_proxy' ? 'selected' : ''} onClick={() => setLlmMode('demo_proxy')}><strong>Demo Proxy</strong><span>用于快速体验，默认 qwen-plus</span></button>
              <button className={draft.llm.mode === 'custom_byok' ? 'selected' : ''} onClick={() => setLlmMode('custom_byok')}><strong>自定义 / BYOK</strong><span>OpenAI 兼容 API</span></button>
            </div>
            <div className="form-grid">
              <label className="field wide"><span>Base URL</span><input value={draft.llm.baseUrl} readOnly={draft.llm.mode === 'demo_proxy'} onChange={event => setDraft({ ...draft, llm: { ...draft.llm, baseUrl: event.target.value } })} /></label>
              <label className="field"><span>模型</span><input value={draft.llm.modelId} onChange={event => setDraft({ ...draft, llm: { ...draft.llm, modelId: event.target.value } })} /></label>
              <label className="field"><span>Temperature</span><input type="number" min="0" max="2" step="0.1" value={draft.llm.temperature} onChange={event => setDraft({ ...draft, llm: { ...draft.llm, temperature: Number(event.target.value) } })} /></label>
              <label className="field"><span>最大输出 Token</span><input type="number" min="128" max="16384" step="128" value={draft.llm.maxTokens} onChange={event => setDraft({ ...draft, llm: { ...draft.llm, maxTokens: Number(event.target.value) } })} /></label>
              {draft.llm.mode === 'custom_byok' && <label className="field wide"><span>API Key {draft.apiKeyConfigured && '（已安全保存，留空则不修改）'}</span><input type="password" autoComplete="off" value={draft.llm.apiKey} placeholder={draft.apiKeyConfigured ? '••••••••••••' : 'sk-…'} onChange={event => setDraft({ ...draft, llm: { ...draft.llm, apiKey: event.target.value } })} /></label>}
            </div>
            {draft.llm.mode === 'custom_byok' && draft.apiKeyConfigured && <label className="check-field"><input type="checkbox" checked={Boolean(draft.llm.clearApiKey)} onChange={event => setDraft({ ...draft, llm: { ...draft.llm, clearApiKey: event.target.checked } })} />删除已保存的 API Key</label>}
            <p className="privacy-note">API Key 由操作系统安全存储加密，前端页面不会读取已保存的明文。</p>
          </section>

          <section className="settings-card">
            <div className="section-title"><div><span className="eyebrow">AGENT</span><h2>洞察偏好</h2></div></div>
            <p className="setting-description">决定 Summary / Explore 发送哪些内容，以及结果使用的默认语言。</p>
            <div className="form-grid">
              <label className="field"><span>输出语言</span><select value={draft.agent.outputLanguage} onChange={event => setDraft({ ...draft, agent: { ...draft.agent, outputLanguage: event.target.value as 'zh-CN' | 'en-US' } })}><option value="zh-CN">简体中文</option><option value="en-US">English</option></select></label>
              <div />
              <label className="field wide"><span>自定义分析偏好（可选）</span><textarea maxLength={4000} value={draft.agent.customInstructions} onChange={event => setDraft({ ...draft, agent: { ...draft.agent, customInstructions: event.target.value } })} placeholder="例如：优先提取产品决策和技术风险；所有下一步都给出负责人和验收标准。" /></label>
            </div>
            <div className="settings-list compact-list">
              <SettingToggle checked={draft.agent.includeThinking} title="包含可见思考摘要" description="如果来源提供思考摘要，将其一并交给分析模型。" onChange={checked => setDraft({ ...draft, agent: { ...draft.agent, includeThinking: checked } })} />
              <SettingToggle checked={draft.agent.includeToolDetails} title="包含工具调用详情" description="发送工具名称、输入、输出与错误，以获得更完整的技术分析。" onChange={checked => setDraft({ ...draft, agent: { ...draft.agent, includeToolDetails: checked } })} />
            </div>
          </section>

          <section className="settings-card">
            <div className="section-title"><div><span className="eyebrow">NETWORK</span><h2>网络与代理</h2></div></div>
            <p className="setting-description">模型请求默认跟随 Windows 系统代理。修改后立即应用，无需重启。</p>
            <div className="mode-picker three">
              <button type="button" className={draft.network.proxyMode === 'system' ? 'selected' : ''} onClick={() => setDraft({ ...draft, network: { ...draft.network, proxyMode: 'system' } })}><strong>跟随系统</strong><span>推荐；使用 Windows / VPN 代理</span></button>
              <button type="button" className={draft.network.proxyMode === 'direct' ? 'selected' : ''} onClick={() => setDraft({ ...draft, network: { ...draft.network, proxyMode: 'direct' } })}><strong>直接连接</strong><span>忽略系统代理</span></button>
              <button type="button" className={draft.network.proxyMode === 'custom' ? 'selected' : ''} onClick={() => setDraft({ ...draft, network: { ...draft.network, proxyMode: 'custom' } })}><strong>自定义代理</strong><span>HTTP / HTTPS / SOCKS</span></button>
            </div>
            {draft.network.proxyMode === 'custom' && <label className="field"><span>代理地址</span><input value={draft.network.proxyUrl} onChange={event => setDraft({ ...draft, network: { ...draft.network, proxyUrl: event.target.value } })} placeholder="http://127.0.0.1:7890" /></label>}
          </section>

          <section className="settings-card about-card">
            <div className="section-title"><div><span className="eyebrow">ABOUT</span><h2>关于 Vesti</h2></div><span className="version-badge">v{settings.appVersion}</span></div>
            <p className="setting-description">本地优先的 AI 会话采集、归档与洞察工具。当前支持 Codex、Cursor 和 Kimi Code。</p>
            <dl className="about-list"><div><dt>设置目录</dt><dd>{settings.settingsDirectory}</dd></div><div><dt>内容目录</dt><dd>{settings.activeDataDirectory}</dd></div></dl>
            <div className="inline-actions"><button className="secondary-button" onClick={() => void window.vesti.openSettingsDirectory()}>打开设置目录</button><button className="secondary-button" onClick={() => void window.vesti.restartApp()}>重启 Vesti</button></div>
          </section>
          {settingsMessage && <p className="form-message">{settingsMessage}</p>}
          <div className="settings-actions"><button className="secondary-button" disabled={settingsBusy} onClick={() => void saveSettings(true)}>保存并测试模型</button><button className="primary-button" disabled={settingsBusy} onClick={() => void saveSettings()}>{settingsBusy ? '保存中…' : '保存设置'}</button></div>
        </>}
      </div>}
    </main>
    {detail && <DetailPanel detail={detail} onClose={() => setDetail(null)} />}
  </div>;
}
