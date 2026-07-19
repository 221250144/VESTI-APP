// Auto-classify (P2a): batches unclassified conversations through the main
// process's `classify` agent kind and files them into the manual topic tree.
//
// The logic core is pure (candidate selection, condensed briefs, topic-path
// resolution, suggestion merging) so it runs under the root vitest suite;
// the Dexie/IPC-touching orchestration sits at the bottom of the file.
//
// Safety rules:
// - a conversation the user classified manually (topic_id set without the
//   auto_classified marker) is never overwritten;
// - low-confidence results (< 0.6) and suggest-only mode go to a persistent
//   queue stored as the non-indexed `classify_suggestion` field on the
//   conversation record;
// - accepting/ignoring a suggestion and any manual re-assignment clears that
//   field; a user-confirmed suggestion counts as a manual assignment.

import { db } from "../db/schema";
import type { ConversationRecord, TopicRecord } from "../db/schema";
import { createTopic, getAllSummaries } from "../db/repository";
import { logger } from "../db/logger";
import { loadConversationTree } from "../sync/conversationTree";

export const CLASSIFY_BATCH_SIZE = 30;
export const CLASSIFY_AUTO_APPLY_MIN_CONFIDENCE = 0.6;
export const AUTO_CLASSIFY_TRIGGER_DEBOUNCE_MS = 10_000;

export type AutoClassifyMode = "auto" | "suggest";

const PREF_KEYS = {
  enabled: "classify.enabled",
  mode: "classify.mode",
  lastRun: "classify.lastRun",
} as const;

// ---- Pure core -------------------------------------------------------------

export interface ClassifySuggestionPayload {
  topicPath: string[];
  confidence: number;
  createdAt: number;
}

export interface ClassifySuggestion extends ClassifySuggestionPayload {
  conversationId: number;
  title: string;
}

/** Minimal conversation shape the pure core needs (ConversationRecord fits). */
export interface ClassifyCandidateRecord {
  id?: number;
  topic_id: number | null;
  is_archived?: boolean;
  is_trash?: boolean;
  auto_classified?: number;
  classify_suggestion?: ClassifySuggestionPayload | null;
}

/**
 * Conversations eligible for auto-classification: not archived/trashed and
 * either unclassified or previously auto-classified (re-run). Manual
 * assignments and conversations already holding a pending suggestion are
 * never touched.
 */
export function selectClassifyCandidates<T extends ClassifyCandidateRecord>(
  records: T[]
): T[] {
  return records.filter(
    (record) =>
      typeof record.id === "number" &&
      !record.is_archived &&
      !record.is_trash &&
      !record.classify_suggestion &&
      (record.topic_id == null || record.auto_classified === 1)
  );
}

export interface ClassifyTopicNode {
  id: number;
  name: string;
  parent_id: number | null;
}

export function normalizePathSegment(name: string): string {
  return name.replace(/\s+/g, " ").trim().toLowerCase();
}

export type TopicPathResolution =
  | { kind: "existing"; topicId: number }
  | { kind: "create"; parentId: number | null; names: string[] };

/**
 * Resolve a 1-3 level topic path against the flat topic list. Existing nodes
 * are reused per level by normalized name match (case/whitespace
 * insensitive); the first unmatched segment and everything below it becomes
 * a creation plan chained under the deepest matched node.
 */
export function resolveTopicPath(
  path: string[],
  topics: ClassifyTopicNode[]
): TopicPathResolution {
  const segments = path.map((segment) => segment.replace(/\s+/g, " ").trim()).filter(Boolean);
  if (segments.length === 0) throw new Error("topicPath 为空");
  let parentId: number | null = null;
  for (let index = 0; index < segments.length; index += 1) {
    const wanted = normalizePathSegment(segments[index]);
    const match = topics.find(
      (topic) => topic.parent_id === parentId && normalizePathSegment(topic.name) === wanted
    );
    if (!match) {
      return { kind: "create", parentId, names: segments.slice(index) };
    }
    parentId = match.id;
  }
  return { kind: "existing", topicId: parentId as number };
}

/** Flatten the topic list into `#id 一级 / 二级` lines for the prompt. */
export function formatTopicTree(topics: ClassifyTopicNode[]): string {
  if (topics.length === 0) return "（空）";
  const byId = new Map(topics.map((topic) => [topic.id, topic]));
  const pathOf = (topic: ClassifyTopicNode): string => {
    const names = [topic.name];
    const guard = new Set<number>([topic.id]);
    let current = topic;
    while (current.parent_id !== null) {
      const parent = byId.get(current.parent_id);
      if (!parent || guard.has(parent.id)) break;
      names.unshift(parent.name);
      guard.add(parent.id);
      current = parent;
    }
    return names.join(" / ");
  };
  return [...topics]
    .sort((a, b) => pathOf(a).localeCompare(pathOf(b)))
    .map((topic) => `#${topic.id} ${pathOf(topic)}`)
    .join("\n");
}

