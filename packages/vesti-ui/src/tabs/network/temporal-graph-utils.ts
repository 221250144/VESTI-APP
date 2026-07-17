import type { Conversation, Platform, UiThemeMode } from "../../types";

export const DAY_MS = 86_400_000;
export const GRAPH_FONT_FAMILY =
  '"Inter", "SF Pro Text", -apple-system, "PingFang SC", sans-serif';
export const GRAPH_HEIGHT = 420;
export const TIMEBAR_HEIGHT = 72;
export const TIMEBAR_HORIZONTAL_PADDING = 12;
export const TIMEBAR_CHART_TOP = 8;
export const TIMEBAR_CHART_HEIGHT = 42;
export const TIMEBAR_TICK_Y = 66;

export interface GraphNode {
  id: number;
  label: string;
  platform: Platform;
  day: number;
  timelineDay: number;
  messageCount: number;
  originAt: number;
  firstCapturedAt: number;
  lastCapturedAt: number;
  createdAt: number;
  radius: number;
  color: string;
}

export interface GraphEdge {
  source: number;
  target: number;
  weight: number;
}

export interface NetworkData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  totalDays: number;
}

export interface TemporalNetworkDataset {
  data: NetworkData;
  dayCounts: number[];
  newestNodeByDay: Map<number, GraphNode>;
}

export const GRAPH_PLATFORM_COLORS: Record<Platform, string> = {
  ChatGPT: "#4a90d9",
  Claude: "#bf7b3a",
  Gemini: "#5c6bc0",
  DeepSeek: "#2979c0",
  Qwen: "#C026D3",
  Doubao: "#1E6FFF",
  Kimi: "#181C28",
  Yuanbao: "#00C5A3",
  Codex: "#10A37F",
  Cursor: "#6B7280",
  "Kimi Code": "#181C28",
  "Claude Code": "#bf7b3a",
  Aider: "#E11D48",
};

export function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

export function sigmoid(x: number) {
  return 1 / (1 + Math.exp(-x));
}

