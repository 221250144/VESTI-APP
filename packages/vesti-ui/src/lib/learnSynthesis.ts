// 路线级 LLM 合成 (Learn route synthesis): the fingerprint helper shared by
// the host-side orchestration (src/ui/learn/learnSynthesis) and the LearnCard
// view, so both sides key the synthesis cache the same way. Pure.

import type { LearnDomain } from "../types";

/** Version tag baked into every fingerprint — bump it when the fingerprint
 * inputs change so stale cache entries simply miss. v2: synthesis prompt now
 * asks for condensed parent-topic titles, so v1 caches hold stale naming. */
const FINGERPRINT_VERSION = "v2";

/**
 * Route fingerprint: a stable hash of the route's member conversation id set.
 * A route whose membership didn't change keeps its synthesis; any member
 * added/removed flips the hash and only that route re-synthesizes. Hand-built
 * profiles without `memberIds` fall back to the representative ids.
 */
export function learnRouteFingerprint(domain: LearnDomain): string {
  const ids = (
    domain.memberIds && domain.memberIds.length > 0
      ? domain.memberIds
      : domain.representatives.map((rep) => rep.conversationId)
  )
    .slice()
    .sort((a, b) => a - b);
  // FNV-1a 32-bit over the joined id list — deterministic across platforms,
  // no crypto needed for a cache key.
  const key = ids.join(",");
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${FINGERPRINT_VERSION}:${(hash >>> 0).toString(16)}`;
}
