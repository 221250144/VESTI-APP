// Daily journal (P4c quality upgrade): pure core of the two-pass daily-log
// pipeline. The renderer gathers the day's conversations plus their
// enrichments (fork lineage + unique message counts from the conversation
// tree, capture-store open_questions, subagent briefs, raw file-tool touch
// rows, project memory) and passes everything in here — no Dexie/IO, so every
// step is deterministic and unit-testable.
//
// Pipeline shape:
//   1. buildDailyWorkModel: merge fork/continuation chains into single work
//      items (a session re-opened 6 times is ONE chain, not 6 rows), group
//      the chains into project/site clusters, and aggregate the captured
//      file-tool touches into deterministic file anchors (path + change kind:
//      created/modified/analyzed — never model-invented).
//   2. Pass 1 (per cluster): buildClusterExtractionTranscript feeds the
//      'daily-cluster' template; parseDailyClusterPayload normalizes the
//      structured brief. Without (or with a failing) LLM the deterministic
//      brief falls back to digest one-liners/decisions/open-questions.
//   3. Pass 2 (synthesis): buildDailySynthesisTranscript hands the briefs +
//      anchors + browser items + project memory + yesterday's excerpt to the
//      'daily' template. composeDailyMarkdown layers deterministic data over
//      the model's prose: the key-files section is program-rendered (the
//      model only marks its position with {{KEY_FILES}}) and any missing
//      mandatory section is repaired from the deterministic renderers, so the
//      output schema is stable no matter what the model does.
//   4. No-LLM path: buildLocalDailyJournal renders the same schema fully
//      deterministically (fork-merged, project-grouped, anchored) — a work
//      record, not a raw session dump.

import type { RelayFileTouchRow } from "../../shared/contracts";
import type { RelayProjectMemory } from "../relay/relayContext";
import { buildProjectMemoryBlock } from "../relay/relayContext";
import { extractTouchPath } from "../relay/relayFiles";
import type { DailyLogStats } from "../db/types";
import {
  DAILY_CONTEXT_BUDGET_CHARS,
  type DailyActivity,
  type DailyActivityItem,
  type DailyDigestInput,
  type DailyLocale,
} from "./dailyActivity";

// ---- Work model: fork-merged chains grouped into project clusters -----------

/** Renderer-side enrichment for one conversation: everything the journal
 * model needs beyond the Dexie record + tree digest. Gathered by dailyService
 * from the conversation tree (fork lineage, unique counts, subagent children)
 * and the capture store (open_questions, git). */
export interface DailySessionEnrichment {
  conversationId: number;
  /** Capture-store session id (work_sessions.id) for local-terminal captures. */
  cliId: string | null;
  /** Capture-store id of the session this one was forked/continued from. */
  forkedFrom: string | null;
  /** Fork-deduped message count (tree); null for non-fork sessions. */
  uniqueMessageCount: number | null;
  /** Capture-store digest extras the tree digest never carries. */
  openQuestions: string[];
  subagents: Array<{ role?: string | null; title: string; oneLiner?: string | null }>;
}

/** One session's contribution to the day's work model. */
export interface DailyWorkItem {
  conversationId: number;
  cliId: string | null;
  title: string;
  platform: string;
  source: "cli" | "browser";
  projectLabel: string | null;
  /** Fork-deduped message count when known, else the raw count. */
  messages: number;
  updatedAt: number;
  digest: DailyDigestInput | null;
  openQuestions: string[];
  /** Latest summary text (browser side mainly). */
  summary: string | null;
  subagents: DailySessionEnrichment["subagents"];
  /** Fork parent edge (cliId), resolved only inside the day's item set. */
  forkParentCliId: string | null;
}

/** One logical work item: a session plus every fork/continuation of it that
 * was active the same day. The chain is cited once, through its most recent
 * session. */
export interface DailyWorkChain {
  /** Chain members, oldest activity first. */
  items: DailyWorkItem[];
  /** The session the reader should open: the latest activity in the chain. */
  representative: DailyWorkItem;
  /** Fork-deduped messages summed across the chain. */
  messages: number;
  /** How many fork/continuation sessions merged into this chain (>= 0). */
  continuations: number;
}

/** A project (CLI) or site domain (browser) grouping of the day's chains. */
export interface DailyCluster {
  /** Stable key: `${source}:${projectLabel}`. */
  key: string;
  source: "cli" | "browser";
  projectLabel: string;
  chains: DailyWorkChain[];
  messages: number;
}

export const UNGROUPED_PROJECT_LABEL = "未分组";

function workItemMessages(item: {
  messageCount: number;
  uniqueMessageCount?: number | null;
}): number {
  return item.uniqueMessageCount && item.uniqueMessageCount > 0
    ? item.uniqueMessageCount
    : item.messageCount;
}