export function truncateLabel(label: string, maxLength = 18) {
  const normalized = label.trim() || "Untitled";
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength).trimEnd()}...`
    : normalized;
}

export function getNodeRadius(messageCount: number) {
  const safeCount = Math.max(0, Number.isFinite(messageCount) ? messageCount : 0);
  return clamp(10 + Math.log(safeCount + 1) * 3, 10, 22);
}

export function getNodeAlpha(node: GraphNode, currentDay: number) {
  if (node.timelineDay > currentDay) return 0;
  const age = currentDay - node.timelineDay;
  return Math.max(0.15, 0.2 + 0.8 * sigmoid(3 - age * 0.6));
}

export function getEdgeAlpha(
  edge: GraphEdge,
  sourceNode: GraphNode,
  targetNode: GraphNode,
  currentDay: number
) {
  const latestDay = Math.max(sourceNode.timelineDay, targetNode.timelineDay);
  if (latestDay > currentDay) return 0;
  const edgeAge = currentDay - latestDay;
  return edge.weight * Math.max(0.08, 0.15 + 0.6 * sigmoid(2.5 - edgeAge * 0.55));
}

export function hexToRgba(hex: string, alpha: number) {
  const normalized = hex.replace("#", "");
  const r = Number.parseInt(normalized.slice(0, 2), 16);
  const g = Number.parseInt(normalized.slice(2, 4), 16);
  const b = Number.parseInt(normalized.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function getDisplayDay(currentDay: number, totalDays: number) {
  if (totalDays <= 0) return 0;
  return clamp(Math.ceil(currentDay) || 1, 1, totalDays);
}

export function getVisibleConversationCount(nodes: GraphNode[], currentDay: number) {
  return nodes.reduce((count, node) => count + (node.timelineDay <= currentDay ? 1 : 0), 0);
}

export function getGraphEdgeStroke(themeMode: UiThemeMode, alpha: number) {
  const rgb = themeMode === "dark" ? "180, 178, 168" : "100, 98, 90";
  return `rgba(${rgb}, ${alpha})`;
}

export function getGraphLabelFill(themeMode: UiThemeMode, alpha: number) {
  const rgb = themeMode === "dark" ? "200, 198, 190" : "65, 63, 58";
  return `rgba(${rgb}, ${alpha})`;
}

export function getTimebarMetrics(width: number, totalDays: number) {
  const safeWidth = Math.max(0, width);
  const usableWidth = Math.max(0, safeWidth - TIMEBAR_HORIZONTAL_PADDING * 2);
  const dayWidth = totalDays > 0 ? usableWidth / totalDays : 0;
  return {
    usableWidth,
    dayWidth,
    chartTop: TIMEBAR_CHART_TOP,
    chartHeight: TIMEBAR_CHART_HEIGHT,
    chartBottom: TIMEBAR_CHART_TOP + TIMEBAR_CHART_HEIGHT,
    tickY: TIMEBAR_TICK_Y,
  };
}

export function dayToPixel(day: number, totalDays: number, width: number) {
  if (totalDays <= 0) return TIMEBAR_HORIZONTAL_PADDING;
  const { usableWidth } = getTimebarMetrics(width, totalDays);
  const x = TIMEBAR_HORIZONTAL_PADDING + ((day - 0.5) / totalDays) * usableWidth;
  return clamp(x, TIMEBAR_HORIZONTAL_PADDING, TIMEBAR_HORIZONTAL_PADDING + usableWidth);
}

export function pixelToDay(x: number, totalDays: number, width: number) {
  if (totalDays <= 0) return 0;
  const { usableWidth } = getTimebarMetrics(width, totalDays);
  if (usableWidth <= 0) return 0;
  const fraction = clamp((x - TIMEBAR_HORIZONTAL_PADDING) / usableWidth, 0, 1);
  return fraction * totalDays;
}

export function timelineToPixel(day: number, totalDays: number, width: number) {
  if (totalDays <= 0) return TIMEBAR_HORIZONTAL_PADDING;
  const { usableWidth } = getTimebarMetrics(width, totalDays);
  const fraction = clamp(day / totalDays, 0, 1);
  return TIMEBAR_HORIZONTAL_PADDING + fraction * usableWidth;
}

export function dayToProgress(day: number, totalDays: number) {
  if (totalDays <= 0) return 0;
  return clamp(day / totalDays, 0, 1);
}

export function progressToDay(progress: number, totalDays: number) {
  if (totalDays <= 0) return 0;
  return clamp(progress, 0, 1) * totalDays;
}

export function getTrendPointY(
  count: number,
  maxCount: number,
  chartTop: number,
  chartHeight: number
) {
  const normalized = maxCount > 0 ? count / maxCount : 0;
  const visibleHeight = normalized > 0 ? Math.max(4, normalized * chartHeight) : 2;
  return chartTop + chartHeight - visibleHeight;
}

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function getConversationSourceCreatedAt(conversation: Conversation) {
  return isFiniteTimestamp(conversation.source_created_at)
    ? conversation.source_created_at
    : null;
}

export function getConversationFirstCapturedAt(conversation: Conversation) {
  return isFiniteTimestamp(conversation.first_captured_at)
    ? conversation.first_captured_at
    : conversation.created_at;
}

export function getConversationLastCapturedAt(conversation: Conversation) {
  return isFiniteTimestamp(conversation.last_captured_at)
    ? conversation.last_captured_at
    : conversation.updated_at;
}

export function getConversationOriginAt(conversation: Conversation) {
  return (
    getConversationSourceCreatedAt(conversation) ??
    getConversationFirstCapturedAt(conversation)
  );
}

function compareConversationChronology(left: Conversation, right: Conversation) {
  const leftOriginAt = getConversationOriginAt(left);
  const rightOriginAt = getConversationOriginAt(right);
  if (leftOriginAt !== rightOriginAt) {
    return leftOriginAt - rightOriginAt;
  }

  const leftFirstCapturedAt = getConversationFirstCapturedAt(left);
  const rightFirstCapturedAt = getConversationFirstCapturedAt(right);
  if (leftFirstCapturedAt !== rightFirstCapturedAt) {
    return leftFirstCapturedAt - rightFirstCapturedAt;
  }

  if (left.created_at !== right.created_at) {
    return left.created_at - right.created_at;
  }

  return left.id - right.id;
}

function compareGraphNodeChronology(left: GraphNode, right: GraphNode) {
  if (left.originAt !== right.originAt) {
    return left.originAt - right.originAt;
  }

  if (left.firstCapturedAt !== right.firstCapturedAt) {
    return left.firstCapturedAt - right.firstCapturedAt;
  }

  if (left.createdAt !== right.createdAt) {
    return left.createdAt - right.createdAt;
  }

  return left.id - right.id;
}

export function buildTemporalNetworkDataset(
  conversations: Conversation[],
  edges: GraphEdge[]
): TemporalNetworkDataset {
  const sortedConversations = conversations
    .filter((conversation) => !conversation.is_archived && !conversation.is_trash)
    .slice()
    .sort(compareConversationChronology);

  if (sortedConversations.length === 0) {
    return {
      data: { nodes: [], edges: [], totalDays: 0 },
      dayCounts: [0],
      newestNodeByDay: new Map<number, GraphNode>(),
    };
  }

  const firstTimestamp = getConversationOriginAt(sortedConversations[0]);
  const nodes = sortedConversations.map<GraphNode>((conversation) => {
    const originAt = getConversationOriginAt(conversation);
    const firstCapturedAt = getConversationFirstCapturedAt(conversation);
    const lastCapturedAt = getConversationLastCapturedAt(conversation);
    const day =
      Math.floor(Math.max(0, originAt - firstTimestamp) / DAY_MS) + 1;
    const messageCount =
      typeof conversation.message_count === "number" && Number.isFinite(conversation.message_count)
        ? Math.max(0, Math.floor(conversation.message_count))
        : 0;

    return {
      id: conversation.id,
      label: conversation.title.trim() || "Untitled",
      platform: conversation.platform,
      day,
      timelineDay: day,
      messageCount,
      originAt,
      firstCapturedAt,
      lastCapturedAt,
      createdAt: conversation.created_at,
      radius: getNodeRadius(messageCount),
      color: GRAPH_PLATFORM_COLORS[conversation.platform],
    };
  });

  const totalDays = nodes[nodes.length - 1]?.day ?? 0;
  const dayCounts = Array.from({ length: totalDays + 1 }, () => 0);
  const newestNodeByDay = new Map<number, GraphNode>();
  const nodesPerDay = new Map<number, number>();
  const seenPerDay = new Map<number, number>();

  for (const node of nodes) {
    nodesPerDay.set(node.day, (nodesPerDay.get(node.day) ?? 0) + 1);
  }

  for (const node of nodes) {
    const dayCount = nodesPerDay.get(node.day) ?? 1;
    const dayIndex = (seenPerDay.get(node.day) ?? 0) + 1;
    seenPerDay.set(node.day, dayIndex);
    node.timelineDay =
      dayCount <= 1 ? node.day : node.day - 1 + dayIndex / dayCount;

    dayCounts[node.day] += 1;
    const existing = newestNodeByDay.get(node.day);
    if (!existing || compareGraphNodeChronology(node, existing) > 0) {
      newestNodeByDay.set(node.day, node);
    }
  }

  const nodeIds = new Set(nodes.map((node) => node.id));
  const filteredEdges = edges.filter(
    (edge) => edge.weight >= 0.4 && nodeIds.has(edge.source) && nodeIds.has(edge.target)
  );

  return {
    data: {
      nodes,
      edges: filteredEdges,
      totalDays,
    },
    dayCounts,
    newestNodeByDay,
  };
}

export function hitTestNode<
  T extends { timelineDay: number; x: number; y: number; radius: number }
>(
  nodes: T[],
  x: number,
  y: number,
  currentDay: number
) {
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index];
    if (node.timelineDay > currentDay) continue;
    const dx = x - node.x;
    const dy = y - node.y;
    if (Math.sqrt(dx * dx + dy * dy) <= node.radius + 4) {
      return node;
    }
  }

  return null;
}
