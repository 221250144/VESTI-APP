import { net, session } from 'electron';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type {
  AgentResult,
  AgentRunRequest,
  LlmTestResult,
  SessionDetail,
  SessionMessage,
} from '../shared/contracts';
import { getAgentKindDefinition } from './agentPrompts';
import type { CaptureService } from './captureService';
import type { RuntimeAgentSettings, RuntimeLlmSettings, SettingsService } from './settingsService';

const MAX_TRANSCRIPT_CHARACTERS = 80_000;

export class AgentService {
  constructor(
    private readonly capture: CaptureService,
    private readonly settings: SettingsService,
  ) {}

  async run(request: AgentRunRequest, options?: { persist?: boolean }): Promise<AgentResult> {
    const detail = this.capture.getSession(request.sessionId);
    // Batch kinds (classify) run over renderer-side Dexie conversations whose
    // ids don't exist in the capture store; a pre-built transcript makes the
    // session lookup unnecessary.
    if (!detail && !request.transcriptOverride?.trim()) throw new Error('找不到所选会话，请先重新同步');
    const preferences = this.settings.getRuntimeAgent();
    // Callers may supply a pre-built transcript (digest pipeline, cross-session
    // recall); otherwise it is derived from the session messages as usual.
    const transcript = request.transcriptOverride ?? this.buildTranscript(detail!, preferences);
    if (!transcript.trim()) throw new Error('该会话没有可用于分析的文本内容');

    const llm = this.settings.getRuntimeLlm();
    const question = request.question?.trim();
    const definition = getAgentKindDefinition(request.kind);
    const raw = await this.complete(llm, definition.buildPrompt({ transcript, question, template: request.template, preferences }));
    const content = definition.parse ? definition.parse(raw) : raw;
    const result: AgentResult = {
      id: randomUUID(),
      kind: request.kind,
      sessionId: detail?.session.id ?? request.sessionId,
      sessionTitle: detail?.session.title ?? '',
      question: request.kind === 'explore' ? question : undefined,
      content,
      modelId: llm.modelId,
      createdAt: Date.now(),
    };
    if (options?.persist !== false) await this.prependResult(result);
    return result;
  }

  async test(): Promise<LlmTestResult> {
    try {
      const llm = this.settings.getRuntimeLlm();
      await this.complete(llm, [
        { role: 'system', content: 'You are a connection test. Answer with only OK.' },
        { role: 'user', content: 'ping' },
      ]);
      return { ok: true, message: `连接成功：${llm.modelId}` };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '连接失败' };
    }
  }

  async listResults(): Promise<AgentResult[]> {
    try {
      const raw = JSON.parse(await fs.readFile(this.resultsPath, 'utf8')) as unknown;
      return Array.isArray(raw) ? raw.slice(0, 100) as AgentResult[] : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  async clearResults(): Promise<void> {
    await fs.rm(this.resultsPath, { force: true });
  }

  private get resultsPath(): string {
    return path.join(this.capture.activeDataDirectory, 'agent-results', 'results.json');
  }

  private buildTranscript(detail: SessionDetail, preferences: RuntimeAgentSettings): string {
    const parts = detail.messages
      .map((message, index) => this.formatMessage(message, index + 1, preferences))
      .filter(Boolean);
    const transcript = parts.join('\n\n');
    if (transcript.length <= MAX_TRANSCRIPT_CHARACTERS) return transcript;
    return `${transcript.slice(0, 30_000)}\n\n[中间内容因长度限制已省略]\n\n${transcript.slice(-50_000)}`;
  }

  private formatMessage(message: SessionMessage, turn: number, preferences: RuntimeAgentSettings): string {
    const values = [
      message.contentText,
      preferences.includeThinking ? message.contentThinking : undefined,
      preferences.includeToolDetails && message.contentToolName ? `工具：${message.contentToolName}` : undefined,
      preferences.includeToolDetails && message.contentToolInput ? `工具输入：${message.contentToolInput}` : undefined,
      preferences.includeToolDetails && message.contentToolOutput ? `工具输出：${message.contentToolOutput}` : undefined,
      preferences.includeToolDetails && message.contentToolError ? `工具错误：${message.contentToolError}` : undefined,
    ].filter((value): value is string => Boolean(value?.trim()));
    if (!values.length) return '';
    const role = message.role === 'user' ? '用户' : message.role === 'assistant' ? 'AI' : '系统';
    return `[${turn}] ${role} / ${message.source}\n${values.join('\n')}`;
  }

  private async complete(
    settings: RuntimeLlmSettings,
    messages: Array<{ role: string; content: string }>,
  ): Promise<string> {
    if (settings.mode === 'custom_byok' && !settings.apiKey) {
      throw new Error('请先在设置中填写 API Key');
    }
    const endpoint = settings.mode === 'demo_proxy'
      ? `${settings.baseUrl}/chat`
      : `${settings.baseUrl}/chat/completions`;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (settings.mode === 'demo_proxy') headers['x-vesti-service-token'] = settings.serviceToken;
    else headers.authorization = `Bearer ${settings.apiKey}`;

    let response: Response;
    try {
      response = await net.fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: settings.modelId,
          messages,
          temperature: settings.temperature,
          max_tokens: settings.maxTokens,
          stream: false,
        }),
        signal: AbortSignal.timeout(90_000),
      });
    } catch (error) {
      throw await this.networkError(error, endpoint);
    }
    const payload = await response.json().catch(() => ({})) as {
      choices?: Array<{ message?: { content?: unknown } }>;
      error?: { message?: string } | string;
      message?: string;
    };
    if (!response.ok) {
      const detail = typeof payload.error === 'string' ? payload.error : payload.error?.message || payload.message;
      throw new Error(detail || `模型请求失败（HTTP ${response.status}）`);
    }
    const value = payload.choices?.[0]?.message?.content;
    const content = typeof value === 'string'
      ? value
      : Array.isArray(value)
        ? value.map(part => typeof part === 'string' ? part : '').join('')
        : '';
    const cleaned = content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    if (!cleaned) throw new Error('模型没有返回可显示的内容');
    return cleaned;
  }

  private async networkError(error: unknown, endpoint: string): Promise<Error> {
    const details: string[] = [];
    let current: unknown = error;
    for (let depth = 0; depth < 4 && current; depth += 1) {
      if (current instanceof Error && current.message) details.push(current.message);
      if (typeof current === 'object' && current && 'code' in current) {
        const code = (current as { code?: unknown }).code;
        if (typeof code === 'string') details.push(code);
      }
      current = typeof current === 'object' && current && 'cause' in current
        ? (current as { cause?: unknown }).cause
        : undefined;
    }

    const proxy = await session.defaultSession.resolveProxy(endpoint).catch(() => 'unknown');
    const reason = [...new Set(details)].join(' · ') || '未知网络错误';
    const message = proxy === 'DIRECT'
      ? `无法连接模型服务：${reason}。当前为直连网络，请检查防火墙、VPN 或在系统中配置可用代理。`
      : `无法通过系统网络连接模型服务：${reason}。当前代理路径：${proxy}。请检查代理是否正在运行。`;
    return new Error(message, { cause: error });
  }

  private async prependResult(result: AgentResult): Promise<void> {
    const current = await this.listResults();
    const directory = path.dirname(this.resultsPath);
    await fs.mkdir(directory, { recursive: true });
    const temporary = `${this.resultsPath}.tmp`;
    await fs.writeFile(temporary, JSON.stringify([result, ...current].slice(0, 100), null, 2), 'utf8');
    await fs.rm(this.resultsPath, { force: true });
    await fs.rename(temporary, this.resultsPath);
  }
}
