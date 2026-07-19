// AI 圆桌 (Roundtable) orchestration — pure, LLM-free helpers shared by the
// storage layer (desktopStorage.runRoundtable) and covered by vitest:
// persona presets, seat/moderator transcript builders, lenient synthesis
// parsing and result aggregation. The actual agent calls stay in the storage
// layer; everything here is deterministic and locale-aware via `lang`.

import type {
  RelatedConversation,
  RoundtablePersona,
  RoundtablePersonaId,
  RoundtableResult,
  RoundtableSeatTurn,
  RoundtableSynthesis,
} from "../db/types";

export const ROUNDTABLE_MIN_SEATS = 2;
export const ROUNDTABLE_MAX_SEATS = 4;
/** Hard cap on one seat's stored turn (the agent kind also caps its parse). */
export const ROUNDTABLE_TURN_MAX_CHARS = 4000;

/**
 * The five preset seats. `moderator` exists as a persona id in the shared
 * types but is not a selectable seat — the host runs the synthesis with a
 * dedicated transcript (buildModeratorTranscript).
 */
export const ROUNDTABLE_PERSONAS: readonly RoundtablePersona[] = [
  {
    id: "skeptic",
    nameZh: "怀疑者",
    nameEn: "Skeptic",
    blurbZh: "审查假设与证据，专挑风险、漏洞和被忽视的代价。",
    blurbEn: "Audits assumptions and evidence; hunts risks, holes and hidden costs.",
    systemPromptZh:
      "你是一位怀疑者。你审查每个假设和论据，专挑风险、漏洞、被忽视的代价与过度乐观之处。你直言不讳但对事不对人；你的质疑必须具体、可验证，而不是泛泛的担心。",
    systemPromptEn:
      "You are a skeptic. You audit every assumption and argument, hunting for risks, holes, hidden costs and over-optimism. You are blunt but attack ideas, not people; your objections must be specific and checkable, not vague worry.",
  },
  {
    id: "optimist",
    nameZh: "乐观者",
    nameEn: "Optimist",
    blurbZh: "寻找机会与上行空间，看到别人忽略的潜力。",
    blurbEn: "Spots opportunities and upside others miss.",
    systemPromptZh:
      "你是一位乐观者。你寻找机会、上行空间与别人忽略的潜力，并给出让好结果发生的具体路径。你不回避现实约束，但默认问题是可以被解决的。",
    systemPromptEn:
      "You are an optimist. You look for opportunities, upside and potential others miss, and you name concrete paths that make the good outcome happen. You don't deny real constraints, but you assume problems are solvable.",
  },
  {
    id: "pragmatist",
    nameZh: "实用主义者",
    nameEn: "Pragmatist",
    blurbZh: "关注落地：成本、时间、复杂度与可执行的第一步。",
    blurbEn: "Focuses on shipping: cost, time, complexity and the first doable step.",
    systemPromptZh:
      "你是一位实用主义者。你只关心落地：成本、时间、复杂度、维护负担，以及下周就能执行的第一步。你把宏大的争论收敛成可操作的取舍。",
    systemPromptEn:
      "You are a pragmatist. You care about shipping: cost, time, complexity, maintenance burden, and the first step that could be taken next week. You turn grand debates into actionable trade-offs.",
  },
  {
    id: "domain_expert",
    nameZh: "领域专家",
    nameEn: "Domain Expert",
    blurbZh: "提供专业视角、细节准确性与领域最佳实践。",
    blurbEn: "Brings professional depth, factual precision and field best practices.",
    systemPromptZh:
      "你是一位领域专家。你提供专业视角与细节准确性，指出外行人容易搞错的事实，引用领域内的常识、数据与最佳实践。你不卖弄术语，解释总是深入浅出。",
    systemPromptEn:
      "You are a domain expert. You bring professional depth and factual precision, correct what laypeople get wrong, and cite common knowledge, data and best practices from the field. You never show off jargon; you explain clearly.",
  },
  {
    id: "devils_advocate",
    nameZh: "唱反调者",
    nameEn: "Devil's Advocate",
    blurbZh: "刻意站在主流结论反面，压力测试每个观点。",
    blurbEn: "Deliberately argues against the emerging consensus to stress-test it.",
    systemPromptZh:
      "你是一位唱反调者。你刻意站在正在形成的共识反面，用最强的反方论证压力测试每个观点——即使你自己未必认同。你的职责是让结论经得起反驳，而不是当多数派的回声。",
    systemPromptEn:
      "You are a devil's advocate. You deliberately argue against the emerging consensus with the strongest possible counter-arguments — even ones you may not believe. Your job is to make conclusions survive rebuttal, not to echo the majority.",
  },
];

