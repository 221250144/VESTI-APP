import { describe, expect, it } from "vitest";
import type { Conversation, ConversationTree, Topic } from "../../types";
import {
  buildConversationTreeLookup,
  buildSourceTreeModel,
  collectTopicSubtreeIds,
  describeSelection,
  filterConversationsBySelection,
  resolveConversationPlacement,
  type DesktopSourceFields,
  type SourceSelection,
} from "./sourceTree";

type TestConversation = Conversation & DesktopSourceFields;

function conversation(
  id: number,
  overrides: Partial<TestConversation> = {},
): TestConversation {
  return {
    id,
    title: `Conversation ${id}`,
    platform: "Claude Code",
    snippet: "",
    tags: [],
    topic_id: null,
    created_at: 1000,
    updated_at: 2000,
    is_starred: false,
    ...overrides,
  };
}

function session(id: string) {
  return {
    id,
    title: id,
    messageCount: 1,
    lastActivityAt: 0,
    oneLiner: null,
    keyTopics: [],
    keyFiles: [],
    decisions: [],
  };
}

const TREE: ConversationTree = {
  generatedAt: "2026-07-18T00:00:00.000Z",
  sources: [
    {
      platform: "claude-code",
      host: "native",
      projects: [
        {
          projectKey: "cli_aaa",
          label: "vesti-app",
          pathOrDomain: "C:/dev/vesti-app",
          sessions: [session("claude-code:s1"), session("claude-code:s2")],
        },
        {
          projectKey: "cli_bbb",
          label: "other",
          pathOrDomain: "C:/dev/other",
          sessions: [session("claude-code:s3")],
        },
      ],
    },
    {
      platform: "claude-code",
      host: "wsl:Ubuntu",
      projects: [
        {
          projectKey: "cli_ccc",
          label: "wsl-proj",
          pathOrDomain: "/home/u/proj",
          sessions: [session("claude-code:wsl-Ubuntu-s4")],
        },
      ],
    },
    {
      platform: "browser",
      host: "browser",
      projects: [
        {
          projectKey: "web:chatgpt.com",
          label: "chatgpt.com",
          pathOrDomain: "chatgpt.com",
          sessions: [session("browser:9")],
        },
      ],
    },
  ],
};

const TOPICS: Topic[] = [
  {
    id: 1,
    name: "Work",
    parent_id: null,
    created_at: 0,
    updated_at: 0,
    children: [
      {
        id: 2,
        name: "Backend",
        parent_id: 1,
        created_at: 0,
        updated_at: 0,
        children: [],
      },
    ],
  },
  { id: 3, name: "Life", parent_id: null, created_at: 0, updated_at: 0, children: [] },
];

const LOOKUP = buildConversationTreeLookup(TREE);

const c1 = conversation(1, {
  _source: "local_terminal",
  _cli_id: "claude-code:s1",
  topic_id: 2,
});
const c2 = conversation(2, {
  _source: "local_terminal",
  _cli_id: "claude-code:s2",
  topic_id: 1,
});
const c3 = conversation(3, {
  _source: "local_terminal",
  _cli_id: "claude-code:s3",
});
const c4 = conversation(4, {
  _source: "local_terminal",
  _cli_id: "claude-code:wsl-Ubuntu-s4",
  topic_id: 3,
});
const c5 = conversation(5, {
  platform: "ChatGPT",
  _source: "browser_extension",
  url: "https://chatgpt.com/c/xyz",
});
const cTrashed = conversation(6, {
  _source: "local_terminal",
  _cli_id: "claude-code:s1",
  is_trash: true,
});
const cArchived = conversation(7, {
  _source: "local_terminal",
  _cli_id: "claude-code:s2",
  is_archived: true,
});
const ALL = [c1, c2, c3, c4, c5, cTrashed, cArchived];

describe("resolveConversationPlacement", () => {
  it("joins CLI rows by _cli_id (exact session id match, incl. WSL)", () => {
    expect(resolveConversationPlacement(c4, LOOKUP)).toEqual({
      source: { platform: "claude-code", host: "wsl:Ubuntu" },
      projectKey: "cli_ccc",
    });
  });

  it("falls back to the normalized project path", () => {
    const row = conversation(10, {
      _source: "local_terminal",
      _project_path: "c:/dev/vesti-app/",
    });
    expect(resolveConversationPlacement(row, LOOKUP)).toEqual({
      source: { platform: "claude-code", host: "native" },
      projectKey: "cli_aaa",
    });
  });

  it("groups browser-extension rows by URL domain", () => {
    expect(resolveConversationPlacement(c5, LOOKUP)).toEqual({
      source: { platform: "browser", host: "browser" },
      projectKey: "web:chatgpt.com",
    });
  });

  it("returns null for rows without known lineage", () => {
    expect(resolveConversationPlacement(conversation(11), LOOKUP)).toBeNull();
  });
});

