import { net } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentService, buildProjectedSessionTranscript } from './agentService';
import type { SessionDetail } from '../shared/contracts';
import type { CaptureService } from './captureService';
import type { RuntimeLlmSettings, SettingsService } from './settingsService';

vi.mock('electron', () => ({
  net: { fetch: vi.fn() },
  session: {
    defaultSession: {
      resolveProxy: vi.fn().mockResolvedValue('DIRECT'),
    },
  },
}));

function runtime(overrides: Partial<RuntimeLlmSettings> = {}): RuntimeLlmSettings {
  return {
    mode: 'demo_proxy',
    baseUrl: 'https://api.ccvg1218.online/api',
    fallbackBaseUrl: 'https://vesti-gate.vercel.app/api',
    modelId: 'qwen-plus',
    temperature: 0.3,
    maxTokens: 0,
    apiKey: '',
    serviceToken: 'test-service-token',
    embeddingModel: 'text-embedding-v1',
    ...overrides,
  };
}

function service(llm = runtime()): AgentService {
  const capture = {
    getSession: () => null,
    activeDataDirectory: 'C:/tmp/vesti-agent-test',
  } as unknown as CaptureService;
  const settings = {
    getRuntimeAgent: () => ({
      outputLanguage: 'en-US',
      includeThinking: false,
      includeToolDetails: false,
      customInstructions: '',
    }),
    getRuntimeLlm: () => llm,
  } as unknown as SettingsService;
  return new AgentService(capture, settings);
}

const request = {
  kind: 'explore' as const,
  sessionId: 'renderer-session',
  question: 'What matters?',
  transcriptOverride: 'User: hello\nAI: hello',
};

describe('buildProjectedSessionTranscript', () => {
  const detail: SessionDetail = {
    session: {
      id: 'codex:test',
      sessionId: 'test',
      platform: 'codex',
      projectPath: 'D:/work',
      title: 'Task',
      status: 'active',
      startedAt: 1,
      lastActivityAt: 6,
      messageCount: 6,
      turnCount: 1,
      toolCallCount: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
    },
    messages: [
      { id: 'u1', sessionId: 'codex:test', turnId: 'turn-1', sequence: 0, source: 'user_input', role: 'user', contentText: '主提示', timestamp: 1 },
      { id: 'p1', sessionId: 'codex:test', turnId: 'turn-1', sequence: 1, source: 'assistant_commentary', role: 'assistant', contentText: '进度', timestamp: 2 },
      { id: 'u2', sessionId: 'codex:test', turnId: 'turn-1', sequence: 2, source: 'user_input', role: 'user', contentText: '跟进', timestamp: 3 },
      { id: 't1', sessionId: 'codex:test', turnId: 'turn-1', sequence: 3, source: 'assistant_think', role: 'assistant', contentThinking: '思考', timestamp: 4 },
      { id: 'a1', sessionId: 'codex:test', turnId: 'turn-1', sequence: 4, source: 'assistant_text', role: 'assistant', contentText: '最终答案', timestamp: 5 },
    ],
  };

  it('uses prompt, follow-ups and final answer by default, adding process only when enabled', () => {
    const base = {
      outputLanguage: 'zh-CN',
      includeThinking: false,
      includeToolDetails: false,
      customInstructions: '',
    } satisfies ReturnType<SettingsService['getRuntimeAgent']>;

    const compact = buildProjectedSessionTranscript(detail, base);
    expect(compact).toContain('主提示');
    expect(compact).toContain('跟进 1：跟进');
    expect(compact).toContain('最终答案');
    expect(compact).not.toContain('进度');
    expect(compact).not.toContain('思考');

    const complete = buildProjectedSessionTranscript(detail, { ...base, includeThinking: true });
    expect(complete).toContain('[进度]');
    expect(complete).toContain('[思考]');
  });

  it('keeps tool activity from an unfinished turn when tool details are enabled', () => {
    const toolOnly: SessionDetail = {
      ...detail,
      messages: [
        { id: 'u1', sessionId: 'codex:test', turnId: 'turn-1', sequence: 0, source: 'user_input', role: 'user', contentText: '检查文件', timestamp: 1 },
        { id: 'tool-1', sessionId: 'codex:test', turnId: 'turn-1', sequence: 1, source: 'tool_request', role: 'assistant', contentToolName: 'read_file', contentToolInput: 'src/a.ts', timestamp: 2 },
        { id: 'tool-2', sessionId: 'codex:test', turnId: 'turn-1', sequence: 2, source: 'tool_result', role: 'assistant', contentToolName: 'read_file', contentToolOutput: 'file body', timestamp: 3 },
      ],
    };
    const transcript = buildProjectedSessionTranscript(toolOnly, {
      outputLanguage: 'zh-CN',
      includeThinking: false,
      includeToolDetails: true,
      customInstructions: '',
    });

    expect(transcript).toContain('检查文件');
    expect(transcript).toContain('[工具]');
    expect(transcript).toContain('工具：read_file');
    expect(transcript).toContain('工具输入：src/a.ts');
    expect(transcript).toContain('工具输出：file body');
  });
});

