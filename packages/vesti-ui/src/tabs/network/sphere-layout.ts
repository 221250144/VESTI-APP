import type { GraphNode } from "./temporal-graph-utils";

/**
 * 星轨球球面布局（Conversation Sphere, docs/conversation-sphere-design.md §4.1）。
 *
 * 纯函数、确定性：同一组节点 + 分组标签永远产出同一张布局。布局与视口尺寸
 * 无关（输出单位球面 3D 坐标），因此相机操作 / hover / 选择 / 回放都不会
 * 触发重算——只有数据或分组维度变化时才需要重新调用。
 *
 * 位置只表达"属于同一组"：每个分组（GraphNode.groupKey）分得球面上一个由
 * 分组 id 哈希驱动黄金角螺旋（Fibonacci sphere）取点的星座中心，组内节点
 * 围绕中心做等面积 phyllotaxis 散布，散布半径正相关于节点大小以避免重叠。
 * 不表达语义距离（不计算 embedding / 相似度）。
 *
 * 拥挤预案（2026-08）：星座中心摆放是 cap-aware 的——两中心间距必须 ≥
 * 两者 cap 半径之和 + 余量，大星座自动离得远（取代旧的全局 2.4/√k 预算）；
 * 全部节点的角面积之和超出预算时，所有节点按同一 sizeScale 收缩（相对大小
 * 关系不变），renderer 用 SphereLayout.sizeScale 同步缩放绘制半径。
 */

export interface SphereVec3 {
  x: number;
  y: number;
  z: number;
}

export interface SphereConstellation {
  /** Member nodes' GraphNode.groupKey (e.g. "platform:Claude", "topic:12"). */
  key: string;
  label: string;
  center: SphereVec3;
  nodeCount: number;
  /** Angular radius (radians) of the spherical cap the group is packed into. */
  capRadius: number;
}

export interface SphereLayout {
  /** node id → unit-sphere position (|p| === 1). */
  positions: ReadonlyMap<number, SphereVec3>;
  constellations: SphereConstellation[];
  /** 星座结构线：每个星座成员节点的球面 MST（m−1 条 id 对）。语义 = 同组
   * 从属（tabs/AGENTS.md §2 2026-08 修订），不表达相似度或时序。 */
  constellationEdges: ReadonlyArray<readonly [number, number]>;
  /** Global size normalization (≤ 1): when the total angular area of all
   * nodes exceeds NODE_AREA_BUDGET, every node shrinks by this factor —
   * relative sizes are preserved. The renderer multiplies drawn radii by it,
   * so dense skies stay readable without touching camera presets. */
  sizeScale: number;
}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
/** Resolution of the Fibonacci spiral that constellation centers are picked from. */
const SPIRAL_SLOTS = 4096;
/** Prime probing step (coprime with SPIRAL_SLOTS) used when a hashed slot lands
 * too close to an already-placed constellation center. */
const PROBE_STEP = 89;
const MAX_PROBE_ATTEMPTS = 512;
/** Angular radius of a node per pixel of GraphNode.radius, on the unit sphere. */
export const ANGULAR_RADIUS_PER_PX = 0.0075;
/** Cap radius = PACKING · √(Σ angularRadius²). With equal-area phyllotaxis
 * (nearest-neighbour distance ≈ 1.6·R/√n) this keeps same-size nodes more than
 * a node diameter apart — sizes differ, so this is a layout contract, not a
 * hard geometry proof; very large groups clamp into MAX_CAP_RADIUS instead. */
const INTRA_GROUP_PACKING = 1.5;
/** Constellations never spread beyond this cap radius (radians); larger groups
 * pack tighter inside it instead of swallowing the sphere. */
const MAX_CAP_RADIUS = 0.65;
/** Deterministic radial jitter (fraction of cap radius) so constellations read
 * organic rather than as a perfect spiral. */
const RADIAL_JITTER = 0.06;
/** Cap-aware placement: two constellation centers must clear the sum of their
 * cap radii plus this margin (radians), so big constellations never bleed into
 * each other. Replaces the old global 2.4/√k separation budget. */
