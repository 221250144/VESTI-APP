export const PROXY_TOTAL_TIMEOUT_MS = 90_000;
export const PROXY_PRIMARY_ATTEMPT_TIMEOUT_MS = 60_000;

export type ProxyRoute = 'chat' | 'embeddings';

export interface ProxyAttemptMetadata {
  requestId?: string;
  providerUsed?: string;
  modelUsed?: string;
  attempt: number;
  fallbackReason?: string;
  endpoint: string;
}

export interface ProxyFetchResult {
  response: Response;
  metadata: ProxyAttemptMetadata;
}

export interface DemoProxyFetchOptions {
  primaryBaseUrl: string;
  fallbackBaseUrl: string;
  route: ProxyRoute;
  serviceToken: string;
  body: string;
  signal?: AbortSignal;
  totalTimeoutMs?: number;
  primaryAttemptTimeoutMs?: number;
}

export type ProxyFetchImplementation = (input: string, init: RequestInit) => Promise<Response>;

function endpoint(baseUrl: string, route: ProxyRoute): string {
  return `${baseUrl.replace(/\/+$/, '')}/${route}`;
}

function retryReason(status: number): string | null {
  if (status === 429) return 'http_429';
  if (status >= 500 && status <= 599) return `http_${status}`;
  return null;
}

function metadata(
  response: Response,
  attempt: number,
  requestEndpoint: string,
  clientFallbackReason?: string,
): ProxyAttemptMetadata {
  const headerAttempt = Number(response.headers.get('x-proxy-attempt'));
  return {
    requestId: response.headers.get('x-request-id') || undefined,
    providerUsed: response.headers.get('x-proxy-provider-used') || undefined,
    modelUsed: response.headers.get('x-proxy-model-used') || undefined,
    attempt: Number.isFinite(headerAttempt) && headerAttempt > 0 ? headerAttempt : attempt,
    fallbackReason: response.headers.get('x-proxy-fallback-reason') || clientFallbackReason || undefined,
    endpoint: requestEndpoint,
  };
}

async function attemptFetch(
  fetchImpl: ProxyFetchImplementation,
  requestEndpoint: string,
  headers: Record<string, string>,
  body: string,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<Response> {
  if (externalSignal?.aborted) {
    throw externalSignal.reason ?? new DOMException('Request aborted', 'AbortError');
  }
  const controller = new AbortController();
  const onAbort = () => controller.abort(externalSignal?.reason);
  externalSignal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(
    () => controller.abort(new DOMException('Proxy request timed out', 'TimeoutError')),
    timeoutMs,
  );
  try {
    return await fetchImpl(requestEndpoint, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', onAbort);
  }
}

/** Client-side legacy gateway fallback. It never changes the model or body. */
export async function fetchDemoProxy(
  options: DemoProxyFetchOptions,
  fetchImpl: ProxyFetchImplementation,
): Promise<ProxyFetchResult> {
  const startedAt = Date.now();
  const totalTimeoutMs = options.totalTimeoutMs ?? PROXY_TOTAL_TIMEOUT_MS;
  const primaryTimeoutMs = Math.min(
    options.primaryAttemptTimeoutMs ?? PROXY_PRIMARY_ATTEMPT_TIMEOUT_MS,
    totalTimeoutMs,
  );
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (options.serviceToken.trim()) {
    headers['x-vesti-service-token'] = options.serviceToken.trim();
  }
  const primaryEndpoint = endpoint(options.primaryBaseUrl, options.route);
  const fallbackEndpoint = endpoint(options.fallbackBaseUrl, options.route);
  const canFallback = primaryEndpoint !== fallbackEndpoint;
  let fallbackReason: string | undefined;

  try {
    const response = await attemptFetch(
      fetchImpl,
      primaryEndpoint,
      headers,
      options.body,
      primaryTimeoutMs,
      options.signal,
    );
    const reason = retryReason(response.status);
    if (!reason || !canFallback) {
      return { response, metadata: metadata(response, 1, primaryEndpoint) };
    }
    fallbackReason = reason;
    void response.body?.cancel().catch(() => undefined);
  } catch (error) {
    if (options.signal?.aborted) throw error;
    if (!canFallback) throw error;
    fallbackReason = error instanceof DOMException && error.name === 'TimeoutError'
      ? 'primary_timeout'
      : 'primary_network_error';
  }

  const remainingMs = totalTimeoutMs - (Date.now() - startedAt);
  if (remainingMs <= 0) throw new DOMException('Proxy request timed out', 'TimeoutError');
  const response = await attemptFetch(
    fetchImpl,
    fallbackEndpoint,
    headers,
    options.body,
    remainingMs,
    options.signal,
  );
  return {
    response,
    metadata: metadata(response, 2, fallbackEndpoint, fallbackReason),
  };
}
