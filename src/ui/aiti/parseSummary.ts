// Structured conversation summary (ConversationSummaryV2) parsing for the
// desktop summary channel. The 'summary' agent answers with strict JSON;
// this module validates + normalizes that JSON so a malformed or chatty
// answer degrades to the plain-text fallback instead of poisoning the
// summaries table. Pure and DOM-free.

import type { ConversationSummaryV2 } from "../db/types";

const MAX_JOURNEY_STEPS = 10;
const MAX_INSIGHTS = 8;
const MAX_THREADS = 6;
const MAX_NEXT_STEPS = 6;
const DEPTH_LEVELS = new Set(["superficial", "moderate", "deep"]);

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asStringList(value: unknown, maxItems: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const text = asString(item);
    if (!text) continue;
    out.push(text);
    if (out.length >= maxItems) break;
  }
  return out;
}

/** Tolerate Markdown code fences / leading prose around the JSON object. */
function extractJsonObject(raw: string): unknown | null {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * Parse the 'summary' agent's raw output into a ConversationSummaryV2.
 * Returns null when the output isn't a usable JSON summary — callers then
 * keep the legacy plain-text fallback write.
 */
export function parseConversationSummaryV2(raw: string): ConversationSummaryV2 | null {
  const value = extractJsonObject(raw);
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;

  const coreQuestion = asString(row.core_question);
  if (!coreQuestion) return null;

  const journey: ConversationSummaryV2["thinking_journey"] = [];
  if (Array.isArray(row.thinking_journey)) {
    for (const item of row.thinking_journey) {
      if (!item || typeof item !== "object") continue;
      const entry = item as Record<string, unknown>;
      const assertion = asString(entry.assertion);
      if (!assertion) continue;
      const anchor = asString(entry.real_world_anchor);
      journey.push({
        step: journey.length + 1,
        speaker: entry.speaker === "AI" ? "AI" : "User",
        assertion,
        real_world_anchor: anchor || null,
      });
      if (journey.length >= MAX_JOURNEY_STEPS) break;
    }
  }

  const insights: ConversationSummaryV2["key_insights"] = [];
  if (Array.isArray(row.key_insights)) {
    for (const item of row.key_insights) {
      if (!item || typeof item !== "object") continue;
      const entry = item as Record<string, unknown>;
      const term = asString(entry.term);
      const definition = asString(entry.definition);
      if (!term || !definition) continue;
      insights.push({ term, definition });
      if (insights.length >= MAX_INSIGHTS) break;
    }
  }

  const metaRaw =
    row.meta_observations && typeof row.meta_observations === "object"
      ? (row.meta_observations as Record<string, unknown>)
      : {};
  const depthRaw = asString(metaRaw.depth_level);

  return {
    core_question: coreQuestion,
    thinking_journey: journey,
    key_insights: insights,
    unresolved_threads: asStringList(row.unresolved_threads, MAX_THREADS),
    meta_observations: {
      thinking_style: asString(metaRaw.thinking_style),
      emotional_tone: asString(metaRaw.emotional_tone),
      depth_level: DEPTH_LEVELS.has(depthRaw)
        ? (depthRaw as ConversationSummaryV2["meta_observations"]["depth_level"])
        : "moderate",
    },
    actionable_next_steps: asStringList(row.actionable_next_steps, MAX_NEXT_STEPS),
  };
}

/** Plain-text rendering stored in SummaryRecord.content — the column the
 * relay/digest pipelines quote as LLM context. Fixed zh scaffolding matches
 * the agent layer's primary output language. */
export function renderSummaryPlainText(summary: ConversationSummaryV2): string {
  const sections: string[] = [`核心问题：${summary.core_question}`];
  if (summary.key_insights.length > 0) {
    sections.push(
      ["关键结论：", ...summary.key_insights.map((item) => `- ${item.term}：${item.definition}`)].join("\n")
    );
  }
  if (summary.unresolved_threads.length > 0) {
    sections.push(["未解决的问题：", ...summary.unresolved_threads.map((item) => `- ${item}`)].join("\n"));
  }
  if (summary.actionable_next_steps.length > 0) {
    sections.push(["下一步建议：", ...summary.actionable_next_steps.map((item) => `- ${item}`)].join("\n"));
  }
  return sections.join("\n\n");
}
