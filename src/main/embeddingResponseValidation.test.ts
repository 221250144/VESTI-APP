import { net } from 'electron';
import { beforeEach, expect, it, vi } from 'vitest';
import { EmbeddingService } from './embeddingService';
import type { SettingsService } from './settingsService';
vi.mock('electron', () => ({ net: { fetch: vi.fn() } }));
beforeEach(() => { vi.mocked(net.fetch).mockReset(); });
const service = () => new EmbeddingService({ getRuntimeLlm: () => ({ mode: 'custom_byok', baseUrl: 'https://example.test/v1', apiKey: 'test', embeddingModel: 'embed' }) } as unknown as SettingsService);

it.each([
  [{ index: 0, embedding: [1, 2] }, { index: 0, embedding: [3, 4] }],
  [{ index: 0, embedding: [1, 2] }, { embedding: [3, 4] }],
  [{ index: -1, embedding: [1, 2] }, { index: 1, embedding: [3, 4] }],
])('rejects ambiguous batch indices %#', async (...data) => {
  vi.mocked(net.fetch).mockResolvedValue(new Response(JSON.stringify({ data })));
  await expect(service().embed(['first', 'second'])).rejects.toThrow();
});

it('rejects coordinates that overflow the Float32 storage format', async () => {
  vi.mocked(net.fetch).mockResolvedValue(new Response(JSON.stringify({ data: [{ index: 0, embedding: [1e40, 1] }] })));
  await expect(service().embed(['text'])).rejects.toThrow();
});

it('preserves ordered responses from providers that omit every index', async () => {
  vi.mocked(net.fetch).mockResolvedValue(new Response(JSON.stringify({ data: [{ embedding: [1, 2] }, { embedding: [3, 4] }] })));
  expect((await service().embed(['first', 'second'])).map(v => Array.from(v))).toEqual([[1, 2], [3, 4]]);
});
