import type { UiThemeMode } from "../../types";

/**
 * 恒星光谱色（未摘要节点着色，docs/conversation-sphere-design.md §4.3 追加）。
 *
 * 语义：会话最近活跃时间（GraphNode.lastCapturedAt）距今天数 → 恒星温度——
 * 还在燃烧的会话是蓝白热星，久置不碰的会话冷却成红星（"星星随时间冷却"）。
 * 颜色序列参考哈佛光谱分类 O/B→A→F→G→K→M（参宿七蓝白 → 天狼星白 → 太阳淡黄
 * → 大角星淡橙 → 参宿四淡红），但全部低饱和：真实恒星颜色本就是淡色，与
 * 高饱和的情绪色（emotionColors.ts）天然可辨——未摘要的是"真实的星"，
 * 有摘要的是"有故事的星"。
 *
 * 纯函数、按天量化：同一天内同一会话颜色不变；颜色随墙钟以天为粒度缓慢
 * 冷却（布局位置永远确定，不受墙钟影响——§4 确定性约束只锁位置）。温度
 * 量化到有限档：光晕 sprite 缓存按颜色字符串索引，必须保持有界。
 */

const DAY_MS = 86_400_000;
/** 冷却时间常数：距今这么多天以上的会话落到最冷档（M 淡红）。 */
const COOLING_DAYS = 45;
/** 温度量化档数：连续观感 + 有界的 sprite 缓存。 */
const TEMPERATURE_STEPS = 24;

interface SpectralWaypoint {
  /** Temperature position in [0, 1] (0 = hottest). */
  t: number;
  dark: string;
  light: string;
}

/** 哈佛光谱序列 B→M 的淡色版（dark = 深空上发光，light = 纸面上可读）。 */
const SPECTRAL_WAYPOINTS: ReadonlyArray<SpectralWaypoint> = [
  { t: 0, dark: "#A9C2EE", light: "#6E8FC4" }, // B 蓝白（参宿七）
  { t: 0.3, dark: "#D6D9DE", light: "#8F9299" }, // A 白（天狼星，≈ 原中性灰白）
  { t: 0.5, dark: "#E6E1C6", light: "#A39D7A" }, // F 黄白
  { t: 0.7, dark: "#ECD9A6", light: "#AF9A5C" }, // G 淡黄（太阳）
  { t: 0.85, dark: "#F0C298", light: "#B57F4E" }, // K 淡橙（大角星）
  { t: 1, dark: "#E9A08E", light: "#B25A48" }, // M 淡红（参宿四/心宿二）
];

function hexToRgb(hex: string): [number, number, number] {
  const normalized = hex.replace("#", "");
  return [
    Number.parseInt(normalized.slice(0, 2), 16),
    Number.parseInt(normalized.slice(2, 4), 16),
    Number.parseInt(normalized.slice(4, 6), 16),
  ];
}

function lerpHex(left: string, right: string, t: number): string {
  const a = hexToRgb(left);
  const b = hexToRgb(right);
  const channel = (index: number) =>
    Math.round(a[index] + (b[index] - a[index]) * t)
      .toString(16)
      .padStart(2, "0");
  return `#${channel(0)}${channel(1)}${channel(2)}`.toUpperCase();
}

/** 距今天数 → 恒星温度 t ∈ [0,1]（0 = 最热）。按天量化；sqrt easing 让近
 * 端差异更敏感——昨天和上周的区别要大，半年前和一年前的区别无所谓。 */
export function getStellarTemperature(lastCapturedAt: number, nowMs: number): number {
  const days = Math.max(
    0,
    Math.floor(nowMs / DAY_MS) - Math.floor(lastCapturedAt / DAY_MS)
  );
  const eased = Math.sqrt(Math.min(1, days / COOLING_DAYS));
  // floor 而非 round：不到冷却期满不许多占最冷档（round 会把 44 天四舍五入成 1）。
  return Math.floor(eased * TEMPERATURE_STEPS) / TEMPERATURE_STEPS;
}

/** 未摘要星的颜色：lastCapturedAt 越久远越冷（红），越近越热（蓝白）。 */
export function getStellarColor(
  lastCapturedAt: number,
  nowMs: number,
  themeMode: UiThemeMode
): string {
  const temperature = getStellarTemperature(lastCapturedAt, nowMs);
  const points = SPECTRAL_WAYPOINTS;
  if (temperature <= points[0].t) return points[0][themeMode];
  const last = points[points.length - 1];
  if (temperature >= last.t) return last[themeMode];
  let upper = 1;
  while (points[upper].t < temperature) upper += 1;
  const lower = points[upper - 1];
  const span = points[upper].t - lower.t;
  return lerpHex(lower[themeMode], points[upper][themeMode], (temperature - lower.t) / span);
}