/**
 * Merge the day's sessions into fork chains: sessions linked by forkedFrom
 * edges (a parent outside the day's set makes the child a root today) collapse
 * into one chain cited through its most recent member; message totals use the
 * tree's fork-deduped counts so pre-fork copies are not double-counted.
 */
export function mergeDailyWorkItems(items: DailyWorkItem[]): DailyWorkChain[] {
  const parentOf = new Map<number, number>();
  const byCliId = new Map<string, DailyWorkItem>();
  for (const item of items) {
    if (item.cliId) byCliId.set(item.cliId, item);
  }
  for (const item of items) {
    if (!item.forkParentCliId) continue;
    const parent = byCliId.get(item.forkParentCliId);
    // A fork edge only merges when the parent was also active today and is a
    // different session; otherwise the item starts its own chain.
    if (parent && parent.conversationId !== item.conversationId) {
      parentOf.set(item.conversationId, parent.conversationId);
    }
  }

  // Union-find over the fork edges (chains are short; path halving suffices).
  const rootOf = (id: number): number => {
    let cursor = id;
    const seen = new Set<number>([id]);
    while (parentOf.has(cursor)) {
      const next = parentOf.get(cursor) as number;
      if (seen.has(next)) break; // corrupt cycle: cut it, keep both as roots
      seen.add(next);
      cursor = next;
    }
    return cursor;
  };

  const groups = new Map<number, DailyWorkItem[]>();
  for (const item of items) {
    const root = rootOf(item.conversationId);
    const group = groups.get(root) ?? [];
    group.push(item);
    groups.set(root, group);
  }

  const chains: DailyWorkChain[] = [...groups.values()].map((group) => {
    const sorted = [...group].sort((a, b) => a.updatedAt - b.updatedAt);
    const representative = sorted[sorted.length - 1];
    return {
      items: sorted,
      representative,
      messages: sorted.reduce((sum, item) => sum + item.messages, 0),
      continuations: sorted.length - 1,
    };
  });
  // Busiest chain first, ties broken by recency.
  return chains.sort(
    (a, b) =>
      b.messages - a.messages || b.representative.updatedAt - a.representative.updatedAt
  );
}

/** Group chains into project (CLI) / site-domain (browser) clusters, busiest
 * first. Browser and CLI work never mix in one cluster. */
export function groupDailyClusters(chains: DailyWorkChain[]): DailyCluster[] {
  const clusters = new Map<string, DailyCluster>();
  for (const chain of chains) {
    const item = chain.representative;
    const label = item.projectLabel?.trim() || UNGROUPED_PROJECT_LABEL;
    const key = `${item.source}:${label}`;
    let cluster = clusters.get(key);
    if (!cluster) {
      cluster = { key, source: item.source, projectLabel: label, chains: [], messages: 0 };
      clusters.set(key, cluster);
    }
    cluster.chains.push(chain);
    cluster.messages += chain.messages;
  }
  return [...clusters.values()].sort((a, b) => b.messages - a.messages);
}

// ---- Deterministic file anchors ----------------------------------------------

/** Max anchors injected into the synthesis transcript / rendered section. */
export const DAILY_FILE_ANCHOR_LIMIT = 20;

export type DailyFileChangeKind = "created" | "modified" | "analyzed";

export interface DailyFileAnchor {
  /** Display path (first-seen spelling; dedupe is separator/case-insensitive). */
  path: string;
  /** Dominant change nature: any edit touch → modified, else any write touch
   * → created, else read-only → analyzed. */
  kind: DailyFileChangeKind;
  touches: number;
  lastTouchedAt: number;
  /** Renderer conversation ids that touched the file, first-seen order. */
  conversationIds: number[];
}

/** Dedupe key: separators and case folded, trailing slashes stripped (same
 * folding as the relay anchors). */
