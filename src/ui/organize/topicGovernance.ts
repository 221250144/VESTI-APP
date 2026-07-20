// Topic governance (P2b): a one-shot "tidy existing topics" action on the
// settings page. The whole current topic tree is sent to the LLM, which
// proposes synonym merges and keyword-style renames; the user reviews the
// plan and confirms, then the plan is applied in batch via the repository's
// renameTopic / mergeTopics.
//
// The classify kind prompt cannot change (src/main/agentPrompts.ts is
// frozen), so the review runs through the free-form `explore` kind — its
// system prompt already follows agent.outputLanguage, and the question text
// below repeats the naming-language requirement explicitly. The pure core
// (request building, output parsing, plan validation) runs under the root
// vitest suite; only the Dexie/IPC orchestration at the bottom touches
// window.vesti.

import { db } from "../db/schema";
import type { TopicRecord } from "../db/schema";
import { mergeTopics, renameTopic } from "../db/repository";
import { logger } from "../db/logger";
import {
  formatTopicTree,
  normalizePathSegment,
  resolveClassifyLanguage,
  type ClassifyLanguage,
  type ClassifyTopicNode,
} from "./autoClassify";

// ---- Pure core -------------------------------------------------------------

/** Raw model output shape (ids only, before validation against the tree). */
export interface TopicGovernanceRaw {
  merges: Array<{ targetId: number; sourceIds: number[]; name: string | null }>;
  renames: Array<{ id: number; name: string }>;
}

export interface TopicMergePlan {
  targetId: number;
  targetName: string;
  sourceIds: number[];
  sourceNames: string[];
  /** Optional post-merge rename of the target (null = keep the target name). */
  name: string | null;
}

export interface TopicRenamePlan {
  id: number;
  from: string;
  to: string;
}

/** A validated, display-ready governance plan. */
export interface TopicGovernancePlan {
  merges: TopicMergePlan[];
  renames: TopicRenamePlan[];
}

const MAX_GOVERNANCE_NAME_LENGTH = 40;

function asPositiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : null;
}

function asName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed ? trimmed.slice(0, MAX_GOVERNANCE_NAME_LENGTH) : null;
}

/**
 * Parse the model's governance JSON, tolerating Markdown code fences and
 * surrounding prose. Malformed entries are dropped individually; a payload
 * that is not a JSON object at all throws so the caller can report a failed
 * review instead of applying nothing silently.
 */
export function parseTopicGovernance(raw: string): TopicGovernanceRaw {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("话题整理输出不是 JSON 对象");
  const parsed = JSON.parse(cleaned.slice(start, end + 1)) as unknown;
  if (!parsed || typeof parsed !== "object") throw new Error("话题整理输出不是 JSON 对象");
  const payload = parsed as Record<string, unknown>;

  const merges: TopicGovernanceRaw["merges"] = [];
  if (Array.isArray(payload.merges)) {
    for (const item of payload.merges) {
      if (!item || typeof item !== "object") continue;
      const entry = item as Record<string, unknown>;
      const targetId = asPositiveInt(entry.targetId);
      if (targetId === null) continue;
      const sourceIds = Array.isArray(entry.sourceIds)
        ? [...new Set(entry.sourceIds.map(asPositiveInt).filter((id): id is number => id !== null))]
        : [];
      const validSources = sourceIds.filter((id) => id !== targetId);
      if (validSources.length === 0) continue;
      merges.push({ targetId, sourceIds: validSources, name: asName(entry.name) });
    }
  }

  const renames: TopicGovernanceRaw["renames"] = [];
  if (Array.isArray(payload.renames)) {
    for (const item of payload.renames) {
      if (!item || typeof item !== "object") continue;
      const entry = item as Record<string, unknown>;
      const id = asPositiveInt(entry.id);
      const name = asName(entry.name);
      if (id === null || name === null) continue;
      renames.push({ id, name });
    }
  }

  return { merges, renames };
}

function isAncestorOf(
  ancestorId: number,
  id: number,
  byId: Map<number, ClassifyTopicNode>
): boolean {
  const guard = new Set<number>([id]);
  let current = byId.get(id);
  while (current && current.parent_id !== null && !guard.has(current.parent_id)) {
    if (current.parent_id === ancestorId) return true;
    guard.add(current.parent_id);
    current = byId.get(current.parent_id);
  }
  return false;
}

