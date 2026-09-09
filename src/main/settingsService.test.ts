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
      '使用自定义 / BYOK 时必须填写 Base URL。',
    );
  });

  it('localizes the BYOK Base URL error after the UI language', async () => {
    const service = new SettingsService(directory, '0.3.0-test', () => ({ locale: 'en' }));
    const update = toUpdate(service.getView(dataDirectory));
    update.dataDirectory = dataDirectory;
    update.llm.mode = 'custom_byok';
    update.llm.baseUrl = '   ';

    await expect(service.save(update, dataDirectory)).rejects.toThrow(
      'A Base URL is required for Custom / BYOK mode.',
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

describe('SettingsService embedding model (BYOK)', () => {
  let directory: string;
  let dataDirectory: string;

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vesti-settings-'));
    dataDirectory = path.join(directory, 'data');
  });

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('defaults to text-embedding-v1 and round-trips a custom embedding model', async () => {
    const service = new SettingsService(directory, '0.3.0-test');
    expect(service.getView(dataDirectory).llm.embeddingModel).toBe('text-embedding-v1');
    expect(service.getRuntimeLlm().embeddingModel).toBe('text-embedding-v1');

    const update = toUpdate(service.getView(dataDirectory));
    update.dataDirectory = dataDirectory;
    update.llm.embeddingModel = '  text-embedding-3-small  ';
    const result = await service.save(update, dataDirectory);

    expect(result.settings.llm.embeddingModel).toBe('text-embedding-3-small');
    expect(service.getRuntimeLlm().embeddingModel).toBe('text-embedding-3-small');

    const reloaded = new SettingsService(directory, '0.3.0-test');
    await reloaded.initialize();
    expect(reloaded.getView(dataDirectory).llm.embeddingModel).toBe('text-embedding-3-small');
  });

  it('keeps the stored embedding model when the update omits it, and resets on an explicit empty string', async () => {
    const service = new SettingsService(directory, '0.3.0-test');
    const update = toUpdate(service.getView(dataDirectory));
    update.dataDirectory = dataDirectory;
    update.llm.embeddingModel = 'bge-m3';
    await service.save(update, dataDirectory);

    // Older renderers send no embeddingModel field: the stored value survives.
    const legacy = toUpdate(service.getView(dataDirectory));
    legacy.dataDirectory = dataDirectory;
    delete legacy.llm.embeddingModel;
    await service.save(legacy, dataDirectory);
    expect(service.getRuntimeLlm().embeddingModel).toBe('bge-m3');

    // An explicit empty string resets to the default.
    const reset = toUpdate(service.getView(dataDirectory));
    reset.dataDirectory = dataDirectory;
    reset.llm.embeddingModel = '   ';
    const result = await service.save(reset, dataDirectory);
    expect(result.settings.llm.embeddingModel).toBe('text-embedding-v1');
    expect(service.getRuntimeLlm().embeddingModel).toBe('text-embedding-v1');
  });
});

describe('SettingsService agent output language defaults', () => {
  let directory: string;
  let dataDirectory: string;

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vesti-settings-'));
    dataDirectory = path.join(directory, 'data');
  });

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('derives the default output language from the UI locale', () => {
    expect(new SettingsService(directory, '0.3.0-test').getView(dataDirectory).agent.outputLanguage).toBe('zh-CN');
    expect(new SettingsService(directory, '0.3.0-test', () => ({ locale: 'en' })).getView(dataDirectory).agent.outputLanguage).toBe('en-US');
    expect(new SettingsService(directory, '0.3.0-test', () => ({ locale: 'ja' })).getView(dataDirectory).agent.outputLanguage).toBe('ja-JP');
    expect(new SettingsService(directory, '0.3.0-test', () => ({ locale: 'ko' })).getView(dataDirectory).agent.outputLanguage).toBe('ko-KR');
  });

  it('follows UI language changes while the stored value is still a default', async () => {
    const service = new SettingsService(directory, '0.3.0-test');
    // First-ever pref write (no previous locale): factory defaults follow.
    await expect(service.followAgentOutputLanguage(null, 'en-US')).resolves.toBe(true);
    expect(service.getRuntimeAgent().outputLanguage).toBe('en-US');

    // Subsequent switch: still on the old mapping → follows again.
    await expect(service.followAgentOutputLanguage('en-US', 'ja-JP')).resolves.toBe(true);
    expect(service.getRuntimeAgent().outputLanguage).toBe('ja-JP');

    const reloaded = new SettingsService(directory, '0.3.0-test');
    await reloaded.initialize();
    expect(reloaded.getRuntimeAgent().outputLanguage).toBe('ja-JP');
  });

  it('leaves an explicitly chosen output language alone', async () => {
    const service = new SettingsService(directory, '0.3.0-test');
    const update = toUpdate(service.getView(dataDirectory));
    update.dataDirectory = dataDirectory;
    update.agent.outputLanguage = 'ko-KR';
    await service.save(update, dataDirectory);

    await expect(service.followAgentOutputLanguage(null, 'en-US')).resolves.toBe(false);
    await expect(service.followAgentOutputLanguage('zh-CN', 'en-US')).resolves.toBe(false);
    expect(service.getRuntimeAgent().outputLanguage).toBe('ko-KR');
  });

  it('does not rewrite when the mapped language is unchanged', async () => {
    const service = new SettingsService(directory, '0.3.0-test');
    await expect(service.followAgentOutputLanguage('zh-CN', 'zh-CN')).resolves.toBe(false);
    expect(service.getRuntimeAgent().outputLanguage).toBe('zh-CN');
  });
});
