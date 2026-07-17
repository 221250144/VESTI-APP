import type { Platform, UiThemeMode } from "../types";

interface PlatformMetadata {
  label: string;
  hex: string;
  isNew?: boolean;
}

const FALLBACK_PLATFORM: Platform = "ChatGPT";
const DARK_TEXT = "#1A1A1A";
const LIGHT_TEXT = "#FFFFFF";
const WCAG_DARK_REFERENCE = "#000000";

const KIMI_BADGE_TOKENS: Record<UiThemeMode, { backgroundColor: string; color: string }> = {
  light: {
    backgroundColor: "hsl(220 20% 93%)",
    color: "#111111",
  },
  dark: {
    backgroundColor: "hsl(220 20% 16%)",
    color: "#FFFFFF",
  },
};

export const PLATFORM_FILTER_OPTIONS: readonly Platform[] = [
  "ChatGPT",
  "Claude",
  "Gemini",
  "DeepSeek",
  "Qwen",
  "Doubao",
  "Yuanbao",
  "Kimi",
  "Codex",
  "Cursor",
  "Kimi Code",
  "Claude Code",
  "Aider",
];

export const PLATFORM_METADATA: Record<Platform, PlatformMetadata> = {
  ChatGPT: { label: "ChatGPT", hex: "#10A37F" },
  Claude: { label: "Claude", hex: "#CC785C" },
  Gemini: { label: "Gemini", hex: "#AD89EB" },
  DeepSeek: { label: "DeepSeek", hex: "#0D28F3" },
  Qwen: { label: "Qwen", hex: "#C026D3" },
  Doubao: { label: "Doubao", hex: "#1E6FFF" },
  Yuanbao: { label: "Yuanbao", hex: "#00C5A3", isNew: true },
  Kimi: { label: "Kimi", hex: "#181C28", isNew: true },
  Codex: { label: "Codex", hex: "#10A37F" },
  Cursor: { label: "Cursor", hex: "#6B7280" },
  "Kimi Code": { label: "Kimi Code", hex: "#181C28", isNew: true },
  "Claude Code": { label: "Claude Code", hex: "#CC785C" },
  Aider: { label: "Aider", hex: "#E11D48" },
};

function normalizePlatform(platform: Platform | string): Platform {
  if (platform === "YUANBAO") {
    return "Yuanbao";
  }
  if (platform in PLATFORM_METADATA) {
    return platform as Platform;
  }
  return FALLBACK_PLATFORM;
}

function normalizeThemeMode(themeMode?: UiThemeMode): UiThemeMode {
  return themeMode === "dark" ? "dark" : "light";
}

function hexToRgb(hex: string): [number, number, number] {
  const normalized = hex.replace("#", "");
  if (normalized.length !== 6) {
    throw new Error(`Invalid hex color: ${hex}`);
  }

  const r = Number.parseInt(normalized.slice(0, 2), 16);
  const g = Number.parseInt(normalized.slice(2, 4), 16);
  const b = Number.parseInt(normalized.slice(4, 6), 16);

  return [r, g, b];
}

function toLinear(channel: number): number {
  const srgb = channel / 255;
  return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

function contrastRatio(firstHex: string, secondHex: string): number {
  const first = luminance(firstHex);
  const second = luminance(secondHex);
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}

function getAccessibleTextColor(backgroundHex: string): string {
  const darkContrast = contrastRatio(backgroundHex, WCAG_DARK_REFERENCE);
  const lightContrast = contrastRatio(backgroundHex, LIGHT_TEXT);
  return darkContrast >= lightContrast ? DARK_TEXT : LIGHT_TEXT;
}

export function getPlatformLabel(platform: Platform | string): string {
  return PLATFORM_METADATA[normalizePlatform(platform)].label;
}

export function getPlatformHex(platform: Platform | string): string {
  return PLATFORM_METADATA[normalizePlatform(platform)].hex;
}

export function getPlatformTextColor(
  platform: Platform | string,
  themeMode: UiThemeMode = "light"
): string {
  const normalizedPlatform = normalizePlatform(platform);
  if (normalizedPlatform === "Kimi" || normalizedPlatform === "Kimi Code") {
    return KIMI_BADGE_TOKENS[normalizeThemeMode(themeMode)].color;
  }
  return getAccessibleTextColor(getPlatformHex(normalizedPlatform));
}

export function getPlatformBadgeStyle(
  platform: Platform | string,
  themeMode: UiThemeMode = "light"
): {
  backgroundColor: string;
  color: string;
} {
  const normalizedPlatform = normalizePlatform(platform);
  if (normalizedPlatform === "Kimi" || normalizedPlatform === "Kimi Code") {
    return KIMI_BADGE_TOKENS[normalizeThemeMode(themeMode)];
  }

  return {
    backgroundColor: getPlatformHex(normalizedPlatform),
    color: getPlatformTextColor(normalizedPlatform, themeMode),
  };
}
