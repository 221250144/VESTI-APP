// Ambient capsule bubbles (环境气泡): while the app is in the foreground and
// idle, the owl occasionally surfaces a gentle one-liner — the latest
// dream-log summary first, then a line from the latest daily log, finally a
// fixed pool of quiet prompts. At most one bubble per 45–90 minutes, and the
// whole thing is toggled by the ui-pref 'companion.ambientBubble' (default
// on). Content sources are read-only bridges (window.vesti.listMemoryEntries,
// the Dexie daily-log mirror); scheduling is mounted once from App.tsx.

import type { CapsuleBubbleMood, MemoryEntryView } from "../../shared/contracts";
import { listDailyLogs } from "../db/repository";

export const AMBIENT_BUBBLE_PREF_KEY = "companion.ambientBubble";
/** The gap between two bubbles is randomized inside this window. */
export const AMBIENT_BUBBLE_MIN_GAP_MS = 45 * 60_000;
export const AMBIENT_BUBBLE_MAX_GAP_MS = 90 * 60_000;
/** No pointer/keyboard input for this long before a bubble may appear. */
const AMBIENT_IDLE_REQUIRED_MS = 3 * 60_000;
const AMBIENT_TICK_MS = 60_000;
const AMBIENT_TEXT_MAX_CHARS = 80;

/** 兜底温柔短句池 (rotated randomly when no dream-log / daily content). */
export const AMBIENT_FALLBACK_LINES: readonly string[] = [
  "今天也想听听你的进展。",
  "忙里偷闲，记得喝口水。",
  "有什么新发现吗？我都在。",
  "慢慢来，我帮你记着。",
  "晚点想聊聊今天的收获吗？",
];

export interface AmbientBubbleContent {
  text: string;
  mood: CapsuleBubbleMood;
}

// ---- Pure pieces (unit-tested) ------------------------------------------------

/**
 * One-liner from the latest dream-log entry. The journal summary looks like
 * "整理 N 个会话：新增 X / 更新 Y / …" — surface the touched-memory count,
 * or a quiet no-change note when the run only looked around.
 */
export function dreamLogBubbleText(entry: MemoryEntryView): string | null {
  const summary = entry.summary?.trim();
  if (!summary) return null;
  const added = Number(/新增\s*(\d+)/.exec(summary)?.[1] ?? 0);
  const updated = Number(/更新\s*(\d+)/.exec(summary)?.[1] ?? 0);
  if (added + updated > 0) {
    return `昨晚我整理了 ${added + updated} 条关于你的记忆`;
  }
  return "昨晚的梦境整理好了，记忆都很安定";
}

/** First readable line of a daily log (headings stripped), truncated. */
export function firstDailyLogLine(markdown: string): string | null {
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.replace(/^#+\s*/, "").trim();
    if (!line) continue;
    return line.length > AMBIENT_TEXT_MAX_CHARS
      ? `${line.slice(0, AMBIENT_TEXT_MAX_CHARS - 1)}…`
      : line;
  }
  return null;
}

export function randomGapMs(random: () => number = Math.random): number {
  return (
    AMBIENT_BUBBLE_MIN_GAP_MS +
    Math.floor(random() * (AMBIENT_BUBBLE_MAX_GAP_MS - AMBIENT_BUBBLE_MIN_GAP_MS))
  );
}

// ---- Preference ---------------------------------------------------------------

export async function isAmbientBubbleEnabled(): Promise<boolean> {
  const value = await window.vestiUi
    ?.getUiPreference(AMBIENT_BUBBLE_PREF_KEY)
    .catch(() => null);
  return value !== false;
}

export async function setAmbientBubbleEnabled(enabled: boolean): Promise<void> {
  await window.vestiUi?.setUiPreference(AMBIENT_BUBBLE_PREF_KEY, enabled);
}

// ---- Scheduler -----------------------------------------------------------------

const scheduler = {
  started: false,
  ticking: false,
  lastShownAt: 0,
  nextGapMs: 0,
  lastActiveAt: 0,
  lastText: null as string | null,
};

/** Content priority: latest dream-log → latest daily log line → fallback pool. */
async function pickAmbientBubble(): Promise<AmbientBubbleContent | null> {
  const api = typeof window !== "undefined" ? window.vesti : null;
  if (!api) return null;
  const dreamLog = (
    await api.listMemoryEntries({ kind: "dream-log", limit: 1 }).catch(() => [])
  )[0];
  const dreamText = dreamLog ? dreamLogBubbleText(dreamLog) : null;
  if (dreamText) return { text: dreamText, mood: "sleepy" };
  const daily = (await listDailyLogs().catch(() => []))[0];
  const dailyText = daily ? firstDailyLogLine(daily.contentMarkdown) : null;
  if (dailyText) return { text: dailyText, mood: "warm" };
  const pool = AMBIENT_FALLBACK_LINES;
  return { text: pool[Math.floor(Math.random() * pool.length)], mood: "calm" };
}

async function ambientTick(): Promise<void> {
  if (scheduler.ticking) return;
  scheduler.ticking = true;
  try {
    const now = Date.now();
    if (now - scheduler.lastShownAt < scheduler.nextGapMs) return;
    if (document.visibilityState !== "visible") return;
    if (now - scheduler.lastActiveAt < AMBIENT_IDLE_REQUIRED_MS) return;
    if (!(await isAmbientBubbleEnabled())) return;
    let bubble = await pickAmbientBubble();
    if (!bubble) return;
    if (bubble.text === scheduler.lastText) {
      // Same content twice in a row reads as nagging — fall back to the pool.
      const pool = AMBIENT_FALLBACK_LINES.filter((line) => line !== scheduler.lastText);
      bubble = { text: pool[Math.floor(Math.random() * pool.length)], mood: "calm" };
    }
    scheduler.lastShownAt = now;
    scheduler.nextGapMs = randomGapMs();
    scheduler.lastText = bubble.text;
    await window.vesti?.showCapsuleBubble(bubble).catch(() => undefined);
  } finally {
    scheduler.ticking = false;
  }
}

/**
 * Mount the ambient-bubble loop (idempotent). Runs for the renderer lifetime,
 * like startDreamScheduler; the first bubble is due one full gap after mount.
 */
export function startAmbientBubbleScheduler(): void {
  if (scheduler.started) return;
  scheduler.started = true;
  scheduler.lastShownAt = Date.now();
  scheduler.nextGapMs = randomGapMs();
  scheduler.lastActiveAt = Date.now();
  const markActive = () => {
    scheduler.lastActiveAt = Date.now();
  };
  window.addEventListener("pointerdown", markActive, { passive: true });
  window.addEventListener("keydown", markActive, { passive: true });
  window.addEventListener("wheel", markActive, { passive: true });
  setInterval(() => {
    void ambientTick();
  }, AMBIENT_TICK_MS);
}
