import { describe, expect, it } from "vitest";
import { buildFixedAnchorLayout } from "./network-layout";
import type { GraphEdge, GraphNode } from "./temporal-graph-utils";

const BASE = new Date("2025-01-01T00:00:00Z").getTime();

function makeNode(id: number, groupKey = "platform:ChatGPT"): GraphNode {
  return {
    id,
    kind: "conversation",
    label: `Conversation ${id}`,
    platform: "ChatGPT",
    groupKey,
    day: id,
    timelineDay: id,
    messageCount: 10,
    originAt: BASE + id * 86_400_000,
    firstCapturedAt: BASE + id * 86_400_000,
    lastCapturedAt: BASE + id * 86_400_000,
    createdAt: BASE + id * 86_400_000,
    radius: 12,
    color: "#4a90d9",
  };
}

describe("buildFixedAnchorLayout", () => {
  it("returns a finite anchor for every node", () => {
    const nodes = Array.from({ length: 40 }, (_, index) => makeNode(index + 1));
    const edges: GraphEdge[] = Array.from({ length: 39 }, (_, index) => ({
      source: index + 1,
      target: index + 2,
      weight: 0.7,
    }));
    const layout = buildFixedAnchorLayout(nodes, edges, 1200, 420);
    expect(layout.size).toBe(40);
    for (const node of nodes) {
      const anchor = layout.get(node.id);
      expect(anchor).toBeDefined();
      expect(Number.isFinite(anchor!.anchorX)).toBe(true);
      expect(Number.isFinite(anchor!.anchorY)).toBe(true);
    }
  });

  it("is deterministic for identical input", () => {
    const nodes = Array.from({ length: 30 }, (_, index) => makeNode(index + 1));
    const edges: GraphEdge[] = [
      { source: 1, target: 5, weight: 0.9 },
      { source: 5, target: 12, weight: 0.6 },
    ];
    const first = buildFixedAnchorLayout(nodes, edges, 1200, 420);
    const second = buildFixedAnchorLayout(nodes, edges, 1200, 420);
    for (const node of nodes) {
      expect(first.get(node.id)!.anchorX).toBe(second.get(node.id)!.anchorX);
      expect(first.get(node.id)!.anchorY).toBe(second.get(node.id)!.anchorY);
    }
  });

  it("handles a large sparse graph quickly (spatial grid, not O(n²) pairs)", () => {
    const nodes = Array.from({ length: 800 }, (_, index) => makeNode(index + 1));
    const startedAt = performance.now();
    const layout = buildFixedAnchorLayout(nodes, [], 1200, 420);
    const elapsed = performance.now() - startedAt;
    expect(layout.size).toBe(800);
    // Generous bound — the old all-pairs relaxation took seconds here.
    expect(elapsed).toBeLessThan(3000);
  });

  it("returns an empty map for empty input", () => {
    expect(buildFixedAnchorLayout([], [], 1200, 420).size).toBe(0);
    expect(buildFixedAnchorLayout([makeNode(1)], [], 0, 420).size).toBe(0);
  });
});