export interface ClassifyBrief {
  id: number;
  title: string;
  platform: string;
  project: string | null;
  digest: { oneLiner: string; keyTopics: string[] } | null;
  summaryPoints: string[];
  snippet: string;
}

function clip(text: string, max: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
}

/**
 * One numbered transcript line per candidate. The condensed info prefers the
 * session digest, falls back to summary bullet points, then to title+snippet.
 */
export function buildCandidateLine(ref: number, brief: ClassifyBrief): string {
  const parts = [`[${ref}] 标题：${clip(brief.title, 80)}`, `平台：${brief.platform}`];
  if (brief.project) parts.push(`项目：${clip(brief.project, 60)}`);
  if (brief.digest?.oneLiner) {
    parts.push(`摘要：${clip(brief.digest.oneLiner, 120)}`);
    if (brief.digest.keyTopics.length > 0) {
      parts.push(`主题词：${brief.digest.keyTopics.slice(0, 4).map((topic) => clip(topic, 24)).join("、")}`);
    }
  } else if (brief.summaryPoints.length > 0) {
    parts.push(`要点：${brief.summaryPoints.slice(0, 3).map((point) => clip(point, 80)).join("；")}`);
  } else if (brief.snippet) {
    parts.push(`片段：${clip(brief.snippet, 160)}`);
  }
  return parts.join("｜");
}

/** The transcriptOverride sent to the classify kind: topic tree + numbered candidates. */
export function buildClassifyTranscript(
  briefs: ClassifyBrief[],
  topics: ClassifyTopicNode[]
): string {
  return [
    "现有主题树：",
    formatTopicTree(topics),
    "",
    "待分类会话：",
    ...briefs.map((brief, index) => buildCandidateLine(index + 1, brief)),
  ].join("\n");
}

export interface MappedClassifyAssignment {
  ref: number;
  conversationId: number;
  topicPath: string[];
  newTopic: boolean;
  confidence: number;
}

/**
 * Bind parsed assignments back to the batch candidates (refs are 1-based, in
 * the same order buildClassifyTranscript numbered them). A ref that does not
 * map to a candidate means the model hallucinated — throw so the caller can
 * degrade the whole batch. Duplicate refs keep the first occurrence.
 */
export function mapClassifyAssignments(
  assignments: Array<{
    ref: number;
    topicPath: string[];
    newTopic: boolean;
    confidence: number;
  }>,
  candidateIds: number[]
): MappedClassifyAssignment[] {
  const seen = new Set<number>();
  const mapped: MappedClassifyAssignment[] = [];
  for (const assignment of assignments) {
    const conversationId = candidateIds[assignment.ref - 1];
    if (conversationId === undefined) {
      throw new Error(`classify 输出包含无法映射的 ref：${assignment.ref}`);
    }
    if (seen.has(assignment.ref)) continue;
    seen.add(assignment.ref);
    mapped.push({ ...assignment, conversationId });
  }
  return mapped;
}

// ---- Suggestion queue ------------------------------------------------------

export interface SuggestionStore {
  list(): Promise<ClassifySuggestion[]>;
  add(items: ClassifySuggestion[]): Promise<void>;
  remove(conversationId: number): Promise<void>;
}

/** In-memory store: used by tests, and as the non-Electron fallback. */
export function createMemorySuggestionStore(): SuggestionStore {
  const items = new Map<number, ClassifySuggestion>();
  return {
    list: async () => [...items.values()].sort((a, b) => b.createdAt - a.createdAt),
    add: async (next) => {
      for (const item of next) items.set(item.conversationId, item);
    },
    remove: async (conversationId) => {
      items.delete(conversationId);
    },
  };
}

/**
 * Dexie-backed queue: suggestions live as the non-indexed
 * `classify_suggestion` field on each conversation record, so no schema
 * version bump and re-sync merges preserve them (captureSync /
 * importExtensionBundle carry the field over like topic_id).
 */
