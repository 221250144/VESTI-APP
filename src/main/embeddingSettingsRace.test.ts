import { net } from 'electron';
import { beforeEach, expect, it, vi } from 'vitest';
import { EmbeddingService } from './embeddingService';
import type { SettingsService } from './settingsService';

vi.mock('electron', () => ({ net: { fetch: vi.fn() } }));
beforeEach(() => { vi.mocked(net.fetch).mockReset(); });

function setup() {
  const settings = { mode: 'custom_byok', baseUrl: 'https://example.test/v1', apiKey: 'old-key', embeddingModel: 'embed' };
  const service = new EmbeddingService({ getRuntimeLlm: () => settings } as unknown as SettingsService);
  return { settings, service };
}

function response(value: number) {
  return new Response(JSON.stringify({ model: 'embed', data: [{ index: 0, embedding: [value, 1] }] }));
}

it('does not let an old successful request repopulate cache after settings invalidation', async () => {
  let finish!: (value: Response) => void;
  vi.mocked(net.fetch).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  vi.mocked(net.fetch).mockImplementationOnce(async () => response(2));
  const { settings, service } = setup();
  const old = service.embed(['same text']);
  await vi.waitFor(() => expect(net.fetch).toHaveBeenCalledTimes(1));
  settings.apiKey = 'new-key';
  service.invalidateStatus();
  const fresh = service.embed(['same text']);
  finish(response(1));
  await old;
  expect((await fresh)[0][0]).toBe(2);
  expect(net.fetch).toHaveBeenCalledTimes(2);
});

it('does not let an old failed request disable the newly configured endpoint', async () => {
  let fail!: (reason: Error) => void;
  vi.mocked(net.fetch).mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
  vi.mocked(net.fetch).mockImplementationOnce(async () => response(2));
  const { settings, service } = setup();
  const old = service.embed(['same text']).catch(error => error);
  await vi.waitFor(() => expect(net.fetch).toHaveBeenCalledTimes(1));
  settings.apiKey = 'new-key';
  service.invalidateStatus();
  const fresh = service.embed(['same text']);
  fail(new Error('old credential rejected'));
  expect(await old).toBeInstanceOf(Error);
  await expect(fresh).resolves.toHaveLength(1);
  expect(net.fetch).toHaveBeenCalledTimes(2);
});