function normalizeAnchorKey(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function kindFromCategory(toolCategory: string): DailyFileChangeKind | null {
  if (toolCategory === "file_edit") return "modified";
  if (toolCategory === "file_write") return "created";
  if (toolCategory === "file_read") return "analyzed";
  return null;
}

function kindPrecedence(kind: DailyFileChangeKind): number {
  return kind === "modified" ? 3 : kind === "created" ? 2 : 1;
}

/**
 * Aggregate the day's raw file-tool touches into deterministic anchors. The
 * journal's key-files section is built from these alone — the LLM never
 * invents paths. Change kind is decided per file by the strongest captured
 * category (edit > write > read).
 */
export function extractDailyFileAnchors(
  rows: RelayFileTouchRow[],
  resolveConversationId: (sessionId: string) => number | null,
  limit: number = DAILY_FILE_ANCHOR_LIMIT
): DailyFileAnchor[] {
  type MutableAnchor = DailyFileAnchor & { key: string };
  const byKey = new Map<string, MutableAnchor>();
  for (const row of rows) {
    const path = extractTouchPath(row.inputSummary);
    if (!path) continue;
    const kind = kindFromCategory(row.toolCategory ?? "");
    if (!kind) continue;
    const key = normalizeAnchorKey(path);
    if (!key) continue;
    let anchor = byKey.get(key);
    if (!anchor) {
      anchor = { key, path, kind, touches: 0, lastTouchedAt: 0, conversationIds: [] };
      byKey.set(key, anchor);
    }
    anchor.touches += 1;
    if (kindPrecedence(kind) > kindPrecedence(anchor.kind)) anchor.kind = kind;
    if (row.timestamp > anchor.lastTouchedAt) anchor.lastTouchedAt = row.timestamp;
    const conversationId = resolveConversationId(row.sessionId);
    if (conversationId !== null && !anchor.conversationIds.includes(conversationId)) {
      anchor.conversationIds.push(conversationId);
    }
  }
  return [...byKey.values()]
    .sort(
      (a, b) =>
        b.touches - a.touches ||
        b.lastTouchedAt - a.lastTouchedAt ||
        a.path.localeCompare(b.path)
    )
    .slice(0, Math.max(0, limit))
    .map(({ key: _key, ...anchor }) => anchor);
}

// ---- The day's work model -----------------------------------------------------

export interface DailyWorkModel {
  date: string;
  stats: DailyLogStats;
  clusters: DailyCluster[];
  fileAnchors: DailyFileAnchor[];
}

/** Assemble the model: activity items + enrichments → work items → fork
 * chains → clusters, plus the deterministic file anchors. */
export function buildDailyWorkModel(input: {
  activity: DailyActivity;
  enrichments: DailySessionEnrichment[];
  fileTouches: RelayFileTouchRow[];
  resolveTouchConversationId: (sessionId: string) => number | null;
}): DailyWorkModel {
  const enrichmentById = new Map(
    input.enrichments.map((enrichment) => [enrichment.conversationId, enrichment])
  );
  const items: DailyWorkItem[] = input.activity.items.map((item) => {
    const enrichment = enrichmentById.get(item.id);
    return {
      conversationId: item.id,
      cliId: enrichment?.cliId ?? null,
      title: item.title,
      platform: item.platform,
      source: item.source,
      projectLabel: item.projectLabel,
      messages: workItemMessages({
        messageCount: item.messageCount,
        uniqueMessageCount: enrichment?.uniqueMessageCount ?? null,
      }),
      updatedAt: item.updatedAt,
      digest: item.digest,
      openQuestions: enrichment?.openQuestions ?? [],
      summary: item.summary,
      subagents: enrichment?.subagents ?? [],
      forkParentCliId: enrichment?.forkedFrom ?? null,
    };
  });
  return {
    date: input.activity.date,
    stats: input.activity.stats,
    clusters: groupDailyClusters(mergeDailyWorkItems(items)),
    fileAnchors: extractDailyFileAnchors(
      input.fileTouches,
      input.resolveTouchConversationId
    ),
  };
}

// ---- Cluster briefs (pass-1 output / deterministic fallback) ------------------

export interface DailyClusterBrief {
  /** Cluster key this brief describes. */
  key: string;
  projectLabel: string;
  source: "cli" | "browser";
  theme: string;
  goal: string;
  completed: string[];
  inProgress: string[];
  decisions: string[];
  openQuestions: string[];
  /** false when the brief is the deterministic fallback (no LLM involved). */
  fromLlm: boolean;
}

/** Cap on pass-1 LLM calls per day; extra clusters fall back to the
 * deterministic brief. */
export const DAILY_CLUSTER_LLM_LIMIT = 10;

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncateText(value: string, maxChars: number): string {
  const collapsed = collapseWhitespace(value);
  if (collapsed.length <= maxChars) return collapsed;
  return `${collapsed.slice(0, Math.max(0, maxChars - 1))}…`;
}

function mergeStringLists(lists: string[][], maxItems: number): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const list of lists) {
    for (const entry of list) {
      const value = collapseWhitespace(entry);
      if (!value) continue;
      const key = value.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(value);
      if (merged.length >= maxItems) return merged;
    }
  }
  return merged;
}

/** A cluster whose chains carry no digest/summary content at all has nothing
 * worth an LLM call — the deterministic brief covers it. */
export function clusterHasLlmMaterial(cluster: DailyCluster): boolean {
  if (cluster.source === "browser") {
    return cluster.chains.some((chain) =>
      chain.items.some((item) => Boolean(item.summary?.trim()))
    );
  }
  return cluster.chains.some((chain) =>
    chain.items.some(
      (item) =>
        Boolean(item.digest?.oneLiner) ||
        (item.digest?.keyTopics.length ?? 0) > 0 ||
        (item.digest?.decisions.length ?? 0) > 0 ||
        item.openQuestions.length > 0 ||
        item.subagents.length > 0
    )
  );
}

