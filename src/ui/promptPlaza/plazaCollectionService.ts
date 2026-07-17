// The user's personal 提示词广场: a lightweight set of catalog ids they've
// "加入"d from the 提示词超市. Persisted through the desktop UI-preference
// bridge (window.vestiUi → ui-prefs.json in userData) as plain ids that
// reference the bundled catalog (no prompt duplication). Kept separate from the
// auto-extracted 常用提示词 (DB) so the two shelves stay distinct.

const PREF_KEY = "plaza_adopted";

function normalize(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

let cachedIds: string[] | null = null;
const listeners = new Set<(ids: string[]) => void>();
let bridgeSubscribed = false;

function emit(ids: string[]): void {
  cachedIds = ids;
  for (const listener of listeners) listener(ids);
}

function subscribeBridgeOnce(): void {
  if (bridgeSubscribed || typeof window === "undefined" || !window.vestiUi?.onUiPreferenceChanged) return;
  bridgeSubscribed = true;
  window.vestiUi.onUiPreferenceChanged((key, value) => {
    if (key === PREF_KEY) emit(normalize(value));
  });
}

export async function getAdoptedPlazaIds(): Promise<string[]> {
  subscribeBridgeOnce();
  if (typeof window === "undefined" || !window.vestiUi?.getUiPreference) {
    return cachedIds ?? [];
  }
  try {
    const value = await window.vestiUi.getUiPreference(PREF_KEY);
    cachedIds = normalize(value);
  } catch {
    cachedIds = cachedIds ?? [];
  }
  return cachedIds;
}

async function persist(ids: string[]): Promise<void> {
  if (typeof window === "undefined" || !window.vestiUi?.setUiPreference) return;
  try {
    await window.vestiUi.setUiPreference(PREF_KEY, ids);
  } catch {
    // Persistence is best-effort; local state already updated.
  }
}

/** Add or remove a catalog id; returns the updated set. */
export async function setPlazaAdopted(id: string, adopt: boolean): Promise<string[]> {
  const current = await getAdoptedPlazaIds();
  const set = new Set(current);
  if (adopt) set.add(id);
  else set.delete(id);
  const next = Array.from(set);
  emit(next);
  await persist(next);
  return next;
}

/**
 * Add or remove MANY catalog ids in a single read-modify-write; returns the
 * updated set. Bulk operations must not call setPlazaAdopted in a loop — each
 * call reads the same starting set and the writes clobber each other, so only
 * one change would survive.
 */
export async function setPlazaAdoptedMany(ids: string[], adopt: boolean): Promise<string[]> {
  const current = await getAdoptedPlazaIds();
  const set = new Set(current);
  for (const id of ids) {
    if (adopt) set.add(id);
    else set.delete(id);
  }
  const next = Array.from(set);
  emit(next);
  await persist(next);
  return next;
}

/** Subscribe to changes (e.g. adoption from another view). Returns unsubscribe. */
export function subscribeAdoptedPlazaIds(listener: (ids: string[]) => void): () => void {
  subscribeBridgeOnce();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