export const CONSTELLATION_SEPARATION_MARGIN = 0.08;
/** Node-area budget: Σ (angularRadius)² the sphere hosts at full size. Beyond
 * it every node shrinks together (sizeScale < 1). 6.0 keeps a typical
 * full-budget sky (260 conversations, mixed sizes ≈ Σ4) at scale 1; only
 * cluster-heavy skies (cluster radius up to 30 → Σ up to ~13) shrink. */
const NODE_AREA_BUDGET = 6;
/** sizeScale floor — dense skies shrink stars, never to invisibility. */
const MIN_SIZE_SCALE = 0.35;

/** FNV-1a 32-bit — deterministic string hash, no dependencies. */
function hashString(input: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Hash → [0, 1). */
function hashUnit(input: string): number {
  return hashString(input) / 0x100000000;
}

/** Point `slot` on a SPIRAL_SLOTS-point Fibonacci sphere (golden-angle spiral). */
function fibonacciPoint(slot: number): SphereVec3 {
  const y = 1 - (2 * (slot + 0.5)) / SPIRAL_SLOTS;
  const radius = Math.sqrt(Math.max(0, 1 - y * y));
  const theta = slot * GOLDEN_ANGLE;
  return { x: radius * Math.cos(theta), y, z: radius * Math.sin(theta) };
}

export function sphereAngularDistance(left: SphereVec3, right: SphereVec3): number {
  const dot = left.x * right.x + left.y * right.y + left.z * right.z;
  return Math.acos(Math.min(1, Math.max(-1, dot)));
}

/** Orthonormal tangent basis at `center` (for local offsets on the sphere). */
function tangentBasis(center: SphereVec3): { east: SphereVec3; north: SphereVec3 } {
  // Any fixed reference not parallel to center works; poles fall back to +X.
  const reference =
    Math.abs(center.y) > 0.98 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
  const eastX = reference.y * center.z - reference.z * center.y;
  const eastY = reference.z * center.x - reference.x * center.z;
  const eastZ = reference.x * center.y - reference.y * center.x;
  const eastLength = Math.hypot(eastX, eastY, eastZ) || 1;
  const east = { x: eastX / eastLength, y: eastY / eastLength, z: eastZ / eastLength };
  const north = {
    x: center.y * east.z - center.z * east.y,
    y: center.z * east.x - center.x * east.z,
    z: center.x * east.y - center.y * east.x,
  };
  return { east, north };
}

/** Move `rho` radians away from `center` along bearing `theta` (tangent plane).
 * Exported for the renderer: birth ripples are rings of these offsets. */
export function offsetOnSphere(center: SphereVec3, rho: number, theta: number): SphereVec3 {
  if (rho <= 0) return center;
  const { east, north } = tangentBasis(center);
  const cosRho = Math.cos(rho);
  const sinRho = Math.sin(rho);
  const bearingX = Math.cos(theta);
  const bearingY = Math.sin(theta);
  const x =
    center.x * cosRho + (east.x * bearingX + north.x * bearingY) * sinRho;
  const y =
    center.y * cosRho + (east.y * bearingX + north.y * bearingY) * sinRho;
  const z =
    center.z * cosRho + (east.z * bearingX + north.z * bearingY) * sinRho;
  const length = Math.hypot(x, y, z) || 1;
  return { x: x / length, y: y / length, z: z / length };
}

/**
 * 星座结构线（docs/conversation-sphere-design.md §4.7）：一个星座的成员节点
 * 在球面上的最小生成树。边权 = 单位向量球面角距；Kruskal 实现，候选边按
 * (角距, 小端点 id, 大端点 id) 升序排序打破并列——同数据必同树，与输入
 * 顺序无关。cluster 节点作为普通成员参与（负 id 照常排序）。
 *
 * 输出 m−1 条边（m>1 时），每条边的端点按 id 升序存放；positions 中缺失
 * 的 id 被忽略。语义 = 同组从属（tabs/AGENTS.md §2 2026-08 修订），不得
 * 用于暗示语义相似度或时序。
 */
export function buildConstellationMstEdges(
  memberIds: ReadonlyArray<number>,
  positions: ReadonlyMap<number, SphereVec3>
): Array<readonly [number, number]> {
  const ids = [...new Set(memberIds)].filter((id) => positions.has(id));
  if (ids.length < 2) return [];

  interface CandidateEdge {
    a: number;
    b: number;
    weight: number;
  }
  const candidates: CandidateEdge[] = [];
  for (let left = 0; left < ids.length; left += 1) {
    for (let right = left + 1; right < ids.length; right += 1) {
      const a = Math.min(ids[left], ids[right]);
      const b = Math.max(ids[left], ids[right]);
      const weight = sphereAngularDistance(
        positions.get(ids[left])!,
        positions.get(ids[right])!
      );
      candidates.push({ a, b, weight });
    }
  }
  candidates.sort(
    (left, right) => left.weight - right.weight || left.a - right.a || left.b - right.b
  );

  // Kruskal with path-compressed union-find over the member ids.
  const parent = new Map<number, number>(ids.map((id) => [id, id]));
  const findRoot = (id: number): number => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let cursor = id;
    while (parent.get(cursor) !== cursor) {
      const next = parent.get(cursor)!;
      parent.set(cursor, root);
      cursor = next;
    }
    return root;
  };

  const edges: Array<readonly [number, number]> = [];
  for (const candidate of candidates) {
    const rootA = findRoot(candidate.a);
    const rootB = findRoot(candidate.b);
    if (rootA === rootB) continue;
    parent.set(rootA, rootB);
    edges.push([candidate.a, candidate.b]);
    if (edges.length === ids.length - 1) break;
  }
  return edges;
}

