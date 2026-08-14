import { net } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentService } from './agentService';
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
});
