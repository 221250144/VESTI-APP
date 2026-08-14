"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { UiThemeMode } from "../../types";
import { buildSphereLayout, offsetOnSphere, type SphereLayout, type SphereVec3 } from "./sphere-layout";
import { getEmotionColor, type EmotionFamily } from "./emotionColors";
import { getStellarColor } from "./stellarColors";
import type { GraphNode, NetworkData } from "./temporal-graph-utils";
import {
  GRAPH_FONT_FAMILY,
  clamp,
  getGraphLabelFill,
  getNodeAlpha,
  hexToRgba,
  hitTestNode,
  truncateLabel,
} from "./temporal-graph-utils";

/**
 * 星轨球 renderer（docs/conversation-sphere-design.md §4.2）。
 *
 * Canvas 2D 伪 3D：sphere-layout 给出的单位球面坐标 → 旋转矩阵（drag 改变
 * rotX/rotY）→ 透视除法（单参数相机距离 d，滚轮/pinch 调整）→ 2D 绘制。
 * d 从远距正交感弱透视（整球可见）连续推进，越过球面（d ≈ 1）后自然过渡
 * 为球心附近向外看的内向全景（d < 1 时只画 z > d 的前方视锥）——同一套
 * 投影公式，过渡区仅由近距淡出处理，无跳变。
 *
 * 纪律（tabs/AGENTS.md §3/§4）：布局是 sphere-layout 的纯函数结果，只在
 * data/groups 变化时重算；本组件不查库、不构造业务数据；绘制按需触发，
 * 动画帧（惯性/复位）只做 canvas 重绘，不进 React state。呼吸光晕与分组
 * 过渡共用一个常驻 wall-clock rAF（~30fps 节流，hidden/inactive 暂停），
 * 同样只做重绘；情绪色经 emotionById 注入，themeMode 变化不重算布局。
 */

interface TemporalGraphProps {
  data: NetworkData;
  currentDay: number;
  height: number;
  themeMode?: UiThemeMode;
  scrubbing?: boolean;
  /** True while the 8s birth replay is running (drives ripples). */
  playing?: boolean;
  resetToken?: number;
  selectedNodeId?: number | null;
  highlightedNodeIds?: number[];
  /** Emotion family per node id (null = summarized-but-unmatched / neutral).
   * Colors are resolved at draw time via getEmotionColor, so theme switches
   * never recompute data or layout. */
  emotionById?: ReadonlyMap<number, EmotionFamily | null>;
  /** False when the tab/graph is not visible: pauses the standing ambient
   * rAF (breathing glow + grouping transitions). */
  isActive?: boolean;
  /** Constellation display labels (buildNetworkGroups output). */
  groups?: ReadonlyArray<{ key: string; label: string }>;
  onNodeClick?: (nodeId: number) => void;
  onBackgroundClick?: () => void;
  /** Extra hover-detail line for a node (e.g. digest one-liner, cluster date
   * range). Return null for title-only tooltips. */
  getNodeTooltip?: (node: GraphNode) => string | null;
  /** Accessible labels for the two camera preset buttons. */
  overviewLabel?: string;
  immerseLabel?: string;
}

interface RenderNode extends GraphNode {
  x: number;
  y: number;
  /** Projected perspective scale (1 = sphere at overview distance). */
  scale: number;
  /** GraphNode.radius before projection (message-count world size). */
  worldRadius: number;
  /** Emotion-bucketed star color for this frame (emotionById + themeMode),
   * resolved once and shared by ripple/glow/core/cluster ring. */
  nodeColor: string;
  /** Whether this star carries an emotion color (saturated "story star").
   * False = stellar-tinted star, drawn translucent so temperature stays
   * readable while story stars own the sky (§4.3). */
  hasEmotion: boolean;
}

interface CameraState {
  /** Pitch, clamped to ±MAX_TILT. */
  rotX: number;
  /** Yaw, unbounded. */
  rotY: number;
  /** Camera distance from the sphere center (sphere radius = 1). */
  distance: number;
}

interface LabelCandidate {
  id: number;
  label: string;
  alpha: number;
  x: number;
  y: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
  priority: number;
  force: boolean;
  /** LOD titles only: constellation bucket for the per-group cap. */
  groupKey?: string;
  /** LOD titles only: unprojected node radius (largest-first capping). */
  worldRadius?: number;
}

interface PointerSnapshot {
  clientX: number;
  clientY: number;
}

interface GestureState {
  mode: "idle" | "rotate" | "pinch";
  pointerId: number | null;
  startClientX: number;
  startClientY: number;
  startRotX: number;
  startRotY: number;
  startCameraDistance: number;
  startPointerGap: number;
  moved: boolean;
}

/** Overview preset: gentle perspective, whole sphere on screen. Also the
 * projection focal length, so equator scale is exactly 1 at this distance. */
const OVERVIEW_DISTANCE = 2.6;
/** Immersive preset: near the sphere center looking outward (FOV ≈ 120°). */
const IMMERSIVE_DISTANCE = 0.5;
const MIN_CAMERA_DISTANCE = 0.3;
const MAX_CAMERA_DISTANCE = 4.6;
/** Depth below which nodes fade out — this is what makes passing through the
 * sphere surface continuous instead of a clip-plane pop. */
const NEAR_FADE_DEPTH = 0.14;
const MAX_PERSPECTIVE_SCALE = 52;
const MAX_TILT = 1.45;
const DRAG_THRESHOLD = 5;
/** Radians of yaw per full canvas-width drag. */
const ROTATE_RADIANS_PER_WIDTH = 2.9;
const WHEEL_ZOOM_INTENSITY = 0.0016;
const PRESET_ANIMATION_MS = 480;
const INERTIA_DECAY_SECONDS = 0.24;
const INERTIA_MIN_SPEED = 0.05;
/** Screen radius per GraphNode.radius pixel at perspective scale 1. */
const NODE_RADIUS_SCALE = 0.0052;
/** MST constellation lines (§4.7): drawn under the nodes, alpha scaled by
 * endpoint visibility. Distinct hues per theme: dark = luminous silver-blue
 * (indigo-300 family) glowing on the night sky; light = deep indigo
 * (indigo-700 family) crisp on paper. Lines are uniform — width/style never
 * encode similarity or chronology. */
const MST_LINE_ALPHA_DARK = 0.32;
const MST_LINE_ALPHA_LIGHT = 0.38;
const MST_LINE_RGB_DARK = "165, 180, 252";
const MST_LINE_RGB_LIGHT = "67, 56, 202";
const MST_LINE_WIDTH = 1.4;
/** Selected-constellation lines brighten to this alpha; the rest dim with the
 * same 0.22 rule as non-neighbouring nodes. */
