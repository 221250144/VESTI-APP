import { describe, expect, it } from "vitest";
import type { Conversation, Message } from "../../types";
import {
  buildFollowupsByTurn,
  getConversationTurnCount,
  shouldRenderFollowupsUnderPrompt,
} from "./turnView";

const conversation = (turnCount?: number): Conversation => ({
  id: 1,
  title: "Task",
  platform: "Codex",
  snippet: "",
  tags: [],
  topic_id: null,
  created_at: 1,
  updated_at: 1,
  message_count: 4,
  turn_count: turnCount,
  is_starred: false,
});

const message = (id: number, role: "user" | "ai", turnId: string): Message => ({
  id,
  conversation_id: 1,
  role,
  content_text: String(id),
  created_at: id,
  _turn_id: turnId,
});

describe("turnView", () => {
  it("prefers the captured task count and falls back to unique projected turns", () => {
    const messages = [
      message(1, "user", "turn-1"),
      message(2, "ai", "turn-1"),
      message(3, "user", "turn-2"),
      message(4, "ai", "turn-2"),
    ];

    expect(getConversationTurnCount(conversation(6), messages)).toBe(6);
    expect(getConversationTurnCount(conversation(), messages)).toBe(2);
  });

  it("makes prompt follow-ups available to the matching assistant response", () => {
    const prompt = {
      ...message(1, "user", "turn-1"),
      _followups: [{ id: 11, content_text: "跟进", created_at: 11 }],
    };

    expect(buildFollowupsByTurn([prompt, message(2, "ai", "turn-1")]).get("turn-1"))
      .toEqual(prompt._followups);
  });

  it("keeps follow-ups under an unfinished prompt when response placement is selected", () => {
    const prompt = {
      ...message(1, "user", "turn-1"),
      _followups: [{ id: 11, content_text: "跟进", created_at: 11 }],
    };

    expect(shouldRenderFollowupsUnderPrompt(prompt, "under_prompt", new Set()))
      .toBe(true);
    expect(shouldRenderFollowupsUnderPrompt(prompt, "inside_response", new Set()))
      .toBe(true);
    expect(shouldRenderFollowupsUnderPrompt(
      prompt,
      "inside_response",
      new Set(["turn-1"]),
    )).toBe(false);
  });
});
