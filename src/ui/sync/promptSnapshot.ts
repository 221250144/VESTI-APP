// Prompt snapshot writer (P6 capsule dock): the floating capsule is a
// separate renderer entry that never loads Dexie, so its 提示词助手 reads a
// file snapshot instead. This module mirrors the user prompt library
// (id/title/description/tags/body/source) into ~/.vesti/cache/
// prompt-snapshot.json via the main process (window.vestiCapsule.
// savePromptSnapshot). Refreshes on startup, on "vesti:data-updated", on
// window focus and on a slow interval; a content hash skips redundant writes.
//
// Outside Electron (no window.vestiCapsule bridge) every entry point is a
// no-op.

import { listPrompts } from "../db/promptRepository";
import type { CapsulePromptSnapshot, VestiCapsuleApi } from "../../shared/contracts";
import { logger } from "../db/logger";

// Keep in sync with PROMPT_SNAPSHOT_MAX_ENTRIES in src/main/capsuleDock.ts
// (main re-validates and caps again on save).
const SNAPSHOT_MAX_ENTRIES = 300;
const DEBOUNCE_MS = 1_000;
const INTERVAL_MS = 60_000;

let started = false;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let lastSerialized = "";
let running: Promise<void> | null = null;
let rerunRequested = false;

function capsuleApi(): VestiCapsuleApi | null {
  return typeof window !== "undefined" && window.vestiCapsule ? window.vestiCapsule : null;
}

async function pushSnapshot(): Promise<void> {
  const api = capsuleApi();
  if (!api) return;
  if (running) {
    rerunRequested = true;
    return running;
  }
  running = (async () => {
    try {
      const prompts = await listPrompts({});
      const snapshot: CapsulePromptSnapshot = {
        updatedAt: Date.now(),
        prompts: prompts.slice(0, SNAPSHOT_MAX_ENTRIES).map((prompt) => ({
          id: String(prompt.id ?? prompt.body_hash ?? prompt.title),
          title: prompt.title,
          description: prompt.summary ?? "",
          tags: Array.isArray(prompt.tags) ? prompt.tags : [],
          body: prompt.body,
          source: prompt.source ?? "manual",
        })),
      };
      // Change detection: only hit IPC/disk when the library actually moved.
      const serialized = JSON.stringify(snapshot.prompts);
      if (serialized === lastSerialized) return;
      await api.savePromptSnapshot(snapshot);
      lastSerialized = serialized;
    } catch (error) {
      logger.warn("service", "Prompt snapshot push failed", {
        error: (error as Error)?.message ?? String(error),
      });
    } finally {
      running = null;
      if (rerunRequested) {
        rerunRequested = false;
        void pushSnapshot();
      }
    }
  })();
  return running;
}

function schedulePush(): void {
  if (debounceTimer !== null) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void pushSnapshot();
  }, DEBOUNCE_MS);
}

/** Start mirroring the prompt library into the capsule-readable snapshot. */
export function startPromptSnapshotSync(): void {
  if (started) return;
  if (!capsuleApi()) {
    // Non-Electron environment (tests, plain browser): no-op.
    return;
  }
  started = true;
  void pushSnapshot();
  window.addEventListener("vesti:data-updated", schedulePush);
  window.addEventListener("focus", schedulePush);
  setInterval(schedulePush, INTERVAL_MS);
}
