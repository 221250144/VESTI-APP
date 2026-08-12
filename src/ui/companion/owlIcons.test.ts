// Regression test: the glob map must actually populate every mood — an early
// version checked `id in ICONS` on an initially-empty object and produced an
// empty map (chat silently fell back to the monogram).
import { describe, expect, it } from "vitest";

import { OWL_MOOD_ICONS } from "./owlIcons";

describe("OWL_MOOD_ICONS", () => {
  it("resolves a URL for every companion mood", () => {
    for (const mood of ["calm", "thinking", "delighted", "spark", "sleepy", "warm"] as const) {
      expect(OWL_MOOD_ICONS[mood], `missing icon for mood ${mood}`).toBeTruthy();
    }
  });
});
