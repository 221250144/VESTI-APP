// getTopics topic counting: callers that already hold the conversation list
// pass it in so one conversations-table scan serves both the library list and
// the topic tree; without a prefetch getTopics scans the table itself.

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  topicsToArray: vi.fn(),
  conversationsToArray: vi.fn(),
}));

vi.mock("./schema", () => ({
  db: {
    topics: { toArray: mocks.topicsToArray },
    conversations: { toArray: mocks.conversationsToArray },
  },
}));

import { getTopics } from "./repository";

function topicRecord(id: number, name: string) {
  return { id, name, parent_id: null };
}

describe("getTopics", () => {
  beforeEach(() => {
    mocks.topicsToArray.mockReset();
    mocks.conversationsToArray.mockReset();
    mocks.topicsToArray.mockResolvedValue([topicRecord(1, "Work")]);
  });

  it("counts from a prefetched conversation list without rescanning the table", async () => {
    const prefetched = [
      { topic_id: 1 },
      { topic_id: 1 },
      // Archived/trash conversations never count toward a topic.
      { topic_id: 1, is_archived: true },
      { topic_id: 1, is_trash: true },
      { topic_id: null },
    ];

    const topics = await getTopics(prefetched);

    expect(mocks.conversationsToArray).not.toHaveBeenCalled();
    expect(topics).toHaveLength(1);
    expect(topics[0]).toMatchObject({ id: 1, count: 2 });
  });

  it("falls back to scanning the conversations table without a prefetch", async () => {
    mocks.conversationsToArray.mockResolvedValue([
      { topic_id: 1 },
      { topic_id: 1, is_trash: true },
      { topic_id: 1 },
    ]);

    const topics = await getTopics();

    expect(mocks.conversationsToArray).toHaveBeenCalledTimes(1);
    expect(topics[0]).toMatchObject({ id: 1, count: 2 });
  });
});
