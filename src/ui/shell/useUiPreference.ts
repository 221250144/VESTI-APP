import { useCallback, useEffect, useState } from "react";

/**
 * Bind a React state pair to a key in the desktop UI-preference store
 * (window.vestiUi → ui-prefs.json). Mirrors writes locally and subscribes to
 * cross-window changes.
 */
export function useUiPreference<T>(
  key: string,
  defaultValue: T,
  normalize: (value: unknown) => T = value => value as T,
): [T, (next: T) => void] {
  const [value, setValue] = useState<T>(defaultValue);

  useEffect(() => {
    let cancelled = false;
    const bridge = window.vestiUi;
    if (!bridge) return;
    void bridge
      .getUiPreference(key)
      .then(stored => {
        if (cancelled || stored === null || stored === undefined) return;
        setValue(normalize(stored));
      })
      .catch(() => {});
    return bridge.onUiPreferenceChanged((changedKey, stored) => {
      if (cancelled || changedKey !== key) return;
      setValue(normalize(stored));
    });
  }, [key]);

  const update = useCallback(
    (next: T) => {
      setValue(next);
      void window.vestiUi?.setUiPreference(key, next).catch(() => {});
    },
    [key],
  );

  return [value, update];
}
