import { describe, expect, it } from "vitest";
import type { Conversation } from "../../types";
import {
  DAY_MS,
  aggregateNodesIntoClusters,
  buildNetworkGroups,
  buildTemporalNetworkDataset,
  remapAndCapEdges,
  type GraphNode,
} from "./temporal-graph-utils";

const BASE = new Date("2025-01-01T00:00:00Z").getTime();

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

function makeConversations(count: number): Conversation[] {
  return Array.from({ length: count }, (_, index) =>
    makeConversation({ id: index + 1 })
  );
}

describe("buildNetworkGroups", () => {
  it("groups by platform with stable colors and counts", () => {
    const conversations = [
      makeConversation({ id: 1, platform: "ChatGPT" }),
      makeConversation({ id: 2, platform: "Claude" }),
      makeConversation({ id: 3, platform: "ChatGPT" }),
    ];
    const { groupKeyById, groups } = buildNetworkGroups(conversations, "platform");
    expect(groupKeyById.get(1)).toBe("platform:ChatGPT");
    expect(groupKeyById.get(2)).toBe("platform:Claude");
    expect(groups).toHaveLength(2);
    // Ranked by count desc → ChatGPT first.
    expect(groups[0].key).toBe("platform:ChatGPT");
    expect(groups[0].count).toBe(2);
    expect(groups.every((group) => /^#/.test(group.color))).toBe(true);
  });

  it("groups by topic with names and an 'other' bucket", () => {
    const conversations = [
      makeConversation({ id: 1, topic_id: 7 }),
      makeConversation({ id: 2, topic_id: null }),
    ];
    const { groupKeyById, groups } = buildNetworkGroups(conversations, "topic", {
      topicNameById: new Map([[7, "Infra"]]),
      otherLabel: "Ungrouped",
    });
    expect(groupKeyById.get(1)).toBe("topic:7");
    expect(groupKeyById.get(2)).toBe("topic:none");
    expect(groups.find((group) => group.key === "topic:7")?.label).toBe("Infra");
    expect(groups.find((group) => group.key === "topic:none")?.label).toBe("Ungrouped");
  });

  it("groups by project via digest hints, falling back to the other bucket", () => {
    const conversations = [makeConversation({ id: 1 }), makeConversation({ id: 2 })];
    const { groupKeyById, groups } = buildNetworkGroups(conversations, "project", {
      digestById: new Map([[1, { projectKey: "vesti", projectLabel: "VESTI" }]]),
      otherLabel: "Ungrouped",
    });
    expect(groupKeyById.get(1)).toBe("project:vesti");
    expect(groupKeyById.get(2)).toBe("project:none");
    expect(groups.find((group) => group.key === "project:vesti")?.label).toBe("VESTI");
  });

  it("skips archived and trashed conversations", () => {
    const conversations = [
      makeConversation({ id: 1 }),
      makeConversation({ id: 2, is_archived: true }),
      makeConversation({ id: 3, is_trash: true }),
    ];
    const { groupKeyById, groups } = buildNetworkGroups(conversations, "platform");
    expect(groupKeyById.size).toBe(1);
    expect(groups[0].count).toBe(1);
  });
});

describe("aggregateNodesIntoClusters", () => {
  function makeNode(id: number, groupKey = "platform:ChatGPT"): GraphNode {
    return {
      id,
      kind: "conversation",
      label: `c${id}`,
      platform: "ChatGPT",
      groupKey,
      day: id,
      timelineDay: id,
      messageCount: 1,
      originAt: BASE + id * DAY_MS,
      firstCapturedAt: BASE + id * DAY_MS,
      lastCapturedAt: BASE + id * DAY_MS,
      createdAt: BASE + id * DAY_MS,
      radius: 10,
      color: "#000000",
    };
  }

  it("returns nodes untouched when under the budget", () => {
    const nodes = [makeNode(1), makeNode(2)];
    expect(aggregateNodesIntoClusters(nodes, 10)).toBe(nodes);
  });

  it("collapses overflow into cluster nodes that conserve membership", () => {
    const nodes = Array.from({ length: 30 }, (_, index) => makeNode(index + 1));
    const result = aggregateNodesIntoClusters(nodes, 10);
    expect(result.length).toBeLessThanOrEqual(10);
    const clusterNodes = result.filter((node) => node.kind === "cluster");
    expect(clusterNodes.length).toBeGreaterThan(0);
    const memberTotal = clusterNodes.reduce(
      (sum, node) => sum + (node.memberCount ?? 0),
      0
    );
    const plainTotal = result.filter((node) => node.kind === "conversation").length;
    expect(memberTotal + plainTotal).toBe(30);
    // Cluster ids are negative so they never collide with conversation ids.
    expect(clusterNodes.every((node) => node.id < 0)).toBe(true);
    // Cluster appears when its latest member appears.
    for (const cluster of clusterNodes) {
      const memberDays = cluster.memberIds!.map(
        (id) => nodes.find((node) => node.id === id)!.timelineDay
      );
      expect(cluster.timelineDay).toBe(Math.max(...memberDays));
    }
  });

  it("never mixes groups inside one cluster", () => {
    const nodes = [
      makeNode(1, "topic:1"),
      makeNode(2, "topic:1"),
      makeNode(3, "topic:2"),
      makeNode(4, "topic:2"),
    ];
    const result = aggregateNodesIntoClusters(nodes, 2);
    for (const node of result) {
      if (node.kind !== "cluster") continue;
      const groupKeys = new Set(
        node.memberIds!.map((id) => nodes.find((entry) => entry.id === id)!.groupKey)
      );
      expect(groupKeys.size).toBe(1);
    }
  });
});

describe("remapAndCapEdges", () => {
  it("dedupes pairs keeping the strongest weight and drops sub-threshold edges", () => {
    const nodes = [
      { id: 1, kind: "conversation" },
      { id: 2, kind: "conversation" },
    ] as GraphNode[];
    const result = remapAndCapEdges(
      [
        { source: 1, target: 2, weight: 0.5 },
        { source: 2, target: 1, weight: 0.8 },
        { source: 1, target: 2, weight: 0.39 },
      ],
      nodes,
      10
    );
    expect(result).toHaveLength(1);
    expect(result[0].weight).toBe(0.8);
  });

  it("remaps members onto cluster ids and drops intra-cluster edges", () => {
    const cluster = {
      id: -1,
      kind: "cluster",
      memberIds: [1, 2],
    } as GraphNode;
    const nodes = [cluster, { id: 3, kind: "conversation" } as GraphNode];
    const result = remapAndCapEdges(
      [
        { source: 1, target: 2, weight: 0.9 }, // inside cluster → dropped
        { source: 1, target: 3, weight: 0.7 },
        { source: 2, target: 3, weight: 0.6 },
      ],
      nodes,
      10
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ source: -1, target: 3, weight: 0.7 });
  });

  it("caps to the strongest edges", () => {
    const nodes = Array.from({ length: 6 }, (_, index) => ({
      id: index + 1,
      kind: "conversation",
    })) as GraphNode[];
    const edges = [
      { source: 1, target: 2, weight: 0.9 },
      { source: 3, target: 4, weight: 0.8 },
      { source: 5, target: 6, weight: 0.5 },
    ];
    const result = remapAndCapEdges(edges, nodes, 2);
    expect(result).toHaveLength(2);
    expect(result.map((edge) => edge.weight)).toEqual([0.9, 0.8]);
  });
});

describe("buildTemporalNetworkDataset", () => {
  it("builds conversation nodes with platform grouping by default", () => {
    const dataset = buildTemporalNetworkDataset(makeConversations(5), []);
    expect(dataset.data.nodes).toHaveLength(5);
    expect(dataset.data.nodes.every((node) => node.kind === "conversation")).toBe(true);
    expect(dataset.data.nodes[0].groupKey).toBe("platform:ChatGPT");
    expect(dataset.dayCounts.reduce((sum, count) => sum + count, 0)).toBe(5);
  });

  it("clusters beyond the node budget while dayCounts stay per-conversation", () => {
    const conversations = makeConversations(300);
    const dataset = buildTemporalNetworkDataset(conversations, [], { maxNodes: 100 });
    expect(dataset.data.nodes.length).toBeLessThanOrEqual(100);
    expect(dataset.data.nodes.some((node) => node.kind === "cluster")).toBe(true);
    expect(dataset.dayCounts.reduce((sum, count) => sum + count, 0)).toBe(300);
  });

  it("applies group colors to nodes", () => {
    const conversations = makeConversations(3);
    const dataset = buildTemporalNetworkDataset(conversations, [], {
      groupKeyById: new Map([
        [1, "topic:1"],
        [2, "topic:1"],
        [3, "topic:2"],
      ]),
      groupColorByKey: new Map([
        ["topic:1", "#111111"],
        ["topic:2", "#222222"],
      ]),
    });
    expect(dataset.data.nodes[0].color).toBe("#111111");
    expect(dataset.data.nodes[2].color).toBe("#222222");
  });

  it("remaps and caps edges through clustering", () => {
    const conversations = makeConversations(50);
    const edges = Array.from({ length: 49 }, (_, index) => ({
      source: index + 1,
      target: index + 2,
      weight: 0.9,
    }));
    const dataset = buildTemporalNetworkDataset(conversations, edges, { maxNodes: 10 });
    const nodeIds = new Set(dataset.data.nodes.map((node) => node.id));
    for (const edge of dataset.data.edges) {
      expect(nodeIds.has(edge.source)).toBe(true);
      expect(nodeIds.has(edge.target)).toBe(true);
      expect(edge.source).not.toBe(edge.target);
    }
  });
});