/**
 * Deterministic brief for one cluster: theme from the busiest chain's
 * representative title, completed from digest one-liners, decisions and open
 * questions merged across the chains. Used as the no-LLM fallback and as the
 * repair source for missing journal sections.
 */
export function buildDeterministicClusterBrief(cluster: DailyCluster): DailyClusterBrief {
  const allItems = cluster.chains.flatMap((chain) => chain.items);
  const oneLiners = mergeStringLists(
    allItems.map((item) => (item.digest?.oneLiner ? [item.digest.oneLiner] : [])),
    6
  );
  const summaries =
    cluster.source === "browser"
      ? mergeStringLists(
          allItems.map((item) =>
            item.summary?.trim() ? [truncateText(item.summary, 200)] : []
          ),
          6
        )
      : [];
  const top = cluster.chains[0]?.representative;
  return {
    key: cluster.key,
    projectLabel: cluster.projectLabel,
    source: cluster.source,
    theme: truncateText(top?.title || cluster.projectLabel, 80),
    goal: oneLiners[0] ?? summaries[0] ?? "",
    completed: mergeStringLists([oneLiners, summaries], 6),
    inProgress: [],
    decisions: mergeStringLists(
      allItems.map((item) => item.digest?.decisions ?? []),
      6
    ),
    openQuestions: mergeStringLists(
      allItems.map((item) => item.openQuestions),
      6
    ),
    fromLlm: false,
  };
}

// ---- Pass-1 transcript (per cluster) ------------------------------------------

/** Per-cluster extraction budget — small on purpose: the digest heads carry
 * most of the signal, the excerpts only fill gaps. */
export const DAILY_CLUSTER_BUDGET_CHARS = 6_000;

const SUBAGENT_LINE_LIMIT = 4;

function buildChainBlock(chain: DailyWorkChain, index: number): string {
  const head = chain.representative;
  const forkNote =
    chain.continuations > 0 ? ` · fork/续写合并 ${chain.continuations + 1} 个会话` : "";
  const lines = [
    `### 工作项 ${index + 1}：《${truncateText(head.title || "未命名会话", 80)}》（${head.platform} · ${chain.messages} 条消息${forkNote}）`,
  ];
  for (const item of chain.items) {
    const digest = item.digest;
    const prefix = chain.items.length > 1 ? `（会话《${truncateText(item.title, 40)}》）` : "";
    if (digest?.oneLiner) lines.push(`一句话${prefix}：${truncateText(digest.oneLiner, 200)}`);
    const topics = mergeStringLists([digest?.keyTopics ?? []], 6);
    if (topics.length > 0) lines.push(`关键主题${prefix}：${topics.join("、")}`);
    const files = mergeStringLists([digest?.keyFiles ?? []], 6);
    if (files.length > 0) lines.push(`关键文件${prefix}：${files.join("、")}`);
    const decisions = mergeStringLists([digest?.decisions ?? []], 6);
    if (decisions.length > 0) lines.push(`关键决策${prefix}：${decisions.join("、")}`);
    if (item.openQuestions.length > 0) {
      lines.push(`未决问题${prefix}：${mergeStringLists([item.openQuestions], 6).join("、")}`);
    }
    if (!digest?.oneLiner && item.summary?.trim()) {
      lines.push(`摘要${prefix}：${truncateText(item.summary, 400)}`);
    }
  }
  const subagents = chain.items.flatMap((item) => item.subagents);
  const usable = subagents.filter((entry) => entry.title || entry.oneLiner);
  if (usable.length > 0) {
    lines.push(`子代理（${usable.length}）：`);
    for (const entry of usable.slice(0, SUBAGENT_LINE_LIMIT)) {
      const role = entry.role ? `[${collapseWhitespace(entry.role)}] ` : "";
      const oneLiner = entry.oneLiner ? ` — ${truncateText(entry.oneLiner, 120)}` : "";
      lines.push(`  - ${role}${truncateText(entry.title || "未命名子任务", 60)}${oneLiner}`);
    }
    if (usable.length > SUBAGENT_LINE_LIMIT) {
      lines.push(`  - …另有 ${usable.length - SUBAGENT_LINE_LIMIT} 个子代理运行`);
    }
  }
  return lines.join("\n");
}

/**
 * Pass-1 context for one cluster: project header, the cluster's file anchors
 * (deterministic), then one block per work chain (fork-merged) with digest
 * heads, open questions and subagent briefs.
 */
