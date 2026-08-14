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
    return { content: '', reasoning: '', usage: null, model: null, done: true };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as {
    choices?: Array<{ delta?: { content?: unknown; reasoning_content?: unknown } }>;
    usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
    model?: unknown;
  };
  const delta = record.choices?.[0]?.delta;
  const contentValue = delta?.content;
  const reasoningValue = delta?.reasoning_content;
  const promptTokens = typeof record.usage?.prompt_tokens === 'number' ? record.usage.prompt_tokens : null;
  const completionTokens =
    typeof record.usage?.completion_tokens === 'number' ? record.usage.completion_tokens : null;
  return {
    content: typeof contentValue === 'string' ? contentValue : '',
    reasoning: typeof reasoningValue === 'string' ? reasoningValue : '',
    usage: promptTokens !== null && completionTokens !== null ? { promptTokens, completionTokens } : null,
    model: typeof record.model === 'string' && record.model.trim() ? record.model.trim() : null,
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
