// "学习 Learn" — reframes the captured KB as a personal curriculum, computed 100%
// locally (no LLM, no new extraction) from data VESTI already stores: topics
// (domains), per-conversation summary signals (key_insights → glossary;
// unresolved_threads → open loops; depth_level → depth mix). Mirrors computeAiti:
// pure + locale-agnostic; the host applies localized labels.
//
// V2 (2026-07): user corrections parameter allows manual glossary edits, domain
// reassignment hints, and open-loop management that survive recomputation.

import type { Conversation, SummaryRecord, Topic } from "../db/types";
import type {
  LearnProfile,
  LearnDomain,
  LearnGlossaryEntry,
  LearnOpenLoop,
} from "@vesti/ui";

const MIN_LEARN_SAMPLE = 3;
const MAX_GLOSSARY = 24;
const MAX_OPEN_LOOPS = 14;
/** Representative conversations surfaced per domain (evidence-chain jumps). */
const MAX_DOMAIN_REPS = 3;
const DAY_MS = 86_400_000;

type Depth = "superficial" | "moderate" | "deep";

// ---- User Corrections (V2) --------------------------------------------------

export interface LearnCorrection {
  type: 'glossary_add' | 'glossary_edit' | 'glossary_remove' | 'open_loop_dismiss';
  term?: string;
  definition?: string;
  /** Domain name targeted for reassignment. */
  domain?: string;
  /** Text of an open loop to dismiss. */
  loopText?: string;
  timestamp?: number;
}

/** Apply user corrections to the glossary after automatic extraction. */
function applyGlossaryCorrections(
  glossary: LearnGlossaryEntry[],
  corrections: LearnCorrection[],
): LearnGlossaryEntry[] {
  const removeKeys = new Set(
    corrections
      .filter(c => c.type === 'glossary_remove' && c.term)
      .map(c => c.term!.toLowerCase())
  );
  // Start with auto-extracted entries, minus user-removed ones.
  let filtered = glossary.filter(g => !removeKeys.has(g.term.toLowerCase()));

  // Apply edits: user-edited definitions replace auto-extracted ones.
  const edits = new Map(
    corrections
      .filter(c => c.type === 'glossary_edit' && c.term && c.definition)
      .map(c => [c.term!.toLowerCase(), c.definition!])
  );
  filtered = filtered.map(g => {
    const edit = edits.get(g.term.toLowerCase());
    return edit ? { ...g, definition: edit } : g;
  });

  // Prepend user-added entries at the top.
  const adds = corrections
    .filter(c => c.type === 'glossary_add' && c.term)
    .map(c => ({
      term: c.term!,
      definition: c.definition ?? '',
    }));
  return [...adds, ...filtered].slice(0, MAX_GLOSSARY);
}

/** Remove user-dismissed loops from the open-loops list. */
function applyOpenLoopCorrections(
  loops: LearnOpenLoop[],
  corrections: LearnCorrection[],
): LearnOpenLoop[] {
  const dismissKeys = new Set(
    corrections
      .filter(c => c.type === 'open_loop_dismiss' && c.loopText)
      .map(c => c.loopText!.toLowerCase())
  );
  return loops.filter(l => !dismissKeys.has(l.text.toLowerCase()));
}

/** Ranking weight for "how representative is this conversation": a deep dive
 * beats a superficial skim; unsummarized conversations rank last. */
const DEPTH_RANK: Record<Depth, number> = { deep: 3, moderate: 2, superficial: 1 };

// ---- V2: Domain Importance Scoring -----------------------------------------

/** Thresholds for domain compact mode. */
const COMPACT_MAX_COUNT = 2;
const DORMANT_DAYS = 30;
const IMPORTANCE_COUNT_WEIGHT = 0.35;
const IMPORTANCE_RECENCY_WEIGHT = 0.25;
const IMPORTANCE_DEPTH_WEIGHT = 0.20;
const IMPORTANCE_OPEN_WEIGHT = 0.20;

/**
 * V2: score a domain's importance (0-1). Key domains are large, active,
 * deep, and have open questions. Minor/dormant domains score low and
 * render in compact mode.
 */
function scoreDomainImportance(e: {
  count: number;
  deep: number;
  moderate: number;
  superficial: number;
  recent30: number;
  openQuestion: { text: string } | null;
}): number {
  const total = e.deep + e.moderate + e.superficial;
  const depthRatio = total > 0 ? (e.deep * 1.0 + e.moderate * 0.5) / total : 0;
  const recencyRatio = e.count > 0 ? Math.min(1, e.recent30 / Math.max(e.count, 1)) : 0;
  const countScore = Math.min(1, e.count / 10); // 10+ conversations → full score
  const openScore = e.openQuestion ? 1 : 0;
  return (
    IMPORTANCE_COUNT_WEIGHT * countScore +
    IMPORTANCE_RECENCY_WEIGHT * recencyRatio +
    IMPORTANCE_DEPTH_WEIGHT * depthRatio +
    IMPORTANCE_OPEN_WEIGHT * openScore
  );
}