describe('AgentService Demo proxy contract', () => {
  beforeEach(() => {
    vi.mocked(net.fetch).mockReset();
  });

  it('omits max_tokens and records requested and effective models separately', async () => {
    vi.mocked(net.fetch).mockResolvedValue(new Response(JSON.stringify({
      model: 'ignored-body-model',
      choices: [{ message: { content: 'Useful answer' } }],
    }), {
      status: 200,
      headers: { 'x-proxy-model-used': 'dashscope/qwen-turbo' },
    }));

    const result = await service().run(request, { persist: false });

    expect(result).toMatchObject({
      content: 'Useful answer',
      modelId: 'dashscope/qwen-turbo',
      requestedModelId: 'qwen-plus',
      modelUsed: 'dashscope/qwen-turbo',
    });
    const body = JSON.parse(String(vi.mocked(net.fetch).mock.calls[0][1]?.body));
    expect(body.model).toBe('qwen-plus');
    expect(body).not.toHaveProperty('max_tokens');
  });

  it('raises a small user token cap to the per-kind floor for chat kinds', async () => {
    vi.mocked(net.fetch).mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: '温柔的开场' } }],
    }), { status: 200 }));

    await service(runtime({ maxTokens: 128 })).run(
      { ...request, kind: 'companion' as const, question: '' },
      { persist: false },
    );

    const body = JSON.parse(String(vi.mocked(net.fetch).mock.calls[0][1]?.body));
    // Reasoning models eat a small cap with the thinking trace, returning an
    // empty visible answer — the floor keeps a real answer possible.
    expect(body.max_tokens).toBe(2048);
  });

  it('reuses the Auto body unchanged when falling back to the legacy gateway', async () => {
    vi.mocked(net.fetch)
      .mockResolvedValueOnce(new Response('{}', { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: 'Fallback answer' } }],
      }), {
        status: 200,
        headers: { 'x-proxy-model-used': 'legacy/qwen-plus' },
      }));

    const result = await service().run(request, { persist: false });

    expect(vi.mocked(net.fetch)).toHaveBeenCalledTimes(2);
    const [primaryUrl, primaryInit] = vi.mocked(net.fetch).mock.calls[0];
    const [fallbackUrl, fallbackInit] = vi.mocked(net.fetch).mock.calls[1];
    expect(primaryUrl).toBe('https://api.ccvg1218.online/api/chat');
    expect(fallbackUrl).toBe('https://vesti-gate.vercel.app/api/chat');
    expect(fallbackInit?.body).toBe(primaryInit?.body);
    expect(JSON.parse(String(fallbackInit?.body))).not.toHaveProperty('max_tokens');
    expect(result.modelUsed).toBe('legacy/qwen-plus');
  });
});

describe('AgentService.test connection messages follow the UI language', () => {
  beforeEach(() => {
    vi.mocked(net.fetch).mockReset();
  });

  function byokService(locale: unknown, apiKey = 'sk-test'): AgentService {
    const capture = {
      getSession: () => null,
      activeDataDirectory: 'C:/tmp/vesti-agent-test',
    } as unknown as CaptureService;
    const llm = runtime({
      mode: 'custom_byok',
      baseUrl: 'https://api.openai.com/v1',
      modelId: 'gpt-4o-mini',
      apiKey,
    });
    const settings = {
      getRuntimeAgent: () => ({
        outputLanguage: 'en-US',
        includeThinking: false,
        includeToolDetails: false,
        customInstructions: '',
      }),
      getRuntimeLlm: () => llm,
    } as unknown as SettingsService;
    return new AgentService(capture, settings, undefined, () => locale);
  }

  it('reports success in English for an English UI', async () => {
    vi.mocked(net.fetch).mockResolvedValue(new Response(JSON.stringify({
      model: 'gpt-4o-mini',
      choices: [{ message: { content: 'OK' } }],
    }), { status: 200 }));

    const result = await byokService({ locale: 'en' }).test();

    expect(result).toEqual({ ok: true, message: 'Connection successful: gpt-4o-mini' });
    // BYOK hits the standard OpenAI-compatible endpoint with a Bearer header.
    const [url, init] = vi.mocked(net.fetch).mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer sk-test');
  });

  it('reports success in Chinese by default (legacy factory language)', async () => {
    vi.mocked(net.fetch).mockResolvedValue(new Response(JSON.stringify({
      model: 'gpt-4o-mini',
      choices: [{ message: { content: 'OK' } }],
    }), { status: 200 }));

    const result = await service(runtime({
      mode: 'custom_byok',
      baseUrl: 'https://api.openai.com/v1',
      modelId: 'gpt-4o-mini',
      apiKey: 'sk-test',
    })).test();

    expect(result).toEqual({ ok: true, message: '连接成功：gpt-4o-mini' });
  });

  it('localizes the missing-API-key failure', async () => {
    const en = await byokService({ locale: 'en' }, '').test();
    expect(en).toEqual({ ok: false, message: 'Add your API key in Settings first' });

    const ja = await byokService({ locale: 'ja' }, '').test();
    expect(ja).toEqual({ ok: false, message: '先に設定で API キーを入力してください' });

    expect(vi.mocked(net.fetch)).not.toHaveBeenCalled();
  });

  it('localizes HTTP failures from the provider', async () => {
    vi.mocked(net.fetch).mockResolvedValue(new Response(JSON.stringify({
      error: { message: 'Incorrect API key provided' },
    }), { status: 401 }));

    const result = await byokService({ locale: 'ko' }).test();

    expect(result.ok).toBe(false);
    // Upstream detail passes through verbatim; no Chinese scaffolding is added.
    expect(result.message).toBe('Incorrect API key provided');
  });
});

