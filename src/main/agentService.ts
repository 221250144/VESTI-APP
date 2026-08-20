import { net, session } from 'electron';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  projectSessionTurnsToVesti,
  type SessionMessage as CaptureSessionMessage,
} from '@vesti/capture-core';
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
import { chatStreamEndpoint, createSseDataCollector, parseChatStreamData } from './chatStream';
import type { RuntimeAgentSettings, RuntimeLlmSettings, SettingsService } from './settingsService';
import { fetchDemoProxy, type ProxyAttemptMetadata } from './proxyFetch';

const MAX_TRANSCRIPT_CHARACTERS = 80_000;

export function buildProjectedSessionTranscript(
  detail: SessionDetail,
  preferences: RuntimeAgentSettings,
): string {
  const projection = projectSessionTurnsToVesti(
    detail.messages as CaptureSessionMessage[],
    0,
    detail.session.platform,
  );
  const rawByTurn = new Map<string, SessionMessage[]>();
  for (const message of detail.messages) {
    if (!message.turnId) continue;
    const group = rawByTurn.get(message.turnId) ?? [];
    group.push(message);
    rawByTurn.set(message.turnId, group);
  }

  const projectedResponseTurnIds = new Set(
    projection.messages.flatMap(message => (
      message.role === 'ai' && message._turn_id ? [message._turn_id] : []
    )),
  );
  const toolLinesForTurn = (turnId: string | undefined): string[] => {
    if (!preferences.includeToolDetails || !turnId) return [];
    const lines = (rawByTurn.get(turnId) ?? []).flatMap(raw => [
      raw.contentToolName ? `工具：${raw.contentToolName}` : undefined,
      raw.contentToolInput ? `工具输入：${raw.contentToolInput}` : undefined,
      raw.contentToolOutput ? `工具输出：${raw.contentToolOutput}` : undefined,
      raw.contentToolError ? `工具错误：${raw.contentToolError}` : undefined,
    ].filter((value): value is string => Boolean(value?.trim())));
    return [...new Set(lines)];
  };

  return projection.messages.flatMap(message => {
    const turn = message._turn_sequence ?? 0;
    const values: string[] = [];
    if (message.content_text.trim()) values.push(message.content_text.trim());
    if (message.role === 'user') {
      (message._followups ?? []).forEach((followup, index) => {
        values.push(`跟进 ${index + 1}：${followup.content_text}`);
      });
    } else {
      if (preferences.includeThinking && message._progress_segments?.length) {
        values.push(`[进度]\n${message._progress_segments.map(item => item.content_text).join('\n\n')}`);
      }
      if (preferences.includeThinking && message._thinking_segments?.length) {
        values.push(`[思考]\n${message._thinking_segments.map(item => item.content_text).join('\n\n')}`);
      }
      if (message._turn_id) {
        const toolLines = toolLinesForTurn(message._turn_id);
        if (toolLines.length) values.push(`[工具]\n${toolLines.join('\n')}`);
      }
    }
    if (!values.length) return [];
    const output = [`[轮次 ${turn}] ${message.role === 'user' ? '用户' : 'AI'}\n${values.join('\n\n')}`];
    if (
      message.role === 'user'
      && message._turn_id
      && !projectedResponseTurnIds.has(message._turn_id)
    ) {
      const toolLines = toolLinesForTurn(message._turn_id);
      if (toolLines.length) {
        output.push(`[轮次 ${turn}] AI\n[工具]\n${toolLines.join('\n')}`);
      }
    }
    return output;
  }).join('\n\n');
}
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
  // 夜话 / 圆桌 / 提示词优化: reasoning models (deepseek-v4-flash) spend
  // completion tokens on the thinking trace first — a small user cap (the
  // legacy 128/1600 defaults) is eaten entirely by reasoning and the visible
  // answer comes back EMPTY, surfacing as the misleading "misconfigured
  // service" banner. These floors keep a real answer possible.
  companion: 2048,
  'roundtable-turn': 2048,
  'prompt-improve': 2048,
  'prompt-continue': 2048,
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

export interface AgentUsageTokens {
  promptTokens: number;
  completionTokens: number;
}

/**
 * Credit-metering hook wired by main: demo-gateway calls are pre-checked and
 * accounted against the local credit ledger; BYOK mode meters nothing (the
 * adapter no-ops), so agent code stays mode-agnostic.
 */