export function buildClusterExtractionTranscript(
  cluster: DailyCluster,
  fileAnchors: DailyFileAnchor[],
  budgetChars: number = DAILY_CLUSTER_BUDGET_CHARS
): string {
  const clusterConversationIds = new Set(
    cluster.chains.flatMap((chain) => chain.items.map((item) => item.conversationId))
  );
  const anchors = fileAnchors.filter((anchor) =>
    anchor.conversationIds.some((id) => clusterConversationIds.has(id))
  );
  const sourceLabel = cluster.source === "browser" ? "网页端站点" : "项目";
  const header = [
    `${sourceLabel}：${cluster.projectLabel}`,
    `本簇共 ${cluster.chains.length} 个工作项（fork/续写已合并）、${cluster.messages} 条消息。`,
  ].join("\n");
  const anchorBlock =
    anchors.length > 0
      ? `程序提取的文件锚点（确定性，不得改动路径）：\n${anchors
          .map((anchor) => `- ${anchor.path}（触碰 ${anchor.touches} 次）`)
          .join("\n")}`
      : null;
  const blocks = cluster.chains.map((chain, index) => buildChainBlock(chain, index));
  const assembled = [header, ...(anchorBlock ? [anchorBlock] : []), ...blocks].join("\n\n");
  if (assembled.length <= budgetChars) return assembled;
  return `${assembled.slice(0, Math.max(0, budgetChars - 12))}\n[上下文已截断]`;
}

// ---- Pass-2 transcript (synthesis) ---------------------------------------------

function excerptLogForSynthesis(markdown: string, maxChars: number): string {
  const lines = markdown
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && !line.startsWith(">") && !line.startsWith("---"));
  const joined = lines.join(" ");
  return truncateText(joined, maxChars);
}

/**
 * Pass-2 context: stats header, the per-cluster structured briefs (pass-1
 * output or deterministic fallback), the deterministic file-anchor block, the
 * browser conversation listing (so the web section is never blank when data
 * exists), project memory, and yesterday's log excerpt for continuity.
 */
export function buildDailySynthesisTranscript(input: {
  model: DailyWorkModel;
  briefs: DailyClusterBrief[];
  projectMemory: RelayProjectMemory[];
  previousLogMarkdown: string | null;
  budgetChars?: number;
}): string {
  const budgetChars = input.budgetChars ?? DAILY_CONTEXT_BUDGET_CHARS;
  const { model } = input;
  const stats = model.stats;
  const header = [
    `日期：${model.date}（本地时区）`,
    `统计：CLI 会话 ${stats.cliSessions} 个 · 网页会话 ${stats.browserConversations} 个 · 消息 ${stats.messages} 条` +
      (stats.platforms.length > 0 ? ` · 平台 ${stats.platforms.join("、")}` : "") +
      (stats.projects.length > 0 ? ` · 项目 ${stats.projects.join("、")}` : ""),
  ].join("\n");

  const briefBlocks = input.briefs.map((brief, index) => {
    const sourceLabel = brief.source === "browser" ? "网页端" : "项目";
    const lines = [
      `### 簇 ${index + 1}：${brief.projectLabel}（${sourceLabel} · ${brief.fromLlm ? "AI 提取" : "程序整理"}）`,
      `主题：${brief.theme}`,
    ];
    if (brief.goal) lines.push(`目标：${brief.goal}`);
    if (brief.completed.length > 0) lines.push(`已完成：${brief.completed.join("；")}`);
    if (brief.inProgress.length > 0) lines.push(`进行中：${brief.inProgress.join("；")}`);
    if (brief.decisions.length > 0) lines.push(`决策：${brief.decisions.join("；")}`);
    if (brief.openQuestions.length > 0) lines.push(`未决：${brief.openQuestions.join("；")}`);
    return lines.join("\n");
  });

  const anchorBlock =
    model.fileAnchors.length > 0
      ? `## 关键文件锚点（程序提取，确定性——文件小节由程序渲染，仅供你写其他小节时参考变更性质）\n${model.fileAnchors
          .map((anchor) => {
            const kindLabel =
              anchor.kind === "created" ? "新建" : anchor.kind === "modified" ? "修改" : "分析";
            return `- ${anchor.path}（${kindLabel} · 触碰 ${anchor.touches} 次）`;
          })
          .join("\n")}`
      : null;

  const browserItems = model.clusters
    .filter((cluster) => cluster.source === "browser")
    .flatMap((cluster) => cluster.chains.map((chain) => chain.representative));
  const browserBlock =
    browserItems.length > 0
      ? `## 网页端对话清单（标题 · 平台 · 要点）\n${browserItems
          .map((item) => {
            const excerpt = item.summary?.trim()
              ? `：${truncateText(item.summary, 200)}`
              : "";
            return `- 《${truncateText(item.title || "未命名会话", 60)}》（${item.platform} · ${item.projectLabel ?? "未知站点"} · ${item.messages} 条消息）${excerpt}`;
          })
          .join("\n")}`
      : null;

  const memoryBlock = buildProjectMemoryBlock(input.projectMemory);
  const previousBlock = input.previousLogMarkdown?.trim()
    ? `## 昨日日报摘录（连续性上下文）\n${excerptLogForSynthesis(input.previousLogMarkdown, 600)}`
    : null;

  const sections = [
    header,
    "## 各簇结构化要点（pass-1 提取）",
    ...briefBlocks,
    ...(anchorBlock ? [anchorBlock] : []),
    ...(browserBlock ? [browserBlock] : []),
    ...(memoryBlock ? [memoryBlock] : []),
    ...(previousBlock ? [previousBlock] : []),
  ];
  const assembled = sections.join("\n\n");
  if (assembled.length <= budgetChars) return assembled;
  return `${assembled.slice(0, Math.max(0, budgetChars - 12))}\n[上下文已截断]`;
}

