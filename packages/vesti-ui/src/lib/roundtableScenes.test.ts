import { describe, expect, it } from "vitest";
import {
  ROUNDTABLE_SCENES,
  sceneMatchesSelection,
  type RoundtableSeatId,
} from "./roundtableScenes";

const SELECTABLE: RoundtableSeatId[] = [
  "skeptic",
  "optimist",
  "pragmatist",
  "domain_expert",
  "devils_advocate",
];

describe("ROUNDTABLE_SCENES", () => {
  it("keeps every lineup within the 2-4 seat bounds, deduped, and made of selectable personas", () => {
    for (const scene of ROUNDTABLE_SCENES) {
      expect(scene.seats.length).toBeGreaterThanOrEqual(2);
      expect(scene.seats.length).toBeLessThanOrEqual(4);
      expect(new Set(scene.seats).size).toBe(scene.seats.length);
      for (const seat of scene.seats) expect(SELECTABLE).toContain(seat);
    }
  });

  it("has unique scene ids", () => {
    const ids = ROUNDTABLE_SCENES.map((scene) => scene.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("sceneMatchesSelection", () => {
  const techReview = ROUNDTABLE_SCENES.find((scene) => scene.id === "tech_review")!;

  it("matches the lineup regardless of selection order", () => {
    expect(
      sceneMatchesSelection(techReview, ["pragmatist", "domain_expert", "skeptic"]),
    ).toBe(true);
  });

  it("rejects subsets, supersets and different lineups", () => {
    expect(sceneMatchesSelection(techReview, ["domain_expert", "skeptic"])).toBe(false);
    expect(
      sceneMatchesSelection(techReview, ["domain_expert", "skeptic", "pragmatist", "optimist"]),
    ).toBe(false);
    expect(
      sceneMatchesSelection(techReview, ["domain_expert", "skeptic", "optimist"]),
    ).toBe(false);
  });
});
