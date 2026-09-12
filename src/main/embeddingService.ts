import { createHash } from 'node:crypto';
import { net } from 'electron';
import type { EmbeddingStatus } from '../shared/contracts';
import type { SettingsService } from './settingsService';
import { fetchDemoProxy, type ProxyAttemptMetadata } from './proxyFetch';
import {
  embeddingStrings,
  formatMainString,
  llmStrings,
  resolveMainLocale,
  type MainEmbeddingStrings,
} from './mainStrings';

const EMBEDDING_BATCH_SIZE = 32;
const EMBEDDING_TIMEOUT_MS = 90_000;
const EMBEDDING_INDEX_SCHEMA_VERSION = 'v1';
/** Session-scoped vector cache size: identical texts (digest re-embeds,
 * repeated recall queries, thinking-map probes) skip the endpoint entirely. */
const EMBEDDING_CACHE_MAX_ENTRIES = 64;

export interface EmbeddingIndexMetadata {
  provider: string;
  model: string;
  dimensions: number;
  version: string;
}

export interface EmbeddingBatchResult {
  vectors: Float32Array[];
  metadata: EmbeddingIndexMetadata;
}

interface CachedEmbedding {
  vector: Float32Array;
  metadata: EmbeddingIndexMetadata;
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function indexVersion(provider: string, model: string, dimensions: number): string {
  return [EMBEDDING_INDEX_SCHEMA_VERSION, provider, model, dimensions]
    .map(part => String(part).trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '_'))
    .join(':');
}

export class EmbeddingRequestError extends Error {
  constructor(
    message: string,
    readonly details: {
      status?: number;
      code?: string;
      requestId?: string;
      providerUsed?: string;
      modelUsed?: string;
      attempt?: number;
      fallbackReason?: string;
    } = {},
  ) {
    super(message);
    this.name = 'EmbeddingRequestError';
  }
}

/** Credit-metering hook wired by main (demo-gateway accounting; BYOK no-ops). */
export interface EmbeddingCreditMeter {
  /** Post-success accounting of one embeddings endpoint call. */
  afterEmbedding(label: string): void;
}

/** OpenAI-compatible embeddings client with isolated, versioned indexes. */
export class EmbeddingService {
  private status: EmbeddingStatus = { available: true };
  private probed = false;
  private tail: Promise<unknown> = Promise.resolve();
  /** LRU of successful vectors keyed by endpoint identity + text hash.
   * Failures are never cached, and invalidateStatus() (settings change /
   * breaker recovery) drops the whole map. Session-scoped on purpose — the
   * persisted per-version tables handle restart reuse for digests. Cached
   * vectors are shared by reference; callers serialize them read-only. */
  private readonly vectorCache = new Map<string, CachedEmbedding>();
  /** Whole-request dedup: concurrent identical calls share one queued op. */
  private readonly inflight = new Map<string, Promise<EmbeddingBatchResult>>();
  /** Bumped by invalidateStatus() so inflight keys never span a settings change. */
  private settingsGeneration = 0;

  constructor(
    private readonly settings: SettingsService,
    private readonly credits?: EmbeddingCreditMeter,
    /** UI-language source (ui-prefs `language`) for user-facing status/error
     * messages; defaults to Chinese, the legacy factory language. */
    private readonly uiLocale: () => unknown = () => 'zh',
  ) {}

  private strings(): MainEmbeddingStrings {
    return embeddingStrings(resolveMainLocale(this.uiLocale()));
  }

  invalidateStatus(): void {
    this.status = { available: true };
    this.probed = false;
    this.settingsGeneration += 1;
    this.vectorCache.clear();
  }

  /** Identity of the configured embedding endpoint (mode + base URL + model)
   * — the parts of the runtime LLM config that determine vector semantics.
   * Dimensions are only known after a response, so they stay out of the key;
   * the per-version persisted indexes remain the cross-restart source of
   * truth. Null when the runtime config is unreadable (locked safeStorage). */
  getEndpointIdentity(): string | null {
    try {
      const llm = this.settings.getRuntimeLlm();
      return [llm.mode, llm.baseUrl, llm.embeddingModel].join('|');
    } catch {
      return null;
    }
  }

