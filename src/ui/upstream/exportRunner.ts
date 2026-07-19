// P3 upstream export: shared sequential batch runner used by the Obsidian,
// Notion, and Markdown-directory batch exports. Sequential on purpose — vault
// writes are cheap but Notion is rate-limited, and a single code path keeps
// progress/failure reporting consistent.

export interface BatchExportProgress {
  done: number;
  total: number;
  failed: number;
  currentTitle: string;
}

export interface BatchExportFailure {
  id: number;
  title: string;
  error: string;
}

export interface BatchExportResult {
  succeeded: number;
  failed: BatchExportFailure[];
}

export async function runBatchExport(
  items: Array<{ id: number; title: string }>,
  exportOne: (item: { id: number; title: string }) => Promise<void>,
  onProgress?: (progress: BatchExportProgress) => void,
): Promise<BatchExportResult> {
  const failed: BatchExportFailure[] = [];
  let succeeded = 0;
  for (const [index, item] of items.entries()) {
    onProgress?.({
      done: index,
      total: items.length,
      failed: failed.length,
      currentTitle: item.title,
    });
    try {
      await exportOne(item);
      succeeded += 1;
    } catch (error) {
      failed.push({
        id: item.id,
        title: item.title,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  onProgress?.({
    done: items.length,
    total: items.length,
    failed: failed.length,
    currentTitle: "",
  });
  return { succeeded, failed };
}
