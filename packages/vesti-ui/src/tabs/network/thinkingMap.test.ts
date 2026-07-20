import { describe, expect, it } from "vitest";
import type { ChatSummaryData, Conversation } from "../../types";
import { buildThinkingMap } from "./thinkingMap";

const BASE = new Date("2025-01-01T00:00:00Z").getTime();
const DAY_MS = 86_400_000;

function makeConversation(overrides: Partial<Conversation> & { id: number }): Conversation {
  return {
    title: `Conversation ${overrides.id}`,
    platform: "ChatGPT",
    snippet: "",
    tags: [],
    topic_id: null,
    created_at: BASE + overrides.id * DAY_MS,
    updated_at: BASE + overrides.id * DAY_MS,
    is_starred: false,
    is_archived: false,
    is_trash: false,
    message_count: 5,
    ...overrides,
  };
}

function makeSummary(term: string): ChatSummaryData {
  return {
    meta: {
      title: "t",
      generated_at: "2025-01-01",
      tags: [],
      fallback: false,
    },
    core_question: "",
    thinking_journey: [],
    key_insights: [{ term, definition: `def of ${term}` }],
    unresolved_threads: [],
    meta_observations: {
      thinking_style: "",
      communication_pattern: "",
      implicit_assumptions: [],
    },
  } as unknown as ChatSummaryData;
}

describe("buildThinkingMap", () => {
  it("prefers digest key topics over summary key_insights", () => {
    const conversations = [makeConversation({ id: 1 }), makeConversation({ id: 2 })];
    const summaries = new Map<number, ChatSummaryData>([
      [1, makeSummary("insight-term")],
      [2, makeSummary("insight-term")],
    ]);
    const map = buildThinkingMap(conversations, summaries, new Map(), {
      digestTopicsById: new Map([
        [1, ["digest-topic"]],
        [2, ["digest-topic"]],
      ]),
    });
    const terms = map.concepts.map((concept) => concept.term);
    expect(terms).toContain("digest-topic");
    expect(terms).not.toContain("insight-term");
  });

  it("falls back to key_insights when a conversation has no digest topics", () => {
    const conversations = [makeConversation({ id: 1 }), makeConversation({ id: 2 })];
    const summaries = new Map<number, ChatSummaryData>([
      [1, makeSummary("digest-wins")],
      [2, makeSummary("insight-fallback")],
    ]);
    const map = buildThinkingMap(conversations, summaries, new Map(), {
      digestTopicsById: new Map([[1, ["digest-wins"]]]),
    });
    const terms = map.concepts.map((concept) => concept.term);
    expect(terms).toContain("digest-wins");
    expect(terms).toContain("insight-fallback");
  });

  it("caps mention edges per concept while keeping the full id list", () => {
    const conversations = Array.from({ length: 30 }, (_, index) =>
      makeConversation({ id: index + 1 })
    );
    const summaries = new Map<number, ChatSummaryData>(
      conversations.map((conversation) => [
        conversation.id,
        makeSummary("hot-topic"),
      ])
    );
    const map = buildThinkingMap(conversations, summaries, new Map(), {
      maxConversationsPerConcept: 5,
    });
    const concept = map.concepts.find((entry) => entry.term === "hot-topic");
    expect(concept).toBeDefined();
    expect(concept!.conversationIds.length).toBe(30);
    const mentionEdges = map.edges.filter(
      (edge) => edge.type === "mentions" && edge.source === concept!.id
    );
    expect(mentionEdges.length).toBe(5);
    // Mentions keep the most recent conversations.
    const mentionedIds = mentionEdges.map((edge) =>
      Number(edge.target.slice("conv:".length))
    );
    expect(Math.min(...mentionedIds)).toBeGreaterThan(30 - 5);
  });

  it("caps conversation nodes globally to the most recent ones", () => {
    const conversations = Array.from({ length: 20 }, (_, index) =>
      makeConversation({ id: index + 1 })
    );
    // Each pair of conversations shares a distinct topic → many conversation nodes.
    const summaries = new Map<number, ChatSummaryData>(
      conversations.map((conversation) => [
        conversation.id,
        makeSummary(`topic-${Math.ceil(conversation.id / 2)}`),
      ])
    );
    const map = buildThinkingMap(conversations, summaries, new Map(), {
      maxConversationNodes: 6,
      maxConversationsPerConcept: 50,
    });
    expect(map.conversationNodes.length).toBeLessThanOrEqual(6);
    const nodeIds = new Set(map.conversationNodes.map((node) => node.conversationId));
    for (const edge of map.edges) {
      if (edge.type !== "mentions") continue;
      const targetId = Number(edge.target.slice("conv:".length));
      expect(nodeIds.has(targetId)).toBe(true);
    }
  });

  it("builds clusters and gaps deterministically", () => {
    const conversations = [
      makeConversation({ id: 1, topic_id: 1 }),
      makeConversation({ id: 2, topic_id: 1 }),
      makeConversation({ id: 3, topic_id: 2 }),
      makeConversation({ id: 4, topic_id: 2 }),
    ];
    const summaries = new Map<number, ChatSummaryData>([
      [1, makeSummary("alpha")],
      [2, makeSummary("alpha")],
      [3, makeSummary("beta")],
      [4, makeSummary("beta")],
    ]);
    const topicNames = new Map([
      [1, "Topic A"],
      [2, "Topic B"],
    ]);
    const map = buildThinkingMap(conversations, summaries, topicNames);
    expect(map.clusters.length).toBe(2);
    expect(map.concepts.map((concept) => concept.term).sort()).toEqual([
      "alpha",
      "beta",
    ]);
    // alpha and beta never co-occur and sit in different clusters → one gap.
    expect(map.gaps).toHaveLength(1);
    expect(map.timeRange.start).toBeLessThan(map.timeRange.end);
  });
});
