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
    maxTokens: 0,
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

describe('EmbeddingService session cache', () => {
  // A Response body is single-use: build a fresh one per fetch call.
  function okResponse(embedding: number[] = [0.1, 0.2, 0.3]): Response {
    return new Response(JSON.stringify({
      model: 'text-embedding-v1',
      data: [{ index: 0, embedding }],
    }), { status: 200 });
  }

  function mockOk(): void {
    vi.mocked(net.fetch).mockImplementation(() => Promise.resolve(okResponse()));
  }

  // BYOK hits net.fetch directly; demo_proxy additionally retries on the
  // fallback gateway, which would blur exact call counts in failure tests.
  function byokRuntime(): RuntimeLlmSettings {
    return runtime({ mode: 'custom_byok', baseUrl: 'https://example.test/v1', apiKey: 'byok-key' });
  }

  beforeEach(() => {
    vi.mocked(net.fetch).mockReset();
  });

  it('serves a repeated text from cache without a second network call', async () => {
    mockOk();
    const svc = service(runtime());

    const first = await svc.embedWithMetadata(['hello']);
    const second = await svc.embedWithMetadata(['hello']);

    expect(net.fetch).toHaveBeenCalledTimes(1);
    expect(second.vectors[0]).toEqual(first.vectors[0]);
    expect(second.metadata).toEqual(first.metadata);
  });

  it('shares one network call between concurrent identical requests', async () => {
    mockOk();
    const svc = service(runtime());

    // Both calls start in the same tick: the second finds the first already
    // registered in-flight and shares its promise instead of re-queueing.
    const [first, second] = await Promise.all([
      svc.embedWithMetadata(['hello']),
      svc.embedWithMetadata(['hello']),
    ]);

    expect(net.fetch).toHaveBeenCalledTimes(1);
    expect(second.vectors[0]).toEqual(first.vectors[0]);
    expect(second.metadata).toEqual(first.metadata);
  });

  it('does not cache failures: a retry after recovery hits the network again', async () => {
    vi.mocked(net.fetch).mockRejectedValueOnce(new Error('network down'));
    const svc = service(byokRuntime());

    await expect(svc.embed(['hello'])).rejects.toThrow();
    // The settings-save / thinking-map retry hook reopens the breaker; the
    // failed call must have left nothing servable behind.
    svc.invalidateStatus();
    mockOk();
    const retry = await svc.embed(['hello']);

    expect(net.fetch).toHaveBeenCalledTimes(2);
    expect(retry[0]).toHaveLength(3);
  });

  it('does not serve cached vectors while the circuit breaker is open', async () => {
    mockOk();
    const svc = service(byokRuntime());

    await svc.embed(['hello']); // populates the cache
    vi.mocked(net.fetch).mockRejectedValueOnce(new Error('network down'));
    await expect(svc.embed(['other'])).rejects.toThrow(); // breaker trips
    // 'hello' is cached, but the open breaker must win over the cache.
    await expect(svc.embed(['hello'])).rejects.toThrow();
    expect(net.fetch).toHaveBeenCalledTimes(2);

    // Recovery (settings save / retry hook) clears status and cache.
    svc.invalidateStatus();
    mockOk();
    await svc.embed(['hello']);
    expect(net.fetch).toHaveBeenCalledTimes(3);
  });

  it('keys the cache by endpoint identity: a BYOK model change misses', async () => {
    mockOk();
    const svc = service(runtime());

    await svc.embed(['hello']);
    // Same text through a different configured endpoint = different vector
    // semantics, so the cache must miss even before invalidateStatus().
    const byok = service(byokRuntime());
    await byok.embed(['hello']);
    expect(net.fetch).toHaveBeenCalledTimes(2);
  });
});
