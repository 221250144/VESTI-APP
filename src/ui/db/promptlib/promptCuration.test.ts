import { describe, expect, it } from "vitest";
import { selectClustersForExtraction } from "./promptCuration";
import type { ScannedPromptCluster } from "./promptScanner";

function cluster(overrides: Partial<ScannedPromptCluster>): ScannedPromptCluster {
  return {
    key: overrides.key ?? `key-${Math.random().toString(36).slice(2)}`,
    title: "title",
    body: "body",
    count: 1,
    sourceCount: 1,
    sources: [],
    score: 0.5,
    tags: [],
    category: null,
    ...overrides,
  };
}

describe("selectClustersForExtraction", () => {
  it("returns an empty selection for empty input", () => {
    expect(selectClustersForExtraction([])).toEqual([]);
  });

  it("keeps recurring patterns that clear the quality gate", () => {
    const recurring = cluster({ key: "a", sourceCount: 3, score: 0.6 });
    const weak = cluster({ key: "b", sourceCount: 4, score: 0.3 });
    const oneOff = cluster({ key: "c", sourceCount: 1, score: 0.95 });
    const selected = selectClustersForExtraction([recurring, weak, oneOff], {
      maxSingletonTopUp: 0,
    });
    expect(selected.map((item) => item.key)).toEqual(["a"]);
  });

  // Regression: the old gates (>= 4 conversations AND score >= 0.62, zero
  // floor) made extraction deterministically return 0 on real libraries.
  it("still produces output when nothing recurs across 4+ conversations", () => {
    const clusters = [
      cluster({ key: "a", sourceCount: 1, score: 0.8 }),
      cluster({ key: "b", sourceCount: 2, score: 0.55 }),
      cluster({ key: "c", sourceCount: 1, score: 0.7 }),
    ];
    const selected = selectClustersForExtraction(clusters);
    expect(selected.length).toBeGreaterThan(0);
    expect(selected.map((item) => item.key)).toContain("b");
  });

  it("tops up to the floor with high-quality one-offs when too few recur", () => {
    const clusters = [
      cluster({ key: "top1", sourceCount: 1, score: 0.9 }),
      cluster({ key: "top2", sourceCount: 1, score: 0.8 }),
      cluster({ key: "low", sourceCount: 1, score: 0.4 }),
    ];
    const selected = selectClustersForExtraction(clusters);
    expect(selected.map((item) => item.key)).toEqual(["top1", "top2"]);
  });

  it("never tops up beyond the floor or with below-gate one-offs", () => {
    const clusters = [
      cluster({ key: "recur", sourceCount: 2, score: 0.9 }),
      cluster({ key: "one1", sourceCount: 1, score: 0.95 }),
      cluster({ key: "one2", sourceCount: 1, score: 0.85 }),
      cluster({ key: "one3", sourceCount: 1, score: 0.75 }),
      cluster({ key: "trash", sourceCount: 1, score: 0.2 }),
    ];
    const selected = selectClustersForExtraction(clusters);
    // floor is 3: recurring + two best one-offs; the third one-off and the
    // below-gate entry stay out.
    expect(selected.map((item) => item.key)).toEqual(["recur", "one1", "one2"]);
  });

  it("respects the hard result cap", () => {
    const clusters = Array.from({ length: 20 }, (_, index) =>
      cluster({ key: `k${index}`, sourceCount: 5, score: 0.9 }),
    );
    expect(selectClustersForExtraction(clusters, { maxResults: 6 })).toHaveLength(6);
  });

  it("ranks frequency and quality together", () => {
    const frequentWeak = cluster({ key: "freq", sourceCount: 6, score: 0.5 });
    const rareStrong = cluster({ key: "rare", sourceCount: 2, score: 0.9 });
    const selected = selectClustersForExtraction([frequentWeak, rareStrong], {
      maxSingletonTopUp: 0,
    });
    // rare: 0.9*0.5 + (2/6)*0.5 ≈ 0.62; freq: 0.5*0.5 + 1*0.5 = 0.75
    expect(selected[0].key).toBe("freq");
  });
});
