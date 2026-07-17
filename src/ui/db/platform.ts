import type { Platform } from "./types";

export const PLATFORM_LABELS: Record<Platform, string> = {
  ChatGPT: "ChatGPT",
  Claude: "Claude",
  Gemini: "Gemini",
  DeepSeek: "DeepSeek",
  Qwen: "Qwen",
  Doubao: "Doubao",
  Kimi: "Kimi",
  Yuanbao: "Yuanbao",
  Codex: "Codex",
  Cursor: "Cursor",
  "Kimi Code": "Kimi Code",
  "Claude Code": "Claude Code",
  Aider: "Aider",
};

export const SUPPORTED_PLATFORMS: readonly Platform[] = [
  "ChatGPT",
  "Claude",
  "Gemini",
  "DeepSeek",
  "Qwen",
  "Doubao",
  "Kimi",
  "Yuanbao",
  "Codex",
  "Cursor",
  "Kimi Code",
  "Claude Code",
  "Aider",
];

const LEGACY_PLATFORM_ALIASES: Record<string, Platform> = {
  YUANBAO: "Yuanbao",
};

export function isPlatform(value: unknown): value is Platform {
  return typeof value === "string" && value in PLATFORM_LABELS;
}

export function normalizePlatform(value: unknown): Platform | undefined {
  if (isPlatform(value)) {
    return value;
  }
  if (typeof value === "string") {
    return LEGACY_PLATFORM_ALIASES[value];
  }
  return undefined;
}

export function getPlatformLabel(value: unknown): string {
  const platform = normalizePlatform(value);
  if (platform) {
    return PLATFORM_LABELS[platform];
  }
  return typeof value === "string" ? value : "";
}
