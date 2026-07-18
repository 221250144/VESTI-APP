import { useCallback, useEffect, useState } from "react";
import type { UiThemeMode } from "@vesti/ui";

const THEME_PREF_KEY = "theme";

function applyTheme(mode: UiThemeMode): void {
  if (typeof document === "undefined") return;
  document.documentElement.classList.toggle("dark", mode === "dark");
}

function currentDomTheme(): UiThemeMode {
  if (typeof document === "undefined") return "light";
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

/**
 * Desktop theme state, persisted through window.vestiUi (ui-prefs.json) and
 * synced across windows via the ui-pref-changed broadcast.
 */
export function useUiTheme(): {
  themeMode: UiThemeMode;
  toggleTheme: () => Promise<void>;
} {
  const [themeMode, setThemeMode] = useState<UiThemeMode>(currentDomTheme);

  useEffect(() => {
    let cancelled = false;
    const bridge = window.vestiUi;
    if (!bridge) return;

    void bridge
      .getUiPreference(THEME_PREF_KEY)
      .then((value) => {
        if (cancelled) return;
        const mode: UiThemeMode = value === "dark" ? "dark" : "light";
        setThemeMode(mode);
        applyTheme(mode);
      })
      .catch(() => {});

    const unsubscribe = bridge.onUiPreferenceChanged((key, value) => {
      if (cancelled || key !== THEME_PREF_KEY) return;
      const mode: UiThemeMode = value === "dark" ? "dark" : "light";
      setThemeMode(mode);
      applyTheme(mode);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const toggleTheme = useCallback(async () => {
    const next: UiThemeMode = currentDomTheme() === "dark" ? "light" : "dark";
    setThemeMode(next);
    applyTheme(next);
    try {
      await window.vestiUi?.setUiPreference(THEME_PREF_KEY, next);
    } catch {
      // Persistence is best-effort; the DOM state already flipped.
    }
  }, []);

  return { themeMode, toggleTheme };
}