  async getStatus(): Promise<EmbeddingStatus> {
    if (!this.probed) await this.embed(['ping']).catch(() => undefined);
    return { ...this.status };
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    return (await this.embedWithMetadata(texts)).vectors;
  }

  async embedWithMetadata(texts: string[]): Promise<EmbeddingBatchResult> {
    if (texts.length === 0) return this.enqueue(() => this.embedQueued(texts));
    // In-flight dedup: a concurrent identical request shares the queued op
    // instead of lining up a second endpoint call behind it. The generation
    // counter keeps keys from leaking across a settings change.
    const requestKey = `${this.settingsGeneration}:${sha256(JSON.stringify(texts))}`;
    const pending = this.inflight.get(requestKey);
    if (pending) return pending;
    const run = this.enqueue(() => this.embedQueued(texts));
    this.inflight.set(requestKey, run);
    try {
      return await run;
    } finally {
      this.inflight.delete(requestKey);
    }
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.tail.then(task);
    this.tail = run.catch(() => undefined);
    return run;
  }

  private async embedQueued(texts: string[]): Promise<EmbeddingBatchResult> {
    const generation = this.settingsGeneration;
    const strings = this.strings();
    if (texts.length === 0) {
      throw new EmbeddingRequestError(strings.emptyInput);
    }
    if (!this.status.available) throw new Error(this.status.reason ?? strings.unavailable);
    try {
      // Cache fast path (breaker closed only — the availability check above
      // has already thrown when it is open). Served only when every text hits
      // with a single consistent index version; a partial or mixed-version
      // hit falls through to a full fresh fetch so batches never mix models.
      const identity = this.getEndpointIdentity();
      const keys = identity ? texts.map(text => `${identity}:${sha256(text)}`) : null;
      const hits = keys?.map(key => this.cacheGet(key)) ?? null;
      if (hits?.every(Boolean) && new Set(hits.map(hit => hit!.metadata.version)).size === 1) {
        this.status = { available: true };
        this.probed = true;
        return { vectors: hits.map(hit => hit!.vector), metadata: hits[0]!.metadata };
      }

      const vectors: Float32Array[] = [];
      let metadata: EmbeddingIndexMetadata | null = null;
      for (let start = 0; start < texts.length; start += EMBEDDING_BATCH_SIZE) {
        const batch = await this.embedBatch(texts.slice(start, start + EMBEDDING_BATCH_SIZE));
        if (metadata && metadata.version !== batch.metadata.version) {
          throw new EmbeddingRequestError(strings.mixedModels);
        }
        metadata = batch.metadata;
        vectors.push(...batch.vectors);
      }
      // Settings may change while the endpoint request is in flight. Return
      // its result to the original caller without reviving stale shared state.
      if (generation === this.settingsGeneration) {
        this.status = { available: true };
        this.probed = true;
      }
      if (keys && generation === this.settingsGeneration) {
        keys.forEach((key, index) => {
          const vector = vectors[index];
          if (vector) this.cacheSet(key, { vector, metadata: metadata! });
        });
      }
      return { vectors, metadata: metadata! };
    } catch (error) {
      if (generation === this.settingsGeneration) {
        this.status = {
          available: false,
          reason: error instanceof Error ? error.message : strings.requestFailed,
        };
        this.probed = true;
      }
      throw error;
    }
  }

  private cacheGet(key: string): CachedEmbedding | null {
    const hit = this.vectorCache.get(key);
    if (!hit) return null;
    // LRU touch: reinsert at the recency end of the insertion-ordered map.
    this.vectorCache.delete(key);
    this.vectorCache.set(key, hit);
    return hit;
  }

  private cacheSet(key: string, entry: CachedEmbedding): void {
    this.vectorCache.delete(key);
    this.vectorCache.set(key, entry);
    while (this.vectorCache.size > EMBEDDING_CACHE_MAX_ENTRIES) {
      const oldest = this.vectorCache.keys().next().value;
      if (oldest === undefined) break;
      this.vectorCache.delete(oldest);
    }
  }