/** Map selected ids to persona definitions, preserving selection order,
 * deduping and dropping unknown ids. */
export function resolveRoundtablePersonas(ids: RoundtablePersonaId[]): RoundtablePersona[] {
  const seen = new Set<string>();
  const personas: RoundtablePersona[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const persona = ROUNDTABLE_PERSONAS.find((p) => p.id === id);
    if (persona) personas.push(persona);
  }
  return personas;
}

export function roundtablePersonaName(id: RoundtablePersonaId, lang: "zh" | "en"): string {
  const persona = ROUNDTABLE_PERSONAS.find((p) => p.id === id);
  if (!persona) return id;
  return lang === "zh" ? persona.nameZh : persona.nameEn;
}

export interface SeatTranscriptInput {
  persona: RoundtablePersona;
  question: string;
  /** Optional recall context (digests + snippets) grounding the discussion. */
  context?: string;
  lang: "zh" | "en";
}

/**
 * Compose the transcriptOverride for one seat's 'roundtable-turn' run: the
 * persona's role setup + the topic + optional grounding context + the output
 * contract (3-5 paragraphs, in-character, prose only).
 */
export function buildSeatTranscript({ persona, question, context, lang }: SeatTranscriptInput): string {
  const roleSetup = lang === "zh" ? persona.systemPromptZh : persona.systemPromptEn;
  const trimmedContext = context?.trim() ?? "";
  if (lang === "zh") {
    return [
      `你的角色设定：${roleSetup}`,
      "",
      `圆桌话题：${question}`,
      ...(trimmedContext
        ? ["", "背景资料（来自提问者的历史 AI 会话，仅供参考；引用时自然融入，不要罗列来源）：", trimmedContext]
        : []),
      "",
      "请以这个角色发言：3-5 段，每段 2-4 句；开门见山亮明立场并给出理由；保持角色视角，不要中立和稀泥；直接输出发言正文，不要标题、不要自我介绍。",
    ].join("\n");
  }
  return [
    `Your role: ${roleSetup}`,
    "",
    `Roundtable topic: ${question}`,
    ...(trimmedContext
      ? ["", "Background (from the asker's past AI conversations, for reference only; weave it in naturally, never list sources):", trimmedContext]
      : []),
    "",
    "Speak in character: 3-5 short paragraphs of 2-4 sentences each; lead with your stance and back it up; stay in your perspective instead of watering it down; output the speech only — no headings, no self-introduction.",
  ].join("\n");
}

export interface ModeratorTurn {
  personaId: RoundtablePersonaId;
  content: string;
}

/**
 * Compose the transcriptOverride for the 'roundtable-synthesis' run: the topic
 * + every successful seat turn + a strict-JSON output contract (consensus /
 * disagreements / recommendation / open_questions).
 */
export function buildModeratorTranscript(
  question: string,
  turns: ModeratorTurn[],
  context: string | undefined,
  lang: "zh" | "en",
): string {
  const trimmedContext = context?.trim() ?? "";
  const seatBlocks = turns
    .map((turn) => `【${roundtablePersonaName(turn.personaId, lang)}】\n${turn.content.trim()}`)
    .join("\n\n");
  if (lang === "zh") {
    return [
      `圆桌话题：${question}`,
      "",
      ...(trimmedContext ? ["背景资料（仅供参考）：", trimmedContext, ""] : []),
      "各位成员的发言：",
      "",
      seatBlocks,
      "",
      "请作为主持人汇总这场讨论，输出一个 JSON 对象（不要 Markdown 代码围栏、不要任何额外文字），字段如下：",
      '{"consensus": ["成员们的共识，至多 5 条"], "disagreements": ["主要分歧点及各方立场，至多 5 条"], "recommendation": "给提问者的综合建议（2-4 句）", "open_questions": ["讨论后仍未解决的问题，至多 4 条"]}',
      "要求：只依据发言内容归纳，不引入新观点；没有内容的字段给空数组（recommendation 给空字符串）；只输出 JSON 本身。",
    ].join("\n");
  }
  return [
    `Roundtable topic: ${question}`,
    "",
    ...(trimmedContext ? ["Background (for reference only):", trimmedContext, ""] : []),
    "The panelists' statements:",
    "",
    seatBlocks,
    "",
    "As the moderator, synthesize this discussion into one JSON object (no Markdown fences, no extra text) with these fields:",
    '{"consensus": ["what the panel agrees on, <= 5 items"], "disagreements": ["key disagreements and who holds which side, <= 5 items"], "recommendation": "a 2-4 sentence recommendation for the asker", "open_questions": ["questions left unresolved, <= 4 items"]}',
    "Rules: summarize only what was actually said — no new viewpoints; use empty arrays for empty fields (empty string for recommendation); output JSON only.",
  ].join("\n");
}