/** V2: decide if a domain should render compact. */
function shouldCompact(e: {
  count: number;
  recent30: number;
  deep: number;
  moderate: number;
  superficial: number;
  topicId: number | null;
}, importanceScore: number): boolean {
  // Uncategorized always compacts (special bucket with no AI actions).
  if (e.topicId === null) return true;
  // Very small: compact.
  if (e.count <= COMPACT_MAX_COUNT) return true;
  // Dormant + low depth: compact.
  const total = e.deep + e.moderate + e.superficial;
  if (e.recent30 === 0 && total <= 2) return true;
  // Low importance score: compact.
  return importanceScore < 0.25;
}

function latestSummaryByConversation(summaries: SummaryRecord[]): Map<number, SummaryRecord> {
  const byConv = new Map<number, SummaryRecord>();
  for (const rec of summaries) {
    if (typeof rec.conversationId !== "number") continue;
    const prev = byConv.get(rec.conversationId);
    if (!prev || (rec.createdAt ?? 0) > (prev.createdAt ?? 0)) byConv.set(rec.conversationId, rec);
  }
  return byConv;
}

function depthOf(rec: SummaryRecord | undefined): Depth | null {
  const meta = rec && (rec.structured as unknown as Record<string, unknown> | null | undefined)?.["meta_observations"];
  const level = meta && typeof (meta as { depth_level?: unknown }).depth_level === "string"
    ? (meta as { depth_level: string }).depth_level
    : null;
  return level === "superficial" || level === "moderate" || level === "deep" ? level : null;
}

/** First unresolved thread of a conversation's latest summary (same length
 * filter as the global open-loops section), or null. */
function firstUnresolvedThread(rec: SummaryRecord | undefined): string | null {
  const s = rec && (rec.structured as unknown as Record<string, unknown> | null | undefined);
  const threads = s && Array.isArray(s.unresolved_threads) ? (s.unresolved_threads as unknown[]) : [];
  for (const t of threads) {
    if (typeof t !== "string") continue;
    const text = t.trim();
    if (text.length >= 4) return text;
  }
  return null;
}