  private async embedBatch(texts: string[]): Promise<EmbeddingBatchResult> {
    const strings = this.strings();
    const llm = this.settings.getRuntimeLlm();
    if (llm.mode === 'custom_byok' && !llm.apiKey) {
      throw new Error(llmStrings(resolveMainLocale(this.uiLocale())).apiKeyMissing);
    }

    let response: Response;
    let proxyMetadata: ProxyAttemptMetadata | undefined;
    try {
      if (llm.mode === 'demo_proxy') {
        // The Demo gateway selects text-embedding-v1; clients must not send a
        // model field so server-side routing remains authoritative.
        const result = await fetchDemoProxy({
          primaryBaseUrl: llm.baseUrl,
          fallbackBaseUrl: llm.fallbackBaseUrl,
          route: 'embeddings',
          serviceToken: llm.serviceToken,
          body: JSON.stringify({ input: texts, encoding_format: 'float' }),
          totalTimeoutMs: EMBEDDING_TIMEOUT_MS,
        }, (input, init) => net.fetch(input, init));
        response = result.response;
        proxyMetadata = result.metadata;
      } else {
        response = await net.fetch(`${llm.baseUrl.replace(/\/+$/, '')}/embeddings`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${llm.apiKey}`,
          },
          body: JSON.stringify({
            model: llm.embeddingModel,
            input: texts,
            encoding_format: 'float',
          }),
          signal: AbortSignal.timeout(EMBEDDING_TIMEOUT_MS),
        });
      }
    } catch (error) {
      throw new EmbeddingRequestError(
        formatMainString(strings.networkError, {
          reason: error instanceof Error
            ? error.message
            : llmStrings(resolveMainLocale(this.uiLocale())).unknownNetworkReason,
        }),
      );
    }

    const payload = await response.json().catch(() => ({})) as {
      model?: string;
      data?: Array<{ index?: number; embedding?: unknown }>;
      error?: { code?: string; message?: string; requestId?: string } | string;
      message?: string;
    };
    if (!response.ok) {
      const detail = typeof payload.error === 'string' ? payload.error : payload.error?.message || payload.message;
      const requestId = response.headers.get('x-request-id')
        || (typeof payload.error === 'object' ? payload.error?.requestId : undefined)
        || proxyMetadata?.requestId;
      throw new EmbeddingRequestError(
        detail || formatMainString(strings.requestFailedHttp, { status: String(response.status) }),
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
    if (!Array.isArray(payload.data) || payload.data.length !== texts.length) {
      throw new EmbeddingRequestError(strings.badResponse);
    }

    const ordered = [...payload.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    // Some compatible providers omit indices entirely and preserve order.
    // If any index is supplied, require an exact permutation of the batch;
    // duplicates or missing indices would silently attach vectors to wrong texts.
    if (ordered.some(item => item.index !== undefined)
      && ordered.some((item, index) => item.index !== index)) {
      throw new EmbeddingRequestError(strings.badResponse);
    }
    const vectors = ordered.map(item => {
      if (!Array.isArray(item.embedding) || !item.embedding.every(value =>
        typeof value === 'number' && Number.isFinite(value) && Number.isFinite(Math.fround(value)))) {
        throw new EmbeddingRequestError(strings.badResponse);
      }
      return Float32Array.from(item.embedding as number[]);
    });
    const dimensions = vectors[0]?.length ?? 0;
    if (!dimensions || vectors.some(vector => vector.length !== dimensions)) {
      throw new EmbeddingRequestError(strings.mixedDimensions);
    }
    const provider = response.headers.get('x-proxy-provider-used')
      || proxyMetadata?.providerUsed
      || (llm.mode === 'demo_proxy' ? 'dashscope' : 'byok');
    const model = response.headers.get('x-proxy-model-used')
      || proxyMetadata?.modelUsed
      || payload.model
      || llm.embeddingModel;
    // One successful endpoint call = one metered embedding (demo gateway only).
    this.credits?.afterEmbedding('embedding');
    return {
      vectors,
      metadata: {
        provider,
        model,
        dimensions,
        version: indexVersion(provider, model, dimensions),
      },
    };
  }
}
