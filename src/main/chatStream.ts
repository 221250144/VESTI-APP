// Streaming chat completions (夜话 live typing): pure SSE / chunk-parsing
// helpers, kept Electron-free so vitest covers them in the node environment.
// agentService.completeStream wires them to net.fetch; the legacy demo-gateway
// `/chat` route is forced non-stream, so streaming goes through the
// OpenAI-compatible `/v1/chat/completions` endpoint instead.

export interface ChatStreamDelta {
  /** Incremental answer text from choices[0].delta.content. */
  content: string;
  /** Incremental thinking trace from choices[0].delta.reasoning_content. */
  reasoning: string;
  /** Token usage when the final chunk reports it (include_usage). */
  usage: { promptTokens: number; completionTokens: number } | null;
  /** Upstream model id when the chunk carries one. */
  model: string | null;
  /** choices[0].finish_reason on the terminal content chunk ("stop"/"length"). */
  finishReason: string | null;
  /** True on the terminal `data: [DONE]` frame. */
  done: boolean;
}

/**
 * Parse one SSE `data:` payload. Returns null for malformed JSON or frames
 * without anything worth forwarding (keep-alives, role-only opening chunks
 * still surface as zero-delta frames so the caller can learn the model id).
 */
export function parseChatStreamData(data: string): ChatStreamDelta | null {
  const trimmed = data.trim();
  if (!trimmed) return null;
  if (trimmed === '[DONE]') {
    return { content: '', reasoning: '', usage: null, model: null, finishReason: null, done: true };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as {
    choices?: Array<{ delta?: { content?: unknown; reasoning_content?: unknown }; finish_reason?: unknown }>;
    usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
    model?: unknown;
  };
  const delta = record.choices?.[0]?.delta;
  const contentValue = delta?.content;
  const reasoningValue = delta?.reasoning_content;
  const finishValue = record.choices?.[0]?.finish_reason;
  const promptTokens = typeof record.usage?.prompt_tokens === 'number' ? record.usage.prompt_tokens : null;
  const completionTokens =
    typeof record.usage?.completion_tokens === 'number' ? record.usage.completion_tokens : null;
  return {
    content: typeof contentValue === 'string' ? contentValue : '',
    reasoning: typeof reasoningValue === 'string' ? reasoningValue : '',
    usage: promptTokens !== null && completionTokens !== null ? { promptTokens, completionTokens } : null,
    model: typeof record.model === 'string' && record.model.trim() ? record.model.trim() : null,
    finishReason: typeof finishValue === 'string' && finishValue.trim() ? finishValue.trim() : null,
    done: false,
  };
}

/**
 * Incremental SSE frame splitter: feed raw decoded text, complete `data:`
 * payloads come back through onData. Handles frames split across network
 * chunks, multi-line data frames (joined per the SSE spec), comment/heartbeat
 * lines and both LF and CRLF framing.
 */
export function createSseDataCollector(onData: (data: string) => void): (chunk: string) => void {
  let buffer = '';
  let dataLines: string[] = [];

  const flushEvent = () => {
    if (dataLines.length > 0) {
      onData(dataLines.join('\n'));
      dataLines = [];
    }
  };

  const handleLine = (rawLine: string) => {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line === '') {
      // Blank line: event boundary.
      flushEvent();
      return;
    }
    if (line.startsWith(':')) return; // comment / heartbeat
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).replace(/^ /, ''));
    }
    // event:/id:/retry: fields are irrelevant for chat streaming — ignored.
  };

  return (chunk: string) => {
    buffer += chunk;
    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex !== -1) {
      handleLine(buffer.slice(0, newlineIndex));
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf('\n');
    }
  };
}

/**
 * The demo gateway's OpenAI-compatible base: SSE streaming and image
 * generation only exist on the `/v1` surface (the legacy `/api` routes are
 * the old non-stream protocol), so `/gate/api` maps to `/gate/v1`.
 */
export function demoOpenAiBase(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  return trimmed.endsWith('/api') ? `${trimmed.slice(0, -4)}/v1` : trimmed;
}

