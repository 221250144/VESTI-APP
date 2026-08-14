import { describe, expect, it } from "vitest";
import {
  ANGULAR_RADIUS_PER_PX,
  CONSTELLATION_SEPARATION_MARGIN,
  buildConstellationMstEdges,
  buildSphereLayout,
  sphereAngularDistance,
  type SphereVec3,
} from "./sphere-layout";
import type { GraphNode } from "./temporal-graph-utils";

const BASE = new Date("2025-01-01T00:00:00Z").getTime();

function makeNode(id: number, groupKey = "platform:ChatGPT", radius = 12): GraphNode {
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
    radius,
    color: "#4a90d9",
  };
}

function angularSeparation(
  layout: ReturnType<typeof buildSphereLayout>,
  leftId: number,
  rightId: number
) {
  return sphereAngularDistance(
    layout.positions.get(leftId)!,
    layout.positions.get(rightId)!
  );
}

describe("buildSphereLayout", () => {
  it("places every node on the unit sphere", () => {
    const nodes = Array.from({ length: 60 }, (_, index) =>
      makeNode(index + 1, `topic:${index % 7}`, 10 + (index % 12))
    );
    const layout = buildSphereLayout(nodes, []);
    expect(layout.positions.size).toBe(nodes.length);
    for (const node of nodes) {
      const position = layout.positions.get(node.id);
      expect(position).toBeDefined();
      expect(Math.hypot(position!.x, position!.y, position!.z)).toBeCloseTo(1, 12);
    }
  });

  it("is deterministic for identical input, regardless of node order", () => {
    const nodes = Array.from({ length: 40 }, (_, index) =>
      makeNode(index + 1, `platform:P${index % 5}`, 10 + (index % 6) * 2)
    );
    const groups = [
      { key: "platform:P0", label: "P0" },
      { key: "platform:P1", label: "P1" },
    ];
    const first = buildSphereLayout(nodes, groups);
    const second = buildSphereLayout(nodes.slice().reverse(), groups);
    expect(second.constellations).toEqual(first.constellations);
    for (const node of nodes) {
      expect(second.positions.get(node.id)).toEqual(first.positions.get(node.id));
    }
  });

  it("assigns each group a stable, well-separated constellation center", () => {
    const nodes: GraphNode[] = [];
    let id = 1;
    for (let group = 0; group < 4; group += 1) {
      for (let index = 0; index < 4; index += 1) {
        nodes.push(makeNode(id, `topic:${group}`));
        id += 1;
      }
    }
    const layout = buildSphereLayout(nodes, []);
    const again = buildSphereLayout(nodes, []);
    expect(layout.constellations).toHaveLength(4);
    // Same data → same centers (grill: 切换分组来回后位置复原).
    expect(again.constellations.map((entry) => entry.center)).toEqual(
      layout.constellations.map((entry) => entry.center)
    );
    for (let left = 0; left < 4; left += 1) {
      for (let right = left + 1; right < 4; right += 1) {
        const separation = sphereAngularDistance(
          layout.constellations[left].center,
          layout.constellations[right].center
        );
        // Cap-aware contract (2026-08): centers clear the sum of both cap
        // radii plus the separation margin — big constellations keep wider
        // berths. Replaces the old global 1.05-rad budget assertion.
        const required =
          layout.constellations[left].capRadius +
          layout.constellations[right].capRadius +
          CONSTELLATION_SEPARATION_MARGIN;
        expect(separation).toBeGreaterThan(required - 0.01);
      }
    }
  });

  it("spreads many constellations without cap collisions", () => {
    const nodes: GraphNode[] = [];
    let id = 1;
    for (let group = 0; group < 20; group += 1) {
      for (let index = 0; index < 3; index += 1) {
        nodes.push(makeNode(id, `topic:${group}`, 12 + (index % 3) * 3));
        id += 1;
      }
    }
    const layout = buildSphereLayout(nodes, []);
    expect(layout.constellations).toHaveLength(20);
    for (let left = 0; left < 20; left += 1) {
      for (let right = left + 1; right < 20; right += 1) {
        const separation = sphereAngularDistance(
          layout.constellations[left].center,
          layout.constellations[right].center
        );
        const required =
          layout.constellations[left].capRadius +
          layout.constellations[right].capRadius +
          CONSTELLATION_SEPARATION_MARGIN;
        expect(separation).toBeGreaterThan(required - 0.01);
      }
    }
  });

  it("keeps typical full-budget skies at sizeScale 1, shrinks cluster-heavy skies", () => {
    const typical = buildSphereLayout(
      Array.from({ length: 260 }, (_, index) =>
        makeNode(index + 1, `topic:${index % 11}`, 10 + (index % 14))
      ),
      []
    );
    expect(typical.sizeScale).toBe(1);

    const bigNodes = Array.from({ length: 260 }, (_, index) =>
      makeNode(index + 1, `topic:${index % 11}`, 30)
    );
    const clusterHeavy = buildSphereLayout(bigNodes, []);
    expect(clusterHeavy.sizeScale).toBeLessThan(1);
    expect(clusterHeavy.sizeScale).toBeGreaterThanOrEqual(0.35);
    // Same data → same scale (normalization is part of the deterministic layout).
    expect(buildSphereLayout(bigNodes.slice().reverse(), []).sizeScale).toBe(
      clusterHeavy.sizeScale
    );
  });

  it("keeps nodes inside one group from overlapping (scatter radius ∝ node size)", () => {
    const nodes = Array.from({ length: 10 }, (_, index) =>
      makeNode(index + 1, "project:vesti", 12 + (index % 4) * 2)
    );
    const layout = buildSphereLayout(nodes, []);
    for (let left = 0; left < nodes.length; left += 1) {
      for (let right = left + 1; right < nodes.length; right += 1) {
        const required =
          (nodes[left].radius + nodes[right].radius) * ANGULAR_RADIUS_PER_PX;
        // Measured worst case for this size is ≥1.03× the required distance;
        // assert with margin so the contract (no visual overlap) is what breaks
        // the test, not floating-point noise.
        expect(angularSeparation(layout, nodes[left].id, nodes[right].id)).toBeGreaterThan(
          required * 0.9
        );
      }
    }
  });

  it("keeps cluster nodes as first-class layout citizens", () => {
    const cluster: GraphNode = {
      ...makeNode(-1, "platform:Claude", 30),
      kind: "cluster",
      label: "×6",
      memberIds: [101, 102, 103, 104, 105, 106],
      memberCount: 6,
    };
    const nodes = [makeNode(1, "platform:Claude"), makeNode(2, "platform:ChatGPT"), cluster];
    const layout = buildSphereLayout(nodes, []);
    expect(layout.positions.get(cluster.id)).toBeDefined();
    expect(layout.constellations.find((entry) => entry.key === "platform:Claude")?.nodeCount).toBe(2);
  });

  it("labels constellations from the provided groups, falling back to the key", () => {
    const nodes = [makeNode(1, "topic:7"), makeNode(2, "topic:9")];
    const layout = buildSphereLayout(nodes, [{ key: "topic:7", label: "Infra" }]);
    expect(layout.constellations.find((entry) => entry.key === "topic:7")?.label).toBe("Infra");
    expect(layout.constellations.find((entry) => entry.key === "topic:9")?.label).toBe("topic:9");
  });

  it("puts a single-node group exactly at its constellation center", () => {
    const layout = buildSphereLayout([makeNode(1, "platform:Kimi")], []);
    expect(layout.constellations).toHaveLength(1);
    expect(layout.constellations[0].capRadius).toBe(0);
    expect(layout.positions.get(1)).toEqual(layout.constellations[0].center);
  });

  it("keeps a single group on the sphere with members inside its cap", () => {
    const nodes = Array.from({ length: 12 }, (_, index) => makeNode(index + 1, "topic:3", 12));
    const layout = buildSphereLayout(nodes, []);
    const { center, capRadius } = layout.constellations[0];
    for (const node of nodes) {
      expect(sphereAngularDistance(center, layout.positions.get(node.id)!)).toBeLessThanOrEqual(
        capRadius + 1e-9
      );
    }
  });

  it("handles the empty graph", () => {
    const layout = buildSphereLayout([], []);
    expect(layout.positions.size).toBe(0);
    expect(layout.constellations).toEqual([]);
  });

  it("lays out a budget-scale graph quickly and sanely", () => {
    const nodes = Array.from({ length: 260 }, (_, index) =>
      makeNode(index + 1, `topic:${index % 11}`, 10 + (index % 14))
    );
    const startedAt = performance.now();
    const layout = buildSphereLayout(nodes, []);
    const elapsed = performance.now() - startedAt;
    expect(layout.positions.size).toBe(260);
    expect(layout.constellations).toHaveLength(11);
    // Pure arithmetic, no relax iterations — should be far below the old 3s bound.
    expect(elapsed).toBeLessThan(500);
  });
});