export function computeLearn(
  summaries: SummaryRecord[],
  topics: Topic[],
  conversations: Conversation[],
  now = Date.now(),
  corrections?: LearnCorrection[],
): LearnProfile {
  const summaryByConv = latestSummaryByConversation(summaries);
  const liveConvs = conversations.filter((c) => !c.is_archived && !c.is_trash);

  // ---- Domains: group conversations by topic, with a depth mix ----
  const topicName = new Map<number, string>();
  for (const t of topics) if (typeof t.id === "number") topicName.set(t.id, t.name);

  const domainAgg = new Map<
    string,
    {
      topicId: number | null;
      name: string;
      count: number;
      deep: number;
      moderate: number;
      superficial: number;
      recent7: number;
      recent30: number;
      lastActiveAt: number;
      openQuestion: { text: string; conversationId: number; at: number } | null;
      reps: Array<{ id: number; title: string; rank: number; updatedAt: number }>;
    }
  >();
  for (const conv of liveConvs) {
    if (typeof conv.id !== "number") continue;
    const topicId = typeof conv.topic_id === "number" ? conv.topic_id : null;
    const key = topicId === null ? "null" : String(topicId);
    let entry = domainAgg.get(key);
    if (!entry) {
      entry = {
        topicId,
        name: topicId !== null ? topicName.get(topicId) ?? "" : "",
        count: 0,
        deep: 0,
        moderate: 0,
        superficial: 0,
        recent7: 0,
        recent30: 0,
        lastActiveAt: 0,
        openQuestion: null,
        reps: [],
      };
      domainAgg.set(key, entry);
    }
    entry.count += 1;
    const updatedAt = conv.updated_at ?? 0;
    if (now - updatedAt <= 7 * DAY_MS) entry.recent7 += 1;
    if (now - updatedAt <= 30 * DAY_MS) entry.recent30 += 1;
    if (updatedAt > entry.lastActiveAt) entry.lastActiveAt = updatedAt;
    const rec = summaryByConv.get(conv.id);
    const d = depthOf(rec);
    if (d) entry[d] += 1;
    // The domain's "next step": the unresolved thread left by its most
    // recently active conversation — one concrete question to follow up on.
    const unresolved = firstUnresolvedThread(rec);
    if (unresolved && (!entry.openQuestion || updatedAt > entry.openQuestion.at)) {
      entry.openQuestion = { text: unresolved, conversationId: conv.id, at: updatedAt };
    }
    entry.reps.push({
      id: conv.id,
      title: conv.title,
      rank: d ? DEPTH_RANK[d] : 0,
      updatedAt,
    });
  }
  const domains: LearnDomain[] = Array.from(domainAgg.values())
    .map((e) => {
      const importanceScore = scoreDomainImportance(e);
      return {
        topicId: e.topicId,
        name: e.name,
        count: e.count,
        deep: e.deep,
        moderate: e.moderate,
        superficial: e.superficial,
        recent7: e.recent7,
        recent30: e.recent30,
        lastActiveAt: e.lastActiveAt,
        ...(e.openQuestion
          ? { openQuestion: { text: e.openQuestion.text, conversationId: e.openQuestion.conversationId } }
          : {}),
        representatives: e.reps
          .sort((a, b) => b.rank - a.rank || b.updatedAt - a.updatedAt)
          .slice(0, MAX_DOMAIN_REPS)
          .map((r) => ({ conversationId: r.id, title: r.title })),
        importanceScore,
        compact: shouldCompact(e, importanceScore),
      };
    })
    // Sort: key (high-importance, named) domains first, then compact/dormant,
    // then uncategorized last.
    .sort((a, b) => {
      // Uncategorized always last.
      if (a.topicId === null && b.topicId !== null) return 1;
      if (b.topicId === null && a.topicId !== null) return -1;
      // Compact domains after expanded ones.
      if (a.compact && !b.compact) return 1;
      if (b.compact && !a.compact) return -1;
      // Within same class: by importanceScore descending, then count.
      return (b.importanceScore ?? 0) - (a.importanceScore ?? 0) || b.count - a.count;
    });

  // ---- Glossary: key_insights terms across summaries (deduped + ranked) ----
  // Rank by how often a term recurs (then recency) so the most-studied terms
  // survive the MAX_GLOSSARY cap — taking the arbitrary first-N in storage order
  // would drop high-value terms.
  type GlossaryAgg = LearnGlossaryEntry & { count: number; recencyAt: number };
  const glossaryMap = new Map<string, GlossaryAgg>();
  for (const rec of summaryByConv.values()) {
    const s = rec.structured as unknown as Record<string, unknown> | null | undefined;
    const insights = s && Array.isArray(s.key_insights) ? (s.key_insights as unknown[]) : [];
    const recencyAt = rec.createdAt ?? 0;
    for (const ki of insights) {
      let term = "";
      let def = "";
      if (typeof ki === "string") term = ki;
      else if (ki && typeof ki === "object") {
        term = typeof (ki as { term?: unknown }).term === "string" ? (ki as { term: string }).term : "";
        def = typeof (ki as { definition?: unknown }).definition === "string" ? (ki as { definition: string }).definition : "";
      }
      term = term.trim();
      if (term.length < 2 || term.length > 60) continue;
      const key = term.toLowerCase();
      const existing = glossaryMap.get(key);
      if (existing) {
        existing.count += 1;
        if (!existing.definition && def.trim()) existing.definition = def.trim();
        if (recencyAt > existing.recencyAt) existing.recencyAt = recencyAt;
      } else {
        glossaryMap.set(key, {
          term,
          definition: def.trim(),
          conversationId: rec.conversationId,
          count: 1,
          recencyAt,
        });
      }
    }
  }
  const glossary: LearnGlossaryEntry[] = Array.from(glossaryMap.values())
    .sort((a, b) => b.count - a.count || b.recencyAt - a.recencyAt)
    .slice(0, MAX_GLOSSARY)
    .map((entry) => ({
      term: entry.term,
      definition: entry.definition,
      conversationId: entry.conversationId,
    }));

  // ---- Open loops: unresolved_threads with their source conversation ----
  const openLoops: LearnOpenLoop[] = [];
  const seenLoops = new Set<string>();
  for (const rec of summaryByConv.values()) {
    const s = rec.structured as unknown as Record<string, unknown> | null | undefined;
    const threads = s && Array.isArray(s.unresolved_threads) ? (s.unresolved_threads as unknown[]) : [];
    for (const t of threads) {
      if (typeof t !== "string") continue;
      const text = t.trim();
      if (text.length < 4) continue;
      const key = text.toLowerCase();
      if (seenLoops.has(key)) continue;
      seenLoops.add(key);
      openLoops.push({ text, conversationId: rec.conversationId });
      if (openLoops.length >= MAX_OPEN_LOOPS) break;
    }
    if (openLoops.length >= MAX_OPEN_LOOPS) break;
  }

  const sampleSize = summaryByConv.size;
  const available = liveConvs.length >= MIN_LEARN_SAMPLE && (domains.length > 0 || glossary.length > 0);

  // V2: apply user corrections to glossary and open loops.
  const effectiveGlossary = corrections && corrections.length > 0
    ? applyGlossaryCorrections(glossary, corrections)
    : glossary;
  const effectiveLoops = corrections && corrections.length > 0
    ? applyOpenLoopCorrections(openLoops, corrections)
    : openLoops;

  return { available, sampleSize, domains, glossary: effectiveGlossary, openLoops: effectiveLoops };
}