describe('AgentService.runStream', () => {
  beforeEach(() => {
    vi.mocked(net.fetch).mockReset();
  });

  const sseBody = (frames: string[]) =>
    new Response(frames.map((frame) => `data: ${frame}\n\n`).join(''), { status: 200 });

  it('streams SSE deltas to emit and resolves with the parsed result', async () => {
    vi.mocked(net.fetch).mockResolvedValue(sseBody([
      JSON.stringify({ model: 'deepseek-v4-flash', choices: [{ delta: { reasoning_content: '想想…' } }] }),
      JSON.stringify({ choices: [{ delta: { content: 'Use' } }] }),
      JSON.stringify({ choices: [{ delta: { content: 'ful answer' } }] }),
      JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 4 } }),
      '[DONE]',
    ]));

    const chunks: Array<{ delta?: string; reasoning?: string; done?: boolean }> = [];
    const result = await service(runtime({ baseUrl: 'https://vesti.world/gate/api' }))
      .runStream(request, (chunk) => chunks.push(chunk), { persist: false });

    expect(result.content).toBe('Useful answer');
    expect(result.modelUsed).toBe('deepseek-v4-flash');
    expect(chunks).toEqual([
      { delta: undefined, reasoning: '想想…' },
      { delta: 'Use', reasoning: undefined },
      { delta: 'ful answer', reasoning: undefined },
      { done: true },
    ]);
    // The demo gateway streams over the OpenAI-compatible /v1 surface.
    const [url, init] = vi.mocked(net.fetch).mock.calls[0];
    expect(url).toBe('https://vesti.world/gate/v1/chat/completions');
    expect((init?.headers as Record<string, string>)['x-vesti-service-token']).toBe('test-service-token');
    const body = JSON.parse(String(init?.body));
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
  });

  it('degrades to the non-streaming call when the transport fails before any delta', async () => {
    vi.mocked(net.fetch)
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: 'Non-stream answer' } }],
      }), { status: 200 }));

    const chunks: Array<{ delta?: string; reasoning?: string; done?: boolean }> = [];
    const result = await service().runStream(request, (chunk) => chunks.push(chunk), { persist: false });

    expect(result.content).toBe('Non-stream answer');
    expect(chunks).toEqual([{ done: true }]);
    // First call = stream endpoint; the fallback re-uses the legacy /chat route.
    expect(vi.mocked(net.fetch)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(net.fetch).mock.calls[0][0]).toBe('https://api.ccvg1218.online/v1/chat/completions');
    expect(vi.mocked(net.fetch).mock.calls[1][0]).toBe('https://api.ccvg1218.online/api/chat');
  });

  it('does not retry once a delta was already shown', async () => {
    const brokenStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          'data: {"choices":[{"delta":{"content":"部分"}}]}\n\n',
        ));
        // Async error: undici discards a synchronously-errored stream's queued
        // chunk, real mid-stream failures deliver the chunk first.
        setTimeout(() => controller.error(new Error('mid-stream boom')), 0);
      },
    });
    vi.mocked(net.fetch).mockResolvedValue(new Response(brokenStream, { status: 200 }));

    const chunks: Array<{ delta?: string }> = [];
    await expect(
      service().runStream(request, (chunk) => chunks.push(chunk), { persist: false }),
    ).rejects.toThrow('mid-stream boom');
    expect(chunks).toEqual([{ delta: '部分', reasoning: undefined }]);
    expect(vi.mocked(net.fetch)).toHaveBeenCalledTimes(1);
  });

  it('reports a length-terminated empty stream as a token-cap truncation', async () => {
    vi.mocked(net.fetch).mockResolvedValue(sseBody([
      JSON.stringify({ choices: [{ delta: { reasoning_content: '长时间思考…' } }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] }),
      '[DONE]',
    ]));

    await expect(
      service().runStream(request, () => undefined, { persist: false }),
    ).rejects.toThrow('Token 上限');
  });
});
