// Dream scheduler: mirrors startDailyScheduler's pattern — an immediate check
// at app launch, then a 10-minute tick. A tick runs the dream pipeline only
// when the auto toggle is on (uiPref, default true), an LLM is configured,
// and no run has completed today yet (memory_meta 'dream.lastRunAt').

import { todayDateString } from "../daily/dailyActivity";
import { runDream } from "./dreamService";

export const DREAM_AUTO_PREF_KEY = "memory.dreamAutoEnabled";

const TICK_MS = 10 * 60_000;

let started = false;
let checking = false;

/** Auto-dream toggle; anything but a stored explicit `false` means on. */
export async function isDreamAutoEnabled(): Promise<boolean> {
  const stored = await window.vestiUi?.getUiPreference(DREAM_AUTO_PREF_KEY).catch(() => null);
  return stored !== false;
}

async function maybeRunDream(): Promise<void> {
  if (checking) return;
  checking = true;
  try {
    const api = typeof window !== "undefined" ? window.vesti : null;
    if (!api) return;
    // 做梦为会员专属: free-tier (expired) accounts never auto-dream, even if
    // the toggle stayed on from a previous membership period.
    const membership = await window.vestiMembership?.getStatus().catch(() => null);
    if (membership && !membership.active) return;
    if (!(await isDreamAutoEnabled())) return;
    const settings = await api.getSettings().catch(() => null);
    const llmConfigured = settings
      ? settings.llm.mode === "demo_proxy" || settings.llm.apiKeyConfigured
      : false;
    if (!llmConfigured) return;
    const lastRunAt =
      Number((await api.getMemoryMeta("dream.lastRunAt").catch(() => null)) ?? 0) || 0;
    if (lastRunAt > 0 && todayDateString(lastRunAt) >= todayDateString()) return;
    await runDream({ mode: "auto" });
  } finally {
    checking = false;
  }
}

/**
 * Start the dream scheduler: an immediate check at launch (covers days missed
 * while the app was off), then a 10-minute tick. Re-entrant safe — a slow run
 * collapses onto the same check.
 */
export function startDreamScheduler(): void {
  if (started) return;
  if (typeof window === "undefined" || !window.vesti) return;
  started = true;
  void maybeRunDream();
  window.setInterval(() => void maybeRunDream(), TICK_MS);
}

/** Persist the auto-dream toggle; enabling takes effect immediately. */
export async function setDreamAutoEnabled(enabled: boolean): Promise<void> {
  await window.vestiUi?.setUiPreference(DREAM_AUTO_PREF_KEY, enabled);
  if (enabled) void maybeRunDream();
}