/** BFS over MST edges: every member must be reachable from any other. */
function expectFullyConnected(
  ids: readonly number[],
  edges: ReadonlyArray<readonly [number, number]>
) {
  const adjacency = new Map<number, number[]>();
  for (const [a, b] of edges) {
    adjacency.set(a, [...(adjacency.get(a) ?? []), b]);
    adjacency.set(b, [...(adjacency.get(b) ?? []), a]);
  }
  const visited = new Set<number>();
  const queue = [ids[0]];
  while (queue.length > 0) {
    const current = queue.pop()!;
    if (visited.has(current)) continue;
    visited.add(current);
    queue.push(...(adjacency.get(current) ?? []));
  }
  expect(visited.size).toBe(ids.length);
}

describe("buildConstellationMstEdges", () => {
  it("returns no edges for empty and single-node groups", () => {
    const positions = new Map<number, SphereVec3>([[1, { x: 1, y: 0, z: 0 }]]);
    expect(buildConstellationMstEdges([], positions)).toEqual([]);
    expect(buildConstellationMstEdges([1], positions)).toEqual([]);
  });

  it("links a two-node group with exactly one edge", () => {
    const positions = new Map<number, SphereVec3>([
      [1, { x: 1, y: 0, z: 0 }],
      [2, { x: 0, y: 1, z: 0 }],
    ]);
    expect(buildConstellationMstEdges([1, 2], positions)).toEqual([[1, 2]]);
    // Endpoint order is normalized to ascending ids, not input order.
    expect(buildConstellationMstEdges([2, 1], positions)).toEqual([[1, 2]]);
  });

  it("spans m nodes with m−1 edges and keeps the group fully connected", () => {
    const nodes = Array.from({ length: 30 }, (_, index) =>
      makeNode(index + 1, "topic:4", 10 + (index % 9))
    );
    const layout = buildSphereLayout(nodes, []);
    const ids = nodes.map((node) => node.id);
    const edges = buildConstellationMstEdges(ids, layout.positions);
    expect(edges).toHaveLength(ids.length - 1);
    expectFullyConnected(ids, edges);
    // Cluster nodes participate as ordinary members (negative ids sort fine).
    const withCluster = new Map(layout.positions);
    withCluster.set(-7, { x: 0, y: 0, z: 1 });
    const clusterEdges = buildConstellationMstEdges([...ids, -7], withCluster);
    expect(clusterEdges).toHaveLength(ids.length);
    expectFullyConnected([...ids, -7], clusterEdges);
  });

  it("is deterministic and independent of input order", () => {
    const nodes = Array.from({ length: 24 }, (_, index) =>
      makeNode(index + 1, "platform:Claude", 10 + (index % 7))
    );
    const layout = buildSphereLayout(nodes, []);
    const ids = nodes.map((node) => node.id);
    const forward = buildConstellationMstEdges(ids, layout.positions);
    const reversed = buildConstellationMstEdges(ids.slice().reverse(), layout.positions);
    // Deterministic interleave (evens then odds) — a third, different order.
    const interleaved = [
      ...ids.filter((_, index) => index % 2 === 0),
      ...ids.filter((_, index) => index % 2 === 1),
    ];
    const shuffled = buildConstellationMstEdges(interleaved, layout.positions);
    expect(reversed).toEqual(forward);
    expect(shuffled).toEqual(forward);
    // Re-running on the same data yields the same tree.
    expect(buildConstellationMstEdges(ids, layout.positions)).toEqual(forward);
  });

  it("breaks angular-distance ties by ascending endpoint ids", () => {
    // Regular tetrahedron on the unit sphere: all six pairwise distances are
    // equal (dot = −1/3), so the tree is decided purely by the id tie-break —
    // the smallest id becomes the hub of a star.
    const t = 1 / Math.sqrt(3);
    const positions = new Map<number, SphereVec3>([
      [1, { x: t, y: t, z: t }],
      [2, { x: t, y: -t, z: -t }],
      [3, { x: -t, y: t, z: -t }],
      [4, { x: -t, y: -t, z: t }],
    ]);
    expect(buildConstellationMstEdges([4, 2, 3, 1], positions)).toEqual([
      [1, 2],
      [1, 3],
      [1, 4],
    ]);
  });

  it("ignores member ids without a position", () => {
    const positions = new Map<number, SphereVec3>([
      [1, { x: 1, y: 0, z: 0 }],
      [2, { x: 0, y: 1, z: 0 }],
    ]);
    expect(buildConstellationMstEdges([1, 2, 999], positions)).toEqual([[1, 2]]);
  });
});

describe("buildSphereLayout constellation edges", () => {
  it("emits n − k intra-group edges (k = constellation count), endpoints in-group", () => {
    const nodes = Array.from({ length: 40 }, (_, index) =>
      makeNode(index + 1, `topic:${index % 5}`, 10 + (index % 6))
    );
    const layout = buildSphereLayout(nodes, []);
    const groupKeyById = new Map(nodes.map((node) => [node.id, node.groupKey]));
    expect(layout.constellationEdges).toHaveLength(
      nodes.length - layout.constellations.length
    );
    for (const [a, b] of layout.constellationEdges) {
      // Edges never cross constellations and always reference real nodes.
      expect(layout.positions.has(a)).toBe(true);
      expect(layout.positions.has(b)).toBe(true);
      expect(groupKeyById.get(a)).toBe(groupKeyById.get(b));
    }
    // Same data → same tree through the full layout pipeline as well.
    const again = buildSphereLayout(nodes.slice().reverse(), []);
    expect(again.constellationEdges).toEqual(layout.constellationEdges);
  });

  it("emits no edges for the empty graph", () => {
    expect(buildSphereLayout([], []).constellationEdges).toEqual([]);
  });
});