// ---- Journal sections (deterministic renderers + markdown composition) ---------

/** The marker the synthesis prompt pins between the projects and decisions
 * sections; composeDailyMarkdown replaces it with the deterministic file
 * section. */
export const KEY_FILES_MARKER = "{{KEY_FILES}}";

interface JournalSectionCopy {
  note: string;
  completed: string;
  projects: string;
  files: string;
  decisions: string;
  web: string;
  next: string;
  none: string;
  goal: string;
  progress: string;
  status: string;
  kindLabels: Record<DailyFileChangeKind, string>;
  touches: (count: number) => string;
  fromConversation: (title: string) => string;
  browserLine: (title: string, platform: string, domain: string) => string;
  webOverflow: (count: number) => string;
}

const JOURNAL_COPY: Record<DailyLocale, JournalSectionCopy> = {
  zh: {
    note: "> 未配置模型，以下为本地模板按确定性数据整理的工作记录（未经 AI 润色）。配置模型后可为今天重新生成。",
    completed: "今日完成",
    projects: "项目工作流分解",
    files: "关键文件",
    decisions: "决策与发现",
    web: "网页端对话摘要",
    next: "明日线索",
    none: "无",
    goal: "目标",
    progress: "今日进展",
    status: "当前状态",
    kindLabels: { created: "新建", modified: "修改", analyzed: "分析" },
    touches: (count) => `触碰 ${count} 次`,
    fromConversation: (title) => `，来自《${title}》`,
    browserLine: (title, platform, domain) => `《${title}》（${platform} · ${domain}）`,
    webOverflow: (count) => `……以及另外 ${count} 条对话（从略）`,
  },
  en: {
    note: "> No model configured — a deterministic work record from the local template (no AI polish). Configure a model to regenerate today with AI.",
    completed: "Completed today",
    projects: "Project workflow breakdown",
    files: "Key files",
    decisions: "Decisions & findings",
    web: "Browser conversation digest",
    next: "Leads for tomorrow",
    none: "None",
    goal: "Goal",
    progress: "Progress today",
    status: "Current state",
    kindLabels: { created: "created", modified: "modified", analyzed: "analyzed" },
    touches: (count) => `${count} touch(es)`,
    fromConversation: (title) => `, from "${title}"`,
    browserLine: (title, platform, domain) => `"${title}" (${platform} · ${domain})`,
    webOverflow: (count) => `…and ${count} more conversations (omitted)`,
  },
};

/** Canonical heading prefixes per section (zh + en accepted) — used to detect
 * which sections the model's synthesis output already carries. */
const SECTION_HEADINGS: Array<{ key: string; prefixes: string[] }> = [
  { key: "completed", prefixes: ["## 今日完成", "## Completed today"] },
  { key: "projects", prefixes: ["## 项目工作流分解", "## Project workflow breakdown"] },
  { key: "files", prefixes: ["## 关键文件", "## Key files"] },
  { key: "decisions", prefixes: ["## 决策与发现", "## Decisions & findings"] },
  { key: "web", prefixes: ["## 网页端对话摘要", "## Browser conversation digest"] },
  { key: "next", prefixes: ["## 明日线索", "## Leads for tomorrow"] },
];

function renderCompletedSection(briefs: DailyClusterBrief[], locale: DailyLocale): string {
  const copy = JOURNAL_COPY[locale];
  const lines = mergeStringLists(
    briefs.map((brief) => brief.completed),
    12
  );
  return `## ${copy.completed}\n${lines.length > 0 ? lines.map((line) => `- ${line}`).join("\n") : copy.none}`;
}