const MST_LINE_HIGHLIGHT_ALPHA = 0.65;
/** Node-title LOD (§4.7): a title appears once the node's projected screen
 * radius passes TITLE_LOD_ENTER_RADIUS and stays until it drops below
 * TITLE_LOD_EXIT_RADIUS (hysteresis against zoom flicker). Screen radius is
 * node size × camera distance combined — small conversations never fight for
 * attention, by design. */
const TITLE_LOD_ENTER_RADIUS = 12;
const TITLE_LOD_EXIT_RADIUS = 10;
/** Per-constellation cap on simultaneous LOD titles (largest nodes first). */
const TITLE_LOD_MAX_PER_CONSTELLATION = 5;
/** Birth-ripple window in timeline days (matches the birth ease-in). Ripples
 * are driven by currentDay — replay/scrub advances it frame by frame, so no
 * standing rAF is needed; nothing ripples on a settled sky. */
const BIRTH_RIPPLE_DAYS = 0.8;
/** Circle samples per ripple ring (projected into a screen-space polygon). */
const RIPPLE_SAMPLES = 28;
/** Breathing glow: full oscillation period (seconds). Slow enough to read as
 * ambient sky motion, not UI feedback. */
const BREATH_PERIOD_SECONDS = 4.2;
/** Glow alpha oscillates ±22%, scaled down for small stars. */
const BREATH_ALPHA_AMPLITUDE = 0.22;
/** Glow size oscillates ±8%, scaled down for small stars. */
const BREATH_SIZE_AMPLITUDE = 0.08;
/** Golden-ratio fraction for decorrelating per-node breathing phases. */
const BREATH_PHASE_SPREAD = 0.6180339887;
/** Steady halo multiplier for starred conversations (on top of the glow). */
const STARRED_HALO_SIZE_FACTOR = 7;
const STARRED_HALO_ALPHA = 0.5;
/** Proximity brightness: stars flare gently as they approach the camera
 * (√perspectiveScale, capped) — immersive views stay luminous instead of
 * washing out into wide, thin fog. ~1 at overview, so the settled sky is
 * unaffected. */
const PROXIMITY_BOOST_MAX = 2.4;
/** Stellar-tinted (unsummarized) stars are drawn translucent — temperature
 * readable, but saturated emotion stars own the sky (§4.3). Draw-time only:
 * layout, structure lines and label logic are unaffected. */
const STELLAR_ALPHA_FACTOR = 0.55;
/** Grouping transition: old constellation members slerp to their new slots. */
const GROUP_TRANSITION_MS = 360;

const DEFAULT_CAMERA: CameraState = {
  rotX: 0.22,
  rotY: 0,
  distance: OVERVIEW_DISTANCE,
};

/** Snapshot of the previous layout taken when data/groups change: surviving
 * nodes slerp from these positions onto the new layout (GROUP_TRANSITION_MS). */
interface LayoutTransition {
  from: Map<number, SphereVec3>;
  fromCenters: Map<string, SphereVec3>;
  startedAt: number;
}

function createGestureState(): GestureState {
  return {
    mode: "idle",
    pointerId: null,
    startClientX: 0,
    startClientY: 0,
    startRotX: 0,
    startRotY: 0,
    startCameraDistance: OVERVIEW_DISTANCE,
    startPointerGap: 0,
    moved: false,
  };
}

function easeInOutCubic(t: number) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/** Shortest-path angular delta (for yaw animation across the ±π wrap). */
function angularDelta(from: number, to: number) {
  return Math.atan2(Math.sin(to - from), Math.cos(to - from));
}

/** Spherical lerp between two unit-sphere points: grouping transitions must
 * arc across the surface, never cut through the sphere interior. Falls back
 * to endpoints for (near-)coincident or antipodal pairs. */
function slerpUnit(a: SphereVec3, b: SphereVec3, t: number): SphereVec3 {
  const dot = clamp(a.x * b.x + a.y * b.y + a.z * b.z, -1, 1);
  const omega = Math.acos(dot);
  const sinOmega = Math.sin(omega);
  if (sinOmega < 1e-5) return t < 0.5 ? a : b;
  const ka = Math.sin((1 - t) * omega) / sinOmega;
  const kb = Math.sin(t * omega) / sinOmega;
  return {
    x: a.x * ka + b.x * kb,
    y: a.y * ka + b.y * kb,
    z: a.z * ka + b.z * kb,
  };
}

/** Deterministic per-node breathing phase in [0, 2π): golden-ratio multiply
 * decorrelates neighbours without any per-node state. */
function breathPhase(id: number): number {
  const raw = Math.abs(id) * BREATH_PHASE_SPREAD;
  return (raw - Math.floor(raw)) * Math.PI * 2;
}

function labelsOverlap(left: LabelCandidate, right: LabelCandidate) {
  return !(
    left.right < right.left ||
    left.left > right.right ||
    left.bottom < right.top ||
    left.top > right.bottom
  );
}

function getDistanceBetweenPointers(points: PointerSnapshot[]) {
  if (points.length < 2) return 0;
  const [left, right] = points;
  return Math.hypot(right.clientX - left.clientX, right.clientY - left.clientY);
}

/** Soft radial-glow sprite per node color (pre-rendered once per color — no
 * per-frame shadowBlur). Module-level cache: colors are palette-bounded. */
const glowSpriteCache = new Map<string, HTMLCanvasElement>();

function getGlowSprite(color: string): HTMLCanvasElement | null {
  const cached = glowSpriteCache.get(color);
  if (cached) return cached;
  if (typeof document === "undefined") return null;
  const size = 64;
  const sprite = document.createElement("canvas");
  sprite.width = size;
  sprite.height = size;
  const context = sprite.getContext("2d");
  if (!context) return null;
  const gradient = context.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, hexToRgba(color, 0.5));
  gradient.addColorStop(0.32, hexToRgba(color, 0.16));
  gradient.addColorStop(1, hexToRgba(color, 0));
  context.fillStyle = gradient;
  context.fillRect(0, 0, size, size);
  glowSpriteCache.set(color, sprite);
  return sprite;
}

interface ProjectedPoint {
  x: number;
  y: number;
  /** Rotated z (+z toward viewer), pre-projection. */
  z: number;
  /** |camera distance − z|; small means the point is passing the camera. */
  depth: number;
  /** Perspective scale (1 = node at sphere equator at overview distance). */
  scale: number;
}

