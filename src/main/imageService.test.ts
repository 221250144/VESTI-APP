// ImageService (custom owl DIY): gateway contract (endpoint, service token,
// style-prefixed prompt, transparent background), b64/url response handling,
// on-disk asset persistence + read-back, and credit metering on both modes.

import { net } from 'electron';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CaptureService } from './captureService';
import { CUSTOM_OWL_STYLE_PREFIX, ImageService, type ImageCreditMeter } from './imageService';
import type { RuntimeLlmSettings, SettingsService } from './settingsService';

vi.mock('electron', () => ({
  net: { fetch: vi.fn() },
}));

function runtime(overrides: Partial<RuntimeLlmSettings> = {}): RuntimeLlmSettings {
  return {
    mode: 'demo_proxy',
    baseUrl: 'https://vesti.world/gate/api',
    fallbackBaseUrl: 'https://api.ccvg1218.online/api',
    modelId: 'deepseek-v4-flash',
    temperature: 0.3,
    maxTokens: 0,
    apiKey: '',
    serviceToken: 'test-service-token',
    embeddingModel: 'text-embedding-v1',
    ...overrides,
  };
}

describe('ImageService', () => {
  let dataDirectory: string;
  let service: ImageService;
  let meter: { beforeImage: ReturnType<typeof vi.fn>; afterImage: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.mocked(net.fetch).mockReset();
    dataDirectory = mkdtempSync(path.join(tmpdir(), 'vesti-image-test-'));
    const capture = { activeDataDirectory: dataDirectory } as CaptureService;
    const settings = { getRuntimeLlm: () => runtime() } as unknown as SettingsService;
    meter = { beforeImage: vi.fn(), afterImage: vi.fn() };
    service = new ImageService(capture, settings, meter as ImageCreditMeter);
  });

  afterEach(() => {
    rmSync(dataDirectory, { recursive: true, force: true });
  });

  const pngB64 = Buffer.from('fake-png-bytes').toString('base64');

  it('generates through the gateway /v1 images surface with the style prefix and persists the asset', async () => {
    vi.mocked(net.fetch).mockResolvedValue(
      new Response(JSON.stringify({ data: [{ b64_json: pngB64 }] }), { status: 200 }),
    );

    const asset = await service.generateCustomOwl('青花瓷纹样，淡雅蓝色');

    const [url, init] = vi.mocked(net.fetch).mock.calls[0];
    expect(url).toBe('https://vesti.world/gate/v1/images/generations');
    expect((init?.headers as Record<string, string>)['x-vesti-service-token']).toBe('test-service-token');
    const body = JSON.parse(String(init?.body));
    expect(body.model).toBe('gpt-image-2-high');
    expect(body.background).toBe('transparent');
    expect(body.prompt.startsWith(CUSTOM_OWL_STYLE_PREFIX)).toBe(true);
    expect(body.prompt.endsWith('青花瓷纹样，淡雅蓝色')).toBe(true);

    expect(asset.dataUrl).toBe(`data:image/png;base64,${pngB64}`);
    expect(readFileSync(path.join(dataDirectory, 'skins', 'custom-owl.png'))).toEqual(
      Buffer.from('fake-png-bytes'),
    );
    const meta = JSON.parse(readFileSync(path.join(dataDirectory, 'skins', 'custom-owl.json'), 'utf8'));
    expect(meta.prompt).toBe('青花瓷纹样，淡雅蓝色');
    expect(meter.beforeImage).toHaveBeenCalledTimes(1);
    expect(meter.afterImage).toHaveBeenCalledWith('custom-owl');
  });

  it('reads the persisted asset back as a data URL', async () => {
    vi.mocked(net.fetch).mockResolvedValue(
      new Response(JSON.stringify({ data: [{ b64_json: pngB64 }] }), { status: 200 }),
    );
    await service.generateCustomOwl('午夜星空');

    const asset = await service.readCustomOwl();
    expect(asset?.dataUrl).toBe(`data:image/png;base64,${pngB64}`);
    expect(asset?.updatedAt).toBeGreaterThan(0);
  });

  it('returns null when no custom owl exists yet', async () => {
    expect(existsSync(path.join(dataDirectory, 'skins'))).toBe(false);
    await expect(service.readCustomOwl()).resolves.toBeNull();
  });

  it('downloads the image when the gateway answers with a url instead of b64', async () => {
    vi.mocked(net.fetch)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ url: 'https://cdn.example/owl.png' }] }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(Buffer.from('downloaded-png'), { status: 200 }),
      );
    const asset = await service.generateCustomOwl('像素风');
    expect(asset.dataUrl).toBe(
      `data:image/png;base64,${Buffer.from('downloaded-png').toString('base64')}`,
    );
    expect(vi.mocked(net.fetch).mock.calls[1][0]).toBe('https://cdn.example/owl.png');
  });

  it('surfaces gateway error messages and skips accounting on failure', async () => {
    vi.mocked(net.fetch).mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'content_policy_violation' } }), { status: 400 }),
    );
    await expect(service.generateCustomOwl('奇怪的东西')).rejects.toThrow('content_policy_violation');
    expect(meter.afterImage).not.toHaveBeenCalled();
    await expect(service.readCustomOwl()).resolves.toBeNull();
  });

  it('falls back to the built-in gateway credentials under BYOK mode', async () => {
    const settings = {
      getRuntimeLlm: () => runtime({ mode: 'custom_byok', baseUrl: 'https://api.deepseek.com/v1', serviceToken: '' }),
    } as unknown as SettingsService;
    const capture = { activeDataDirectory: dataDirectory } as CaptureService;
    const byokService = new ImageService(capture, settings, meter as ImageCreditMeter);
    vi.mocked(net.fetch).mockResolvedValue(
      new Response(JSON.stringify({ data: [{ b64_json: pngB64 }] }), { status: 200 }),
    );

    await byokService.generateCustomOwl('陶艺质感');

    const [url, init] = vi.mocked(net.fetch).mock.calls[0];
    expect(url).toBe('https://vesti.world/gate/v1/images/generations');
    expect((init?.headers as Record<string, string>)['x-vesti-service-token']).toBeTruthy();
    // BYOK 用户的图也走我们的网关 → 同样计积分。
    expect(meter.beforeImage).toHaveBeenCalledTimes(1);
    expect(meter.afterImage).toHaveBeenCalledTimes(1);
  });

  it('rejects an empty description before touching the network', async () => {
    await expect(service.generateCustomOwl('   ')).rejects.toThrow('请先描述');
    expect(vi.mocked(net.fetch)).not.toHaveBeenCalled();
  });
});
