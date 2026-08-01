import { describe, expect, it, vi } from 'vitest';
import { fetchDemoProxy } from './proxyFetch';

const primary = 'https://api.ccvg1218.online/api';
const fallback = 'https://vesti-gate.vercel.app/api';

function options(route: 'chat' | 'embeddings' = 'chat') {
  return {
    primaryBaseUrl: primary,
    fallbackBaseUrl: fallback,
    route,
    serviceToken: 'test-service-token',
    body: JSON.stringify(route === 'chat'
      ? { model: 'qwen-plus', messages: [], stream: false }
      : { input: ['hello'], encoding_format: 'float' }),
  };
}

describe('fetchDemoProxy', () => {
  it('uses the new /api/chat route, service header and non-stream body', async () => {
    const fetchImpl = vi.fn<[string, RequestInit], Promise<Response>>(async () => new Response('{}', {
      status: 200,
      headers: {
        'x-request-id': 'req-1',
        'x-proxy-provider-used': 'dashscope',
        'x-proxy-model-used': 'qwen-plus',
      },
    }));
    const result = await fetchDemoProxy(options(), fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.ccvg1218.online/api/chat');
    expect(init.headers).toMatchObject({ 'x-vesti-service-token': 'test-service-token' });
    expect(JSON.parse(String(init.body))).toMatchObject({ model: 'qwen-plus', stream: false });
    expect(result.metadata).toMatchObject({
      requestId: 'req-1',
      providerUsed: 'dashscope',
      modelUsed: 'qwen-plus',
      attempt: 1,
    });
  });

  it('sends Demo embeddings without a model field', async () => {
    const fetchImpl = vi.fn<[string, RequestInit], Promise<Response>>(async () => new Response('{}', { status: 200 }));
    await fetchDemoProxy(options('embeddings'), fetchImpl);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.ccvg1218.online/api/embeddings');
    const body = JSON.parse(String(init.body));
    expect(body).toEqual({ input: ['hello'], encoding_format: 'float' });
    expect(body).not.toHaveProperty('model');
  });

  it.each([400, 401, 403, 404, 422])('does not fallback for HTTP %s', async status => {
    const fetchImpl = vi.fn<[string, RequestInit], Promise<Response>>(async () => new Response('{}', { status }));
    const result = await fetchDemoProxy(options(), fetchImpl);
    expect(result.response.status).toBe(status);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([429, 500, 502, 503])('falls back for retryable HTTP %s and reuses the body', async status => {
    const fetchImpl = vi.fn<[string, RequestInit], Promise<Response>>()
      .mockResolvedValueOnce(new Response('{}', { status }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    const request = options();
    const result = await fetchDemoProxy(request, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0][1].body).toBe(request.body);
    expect(fetchImpl.mock.calls[1][1].body).toBe(request.body);
    expect(fetchImpl.mock.calls[1][0]).toBe('https://vesti-gate.vercel.app/api/chat');
    expect(result.metadata).toMatchObject({ attempt: 2, fallbackReason: `http_${status}` });
  });

  it('falls back after a network error', async () => {
    const fetchImpl = vi.fn<[string, RequestInit], Promise<Response>>()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    const result = await fetchDemoProxy(options(), fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.metadata.fallbackReason).toBe('primary_network_error');
  });

  it('falls back after the primary attempt times out within the shared budget', async () => {
    const fetchImpl = vi.fn<[string, RequestInit], Promise<Response>>()
      .mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    const result = await fetchDemoProxy({
      ...options(),
      primaryAttemptTimeoutMs: 5,
      totalTimeoutMs: 100,
    }, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.metadata.fallbackReason).toBe('primary_timeout');
  });
});
