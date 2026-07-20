// Conversation-library scanner: turn raw user inputs (agent CLI sessions +
// browser conversations) into clustered, frequency-ranked prompt candidates.
//
// Pure logic: callers (storage layer) supply the flattened user inputs; this
// module filters instruction-like turns, de-duplicates exact repeats, merges
// template-similar prompts (same opening / same template with different
// variable fills) and ranks the clusters. No DB, DOM or LLM access here —
// optional LLM naming happens in the caller and only relabels the output.

import { isTrivialPromptText } from "./promptExtractor";
import { guessCategory, scorePrompt, suggestTags } from "./promptHeuristics";
import {
  canonicalizeForHash,
  deriveTitle,
  normalizeWhitespace,
} from "./promptNormalize";

/** One flattened user turn from any captured conversation source. */
export interface PromptScanUserInput {
  /** 'agent' = main-process CLI session; 'browser' = extension-captured chat. */
  origin: "agent" | "browser";
  /** Stable conversation identifier (agent session id / Dexie numeric id). */
  conversationId: string;
  conversationTitle: string;
  text: string;
}

/** A conversation a scanned candidate was seen in (capped per candidate). */
export interface PromptScanSourceRef {
  origin: "agent" | "browser";
  conversationId: string;
  title: string;
}

/** A merged prompt pattern with frequency + provenance, ready for review. */
export interface ScannedPromptCluster {
  /** Stable cluster identity (template key), safe to use as a React key. */
  key: string;
  title: string;
  /** Representative body: the highest-scoring variant in the cluster. */
  body: string;
  /** Total occurrences across every conversation. */
  count: number;
  /** Distinct conversations the pattern appears in. */
  sourceCount: number;
  sources: PromptScanSourceRef[];
  score: number;
  tags: string[];
  category: string | null;
}

export interface ScanPromptsOptions {
  /** Minimum heuristic quality score to keep an input (default 0.15). */
  minScore?: number;
  /** Minimum normalized body length (default 16). */
  minLength?: number;
  /** Result cap, highest-frequency first (default 50). */
  maxResults?: number;
  /** Source refs kept per cluster (default 5). */
  maxSourcesPerCluster?: number;
  /** Shared-opening length used for template merging (default 40). */
  templatePrefixLength?: number;
}

const DEFAULT_MIN_SCORE = 0.15;
const DEFAULT_MIN_LENGTH = 16;
const DEFAULT_MAX_RESULTS = 50;
const DEFAULT_MAX_SOURCES = 5;
const DEFAULT_TEMPLATE_PREFIX = 40;

// Template variables normalize to placeholders so "总结下面的会议记录：{{主题}}"
// and "总结下面的会议记录：{{项目名}}" land in the same cluster.
const CURLY_VARIABLE = /\{\{[^}]{1,60}\}\}/g;
const BRACKET_VARIABLE = /\[[A-Z][A-Z0-9_ ]{1,40}\]/g;

/**
 * Clustering key for template-similar prompts: canonical form with template
 * variables replaced by placeholders, truncated to a shared opening. Two
 * prompts that start the same way (same template / same opening sentence)
 * merge into one cluster; unrelated prompts keep distinct keys.
 */
export function deriveTemplateKey(
  body: string,
  prefixLength: number = DEFAULT_TEMPLATE_PREFIX,
): string {
  const withPlaceholders = normalizeWhitespace(body)
    .replace(CURLY_VARIABLE, "{}")
    .replace(BRACKET_VARIABLE, "[]");
  return canonicalizeForHash(withPlaceholders).slice(0, Math.max(8, prefixLength));
}

interface ExactGroup {
  hash: string;
  representativeBody: string;
  representativeScore: number;
  count: number;
  conversationKeys: Set<string>;
  sources: PromptScanSourceRef[];
}

function conversationKeyOf(input: PromptScanUserInput): string {
  return `${input.origin}:${input.conversationId}`;
}