function compareGroupEntries(
  left: { key: string; members: GraphNode[] },
  right: { key: string; members: GraphNode[] }
) {
  return (
    right.members.length - left.members.length || left.key.localeCompare(right.key)
  );
}

/**
 * Assign each group a deterministic constellation center: hash the group key
 * onto the Fibonacci spiral, probing forward by a prime step until the
 * candidate clears every center placed so far by the cap-aware separation
 * (capRadius_i + capRadius_j + CONSTELLATION_SEPARATION_MARGIN). Groups are
 * placed largest-first so big constellations get first pick. When no slot
 * clears the constraints (a genuinely overfull sky), the least-bad candidate
 * keeps the layout deterministic and degradation graceful.
 */
function placeConstellationCenters(
  groups: Array<{ key: string; members: GraphNode[]; capRadius: number }>
): Map<string, SphereVec3> {
  const centers = new Map<string, SphereVec3>();
  const placed: Array<{ center: SphereVec3; capRadius: number }> = [];

  for (const group of groups) {
    const startSlot = hashString(group.key) % SPIRAL_SLOTS;
    let best: SphereVec3 | null = null;
    let bestSlack = Number.NEGATIVE_INFINITY;

    for (let attempt = 0; attempt < MAX_PROBE_ATTEMPTS; attempt += 1) {
      const candidate = fibonacciPoint((startSlot + attempt * PROBE_STEP) % SPIRAL_SLOTS);
      // Slack = clearance beyond the required cap-aware separation; ≥ 0 fits.
      let slack = Number.POSITIVE_INFINITY;
      for (const other of placed) {
        slack = Math.min(
          slack,
          sphereAngularDistance(candidate, other.center) -
            (group.capRadius + other.capRadius + CONSTELLATION_SEPARATION_MARGIN)
        );
      }
      if (slack >= 0) {
        best = candidate;
        break;
      }
      if (slack > bestSlack) {
        bestSlack = slack;
        best = candidate;
      }
    }

    const center = best ?? fibonacciPoint(startSlot);
    centers.set(group.key, center);
    placed.push({ center, capRadius: group.capRadius });
  }

  return centers;
}

/**
 * Build the deterministic unit-sphere layout for the (possibly clustered)
 * conversation nodes. `groups` supplies display labels for constellation keys
 * (buildNetworkGroups output); unknown keys fall back to the raw key string.
 */