/**
 * Rotate (yaw then pitch) and perspective-divide a unit-sphere point.
 * Returns null when the point is behind the camera (only possible when the
 * camera is inside the sphere, d < 1: the visible cone is z > d).
 */
function projectPoint(
  point: SphereVec3,
  camera: CameraState,
  centerX: number,
  centerY: number,
  viewScale: number
): ProjectedPoint | null {
  const cosY = Math.cos(camera.rotY);
  const sinY = Math.sin(camera.rotY);
  const rotatedX = point.x * cosY + point.z * sinY;
  const rotatedZ1 = -point.x * sinY + point.z * cosY;
  const cosX = Math.cos(camera.rotX);
  const sinX = Math.sin(camera.rotX);
  const rotatedY = point.y * cosX - rotatedZ1 * sinX;
  const rotatedZ = point.y * sinX + rotatedZ1 * cosX;

  if (camera.distance < 1 && rotatedZ < camera.distance) return null;

  const depth = Math.abs(camera.distance - rotatedZ);
  const scale = Math.min(OVERVIEW_DISTANCE / Math.max(depth, 0.02), MAX_PERSPECTIVE_SCALE);
  return {
    x: centerX + rotatedX * scale * viewScale,
    y: centerY - rotatedY * scale * viewScale,
    z: rotatedZ,
    depth,
    scale,
  };
}

