// Source-tree navigation model (P2b) — pure, React-free logic.
//
// Joins the desktop conversation tree (CLI capture: platform+host → project,
// plus the renderer-built "browser" subtree grouped by site domain) with the
// Dexie conversation list, so the library nav can filter by
// source → project → topic. The join key for CLI rows is `_cli_id` (the
// work-session id, identical to the tree's session id); browser rows map by
// URL hostname to the tree's `web:<domain>` project keys.

import type {
  Conversation,
  ConversationTree,
  ConversationTreeSession,
  ProjectStateView,
  Topic,
} from "../../types";

/** Capture-lineage fields the desktop shell stamps on Dexie records. They are
 * absent (undefined) in the extension build. */
export type DesktopSourceFields = {
  _source?: string;
  _cli_id?: string;
  _project_path?: string;
  /** A1: parent work-session id stamped on folded subagent runs. */
  _subagent_of?: string;
  /** A1: subagent role/type, when the capture recorded one. */
  _agent_role?: string;
};

export type SourceRef = {
  /** CLI platform slug ("claude-code", …) or "browser". */
  platform: string;
  /** "native", "wsl:<distro>" or "browser". */
  host: string;
};

export type SourceSelection =
  /** Platform-wide pick (home-dashboard source deep link): every host of the
   * platform matches, native and WSL alike — no single tree node owns it. */
  | { kind: "platform"; platform: string }
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
  /** subagent session id → parent session id (A1; children nested in the tree) */
  subagentParentByChildId: Map<string, string>;
  /** main session id → its subagent child nodes (A1) */
  subagentsByParentId: Map<string, ConversationTreeSession[]>;
  /** Memory v2: fork session id → the session it was forked from */
  forkedFromBySessionId: Map<string, string>;
  /** Memory v2: tree session id → node (fork badge + dedup counts on cards) */
  sessionNodeById: Map<string, ConversationTreeSession>;
};

export function buildConversationTreeLookup(
  tree: ConversationTree | null,
): ConversationTreeLookup {
  const bySessionId = new Map<string, { source: SourceRef; projectKey: string }>();
  const byProjectPath = new Map<string, { source: SourceRef; projectKey: string }>();
  const subagentParentByChildId = new Map<string, string>();
  const subagentsByParentId = new Map<string, ConversationTreeSession[]>();
  const forkedFromBySessionId = new Map<string, string>();
  const sessionNodeById = new Map<string, ConversationTreeSession>();
  for (const source of tree?.sources ?? []) {
    const ref: SourceRef = { platform: source.platform, host: source.host };
    for (const project of source.projects) {
      const placement = { source: ref, projectKey: project.projectKey };
      const pathKey = normalizePathKey(project.pathOrDomain ?? "");
      if (pathKey && !byProjectPath.has(pathKey)) {
        byProjectPath.set(pathKey, placement);
      }
      const indexSession = (
        session: ConversationTreeSession,
        parentId?: string,
      ) => {
        if (!bySessionId.has(session.id)) {
          bySessionId.set(session.id, placement);
        }
        if (!sessionNodeById.has(session.id)) {
          sessionNodeById.set(session.id, session);
        }
        if (session.forkedFrom && !forkedFromBySessionId.has(session.id)) {
          forkedFromBySessionId.set(session.id, session.forkedFrom);
        }
        if (parentId) {
          if (!subagentParentByChildId.has(session.id)) {
            subagentParentByChildId.set(session.id, parentId);
          }
          const siblings = subagentsByParentId.get(parentId) ?? [];
          siblings.push(session);
          subagentsByParentId.set(parentId, siblings);
        }
        for (const child of session.children ?? []) indexSession(child, session.id);
      };
      for (const session of project.sessions) indexSession(session);
    }
  }
  return {
    bySessionId,
    byProjectPath,
    subagentParentByChildId,
    subagentsByParentId,
    forkedFromBySessionId,
    sessionNodeById,
  };
}

/** A1: true when the conversation is a captured subagent session (folded
 * under its parent in the tree, the counts and the default library list).
 * Two signals: the `_subagent_of` stamp the desktop export writes on the
 * record itself, and the tree lookup (covers records synced before the
 * stamp existed). */
export function isSubagentConversation<T extends object>(
  conversation: T & { _cli_id?: unknown; _subagent_of?: unknown },
  lookup: ConversationTreeLookup,
): boolean {
  if (typeof conversation._subagent_of === "string" && conversation._subagent_of) {
    return true;
  }
  return (
    typeof conversation._cli_id === "string" &&
    lookup.subagentParentByChildId.has(conversation._cli_id)
  );
}

/** A1: merge the key_topics of a session's subagent descendants (deduped,
 * first-seen order, capped) for the parent digest header. Read-only. */
export function collectSubagentTopics(
  children: ConversationTreeSession[] | undefined,
  limit = 5,
): string[] {
  const topics: string[] = [];
  const seen = new Set<string>();
  const walk = (nodes: ConversationTreeSession[]) => {
    for (const node of nodes) {
      for (const topic of node.keyTopics) {
        if (topics.length >= limit) return;
        if (!seen.has(topic)) {
          seen.add(topic);
          topics.push(topic);
        }
      }
      if (topics.length < limit) walk(node.children ?? []);
      if (topics.length >= limit) return;
    }
  };
  walk(children ?? []);
  return topics;
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
 * shown in the tree; platform selections span every host of that platform
 * (native + WSL). A1: subagent sessions are folded under their parent and
 * never listed here — they surface through the parent card's subagent strip.
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
    if (isSubagentConversation(conversation, lookup)) return false;
    const placement = resolveConversationPlacement(conversation, lookup);
    if (!placement) return false;
    if (selection.kind === "platform") {
      return placement.source.platform === selection.platform;
    }
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
  /** Memory v2 L0 card, when the desktop has rebuilt one for this project. */
  state?: ProjectStateView;
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
 * and sources with no matching conversations are omitted. A1: subagent
 * sessions fold into their parent — only main sessions count.
 */
export function buildSourceTreeModel(args: {
  tree: ConversationTree | null;
  conversations: Conversation[];
  topics: Topic[];
  lookup?: ConversationTreeLookup;
  /** Memory v2: L0 cards keyed by projectKey, attached to project nodes. */
  projectStates?: Map<string, ProjectStateView>;
}): SourceTreeModel {
  const { tree, conversations, topics } = args;
  if (!tree) return { sources: [] };
  const lookup = args.lookup ?? buildConversationTreeLookup(tree);

  const aggregates = new Map<string, Map<string, ProjectAggregate>>();
  for (const conversation of conversations) {
    if (conversation.is_trash || conversation.is_archived) continue;
    if (isSubagentConversation(conversation, lookup)) continue;
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
        ...(args.projectStates?.get(project.projectKey)
          ? { state: args.projectStates.get(project.projectKey) }
          : {}),
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
  if (selection.kind === "platform") {
    return sourcePlatformLabel(selection.platform, browserLabel);
  }
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