function renderProjectsSection(
  briefs: DailyClusterBrief[],
  model: DailyWorkModel,
  locale: DailyLocale
): string {
  const copy = JOURNAL_COPY[locale];
  const briefByKey = new Map(briefs.map((brief) => [brief.key, brief]));
  const cliClusters = model.clusters.filter((cluster) => cluster.source === "cli");
  const blocks: string[] = [];
  for (const cluster of cliClusters) {
    const brief = briefByKey.get(cluster.key) ?? buildDeterministicClusterBrief(cluster);
    const lines = [`### ${cluster.projectLabel}`];
    lines.push(`- ${copy.goal}：${brief.goal || brief.theme}`);
    const progress = mergeStringLists(
      [brief.completed, brief.inProgress],
      6
    );
    lines.push(
      `- ${copy.progress}：${progress.length > 0 ? progress.join("；") : copy.none}`
    );
    const status = mergeStringLists([brief.openQuestions], 4);
    lines.push(`- ${copy.status}：${status.length > 0 ? status.join("；") : copy.none}`);
    blocks.push(lines.join("\n"));
  }
  return `## ${copy.projects}\n${blocks.length > 0 ? blocks.join("\n\n") : copy.none}`;
}

function renderFilesSection(
  model: DailyWorkModel,
  locale: DailyLocale
): string {
  const copy = JOURNAL_COPY[locale];
  if (model.fileAnchors.length === 0) return `## ${copy.files}\n${copy.none}`;
  const titleByConversation = new Map<number, string>();
  for (const cluster of model.clusters) {
    for (const chain of cluster.chains) {
      for (const item of chain.items) {
        titleByConversation.set(item.conversationId, item.title);
      }
    }
  }
  const lines = model.fileAnchors.map((anchor) => {
    const kind = copy.kindLabels[anchor.kind];
    const sourceTitles = [
      ...new Set(
        anchor.conversationIds
          .map((id) => titleByConversation.get(id))
          .filter((title): title is string => Boolean(title))
      ),
    ].slice(0, 2);
    const source = sourceTitles.length > 0 ? copy.fromConversation(sourceTitles.join("、")) : "";
    return `- \`${anchor.path}\`（${kind} · ${copy.touches(anchor.touches)}${source}）`;
  });
  return `## ${copy.files}\n${lines.join("\n")}`;
}

function renderDecisionsSection(briefs: DailyClusterBrief[], locale: DailyLocale): string {
  const copy = JOURNAL_COPY[locale];
  const lines = mergeStringLists(
    briefs.map((brief) => brief.decisions),
    10
  );
  return `## ${copy.decisions}\n${lines.length > 0 ? lines.map((line) => `- ${line}`).join("\n") : copy.none}`;
}

/** Cap on rendered lines in the web-digest section (see renderWebSection). */
export const MAX_WEB_SECTION_LINES = 25;

/** True when the markdown is the deterministic no-LLM fallback — its note
 * line marks it in either locale. */
export function isDeterministicDailyJournal(markdown: string): boolean {
  return markdown.includes("未配置模型") || markdown.includes("No model configured");
}

/**
 * Decide whether a (re)generation's output may overwrite the stored log: an
 * AI-polished log is never replaced by the deterministic fallback — a
 * regenerate can degrade mid-run (model unreachable), and the polished log
 * is strictly better. Everything else writes through.
 */
export function resolveDailyLogWrite(
  existing: { contentMarkdown: string } | null,
  newMarkdown: string
): "write" | "keep" {
  if (!existing) return "write";
  if (isDeterministicDailyJournal(newMarkdown) && !isDeterministicDailyJournal(existing.contentMarkdown)) {
    return "keep";
  }
  return "write";
}

function renderWebSection(
  briefs: DailyClusterBrief[],
  model: DailyWorkModel,
  locale: DailyLocale
): string {
  const copy = JOURNAL_COPY[locale];
  const browserClusters = model.clusters.filter((cluster) => cluster.source === "browser");
  const briefByKey = new Map(briefs.map((brief) => [brief.key, brief]));
  const lines: string[] = [];
  for (const cluster of browserClusters) {
    const brief = briefByKey.get(cluster.key);
    for (const chain of cluster.chains) {
      const item = chain.representative;
      const excerpt = item.summary?.trim()
        ? `：${truncateText(item.summary, 200)}`
        : brief?.completed[0]
          ? `：${truncateText(brief.completed[0], 200)}`
          : "";
      lines.push(
        `- ${copy.browserLine(
          truncateText(item.title || "未命名会话", 60),
          item.platform,
          cluster.projectLabel
        )}${excerpt}`
      );
    }
  }
  // Cap the section: a mass history import lands hundreds of web conversations
  // on one day, and an uncapped list turns the fallback log into a raw dump.
  const shown = lines.slice(0, MAX_WEB_SECTION_LINES);
  const overflow = lines.length - shown.length;
  const body =
    shown.length === 0
      ? copy.none
      : shown.join("\n") + (overflow > 0 ? `\n- ${copy.webOverflow(overflow)}` : "");
  return `## ${copy.web}\n${body}`;
}

