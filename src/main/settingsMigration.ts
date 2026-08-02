import type { CapturePlatform, LlmAccessMode } from '../shared/contracts';

export const CURRENT_SETTINGS_VERSION = 5;
export const LEGACY_DEFAULT_BYOK_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
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

  const needsClaudeDefaultMigration = typeof settingsVersion !== 'number' || settingsVersion < 3;
  if (needsClaudeDefaultMigration && !enabled.includes('claude-code')) {
    enabled.push('claude-code');
  }
  return enabled;
}

/**
 * Normalize the optional chat output limit. The previous Demo configuration
 * shipped with 1600 as an implicit product limit, so migrate only that legacy
 * default to Auto. Explicit positive limits (including BYOK's legacy 1600)
 * remain intact.
 */
export function normalizeMaxTokens(
  value: unknown,
  mode: LlmAccessMode,
  settingsVersion: unknown,
): number {
  if (
    (typeof settingsVersion !== 'number' || settingsVersion < CURRENT_SETTINGS_VERSION)
    && mode === 'demo_proxy'
    && value === 1600
  ) {
    return 0;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0;
  return Math.max(1, Math.round(value));
}

/**
 * The old settings schema persisted DashScope's URL even when the user had
 * never selected BYOK. Clear only that implicit value during the v4 -> v5
 * migration. A URL used in BYOK mode (or accompanied by a stored key) is a
 * real user setting and must survive switching back to Demo Proxy.
 */
export function normalizeCustomBaseUrl(
  value: unknown,
  mode: LlmAccessMode,
  apiKeyConfigured: boolean,
  settingsVersion: unknown,
): string {
  const normalized = typeof value === 'string'
    ? value.trim().replace(/\/+$/, '')
    : '';
  const isLegacyImplicitDefault =
    (typeof settingsVersion !== 'number' || settingsVersion < CURRENT_SETTINGS_VERSION)
    && mode === 'demo_proxy'
    && !apiKeyConfigured
    && normalized.toLowerCase() === LEGACY_DEFAULT_BYOK_BASE_URL.toLowerCase();
  return isLegacyImplicitDefault ? '' : normalized;
}
