"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, Maximize2, Minimize2, X } from "lucide-react";
import type {
  ChatSummaryData,
  StorageApi,
  UiThemeMode,
} from "../types";
import type { DashboardLabels } from "../types";
import { useLibraryData } from "../contexts/library-data";
import { getPlatformBadgeStyle, getPlatformLabel } from "../constants/platform";
import { GraphLegend } from "./network/GraphLegend";
import {
  EMOTION_FAMILIES,
  EMOTION_FAMILY_LABELS,
  getEmotionColor,
  getEmotionFamily,
  type EmotionFamily,
} from "./network/emotionColors";
import { TemporalGraph } from "./network/TemporalGraph";
import { TimeBar } from "./network/TimeBar";
import {
  GRAPH_HEIGHT,
  buildNetworkGroups,
  buildTemporalNetworkDataset,
  dayToProgress,
  getConversationOriginAt,
  getVisibleConversationCount,
  progressToDay,
  type GraphNode,
  type NetworkGroupBy,
} from "./network/temporal-graph-utils";

const SUMMARY_FETCH_BATCH = 8;
/** Bound summary loading (star emotion colors): most recent first, capped. */
const SUMMARY_FETCH_MAX = 400;
/** Node budget for the conversation sphere (see temporal-graph-utils). */
const MAX_GRAPH_NODES = 260;
/** Sphere legend footnotes (English, matching the slice-1 preset
 * buttons -- i18n labels for these are follow-up work). */
const EMOTION_LEGEND_NOTES = [
  "Pale tint = last activity (blue recent → red dormant)",
  "Steady halo = starred",
];
/** Full-bleed sky: the tab background itself is the sky — no panel, no
 * edge, so the sphere floats in open space (canvas stays transparent).
 * Theme-anchored: the far field converges exactly to --bg-tertiary. The dark
 * theme stays hue-free black (premium feel): depth comes from value steps —
 * slightly deeper zenith overhead, faint halo near the sphere — not blue. */
const SKY_BACKGROUND: Record<UiThemeMode, string> = {
  dark: "radial-gradient(ellipse 150% 110% at 50% 42%, #232323 0%, rgba(26, 26, 26, 0) 68%), linear-gradient(#141414 0%, #1a1a1a 52%)",
  light:
    "radial-gradient(ellipse 150% 110% at 50% 42%, rgba(228, 234, 246, 0.9) 0%, rgba(249, 250, 252, 0) 70%), linear-gradient(#eef1f7 0%, #f9fafc 58%)",
};
/** Cap the cluster drawer member list; the rest is summarized. */
const CLUSTER_DRAWER_MEMBER_LIMIT = 60;

interface NetworkTabProps {
  storage: StorageApi;
  themeMode?: UiThemeMode;
  isActive?: boolean;
  onSelectConversation?: (id: number) => void;
  labels?: DashboardLabels["network"];
}

const PLAYBACK_DURATION_MS = 8_000;

function formatDefaultInfo(totalDays: number, labels: DashboardLabels["network"]) {
  if (totalDays <= 0) return labels.noConversationsYet;
  return labels.replayInfo;
}

function formatBirthInfo(label: string, platform: string, labels: DashboardLabels["network"]) {
  if (label.trim().toLowerCase() === platform.trim().toLowerCase()) {
    return labels.newConversationOn.replace("{platform}", platform);
  }
  return labels.conversationOn.replace("{label}", label).replace("{platform}", platform);
}

function formatStartedLabel(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(timestamp);
}

