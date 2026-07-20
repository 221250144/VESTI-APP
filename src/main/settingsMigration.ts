import type { CapturePlatform } from '../shared/contracts';

export const CURRENT_SETTINGS_VERSION = 3;
export const PRIMARY_CAPTURE_PLATFORMS: CapturePlatform[] = [
  'codex',
  'cursor',
  'kimi-code',
  'claude-code',
];

/** Normalize persisted capture sources and migrate the v2 Claude Code default. */
export function normalizeEnabledPlatforms(
  value: unknown,
  settingsVersion: unknown,
): CapturePlatform[] {
  const enabled = Array.isArray(value)
    ? [...new Set(value)].filter(
        (platform): platform is CapturePlatform =>
          typeof platform === 'string'
          && PRIMARY_CAPTURE_PLATFORMS.includes(platform as CapturePlatform),
      )
    : [...PRIMARY_CAPTURE_PLATFORMS];

  if (settingsVersion !== CURRENT_SETTINGS_VERSION && !enabled.includes('claude-code')) {
    enabled.push('claude-code');
  }
  return enabled;
}
