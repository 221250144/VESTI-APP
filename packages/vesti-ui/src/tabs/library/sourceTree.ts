// Source-tree navigation model (P2b) — pure, React-free logic.
//
// Joins the desktop conversation tree (CLI capture: platform+host → project,
// plus the renderer-built "browser" subtree grouped by site domain) with the
// Dexie conversation list, so the library nav can filter by
// source → project → topic. The join key for CLI rows is `_cli_id` (the
// work-session id, identical to the tree's session id); browser rows map by
// URL hostname to the tree's `web:<domain>` project keys.

import type { Conversation, ConversationTree, Topic } from "../../types";

/** Capture-lineage fields the desktop shell stamps on Dexie records. They are
 * absent (undefined) in the extension build. */
export type DesktopSourceFields = {
  _source?: string;
  _cli_id?: string;
  _project_path?: string;
};

export type SourceRef = {
  /** CLI platform slug ("claude-code", …) or "browser". */
  platform: string;
  /** "native", "wsl:<distro>" or "browser". */
  host: string;
};

export type SourceSelection =
  | { kind: "source"; source: SourceRef }
  | { kind: "project"; source: SourceRef; projectKey: string }
  | { kind: "topic"; source: SourceRef; projectKey: string; topicId: number };

export const BROWSER_SOURCE: SourceRef = { platform: "browser", host: "browser" };

const EXTENSION_SOURCE = "browser_extension";

const CLI_PLATFORM_LABELS: Record<string, string> = {
  "claude-code": "Claude Code",
  "kimi-code": "Kimi Code",
  codex: "Codex",
  cursor: "Cursor",
  aider: "Aider",
};

export function sourcePlatformLabel(platform: string, browserLabel = "Browser"): string {
  if (platform === BROWSER_SOURCE.platform) return browserLabel;
  return CLI_PLATFORM_LABELS[platform] ?? platform;
}

export function isWslHost(host: string): boolean {
  return host.startsWith("wsl:");
}

export function wslDistro(host: string): string {
  return isWslHost(host) ? host.slice("wsl:".length) : "";
}

function sameSource(a: SourceRef, b: SourceRef): boolean {
  return a.platform === b.platform && a.host === b.host;
}

function sourceKey(source: SourceRef): string {
  return `${source.platform}|${source.host}`;
}

function domainOf(url: string | undefined): string {
  if (!url) return "unknown";
  try {
    return new URL(url).hostname || "unknown";
  } catch {
    return "unknown";
  }
}

function normalizePathKey(path: string): string {
  return path.trim().replace(/[\\/]+$/, "").toLowerCase();
}

// ---- Tree lookup ------------------------------------------------------------

export type ConversationTreeLookup = {
  /** tree session id (= Dexie `_cli_id`) → project placement */
  bySessionId: Map<string, { source: SourceRef; projectKey: string }>;
  /** normalized project path/domain → project placement (fallback join) */
  byProjectPath: Map<string, { source: SourceRef; projectKey: string }>;
};

export function buildConversationTreeLookup(
  tree: ConversationTree | null,
): ConversationTreeLookup {
  const bySessionId = new Map<string, { source: SourceRef; projectKey: string }>();
  const byProjectPath = new Map<string, { source: SourceRef; projectKey: string }>();
  for (const source of tree?.sources ?? []) {
    const ref: SourceRef = { platform: source.platform, host: source.host };
    for (const project of source.projects) {
      const placement = { source: ref, projectKey: project.projectKey };
      const pathKey = normalizePathKey(project.pathOrDomain ?? "");
      if (pathKey && !byProjectPath.has(pathKey)) {
        byProjectPath.set(pathKey, placement);
      }
      for (const session of project.sessions) {
        if (!bySessionId.has(session.id)) {
          bySessionId.set(session.id, placement);
        }
      }
    }
  }
  return { bySessionId, byProjectPath };
}

// ---- Conversation → tree placement ------------------------------------------

