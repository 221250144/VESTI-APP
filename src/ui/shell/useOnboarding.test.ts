// persistOnboardingCompleted: the regression guard for the skip bug — both
// finishing AND skipping the wizard must persist completed=true, otherwise
// the wizard reappears on every launch.

import { afterEach, describe, expect, it, vi } from "vitest";
import { persistOnboardingCompleted } from "./useOnboarding";

const PREF_KEY = "onboarding.completed";

describe("persistOnboardingCompleted", () => {
  afterEach(() => {
    // Clean up any localStorage stub installed by a test.
    delete (globalThis as Record<string, unknown>).localStorage;
  });

  it("always writes completed=true through the ui-prefs bridge (skip included)", async () => {
    const setUiPreference = vi.fn(async () => {});
    persistOnboardingCompleted({ setUiPreference });
    expect(setUiPreference).toHaveBeenCalledTimes(1);
    expect(setUiPreference).toHaveBeenCalledWith(PREF_KEY, true);
  });

  it("falls back to localStorage with the string \"true\" when no bridge exists", () => {
    const store = new Map<string, string>();
    (globalThis as Record<string, unknown>).localStorage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    };
    persistOnboardingCompleted(undefined);
    expect(store.get(PREF_KEY)).toBe("true");
  });

  it("never throws when persistence is unavailable", () => {
    // No bridge, no localStorage (plain node env): best-effort, stays silent.
    expect(() => persistOnboardingCompleted(undefined)).not.toThrow();
    const failing = {
      setUiPreference: vi.fn((_key: string, _value: unknown): Promise<void> => {
        throw new Error("ipc down");
      }),
    };
    expect(() => persistOnboardingCompleted(failing)).not.toThrow();
  });
});