const dexieSuggestionStore: SuggestionStore = {
  async list() {
    const records = await db.conversations.toArray();
    const suggestions: ClassifySuggestion[] = [];
    for (const record of records) {
      const payload = record.classify_suggestion;
      if (typeof record.id !== "number" || !payload) continue;
      suggestions.push({
        conversationId: record.id,
        title: record.title,
        topicPath: Array.isArray(payload.topicPath) ? payload.topicPath : [],
        confidence: typeof payload.confidence === "number" ? payload.confidence : 0.5,
        createdAt: typeof payload.createdAt === "number" ? payload.createdAt : 0,
      });
    }
    return suggestions.sort((a, b) => b.createdAt - a.createdAt);
  },
  async add(items) {
    await db.transaction("rw", db.conversations, async () => {
      for (const item of items) {
        const record = await db.conversations.get(item.conversationId);
        // Never queue over a manual assignment the user made meanwhile.
        if (!record || (record.topic_id != null && record.auto_classified !== 1)) continue;
        await db.conversations.update(item.conversationId, {
          classify_suggestion: {
            topicPath: item.topicPath,
            confidence: item.confidence,
            createdAt: item.createdAt,
          },
        });
      }
    });
  },
  async remove(conversationId) {
    await db.conversations.update(conversationId, { classify_suggestion: null });
  },
};

// ---- Run state -------------------------------------------------------------

export interface ClassifyRunStats {
  ranAt: number;
  candidates: number;
  classified: number;
  topicsCreated: number;
  queued: number;
  batches: number;
  failedBatches: number;
}

export interface AutoClassifyState {
  running: boolean;
  lastRun: ClassifyRunStats | null;
}

export type AutoClassifyListener = (state: AutoClassifyState) => void;

let state: AutoClassifyState = { running: false, lastRun: null };
const listeners = new Set<AutoClassifyListener>();

function setState(patch: Partial<AutoClassifyState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener(state);
}

export function getAutoClassifyState(): AutoClassifyState {
  return state;
}

export function subscribeAutoClassify(listener: AutoClassifyListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

async function readPref<T>(key: string, fallback: T): Promise<T> {
  try {
    if (typeof window === "undefined" || !window.vestiUi) return fallback;
    const value = await window.vestiUi.getUiPreference(key);
    return value === undefined || value === null ? fallback : (value as T);
  } catch {
    return fallback;
  }
}

/** Pull the persisted last-run stats into memory (settings page on open). */
export async function loadAutoClassifyState(): Promise<void> {
  const lastRun = await readPref<ClassifyRunStats | null>(PREF_KEYS.lastRun, null);
  if (lastRun && typeof lastRun.ranAt === "number") setState({ lastRun });
}

// ---- Orchestration (Dexie + window.vesti IPC) ------------------------------

type LocalTerminalFields = {
  _source?: string;
  _cli_id?: string;
  _project_path?: string;
};

function projectLabelOf(record: ConversationRecord & LocalTerminalFields): string | null {
  const projectPath = typeof record._project_path === "string" ? record._project_path.trim() : "";
  if (projectPath) {
    const parts = projectPath.split(/[\\/]/).filter(Boolean);
    return parts[parts.length - 1] ?? null;
  }
  if (record._source === "browser_extension" && record.url) {
    try {
      return new URL(record.url).hostname || null;
    } catch {
      return null;
    }
  }
  return null;
}

function summaryPointsOf(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*>\d.)\s#]+/, "").trim())
    .filter((line) => line.length >= 8)
    .slice(0, 3);
}

/** Digest briefs keyed by Dexie conversation id, from the cached P1.5 tree. */
async function loadDigestBriefs(): Promise<
  Map<number, { oneLiner: string; keyTopics: string[] }>
> {
  const tree = await loadConversationTree();
  const byCliId = new Map<string, { oneLiner: string; keyTopics: string[] }>();
  for (const source of tree.sources) {
    for (const project of source.projects) {
      for (const session of project.sessions) {
        if (!session.oneLiner) continue;
        byCliId.set(session.id, { oneLiner: session.oneLiner, keyTopics: session.keyTopics });
      }
    }
  }
  const briefs = new Map<number, { oneLiner: string; keyTopics: string[] }>();
  if (byCliId.size === 0) return briefs;
  const records = (await db.conversations.toArray()) as Array<
    ConversationRecord & LocalTerminalFields
  >;
  for (const record of records) {
    if (typeof record.id !== "number" || typeof record._cli_id !== "string") continue;
    const digest = byCliId.get(record._cli_id);
    if (digest) briefs.set(record.id, digest);
  }
  return briefs;
}

async function loadTopicNodes(): Promise<ClassifyTopicNode[]> {
  const records = await db.topics.toArray();
  return records
    .filter((record): record is TopicRecord & { id: number } => typeof record.id === "number")
    .map((record) => ({ id: record.id, name: record.name, parent_id: record.parent_id }));
}

