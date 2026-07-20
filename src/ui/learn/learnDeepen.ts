// AI 深化 (Learn deep-dive) — pure, LLM-free helpers shared by the storage
// layer (desktopStorage.runLearnDeepen) and covered by vitest: the recall
// context assembler, the 'learn-deepen' transcript builder, the lenient
// analysis parse and the explore_sessions record markdown. Mirrors the
// roundtable module's conventions (src/ui/roundtable): the actual agent call
// stays in the storage layer; everything here is deterministic and
// locale-aware via `lang`.

import type {
  LearnDeepenAnalysis,
  LearnDeepenResult,
  LearnDomain,
  RelatedConversation,
} from "@vesti/ui";

/** Cap on one stored deep-dive output (the agent kind also caps its parse). */
export const LEARN_DEEPEN_MAX_CHARS = 4000;

/** Minimal shape of a cross-session recall hit the context assembler needs —
 * structural, so the storage layer passes its SessionRecallHit rows in
 * without a mapping step. */
export interface LearnRecallHit {
  title: string;
  oneLiner?: string | null;
  snippet?: string | null;
}

/**
 * Assemble the grounding context block from recall hits — the same shape the
 * Ask and roundtable runs use: "[会话 i] title" + optional digest + hit
 * snippet, blank-line separated. Empty input yields an empty string (the
 * transcript then omits the background block entirely).
 */
export function buildLearnRecallContext(hits: LearnRecallHit[]): string {
  return hits
    .map((hit, index) => {
      const lines = [`[会话 ${index + 1}] ${hit.title}`];
      if (hit.oneLiner) lines.push(`摘要：${hit.oneLiner}`);
      if (hit.snippet) lines.push(`命中片段：${hit.snippet}`);
      return lines.join("\n");
    })
    .join("\n\n");
}

export interface LearnDeepenTranscriptInput {
  domain: LearnDomain;
  /** Optional recall context (digests + snippets) grounding the analysis. */
  context?: string;
  lang: "zh" | "en";
}

/**
 * Compose the transcriptOverride for the 'learn-deepen' run: the domain's
 * local stats (depth mix + representative titles, straight from computeLearn)
 * + optional recall context + a strict-JSON output contract (mastered /
 * blind_spots / path). The renderer validates the JSON shape
 * (parseLearnDeepen) and falls back to the raw text.
 */
export function buildLearnDeepenTranscript({
  domain,
  context,
  lang,
}: LearnDeepenTranscriptInput): string {
  const trimmedContext = context?.trim() ?? "";
  const representatives = domain.representatives
    .map((rep) => rep.title.trim())
    .filter(Boolean);
  if (lang === "zh") {
    return [
      `学习领域：${domain.name}`,
      "",
      `本地统计：该领域共 ${domain.count} 段对话；其中深入 ${domain.deep} 段、适中 ${domain.moderate} 段、浅层 ${domain.superficial} 段。`,
      ...(representatives.length > 0
        ? ["", "最能代表该领域的几段对话：", ...representatives.map((title) => `- ${title}`)]
        : []),
      ...(trimmedContext
        ? ["", "背景资料（来自学习者的历史 AI 会话，仅供参考；引用时自然融入，不要罗列来源）：", trimmedContext]
        : []),
      "",
      "请分析学习者在这个领域的学习脉络，输出一个 JSON 对象（不要 Markdown 代码围栏、不要任何额外文字），字段如下：",
      '{"mastered": ["当前已经掌握的要点，至多 5 条"], "blind_spots": ["理解盲区或尚未触及的关键问题，至多 5 条"], "path": ["建议的下一步学习路径，按先后顺序，至多 5 步"]}',
      "要求：依据本地统计与背景资料做分析，不编造资料中没有的具体事实；没有内容的字段给空数组；只输出 JSON 本身。",
    ].join("\n");
  }
  return [
    `Learning domain: ${domain.name}`,
    "",
    `Local stats: ${domain.count} conversations in this domain — ${domain.deep} deep, ${domain.moderate} moderate, ${domain.superficial} superficial.`,
    ...(representatives.length > 0
      ? ["", "The conversations that best represent this domain:", ...representatives.map((title) => `- ${title}`)]
      : []),
    ...(trimmedContext
      ? ["", "Background (from the learner's past AI conversations, for reference only; weave it in naturally, never list sources):", trimmedContext]
      : []),
    "",
    "Analyze the learner's trajectory in this domain and output one JSON object (no Markdown fences, no extra text) with these fields:",
    '{"mastered": ["what the learner already has a grip on, <= 5 items"], "blind_spots": ["gaps and key questions not yet touched, <= 5 items"], "path": ["suggested next steps, in order, <= 5 items"]}',
    "Rules: base the analysis on the local stats and the background — invent no concrete facts beyond them; use empty arrays for empty fields; output JSON only.",
  ].join("\n");
}

