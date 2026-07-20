// Batch summary generation queue (AITI "立即生成摘要"): a capped, strictly
// sequential (concurrency 1) run over the pending conversation ids. The
// runner loop lives in the host; these pure helpers own the planning and the
// progress bookkeeping so both stay testable.

/** Upper bound of one batch run — a run is 20 sequential LLM calls at most. */
export const SUMMARY_BATCH_LIMIT = 20;

export interface SummaryBatchProgress {
  total: number;
  done: number;
  failed: number;
}

/** Slice the pending queue down to one run's worth of work. */
export function planSummaryBatch(
  pendingConversationIds: readonly number[],
  limit: number = SUMMARY_BATCH_LIMIT
): number[] {
  if (limit <= 0) return [];
  return pendingConversationIds.slice(0, limit);
}

export function createSummaryBatchProgress(total: number): SummaryBatchProgress {
  return { total, done: 0, failed: 0 };
}

/** Record one finished item; `done` counts successes only. */
export function advanceSummaryBatch(
  progress: SummaryBatchProgress,
  outcome: "ok" | "failed"
): SummaryBatchProgress {
  return {
    total: progress.total,
    done: progress.done + (outcome === "ok" ? 1 : 0),
    failed: progress.failed + (outcome === "failed" ? 1 : 0),
  };
}

/** Processed = successes + failures; the loop ends when this reaches total
 * (or the host cancels). */
export function isSummaryBatchComplete(progress: SummaryBatchProgress): boolean {
  return progress.done + progress.failed >= progress.total;
}