/**
 * Create any missing path segments (normalized-match reusing existing nodes)
 * and return the leaf topic id. `topics` is mutated with created nodes so
 * later paths in the same run chain onto them.
 */
export async function ensureTopicPath(
  path: string[],
  topics: ClassifyTopicNode[]
): Promise<{ topicId: number; created: number }> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const resolution = resolveTopicPath(path, topics);
    if (resolution.kind === "existing") {
      return { topicId: resolution.topicId, created: 0 };
    }
    let parentId = resolution.parentId;
    let created = 0;
    try {
      for (const name of resolution.names) {
        const topic = await createTopic({ name, parent_id: parentId });
        topics.push({ id: topic.id, name: topic.name, parent_id: parentId });
        parentId = topic.id;
        created += 1;
      }
      return { topicId: parentId as number, created };
    } catch {
      // A concurrent write created a conflicting node; re-resolve once
      // against the fresh table instead of failing the assignment.
      topics.length = 0;
      topics.push(...(await loadTopicNodes()));
    }
  }
  const fallback = resolveTopicPath(path, topics);
  if (fallback.kind === "existing") return { topicId: fallback.topicId, created: 0 };
  throw new Error("无法创建主题路径");
}

let running = false;

/**
 * One auto-classify pass over every eligible conversation. Returns the run
 * stats, or null when the run was skipped (disabled, no LLM, another run in
 * flight, or no candidates — none of which should overwrite lastRun).
 * trigger: "manual" (settings page button) bypasses the enabled toggle,
 * which only governs the debounced post-sync auto-run.
 */
export async function runAutoClassify(options?: {
  store?: SuggestionStore;
  trigger?: "manual" | "auto";
}): Promise<ClassifyRunStats | null> {
  const api = typeof window !== "undefined" && window.vesti ? window.vesti : null;
  if (!api || running) return null;
  if (options?.trigger !== "manual") {
    const enabled = await readPref(PREF_KEYS.enabled, true);
    if (!enabled) return null;
  }
  const settings = await api.getSettings().catch(() => null);
  if (!settings) return null;
  // demo_proxy works out of the box; BYOK needs a saved API key.
  const llmReady = settings.llm.mode === "demo_proxy" || settings.llm.apiKeyConfigured;
  if (!llmReady) return null;
  const mode = await readPref<AutoClassifyMode>(PREF_KEYS.mode, "auto");

  running = true;
  setState({ running: true });
  try {
    const [records, topics, digestBriefs, summaries] = await Promise.all([
      db.conversations.toArray() as Promise<Array<ConversationRecord & LocalTerminalFields>>,
      loadTopicNodes(),
      loadDigestBriefs().catch(() => new Map<number, { oneLiner: string; keyTopics: string[] }>()),
      getAllSummaries().catch(() => []),
    ]);

    const candidates = selectClassifyCandidates(records);
    if (candidates.length === 0) return null;

    // Latest summary per conversation (getAllSummaries may repeat ids).
    const summaryByConversation = new Map<number, { content: string; createdAt: number }>();
    for (const summary of summaries) {
      const existing = summaryByConversation.get(summary.conversationId);
      if (!existing || summary.createdAt > existing.createdAt) {
        summaryByConversation.set(summary.conversationId, {
          content: summary.content,
          createdAt: summary.createdAt,
        });
      }
    }

    const briefs: ClassifyBrief[] = candidates.map((record) => ({
      id: record.id as number,
      title: record.title,
      platform: record.platform,
      project: projectLabelOf(record),
      digest: digestBriefs.get(record.id as number) ?? null,
      summaryPoints: summaryPointsOf(summaryByConversation.get(record.id as number)?.content ?? ""),
      snippet: record.snippet ?? "",
    }));

    const stats: ClassifyRunStats = {
      ranAt: Date.now(),
      candidates: briefs.length,
      classified: 0,
      topicsCreated: 0,
      queued: 0,
      batches: 0,
      failedBatches: 0,
    };
    const queuedItems: ClassifySuggestion[] = [];
    const briefById = new Map(briefs.map((brief) => [brief.id, brief]));

    for (let start = 0; start < briefs.length; start += CLASSIFY_BATCH_SIZE) {
      const batch = briefs.slice(start, start + CLASSIFY_BATCH_SIZE);
      stats.batches += 1;
      try {
        const result = await api.runAgent({
          kind: "classify",
          sessionId: `classify:${stats.ranAt}:${stats.batches}`,
          transcriptOverride: buildClassifyTranscript(batch, topics),
          persist: false,
        });
        const assignments = mapClassifyAssignments(
          JSON.parse(result.content),
          batch.map((brief) => brief.id)
        );
        for (const assignment of assignments) {
          const brief = briefById.get(assignment.conversationId);
          if (!brief) continue;
          if (mode === "suggest" || assignment.confidence < CLASSIFY_AUTO_APPLY_MIN_CONFIDENCE) {
            queuedItems.push({
              conversationId: brief.id,
              title: brief.title,
              topicPath: assignment.topicPath,
              confidence: assignment.confidence,
              createdAt: stats.ranAt,
            });
            stats.queued += 1;
            continue;
          }
          // Re-check right before writing: a manual assignment made while the
          // LLM was running must win over the classifier.
          const fresh = await db.conversations.get(assignment.conversationId);
          if (!fresh || (fresh.topic_id != null && fresh.auto_classified !== 1)) continue;
          const ensured = await ensureTopicPath(assignment.topicPath, topics);
          stats.topicsCreated += ensured.created;
          await db.conversations.update(assignment.conversationId, {
            topic_id: ensured.topicId,
            auto_classified: 1,
            classify_suggestion: null,
            updated_at: Date.now(),
          });
          stats.classified += 1;
        }
      } catch (error) {
        // Bad model output or a failed batch: degrade by skipping the batch,
        // the conversations stay unclassified for the next run.
        stats.failedBatches += 1;
        logger.error("db", "Auto-classify batch failed", error as Error);
      }
    }

    if (queuedItems.length > 0) {
      await (options?.store ?? dexieSuggestionStore).add(queuedItems);
    }
    if (stats.classified > 0 || stats.topicsCreated > 0 || stats.queued > 0) {
      setState({ lastRun: stats });
      if (typeof window !== "undefined") {
        void window.vestiUi?.setUiPreference(PREF_KEYS.lastRun, stats).catch(() => {});
        window.dispatchEvent(new CustomEvent("vesti:data-updated"));
      }
    }
    return stats;
  } finally {
    running = false;
    setState({ running: false });
  }
}

