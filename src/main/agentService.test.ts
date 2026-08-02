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