export type ConversationPlacement = { source: SourceRef; projectKey: string };

/**
 * Resolve where a conversation belongs in the source tree. Returns null when
 * the conversation has no capture lineage the tree knows about (e.g. legacy
 * rows with no `_source`).
 */
export function resolveConversationPlacement(
  conversation: Pick<Conversation, "url"> & DesktopSourceFields,
  lookup: ConversationTreeLookup,
): ConversationPlacement | null {
  if (conversation._source === EXTENSION_SOURCE) {
    return {
      source: BROWSER_SOURCE,
      projectKey: `web:${domainOf(conversation.url)}`,
    };
  }
  if (conversation._cli_id) {
    const hit = lookup.bySessionId.get(conversation._cli_id);
    if (hit) return hit;
  }
  if (conversation._project_path) {
    const hit = lookup.byProjectPath.get(
      normalizePathKey(conversation._project_path),
    );
    if (hit) return hit;
  }
  return null;
}

// ---- Topics helpers ----------------------------------------------------------

/** Ids of the topic subtree rooted at `topicId` (inclusive). Falls back to
 * `{ topicId }` when the id is not present in the tree. */
export function collectTopicSubtreeIds(topics: Topic[], topicId: number): Set<number> {
  const collect = (node: Topic, into: Set<number>): Set<number> => {
    into.add(node.id);
    for (const child of node.children ?? []) collect(child, into);
    return into;
  };
  const find = (nodes: Topic[]): Topic | null => {
    for (const node of nodes) {
      if (node.id === topicId) return node;
      const hit = find(node.children ?? []);
      if (hit) return hit;
    }
    return null;
  };
  const root = find(topics);
  if (!root) return new Set([topicId]);
  return collect(root, new Set());
}

// ---- Filtering ---------------------------------------------------------------

/**
 * Filter the library conversation list by a source-tree selection. Topic
 * selections include the whole topic subtree (matching the aggregated counts)
 * and stay scoped to the enclosing project, so the list matches the counts
 * shown in the tree.
 */
export function filterConversationsBySelection<T extends Conversation>(
  conversations: T[],
  selection: SourceSelection | null,
  lookup: ConversationTreeLookup,
  topics: Topic[] = [],
): T[] {
  if (!selection) return conversations;
  const topicIds =
    selection.kind === "topic"
      ? collectTopicSubtreeIds(topics, selection.topicId)
      : null;
  return conversations.filter((conversation) => {
    const placement = resolveConversationPlacement(conversation, lookup);
    if (!placement) return false;
    if (!sameSource(placement.source, selection.source)) return false;
    if (selection.kind === "source") return true;
    if (placement.projectKey !== selection.projectKey) return false;
    if (selection.kind === "project") return true;
    return (
      conversation.topic_id !== null && topicIds!.has(conversation.topic_id)
    );
  });
}

// ---- Aggregated nav model -----------------------------------------------------

export type SourceTreeTopicNode = {
  id: number;
  name: string;
  /** Conversations in the enclosing project whose topic_id lies in this
   * subtree (direct + descendants). */
  count: number;
  children: SourceTreeTopicNode[];
};

export type SourceTreeProjectNode = {
  projectKey: string;
  label: string;
  count: number;
  /** Global topics tree pruned to branches used inside this project. */
  topics: SourceTreeTopicNode[];
};

export type SourceTreeSourceNode = {
  platform: string;
  host: string;
  count: number;
  projects: SourceTreeProjectNode[];
};

export type SourceTreeModel = {
  sources: SourceTreeSourceNode[];
};

type ProjectAggregate = {
  count: number;
  /** direct (non-aggregated) per-topic conversation counts in this project */
  topicCounts: Map<number, number>;
};

