import { describe, expect, it } from "vitest";
import { learnTopicSuggestions, LEARN_TOPIC_SUGGESTION_MAX } from "./learnTopics";
import type { LearnDomain, LearnProfile } from "../types";

function domain(topicId: number | null, name: string, count = 1): LearnDomain {
  return {
    topicId,
    name,
    count,
    deep: 0,
    moderate: 0,
    superficial: 0,
    representatives: [],
  };
}

function profile(domains: LearnDomain[]): LearnProfile {
  return { available: domains.length > 0, sampleSize: 10, domains, glossary: [], openLoops: [] };
}

describe("learnTopicSuggestions", () => {
  it("keeps the profile's order (most-studied first) and caps at the max", () => {
    const domains = Array.from({ length: LEARN_TOPIC_SUGGESTION_MAX + 2 }, (_, i) =>
      domain(i + 1, `领域 ${i + 1}`, 100 - i),
    );
    const names = learnTopicSuggestions(profile(domains));
    expect(names).toHaveLength(LEARN_TOPIC_SUGGESTION_MAX);
    expect(names[0]).toBe("领域 1");
  });

  it("drops the uncategorized (unnamed) bucket and blank names", () => {
    const names = learnTopicSuggestions(
      profile([domain(null, "", 50), domain(1, "  ", 40), domain(2, "前端", 30)]),
    );
    expect(names).toEqual(["前端"]);
  });

  it("dedupes case-insensitively, keeping the first occurrence", () => {
    const names = learnTopicSuggestions(
      profile([domain(1, "React", 30), domain(2, "react", 20), domain(3, "Rust", 10)]),
    );
    expect(names).toEqual(["React", "Rust"]);
  });

  it("honors a smaller explicit max and returns [] for an empty map", () => {
    expect(learnTopicSuggestions(profile([domain(1, "前端"), domain(2, "后端")]), 1)).toEqual([
      "前端",
    ]);
    expect(learnTopicSuggestions(profile([]))).toEqual([]);
  });
});
