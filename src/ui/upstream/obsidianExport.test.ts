import { describe, expect, it } from "vitest";
import { computeUpstreamExportStats, isPendingObsidianExport } from "./obsidianExport";

describe("isPendingObsidianExport", () => {
  it("is pending only when untrashed, never exported, and not failed", () => {
    expect(isPendingObsidianExport({})).toBe(true);
    expect(isPendingObsidianExport({ is_trash: true })).toBe(false);
    expect(isPendingObsidianExport({ exported_obsidian_at: 123 })).toBe(false);
    expect(isPendingObsidianExport({ obsidian_export_error: "disk full" })).toBe(false);
    expect(isPendingObsidianExport({ obsidian_export_error: null })).toBe(true);
  });
});

describe("computeUpstreamExportStats", () => {
  it("counts exported/failed/pending per target and tracks recency", () => {
    const stats = computeUpstreamExportStats([
      { exported_obsidian_at: 100, exported_notion_at: 200 },
      { exported_obsidian_at: 300 },
      { obsidian_export_error: "写入被拒" },
      {},
      { is_trash: true },
      { notion_export_error: "HTTP 401" },
    ]);
    expect(stats.obsidian.exported).toBe(2);
    expect(stats.obsidian.lastExportedAt).toBe(300);
    expect(stats.obsidian.failed).toBe(1);
    expect(stats.obsidian.lastError).toBe("写入被拒");
    // untrashed, never exported, no error → pending (the {} row and the
    // notion-error row, which still counts as Obsidian-pending)
    expect(stats.obsidian.pending).toBe(2);
    expect(stats.notion.exported).toBe(1);
    expect(stats.notion.lastExportedAt).toBe(200);
    expect(stats.notion.failed).toBe(1);
    expect(stats.notion.lastError).toBe("HTTP 401");
  });

  it("returns zeros for an empty library", () => {
    expect(computeUpstreamExportStats([])).toEqual({
      obsidian: { exported: 0, failed: 0, pending: 0, lastExportedAt: null, lastError: null },
      notion: { exported: 0, failed: 0, lastExportedAt: null, lastError: null },
    });
  });
});
