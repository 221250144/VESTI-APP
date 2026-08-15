import { describe, expect, it } from 'vitest';
import {
  CURRENT_SETTINGS_VERSION,
  LEGACY_DEFAULT_BYOK_BASE_URL,
  normalizeCustomBaseUrl,
  normalizeEnabledPlatforms,
  normalizeMaxTokens,
} from './settingsMigration';

describe('capture settings migration', () => {
  it('enables Claude Code once when upgrading legacy settings', () => {
    expect(normalizeEnabledPlatforms(['codex', 'cursor', 'kimi-code'], 2)).toEqual([
      'codex', 'cursor', 'kimi-code', 'claude-code',
    ]);
  });

  it('preserves an explicit Claude Code disable after migration', () => {
    expect(normalizeEnabledPlatforms(['codex', 'cursor'], 3)).toEqual(['codex', 'cursor']);
  });

  it('uses all capture sources when no valid saved list exists', () => {
    expect(normalizeEnabledPlatforms(undefined, undefined)).toContain('claude-code');
  });
});

describe('LLM output limit migration', () => {
  it('migrates small legacy Demo caps (1600 and earlier 128) to Auto', () => {
    expect(normalizeMaxTokens(1600, 'demo_proxy', 3)).toBe(0);
    expect(normalizeMaxTokens(128, 'demo_proxy', 3)).toBe(0);
    expect(normalizeMaxTokens(1600, 'custom_byok', 3)).toBe(1600);
    expect(normalizeMaxTokens(128, 'custom_byok', 3)).toBe(128);
  });

  it('preserves explicit positive limits without the old 16384 cap', () => {
    expect(normalizeMaxTokens(4096, 'demo_proxy', 3)).toBe(4096);
    expect(normalizeMaxTokens(32_768, 'demo_proxy', CURRENT_SETTINGS_VERSION)).toBe(32_768);
  });

  it('keeps Auto and rejects invalid limits', () => {
    expect(normalizeMaxTokens(null, 'demo_proxy', CURRENT_SETTINGS_VERSION)).toBe(0);
    expect(normalizeMaxTokens(0, 'custom_byok', CURRENT_SETTINGS_VERSION)).toBe(0);
  });
});

describe('BYOK Base URL migration', () => {
  it('clears the old provider default when it was only an implicit Demo value', () => {
    expect(normalizeCustomBaseUrl(
      LEGACY_DEFAULT_BYOK_BASE_URL,
      'demo_proxy',
      false,
      4,
    )).toBe('');
  });

  it('preserves a previously configured BYOK URL', () => {
    expect(normalizeCustomBaseUrl(
      `${LEGACY_DEFAULT_BYOK_BASE_URL}/`,
      'custom_byok',
      false,
      4,
    )).toBe(LEGACY_DEFAULT_BYOK_BASE_URL);
    expect(normalizeCustomBaseUrl(
      'https://models.example.com/v1/',
      'demo_proxy',
      true,
      4,
    )).toBe('https://models.example.com/v1');
  });

  it('leaves new and empty BYOK values blank', () => {
    expect(normalizeCustomBaseUrl('', 'demo_proxy', false, CURRENT_SETTINGS_VERSION)).toBe('');
    expect(normalizeCustomBaseUrl(undefined, 'demo_proxy', false, CURRENT_SETTINGS_VERSION)).toBe('');
  });
});
