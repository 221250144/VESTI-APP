// Summary coverage for the AITI imagery gate: how many live conversations
// already have a summary, how many have a *structured* one (the only kind
// computeAiti can aggregate), and which conversations are still waiting for
// one. Pure + locale-agnostic — the host feeds raw Dexie records, the UI
// renders localized copy from the result.

import type { SummaryCoverage } from "../types";

/** AITI imagery needs at least this many structured summaries. */
export const AITI_MIN_STRUCTURED_SUMMARIES = 5;

export interface SummaryCoverageConversation {
  id?: number;
  is_archived?: boolean;
  is_trash?: boolean;
  /** ms epoch; used to order the pending queue newest-first. */
  updatedAt?: number;
  /** local-terminal capture id; conversations without one cannot be
   * summarized through the desktop agent channel. */
  cliId?: string | null;
}

export interface SummaryCoverageSummary {
  conversationId?: number;
  createdAt?: number;
  structured?: unknown;
}

function hasStructured(summary: SummaryCoverageSummary | undefined): boolean {
  return Boolean(summary && summary.structured && typeof summary.structured === "object");
}

export function computeSummaryCoverage(
  conversations: readonly SummaryCoverageConversation[],
  summaries: readonly SummaryCoverageSummary[]
): SummaryCoverage {
  const live = conversations.filter(
    (conversation) =>
      typeof conversation.id === "number" &&
      !conversation.is_archived &&
      !conversation.is_trash
  );

  // Latest summary per conversation wins — mirrors computeAiti's dedupe.
  const latestByConversation = new Map<number, SummaryCoverageSummary>();
  for (const summary of summaries) {
    if (typeof summary.conversationId !== "number") continue;
    const previous = latestByConversation.get(summary.conversationId);
    if (!previous || (summary.createdAt ?? 0) > (previous.createdAt ?? 0)) {
      latestByConversation.set(summary.conversationId, summary);
    }
  }

  let summarizedCount = 0;
  let structuredCount = 0;
  const pendingConversationIds: number[] = [];
  for (const conversation of live) {
    const latest = latestByConversation.get(conversation.id as number);
    if (latest) summarizedCount += 1;
    if (hasStructured(latest)) {
      structuredCount += 1;
      continue;
    }
    // Only conversations reachable through the local capture store can be
    // summarized; the rest would just fail the agent run.
    if (typeof conversation.cliId === "string" && conversation.cliId.trim()) {
      pendingConversationIds.push(conversation.id as number);
    }
  }

  // Newest first: recent conversations carry the most relevant signal, so a
  // capped batch spends its budget where it matters most.
  const updatedAtById = new Map(
    live.map((conversation) => [conversation.id as number, conversation.updatedAt ?? 0])
  );
  pendingConversationIds.sort(
    (a, b) => (updatedAtById.get(b) ?? 0) - (updatedAtById.get(a) ?? 0)
  );

  return {
    totalConversations: live.length,
    summarizedCount,
    structuredCount,
    pendingConversationIds,
  };
}
