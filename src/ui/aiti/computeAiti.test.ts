import { describe, expect, it } from "vitest";
import { computeAiti } from "./computeAiti";
import type { ConversationSummaryV2, SummaryRecord } from "../db/types";

function v2(overrides: {
  depthLevel?: "superficial" | "moderate" | "deep";
  emotionalTone?: string;
  insights?: string[];
  unresolved?: string[];
  actionable?: string[];
  techStack?: string[];
  omitMeta?: boolean;
}): ConversationSummaryV2 {
  return {
    core_question: "q",
    thinking_journey: [],
    key_insights: (overrides.insights ?? []).map((term) => ({ term, definition: "d" })),
    unresolved_threads: overrides.unresolved ?? [],
    meta_observations: overrides.omitMeta
      ? undefined
      : {
          thinking_style: "s",
          emotional_tone: overrides.emotionalTone ?? "",
          depth_level: overrides.depthLevel ?? "moderate",
        },
    actionable_next_steps: overrides.actionable ?? [],
    ...(overrides.techStack ? { tech_stack_detected: overrides.techStack } : {}),
  } as ConversationSummaryV2;
}

function record(
  conversationId: number,
  structured: SummaryRecord["structured"],
  createdAt = conversationId,
): SummaryRecord {
  return {
    id: conversationId,
    conversationId,
    content: "",
    structured,
    modelId: "test-model",
    createdAt,
    sourceUpdatedAt: createdAt,
  };
}

describe("computeAiti", () => {
  it("returns the gated empty state below the minimum sample size", () => {
    expect(computeAiti([])).toEqual({ available: false, sampleSize: 0, axes: [], obsessions: [] });

    const four = [1, 2, 3, 4].map((id) => record(id, v2({ depthLevel: "deep" })));
    const gated = computeAiti(four);
    expect(gated.available).toBe(false);
    expect(gated.sampleSize).toBe(4);
    expect(gated.axes).toEqual([]);
    expect(gated.obsessions).toEqual([]);
  });

  it("scores the four axes with evidence once the sample is sufficient", () => {
    const records = [
      // deep, maker (actionable), theorist (2 insights), calm → cool
      record(1, v2({
        depthLevel: "deep",
        emotionalTone: "calm and methodical",
        insights: ["sqlite", "WAL"],
        actionable: ["ship it"],
      })),
      // moderate, neither maker nor theorist, curious → spirited
      record(2, v2({
        depthLevel: "moderate",
        emotionalTone: "curious and excited",
        insights: ["sqlite"],
        unresolved: ["u1"],
      })),
      // superficial, maker, positive sentiment without tone → spirited
      record(3, {
        ...v2({ depthLevel: "superficial", actionable: ["a"], unresolved: ["u1", "u2"], techStack: ["React"] }),
        sentiment: "positive",
      } as ConversationSummaryV2),
      // deep, maker (tech stack), theorist (3 insights), analytical → cool
      record(4, v2({
        depthLevel: "deep",
        emotionalTone: "neutral, analytical",
        insights: ["React", "hooks", "state"],
        techStack: ["React"],
      })),
      // no meta cues at all, three unresolved threads
      record(5, v2({ unresolved: ["u1", "u2", "u3"], omitMeta: true })),
    ];

    const profile = computeAiti(records);
    expect(profile.available).toBe(true);
    expect(profile.sampleSize).toBe(5);
    expect(profile.axes.map((axis) => axis.key)).toEqual(["depth", "maker", "focus", "affect"]);

    const byKey = new Map(profile.axes.map((axis) => [axis.key, axis]));
    // depth: mean of 90, 55, 15, 90 (conv 5 carries no depth cue)
    expect(byKey.get("depth")).toMatchObject({
      score: 63,
      evidenceConversationIds: [1, 4, 2],
      hasSignal: true,
    });
    // maker: 3/5 maker vs 2/5 theorist → 50 + 50 * 0.2
    expect(byKey.get("maker")).toMatchObject({
      score: 60,
      evidenceConversationIds: [1, 3, 4],
      hasSignal: true,
    });
    // focus: mean 1.2 unresolved → 20 + 1.2 * 22
    expect(byKey.get("focus")).toMatchObject({
      score: 46,
      evidenceConversationIds: [5, 3, 2],
      hasSignal: true,
    });
    // affect: 2 spirited vs 2 cool → neutral 50
    expect(byKey.get("affect")).toMatchObject({
      score: 50,
      evidenceConversationIds: [2, 3],
      hasSignal: true,
    });

    // terms recurring in ≥2 conversations, original casing preserved
    expect(profile.obsessions).toEqual([
      { term: "sqlite", count: 2 },
      { term: "React", count: 2 },
    ]);
  });

  it("keeps only the latest summary per conversation", () => {
    const records = [1, 2, 3, 4, 5].map((id) => record(id, v2({ depthLevel: "deep" }), id));
    // A newer summary for conversation 1 overrides the older "deep" one.
    records.push(record(1, v2({ depthLevel: "superficial" }), 100));

    const profile = computeAiti(records);
    expect(profile.sampleSize).toBe(5);
    const depth = profile.axes.find((axis) => axis.key === "depth");
    // mean of 15, 90, 90, 90, 90
    expect(depth?.score).toBe(75);
  });

  it("drops records without usable structure from the sample", () => {
    const records = [
      record(1, v2({ depthLevel: "deep" })),
      record(2, null),
      record(3, v2({ depthLevel: "deep" })),
      record(4, undefined),
      record(5, v2({ depthLevel: "deep" })),
    ];
    const profile = computeAiti(records);
    expect(profile.available).toBe(false);
    expect(profile.sampleSize).toBe(3);
  });
});
