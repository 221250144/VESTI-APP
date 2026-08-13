import { net } from 'electron';
import type { EmbeddingStatus } from '../shared/contracts';
import type { SettingsService } from './settingsService';
import { fetchDemoProxy, type ProxyAttemptMetadata } from './proxyFetch';

const EMBEDDING_BATCH_SIZE = 32;
const EMBEDDING_TIMEOUT_MS = 90_000;
const EMBEDDING_INDEX_SCHEMA_VERSION = 'v1';

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

  constructor(
    private readonly settings: SettingsService,
    private readonly credits?: EmbeddingCreditMeter,
  ) {}

  invalidateStatus(): void {
    this.status = { available: true };
    this.probed = false;
  }

  async getStatus(): Promise<EmbeddingStatus> {
    if (!this.probed) await this.embed(['ping']).catch(() => undefined);
    return { ...this.status };
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    return (await this.embedWithMetadata(texts)).vectors;
  }

  async embedWithMetadata(texts: string[]): Promise<EmbeddingBatchResult> {
    return this.enqueue(() => this.embedQueued(texts));
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.tail.then(task);
    this.tail = run.catch(() => undefined);
    return run;
  }

  private async embedQueued(texts: string[]): Promise<EmbeddingBatchResult> {
    if (texts.length === 0) {
      throw new EmbeddingRequestError('embedding 输入不能为空');
    }
    if (!this.status.available) throw new Error(this.status.reason ?? 'Embedding 服务不可用');
    try {
      const vectors: Float32Array[] = [];
      let metadata: EmbeddingIndexMetadata | null = null;
      for (let start = 0; start < texts.length; start += EMBEDDING_BATCH_SIZE) {
        const batch = await this.embedBatch(texts.slice(start, start + EMBEDDING_BATCH_SIZE));
        if (metadata && metadata.version !== batch.metadata.version) {
          throw new EmbeddingRequestError('embedding 批次使用了不同模型，已拒绝混合索引');
        }
        metadata = batch.metadata;
        vectors.push(...batch.vectors);
      }
      this.status = { available: true };
      this.probed = true;
      return { vectors, metadata: metadata! };
    } catch (error) {
      this.status = {
        available: false,
        reason: error instanceof Error ? error.message : 'embedding 请求失败',
      };
      this.probed = true;
      throw error;
    }
  }

  private async embedBatch(texts: string[]): Promise<EmbeddingBatchResult> {
    const llm = this.settings.getRuntimeLlm();
    if (llm.mode === 'custom_byok' && !llm.apiKey) {
      throw new Error('请先在设置中填写 API Key');
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
        `无法连接模型服务：${error instanceof Error ? error.message : '未知网络错误'}`,
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
        detail || `embedding 请求失败（HTTP ${response.status}）`,
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
      throw new EmbeddingRequestError('embedding 响应格式异常');
    }

    const ordered = [...payload.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    const vectors = ordered.map(item => {
      if (!Array.isArray(item.embedding) || !item.embedding.every(value => typeof value === 'number')) {
        throw new EmbeddingRequestError('embedding 响应格式异常');
      }
      return Float32Array.from(item.embedding as number[]);
    });
    const dimensions = vectors[0]?.length ?? 0;
    if (!dimensions || vectors.some(vector => vector.length !== dimensions)) {
      throw new EmbeddingRequestError('embedding 向量维度不一致');
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