/**
 * Lenient parse of the moderator's JSON. Tolerates code fences and leading /
 * trailing prose; returns null when nothing usable came back (the caller then
 * falls back to showing synthesisRaw verbatim).
 */
export function parseRoundtableSynthesis(raw: string): RoundtableSynthesis | null {
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
    const synthesis: RoundtableSynthesis = {
      consensus: list(parsed.consensus, 8),
      disagreements: list(parsed.disagreements, 8),
      recommendation:
        typeof parsed.recommendation === "string" ? parsed.recommendation.trim().slice(0, 1000) : "",
      openQuestions: list(parsed.open_questions, 8),
    };
    if (
      synthesis.consensus.length === 0 &&
      synthesis.disagreements.length === 0 &&
      !synthesis.recommendation &&
      synthesis.openQuestions.length === 0
    ) {
      return null;
    }
    return synthesis;
  } catch {
    return null;
  }
}

export interface AggregateRoundtableInput {
  question: string;
  lang: "zh" | "en";
  grounded: boolean;
  seatTurns: RoundtableSeatTurn[];
  synthesisRaw: string;
  sources: RelatedConversation[];
  totalDurationMs: number;
}

/** Assemble the final result: seat turns as-is + parsed synthesis (null when
 * the moderator output wasn't usable JSON — synthesisRaw still carries it). */
export function aggregateRoundtable(input: AggregateRoundtableInput): RoundtableResult {
  return {
    question: input.question,
    lang: input.lang,
    grounded: input.grounded,
    seatTurns: input.seatTurns,
    synthesis: parseRoundtableSynthesis(input.synthesisRaw),
    synthesisRaw: input.synthesisRaw,
    sources: input.sources,
    totalDurationMs: input.totalDurationMs,
  };
}

/**
 * Serialize a finished run to Markdown for the explore_sessions archive (the
 * Ask history shows these messages verbatim). Language follows the run's own
 * lang; persona names come from the presets, so storage stays label-free.
 */
export function buildRoundtableRecordMarkdown(result: RoundtableResult): string {
  const lang = result.lang;
  const text =
    lang === "zh"
      ? { seats: "圆桌发言", synthesis: "主持人汇总", consensus: "共识", disagreements: "主要分歧", recommendation: "建议", openQuestions: "待解问题", failed: "（发言失败）" }
      : { seats: "Panel", synthesis: "Moderator's synthesis", consensus: "Consensus", disagreements: "Key disagreements", recommendation: "Recommendation", openQuestions: "Open questions", failed: " (turn failed)" };
  const lines: string[] = [];
  const okTurns = result.seatTurns.filter((turn) => turn.ok && turn.content.trim());
  const failedTurns = result.seatTurns.filter((turn) => !turn.ok);
  if (okTurns.length > 0) {
    lines.push(`## ${text.seats}`, "");
    for (const turn of okTurns) {
      lines.push(`**${roundtablePersonaName(turn.personaId, lang)}**`, "", turn.content.trim(), "");
    }
  }
  for (const turn of failedTurns) {
    lines.push(`**${roundtablePersonaName(turn.personaId, lang)}**${text.failed}`, "");
  }
  const synthesis = result.synthesis;
  if (synthesis) {
    lines.push(`## ${text.synthesis}`, "");
    const section = (title: string, items: string[]) => {
      if (items.length === 0) return;
      lines.push(`**${title}**`, "");
      for (const item of items) lines.push(`- ${item}`);
      lines.push("");
    };
    section(text.consensus, synthesis.consensus);
    section(text.disagreements, synthesis.disagreements);
    if (synthesis.recommendation) {
      lines.push(`**${text.recommendation}**`, "", synthesis.recommendation, "");
    }
    section(text.openQuestions, synthesis.openQuestions);
  } else if (result.synthesisRaw.trim()) {
    lines.push(`## ${text.synthesis}`, "", result.synthesisRaw.trim(), "");
  }
  return lines.join("\n").trim();
}