function pruneTopicTree(
  topics: Topic[],
  topicCounts: Map<number, number>,
): SourceTreeTopicNode[] {
  const nodes: SourceTreeTopicNode[] = [];
  for (const topic of topics) {
    const children = pruneTopicTree(topic.children ?? [], topicCounts);
    const childTotal = children.reduce((sum, child) => sum + child.count, 0);
    const count = (topicCounts.get(topic.id) ?? 0) + childTotal;
    if (count === 0) continue;
    nodes.push({ id: topic.id, name: topic.name, count, children });
  }
  return nodes;
}

/**
 * Build the aggregated nav model: per source/project conversation counts plus
 * the per-project pruned topics tree. Conversations in the trash or archive
 * are excluded (same rule as the topic counts in the data provider). Projects
 * and sources with no matching conversations are omitted.
 */
export function buildSourceTreeModel(args: {
  tree: ConversationTree | null;
  conversations: Conversation[];
  topics: Topic[];
  lookup?: ConversationTreeLookup;
}): SourceTreeModel {
  const { tree, conversations, topics } = args;
  if (!tree) return { sources: [] };
  const lookup = args.lookup ?? buildConversationTreeLookup(tree);

  const aggregates = new Map<string, Map<string, ProjectAggregate>>();
  for (const conversation of conversations) {
    if (conversation.is_trash || conversation.is_archived) continue;
    const placement = resolveConversationPlacement(conversation, lookup);
    if (!placement) continue;
    const sKey = sourceKey(placement.source);
    let projects = aggregates.get(sKey);
    if (!projects) {
      projects = new Map();
      aggregates.set(sKey, projects);
    }
    let project = projects.get(placement.projectKey);
    if (!project) {
      project = { count: 0, topicCounts: new Map() };
      projects.set(placement.projectKey, project);
    }
    project.count += 1;
    if (conversation.topic_id !== null) {
      project.topicCounts.set(
        conversation.topic_id,
        (project.topicCounts.get(conversation.topic_id) ?? 0) + 1,
      );
    }
  }

  const sources: SourceTreeSourceNode[] = [];
  for (const source of tree.sources) {
    const ref: SourceRef = { platform: source.platform, host: source.host };
    const projectAggregates = aggregates.get(sourceKey(ref));
    const projects: SourceTreeProjectNode[] = [];
    for (const project of source.projects) {
      const aggregate = projectAggregates?.get(project.projectKey);
      if (!aggregate || aggregate.count === 0) continue;
      projects.push({
        projectKey: project.projectKey,
        label: project.label,
        count: aggregate.count,
        topics: pruneTopicTree(topics, aggregate.topicCounts),
      });
    }
    if (projects.length === 0) continue;
    projects.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
    sources.push({
      platform: source.platform,
      host: source.host,
      count: projects.reduce((sum, project) => sum + project.count, 0),
      projects,
    });
  }
  return { sources };
}

// ---- Selection label (list header) -------------------------------------------

function findTopicName(topics: Topic[], topicId: number): string | null {
  for (const topic of topics) {
    if (topic.id === topicId) return topic.name;
    const hit = findTopicName(topic.children ?? [], topicId);
    if (hit) return hit;
  }
  return null;
}

/** Human-readable label for the current selection, used as the list header. */
export function describeSelection(
  model: SourceTreeModel,
  selection: SourceSelection,
  topics: Topic[],
  browserLabel = "Browser",
): string {
  const sourceNode = model.sources.find(
    (node) => node.platform === selection.source.platform && node.host === selection.source.host,
  );
  const sourceLabel = sourcePlatformLabel(selection.source.platform, browserLabel);
  if (selection.kind === "source") return sourceLabel;
  const projectNode = sourceNode?.projects.find(
    (project) => project.projectKey === selection.projectKey,
  );
  const projectLabel = projectNode?.label ?? selection.projectKey;
  if (selection.kind === "project") return `${sourceLabel} · ${projectLabel}`;
  const topicName = findTopicName(topics, selection.topicId);
  return topicName
    ? `${projectLabel} · ${topicName}`
    : `${sourceLabel} · ${projectLabel}`;
}
