import type { VestiCapsuleApi } from '../shared/contracts';

/** Safe accessor for the capsule preload bridge (absent in plain-browser dev). */
export function capsuleApi(): VestiCapsuleApi | null {
  return typeof window !== 'undefined' && window.vestiCapsule ? window.vestiCapsule : null;
}
