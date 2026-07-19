import { describe, expect, it } from "vitest";
import {
  buildArchivePlan,
  buildBatchTagPlan,
  filterOlderThan,
  findDuplicateGroups,
  findEmptyConversations,
  pickDuplicateKeep,
  type OrganizerConversation,
} from "./organizeRules";

function conversation(
  id: number,
  overrides: Partial<OrganizerConversation> = {},
): OrganizerConversation {
  return {
    id,
    title: `Conversation ${id}`,
    platform: "ChatGPT",
    snippet: "",
    tags: [],
    topic_id: null,
    created_at: 1000,
    updated_at: 1000 + id,
    is_starred: false,
    message_count: 5,
    ...overrides,
  };
}

describe("findEmptyConversations", () => {
  it("matches message_count === 0 and skips trash", () => {
    const rows = [
      conversation(1, { message_count: 0 }),
      conversation(2, { message_count: 3 }),
      conversation(3, { message_count: 0, is_trash: true }),
      conversation(4, { message_count: undefined }),
    ];
    expect(findEmptyConversations(rows).map((row) => row.id)).toEqual([1, 4]);
  });
});

describe("findDuplicateGroups", () => {
  it("groups same platform+uuid across sources, keeping the most complete copy", () => {
    const rows = [
      conversation(1, { uuid: "u-1", _source: "local_terminal", message_count: 10 }),
      conversation(2, { uuid: "u-1", _source: "browser_extension", message_count: 4 }),
      conversation(3, { uuid: "u-2", _source: "local_terminal" }),
    ];
    const groups = findDuplicateGroups(rows);
    expect(groups).toHaveLength(1);
    expect(groups[0].reason).toBe("same_source_id");
    expect(groups[0].keepId).toBe(1);
    expect(groups[0].duplicateIds).toEqual([2]);
  });

  it("ignores same platform+uuid when it only appears from one source", () => {
    const rows = [
      conversation(1, { uuid: "u-1", _source: "local_terminal" }),
      conversation(2, { uuid: "u-1", _source: "local_terminal" }),
    ];
    expect(findDuplicateGroups(rows)).toEqual([]);
  });

  it("groups identical titles across sources", () => {
    const rows = [
      conversation(1, { title: "Refactor auth", _source: "local_terminal" }),
      conversation(2, { title: "Refactor auth", _source: "browser_extension" }),
      conversation(3, { title: "Refactor auth ", _source: "browser_extension" }),
      conversation(4, { title: "Something else", _source: "browser_extension" }),
    ];
    const groups = findDuplicateGroups(rows);
    // id 3 normalizes to the same trimmed title as 1/2.
    expect(groups).toHaveLength(1);
    expect(groups[0].reason).toBe("same_title");
    expect(groups[0].conversations.map((row) => row.id).sort()).toEqual([1, 2, 3]);
  });

  it("a conversation claimed by a uuid group is not re-grouped by title", () => {
    const rows = [
      conversation(1, { uuid: "u-1", title: "Same", _source: "local_terminal" }),
      conversation(2, { uuid: "u-1", title: "Same", _source: "browser_extension" }),
    ];
    const groups = findDuplicateGroups(rows);
    expect(groups).toHaveLength(1);
    expect(groups[0].reason).toBe("same_source_id");
  });

  it("skips trashed rows and keeps a stable keep-order", () => {
    const rows = [
      conversation(1, { uuid: "u-1", _source: "local_terminal", is_trash: true }),
      conversation(2, { uuid: "u-1", _source: "browser_extension" }),
    ];
    expect(findDuplicateGroups(rows)).toEqual([]);

    const keep = pickDuplicateKeep([
      conversation(5, { message_count: 2, updated_at: 50 }),
      conversation(6, { message_count: 2, updated_at: 90 }),
    ]);
    expect(keep.id).toBe(6);
  });
});

describe("buildBatchTagPlan", () => {
  it("skips already-tagged rows (case-insensitive) and trashed rows", () => {
    const rows = [
      conversation(1, { tags: ["reading"] }),
      conversation(2, { tags: ["Paper"] }),
      conversation(3, { tags: [], is_trash: true }),
      conversation(4, { tags: [] }),
    ];
    const plan = buildBatchTagPlan(rows, " paper ");
    expect(plan.map((change) => change.id)).toEqual([1, 4]);
    expect(plan[0].nextTags).toEqual(["reading", "paper"]);
    expect(plan[1].nextTags).toEqual(["paper"]);
  });

  it("respects the 6-tag cap and rejects an empty tag", () => {
    const full = conversation(1, { tags: ["a", "b", "c", "d", "e", "f"] });
    expect(buildBatchTagPlan([full], "g")).toEqual([]);
    expect(buildBatchTagPlan([conversation(2)], "   ")).toEqual([]);
  });
});

describe("buildArchivePlan", () => {
  it("only includes rows whose topic actually changes", () => {
    const rows = [
      conversation(1, { topic_id: null }),
      conversation(2, { topic_id: 7 }),
      conversation(3, { topic_id: 9 }),
      conversation(4, { topic_id: null, is_trash: true }),
    ];
    expect(
      buildArchivePlan(rows, 9).map((change) => [change.id, change.fromTopicId]),
    ).toEqual([
      [1, null],
      [2, 7],
    ]);
    expect(buildArchivePlan(rows, null).map((change) => change.id)).toEqual([2, 3]);
  });
});

describe("filterOlderThan", () => {
  it("keeps only rows last updated before the cutoff", () => {
    const rows = [
      conversation(1, { updated_at: 500 }),
      conversation(2, { updated_at: 1500 }),
      conversation(3, { updated_at: 100, is_trash: true }),
    ];
    expect(filterOlderThan(rows, 1000).map((row) => row.id)).toEqual([1]);
  });
});