export function NetworkTab({
  storage,
  themeMode = "light",
  isActive = true,
  onSelectConversation,
  labels: providedLabels,
}: NetworkTabProps) {
  const labels = providedLabels ?? ({} as DashboardLabels["network"]);
  const { conversations, topics, digestByConversationId } = useLibraryData();
  const [currentDay, setCurrentDay] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [scrubbing, setScrubbing] = useState(false);
  const [playbackToken, setPlaybackToken] = useState(0);
  const [infoText, setInfoText] = useState(labels.noConversationsYet ?? "No conversations captured yet.");
  const [graphResetToken, setGraphResetToken] = useState(0);
  const [scrubToken, setScrubToken] = useState(0);
  // 星轨球不绘制语义边（design §3），也不再加载 getAllEdges——桌面宿主本就
  // 未实现它。`dataset.data.edges` 恒为空；切片 3 起抽屉的 semantic-links
  // 区块随之移除，"关联"改由同星座高亮表达。
  const [selectedNodeId, setSelectedNodeId] = useState<number | null>(null);
  // Emotional tone per conversation (summary meta_observations.emotional_tone)
  // — the ONLY source of star colors on the conversation sphere. Digests
  // carry no emotional_tone, so every non-trash conversation is fetched.
  const [emotionToneById, setEmotionToneById] = useState<Map<number, string>>(
    () => new Map()
  );
  const hasProjectData = useMemo(
    () => [...digestByConversationId.values()].some((digest) => digest.projectKey),
    [digestByConversationId]
  );
  const [groupBy, setGroupBy] = useState<NetworkGroupBy>("platform");
  // Default to the project×time reading once project digests exist (L1 data);
  // otherwise stay on the platform reading that works everywhere.
  useEffect(() => {
    if (hasProjectData) setGroupBy((current) => (current === "platform" ? "project" : current));
  }, [hasProjectData]);
  const animationFrameRef = useRef<number | null>(null);
  const playbackOriginRef = useRef<number | null>(null);
  const playbackStartProgressRef = useRef(0);
  const currentDayRef = useRef(0);
  const previousDayRef = useRef(0);
  const previousScrubTokenRef = useRef(0);
  const previousIsActiveRef = useRef(isActive);
  const previousTotalDaysRef = useRef(0);

  const topicMap = useMemo(() => {
    const map = new Map<number, string>();
    const walk = (items: typeof topics) => {
      items.forEach((topic) => {
        map.set(topic.id, topic.name);
        if (topic.children) walk(topic.children);
      });
    };
    walk(topics);
    return map;
  }, [topics]);
  const conversationsById = useMemo(
    () => new Map(conversations.map((conversation) => [conversation.id, conversation])),
    [conversations]
  );
  // Semantic grouping (platform / topic / project) → node colors, legend
  // swatches, cluster identity. Project grouping needs digest data (APP only).
  const networkGroups = useMemo(
    () =>
      buildNetworkGroups(conversations, groupBy, {
        topicNameById: topicMap,
        digestById: digestByConversationId,
        otherLabel: labels.groupOther ?? "Ungrouped",
      }),
    [conversations, groupBy, topicMap, digestByConversationId, labels.groupOther]
  );
  const groupColorByKey = useMemo(
    () => new Map(networkGroups.groups.map((group) => [group.key, group.color])),
    [networkGroups.groups]
  );
  const groupLabelByKey = useMemo(
    () => new Map(networkGroups.groups.map((group) => [group.key, group.label])),
    [networkGroups.groups]
  );

  const dataset = useMemo(
    () =>
      buildTemporalNetworkDataset(conversations, [], {
        groupKeyById: networkGroups.groupKeyById,
        groupColorByKey,
        maxNodes: MAX_GRAPH_NODES,
      }),
    [conversations, networkGroups.groupKeyById, groupColorByKey]
  );
  // Unclustered dataset: full conversation id set (visible count) stays
  // truthful regardless of aggregation.
  const baseDataset = useMemo(
    () => buildTemporalNetworkDataset(conversations, [], { maxNodes: Infinity }),
    [conversations]
  );
  const totalDays = dataset.data.totalDays;

  // Star colors: conversation nodes bucket their own emotional tone; cluster
  // nodes inherit the newest member's family (same "latest wins" semantics as
  // the cluster color). Missing/unmatched tones simply stay out of the map —
  // the renderer falls back to the neutral grey-white star.
  const emotionById = useMemo(() => {
    const map = new Map<number, EmotionFamily | null>();
    for (const node of dataset.data.nodes) {
      const toneId =
        node.kind === "cluster" ? node.memberIds?.[node.memberIds.length - 1] : node.id;
      const family = getEmotionFamily(
        toneId !== undefined ? emotionToneById.get(toneId) : undefined
      );
      if (family) map.set(node.id, family);
    }
    return map;
  }, [dataset.data.nodes, emotionToneById]);
  // Emotion legend swatches in EMOTION_FAMILIES order; colors follow the
  // active theme, notes explain the two non-emotion visual channels.
  const emotionSwatches = useMemo(
    () =>
      EMOTION_FAMILIES.map((family) => ({
        key: family,
        label: EMOTION_FAMILY_LABELS[family],
        color: getEmotionColor(family, themeMode),
      })),
    [themeMode]
  );



  // Load emotional tones for the conversation-sphere star colors:
  // bounded-concurrency summary fetch, most recent first, capped.
  useEffect(() => {
    const getSummary = storage.getSummary;
    if (!getSummary) {
      setEmotionToneById(new Map());
      return;
    }

    const targetIds = conversations
      .filter((conversation) => !conversation.is_trash)
      .sort(
        (left, right) =>
          getConversationOriginAt(right) - getConversationOriginAt(left) ||
          right.id - left.id
      )
      .slice(0, SUMMARY_FETCH_MAX)
      .map((conversation) => conversation.id);

    if (targetIds.length === 0) {
      setEmotionToneById(new Map());
      return;
    }

    let cancelled = false;

    const run = async () => {
      const collected = new Map<number, string>();
      for (let start = 0; start < targetIds.length; start += SUMMARY_FETCH_BATCH) {
        if (cancelled) return;
        const batch = targetIds.slice(start, start + SUMMARY_FETCH_BATCH);
        const results = await Promise.all(
          batch.map((id) =>
            getSummary(id)
              .then((summary) => ({ id, summary }))
              .catch(() => ({ id, summary: null as ChatSummaryData | null }))
          )
        );
        for (const { id, summary } of results) {
          const tone = summary?.meta_observations?.emotional_tone;
          if (typeof tone === "string" && tone.trim()) collected.set(id, tone);
        }
      }
      if (!cancelled) setEmotionToneById(collected);
    };

    void run();

    return () => {
      cancelled = true;
    };
  }, [conversations, storage]);

  const visibleCount = useMemo(
    () => getVisibleConversationCount(baseDataset.data.nodes, currentDay),
    [currentDay, baseDataset.data.nodes]
  );
  const selectedGraphNode = useMemo(
    () => dataset.data.nodes.find((node) => node.id === selectedNodeId) ?? null,
    [dataset.data.nodes, selectedNodeId]
  );
  const selectedConversation = useMemo(() => {
    if (selectedNodeId === null || selectedGraphNode?.kind === "cluster") return null;
    return conversationsById.get(selectedNodeId) ?? null;
  }, [conversationsById, selectedNodeId, selectedGraphNode]);
  // Cluster drawer data: member conversations of the selected cluster node,
  // most recent first, capped for rendering.
  const selectedClusterMembers = useMemo(() => {
    if (!selectedGraphNode || selectedGraphNode.kind !== "cluster" || !selectedGraphNode.memberIds) {
      return [];
    }
    return selectedGraphNode.memberIds
      .map((id) => conversationsById.get(id))
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
      .sort(
        (left, right) =>
          getConversationOriginAt(right) - getConversationOriginAt(left) ||
          right.id - left.id
      )
      .slice(0, CLUSTER_DRAWER_MEMBER_LIMIT);
  }, [conversationsById, selectedGraphNode]);
  // 同星座高亮：选中一颗星时，同组（同星座）的其它星保持亮度、其余变暗——
  // 语义边已移除（design §3），星座成员关系是球面上唯一的"关联"语义。
  const highlightedNodeIds = useMemo(
    () =>
      selectedGraphNode
        ? dataset.data.nodes
            .filter((node) => node.groupKey === selectedGraphNode.groupKey)
            .map((node) => node.id)
        : [],
    [dataset.data.nodes, selectedGraphNode]
  );

  const handleGroupByChange = useCallback((next: NetworkGroupBy) => {
    setGroupBy(next);
    setSelectedNodeId(null);
  }, []);

  // Hover detail: digest one-liner for conversations (falls back to the
  // capture snippet), group + date range for clusters.
  const getNodeTooltip = useCallback(
    (node: GraphNode): string | null => {
      if (node.kind === "cluster") {
        const groupLabel = groupLabelByKey.get(node.groupKey);
        const range = `${formatStartedLabel(node.originAt)} – ${formatStartedLabel(
          node.lastCapturedAt
        )}`;
        return [groupLabel, range].filter(Boolean).join(" · ");
      }
      const digest = digestByConversationId.get(node.id);
      if (digest?.oneLiner) return digest.oneLiner;
      const conversation = conversationsById.get(node.id);
      return conversation?.snippet?.trim() || null;
    },
    [conversationsById, digestByConversationId, groupLabelByKey]
  );

  useEffect(() => {
    currentDayRef.current = currentDay;
  }, [currentDay]);

  // 全屏模式：画布铺满窗口，仅保留分组切换与视角预设按钮；ESC 或按钮退出。
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [viewportHeight, setViewportHeight] = useState(() => window.innerHeight);
  useEffect(() => {
    if (!isFullscreen) return;
    const handleResize = () => setViewportHeight(window.innerHeight);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsFullscreen(false);
    };
    window.addEventListener("resize", handleResize);
    window.addEventListener("keydown", handleKeyDown);
    handleResize();
    return () => {
      window.removeEventListener("resize", handleResize);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isFullscreen]);

  useEffect(() => {
    if (!selectedGraphNode) return;
    if (selectedGraphNode.timelineDay > currentDay) {
      setSelectedNodeId(null);
    }
  }, [currentDay, selectedGraphNode]);

  const stopPlayback = useCallback(() => {
    if (animationFrameRef.current !== null) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    playbackOriginRef.current = null;
    setPlaying(false);
  }, []);

  const resetTimeline = useCallback(
    (
      nextDay = 0,
      options: {
        hardReset?: boolean;
        scrub?: boolean;
        nextInfoText?: string;
      } = {}
    ) => {
      const { hardReset = true, scrub = false, nextInfoText } = options;
      const clampedDay = Math.max(0, Math.min(totalDays, nextDay));

      stopPlayback();
      setCurrentDay(clampedDay);
      currentDayRef.current = clampedDay;
      previousDayRef.current = clampedDay;

      if (hardReset) {
        setGraphResetToken((token) => token + 1);
      }

      if (scrub) {
        setScrubToken((token) => token + 1);
      } else {
        previousScrubTokenRef.current = 0;
        setScrubToken(0);
      }

      if (typeof nextInfoText === "string") {
        setInfoText(nextInfoText);
      }
    },
    [stopPlayback, totalDays]
  );

  const startReplay = useCallback(() => {
    if (totalDays <= 0) return;

    resetTimeline(0, {
      hardReset: true,
      scrub: false,
      nextInfoText: formatDefaultInfo(totalDays, labels),
    });
    setScrubbing(false);
    playbackStartProgressRef.current = 0;
    setPlaybackToken((token) => token + 1);
    setPlaying(true);
  }, [resetTimeline, totalDays]);

  useEffect(() => {
    const previousTotalDays = previousTotalDaysRef.current;
    previousTotalDaysRef.current = totalDays;

    if (totalDays <= 0) {
      resetTimeline(0, {
        hardReset: true,
        scrub: false,
        nextInfoText: formatDefaultInfo(0, labels),
      });
      return;
    }

    if (currentDayRef.current > totalDays) {
      setCurrentDay(totalDays);
      currentDayRef.current = totalDays;
      previousDayRef.current = totalDays;
    }

    if (isActive && previousTotalDays <= 0 && totalDays > 0) {
      startReplay();
      return;
    }

    if (!playing && currentDayRef.current === 0 && scrubToken === 0) {
      setInfoText(formatDefaultInfo(totalDays, labels));
    }
  }, [isActive, labels, playing, resetTimeline, scrubToken, startReplay, totalDays]);

  useEffect(() => {
    const wasActive = previousIsActiveRef.current;
    previousIsActiveRef.current = isActive;

    if (!isActive) {
      stopPlayback();
      return;
    }

    if (!wasActive && totalDays > 0) {
      startReplay();
    }
  }, [isActive, startReplay, stopPlayback, totalDays]);

  useEffect(() => {
    if (!playing || totalDays <= 0) return;

    playbackOriginRef.current = null;
    playbackStartProgressRef.current = dayToProgress(currentDayRef.current, totalDays);

    const tick = (timestamp: number) => {
      if (playbackOriginRef.current === null) {
        playbackOriginRef.current =
          timestamp - playbackStartProgressRef.current * PLAYBACK_DURATION_MS;
      }

      const progress = Math.max(
        0,
        Math.min(1, (timestamp - playbackOriginRef.current) / PLAYBACK_DURATION_MS)
      );
      const nextDay = progressToDay(progress, totalDays);

      currentDayRef.current = nextDay;
      setCurrentDay(nextDay);

      if (progress >= 1) {
        animationFrameRef.current = null;
        playbackOriginRef.current = null;
        setPlaying(false);
        return;
      }

      animationFrameRef.current = requestAnimationFrame(tick);
    };

    animationFrameRef.current = requestAnimationFrame(tick);

    return () => {
      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
      playbackOriginRef.current = null;
    };
  }, [playbackToken, playing, totalDays]);

  useEffect(() => {
    const previousDay = previousDayRef.current;
    const didScrub = previousScrubTokenRef.current !== scrubToken;

    if (totalDays > 0 && !playing && currentDay === 0 && scrubToken === 0) {
      previousDayRef.current = 0;
      setInfoText(formatDefaultInfo(totalDays, labels));
      return;
    }

    if (didScrub) {
      previousScrubTokenRef.current = scrubToken;
      previousDayRef.current = currentDay;
      setInfoText(`${visibleCount} ${labels.conversationsVisible ?? "conversations visible"}`);
      return;
    }

    if (currentDay > previousDay) {
      let latestBirth: (typeof dataset.data.nodes)[number] | undefined;
      for (let index = dataset.data.nodes.length - 1; index >= 0; index -= 1) {
        const node = dataset.data.nodes[index];
        if (node.timelineDay <= previousDay) break;
        if (node.timelineDay <= currentDay) {
          latestBirth = node;
          break;
        }
      }

      if (latestBirth) {
        setInfoText(formatBirthInfo(latestBirth.label, latestBirth.platform, labels));
      } else if (!playing) {
        setInfoText(`${visibleCount} ${labels.conversationsVisible ?? "conversations visible"}`);
      }
    } else if (!playing && totalDays > 0 && currentDay > 0) {
      setInfoText(`${visibleCount} ${labels.conversationsVisible ?? "conversations visible"}`);
    }

    previousDayRef.current = currentDay;
  }, [
    currentDay,
    dataset.data.nodes,
    labels,
    playing,
    scrubToken,
    totalDays,
    visibleCount,
  ]);

  useEffect(() => () => stopPlayback(), [stopPlayback]);

  const handleReplay = useCallback(() => {
    setSelectedNodeId(null);
    startReplay();
  }, [startReplay]);

  const handleScrubStart = useCallback(() => {
    stopPlayback();
    setScrubbing(true);
  }, [stopPlayback]);

  const handleScrubChange = useCallback(
    (day: number) => {
      const nextDay = Math.max(0, Math.min(totalDays, day));
      stopPlayback();
      setCurrentDay(nextDay);
      currentDayRef.current = nextDay;
      setScrubToken((token) => token + 1);
    },
    [stopPlayback, totalDays]
  );

  const handleScrubEnd = useCallback(() => {
    // Scrub 手势结束（TimeBar pointerup）——scrubbing 只应覆盖拖动进行中；
    // 切片 2 的涟漪以 playing || scrubbing 为激活条件，停留为 true 会让
    // 静止画面残留定格涟漪。
    setScrubbing(false);
  }, []);

  const handleNodeFocus = useCallback(
    (nodeId: number) => {
      stopPlayback();
      setScrubbing(false);
      setSelectedNodeId(nodeId);
    },
    [stopPlayback]
  );

  const handleCloseDrawer = useCallback(() => {
    setSelectedNodeId(null);
  }, []);

  const handleViewInLibrary = useCallback(() => {
    if (selectedNodeId !== null && onSelectConversation) {
      onSelectConversation(selectedNodeId);
      setSelectedNodeId(null);
    }
  }, [onSelectConversation, selectedNodeId]);

  // Node semantics switcher: what a node's color/group means (source platform,
  // topic, or — when digest data exists — project). "会话" stays the node
  // itself; clusters appear automatically beyond the node budget.
  const groupByOptions: Array<[NetworkGroupBy, string]> = [
    ["platform", labels.groupByPlatform ?? "Platform"],
    ["topic", labels.groupByTopic ?? "Topic"],
    ...(hasProjectData
      ? [["project", labels.groupByProject ?? "Project"] as [NetworkGroupBy, string]]
      : []),
  ];
  const groupByToggle = (
    <div className="flex items-center gap-2">
      <span className="text-[11px] font-sans text-text-tertiary">
        {labels.groupByLabel ?? "Group by"}
      </span>
      <div className="inline-flex rounded-full border border-border-subtle bg-bg-primary p-0.5">
        {groupByOptions.map(([value, label]) => {
          const isActive = groupBy === value;
          return (
            <button
              key={value}
              type="button"
              onClick={() => handleGroupByChange(value)}
              className={`rounded-full px-2.5 py-1 text-[11px] font-sans transition-colors ${
                isActive
                  ? "bg-accent-primary text-text-inverse"
                  : "text-text-secondary hover:text-text-primary"
              }`}
            >
              {label}
            </button>
          );
        })}
      </div>
    </div>
  );

  if (dataset.data.nodes.length === 0) {
    return (
      <div className="h-full overflow-y-auto bg-bg-tertiary">
        <div className="flex min-h-full w-full flex-col justify-center gap-3 px-6 py-8 md:px-8">
          <div className="max-w-sm">
            <p className="text-sm font-medium text-text-primary">
              {labels.emptyTitle ?? "Your temporal network will appear here."}
            </p>
            <p className="mt-2 text-sm font-sans text-text-secondary">
              {labels.emptyDesc ?? "Capture a few conversations first, then reopen Network to watch the graph evolve over time."}
            </p>
          </div>
          <GraphLegend groups={emotionSwatches} notes={EMOTION_LEGEND_NOTES} />
        </div>
      </div>
    );
  }

  return (
    <div
      className={
        isFullscreen ? "fixed inset-0 z-50 bg-bg-tertiary" : "relative h-full overflow-y-auto bg-bg-tertiary"
      }
      style={{ background: SKY_BACKGROUND[themeMode] }}
    >
      <div
        className={
          isFullscreen
            ? "relative h-full w-full"
            : "flex min-h-full w-full flex-col gap-4 px-6 pb-8 pt-3 md:px-8"
        }
      >
        <div
          className={
            isFullscreen
              ? "absolute right-4 top-4 z-10 flex flex-wrap items-center justify-end gap-2"
              : "absolute right-8 top-5 z-10 flex flex-wrap items-center justify-end gap-2"
          }
        >
          {groupByToggle}
          <button
            type="button"
            onClick={() => setIsFullscreen((value) => !value)}
            aria-label={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
            title={isFullscreen ? "Exit fullscreen (Esc)" : "Fullscreen"}
            className="flex h-7 w-7 items-center justify-center rounded-full border border-border-subtle bg-bg-primary/70 text-text-secondary backdrop-blur-md transition-colors hover:text-text-primary"
          >
            {isFullscreen ? (
              <Minimize2 strokeWidth={1.5} className="h-3.5 w-3.5" />
            ) : (
              <Maximize2 strokeWidth={1.5} className="h-3.5 w-3.5" />
            )}
          </button>
        </div>
        <div
          className={
            isFullscreen ? "h-full" : "relative min-h-[380px] flex-1 overflow-hidden rounded-2xl bg-bg-tertiary"
          }
        >
          <TemporalGraph
            data={dataset.data}
            currentDay={currentDay}
            height={isFullscreen ? viewportHeight : GRAPH_HEIGHT}
            themeMode={themeMode}
            scrubbing={scrubbing}
            playing={playing}
            resetToken={graphResetToken}
            selectedNodeId={selectedNodeId}
            highlightedNodeIds={highlightedNodeIds}
            emotionById={emotionById}
            isActive={isActive}
            groups={networkGroups.groups}
            onNodeClick={handleNodeFocus}
            onBackgroundClick={handleCloseDrawer}
            getNodeTooltip={getNodeTooltip}
          />
        </div>

        {!isFullscreen && (
          <>
            <div className="text-[11px] font-sans text-text-tertiary">
              {labels.trendLabel ?? "Trend · daily new conversations"}
            </div>

            <TimeBar
              totalDays={totalDays}
              dayCounts={dataset.dayCounts}
              currentDay={currentDay}
              themeMode={themeMode}
              onChange={handleScrubChange}
              onScrubStart={handleScrubStart}
              onScrubEnd={handleScrubEnd}
              ariaLabel={labels.trendScrubberAriaLabel}
            />

            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <button
                type="button"
                onClick={handleReplay}
                className="rounded-full border border-border-subtle bg-bg-primary px-3 py-1.5 text-[12px] font-sans text-text-primary transition-colors hover:bg-bg-secondary"
              >
                {labels.replay ?? "Replay"}
              </button>

              <span className="text-[11px] font-sans text-text-tertiary">
                {labels.dragHint ?? "Drag the trend line to pause on a moment."}
              </span>
            </div>

            <div className="min-h-[16px] text-[11px] font-sans text-text-tertiary">{infoText}</div>

            <GraphLegend groups={emotionSwatches} notes={EMOTION_LEGEND_NOTES} />
          </>
        )}
      </div>

      {selectedGraphNode?.kind === "cluster" && (
        <>
          <div
            className="fixed inset-0 z-40 bg-black/20"
            onClick={handleCloseDrawer}
          />
          <div className="fixed bottom-0 right-0 top-0 z-50 w-[min(24rem,92vw)] overflow-y-auto bg-bg-primary shadow-2xl">
            <div className="p-4">
              <button
                type="button"
                onClick={handleCloseDrawer}
                className="mb-4 flex items-center gap-2 text-sm font-sans text-text-secondary transition-colors hover:text-text-primary"
              >
                <X strokeWidth={1.5} className="h-4 w-4" />
                <span>{labels.close ?? "Close"}</span>
              </button>

              <h2 className="mb-1 text-lg font-serif font-normal text-text-primary">
                {groupLabelByKey.get(selectedGraphNode.groupKey) ?? selectedGraphNode.label}
              </h2>
              <p className="mb-4 text-[11px] font-sans text-text-tertiary">
                {(labels.clusterConversationCount ?? "{count} conversations").replace(
                  "{count}",
                  String(selectedGraphNode.memberCount ?? 0)
                )}
                {" · "}
                {formatStartedLabel(selectedGraphNode.originAt)} –{" "}
                {formatStartedLabel(selectedGraphNode.lastCapturedAt)}
              </p>

              <div className="space-y-2">
                {selectedClusterMembers.map((conversation) => {
                  const digest = digestByConversationId.get(conversation.id);
                  return (
                    <button
                      key={conversation.id}
                      type="button"
                      onClick={() => onSelectConversation?.(conversation.id)}
                      className="flex w-full items-start justify-between gap-3 rounded-lg border border-border-subtle bg-bg-tertiary px-3 py-2 text-left transition-colors hover:bg-bg-secondary"
                    >
                      <div className="min-w-0">
                        <div className="truncate text-sm font-sans text-text-primary">
                          {conversation.title ||
                            (labels.conversationN ?? "Conversation {id}").replace(
                              "{id}",
                              String(conversation.id)
                            )}
                        </div>
                        <div className="mt-1 text-[11px] font-sans text-text-tertiary">
                          {getPlatformLabel(conversation.platform)}
                          {" · "}
                          {formatStartedLabel(getConversationOriginAt(conversation))}
                        </div>
                        {digest?.oneLiner && (
                          <div className="mt-1 line-clamp-2 text-[11px] font-sans text-text-secondary">
                            {digest.oneLiner}
                          </div>
                        )}
                      </div>
                      <ArrowRight
                        strokeWidth={1.5}
                        className="h-4 w-4 shrink-0 text-text-tertiary"
                      />
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </>
      )}

      {selectedGraphNode && selectedConversation && (
        <>
          <div
            className="fixed inset-0 z-40 bg-black/20"
            onClick={handleCloseDrawer}
          />
          <div className="fixed bottom-0 right-0 top-0 z-50 w-[min(24rem,92vw)] overflow-y-auto bg-bg-primary shadow-2xl">
            <div className="p-4">
              <button
                type="button"
                onClick={handleCloseDrawer}
                className="mb-4 flex items-center gap-2 text-sm font-sans text-text-secondary transition-colors hover:text-text-primary"
              >
                <X strokeWidth={1.5} className="h-4 w-4" />
                <span>{labels.close ?? "Close"}</span>
              </button>

              <h2 className="mb-3 text-lg font-serif font-normal text-text-primary">
                {selectedConversation.title || selectedGraphNode.label}
              </h2>

              <div className="mb-4 flex flex-wrap items-center gap-2">
                <span
                  className="rounded-md px-2 py-0.5 text-[11px] font-sans font-medium leading-none"
                  style={getPlatformBadgeStyle(selectedConversation.platform, themeMode)}
                >
                  {getPlatformLabel(selectedConversation.platform)}
                </span>
                <span className="text-xs font-sans text-text-tertiary">
                  {labels.started ?? "Started"} {formatStartedLabel(getConversationOriginAt(selectedConversation))}
                </span>
                {selectedConversation.topic_id !== null && topicMap.get(selectedConversation.topic_id) && (
                  <span className="text-xs font-sans text-text-tertiary">
                    · {topicMap.get(selectedConversation.topic_id)}
                  </span>
                )}
                {selectedConversation.is_starred && (
                  <span className="text-xs font-sans text-text-tertiary">· {labels.starred ?? "Starred"}</span>
                )}
              </div>

              <div className="mb-6 rounded-lg bg-bg-surface-card p-3">
                <div className="mb-2 flex flex-wrap items-center gap-3 text-[11px] font-sans text-text-secondary">
                  <span>{selectedConversation.message_count ?? 0} {labels.messages ?? "messages"}</span>
                </div>
                <p className="text-xs font-sans text-text-secondary">
                  {digestByConversationId.get(selectedConversation.id)?.oneLiner?.trim() ||
                    selectedConversation.snippet?.trim() ||
                    (labels.noPreviewSnippet ?? "No preview snippet available for this conversation yet.")}
                </p>
              </div>

              {selectedConversation.tags.length > 0 && (
                <div className="mb-6">
                  <h3 className="mb-2 text-xs font-sans font-medium uppercase tracking-[0.08em] text-text-tertiary">
                    {labels.tags ?? "Tags"}
                  </h3>
                  <div className="flex flex-wrap gap-2">
                    {selectedConversation.tags.map((tag) => (
                      <span
                        key={tag}
                        className="rounded-full border border-border-subtle px-2 py-1 text-[11px] font-sans text-text-secondary"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {onSelectConversation && (
                <button
                  type="button"
                  onClick={handleViewInLibrary}
                  className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent-primary px-4 py-2.5 text-sm font-sans font-medium text-text-inverse transition-all hover:bg-accent-primary/90"
                >
                  <span>{labels.viewInLibrary ?? "View in Library"}</span>
                  <ArrowRight strokeWidth={1.5} className="h-4 w-4" />
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
