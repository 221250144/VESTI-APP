import { describe, expect, it } from 'vitest';
import { normalizeEnabledPlatforms } from './settingsMigration';

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
