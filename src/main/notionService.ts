import { net } from 'electron';
import type {
  NotionExportRequest,
  NotionExportResult,
  NotionParentType,
  NotionTestResult,
} from '../shared/contracts';
import type { RuntimeUpstreamSettings, SettingsService } from './settingsService';

// P3 upstream export: thin Notion API client. The renderer builds the page
// payload (title/icon/blocks, already chunked); this service only owns the
// transport — the single network egress goes through net.fetch so it follows
// the configured system proxy, same as AgentService.

const NOTION_API_BASE = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';
const MAX_CHILDREN_PER_REQUEST = 100;
const MAX_RATE_LIMIT_RETRIES = 3;

interface NotionErrorPayload {
  code?: string;
  message?: string;
}

function normalizeNotionId(value: string): string {
  return value.trim().replace(/-/g, '');
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class NotionService {
  constructor(private readonly settings: SettingsService) {}

  async testConnection(): Promise<NotionTestResult> {
    try {
      const upstream = this.settings.getRuntimeUpstream();
      if (!upstream.notionToken) throw new Error('请先填写并保存 Notion Integration Token');
      await this.request('GET', '/users/me', upstream.notionToken);
      if (!upstream.notionParentId) {
        return { ok: true, message: 'Token 有效（尚未填写目标页面 / 数据库 ID）' };
      }
      const resolved = await this.resolveParent(upstream);
      if (!resolved) {
        throw new Error('Token 有效，但找不到目标页面或数据库。请确认已在 Notion 中把目标分享给该 Integration');
      }
      return {
        ok: true,
        message: resolved.type === 'database'
          ? `连接成功：目标是数据库（标题属性 ${resolved.titleProperty}）`
          : '连接成功：目标是页面',
      };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '连接失败' };
    }
  }

  async exportPage(request: NotionExportRequest): Promise<NotionExportResult> {
    const upstream = this.settings.getRuntimeUpstream();
    if (!upstream.notionToken) throw new Error('请先在设置中保存 Notion Integration Token');
    if (!upstream.notionParentId) throw new Error('请先在设置中填写目标页面或数据库 ID');

    // Re-export strategy: archive the old page, then recreate. Deleting all
    // children one-by-one costs one API call per block and hits rate limits;
    // archive + recreate preserves the conversation→page lineage via the
    // stored notion_page_id while keeping every export self-contained.
    if (request.existingPageId) {
      await this.request('PATCH', `/pages/${normalizeNotionId(request.existingPageId)}`, upstream.notionToken, {
        archived: true,
      }).catch(() => undefined);
    }

    let parentType = upstream.notionParentType;
    let titleProperty = upstream.notionTitleProperty;
    if (parentType === 'database' && !titleProperty) {
      const resolved = await this.resolveParent(upstream);
      if (!resolved) throw new Error('找不到目标页面或数据库，请先在设置中重新验证连接');
      parentType = resolved.type;
      titleProperty = resolved.titleProperty;
    }

    const parent = parentType === 'database'
      ? { database_id: normalizeNotionId(upstream.notionParentId) }
      : { page_id: normalizeNotionId(upstream.notionParentId) };
    const titleText = request.title.slice(0, 1_900) || 'Vesti 会话导出';
    const properties = parentType === 'database'
      ? { [titleProperty]: { title: [{ text: { content: titleText } }] } }
      : { title: [{ text: { content: titleText } }] };

    const batches = chunkBlocks(request.blocks, MAX_CHILDREN_PER_REQUEST);
    const body: Record<string, unknown> = {
      parent,
      properties,
      children: batches[0] ?? [],
    };
    if (request.iconEmoji) body.icon = { type: 'emoji', emoji: request.iconEmoji };

    const created = await this.request('POST', '/pages', upstream.notionToken, body) as {
      id?: string;
      url?: string;
    };
    const pageId = typeof created.id === 'string' ? created.id : '';
    if (!pageId) throw new Error('Notion 没有返回页面 ID');

    for (const batch of batches.slice(1)) {
      await this.request('PATCH', `/blocks/${pageId}/children`, upstream.notionToken, {
        children: batch,
      });
    }
    return { pageId, url: typeof created.url === 'string' ? created.url : '' };
  }

  /** Verify the configured parent exists; persists the resolved shape. */
  private async resolveParent(
    upstream: RuntimeUpstreamSettings,
  ): Promise<{ type: NotionParentType; titleProperty: string } | null> {
    const id = normalizeNotionId(upstream.notionParentId);
    if (!id) return null;

    const page = await this.request('GET', `/pages/${id}`, upstream.notionToken)
      .then(() => true)
      .catch(() => false);
    if (page) {
      await this.settings.saveResolvedNotionParent('page', '');
      return { type: 'page', titleProperty: '' };
    }

    try {
      const database = await this.request('GET', `/databases/${id}`, upstream.notionToken) as {
        properties?: Record<string, { type?: string }>;
      };
      const titleProperty = Object.entries(database.properties ?? {})
        .find(([, value]) => value?.type === 'title')?.[0] ?? 'Name';
      await this.settings.saveResolvedNotionParent('database', titleProperty);
      return { type: 'database', titleProperty };
    } catch {
      return null;
    }
  }

  private async request(
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    token: string,
    body?: Record<string, unknown>,
  ): Promise<unknown> {
    for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt += 1) {
      const response = await net.fetch(`${NOTION_API_BASE}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'notion-version': NOTION_VERSION,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
      if (response.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
        const retryAfterSeconds = Number(response.headers.get('retry-after'));
        await delay(Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
          ? retryAfterSeconds * 1_000
          : 1_000 * (attempt + 1));
        continue;
      }
      const payload = await response.json().catch(() => ({})) as NotionErrorPayload;
      if (!response.ok) {
        throw new Error(payload.message || `Notion 请求失败（HTTP ${response.status}）`);
      }
      return payload;
    }
    throw new Error('Notion 请求多次触发限流，请稍后重试');
  }
}

function chunkBlocks<T>(blocks: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < blocks.length; index += size) {
    batches.push(blocks.slice(index, index + size));
  }
  return batches;
}
