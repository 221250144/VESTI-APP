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
import { buildChatCompletionBody } from './chatRequest';
import type { RuntimeAgentSettings, RuntimeLlmSettings, SettingsService } from './settingsService';
import { fetchDemoProxy, type ProxyAttemptMetadata } from './proxyFetch';

const MAX_TRANSCRIPT_CHARACTERS = 80_000;
/** Settings upper bound for max_tokens (mirrors settingsService's 0–16_384
 * range, where 0 means "don't send max_tokens"); per-kind floors below can
 * never push past it. */
const MAX_TOKENS_SETTINGS_CAP = 16_384;
/**
 * Per-kind output-token floors. Kinds that answer with a long structured
 * document are degraded when the user configured a small cap: the relay pack
 * either truncates mid-JSON (parse then throws) or the model guts sections to
 * fit. Only applies to an explicit positive user setting — with 0 (uncapped)
 * no max_tokens is sent at all, so there is nothing to protect against.
 */
const KIND_MIN_MAX_TOKENS: Record<string, number> = {
  // Relay V2 pack: goal + state + decisions + failed paths + verification +
  // verify-first checklist + an embedded paste-ready handoff prompt.
  relay: 4096,
  // Daily journal (P4c upgrade): the two-pass pipeline answers with either a
  // per-cluster structured brief (pass 1) or a full achievement-oriented
  // work-record document (pass 2); small caps truncate both.
  daily: 4096,
  // Learn route synthesis (V4): title + 2-4 sentence interpretation + next
  // steps as one JSON document per route; small caps risk mid-JSON truncation.
  'learn-synthesis': 2048,
};

function effectiveMaxTokens(kind: string, configured: number): number {
  // 0 = uncapped: the request carries no max_tokens; the model's own default
  // applies and per-kind floors are moot.
  if (configured <= 0) return 0;
  return Math.min(
    MAX_TOKENS_SETTINGS_CAP,
    Math.max(configured, KIND_MIN_MAX_TOKENS[kind] ?? 0)
  );
}
export const BYOK_CHAT_TIMEOUT_MS = 180_000;

