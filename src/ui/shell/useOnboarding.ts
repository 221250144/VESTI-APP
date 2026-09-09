// Onboarding hook: manages first-run detection and persistence.
// Uses ui-prefs key "onboarding.completed" to track state.
// Call `useOnboarding(locale)` in the Shell component — when the
// app first launches (after initial sync), the wizard renders.

import { useCallback, useEffect, useState } from "react";
import type { SupportedLocale } from "../i18n/locales";

const ONBOARDING_PREF_KEY = "onboarding.completed";

interface UiPrefsBridge {
  setUiPreference(key: string, value: unknown): Promise<void>;
}

/**
 * Persist onboarding completion. Both finishing AND skipping the wizard call
 * this: a skipped tour must never reappear on the next launch, so the stored
 * value is always true. Exported for node-environment tests (no DOM needed).
 */
export function persistOnboardingCompleted(
  bridge: UiPrefsBridge | undefined = typeof window !== "undefined" ? window.vestiUi : undefined,
): void {
  try {
    if (bridge) {
      void bridge.setUiPreference(ONBOARDING_PREF_KEY, true);
    } else {
      localStorage.setItem(ONBOARDING_PREF_KEY, "true");
    }
  } catch { /* best-effort persistence */ }
}

interface OnboardingState {
  /** True when the wizard should be visible. */
  show: boolean;
  /** Call after the user completes or skips the wizard. */
  complete: () => void;
  skip: () => void;
}

/**
 * Returns onboarding visibility state. The wizard is shown when:
 * 1. The user has never completed onboarding (pref is absent/false), AND
 * 2. The first capture sync has finished (syncReady is true).
 *
 * @param locale - Current locale for the wizard content.
 * @param syncReady - True when the initial sync has completed (conversations loaded).
 */
export function useOnboarding(
  locale: SupportedLocale,
  syncReady: boolean,
): OnboardingState {
  const [completed, setCompleted] = useState<boolean | null>(null);
  const [show, setShow] = useState(false);

  // Read the pref on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (typeof window !== "undefined" && window.vestiUi) {
          const value = await window.vestiUi.getUiPreference(ONBOARDING_PREF_KEY);
          if (!cancelled) setCompleted(value === true);
        } else {
          // Non-Electron fallback: check localStorage.
          if (!cancelled) setCompleted(localStorage.getItem(ONBOARDING_PREF_KEY) === "true");
        }
      } catch {
        if (!cancelled) setCompleted(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Show the wizard when: not completed AND sync is ready AND we know the state.
  useEffect(() => {
    if (completed === false && syncReady) {
      // Small delay so the app UI settles before overlay appears.
      const timer = setTimeout(() => setShow(true), 800);
      return () => clearTimeout(timer);
    }
    setShow(false);
    return undefined;
  }, [completed, syncReady]);

  // Skipping also completes onboarding: both paths persist completed=true so
  // the wizard never reappears on the next launch.
  const persistComplete = useCallback(() => {
    setShow(false);
    setCompleted(true);
    persistOnboardingCompleted();
  }, []);

  return {
    show,
    complete: () => persistComplete(),
    skip: () => persistComplete(),
  };
}