describe("buildSourceTreeModel", () => {
  const model = buildSourceTreeModel({
    tree: TREE,
    conversations: ALL,
    topics: TOPICS,
    lookup: LOOKUP,
  });

  it("aggregates conversation counts per source and project", () => {
    expect(model.sources.map((s) => [s.platform, s.host, s.count])).toEqual([
      ["claude-code", "native", 3],
      ["claude-code", "wsl:Ubuntu", 1],
      ["browser", "browser", 1],
    ]);
    const native = model.sources[0];
    expect(native.projects.map((p) => [p.projectKey, p.count])).toEqual([
      ["cli_aaa", 2],
      ["cli_bbb", 1],
    ]);
  });

  it("excludes trashed and archived conversations from counts", () => {
    // cTrashed/cArchived share sessions with c1/c2; counts above already prove
    // exclusion, assert the total explicitly.
    const total = model.sources.reduce((sum, s) => sum + s.count, 0);
    expect(total).toBe(5);
  });

  it("prunes the topics tree per project and rolls child counts into parents", () => {
    const project = model.sources[0].projects[0];
    expect(project.topics).toHaveLength(1);
    const work = project.topics[0];
    expect(work.id).toBe(1);
    // c2 direct + c1 via child "Backend"
    expect(work.count).toBe(2);
    expect(work.children).toHaveLength(1);
    expect(work.children[0]).toMatchObject({ id: 2, count: 1 });
    // Topic "Life" is unused in cli_aaa → pruned there, present in cli_ccc.
    const wslProject = model.sources[1].projects[0];
    expect(wslProject.topics.map((t) => t.id)).toEqual([3]);
  });

  it("returns an empty model without a tree", () => {
    expect(
      buildSourceTreeModel({ tree: null, conversations: ALL, topics: TOPICS })
        .sources,
    ).toEqual([]);
  });
});

describe("filterConversationsBySelection", () => {
  const ids = (rows: TestConversation[]) => rows.map((row) => row.id);

  it("returns the input untouched without a selection", () => {
    expect(filterConversationsBySelection(ALL, null, LOOKUP, TOPICS)).toBe(ALL);
  });

  it("filters by source (platform+host, native vs WSL distinguished)", () => {
    const native: SourceSelection = {
      kind: "source",
      source: { platform: "claude-code", host: "native" },
    };
    expect(ids(filterConversationsBySelection(ALL, native, LOOKUP, TOPICS))).toEqual(
      [1, 2, 3, 6, 7],
    );
    const wsl: SourceSelection = {
      kind: "source",
      source: { platform: "claude-code", host: "wsl:Ubuntu" },
    };
    expect(ids(filterConversationsBySelection(ALL, wsl, LOOKUP, TOPICS))).toEqual([4]);
  });

  it("filters by project", () => {
    const selection: SourceSelection = {
      kind: "project",
      source: { platform: "claude-code", host: "native" },
      projectKey: "cli_aaa",
    };
    expect(ids(filterConversationsBySelection(ALL, selection, LOOKUP, TOPICS))).toEqual(
      [1, 2, 6, 7],
    );
  });

  it("filters by topic incl. the whole subtree, scoped to the project", () => {
    const work: SourceSelection = {
      kind: "topic",
      source: { platform: "claude-code", host: "native" },
      projectKey: "cli_aaa",
      topicId: 1,
    };
    expect(ids(filterConversationsBySelection(ALL, work, LOOKUP, TOPICS))).toEqual([
      1, 2,
    ]);
    const backend: SourceSelection = { ...work, topicId: 2 };
    expect(ids(filterConversationsBySelection(ALL, backend, LOOKUP, TOPICS))).toEqual([
      1,
    ]);
    // Same topic selected under a different project matches nothing.
    const misplaced: SourceSelection = {
      kind: "topic",
      source: { platform: "claude-code", host: "wsl:Ubuntu" },
      projectKey: "cli_ccc",
      topicId: 1,
    };
    expect(
      ids(filterConversationsBySelection(ALL, misplaced, LOOKUP, TOPICS)),
    ).toEqual([]);
  });
});

describe("collectTopicSubtreeIds", () => {
  it("collects the node and all descendants", () => {
    expect([...collectTopicSubtreeIds(TOPICS, 1)].sort()).toEqual([1, 2]);
    expect([...collectTopicSubtreeIds(TOPICS, 2)]).toEqual([2]);
  });

  it("falls back to the id itself when unknown", () => {
    expect([...collectTopicSubtreeIds(TOPICS, 99)]).toEqual([99]);
  });
});

describe("describeSelection", () => {
  const model = buildSourceTreeModel({
    tree: TREE,
    conversations: ALL,
    topics: TOPICS,
    lookup: LOOKUP,
  });

  it("describes each selection depth", () => {
    expect(
      describeSelection(
        model,
        { kind: "source", source: { platform: "browser", host: "browser" } },
        TOPICS,
        "Browser",
      ),
    ).toBe("Browser");
    expect(
      describeSelection(
        model,
        {
          kind: "project",
          source: { platform: "claude-code", host: "native" },
          projectKey: "cli_aaa",
        },
        TOPICS,
      ),
    ).toBe("Claude Code · vesti-app");
    expect(
      describeSelection(
        model,
        {
          kind: "topic",
          source: { platform: "claude-code", host: "native" },
          projectKey: "cli_aaa",
          topicId: 2,
        },
        TOPICS,
      ),
    ).toBe("vesti-app · Backend");
  });
});