/**
 * Lenient parse of the model's JSON. Tolerates code fences and leading /
 * trailing prose; returns null when nothing usable came back (the caller then
 * falls back to showing the raw output verbatim).
 */
export function parseLearnDeepen(raw: string): LearnDeepenAnalysis | null {
  try {
    const cleaned = raw
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "")
      .trim();
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start === -1 || end <= start) return null;
    const parsed = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const list = (value: unknown, maxItems: number): string[] =>
      Array.isArray(value)
        ? value
            .filter((item): item is string => typeof item === "string")
            .map((item) => item.trim())
            .filter(Boolean)
            .slice(0, maxItems)
        : [];
    const analysis: LearnDeepenAnalysis = {
      mastered: list(parsed.mastered, 8),
      blindSpots: list(parsed.blind_spots, 8),
      path: list(parsed.path, 8),
    };
    if (
      analysis.mastered.length === 0 &&
      analysis.blindSpots.length === 0 &&
      analysis.path.length === 0
    ) {
      return null;
    }
    return analysis;
  } catch {
    return null;
  }
}

export interface AggregateLearnDeepenInput {
  domain: string;
  lang: "zh" | "en";
  grounded: boolean;
  raw: string;
  sources: RelatedConversation[];
  durationMs: number;
}

/** Assemble the final result: parsed analysis (null when the model output
 * wasn't usable JSON — `raw` still carries it). */
export function aggregateLearnDeepen(input: AggregateLearnDeepenInput): LearnDeepenResult {
  return {
    domain: input.domain,
    lang: input.lang,
    grounded: input.grounded,
    analysis: parseLearnDeepen(input.raw),
    raw: input.raw,
    sources: input.sources,
    durationMs: input.durationMs,
  };
}

/**
 * Serialize a finished deep-dive to Markdown for the explore_sessions archive
 * (the Ask history shows these messages verbatim). Language follows the run's
 * own lang.
 */
export function buildLearnDeepenRecordMarkdown(result: LearnDeepenResult): string {
  const lang = result.lang;
  const text =
    lang === "zh"
      ? { title: "学习脉络分析", mastered: "当前掌握点", blindSpots: "理解盲区", path: "建议学习路径" }
      : { title: "Learning trajectory", mastered: "Mastered", blindSpots: "Blind spots", path: "Suggested path" };
  const lines: string[] = [`## ${text.title}：${result.domain}`, ""];
  const analysis = result.analysis;
  if (analysis) {
    const section = (title: string, items: string[]) => {
      if (items.length === 0) return;
      lines.push(`**${title}**`, "");
      for (const item of items) lines.push(`- ${item}`);
      lines.push("");
    };
    section(text.mastered, analysis.mastered);
    section(text.blindSpots, analysis.blindSpots);
    section(text.path, analysis.path);
  } else if (result.raw.trim()) {
    lines.push(result.raw.trim(), "");
  }
  return lines.join("\n").trim();
}