function renderNextSection(briefs: DailyClusterBrief[], locale: DailyLocale): string {
  const copy = JOURNAL_COPY[locale];
  const lines = mergeStringLists(
    briefs.map((brief) => brief.openQuestions),
    5
  );
  return `## ${copy.next}\n${lines.length > 0 ? lines.map((line) => `- ${line}`).join("\n") : copy.none}`;
}

function renderSectionByKey(
  key: string,
  briefs: DailyClusterBrief[],
  model: DailyWorkModel,
  locale: DailyLocale
): string {
  switch (key) {
    case "completed":
      return renderCompletedSection(briefs, locale);
    case "projects":
      return renderProjectsSection(briefs, model, locale);
    case "files":
      return renderFilesSection(model, locale);
    case "decisions":
      return renderDecisionsSection(briefs, locale);
    case "web":
      return renderWebSection(briefs, model, locale);
    default:
      return renderNextSection(briefs, locale);
  }
}

/**
 * Fully deterministic journal (the no-LLM path): same schema as the
 * LLM-synthesized report, every section derived from digests, open questions,
 * anchors and browser summaries — fork-merged and project-grouped, never a
 * raw session dump.
 */
export function buildLocalDailyJournal(
  model: DailyWorkModel,
  briefs: DailyClusterBrief[],
  locale: DailyLocale = "zh"
): string {
  const copy = JOURNAL_COPY[locale] ?? JOURNAL_COPY.zh;
  const title = locale === "en" ? `# ${model.date} Daily log` : `# ${model.date} 日报`;
  const sections = [
    title,
    copy.note,
    renderCompletedSection(briefs, locale),
    renderProjectsSection(briefs, model, locale),
    renderFilesSection(model, locale),
    renderDecisionsSection(briefs, locale),
    renderWebSection(briefs, model, locale),
    renderNextSection(briefs, locale),
  ];
  return sections.join("\n\n");
}

/**
 * Layer deterministic data over the pass-2 synthesis: the model writes the
 * prose sections and marks the file section's position with {{KEY_FILES}};
 * this function
 *   - prepends the canonical title (a model-emitted H1 is dropped),
 *   - swaps the marker for the program-rendered anchor section (or inserts
 *     that section before the decisions heading when the marker is missing),
 *   - appends any mandatory section the model skipped, rendered
 *     deterministically, so the output schema is always complete.
 * With `llmBody` null this is exactly buildLocalDailyJournal.
 */
export function composeDailyMarkdown(input: {
  llmBody: string | null;
  model: DailyWorkModel;
  briefs: DailyClusterBrief[];
  locale: DailyLocale;
}): string {
  const locale = input.locale;
  if (!input.llmBody?.trim()) {
    return buildLocalDailyJournal(input.model, input.briefs, locale);
  }
  const title = locale === "en" ? `# ${input.model.date} Daily log` : `# ${input.model.date} 日报`;
  const filesSection = renderFilesSection(input.model, locale);

  let body = input.llmBody.trim();
  // Drop a model-emitted H1 — the canonical title wins.
  body = body.replace(/^#\s+[^\n]*\n+/, "");
  // Sanitize headings: earlier prompts carried writing guidance inside the
  // heading line and models still echo it ("## 今日完成（成就导向清单：…）").
  // Headings are canonical labels — strip any trailing parenthetical notes.
  body = body.replace(/^(#{2,3}\s*[^（(\n]+?)\s*[（(][^\n]*[）)]\s*$/gm, "$1");
  // The marker counts only as a standalone line — a model mentioning
  // "{{KEY_FILES}}" inside prose must not get the section injected
  // mid-sentence.
  const standaloneMarker = /^\{\{KEY_FILES\}\}[ \t]*$/m;
  if (standaloneMarker.test(body)) {
    body = body.replace(standaloneMarker, filesSection);
  } else if (/(^|\n)##\s*(决策与发现|Decisions & findings)/.test(body)) {
    body = body.replace(
      /(^|\n)(##\s*(?:决策与发现|Decisions & findings))/,
      `\n\n${filesSection}\n\n$2`
    );
  } else {
    body = `${body}\n\n${filesSection}`;
  }

  // Repair: every mandatory section must be present exactly once.
  const missing = SECTION_HEADINGS.filter(
    ({ key, prefixes }) =>
      key !== "files" &&
      !prefixes.some((prefix) => new RegExp(`(^|\\n)##\\s*${escapeRegExp(prefix.slice(3))}`).test(body))
  ).map(({ key }) => key);
  if (missing.length > 0) {
    const repairs = missing.map((key) =>
      renderSectionByKey(key, input.briefs, input.model, locale)
    );
    body = `${body}\n\n${repairs.join("\n\n")}`;
  }

  return `${title}\n\n${body.trim()}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
