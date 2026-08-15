// Ambient capsule bubbles (环境气泡): while the app is in the foreground and
// idle, the owl occasionally surfaces a gentle one-liner — the latest
// dream-log summary first, then the freshest captured conversation, then a
// line from the latest daily log, finally a fixed pool of quiet prompts. At
// most one bubble per 45–90 minutes, toggled by the ui-pref
// 'companion.ambientBubble' (default on).
//
// Agent completion bubbles (完工提醒): the main-process capture service
// reports when a watched agent session goes quiet after new activity; the
// notifier here applies policy (pref 'companion.agentNotify', cooldown shared
// with ambient bubbles) and shows a spark bubble near the capsule — even when
// the main window is hidden, since the capsule lives on the desktop.
//
// Content sources are read-only bridges (window.vesti.listMemoryEntries,
// the Dexie conversation/daily-log mirrors); schedulers mount once from App.tsx.

import type { AgentActivityPayload, CapsuleBubbleMood, CapturePlatform, MemoryEntryView } from "../../shared/contracts";
import { listDailyLogs } from "../db/repository";
import { db } from "../db/schema";

export const AMBIENT_BUBBLE_PREF_KEY = "companion.ambientBubble";
export const AGENT_NOTIFY_PREF_KEY = "companion.agentNotify";
/** The gap between two bubbles is randomized inside this window. */
export const AMBIENT_BUBBLE_MIN_GAP_MS = 45 * 60_000;
export const AMBIENT_BUBBLE_MAX_GAP_MS = 90 * 60_000;
/** 完工提醒 cooldown — also suppressed when any bubble was shown this recently. */
export const AGENT_NOTIFY_MIN_GAP_MS = 20 * 60_000;
/** Recent conversations older than this don't make small-talk material. */
const RECENT_CONVERSATION_WINDOW_MS = 36 * 60 * 60_000;
/** No pointer/keyboard input for this long before a bubble may appear. */
const AMBIENT_IDLE_REQUIRED_MS = 3 * 60_000;
const AMBIENT_TICK_MS = 60_000;
const AMBIENT_TEXT_MAX_CHARS = 80;

/** Capture-platform id → display label (mirrors main/captureService). */
const PLATFORM_LABELS: Record<CapturePlatform, string> = {
  codex: "Codex",
  cursor: "Cursor",
  "kimi-code": "Kimi Code",
  "claude-code": "Claude Code",
  trae: "Trae",
  coder: "Qoder",
  workbuddy: "WorkBuddy",
};

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

function truncateBubble(text: string, max = 28): string {
  const clean = text.trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** Small-talk line about a recently captured conversation (最新捕获内容源). */
export function recentConversationBubbleText(input: {
  title: string;
  platform: string;
}): string | null {
  const title = truncateBubble(input.title ?? "");
  if (!title) return null;
  const platform = input.platform?.trim();
  return platform
    ? `看到你在 ${platform} 聊了《${title}》，进展顺利吗？`
    : `看到你在聊《${title}》，进展顺利吗？`;
}

/** 完工提醒 copy: platform label + the session the agent just worked on. */
export function agentActivityBubbleText(payload: AgentActivityPayload): string {
  const label = PLATFORM_LABELS[payload.platform] ?? payload.platform;
  const title = truncateBubble(payload.title ?? "");
  return title
    ? `${label} 刚完成了《${title}》的新进展，要去看看吗？`
    : `${label} 刚完成了新进展，要去看看吗？`;
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

export async function isAgentNotifyEnabled(): Promise<boolean> {
  const value = await window.vestiUi
    ?.getUiPreference(AGENT_NOTIFY_PREF_KEY)
    .catch(() => null);
  return value !== false;
}

export async function setAgentNotifyEnabled(enabled: boolean): Promise<void> {
  await window.vestiUi?.setUiPreference(AGENT_NOTIFY_PREF_KEY, enabled);
}

// ---- Scheduler -----------------------------------------------------------------

const scheduler = {
  started: false,
  ticking: false,
  lastShownAt: 0,
  nextGapMs: 0,
  lastActiveAt: 0,
  lastText: null as string | null,
  lastConversationId: null as number | null,
  notifierStarted: false,
};

/** Freshest captured conversation inside the small-talk window; skipped when
 * it is the one the previous bubble already mentioned. */
async function pickRecentConversation(): Promise<AmbientBubbleContent | null> {
  try {
    const records = await db.conversations
      .orderBy("updated_at")
      .reverse()
      .limit(12)
      .toArray();
    const now = Date.now();
    for (const record of records) {
      if (record.is_trash) continue;
      if ((record as { _subagent_of?: unknown })._subagent_of) continue;
      if (typeof record.id === "number" && record.id === scheduler.lastConversationId) continue;
      const updatedAt = typeof record.updated_at === "number" ? record.updated_at : NaN;
      if (!Number.isFinite(updatedAt) || now - updatedAt > RECENT_CONVERSATION_WINDOW_MS) continue;
      const text = recentConversationBubbleText({
        title: record.title ?? "",
        platform: record.platform ?? "",
      });
      if (!text) continue;
      scheduler.lastConversationId = typeof record.id === "number" ? record.id : null;
      return { text, mood: "warm" };
    }
  } catch {
    // Dexie unavailable (early boot) — other sources still apply.
  }
  return null;
}

/** Content priority: latest dream-log → freshest conversation → daily log → pool. */
async function pickAmbientBubble(): Promise<AmbientBubbleContent | null> {
  const api = typeof window !== "undefined" ? window.vesti : null;
  if (!api) return null;
  const dreamLog = (
    await api.listMemoryEntries({ kind: "dream-log", limit: 1 }).catch(() => [])
  )[0];
  const dreamText = dreamLog ? dreamLogBubbleText(dreamLog) : null;
  if (dreamText) return { text: dreamText, mood: "sleepy" };
  const recent = await pickRecentConversation();
  if (recent) return recent;
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

/**
 * Mount the 完工提醒 listener (idempotent). Unlike ambient bubbles this fires
 * on an event rather than a schedule, so there is no idle/visibility gate —
 * the capsule is visible on the desktop even when the main window is not.
 * Cooldown is shared with ambient bubbles so the owl never nags twice in a
 * row.
 */
export function startAgentActivityNotifier(): void {
  if (scheduler.notifierStarted) return;
  scheduler.notifierStarted = true;
  window.vesti?.onAgentActivity((payload) => {
    void (async () => {
      if (!(await isAgentNotifyEnabled())) return;
      const now = Date.now();
      if (now - scheduler.lastShownAt < AGENT_NOTIFY_MIN_GAP_MS) return;
      const text = agentActivityBubbleText(payload);
      scheduler.lastShownAt = now;
      scheduler.lastText = text;
      await window.vesti
        ?.showCapsuleBubble({ text, mood: "spark", timeoutMs: 10_000 })
        .catch(() => undefined);
    })();
  });
}
