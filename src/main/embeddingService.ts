import { net } from 'electron';
import type { EmbeddingStatus } from '../shared/contracts';
import type { SettingsService } from './settingsService';

const EMBEDDING_BATCH_SIZE = 32;
const EMBEDDING_TIMEOUT_MS = 90_000;

/**
 * OpenAI-compatible embeddings client. Calls are serialized through a queue
 * and sent in batches of up to 32 texts. The first failure (endpoint without
 * embeddings support, network error, bad payload) marks the service
 * unavailable and caches that conclusion until invalidateStatus() is called
 * (settings save) — callers never pay for repeated retries.
 */
export class EmbeddingService {
  private status: EmbeddingStatus = { available: true };
  private probed = false;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly settings: SettingsService) {}

  /** Drop the cached availability conclusion (e.g. after settings change). */
  invalidateStatus(): void {
    this.status = { available: true };
    this.probed = false;
  }

  /** Cached availability; the first call probes the endpoint with a 1-token input. */
  async getStatus(): Promise<EmbeddingStatus> {
    if (!this.probed) await this.embed(['ping']).catch(() => undefined);
    return { ...this.status };
  }

  /** Embed texts in batches; results preserve input order. Throws when unavailable. */
  async embed(texts: string[]): Promise<Float32Array[]> {
    return this.enqueue(() => this.embedQueued(texts));
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.tail.then(task);
    this.tail = run.catch(() => undefined);
    return run;
  }

  private async embedQueued(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    if (!this.status.available) throw new Error(this.status.reason ?? 'Embedding 服务不可用');
    try {
      const vectors: Float32Array[] = [];
      for (let start = 0; start < texts.length; start += EMBEDDING_BATCH_SIZE) {
        vectors.push(...await this.embedBatch(texts.slice(start, start + EMBEDDING_BATCH_SIZE)));
      }
      this.status = { available: true };
      this.probed = true;
      return vectors;
    } catch (error) {
      this.status = {
        available: false,
        reason: error instanceof Error ? error.message : 'embedding 请求失败',
      };
      this.probed = true;
      throw error;
    }
  }

  private async embedBatch(texts: string[]): Promise<Float32Array[]> {
    const llm = this.settings.getRuntimeLlm();
    if (llm.mode === 'custom_byok' && !llm.apiKey) {
      throw new Error('请先在设置中填写 API Key');
    }
    const endpoint = `${llm.baseUrl}/embeddings`;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (llm.mode === 'demo_proxy') headers['x-vesti-service-token'] = llm.serviceToken;
    else headers.authorization = `Bearer ${llm.apiKey}`;

    let response: Response;
    try {
      response = await net.fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: llm.embeddingModel, input: texts }),
        signal: AbortSignal.timeout(EMBEDDING_TIMEOUT_MS),
      });
    } catch (error) {
      throw new Error(`无法连接模型服务：${error instanceof Error ? error.message : '未知网络错误'}`);
    }
    const payload = await response.json().catch(() => ({})) as {
      data?: Array<{ index?: number; embedding?: unknown }>;
      error?: { message?: string } | string;
      message?: string;
    };
    if (!response.ok) {
      const detail = typeof payload.error === 'string' ? payload.error : payload.error?.message || payload.message;
      throw new Error(detail || `embedding 请求失败（HTTP ${response.status}）`);
    }
    if (!Array.isArray(payload.data) || payload.data.length !== texts.length) {
      throw new Error('embedding 响应格式异常');
    }
    const ordered = [...payload.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    return ordered.map(item => {
      if (!Array.isArray(item.embedding)) throw new Error('embedding 响应格式异常');
      return Float32Array.from(item.embedding as number[]);
    });
  }
}
