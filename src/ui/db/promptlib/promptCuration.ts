// Curated selection for the auto-built 常用提示词 library: pick the genuinely
// reusable clusters out of a conversation-library scan. Pure logic — no DB,
// no LLM — so the extraction pipeline stays fully testable.
//
// Gates are deliberately REACHABLE: the previous bars (>= 4 conversations AND
// score >= 0.62, zero floor) almost never cleared on a real library, so
// extraction deterministically returned 0 rows and looked broken. Recurrence
// across 2+ conversations now earns a slot at a moderate quality bar, and a
// small top-up of high-quality one-offs keeps the library useful while it is
// still young.

import type { ScannedPromptCluster } from "./promptScanner";

export interface PromptCurationOptions {
  /** Minimum distinct conversations a pattern must recur in (default 2). */
  minConversations?: number;
  /** Quality bar for recurring patterns (default 0.5). */
  qualityGate?: number;
  /** Hard cap on selected clusters (default 6) — a handful, not a hoard. */
  maxResults?: number;
  /** Minimum selection size the one-off top-up aims for (default 3). */
  floorCount?: number;
  /** Quality bar for one-off (single-conversation) top-up picks (default 0.6). */
  singletonQualityGate?: number;
  /** Cap on one-off top-up picks (default 6). */
  maxSingletonTopUp?: number;
}

const DEFAULT_MIN_CONVERSATIONS = 2;
const DEFAULT_QUALITY_GATE = 0.5;
const DEFAULT_MAX_RESULTS = 6;
const DEFAULT_FLOOR_COUNT = 3;
const DEFAULT_SINGLETON_QUALITY_GATE = 0.6;
const DEFAULT_MAX_SINGLETON_TOPUP = 6;

/** Frequency and quality weighted equally; recurrence normalized over 6. */
function combinedCurationScore(cluster: ScannedPromptCluster): number {
  const freqNorm = Math.min(1, cluster.sourceCount / 6);
  return cluster.score * 0.5 + freqNorm * 0.5;
}

const byCurationScore = (a: ScannedPromptCluster, b: ScannedPromptCluster) =>
  combinedCurationScore(b) - combinedCurationScore(a);

/**
 * Select the clusters worth archiving as 常用提示词. Primary picks recur
 * across conversations and clear the quality gate; when too few recur, the
 * best one-off patterns top the selection up to the floor so the library
 * still produces something on sparse/new data. Empty input → empty output.
 */
export function selectClustersForExtraction(
  clusters: ScannedPromptCluster[],
  options: PromptCurationOptions = {},
): ScannedPromptCluster[] {
  const minConversations = Math.max(1, options.minConversations ?? DEFAULT_MIN_CONVERSATIONS);
  const qualityGate = options.qualityGate ?? DEFAULT_QUALITY_GATE;
  const maxResults = Math.max(1, options.maxResults ?? DEFAULT_MAX_RESULTS);
  const floorCount = Math.max(0, options.floorCount ?? DEFAULT_FLOOR_COUNT);
  const singletonGate = options.singletonQualityGate ?? DEFAULT_SINGLETON_QUALITY_GATE;
  const maxTopUp = Math.max(0, options.maxSingletonTopUp ?? DEFAULT_MAX_SINGLETON_TOPUP);

  const frequent = clusters
    .filter((cluster) => cluster.sourceCount >= minConversations && cluster.score >= qualityGate)
    .sort(byCurationScore);

  const selected = frequent.slice(0, maxResults);

  if (selected.length < floorCount && maxTopUp > 0) {
    const selectedKeys = new Set(selected.map((cluster) => cluster.key));
    const topUp = clusters
      .filter((cluster) => !selectedKeys.has(cluster.key) && cluster.score >= singletonGate)
      .sort(byCurationScore)
      .slice(0, Math.min(maxTopUp, floorCount - selected.length, maxResults - selected.length));
    selected.push(...topUp);
  }

  return selected;
}