export class LlmGatewayError extends Error {
  constructor(
    message: string,
    readonly details: {
      status: number;
      code?: string;
      requestId?: string;
      providerUsed?: string;
      modelUsed?: string;
      attempt?: number;
      fallbackReason?: string;
    },
  ) {
    super(message);
    this.name = 'LlmGatewayError';
  }
}

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
    // Per-kind output budget: kinds with a floor (relay) get their long
    // structured answer protected from the global default's truncation.
    llm.maxTokens = effectiveMaxTokens(request.kind, llm.maxTokens);
    llm.modelId = this.resolveModelId(llm, request.modelId);
    const question = request.question?.trim();
    const definition = getAgentKindDefinition(request.kind);
    const completion = await this.complete(
      llm,
      definition.buildPrompt({ transcript, question, template: request.template, preferences }),
    );
    const raw = completion.content;
    const content = definition.parse ? definition.parse(raw) : raw;
    const result: AgentResult = {
      id: randomUUID(),
      kind: request.kind,
      sessionId: detail?.session.id ?? request.sessionId,
      sessionTitle: detail?.session.title ?? '',
      question: request.kind === 'explore' ? question : undefined,
      content,
      modelId: completion.modelUsed,
      requestedModelId: llm.modelId,
      modelUsed: completion.modelUsed,
      createdAt: Date.now(),
    };
    if (options?.persist !== false) await this.prependResult(result);
    return result;
  }

  async test(): Promise<LlmTestResult> {
    try {
      const llm = this.settings.getRuntimeLlm();
      const completion = await this.complete(llm, [
        { role: 'system', content: 'You are a connection test. Answer with only OK.' },
        { role: 'user', content: 'ping' },
      ]);
      const modelLabel = completion.modelUsed === llm.modelId
        ? llm.modelId
        : `${llm.modelId} → ${completion.modelUsed}`;
      return { ok: true, message: `连接成功：${modelLabel}` };
    } catch (error) {
      // 网关诊断:把 fallback 原因/首败端点带出来,不然"主网关传输失败→旧网关
      // 兜底报错"这类链路问题在 UI 上完全不可见
      if (error instanceof LlmGatewayError) {
        const hints: string[] = [];
        if (error.details.fallbackReason) hints.push(`主网关重试原因：${error.details.fallbackReason}`);
        if (error.details.providerUsed) hints.push(`实际命中：${error.details.providerUsed}`);
        const suffix = hints.length > 0 ? `（${hints.join('，')}）` : '';
        return { ok: false, message: `${error.message}${suffix}` };
      }
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

  /** Per-request model override (capsule quick-ask picker).
   * The current proxy forwards model ids, so Demo and BYOK share the same
   * non-empty pass-through behaviour. The response model remains recorded
   * separately because an upstream provider can still route to another model.
   */
  private resolveModelId(llm: RuntimeLlmSettings, requested: string | undefined): string {
    const override = requested?.trim().slice(0, 100);
    return override || llm.modelId;
  }

  private buildTranscript(detail: SessionDetail, preferences: RuntimeAgentSettings): string {
    const parts = detail.messages
      .map((message, index) => this.formatMessage(message, index + 1, preferences))
      .filter(Boolean);
    let transcript = parts.join('\n\n');
    if (transcript.length > MAX_TRANSCRIPT_CHARACTERS) {
      transcript = `${transcript.slice(0, 30_000)}\n\n[中间内容因长度限制已省略]\n\n${transcript.slice(-50_000)}`;
    }
    // A1 progressive disclosure: the parent transcript alone loses whatever
    // was delegated to subagents. Append their digest briefs (never the raw
    // child transcripts — a bounded compact layer) so explore/summary agents
    // can see and reference delegated work.
    const subagentBlock = this.buildSubagentBlock(detail.session.id);
    return subagentBlock ? `${transcript}\n\n${subagentBlock}` : transcript;
  }

  private buildSubagentBlock(sessionId: string): string {
    const briefs = this.capture.getSubagentBriefs(sessionId).slice(0, 12);
    if (briefs.length === 0) return '';
    const lines = briefs.map(brief => {
      const role = brief.agentRole ? `[${brief.agentRole}] ` : '';
      const title = (brief.title || '(未命名子任务)').slice(0, 120);
      const oneLiner = brief.oneLiner ? `：${brief.oneLiner.slice(0, 200)}` : '';
      return `- ${role}${title}（${brief.messageCount} 条消息）${oneLiner}`;
    });
    return `[子代理工作摘要]\n本会话曾派生 ${briefs.length} 个子代理执行子任务：\n${lines.join('\n')}`;
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
  ): Promise<{ content: string; modelUsed: string }> {
    if (settings.mode === 'custom_byok' && !settings.apiKey) {
      throw new Error('请先在设置中填写 API Key');
    }
    const endpoint = settings.mode === 'demo_proxy'
      ? `${settings.baseUrl}/chat`
      : `${settings.baseUrl}/chat/completions`;
    const body = buildChatCompletionBody(settings, messages);

    let response: Response;
    let proxyMetadata: ProxyAttemptMetadata | undefined;
    try {
      if (settings.mode === 'demo_proxy') {
        const result = await fetchDemoProxy({
          primaryBaseUrl: settings.baseUrl,
          fallbackBaseUrl: settings.fallbackBaseUrl,
          route: 'chat',
          serviceToken: settings.serviceToken,
          body,
        }, (input, init) => net.fetch(input, init));
        response = result.response;
        proxyMetadata = result.metadata;
      } else {
        response = await net.fetch(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${settings.apiKey}`,
          },
          body,
          signal: AbortSignal.timeout(BYOK_CHAT_TIMEOUT_MS),
        });
      }
    } catch (error) {
      throw await this.networkError(error, endpoint);
    }
    const payload = await response.json().catch(() => ({})) as {
      choices?: Array<{ message?: { content?: unknown } }>;
      error?: { code?: string; message?: string; requestId?: string } | string;
      message?: string;
      model?: unknown;
    };
    if (!response.ok) {
      const detail = typeof payload.error === 'string' ? payload.error : payload.error?.message || payload.message;
      const requestId = response.headers.get('x-request-id')
        || (typeof payload.error === 'object' ? payload.error?.requestId : undefined)
        || proxyMetadata?.requestId;
      const suffix = requestId ? `（请求 ID：${requestId}）` : '';
      throw new LlmGatewayError(
        `${detail || `模型请求失败（HTTP ${response.status}）`}${suffix}`,
        {
          status: response.status,
          code: typeof payload.error === 'object' ? payload.error?.code : undefined,
          requestId,
          providerUsed: response.headers.get('x-proxy-provider-used') || proxyMetadata?.providerUsed,
          modelUsed: response.headers.get('x-proxy-model-used') || proxyMetadata?.modelUsed,
          attempt: proxyMetadata?.attempt,
          fallbackReason: response.headers.get('x-proxy-fallback-reason') || proxyMetadata?.fallbackReason,
        },
      );
    }
    const value = payload.choices?.[0]?.message?.content;
    const content = typeof value === 'string'
      ? value
      : Array.isArray(value)
        ? value.map(part => typeof part === 'string' ? part : '').join('')
        : '';
    const cleaned = content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    if (!cleaned) throw new Error('模型没有返回可显示的内容');
    const responseModel = typeof payload.model === 'string' ? payload.model.trim() : '';
    const modelUsed = response.headers.get('x-proxy-model-used')?.trim()
      || proxyMetadata?.modelUsed?.trim()
      || responseModel
      || settings.modelId;
    return { content: cleaned, modelUsed };
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