/**
 * Where a streaming chat request goes. BYOK already talks to an
 * OpenAI-compatible base, so the path matches the non-streaming one; the demo
 * gateway exposes SSE only on the OpenAI-compatible `/v1` surface (its legacy
 * `/api/chat` route forces stream:false), so `/gate/api` maps to `/gate/v1`.
 */
export function chatStreamEndpoint(mode: 'demo_proxy' | 'custom_byok', baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  if (mode === 'demo_proxy') {
    return `${demoOpenAiBase(trimmed)}/chat/completions`;
  }
  return `${trimmed}/chat/completions`;
}

// ---- Structured error taxonomy ---------------------------------------------------
// Electron's IPC boundary only ferries the error message string across, so the
// renderer cannot read LlmGatewayError.details. The established pattern in this
// codebase is a machine-readable marker inside the message (see
// creditExhaustedError's [CREDITS_EXHAUSTED]); classifyChatError is the single
// canonical mapping from whatever crossed the channel — an LlmGatewayError with
// details on the main side, or a re-wrapped message string on the renderer side
// — onto the category the UI switches on.

export type ChatErrorCategory =
  /** 网络连不上: DNS/proxy/timeout/socket failures before any HTTP answer. */
  | 'network'
  /** 401/403, missing or invalid API key / service token. */
  | 'auth'
  /** Model unavailable: HTTP 404 or an explicit model-not-found message. */
  | 'model'
  /** Credit cycle exhausted (demo gateway metering). */
  | 'credits'
  /** The gateway answered but produced nothing displayable. */
  | 'empty'
  /** Anything else — treated as a transient service problem. */
  | 'unknown';

const NETWORK_ERROR_PATTERN =
  /无法连接模型服务|无法通过系统网络连接模型服务|could not reach the model service|接続できません|연결할 수 없습니다|fetch failed|econnrefused|econnreset|enotfound|etimedout|eai_again|socket hang up|network\s?error|timed?\s*out|operation timed out|超时/i;
const AUTH_ERROR_PATTERN =
  /请先在设置中填写\s*API\s*Key|invalid\s+(api[\s_-]?key|token|key)|unauthorized|forbidden|authentication|认证|鉴权|密钥|令牌|api[\s_-]?key|api\s*キー|api\s*키/i;
const MODEL_ERROR_PATTERN =
  /model[^\n]{0,80}(not found|does not exist|unavailable|not supported)|no such model|模型[^\n]{0,20}(不存在|不可用|未找到|不支持)/i;
const EMPTY_RESULT_PATTERN =
  /模型没有返回可显示的内容|模型服务未返回流式响应体|输出达到\s*Token\s*上限|no displayable content|no streaming response body|output token cap|表示できる内容|ストリーミング応答|トークン上限|표시할 수 있는 내용|스트리밍 응답|토큰 상한/i;

/** Read an HTTP status off an LlmGatewayError-shaped object (`details.status`)
 * or a bare `status` field; undefined when nothing structured survived. */
function errorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const direct = (error as { status?: unknown }).status;
  if (typeof direct === 'number') return direct;
  const details = (error as { details?: unknown }).details;
  if (details && typeof details === 'object') {
    const nested = (details as { status?: unknown }).status;
    if (typeof nested === 'number') return nested;
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : '';
}

/**
 * Classify a chat/gateway failure into the category the UI surfaces. Works on
 * both sides of the IPC boundary: structured LlmGatewayError details win when
 * present; otherwise the (possibly Electron re-wrapped) message string is
 * pattern-matched. Never throws.
 */
export function classifyChatError(error: unknown): ChatErrorCategory {
  const message = errorMessage(error);
  if (message.includes('CREDITS_EXHAUSTED')) return 'credits';
  const status = errorStatus(error);
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'model';
  if (EMPTY_RESULT_PATTERN.test(message)) return 'empty';
  if (AUTH_ERROR_PATTERN.test(message) || /http\s*40[13]\b/i.test(message)) return 'auth';
  if (MODEL_ERROR_PATTERN.test(message) || /http\s*404\b/i.test(message)) return 'model';
  if (NETWORK_ERROR_PATTERN.test(message)) return 'network';
  return 'unknown';
}
