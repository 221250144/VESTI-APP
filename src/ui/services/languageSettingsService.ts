import type { SupportedLocale } from "../i18n/locales";
import { resolveLocale, getBrowserLanguage } from "../i18n/locales";

const LANGUAGE_PREFERENCE_KEY = "language";

export interface LanguageSettings {
  locale: SupportedLocale;
  userOverridden: boolean;
}

export const DEFAULT_LANGUAGE_SETTINGS: LanguageSettings = {
  locale: "en",
  userOverridden: false,
};

/**
 * Desktop persistence bridge. Implemented by the preload layer
 * (see src/preload.ts) and backed by the versioned settings.json in the
 * main process, replacing the extension's chrome.storage.local.
 */
interface UiPreferenceBridge {
  getUiPreference(key: string): Promise<unknown>;
  setUiPreference(key: string, value: unknown): Promise<void>;
  onUiPreferenceChanged(
    listener: (key: string, value: unknown) => void,
  ): () => void;
}

declare global {
  interface Window {
    vestiUi?: UiPreferenceBridge;
  }
}

type Listener = (settings: LanguageSettings) => void;

let current: LanguageSettings = { ...DEFAULT_LANGUAGE_SETTINGS };
let loadPromise: Promise<LanguageSettings> | null = null;
const listeners = new Set<Listener>();
let bridgeSubscribed = false;

function normalizeLanguageSettings(value: unknown): LanguageSettings {
  const draft =
    value && typeof value === "object"
      ? (value as Partial<LanguageSettings>)
      : DEFAULT_LANGUAGE_SETTINGS;
  return {
    locale: resolveLocale(draft.locale ?? "en"),
    userOverridden: Boolean(draft.userOverridden),
  };
}

function emit(next: LanguageSettings): void {
  current = next;
  for (const listener of listeners) listener(next);
}

function subscribeBridgeOnce(): void {
  if (bridgeSubscribed || !window.vestiUi?.onUiPreferenceChanged) return;
  bridgeSubscribed = true;
  window.vestiUi.onUiPreferenceChanged((key, value) => {
    if (key === LANGUAGE_PREFERENCE_KEY) emit(normalizeLanguageSettings(value));
  });
}

export async function getLanguageSettings(): Promise<LanguageSettings> {
  if (!window.vestiUi?.getUiPreference) return current;
  loadPromise ??= window.vestiUi
    .getUiPreference(LANGUAGE_PREFERENCE_KEY)
    .then((value) => {
      current = normalizeLanguageSettings(value);
      return current;
    })
    .catch(() => current);
  return loadPromise;
}

export async function setLanguage(
  locale: SupportedLocale,
  userOverridden = true,
): Promise<void> {
  const next: LanguageSettings = { locale, userOverridden };
  emit(next);
  if (!window.vestiUi?.setUiPreference) return;
  try {
    await window.vestiUi.setUiPreference(LANGUAGE_PREFERENCE_KEY, next);
  } catch {
    // Persistence is best-effort; the in-memory state already updated.
  }
}

export async function detectAndSetLanguage(): Promise<SupportedLocale> {
  const existing = await getLanguageSettings();
  if (existing.userOverridden) return existing.locale;
  const matched = resolveLocale(getBrowserLanguage());
  await setLanguage(matched, false);
  return matched;
}

export function subscribeLanguageSettings(
  listener: Listener,
): () => void {
  subscribeBridgeOnce();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