export function buildSphereLayout(
  nodes: GraphNode[],
  groups: ReadonlyArray<{ key: string; label: string }> = []
): SphereLayout {
  const positions = new Map<number, SphereVec3>();
  if (nodes.length === 0) {
    return { positions, constellations: [], constellationEdges: [], sizeScale: 1 };
  }

  const labelByKey = new Map(groups.map((group) => [group.key, group.label]));
  const membersByKey = new Map<string, GraphNode[]>();
  for (const node of nodes) {
    const bucket = membersByKey.get(node.groupKey);
    if (bucket) {
      bucket.push(node);
    } else {
      membersByKey.set(node.groupKey, [node]);
    }
  }

  const orderedGroups = [...membersByKey.entries()]
    .map(([key, members]) => ({ key, members }))
    .sort(compareGroupEntries);

  // Global size normalization: total angular area beyond budget → every node
  // shrinks by the same factor (relative sizes preserved). Cap radii inherit
  // the shrink, so placement below sees the drawn sizes, not raw ones.
  // Sums run over id-sorted copies: floating-point addition is order-sensitive
  // in the last ulp, and "same data, any input order → identical layout" is
  // the determinism contract (tabs/AGENTS.md §4).
  const byId = nodes.slice().sort((left, right) => left.id - right.id);
  const totalArea = byId.reduce(
    (sum, node) => sum + (node.radius * ANGULAR_RADIUS_PER_PX) ** 2,
    0
  );
  const sizeScale = Math.min(
    1,
    Math.max(MIN_SIZE_SCALE, Math.sqrt(NODE_AREA_BUDGET / totalArea))
  );

  // Caps are needed before placement: cap-aware center separation reads them.
  const groupsWithCaps = orderedGroups.map((group) => {
    // Same member sort the scatter pass uses, so the area sum is order-stable.
    const sortedMembers = group.members.slice().sort((left, right) => {
      return (
        left.radius - right.radius ||
        left.originAt - right.originAt ||
        left.id - right.id
      );
    });
    const memberCount = sortedMembers.length;
    const squaredRadii = sortedMembers.reduce(
      (sum, member) => sum + (member.radius * ANGULAR_RADIUS_PER_PX * sizeScale) ** 2,
      0
    );
    const capRadius =
      memberCount <= 1
        ? 0
        : Math.min(MAX_CAP_RADIUS, INTRA_GROUP_PACKING * Math.sqrt(squaredRadii));
    return { ...group, members: sortedMembers, capRadius };
  });

  const centerByKey = placeConstellationCenters(groupsWithCaps);
  const constellations: SphereConstellation[] = [];
  const constellationEdges: Array<readonly [number, number]> = [];

  for (const group of groupsWithCaps) {
    const center = centerByKey.get(group.key)!;
    // Bigger nodes sit further out, where the cap has more room — the scatter
    // radius grows with node size, which is what keeps sizes from overlapping.
    // (members already sorted in the cap pass above.)
    const members = group.members;

    const memberCount = members.length;
    const capRadius = group.capRadius;
    const phase = hashUnit(`spin:${group.key}`) * Math.PI * 2;

    members.forEach((member, index) => {
      // Equal-area phyllotaxis: index j lands at radius R·√((j+½)/n), so
      // nearest-neighbour spacing stays roughly constant across the cap.
      const baseRho = capRadius * Math.sqrt((index + 0.5) / memberCount);
      const jitter =
        (hashUnit(`rho:${member.id}`) - 0.5) * 2 * RADIAL_JITTER * capRadius;
      const rho = Math.max(0, baseRho + jitter);
      const theta = phase + index * GOLDEN_ANGLE;
      positions.set(member.id, offsetOnSphere(center, rho, theta));
    });

    // 结构线随布局一起产出（§4.7）：成员位置已定，本组 MST 只依赖 positions。
    constellationEdges.push(
      ...buildConstellationMstEdges(
        members.map((member) => member.id),
        positions
      )
    );

    constellations.push({
      key: group.key,
      label: labelByKey.get(group.key) ?? group.key,
      center,
      nodeCount: memberCount,
      capRadius,
    });
  }

  return { positions, constellations, constellationEdges, sizeScale };
}