/**
 * Validate a raw governance payload against the actual topic tree and turn it
 * into a display-ready plan:
 * - unknown ids, self-merges and ancestor→descendant merges (would create a
 *   cycle) are dropped;
 * - a topic may appear as a merge source at most once, and a merge target may
 *   not itself be merged away by another entry;
 * - no-op renames and renames colliding with an existing sibling name (the
 *   repository would reject them) are dropped; sources of a merge disappear,
 *   so renaming them is dropped too.
 */
export function filterTopicGovernancePlan(
  raw: TopicGovernanceRaw,
  topics: ClassifyTopicNode[]
): TopicGovernancePlan {
  const byId = new Map(topics.map((topic) => [topic.id, topic]));
  const takenSources = new Set<number>();
  const merges: TopicMergePlan[] = [];

  for (const merge of raw.merges) {
    const target = byId.get(merge.targetId);
    if (!target || takenSources.has(merge.targetId)) continue;
    const sourceIds = merge.sourceIds.filter((id) => {
      const source = byId.get(id);
      return (
        source !== undefined &&
        !takenSources.has(id) &&
        // Merging an ancestor into its own descendant would create a cycle.
        !isAncestorOf(id, merge.targetId, byId)
      );
    });
    if (sourceIds.length === 0) continue;
    for (const id of sourceIds) takenSources.add(id);
    merges.push({
      targetId: target.id,
      targetName: target.name,
      sourceIds,
      sourceNames: sourceIds.map((id) => (byId.get(id) as ClassifyTopicNode).name),
      name:
        merge.name && normalizePathSegment(merge.name) !== normalizePathSegment(target.name)
          ? merge.name
          : null,
    });
  }

  // Sibling-name reservations, seeded with every topic that survives the
  // merges (merged-away sources free their names), so planned renames /
  // post-merge renames cannot collide with each other or with the tree.
  const reserved = new Set(
    topics
      .filter((topic) => !takenSources.has(topic.id))
      .map((topic) => `${topic.parent_id ?? "root"}:${normalizePathSegment(topic.name)}`)
  );
  const claimed = new Set<number>();
  const renames: TopicRenamePlan[] = [];
  const reserveIfFree = (topic: ClassifyTopicNode, name: string): boolean => {
    const key = `${topic.parent_id ?? "root"}:${normalizePathSegment(name)}`;
    if (reserved.has(key)) return false;
    reserved.add(key);
    return true;
  };

  for (const rename of raw.renames) {
    const topic = byId.get(rename.id);
    if (!topic || claimed.has(rename.id) || takenSources.has(rename.id)) continue;
    if (normalizePathSegment(rename.name) === normalizePathSegment(topic.name)) continue;
    if (!reserveIfFree(topic, rename.name)) continue;
    claimed.add(rename.id);
    renames.push({ id: rename.id, from: topic.name, to: rename.name });
  }

  for (const merge of merges) {
    if (merge.name === null || claimed.has(merge.targetId)) {
      if (claimed.has(merge.targetId)) merge.name = null;
      continue;
    }
    const target = byId.get(merge.targetId) as ClassifyTopicNode;
    if (!reserveIfFree(target, merge.name)) {
      // The post-merge name would collide; keep the merge, drop the rename.
      merge.name = null;
    }
  }

  return { merges, renames };
}

// ---- LLM request -----------------------------------------------------------

const GOVERNANCE_QUESTION_ZH = [
  "你是主题树整理助手。下面「会话内容」是用户当前的会话主题树，每行格式为「#id 一级 / 二级」（「 / 」分隔层级）。请审查整棵树并提出整理建议。",
  "只输出一个 JSON 对象（不要 Markdown 代码围栏、不要任何额外文字），结构：",
  '{"merges":[{"targetId":保留的主题id,"sourceIds":[被合并的主题id],"name":"可选：合并后的新名字"}],"renames":[{"id":主题id,"name":"新名字"}]}',
  "整理标准：",
  "- merges：合并同义、近义或粒度重复的主题；targetId 选语义更准确、更通用的那个。被合并主题会被删除，其会话与子主题自动并入 targetId。",
  "- renames：把关键词堆砌、平台名/文件名式、或过长的主题名改成 2-6 字、有区分度的名词短语；名字已经清晰的主题不要动。",
  "- 所有新名字一律使用简体中文（React、API 这类专有名词可保留原文），且不得与同一父主题下的其他主题重名。",
  '- 没有需要整理的地方就输出 {"merges":[],"renames":[]}；不要输出任何解释。',
].join("\n");

