import { net } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EmbeddingService } from './embeddingService';
import type { RuntimeLlmSettings, SettingsService } from './settingsService';

vi.mock('electron', () => ({
  net: { fetch: vi.fn() },
}));

function runtime(overrides: Partial<RuntimeLlmSettings> = {}): RuntimeLlmSettings {
  return {
    mode: 'demo_proxy',
    baseUrl: 'https://api.ccvg1218.online/api',
    fallbackBaseUrl: 'https://vesti-gate.vercel.app/api',
    modelId: 'qwen-plus',
    temperature: 0.3,
    maxTokens: 1600,
    apiKey: '',
    serviceToken: 'test-service-token',
    embeddingModel: 'text-embedding-v1',
    ...overrides,
  };
}

function service(settings: RuntimeLlmSettings): EmbeddingService {
  return new EmbeddingService({
    getRuntimeLlm: () => settings,
  } as unknown as SettingsService);
}

describe('EmbeddingService proxy contract', () => {
  beforeEach(() => {
    vi.mocked(net.fetch).mockReset();
  });

  it('uses Demo /embeddings without model and records the reported 1536-d model', async () => {
    vi.mocked(net.fetch).mockResolvedValue(new Response(JSON.stringify({
      data: [{ index: 0, embedding: Array.from({ length: 1536 }, (_, index) => index / 1536) }],
    }), {
      status: 200,
      headers: {
        'x-request-id': 'embed-1',
        'x-proxy-provider-used': 'dashscope',
        'x-proxy-model-used': 'text-embedding-v1',
      },
    }));

    const result = await service(runtime()).embedWithMetadata(['hello']);
    expect(result.vectors[0]).toHaveLength(1536);
    expect(result.metadata).toMatchObject({
      provider: 'dashscope',
      model: 'text-embedding-v1',
      dimensions: 1536,
    });
    const [url, init] = vi.mocked(net.fetch).mock.calls[0];
    expect(url).toBe('https://api.ccvg1218.online/api/embeddings');
    const body = JSON.parse(String(init?.body));
    expect(body).toEqual({ input: ['hello'], encoding_format: 'float' });
    expect(body).not.toHaveProperty('model');
    expect(init?.headers).toMatchObject({ 'x-vesti-service-token': 'test-service-token' });
  });

  it('keeps BYOK on the standard endpoint with user model and Bearer auth', async () => {
    vi.mocked(net.fetch).mockResolvedValue(new Response(JSON.stringify({
      model: 'custom-embedding-model',
      data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }],
    }), { status: 200 }));
    const result = await service(runtime({
      mode: 'custom_byok',
      baseUrl: 'https://example.test/v1',
      apiKey: 'byok-test-key',
      embeddingModel: 'custom-embedding-model',
    })).embedWithMetadata(['hello']);

    const [url, init] = vi.mocked(net.fetch).mock.calls[0];
    expect(url).toBe('https://example.test/v1/embeddings');
    expect(init?.headers).toMatchObject({ authorization: 'Bearer byok-test-key' });
    expect(JSON.parse(String(init?.body))).toMatchObject({ model: 'custom-embedding-model' });
    expect(result.metadata).toMatchObject({ model: 'custom-embedding-model', dimensions: 3 });
  });
});