export interface AgentCreditMeter {
  /** Pre-flight check before a chat call; throws (CREDITS_EXHAUSTED) when out. */
  beforeChat(estimatedChars: number, label: string): void;
  /** Post-success accounting; usage is null when the gateway didn't report it. */
  afterChat(usage: AgentUsageTokens | null, estimatedChars: number, label: string): void;
}

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
    private readonly credits?: AgentCreditMeter,
  ) {}

  async run(request: AgentRunRequest, options?: { persist?: boolean }): Promise<AgentResult> {
    const prepared = this.prepareRun(request);
    const completion = await this.complete(prepared.llm, prepared.messages, request.kind);
    return this.finalizeRun(request, prepared, completion, options);
  }

  /**
   * Streaming variant of run(): answer/thinking deltas are pushed through
   * `emit` as they arrive while the method resolves with the same final
   * AgentResult run() would produce. A transport failure before the first
   * visible chunk degrades transparently to the non-streaming call; once the
   * user has seen partial output there is no clean retry, so later failures
   * propagate.
   */
  async runStream(
    request: AgentRunRequest,
    emit: (chunk: { delta?: string; reasoning?: string; done?: boolean }) => void,
    options?: { persist?: boolean },
  ): Promise<AgentResult> {
    const prepared = this.prepareRun(request);
    let sawDelta = false;
    let completion: { content: string; modelUsed: string };
    try {
      completion = await this.completeStream(
        prepared.llm,
        prepared.messages,
        request.kind,
        (content, reasoning) => {
          sawDelta = true;
          emit({ delta: content || undefined, reasoning: reasoning || undefined });
        },
      );
    } catch (error) {
      if (sawDelta) throw error;
      completion = await this.complete(prepared.llm, prepared.messages, request.kind);
    }
    emit({ done: true });
    return this.finalizeRun(request, prepared, completion, options);
  }

  private prepareRun(request: AgentRunRequest): {
    detail: SessionDetail | null;
    llm: RuntimeLlmSettings;
    definition: ReturnType<typeof getAgentKindDefinition>;
    messages: Array<{ role: string; content: string }>;
    question: string | undefined;
  } {
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
    const messages = definition.buildPrompt({ transcript, question, template: request.template, preferences });
    return { detail: detail ?? null, llm, definition, messages, question };
  }

  private async finalizeRun(
    request: AgentRunRequest,
    prepared: ReturnType<AgentService['prepareRun']>,
    completion: { content: string; modelUsed: string },
    options?: { persist?: boolean },
  ): Promise<AgentResult> {
    const { detail, definition, llm, question } = prepared;
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
      ], 'llm-test');
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
    let transcript = buildProjectedSessionTranscript(detail, preferences);
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

  private async complete(
    settings: RuntimeLlmSettings,
    messages: Array<{ role: string; content: string }>,
    label = 'chat',
  ): Promise<{ content: string; modelUsed: string }> {
    if (settings.mode === 'custom_byok' && !settings.apiKey) {
      throw new Error('请先在设置中填写 API Key');
    }
    const endpoint = settings.mode === 'demo_proxy'
      ? `${settings.baseUrl}/chat`
      : `${settings.baseUrl}/chat/completions`;
    const body = buildChatCompletionBody(settings, messages);
    // Credit pre-check (demo gateway only; the meter no-ops under BYOK).
    this.credits?.beforeChat(body.length, label);

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
      choices?: Array<{ message?: { content?: unknown }; finish_reason?: unknown }>;
      error?: { code?: string; message?: string; requestId?: string } | string;
      message?: string;
      model?: unknown;
      usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
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
    // A length-terminated completion with no visible answer means the token
    // cap was eaten by the reasoning trace — say so, so the user raises the
    // max-output setting instead of blaming the gateway/proxy.
    if (!cleaned && payload.choices?.[0]?.finish_reason === 'length') {
      throw new Error('模型输出达到 Token 上限，回答被截断为空。请在设置中把「最大输出 Token」调大或设为 0（不限）');
    }
    if (!cleaned) throw new Error('模型没有返回可显示的内容');
    const responseModel = typeof payload.model === 'string' ? payload.model.trim() : '';
    const modelUsed = response.headers.get('x-proxy-model-used')?.trim()
      || proxyMetadata?.modelUsed?.trim()
      || responseModel
      || settings.modelId;
    // Credit accounting after a successful answer; usage comes from the
    // gateway payload, otherwise the meter estimates from request size.
    const promptTokens = typeof payload.usage?.prompt_tokens === 'number' ? payload.usage.prompt_tokens : null;
    const completionTokens = typeof payload.usage?.completion_tokens === 'number' ? payload.usage.completion_tokens : null;
    this.credits?.afterChat(
      promptTokens !== null && completionTokens !== null ? { promptTokens, completionTokens } : null,
      body.length,
      label,
    );
    return { content: cleaned, modelUsed };
  }

  /**
   * Streaming chat completion over the OpenAI-compatible SSE surface. The demo
   * gateway's legacy `/chat` route forces stream:false, so demo mode goes to
   * the `/v1` endpoint (chatStreamEndpoint); BYOK uses its normal base. Token
   * usage rides the terminal chunk (stream_options.include_usage) — without it
   * the credit meter falls back to its estimate, exactly like complete().
   */
  private async completeStream(
    settings: RuntimeLlmSettings,
    messages: Array<{ role: string; content: string }>,
    label: string,
    onDelta: (content: string, reasoning: string) => void,
  ): Promise<{ content: string; modelUsed: string }> {
    if (settings.mode === 'custom_byok' && !settings.apiKey) {
      throw new Error('请先在设置中填写 API Key');
    }
    const endpoint = chatStreamEndpoint(settings.mode, settings.baseUrl);
    const body = buildChatCompletionBody(settings, messages, true);
    // Credit pre-check (demo gateway only; the meter no-ops under BYOK).
    this.credits?.beforeChat(body.length, label);

    let response: Response;
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (settings.mode === 'demo_proxy') {
        if (settings.serviceToken.trim()) {
          headers['x-vesti-service-token'] = settings.serviceToken.trim();
        }
      } else {
        headers.authorization = `Bearer ${settings.apiKey}`;
      }
      response = await net.fetch(endpoint, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(BYOK_CHAT_TIMEOUT_MS),
      });
    } catch (error) {
      throw await this.networkError(error, endpoint);
    }
    if (!response.ok) {
      const payload = await response.json().catch(() => ({})) as {
        error?: { code?: string; message?: string; requestId?: string } | string;
        message?: string;
      };
      const detail = typeof payload.error === 'string' ? payload.error : payload.error?.message || payload.message;
      const requestId = response.headers.get('x-request-id')
        || (typeof payload.error === 'object' ? payload.error?.requestId : undefined);
      const suffix = requestId ? `（请求 ID：${requestId}）` : '';
      throw new LlmGatewayError(
        `${detail || `模型请求失败（HTTP ${response.status}）`}${suffix}`,
        {
          status: response.status,
          code: typeof payload.error === 'object' ? payload.error?.code : undefined,
          requestId,
          providerUsed: response.headers.get('x-proxy-provider-used') || undefined,
          modelUsed: response.headers.get('x-proxy-model-used') || undefined,
        },
      );
    }
    if (!response.body) throw new Error('模型服务未返回流式响应体');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let content = '';
    let finishReason: string | null = null;
    let modelFromChunk: string | null = null;
    let usage: AgentUsageTokens | null = null;
    const feed = createSseDataCollector((data) => {
      const parsed = parseChatStreamData(data);
      if (!parsed || parsed.done) return;
      if (parsed.model) modelFromChunk = parsed.model;
      if (parsed.usage) usage = parsed.usage;
      if (parsed.finishReason) finishReason = parsed.finishReason;
      if (parsed.content || parsed.reasoning) {
        content += parsed.content;
        onDelta(parsed.content, parsed.reasoning);
      }
    });
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        feed(decoder.decode(value, { stream: true }));
      }
      feed(decoder.decode());
    } finally {
      reader.releaseLock();
    }

    const cleaned = content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    // A length-terminated stream with no visible answer means the token cap
    // was eaten by the reasoning trace — say so, so the user raises the
    // max-output setting instead of blaming the gateway/proxy.
    if (!cleaned && finishReason === 'length') {
      throw new Error('模型输出达到 Token 上限，回答被截断为空。请在设置中把「最大输出 Token」调大或设为 0（不限）');
    }
    if (!cleaned) throw new Error('模型没有返回可显示的内容');
    const modelUsed = response.headers.get('x-proxy-model-used')?.trim()
      || modelFromChunk
      || settings.modelId;
    this.credits?.afterChat(usage, body.length, label);
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
