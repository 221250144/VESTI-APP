import { describe, expect, it } from "vitest";
import { computeLearn } from "./computeLearn";
import type { Conversation, SummaryRecord, Topic } from "../db/types";

function conv(
  id: number,
  topicId: number | null,
  updatedAt: number,
  flags?: { archived?: boolean; trash?: boolean },
): Conversation {
  return {
    id,
    uuid: `uuid-${id}`,
    platform: "ChatGPT",
    title: `会话 ${id}`,
    snippet: "",
    url: "",
    source_created_at: updatedAt,
    first_captured_at: updatedAt,
    last_captured_at: updatedAt,
    created_at: updatedAt,
    updated_at: updatedAt,
    message_count: 4,
    turn_count: 2,
    is_archived: flags?.archived ?? false,
    is_trash: flags?.trash ?? false,
    tags: [],
    topic_id: topicId,
    is_starred: false,
  };
}

function topic(id: number, name: string): Topic {
  return { id, name, parent_id: null, created_at: 0, updated_at: 0 };
}

function summary(
  conversationId: number,
  depthLevel: "superficial" | "moderate" | "deep" | null,
  createdAt = conversationId,
): SummaryRecord {
  return {
    id: conversationId,
    conversationId,
    content: "",
    structured: depthLevel
      ? {
          core_question: "q",
          thinking_journey: [],
          key_insights: [],
          unresolved_threads: [],
          meta_observations: { thinking_style: "s", emotional_tone: "e", depth_level: depthLevel },
          actionable_next_steps: [],
        }
      : null,
    modelId: "test-model",
    createdAt,
    sourceUpdatedAt: createdAt,
  };
}

describe("computeLearn representative conversations", () => {
  it("ranks representatives deepest-first, then most recent, capped at 3, with titles", () => {
    const conversations = [
      conv(1, 1, 100), // deep but older
      conv(2, 1, 400), // moderate
      conv(3, 1, 500), // superficial — dropped by the cap
      conv(4, 1, 600), // no summary — dropped by the cap
      conv(5, 1, 700), // deep and newest
    ];
    const summaries = [
      summary(1, "deep", 100),
      summary(5, "deep", 200),
      summary(2, "moderate"),
      summary(3, "superficial"),
    ];
    const profile = computeLearn(summaries, [topic(1, "前端")], conversations);
    expect(profile.available).toBe(true);
    const domain = profile.domains.find((d) => d.topicId === 1);
    expect(domain).toBeDefined();
    expect(domain!.representatives).toEqual([
      { conversationId: 5, title: "会话 5" },
      { conversationId: 1, title: "会话 1" },
      { conversationId: 2, title: "会话 2" },
    ]);
  });

  it("keeps archived and trashed conversations out of domains and representatives", () => {
    const conversations = [
      conv(1, 1, 100),
      conv(2, 1, 200, { archived: true }),
      conv(3, 1, 300, { trash: true }),
      conv(4, 1, 400),
    ];
    const summaries = [summary(1, "deep"), summary(2, "deep"), summary(3, "deep"), summary(4, "moderate")];
    const profile = computeLearn(summaries, [topic(1, "前端")], conversations);
    const domain = profile.domains.find((d) => d.topicId === 1);
    expect(domain!.count).toBe(2);
    expect(domain!.representatives.map((r) => r.conversationId)).toEqual([1, 4]);
  });

  it("stays unavailable below the minimum live-sample size", () => {
    const conversations = [conv(1, 1, 100), conv(2, 1, 200)];
    const summaries = [summary(1, "deep"), summary(2, "deep")];
    const profile = computeLearn(summaries, [topic(1, "前端")], conversations);
    expect(profile.available).toBe(false);
  });
});
