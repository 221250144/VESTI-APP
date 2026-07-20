import { describe, expect, it } from "vitest";
import type { ConversationTree, ConversationTreeSession } from "../../types";
import {
  buildRelaySelectorModel,
  modelConversationIds,
  platformConversationIds,
  projectConversationIds,
  relayNodeCheckState,
  toggleRelayConversation,
  toggleRelayIds,
} from "./relaySelector";

function session(
  id: string,
  overrides: Partial<ConversationTreeSession> = {}
): ConversationTreeSession {
  return {
    id,
    title: `会话 ${id}`,
    messageCount: 10,
    lastActivityAt: 1_000,
    oneLiner: null,
    keyTopics: [],
    keyFiles: [],
    decisions: [],
    ...overrides,
  };
}

function tree(): ConversationTree {
  return {
    generatedAt: "2026-07-19T00:00:00Z",
    sources: [
      {
        platform: "kimi-code",
        host: "native",
        projects: [
          {
            projectKey: "proj-a",
            label: "项目A",
            pathOrDomain: "C:/proj/a",
            sessions: [
              session("k1", {
                lastActivityAt: 3_000,
                oneLiner: "实现接力选择器",
                children: [session("k1-sub1"), session("k1-sub2")],
              }),
              session("k2", { lastActivityAt: 2_000 }),
              // No Dexie row for k3 — the picker skips it.
              session("k3", { lastActivityAt: 1_000 }),
            ],
          },
          {
            projectKey: "proj-b",
            label: "项目B",
            pathOrDomain: "C:/proj/b",
            sessions: [session("k4")],
          },
        ],
      },
      {
        platform: "claude-code",
        host: "native",
        projects: [
          {
            projectKey: "proj-c",
            label: "项目C",
            pathOrDomain: "/home/u/c",
            sessions: [session("c1")],
          },
        ],
      },
    ],
  };
}

function conversations() {
  return [
    { id: 101, title: "接力选择器实现", _cli_id: "k1" },
    { id: 102, title: "第二个会话", _cli_id: "k2" },
    { id: 104, title: "项目B 会话", _cli_id: "k4" },
    { id: 201, title: "Claude 会话", _cli_id: "c1" },
    // Browser rows carry no _cli_id and never enter the picker model.
    { id: 301, title: "浏览器会话", _source: "browser_extension" },
  ];
}

describe("buildRelaySelectorModel", () => {
  it("builds platform → project → conversation, main sessions only", () => {
    const model = buildRelaySelectorModel({ tree: tree(), conversations: conversations() });
    expect(model).toHaveLength(2);
    const [kimi, claude] = model;
    expect(kimi.platform).toBe("kimi-code");
    expect(kimi.projects.map((project) => project.projectKey)).toEqual(["proj-a", "proj-b"]);
    const projA = kimi.projects[0];
    // k3 has no Dexie row and is skipped; subagents k1-sub* are not rows.
    expect(projA.conversations.map((conversation) => conversation.id)).toEqual([101, 102]);
    // Newest first; the library (renamed) title and the one-liner ride along.
    expect(projA.conversations[0]).toMatchObject({
      id: 101,
      title: "接力选择器实现",
      oneLiner: "实现接力选择器",
      subagentCount: 2,
    });
    expect(claude.projects[0].conversations.map((conversation) => conversation.id)).toEqual([201]);
  });

  it("returns an empty model without a tree", () => {
    expect(buildRelaySelectorModel({ tree: null, conversations: conversations() })).toEqual([]);
  });
});

describe("relay selector selection state", () => {
  const projA = () =>
    buildRelaySelectorModel({ tree: tree(), conversations: conversations() })[0].projects[0];
  const kimi = () =>
    buildRelaySelectorModel({ tree: tree(), conversations: conversations() })[0];

  it("toggles a whole project on, then off", () => {
    const ids = projectConversationIds(projA());
    let selected = toggleRelayIds(new Set(), ids);
    expect([...selected].sort()).toEqual([101, 102]);
    selected = toggleRelayIds(selected, ids);
    expect(selected.size).toBe(0);
  });

  it("a partially selected project toggles to fully selected", () => {
    const ids = projectConversationIds(projA());
    const selected = toggleRelayIds(new Set([101]), ids);
    expect([...selected].sort()).toEqual([101, 102]);
  });

  it("toggles a whole platform without touching other platforms", () => {
    const ids = platformConversationIds(kimi());
    const selected = toggleRelayIds(new Set([201]), ids);
    expect([...selected].sort()).toEqual([101, 102, 104, 201]);
  });

  it("toggles a single conversation", () => {
    let selected = toggleRelayConversation(new Set(), 102);
    expect([...selected]).toEqual([102]);
    selected = toggleRelayConversation(selected, 102);
    expect(selected.size).toBe(0);
  });

  it("reports checked / partial / unchecked tri-state", () => {
    const ids = projectConversationIds(projA());
    expect(relayNodeCheckState(new Set(), ids)).toBe("unchecked");
    expect(relayNodeCheckState(new Set([101]), ids)).toBe("partial");
    expect(relayNodeCheckState(new Set([101, 102]), ids)).toBe("checked");
    expect(relayNodeCheckState(new Set([1]), [])).toBe("unchecked");
  });

  it("collects every selectable id across the model", () => {
    const model = buildRelaySelectorModel({ tree: tree(), conversations: conversations() });
    expect(modelConversationIds(model).sort()).toEqual([101, 102, 104, 201]);
  });
});