/**
 * Filter + cluster raw user inputs into ranked prompt candidates.
 *
 * Pass 1 groups exact repeats (canonical body hash) so frequency counts are
 * accurate; pass 2 merges the exact groups by template key (shared opening /
 * same template with different variable fills). Within a conversation each
 * distinct prompt counts once towards the source set, while repeats still
 * raise the total occurrence count.
 */
export function scanUserPromptInputs(
  inputs: PromptScanUserInput[],
  options: ScanPromptsOptions = {},
): ScannedPromptCluster[] {
  const minScore = options.minScore ?? DEFAULT_MIN_SCORE;
  const minLength = options.minLength ?? DEFAULT_MIN_LENGTH;
  const maxResults = Math.max(1, options.maxResults ?? DEFAULT_MAX_RESULTS);
  const maxSources = Math.max(1, options.maxSourcesPerCluster ?? DEFAULT_MAX_SOURCES);
  const prefixLength = options.templatePrefixLength ?? DEFAULT_TEMPLATE_PREFIX;

  // ---- Pass 1: exact repeats ----
  const exactGroups = new Map<string, ExactGroup>();
  for (const input of inputs) {
    const body = normalizeWhitespace(input.text ?? "");
    if (body.length < minLength || isTrivialPromptText(body)) continue;
    const score = scorePrompt(body);
    if (score < minScore) continue;

    const hash = canonicalizeForHash(body);
    const conversationKey = conversationKeyOf(input);
    let group = exactGroups.get(hash);
    if (!group) {
      group = {
        hash,
        representativeBody: body,
        representativeScore: score,
        count: 0,
        conversationKeys: new Set<string>(),
        sources: [],
      };
      exactGroups.set(hash, group);
    }
    group.count += 1;
    if (!group.conversationKeys.has(conversationKey)) {
      group.conversationKeys.add(conversationKey);
      if (group.sources.length < maxSources) {
        group.sources.push({
          origin: input.origin,
          conversationId: input.conversationId,
          title: input.conversationTitle,
        });
      }
    }
    if (score > group.representativeScore) {
      group.representativeBody = body;
      group.representativeScore = score;
    }
  }

  // ---- Pass 2: merge template-similar exact groups ----
  interface MutableCluster {
    key: string;
    groups: ExactGroup[];
    count: number;
    conversationKeys: Set<string>;
    sources: PromptScanSourceRef[];
  }
  const clusters = new Map<string, MutableCluster>();
  for (const group of exactGroups.values()) {
    const key = deriveTemplateKey(group.representativeBody, prefixLength);
    let cluster = clusters.get(key);
    if (!cluster) {
      cluster = { key, groups: [], count: 0, conversationKeys: new Set<string>(), sources: [] };
      clusters.set(key, cluster);
    }
    cluster.groups.push(group);
    cluster.count += group.count;
    for (const conversationKey of group.conversationKeys) {
      cluster.conversationKeys.add(conversationKey);
    }
    for (const source of group.sources) {
      if (cluster.sources.length >= maxSources) break;
      if (
        cluster.sources.some(
          (existing) =>
            existing.origin === source.origin && existing.conversationId === source.conversationId,
        )
      ) {
        continue;
      }
      cluster.sources.push(source);
    }
  }

  // ---- Finalize + rank ----
  const result: ScannedPromptCluster[] = [];
  for (const cluster of clusters.values()) {
    // Representative: the most recurring exact variant, score as tie-break.
    const representative = [...cluster.groups].sort(
      (a, b) => b.count - a.count || b.representativeScore - a.representativeScore,
    )[0];
    const body = representative.representativeBody;
    result.push({
      key: cluster.key,
      title: deriveTitle(body, 48),
      body,
      count: cluster.count,
      sourceCount: cluster.conversationKeys.size,
      sources: cluster.sources,
      score: representative.representativeScore,
      tags: suggestTags(body),
      category: guessCategory(body),
    });
  }

  result.sort(
    (a, b) => b.sourceCount - a.sourceCount || b.count - a.count || b.score - a.score,
  );
  return result.slice(0, maxResults);
}
