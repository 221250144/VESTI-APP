// P3 upstream export: incremental Obsidian auto-export trigger.
//
// After each capture sync (signalled by the "vesti:data-updated" DOM event),
// debounce ~15s then export every conversation that has never been exported
// and has no recorded failure. Failures are stored on the conversation and
// surfaced in Settings instead of being retried forever.

import { exportPendingConversationsToObsidian } from "./obsidianExport";

const AUTO_EXPORT_DEBOUNCE_MS = 15_000;

let timer: number | null = null;
let running = false;
let started = false;

async function runAutoExport(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const settings = await window.vesti.getSettings();
    if (!settings.upstream.obsidianAutoExport || !settings.upstream.obsidianVaultPath.trim()) {
      return;
    }
    await exportPendingConversationsToObsidian();
  } catch (error) {
    console.warn("[vesti] obsidian auto-export failed", error);
  } finally {
    running = false;
  }
}

/** Debounced scan; also called directly when the settings toggle turns on. */
export function scheduleUpstreamAutoExport(): void {
  if (timer !== null) window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    timer = null;
    void runAutoExport();
  }, AUTO_EXPORT_DEBOUNCE_MS);
}

/** App entry: subscribe once, mirroring startAutoClassifyTrigger. */
export function startUpstreamAutoExport(): void {
  if (started) return;
  started = true;
  window.addEventListener("vesti:data-updated", scheduleUpstreamAutoExport);
}
