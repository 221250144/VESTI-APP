import { describe, expect, it } from "vitest";
import {
  AITI_MIN_STRUCTURED_SUMMARIES,
  computeSummaryCoverage,
  type SummaryCoverageConversation,
  type SummaryCoverageSummary,
} from "./summaryCoverage";
import {
  SUMMARY_BATCH_LIMIT,
  advanceSummaryBatch,
  createSummaryBatchProgress,
  isSummaryBatchComplete,
  planSummaryBatch,
} from "./summaryBatch";

function conv(
  id: number,
  overrides: Partial<SummaryCoverageConversation> = {}
): SummaryCoverageConversation {
  return { id, is_archived: false, is_trash: false, updatedAt: id * 100, cliId: `cli-${id}`, ...overrides };
}

function summary(
  conversationId: number,
  createdAt: number,
  structured: unknown = null
): SummaryCoverageSummary {
  return { conversationId, createdAt, structured };
}

describe("computeSummaryCoverage", () => {
  it("counts summarized and structured conversations over live ones only", () => {
    const coverage = computeSummaryCoverage(
      [
        conv(1),
        conv(2),
        conv(3),
        conv(4, { is_archived: true }),
        conv(5, { is_trash: true }),
      ],
      [
        summary(1, 10, { core_question: "q" }),
        summary(2, 10),
        summary(4, 10, { core_question: "q" }), // archived — excluded from totals
      ]
    );
    expect(coverage.totalConversations).toBe(3);
    expect(coverage.summarizedCount).toBe(2);
    expect(coverage.structuredCount).toBe(1);
  });

  it("keeps only the latest summary per conversation when judging structured", () => {
    const coverage = computeSummaryCoverage(
      [conv(1), conv(2)],
      [
        summary(1, 10, { core_question: "q" }),
        summary(1, 20), // newer but unstructured → no longer structured
        summary(2, 10),
        summary(2, 20, { core_question: "q" }),
      ]
    );
    expect(coverage.structuredCount).toBe(1);
    expect(coverage.pendingConversationIds).toEqual([1]);
  });

  it("queues only conversations with a cli id, newest first", () => {
    const coverage = computeSummaryCoverage(
      [
        conv(1, { updatedAt: 100 }),
        conv(2, { updatedAt: 300 }),
        conv(3, { updatedAt: 200, cliId: null }),
        conv(4, { updatedAt: 400, cliId: "  " }),
      ],
      []
    );
    expect(coverage.pendingConversationIds).toEqual([2, 1]);
  });

  it("excludes structured conversations from the pending queue", () => {
    const coverage = computeSummaryCoverage(
      [conv(1), conv(2)],
      [summary(2, 10, { core_question: "q" })]
    );
    expect(coverage.pendingConversationIds).toEqual([1]);
  });

  it("reports an empty library honestly", () => {
    const coverage = computeSummaryCoverage([], []);
    expect(coverage).toEqual({
      totalConversations: 0,
      summarizedCount: 0,
      structuredCount: 0,
      pendingConversationIds: [],
    });
  });

  it("exposes the AITI gate threshold", () => {
    expect(AITI_MIN_STRUCTURED_SUMMARIES).toBe(5);
  });
});

describe("summary batch queue", () => {
  it("caps a run at the batch limit", () => {
    const ids = Array.from({ length: 30 }, (_, index) => index + 1);
    expect(planSummaryBatch(ids)).toHaveLength(SUMMARY_BATCH_LIMIT);
    expect(planSummaryBatch(ids)).toEqual(ids.slice(0, SUMMARY_BATCH_LIMIT));
  });

  it("keeps everything when fewer than the limit", () => {
    expect(planSummaryBatch([3, 1, 2])).toEqual([3, 1, 2]);
  });

  it("honors a custom limit and rejects non-positive limits", () => {
    expect(planSummaryBatch([1, 2, 3], 2)).toEqual([1, 2]);
    expect(planSummaryBatch([1, 2, 3], 0)).toEqual([]);
  });

  it("tracks successes and failures separately and detects completion", () => {
    let progress = createSummaryBatchProgress(3);
    expect(isSummaryBatchComplete(progress)).toBe(false);
    progress = advanceSummaryBatch(progress, "ok");
    progress = advanceSummaryBatch(progress, "failed");
    expect(progress).toEqual({ total: 3, done: 1, failed: 1 });
    expect(isSummaryBatchComplete(progress)).toBe(false);
    progress = advanceSummaryBatch(progress, "ok");
    expect(progress).toEqual({ total: 3, done: 2, failed: 1 });
    expect(isSummaryBatchComplete(progress)).toBe(true);
  });
});
