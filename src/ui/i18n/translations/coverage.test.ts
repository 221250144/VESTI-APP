import { describe, expect, it } from 'vitest';
import { enTranslations } from './en';
import { jaTranslations } from './ja';
import { koTranslations } from './ko';
import { jaDesktopCompletion, koDesktopCompletion } from './desktopCompletions';

function deepMerge(base: unknown, override: unknown): unknown {
  if (!override || typeof override !== 'object' || Array.isArray(override)) return override ?? base;
  const output = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(override)) {
    output[key] = key in output ? deepMerge(output[key], value) : value;
  }
  return output;
}

function leafKeys(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [prefix];
  return Object.entries(value).flatMap(([key, child]) =>
    leafKeys(child, prefix ? `${prefix}.${key}` : key),
  );
}

describe('desktop locale coverage', () => {
  const englishKeys = leafKeys(enTranslations).sort();

  it.each([
    ['ja', deepMerge(jaTranslations, jaDesktopCompletion)],
    ['ko', deepMerge(koTranslations, koDesktopCompletion)],
  ])('%s provides every English translation key', (_locale, translations) => {
    expect(leafKeys(translations).sort()).toEqual(englishKeys);
  });
});
