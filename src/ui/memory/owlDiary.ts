// 猫头鹰日记 (Owl diary): the warm third-person narrative written at the end of
// each dream run, stored as the kind:'dream-log' journal entry. The diary is
// generated at the source (generation end): the dream pipeline calls the
// 'companion' agent kind — the owl listener persona — with the run's outcome
// as the transcript and OWL_DIARY_QUESTION steering it into diary form. When
// the LLM call fails or returns unusable output, a deterministic warm template
// (buildOwlDiaryFallback) guarantees a diary is still written. Historical
// journals are never rewritten — only new runs produce the new style.
//
// Why the 'companion' kind: the agent-kind registry lives in the main process
// and cannot grow from the renderer, and the owl persona is exactly the voice
// the diary needs. Its parse() yields `${mood}\n${body}`; parseOwlDiaryBody
// strips that first line (and tolerates a raw `[mood:x]` tag when the main
// parse never ran, e.g. in tests).

import type { MemoryEntryView } from "../../shared/contracts";

export interface OwlDiaryInput {
  /** Local day the run belongs to (YYYY-MM-DD). */
  today: string;
  firstFull: boolean;
  sessionsProcessed: number;
  gatedSessions: number;
  cappedBatches: number;
  counts: { added: number; updated: number; deleted: number; noop: number };
  addedEntries: MemoryEntryView[];
  updatedEntries: MemoryEntryView[];
}

/** The longest a diary body may be before it is trimmed (LLM runaway guard). */
export const OWL_DIARY_MAX_CHARS = 800;

const OWL_MOODS = ["calm", "thinking", "delighted", "spark", "sleepy", "warm"] as const;

/**
 * Steers the owl listener persona into diary form. Passed as the companion
 * kind's `question` slot, so it lands after the transcript as the immediate
 * instruction; the persona supplies the warmth, this supplies the shape.
 */
export const OWL_DIARY_QUESTION = [
  "（现在不是对话时间——请不要对我说话，写一段猫头鹰日记。)",
  "你是栖在 Vesti 里的猫头鹰。根据上面这次梦境整理的结果，用第三人称写一段 3-5 句的日记：",
  "以「今天用户……」开头，挑一两件具体的事（标题或主题）轻轻带过，语气温柔、克制，不罗列统计数字，不分点、不用标题、不用 emoji；",
  "结尾用一句「它悄悄记下了……」式的话收住。若这次整理没有新变化，就写平静的一夜。",
  "第一行仍输出情绪标签 [mood:xxx]，从第二行开始是日记正文。",
].join("");

function firstSentence(text: string): string {
  const match = /^[^。！？!?.]*[。！？!?]/.exec(text.trim());
  return match ? match[0] : text.trim();
}

/**
 * The transcriptOverride fed to the companion kind: a compact factual brief of
 * the run (counts + new/updated memory titles) the owl can weave a diary from.
 * Titles only — memory bodies stay out of the diary prompt.
 */
export function buildOwlDiaryContext(input: OwlDiaryInput): string {
  const lines: string[] = [
    `【本次梦境整理 · ${input.today}】`,
    `整理了 ${input.sessionsProcessed} 个会话${input.firstFull ? "（首次全量整理）" : ""}；` +
      `新增记忆 ${input.counts.added} 条，更新 ${input.counts.updated} 条，删除 ${input.counts.deleted} 条。`,
  ];
  if (input.addedEntries.length > 0) {
    lines.push(
      `新记住的事：${input.addedEntries
        .slice(0, 6)
        .map((entry) => `「${entry.title}」`)
        .join("、")}`,
    );
  }
  if (input.updatedEntries.length > 0) {
    lines.push(
      `更新的记忆：${input.updatedEntries
        .slice(0, 4)
        .map((entry) => `「${entry.title}」`)
        .join("、")}`,
    );
  }
  return lines.join("\n");
}

/**
 * Extract the diary body from a companion-kind result. Handles both the
 * main-process parsed shape (`warm\n正文`) and the raw model shape
 * (`[mood:warm]\n正文`); without any tag line the whole text is the body.
 * Returns null for empty or JSON-looking output (a confused model answering
 * the maintain shape) so the caller falls back to the template.
 */
export function parseOwlDiaryBody(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const lines = trimmed.replace(/\r\n/g, "\n").split("\n");
  const first = lines[0]?.trim() ?? "";
  const tagged = /^[\[【]\s*mood\s*:\s*([A-Za-z]+)\s*[\]】]$/i.exec(first);
  const bare = (OWL_MOODS as readonly string[]).includes(first.toLowerCase());
  const body = (tagged || bare ? lines.slice(1).join("\n") : lines.join("\n")).trim();
  if (!body || body.startsWith("{") || body.startsWith("[")) return null;
  return body.length > OWL_DIARY_MAX_CHARS ? `${body.slice(0, OWL_DIARY_MAX_CHARS - 1)}…` : body;
}

/**
 * Deterministic warm diary used when the LLM diary is unavailable (gateway
 * down, unusable output). Mirrors the LLM diary's voice: third person, gentle,
 * ends with the owl quietly remembering.
 */
export function buildOwlDiaryFallback(input: OwlDiaryInput): string {
  const lead =
    input.addedEntries.find((entry) => entry.tags.includes("event")) ??
    input.addedEntries[0] ??
    input.updatedEntries[0] ??
    null;
  const sentences: string[] = [];
  if (lead) {
    sentences.push(`今天用户的世界里，「${lead.title}」又清晰了一些。`);
  } else {
    sentences.push("今天用户与 AI 又度过了忙碌的一天。");
  }
  const touched = input.counts.added + input.counts.updated + input.counts.deleted;
  if (touched > 0) {
    sentences.push(
      `夜里，猫头鹰整理了 ${input.sessionsProcessed} 段对话，新记下 ${input.counts.added} 件事` +
        `${input.counts.updated > 0 ? `，更新 ${input.counts.updated} 条记忆` : ""}` +
        `${input.counts.deleted > 0 ? `，放下 ${input.counts.deleted} 件过时的` : ""}。`,
    );
  } else {
    sentences.push(
      `夜里，猫头鹰翻看了 ${input.sessionsProcessed} 段对话，记忆都很妥帖，没有需要改动的地方。`,
    );
  }
  sentences.push("它悄悄记下了这一天的认真。");
  return sentences.join("");
}

/** Journal-card one-liner: the diary's first sentence. */
export function owlDiarySummary(diaryBody: string): string {
  return firstSentence(diaryBody).slice(0, 120);
}
