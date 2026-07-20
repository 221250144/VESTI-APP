// 从学习领域选题 (Roundtable ← Learn): derive quick topic chips for the
// roundtable question box from the locally-computed learning map. Pure +
// locale-agnostic; the panel applies the localized question template.

import type { LearnProfile } from "../types";

/** Cap on the chip row — the most-studied few domains, not the whole map. */
export const LEARN_TOPIC_SUGGESTION_MAX = 6;

/** Domain names worth offering as roundtable topics: named domains only (the
 * uncategorized bucket has no name), deduped case-insensitively, in the
 * profile's own order (computeLearn sorts by conversation count, so the
 * most-studied domains come first), capped at `max`. */
export function learnTopicSuggestions(
  profile: LearnProfile,
  max = LEARN_TOPIC_SUGGESTION_MAX,
): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const domain of profile.domains) {
    const name = domain.name.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
    if (names.length >= max) break;
  }
  return names;
}
