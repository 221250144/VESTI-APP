import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettingsUpdate, AppSettingsView } from '../shared/contracts';
import { DEMO_BASE_URL, SettingsService } from './settingsService';

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((value: string) => Buffer.from(value, 'utf8')),
    decryptString: vi.fn((value: Buffer) => value.toString('utf8')),
  },
}));

function toUpdate(settings: AppSettingsView): AppSettingsUpdate {
  return {
    dataDirectory: settings.dataDirectory,
    general: { ...settings.general },
    capture: {
      ...settings.capture,
      enabledPlatforms: [...settings.capture.enabledPlatforms],
    },
    network: { ...settings.network },
    agent: { ...settings.agent },
    llm: {
      mode: settings.llm.mode,
      baseUrl: settings.llm.baseUrl,
      modelId: settings.llm.modelId,
      temperature: settings.llm.temperature,
      maxTokens: settings.llm.maxTokens,
    },
    upstream: {
      obsidianVaultPath: settings.upstream.obsidianVaultPath,
      obsidianAutoExport: settings.upstream.obsidianAutoExport,
      notionParentId: settings.upstream.notionParentId,
      notionParentType: settings.upstream.notionParentType,
      notionTitleProperty: settings.upstream.notionTitleProperty,
    },
  };
}

describe('SettingsService LLM Base URL handling', () => {
  let directory: string;
  let dataDirectory: string;

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vesti-settings-'));
    dataDirectory = path.join(directory, 'data');
  });

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('keeps a fresh BYOK Base URL blank while Demo runtime uses its managed URL', () => {
    const service = new SettingsService(directory, '0.3.0-test');
    const view = service.getView(dataDirectory);

    expect(view.llm.mode).toBe('demo_proxy');
    expect(view.llm.baseUrl).toBe('');
    expect(service.getRuntimeLlm().baseUrl).toBe(DEMO_BASE_URL);
  });

  it('rejects BYOK mode with a clear error when Base URL is blank', async () => {
    const service = new SettingsService(directory, '0.3.0-test');
    const update = toUpdate(service.getView(dataDirectory));
    update.dataDirectory = dataDirectory;
    update.llm.mode = 'custom_byok';
    update.llm.baseUrl = '   ';

    await expect(service.save(update, dataDirectory)).rejects.toThrow(
      'BYOK Base URL cannot be empty',
    );
  });

  it('preserves a saved custom URL while Demo mode remains managed', async () => {
    const service = new SettingsService(directory, '0.3.0-test');
    const custom = toUpdate(service.getView(dataDirectory));
    custom.dataDirectory = dataDirectory;
    custom.llm.mode = 'custom_byok';
    custom.llm.baseUrl = 'https://models.example.com/v1/';
    custom.llm.apiKey = 'secret';
    const customResult = await service.save(custom, dataDirectory);

    expect(customResult.settings.llm.baseUrl).toBe('https://models.example.com/v1');

    const demo = toUpdate(customResult.settings);
    demo.llm.mode = 'demo_proxy';
    const demoResult = await service.save(demo, dataDirectory);

    expect(demoResult.settings.llm.baseUrl).toBe('https://models.example.com/v1');
    expect(service.getRuntimeLlm().baseUrl).toBe(DEMO_BASE_URL);

    const reloaded = new SettingsService(directory, '0.3.0-test');
    await reloaded.initialize();
    expect(reloaded.getView(dataDirectory).llm.baseUrl).toBe('https://models.example.com/v1');
  });
});