const GOVERNANCE_QUESTION_EN = [
  'You are a topic-tree tidy-up assistant. The "conversation content" below is the user\'s current conversation topic tree, one "#id level1 / level2" path per line (" / " separates levels). Review the whole tree and propose tidy-ups.',
  "Output exactly one JSON object (no Markdown fences, no extra text) with this shape:",
  '{"merges":[{"targetId":topic id to keep,"sourceIds":[ids merged into it],"name":"optional new name after merging"}],"renames":[{"id":topic id,"name":"new name"}]}',
  "Criteria:",
  "- merges: merge synonymous, near-duplicate or redundant-granularity topics; pick the clearer, more general topic as targetId. Merged topics are deleted and their conversations and children move to targetId.",
  "- renames: turn keyword-stuffed, platform/file-name-based or overlong names into distinctive 2-6 word noun phrases; leave already-clear names alone.",
  "- All new names must be in English (proper nouns like React or API may stay as-is) and must not collide with a sibling under the same parent.",
  '- If nothing needs tidying, output {"merges":[],"renames":[]}; do not explain.',
].join("\n");

/** Question + transcript for the explore-kind review call. */
export function buildTopicGovernanceRequest(
  topics: ClassifyTopicNode[],
  language: ClassifyLanguage = "zh"
): { question: string; transcript: string } {
  const header = language === "en" ? "Current topic tree:" : "当前主题树：";
  return {
    question: language === "en" ? GOVERNANCE_QUESTION_EN : GOVERNANCE_QUESTION_ZH,
    // transcriptOverride is capped at 30k chars by the IPC validator; a real
    // topic tree is far smaller, but clip defensively.
    transcript: `${header}\n${formatTopicTree(topics)}`.slice(0, 28_000),
  };
}

// ---- Orchestration (Dexie + window.vesti IPC) ------------------------------

async function loadTopicNodes(): Promise<ClassifyTopicNode[]> {
  const records = await db.topics.toArray();
  return records
    .filter((record): record is TopicRecord & { id: number } => typeof record.id === "number")
    .map((record) => ({ id: record.id, name: record.name, parent_id: record.parent_id }));
}

async function readUiLocale(): Promise<string | null> {
  try {
    if (typeof window === "undefined" || !window.vestiUi) return null;
    const value = (await window.vestiUi.getUiPreference("language")) as { locale?: unknown } | null;
    return value && typeof value.locale === "string" ? value.locale : null;
  } catch {
    return null;
  }
}

/**
 * Run one governance review over the current topic tree and return the
 * validated plan for the user to confirm. Returns null when the review cannot
 * run (no bridge, no working model); an empty plan means the model found
 * nothing to tidy.
 */
export async function runTopicGovernance(): Promise<TopicGovernancePlan | null> {
  const api = typeof window !== "undefined" && window.vesti ? window.vesti : null;
  if (!api) return null;
  const settings = await api.getSettings().catch(() => null);
  if (!settings) return null;
  const llmReady = settings.llm.mode === "demo_proxy" || settings.llm.apiKeyConfigured;
  if (!llmReady) return null;

  const topics = await loadTopicNodes();
  if (topics.length < 2) return { merges: [], renames: [] };

  const language = resolveClassifyLanguage(settings.agent?.outputLanguage, await readUiLocale());
  const request = buildTopicGovernanceRequest(topics, language);
  const result = await api.runAgent({
    kind: "explore",
    sessionId: `topic-govern:${Date.now()}`,
    question: request.question,
    transcriptOverride: request.transcript,
    persist: false,
  });
  return filterTopicGovernancePlan(parseTopicGovernance(result.content), topics);
}

export interface TopicGovernanceApplyResult {
  merged: number;
  renamed: number;
}

/**
 * Apply a user-confirmed plan: renames first, then merges (a merge carrying a
 * post-merge name renames the target best-effort — a raced name conflict
 * must not block the merge itself).
 */
export async function applyTopicGovernance(
  plan: TopicGovernancePlan
): Promise<TopicGovernanceApplyResult> {
  const result: TopicGovernanceApplyResult = { merged: 0, renamed: 0 };
  for (const rename of plan.renames) {
    try {
      await renameTopic(rename.id, rename.to);
      result.renamed += 1;
    } catch (error) {
      logger.error("db", `Topic rename failed for #${rename.id}`, error as Error);
    }
  }
  for (const merge of plan.merges) {
    if (merge.name) {
      await renameTopic(merge.targetId, merge.name).catch(() => {});
    }
    try {
      const applied = await mergeTopics(merge.targetId, merge.sourceIds);
      if (applied.removed > 0) result.merged += 1;
    } catch (error) {
      logger.error("db", `Topic merge failed into #${merge.targetId}`, error as Error);
    }
  }
  if (result.merged > 0 || result.renamed > 0) {
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("vesti:data-updated"));
    }
  }
  return result;
}
