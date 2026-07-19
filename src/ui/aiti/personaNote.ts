// Persona footnote (P5 思维意象): renderer-side cache + trigger for the
// 'persona' agent kind. The note only depends on the type code, the imagery
// copy, and the obsessions set, so it is recomputed solely when that key
// changes; the last note is cached in ui-prefs (same lightweight JSON store
// the theme/language use). Without a configured LLM the whole feature bows
// out — the card then shows only the fixed verdict.

import type { VestiDesktopApi } from "../../shared/contracts";
import type { AitiProfile } from "@vesti/ui";
import type { AitiImagery } from "@vesti/ui";

const PREF_KEY = "aiti.personaNote";

interface PersonaNoteCache {
  key: string;
  note: string;
  createdAt: number;
}

function vestiApi(): VestiDesktopApi | null {
  return typeof window !== "undefined" && window.vesti ? window.vesti : null;
}

function uiPrefs() {
  return typeof window !== "undefined" && window.vestiUi ? window.vestiUi : null;
}

function hashString(value: string): string {
  // djb2 — stable, dependency-free change detector (same idiom as dailyService).
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) + hash + value.charCodeAt(index)) >>> 0;
  }
  return hash.toString(16);
}

/** Cache key: type code + imagery name + obsessions fingerprint. */
export function personaNoteKey(imagery: AitiImagery, profile: AitiProfile): string {
  const obsessions = profile.obsessions.map((o) => `${o.term}:${o.count}`).join(",");
  return `${imagery.code}:${imagery.name}:${hashString(obsessions)}`;
}

function buildPersonaTranscript(
  imagery: AitiImagery,
  profile: AitiProfile,
  sampleLabel: string,
): string {
  const obsessions = profile.obsessions.length
    ? profile.obsessions.map((o) => `${o.term} (×${o.count})`).join("、")
    : "（暂无）";
  return [
    `型码：${imagery.code}`,
    `意象：${imagery.name}`,
    `出典：${imagery.origin}`,
    `判词：${imagery.verdict}`,
    `近期关注：${obsessions}`,
    `样本：${sampleLabel}`,
  ].join("\n");
}

async function isLlmConfigured(api: VestiDesktopApi): Promise<boolean> {
  const settingsView = await api.getSettings().catch(() => null);
  return settingsView
    ? settingsView.llm.mode === "demo_proxy" || settingsView.llm.apiKeyConfigured
    : false;
}

async function readCache(key: string): Promise<string | null> {
  const prefs = uiPrefs();
  if (!prefs) return null;
  const stored = await prefs.getUiPreference(PREF_KEY).catch(() => null);
  if (!stored || typeof stored !== "object") return null;
  const cache = stored as Partial<PersonaNoteCache>;
  return cache.key === key && typeof cache.note === "string" && cache.note.trim()
    ? cache.note
    : null;
}

/**
 * Resolve the persona footnote for the current imagery: cached note when the
 * key matches, otherwise one 'persona' agent run (persist=false) whose result
 * is cached. Resolves null when no LLM is configured or the run fails — the
 * card stays complete with the fixed verdict alone.
 */
export async function getPersonaNote(
  imagery: AitiImagery,
  profile: AitiProfile,
  sampleLabel: string,
): Promise<string | null> {
  const key = personaNoteKey(imagery, profile);
  const cached = await readCache(key);
  if (cached) return cached;

  const api = vestiApi();
  const prefs = uiPrefs();
  if (!api || !(await isLlmConfigured(api))) return null;
  try {
    const result = await api.runAgent({
      kind: "persona",
      sessionId: `persona:${imagery.code}`,
      transcriptOverride: buildPersonaTranscript(imagery, profile, sampleLabel),
      persist: false,
    });
    const note = result.content.trim();
    if (!note) return null;
    await prefs
      ?.setUiPreference(PREF_KEY, { key, note, createdAt: Date.now() } satisfies PersonaNoteCache)
      .catch(() => undefined);
    return note;
  } catch {
    return null;
  }
}
