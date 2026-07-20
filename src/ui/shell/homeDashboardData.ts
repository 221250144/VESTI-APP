import type { Overview, UsageBreakdown } from "../../shared/contracts";

export interface RankedUsage extends UsageBreakdown {
  id: string;
  totalTokens: number;
}

export interface DailyUsagePoint {
  date: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export function rankUsage(
  breakdown: Record<string, UsageBreakdown>,
): RankedUsage[] {
  return Object.entries(breakdown)
    .map(([id, usage]) => ({
      id,
      conversations: usage.conversations,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.inputTokens + usage.outputTokens,
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens || b.conversations - a.conversations);
}

function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function fillDailyUsage(
  rows: Overview["analytics"]["dailyTokenUsage"],
  days = 30,
  now = new Date(),
): DailyUsagePoint[] {
  const byDate = new Map(rows.map((row) => [row.date, row]));
  const output: DailyUsagePoint[] = [];
  const safeDays = Math.max(1, Math.min(90, Math.floor(days)));

  for (let offset = safeDays - 1; offset >= 0; offset -= 1) {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset);
    const key = localDateKey(date);
    const row = byDate.get(key);
    const inputTokens = row?.inputTokens ?? 0;
    const outputTokens = row?.outputTokens ?? 0;
    output.push({
      date: key,
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
    });
  }

  return output;
}

export function basename(filePath: string): string {
  const normalized = filePath.replace(/[\\/]+$/, "");
  const parts = normalized.split(/[\\/]/);
  return parts[parts.length - 1] || filePath;
}
