// P4b deposits: pure helpers for the deposits area — version-chain logic and
// scope → conversation-id resolution. No Dexie/IO here; the caller
// (desktopStorage) gathers conversations and the conversation tree and passes
// them in, so everything stays deterministic and unit-testable.

import type { AgentRunRequest, ConversationTree } from "../../shared/contracts";
import {
  buildDepositMaintainTranscript,
  parseDepositMaintainPayload,
  type DepositMaintainOp,
} from "../../shared/depositMaintain";
import type { Deposit, DepositScope } from "../db/types";

/** Version pointer for a regenerated deposit: v1 has no predecessor, every
 * regeneration chains onto the previous head with version+1. */
export function nextDepositVersion(
  previous: Pick<Deposit, "id" | "version"> | null
): { version: number; prevId: number | null } {
  if (!previous) return { version: 1, prevId: null };
  return { version: previous.version + 1, prevId: previous.id };
}

/**
 * Walk a version chain newest → oldest, starting at `headId` and following
 * prevId pointers. Cycle-safe: each id is visited at most once, and the walk
 * stops silently on a dangling pointer (deleted predecessor).
 */
export function collectVersionChain(deposits: Deposit[], headId: number): Deposit[] {
  const byId = new Map(deposits.map((deposit) => [deposit.id, deposit]));
  const chain: Deposit[] = [];
  const seen = new Set<number>();
  let currentId: number | null = headId;
  while (currentId !== null && !seen.has(currentId)) {
    seen.add(currentId);
    const deposit = byId.get(currentId);
    if (!deposit) break;
    chain.push(deposit);
    currentId = deposit.prevId;
  }
  return chain;
}

/** Current heads: deposits no other deposit points to via prevId. */
export function findDepositHeads(deposits: Deposit[]): Deposit[] {
  const referenced = new Set<number>();
  for (const deposit of deposits) {
    if (deposit.prevId !== null) referenced.add(deposit.prevId);
  }
  return deposits.filter((deposit) => !referenced.has(deposit.id));
}

/** Data the scope resolver needs, gathered by the caller. */
export interface ScopeResolutionData {
  conversations: Array<{
    id: number;
    topic_id?: number | null;
    updated_at?: number | null;
    /** Local-terminal capture id (main-process SQLite session id). */
    _cli_id?: string | null;
  }>;
  tree: ConversationTree | null;
}

function resolveProjectIds(projectKey: string, data: ScopeResolutionData): number[] {
  const ids = new Set<number>();
  const project = data.tree?.sources
    .flatMap((source) => source.projects)
    .find((candidate) => candidate.projectKey === projectKey);
  if (!project) return [];
  const byCliId = new Map<string, number>();
  for (const conversation of data.conversations) {
    if (typeof conversation._cli_id === "string") byCliId.set(conversation._cli_id, conversation.id);
  }
  for (const session of project.sessions) {
    if (session.id.startsWith("browser:")) {
      const id = Number(session.id.slice("browser:".length));
      if (Number.isInteger(id) && id > 0) ids.add(id);
      continue;
    }
    const id = byCliId.get(session.id);
    if (id !== undefined) ids.add(id);
  }
  return [...ids];
}

/**
 * Resolve a deposit scope to concrete conversation ids. Unknown/deleted
 * conversations are dropped; selection keeps its order, every other scope
 * returns ids sorted by recency (newest first).
 */
export function resolveScopeConversationIds(
  scope: DepositScope,
  data: ScopeResolutionData
): number[] {
  const known = new Set(data.conversations.map((conversation) => conversation.id));
  let ids: number[];
  switch (scope.kind) {
    case "selection":
      return [...new Set(scope.conversationIds)].filter(
        (id) => Number.isInteger(id) && id > 0 && known.has(id)
      );
    case "topic":
      ids = data.conversations
        .filter((conversation) => conversation.topic_id === scope.topicId)
        .map((conversation) => conversation.id);
      break;
    case "timerange":
      ids = data.conversations
        .filter((conversation) => {
          const updatedAt = conversation.updated_at ?? 0;
          return updatedAt >= scope.start && updatedAt <= scope.end;
        })
        .map((conversation) => conversation.id);
      break;
    case "project":
      return resolveProjectIds(scope.projectKey, data);
  }
  const recency = new Map(
    data.conversations.map((conversation) => [conversation.id, conversation.updated_at ?? 0])
  );
  return ids.sort((a, b) => (recency.get(b) ?? 0) - (recency.get(a) ?? 0));
}

// ---- mem0-style maintain merge ---------------------------------------------

/** Minimal agent-run surface the merge pipeline needs (window.vesti.runAgent
 * in production, a mock in tests). */
export interface DepositAgentRunner {
  run(request: AgentRunRequest): Promise<{ content: string }>;
}

export interface DepositDistillMergeResult {
  /** Final document to persist as the new version. */
  contentMarkdown: string;
  /** Maintain ops when a merge ran; null when the new version is a raw
   * replacement (fresh v1, or maintain unavailable/failed). */
  ops: DepositMaintainOp[] | null;
}

/**
 * Regeneration pipeline (mem0-style): distill the scope's fresh context, then
 * — only when a previous version exists — ask the deposit-maintain agent to
 * merge the fresh distillation into the previous document and record the ops.
 * Any maintain failure (LLM not configured, bad output) degrades to the raw
 * distillation with no ops, matching the pre-maintain behavior.
 */
export async function distillAndMergeDeposit(
  runner: DepositAgentRunner,
  params: {
    sessionId: string;
    template: string;
    customInstruction?: string;
    transcript: string;
    previousContent: string | null;
  }
): Promise<DepositDistillMergeResult> {
  const distilled = await runner.run({
    kind: "distill",
    sessionId: params.sessionId,
    template: params.template,
    question: params.customInstruction,
    transcriptOverride: params.transcript,
    persist: false,
  });
  const fresh = distilled.content;

  if (!params.previousContent?.trim()) {
    return { contentMarkdown: fresh, ops: null };
  }

  try {
    const maintained = await runner.run({
      kind: "deposit-maintain",
      sessionId: params.sessionId,
      transcriptOverride: buildDepositMaintainTranscript(params.previousContent, fresh),
      persist: false,
    });
    const payload = parseDepositMaintainPayload(maintained.content);
    return { contentMarkdown: payload.merged_markdown, ops: payload.ops };
  } catch {
    // Maintain is best-effort: without it the regeneration still lands as a
    // plain replacement (no ops recorded).
    return { contentMarkdown: fresh, ops: null };
  }
}