// ---- Queue actions (settings page) -----------------------------------------

export async function listClassifySuggestions(
  store: SuggestionStore = dexieSuggestionStore
): Promise<ClassifySuggestion[]> {
  return store.list();
}

export async function ignoreClassifySuggestion(
  conversationId: number,
  store: SuggestionStore = dexieSuggestionStore
): Promise<void> {
  await store.remove(conversationId);
}

export async function acceptClassifySuggestion(
  conversationId: number,
  store: SuggestionStore = dexieSuggestionStore
): Promise<void> {
  const record = await db.conversations.get(conversationId);
  const suggestion = record?.classify_suggestion;
  if (
    !record ||
    !suggestion ||
    !Array.isArray(suggestion.topicPath) ||
    suggestion.topicPath.length === 0
  ) {
    await store.remove(conversationId);
    return;
  }
  const topics = await loadTopicNodes();
  const { topicId } = await ensureTopicPath(suggestion.topicPath, topics);
  await db.conversations.update(conversationId, {
    topic_id: topicId,
    // A user-confirmed assignment counts as manual: future runs leave it alone.
    auto_classified: 0,
    classify_suggestion: null,
    updated_at: Date.now(),
  });
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("vesti:data-updated"));
  }
}

export async function acceptAllClassifySuggestions(
  store: SuggestionStore = dexieSuggestionStore
): Promise<number> {
  const items = await store.list();
  for (const item of items) {
    await acceptClassifySuggestion(item.conversationId, store);
  }
  return items.length;
}

// ---- Debounced auto trigger ------------------------------------------------

let triggerStarted = false;
let triggerTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Debounced auto-run after every successful capture/extension import (which
 * fires "vesti:data-updated"). The run itself dispatches the same event when
 * it changes data; the follow-up pass finds no candidates (everything is
 * classified or queued) and exits as a cheap no-op, so no loop forms.
 */
export function startAutoClassifyTrigger(): void {
  if (triggerStarted) return;
  if (typeof window === "undefined" || !window.vesti) return;
  triggerStarted = true;
  void loadAutoClassifyState();
  window.addEventListener("vesti:data-updated", () => {
    if (triggerTimer !== null) clearTimeout(triggerTimer);
    triggerTimer = setTimeout(() => {
      triggerTimer = null;
      void runAutoClassify();
    }, AUTO_CLASSIFY_TRIGGER_DEBOUNCE_MS);
  });
}