export function TemporalGraph({
  data,
  currentDay,
  height,
  themeMode = "light",
  scrubbing = false,
  playing = false,
  resetToken = 0,
  selectedNodeId = null,
  highlightedNodeIds,
  emotionById,
  isActive = true,
  groups,
  onNodeClick,
  onBackgroundClick,
  getNodeTooltip,
  overviewLabel = "Overview",
  immerseLabel = "Immersive view",
}: TemporalGraphProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const currentDayRef = useRef(currentDay);
  const activeNodesRef = useRef<RenderNode[]>([]);
  const layoutRef = useRef<SphereLayout>({ positions: new Map(), constellations: [], constellationEdges: [], sizeScale: 1 });
  const transitionRef = useRef<LayoutTransition | null>(null);
  /** Title-LOD hysteresis memory (draw-internal, not React state): ids whose
   * titles were visible last frame. */
  const titleLodRef = useRef(new Set<number>());
  const cameraRef = useRef<CameraState>({ ...DEFAULT_CAMERA });
  const motionFrameRef = useRef<number | null>(null);
  const ambientFrameRef = useRef<number | null>(null);
  const lastAmbientDrawRef = useRef(0);
  const spinVelocityRef = useRef({ rotX: 0, rotY: 0 });
  const lastDragSampleRef = useRef({ rotX: 0, rotY: 0, time: 0 });
  const activePointersRef = useRef(new Map<number, PointerSnapshot>());
  const gestureRef = useRef<GestureState>(createGestureState());
  const hoverIdRef = useRef<number | null>(null);
  const [width, setWidth] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [hoveredNode, setHoveredNode] = useState<RenderNode | null>(null);

  const highlightedNodeIdSet = useMemo(
    () => new Set(highlightedNodeIds ?? []),
    [highlightedNodeIds]
  );

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || width <= 0) return;

    const context = canvas.getContext("2d");
    if (!context) return;

    const dpr = window.devicePixelRatio || 1;
    const pixelWidth = Math.round(width * dpr);
    const pixelHeight = Math.round(height * dpr);
    // Resizing the canvas clears it and reallocates the backing store — only
    // do it when the size actually changed (per-frame draws just refill).
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
    }

    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    // 全页天空：天空渐变在标签页容器上（network-tab SKY_BACKGROUND），画布
    // 本身保持透明，星点浮在开放空间上——无面板、无边框。
    context.clearRect(0, 0, width, height);

    const camera = cameraRef.current;
    const centerX = width / 2;
    const centerY = height / 2;
    // Fit: the sphere silhouette (larger than the equator under perspective)
    // keeps ~19px of breathing room on a 420px-tall canvas.
    const viewScale = Math.min(width, height) * 0.42;
    const layout = layoutRef.current;
    // 全局尺寸归一化（sphere-layout）：节点总角面积超预算时全部节点按同一
    // 系数收缩，相对大小不变；绘制半径与涟漪角半径都用它缩放。
    const sizeScale = layout.sizeScale;
    const renderedNodes: RenderNode[] = [];
    const projectedById = new Map<
      number,
      ProjectedPoint & { alpha: number; depthFade: number; hemisphereFade: number }
    >();
    const ripplesActive = playing || scrubbing;
    const now = performance.now();
    // 恒星光谱色的"今天"（按天量化，同日同色；仅用于未摘要节点着色）。
    const nowMs = Date.now();

    // Grouping transition: surviving nodes/labels slerp from the previous
    // layout (wall-clock, ease-out cubic). Expired transitions self-clear.
    const transition = transitionRef.current;
    let transitionEase = 1;
    if (transition) {
      const t = clamp((now - transition.startedAt) / GROUP_TRANSITION_MS, 0, 1);
      transitionEase = 1 - Math.pow(1 - t, 3);
      if (t >= 1) transitionRef.current = null;
    }
    // Display positions only diverge from the layout mid-transition; the map
    // is shared with the ripple pass below (it re-reads node positions).
    const displayPositions = transition ? new Map<number, SphereVec3>() : null;
    const displayPositionOf = (id: number): SphereVec3 | undefined => {
      const to = layout.positions.get(id);
      if (!to) return undefined;
      const from = transition?.from.get(id);
      return from && transitionEase < 1 ? slerpUnit(from, to, transitionEase) : to;
    };

    for (const node of data.nodes) {
      if (node.timelineDay > currentDayRef.current) continue;
      const position = displayPositionOf(node.id);
      if (!position) continue;
      displayPositions?.set(node.id, position);
      const projected = projectPoint(position, camera, centerX, centerY, viewScale);
      if (!projected) continue;

      const age = currentDayRef.current - node.timelineDay;
      const enterProgress = clamp(age / 0.8, 0, 1);

      // Near-plane fade: nodes passing the camera dissolve instead of popping.
      const depthFade = clamp(projected.depth / NEAR_FADE_DEPTH, 0, 1);
      // Far-side attenuation: back of the sphere shrinks (perspective does
      // that part) and dims, so the globe reads as a volume, not a disc.
      const hemisphereFade =
        camera.distance > 1 ? 0.22 + 0.78 * ((projected.z + 1) / 2) : 1;
      const alpha =
        getNodeAlpha(node, currentDayRef.current) *
        depthFade *
        hemisphereFade *
        (0.3 + 0.7 * enterProgress);
      if (alpha <= 0.02) continue;

      const screenRadius = clamp(
        node.radius * sizeScale * projected.scale * viewScale * NODE_RADIUS_SCALE * (0.35 + 0.65 * enterProgress),
        1.1,
        36
      );

      // Frustum culling: skip work for nodes far outside the visible rect.
      if (
        projected.x < -90 ||
        projected.x > width + 90 ||
        projected.y < -90 ||
        projected.y > height + 90
      ) {
        continue;
      }

      // 有情绪家族 = 高饱和情绪色；无（未摘要/未匹配）= 低饱和恒星光谱色
      // ——最近活跃时间 → 温度，还在燃烧的蓝白，久置的冷却成红（§4.3）。
      const family = emotionById?.get(node.id) ?? null;
      const renderNode: RenderNode = {
        ...node,
        radius: screenRadius,
        x: projected.x,
        y: projected.y,
        scale: projected.scale,
        worldRadius: node.radius,
        nodeColor: family
          ? getEmotionColor(family, themeMode)
          : getStellarColor(node.lastCapturedAt, nowMs, themeMode),
        hasEmotion: family !== null,
      };
      renderedNodes.push(renderNode);
      projectedById.set(node.id, { ...projected, alpha, depthFade, hemisphereFade });
    }

    // Painter's order: far to near, so near stars sit on top and the hit test
    // (which walks the array backwards) picks the front-most node.
    renderedNodes.sort((left, right) => {
      const leftDepth = projectedById.get(left.id)?.depth ?? 0;
      const rightDepth = projectedById.get(right.id)?.depth ?? 0;
      return rightDepth - leftDepth || left.id - right.id;
    });
    activeNodesRef.current = renderedNodes;

    // Constellation labels first: quiet, uppercase, letterspaced — they are
    // wayfinding, not content, so they sit under the stars.
    context.textAlign = "center";
    context.font = `10px ${GRAPH_FONT_FAMILY}`;
    for (const constellation of layout.constellations) {
      let center = constellation.center;
      const fromCenter = transition?.fromCenters.get(constellation.key);
      if (fromCenter && transitionEase < 1) {
        center = slerpUnit(fromCenter, center, transitionEase);
      }
      const projected = projectPoint(center, camera, centerX, centerY, viewScale);
      if (!projected) continue;
      let alpha = clamp(projected.depth / NEAR_FADE_DEPTH, 0, 1) * 0.55;
      if (camera.distance > 1) {
        alpha *= 0.3 + 0.7 * ((projected.z + 1) / 2);
      }
      if (alpha <= 0.03) continue;
      const capOffset = constellation.capRadius * projected.scale * viewScale + 16;
      const labelX = projected.x;
      const labelY = projected.y - capOffset;
      if (labelX < -60 || labelX > width + 60 || labelY < -30 || labelY > height + 30) continue;
      const previousLetterSpacing =
        "letterSpacing" in context ? context.letterSpacing : "";
      if ("letterSpacing" in context) context.letterSpacing = "1.5px";
      context.fillStyle = getGraphLabelFill(themeMode, alpha);
      context.fillText(
        truncateLabel(constellation.label, 26).toUpperCase(),
        labelX,
        labelY
      );
      if ("letterSpacing" in context) context.letterSpacing = previousLetterSpacing;
    }

    const hasSelection = selectedNodeId !== null;
    const labelCandidates: LabelCandidate[] = [];

    // 星座结构线（MST，§4.7）：画在节点下层。端点复用节点投影结果——slerp
    // 过渡中 displayPosition 已体现在投影里；背面、相机身后（内视）、被
    // culling 或未诞生的端点不在 projectedById 中，该线按端点跳过。统一宽度
    // 纯色：线只表达"同组从属"，粗细/样式不编码相似度或时序。衰减取两端点
    // 最终 alpha 的较小值（含诞生 enter、年龄、depthFade、hemisphereFade）。
    context.lineWidth = MST_LINE_WIDTH;
    for (const [endpointA, endpointB] of layout.constellationEdges) {
      const projectedA = projectedById.get(endpointA);
      const projectedB = projectedById.get(endpointB);
      if (!projectedA || !projectedB) continue;
      const endpointFade = Math.min(projectedA.alpha, projectedB.alpha);
      const isHighlightedLine =
        hasSelection &&
        highlightedNodeIdSet.has(endpointA) &&
        highlightedNodeIdSet.has(endpointB);
      const lineAlpha = hasSelection
        ? isHighlightedLine
          ? MST_LINE_HIGHLIGHT_ALPHA * endpointFade
          : (themeMode === "dark" ? MST_LINE_ALPHA_DARK : MST_LINE_ALPHA_LIGHT) *
            endpointFade *
            0.22
        : (themeMode === "dark" ? MST_LINE_ALPHA_DARK : MST_LINE_ALPHA_LIGHT) * endpointFade;
      if (lineAlpha <= 0.01) continue;
      context.strokeStyle =
        themeMode === "dark"
          ? `rgba(${MST_LINE_RGB_DARK}, ${lineAlpha})`
          : `rgba(${MST_LINE_RGB_LIGHT}, ${lineAlpha})`;
      context.beginPath();
      context.moveTo(projectedA.x, projectedA.y);
      context.lineTo(projectedB.x, projectedB.y);
      context.stroke();
    }

    for (const node of renderedNodes) {
      const projected = projectedById.get(node.id)!;
      let alpha = projected.alpha;

      const isSelected = node.id === selectedNodeId;
      const isSameConstellation = highlightedNodeIdSet.has(node.id);
      if (hasSelection && !isSelected && !isSameConstellation) {
        alpha *= 0.22;
      }
      if (alpha <= 0.02) continue;

      const isCluster = node.kind === "cluster";
      const coreRadius = Math.max(0.8, node.radius * 0.58);
      // 近距离增亮：恒星靠近相机时按 √scale 提亮（封顶），沉浸视角下星核
      // 仍然明亮可读，而不是摊开成稀薄的大光团；overview 下 boost ≈ 1。
      const proximityBoost = clamp(Math.sqrt(node.scale), 1, PROXIMITY_BOOST_MAX);
      // 未摘要的恒星色星半透明（温度可读、退后一层）；情绪星保持实色。
      const drawAlpha = node.hasEmotion ? alpha : alpha * STELLAR_ALPHA_FACTOR;

      // 诞生涟漪（回放/scrub 期间）：球面上以节点为中心的小圆，沿切平面
      // 扩散——圆周用 offsetOnSphere 采样后逐点投影，透视自然呈现近大远小、
      // 边缘压扁；alpha 与节点共享近面/背面衰减，投影失败（内视身后）的点
      // 被跳过即参与 culling。由 currentDay 驱动，无需常驻 rAF。
      const age = currentDayRef.current - node.timelineDay;
      if (ripplesActive && age >= 0 && age < BIRTH_RIPPLE_DAYS) {
        const position = displayPositions?.get(node.id) ?? layout.positions.get(node.id);
        if (position) {
          const birthProgress = clamp(age / BIRTH_RIPPLE_DAYS, 0, 1);
          const rippleMultiplier = hasSelection && !isSelected && !isSameConstellation ? 0.28 : 1;
          // 渲染角半径（屏幕节点半径 ÷ scale·viewScale），两圈与旧版同比例。
          const nodeAngularRadius = node.worldRadius * sizeScale * NODE_RADIUS_SCALE;
          const rings = [
            { spread: 1 + 1.8 * birthProgress, alpha: (1 - birthProgress) * 0.15 },
            { spread: 1 + 1.0 * birthProgress, alpha: (1 - birthProgress) * 0.1 },
          ];
          for (const ring of rings) {
            const ringAlpha =
              ring.alpha *
              rippleMultiplier *
              projected.depthFade *
              projected.hemisphereFade *
              (node.hasEmotion ? 1 : STELLAR_ALPHA_FACTOR);
            if (ringAlpha <= 0.01) continue;
            const rho = nodeAngularRadius * ring.spread;
            const ringPoints: Array<{ x: number; y: number }> = [];
            for (let sample = 0; sample < RIPPLE_SAMPLES; sample += 1) {
              const theta = (sample / RIPPLE_SAMPLES) * Math.PI * 2;
              const point = projectPoint(
                offsetOnSphere(position, rho, theta),
                camera,
                centerX,
                centerY,
                viewScale
              );
              if (point) ringPoints.push({ x: point.x, y: point.y });
            }
            if (ringPoints.length < 8) continue;
            context.beginPath();
            context.moveTo(ringPoints[0].x, ringPoints[0].y);
            for (let index = 1; index < ringPoints.length; index += 1) {
              context.lineTo(ringPoints[index].x, ringPoints[index].y);
            }
            context.closePath();
            context.fillStyle = hexToRgba(node.nodeColor, ringAlpha);
            context.fill();
          }
        }
      }

      const glow = getGlowSprite(node.nodeColor);
      if (glow) {
        // Starred conversations keep a steady halo under the breathing glow —
        // a fixed extra sprite layer, deliberately NOT oscillating, so the
        // "saved" marker reads as constant at a glance.
        if (node.starred) {
          const haloSize = node.radius * STARRED_HALO_SIZE_FACTOR;
          context.globalAlpha = Math.min(1, alpha * STARRED_HALO_ALPHA);
          context.drawImage(glow, node.x - haloSize / 2, node.y - haloSize / 2, haloSize, haloSize);
          context.globalAlpha = 1;
        }
        // Breathing glow: wall-clock sine, per-node golden-ratio phase; big
        // stars breathe more than small ones (sizeFactor), dimmed stars keep
        // their proportion (modulation is relative to `alpha`).
        const sizeFactor = clamp(node.worldRadius / 22, 0.3, 1);
        const breath =
          Math.sin((now / 1000) * ((Math.PI * 2) / BREATH_PERIOD_SECONDS) + breathPhase(node.id)) *
          sizeFactor;
        const glowSize = node.radius * 5.2 * (1 + BREATH_SIZE_AMPLITUDE * breath);
        context.globalAlpha = Math.min(
          1,
          drawAlpha * proximityBoost * 0.85 * (1 + BREATH_ALPHA_AMPLITUDE * breath)
        );
        context.drawImage(glow, node.x - glowSize / 2, node.y - glowSize / 2, glowSize, glowSize);
        context.globalAlpha = 1;
      }

      context.beginPath();
      context.arc(node.x, node.y, coreRadius, 0, Math.PI * 2);
      context.fillStyle = hexToRgba(node.nodeColor, Math.min(1, drawAlpha * proximityBoost * (isSelected ? 1 : isCluster ? 0.7 : 0.95)));
      context.fill();

      if (isSelected) {
        context.beginPath();
        context.arc(node.x, node.y, coreRadius + 2.4, 0, Math.PI * 2);
        context.strokeStyle =
          themeMode === "dark" ? "rgba(229, 227, 219, 0.95)" : "rgba(26, 26, 26, 0.92)";
        context.lineWidth = 2;
        context.stroke();
      }

      // Clusters get a dashed outer ring so they read as "many" at a glance.
      if (isCluster) {
        context.save();
        context.setLineDash([3, 3]);
        context.beginPath();
        context.arc(node.x, node.y, coreRadius + 4.4, 0, Math.PI * 2);
        context.strokeStyle = hexToRgba(node.nodeColor, drawAlpha * 0.9);
        context.lineWidth = 1;
        context.stroke();
        context.restore();
      }

      // 标题 LOD（§4.7）：阈值挂在节点屏幕半径上（节点大小 × 相机距离的
      // 联合效果，小会话自然不会抢镜），12px 进入 / 10px 退出滞后防闪烁；
      // 外视相机背面半球（z<0）不出标题。滞后的历史放在 titleLodRef
      // （draw 内部 ref，不进 React state）。
      const isBackSide = camera.distance > 1 && projected.z < 0;
      const lodWasVisible = titleLodRef.current.has(node.id);
      const lodVisible =
        !isBackSide &&
        (lodWasVisible
          ? node.radius >= TITLE_LOD_EXIT_RADIUS
          : node.radius >= TITLE_LOD_ENTER_RADIUS);
      if (lodVisible) {
        titleLodRef.current.add(node.id);
      } else {
        titleLodRef.current.delete(node.id);
      }

      if (isCluster || isSelected || isSameConstellation || lodVisible) {
        const isLodTitle = !isCluster && !isSelected && !isSameConstellation;
        const labelAlpha = isSelected
          ? 1
          : isCluster
            ? Math.max(0.55, Math.min(1, alpha + 0.25))
            : isSameConstellation
              ? Math.max(0.62, Math.min(1, (alpha - 0.2) / 0.28))
              : Math.min(0.85, (node.radius - TITLE_LOD_EXIT_RADIUS) / 8);
        // Untitled conversations fall back to the digest one-liner (same
        // source as the hover tooltip); clusters keep their ×N label.
        const title =
          isCluster || node.label !== "Untitled"
            ? node.label
            : getNodeTooltip?.(node) ?? node.label;
        const label = truncateLabel(title, 20);
        const labelHalfWidth = Math.max(30, label.length * 3.2);
        const labelY = node.y + coreRadius + 13;

        labelCandidates.push({
          id: node.id,
          label,
          // Selected/neighbor/cluster labels stay readable even on dimmed
          // nodes; LOD labels fade with their node instead.
          alpha: Math.min(
            1,
            isSelected || isSameConstellation || isCluster ? labelAlpha : labelAlpha * alpha
          ),
          x: node.x,
          y: labelY,
          left: node.x - labelHalfWidth - 10,
          right: node.x + labelHalfWidth + 10,
          top: labelY - 16,
          bottom: labelY + 8,
          priority:
            (isSelected ? 120 : 0) +
            (isSameConstellation ? 30 : 0) +
            node.radius +
            labelAlpha * 10,
          force: isSelected,
          groupKey: isLodTitle ? node.groupKey : undefined,
          worldRadius: isLodTitle ? node.worldRadius : undefined,
        });
      }
    }

    // Per-constellation cap on LOD titles (§4.7 anti-clutter): within each
    // constellation only the 5 largest nodes keep their automatic titles;
    // selected/highlighted/cluster labels are interaction semantics and never
    // count against the cap. Collision avoidance below may still drop more.
    const lodBuckets = new Map<string, LabelCandidate[]>();
    const cappedCandidates: LabelCandidate[] = [];
    for (const candidate of labelCandidates) {
      if (!candidate.groupKey) {
        cappedCandidates.push(candidate);
        continue;
      }
      const bucket = lodBuckets.get(candidate.groupKey);
      if (bucket) {
        bucket.push(candidate);
      } else {
        lodBuckets.set(candidate.groupKey, [candidate]);
      }
    }
    for (const bucket of lodBuckets.values()) {
      bucket.sort(
        (left, right) =>
          (right.worldRadius ?? 0) - (left.worldRadius ?? 0) || left.id - right.id
      );
      cappedCandidates.push(...bucket.slice(0, TITLE_LOD_MAX_PER_CONSTELLATION));
    }

    const acceptedLabels: LabelCandidate[] = [];
    cappedCandidates
      .sort((left, right) => right.priority - left.priority || left.id - right.id)
      .forEach((candidate) => {
        if (
          !candidate.force &&
          acceptedLabels.some((accepted) => labelsOverlap(candidate, accepted))
        ) {
          return;
        }
        acceptedLabels.push(candidate);
      });

    context.font = `11px ${GRAPH_FONT_FAMILY}`;
    context.textAlign = "center";
    acceptedLabels
      .sort((left, right) => left.priority - right.priority || left.id - right.id)
      .forEach((candidate) => {
        // 低透明度底色：标题压在星点/结构线上仍可读（§4.7）。
        const labelWidth = context.measureText(candidate.label).width;
        context.fillStyle =
          themeMode === "dark" ? "rgba(9, 11, 18, 0.55)" : "rgba(248, 247, 244, 0.62)";
        context.fillRect(
          candidate.x - labelWidth / 2 - 3,
          candidate.y - 10,
          labelWidth + 6,
          13
        );
        context.fillStyle = getGraphLabelFill(themeMode, candidate.alpha);
        context.fillText(candidate.label, candidate.x, candidate.y);
      });
  }, [
    data.nodes,
    emotionById,
    getNodeTooltip,
    height,
    highlightedNodeIdSet,
    playing,
    scrubbing,
    selectedNodeId,
    themeMode,
    width,
  ]);

  // Latest-draw ref: the layout effect must NOT re-run when only selection /
  // highlight / theme change (those redraw via the effect below).
  const drawRef = useRef(draw);
  useEffect(() => {
    drawRef.current = draw;
  }, [draw]);

  const stopMotion = useCallback(() => {
    if (motionFrameRef.current !== null) {
      cancelAnimationFrame(motionFrameRef.current);
      motionFrameRef.current = null;
    }
    spinVelocityRef.current = { rotX: 0, rotY: 0 };
  }, []);

  /** Smooth cubic ease-in-out camera flight (preset buttons). Draw-only rAF:
   * no React state, no layout recompute — just camera + repaint. */
  const animateCameraTo = useCallback(
    (target: CameraState) => {
      stopMotion();
      const start = { ...cameraRef.current };
      const yawDelta = angularDelta(start.rotY, target.rotY);
      const startTime = performance.now();

      const step = (now: number) => {
        const progress = clamp((now - startTime) / PRESET_ANIMATION_MS, 0, 1);
        const eased = easeInOutCubic(progress);
        cameraRef.current = {
          rotX: start.rotX + (target.rotX - start.rotX) * eased,
          rotY: start.rotY + yawDelta * eased,
          distance: start.distance + (target.distance - start.distance) * eased,
        };
        drawRef.current();
        if (progress < 1) {
          motionFrameRef.current = requestAnimationFrame(step);
        } else {
          motionFrameRef.current = null;
        }
      };

      motionFrameRef.current = requestAnimationFrame(step);
    },
    [stopMotion]
  );

  const startSpinInertia = useCallback(() => {
    // A held-still finger must not fling on release: only samples from the
    // last moments of the drag count as launch velocity.
    if (performance.now() - lastDragSampleRef.current.time > 120) return;
    const velocity = spinVelocityRef.current;
    if (Math.hypot(velocity.rotX, velocity.rotY) < INERTIA_MIN_SPEED) return;
    stopMotion();
    spinVelocityRef.current = velocity;
    let lastTime = performance.now();

    const step = (now: number) => {
      const dt = Math.min(0.064, (now - lastTime) / 1000);
      lastTime = now;
      const decay = Math.exp(-dt / INERTIA_DECAY_SECONDS);
      spinVelocityRef.current = {
        rotX: spinVelocityRef.current.rotX * decay,
        rotY: spinVelocityRef.current.rotY * decay,
      };
      if (Math.hypot(spinVelocityRef.current.rotX, spinVelocityRef.current.rotY) < INERTIA_MIN_SPEED) {
        motionFrameRef.current = null;
        return;
      }
      const camera = cameraRef.current;
      const nextRotX = clamp(
        camera.rotX + spinVelocityRef.current.rotX * dt,
        -MAX_TILT,
        MAX_TILT
      );
      if (nextRotX === -MAX_TILT || nextRotX === MAX_TILT) {
        spinVelocityRef.current = { ...spinVelocityRef.current, rotX: 0 };
      }
      cameraRef.current = {
        rotX: nextRotX,
        rotY: camera.rotY + spinVelocityRef.current.rotY * dt,
        distance: camera.distance,
      };
      drawRef.current();
      motionFrameRef.current = requestAnimationFrame(step);
    };

    motionFrameRef.current = requestAnimationFrame(step);
  }, [stopMotion]);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;

    const observer = new ResizeObserver((entries) => {
      const nextWidth = entries[0]?.contentRect.width ?? wrapper.clientWidth;
      setWidth(nextWidth);
    });

    observer.observe(wrapper);
    setWidth(wrapper.getBoundingClientRect().width);

    return () => observer.disconnect();
  }, []);

  // Layout is a pure function of data + grouping only: camera, hover,
  // selection, scrub and replay never recompute it (tabs/AGENTS.md §4).
  // Regrouping keeps the previous layout in transitionRef so surviving
  // nodes/labels slerp to their new slots instead of jump-cutting; the first
  // layout (empty previous) and all-new node sets snap directly.
  useEffect(() => {
    const previous = layoutRef.current;
    const next = buildSphereLayout(data.nodes, groups ?? []);
    layoutRef.current = next;

    if (previous.positions.size > 0) {
      const from = new Map<number, SphereVec3>();
      for (const [id, position] of previous.positions) {
        if (next.positions.has(id)) from.set(id, position);
      }
      const nextCenterKeys = new Set(next.constellations.map((constellation) => constellation.key));
      const fromCenters = new Map<string, SphereVec3>();
      for (const constellation of previous.constellations) {
        if (nextCenterKeys.has(constellation.key)) {
          fromCenters.set(constellation.key, constellation.center);
        }
      }
      transitionRef.current =
        from.size > 0 ? { from, fromCenters, startedAt: performance.now() } : null;
    } else {
      transitionRef.current = null;
    }
    drawRef.current();
  }, [data.nodes, groups]);

  // Standing ambient loop: the breathing glow is wall-clock, and grouping
  // transitions are time-based, so both need a permanent rAF that only
  // repaints (the same idempotent draw every other effect uses). Throttled
  // to ~30fps — except during the 360ms transition, which runs unthrottled
  // for smoothness. Replay/scrub draws arrive via the currentDay effect and
  // simply stack on top. Pauses when the tab is hidden or the host reports
  // the graph inactive (which also halts any in-flight camera motion).
  useEffect(() => {
    if (!isActive) {
      stopMotion();
      return;
    }
    const step = (now: number) => {
      ambientFrameRef.current = requestAnimationFrame(step);
      if (document.hidden) return;
      const transitionActive = transitionRef.current !== null;
      if (!transitionActive && now - lastAmbientDrawRef.current < 33) return;
      lastAmbientDrawRef.current = now;
      drawRef.current();
    };
    ambientFrameRef.current = requestAnimationFrame(step);
    return () => {
      if (ambientFrameRef.current !== null) cancelAnimationFrame(ambientFrameRef.current);
      ambientFrameRef.current = null;
    };
  }, [isActive, stopMotion]);

  useEffect(() => {
    currentDayRef.current = currentDay;
    draw();
  }, [currentDay, draw, resetToken, scrubbing, selectedNodeId, highlightedNodeIdSet]);

  // Hard timeline reset also flies the camera back to the overview default
  // (same cubic ease-in-out flight as the preset buttons, not a jump cut).
  useEffect(() => {
    if (resetToken === 0) return;
    animateCameraTo({ ...DEFAULT_CAMERA });
  }, [resetToken, animateCameraTo]);

  useEffect(() => () => stopMotion(), [stopMotion]);

  const initializeRotateGesture = useCallback(
    (pointerId: number, clientX: number, clientY: number) => {
      gestureRef.current = {
        mode: "rotate",
        pointerId,
        startClientX: clientX,
        startClientY: clientY,
        startRotX: cameraRef.current.rotX,
        startRotY: cameraRef.current.rotY,
        startCameraDistance: cameraRef.current.distance,
        startPointerGap: 0,
        moved: false,
      };
      spinVelocityRef.current = { rotX: 0, rotY: 0 };
      lastDragSampleRef.current = {
        rotX: cameraRef.current.rotX,
        rotY: cameraRef.current.rotY,
        time: performance.now(),
      };
    },
    []
  );

  const initializePinchGesture = useCallback(() => {
    const points = Array.from(activePointersRef.current.values());
    if (points.length < 2) return;

    gestureRef.current = {
      mode: "pinch",
      pointerId: null,
      startClientX: 0,
      startClientY: 0,
      startRotX: cameraRef.current.rotX,
      startRotY: cameraRef.current.rotY,
      startCameraDistance: cameraRef.current.distance,
      startPointerGap: Math.max(1, getDistanceBetweenPointers(points)),
      moved: true,
    };
  }, []);

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      stopMotion();
      activePointersRef.current.set(event.pointerId, {
        clientX: event.clientX,
        clientY: event.clientY,
      });

      if (activePointersRef.current.size === 1) {
        initializeRotateGesture(event.pointerId, event.clientX, event.clientY);
      } else if (activePointersRef.current.size === 2) {
        initializePinchGesture();
        setIsDragging(false);
      }

      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [initializePinchGesture, initializeRotateGesture, stopMotion]
  );

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      if (!activePointersRef.current.has(event.pointerId)) return;

      activePointersRef.current.set(event.pointerId, {
        clientX: event.clientX,
        clientY: event.clientY,
      });

      if (activePointersRef.current.size >= 2) {
        if (gestureRef.current.mode !== "pinch") {
          initializePinchGesture();
        }

        const points = Array.from(activePointersRef.current.values());
        const gap = Math.max(1, getDistanceBetweenPointers(points));
        cameraRef.current = {
          ...cameraRef.current,
          distance: clamp(
            gestureRef.current.startCameraDistance *
              (gestureRef.current.startPointerGap / gap),
            MIN_CAMERA_DISTANCE,
            MAX_CAMERA_DISTANCE
          ),
        };
        draw();
        return;
      }

      if (
        gestureRef.current.mode !== "rotate" ||
        gestureRef.current.pointerId !== event.pointerId
      ) {
        return;
      }

      const deltaX = event.clientX - gestureRef.current.startClientX;
      const deltaY = event.clientY - gestureRef.current.startClientY;
      if (!gestureRef.current.moved && Math.hypot(deltaX, deltaY) > DRAG_THRESHOLD) {
        gestureRef.current.moved = true;
        setIsDragging(true);
      }

      if (!gestureRef.current.moved) return;

      // Grab-the-globe: content follows the pointer. The same sign works for
      // the inside view (d < 1) because the projection formula is shared.
      const radiansPerPixel = ROTATE_RADIANS_PER_WIDTH / Math.max(width, 360);
      const nextRotY = gestureRef.current.startRotY + deltaX * radiansPerPixel;
      const nextRotX = clamp(
        gestureRef.current.startRotX + deltaY * radiansPerPixel,
        -MAX_TILT,
        MAX_TILT
      );

      const now = performance.now();
      const sample = lastDragSampleRef.current;
      const sampleDt = (now - sample.time) / 1000;
      if (sampleDt > 0.008) {
        const instantRotX = (nextRotX - sample.rotX) / sampleDt;
        const instantRotY = (nextRotY - sample.rotY) / sampleDt;
        spinVelocityRef.current = {
          rotX: spinVelocityRef.current.rotX * 0.75 + instantRotX * 0.25,
          rotY: spinVelocityRef.current.rotY * 0.75 + instantRotY * 0.25,
        };
        lastDragSampleRef.current = { rotX: nextRotX, rotY: nextRotY, time: now };
      }

      cameraRef.current = {
        rotX: nextRotX,
        rotY: nextRotY,
        distance: cameraRef.current.distance,
      };
      draw();
    },
    [draw, initializePinchGesture, width]
  );

  const releasePointer = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }

      const wasRotate =
        gestureRef.current.mode === "rotate" &&
        gestureRef.current.pointerId === event.pointerId;
      const shouldHandleClick = wasRotate && !gestureRef.current.moved;
      const shouldStartInertia = wasRotate && gestureRef.current.moved;

      activePointersRef.current.delete(event.pointerId);

      if (activePointersRef.current.size >= 2) {
        initializePinchGesture();
      } else if (activePointersRef.current.size === 1) {
        const [remainingPointerId, remainingPointer] = Array.from(
          activePointersRef.current.entries()
        )[0];
        initializeRotateGesture(remainingPointerId, remainingPointer.clientX, remainingPointer.clientY);
      } else {
        gestureRef.current = createGestureState();
        setIsDragging(false);
      }

      if (shouldStartInertia) {
        startSpinInertia();
      }

      if (!shouldHandleClick) return;

      // Picking: hit-test the projected (screen-space) nodes — the inverse of
      // the same projection used for drawing, so near stars win over far ones.
      const rect = event.currentTarget.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      const hitNode = hitTestNode(activeNodesRef.current, x, y, currentDayRef.current);
      if (hitNode) {
        onNodeClick?.(hitNode.id);
      } else {
        onBackgroundClick?.();
      }
    },
    [initializePinchGesture, initializeRotateGesture, onBackgroundClick, onNodeClick, startSpinInertia]
  );

  const handleWheel = useCallback(
    (event: React.WheelEvent<HTMLCanvasElement>) => {
      event.preventDefault();
      stopMotion();
      cameraRef.current = {
        ...cameraRef.current,
        distance: clamp(
          cameraRef.current.distance * Math.exp(event.deltaY * WHEEL_ZOOM_INTENSITY),
          MIN_CAMERA_DISTANCE,
          MAX_CAMERA_DISTANCE
        ),
      };
      draw();
    },
    [draw, stopMotion]
  );

  // Hover tooltip: hit-test only when no gesture is active, and only set
  // state when the hovered node changes (no per-move re-renders).
  const handleHoverMove = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      if (activePointersRef.current.size > 0 || gestureRef.current.moved) return;
      const rect = event.currentTarget.getBoundingClientRect();
      const hit = hitTestNode(
        activeNodesRef.current,
        event.clientX - rect.left,
        event.clientY - rect.top,
        currentDayRef.current
      );
      const nextId = hit ? hit.id : null;
      if (nextId === hoverIdRef.current) return;
      hoverIdRef.current = nextId;
      setHoveredNode(hit);
    },
    []
  );

  const handlePointerLeave = useCallback(() => {
    if (hoverIdRef.current === null) return;
    hoverIdRef.current = null;
    setHoveredNode(null);
  }, []);

  const hoveredTooltip = hoveredNode ? getNodeTooltip?.(hoveredNode) ?? null : null;

  return (
    <div ref={wrapperRef} className="relative h-full w-full">
      <canvas
        ref={canvasRef}
        className="block h-full w-full"
        style={{ cursor: isDragging ? "grabbing" : "grab", touchAction: "none" }}
        onPointerDown={handlePointerDown}
        onPointerMove={(event) => {
          handlePointerMove(event);
          handleHoverMove(event);
        }}
        onPointerUp={releasePointer}
        onPointerCancel={releasePointer}
        onPointerLeave={handlePointerLeave}
        onWheel={handleWheel}
      />
      {hoveredNode && !isDragging && (
        <div
          className="pointer-events-none absolute z-10 max-w-[260px] rounded-md border border-border-subtle bg-bg-primary px-2.5 py-1.5 shadow-md"
          style={{
            left: Math.min(hoveredNode.x + 12, Math.max(0, width - 270)),
            top: Math.max(4, hoveredNode.y - hoveredNode.radius - 8),
          }}
        >
          <div className="truncate text-[11px] font-sans font-medium text-text-primary">
            {hoveredNode.kind === "cluster"
              ? hoveredNode.label
              : truncateLabel(hoveredNode.label, 42)}
          </div>
          {hoveredTooltip && (
            <div className="mt-0.5 line-clamp-2 text-[10px] font-sans text-text-tertiary">
              {hoveredTooltip}
            </div>
          )}
        </div>
      )}

      {/* Camera presets: frosted-glass corner buttons, cubic ease-in-out flight. */}
      <div className="absolute bottom-3 right-3 flex gap-2">
        <button
          type="button"
          aria-label={overviewLabel}
          title={overviewLabel}
          onClick={() => animateCameraTo({ ...DEFAULT_CAMERA })}
          className="flex h-8 w-8 items-center justify-center rounded-full border border-border-subtle/60 bg-bg-primary/55 text-[13px] leading-none backdrop-blur-md transition-colors hover:bg-bg-primary/80"
        >
          🌐
        </button>
        <button
          type="button"
          aria-label={immerseLabel}
          title={immerseLabel}
          onClick={() =>
            animateCameraTo({ ...cameraRef.current, distance: IMMERSIVE_DISTANCE })
          }
          className="flex h-8 w-8 items-center justify-center rounded-full border border-border-subtle/60 bg-bg-primary/55 text-[13px] leading-none backdrop-blur-md transition-colors hover:bg-bg-primary/80"
        >
          ✨
        </button>
      </div>
    </div>
  );
}
