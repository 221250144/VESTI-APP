import { describe, expect, it } from "vitest";
import {
  aggregateRoundtable,
  buildModeratorTranscript,
  buildRoundtableRecordMarkdown,
  buildSeatTranscript,
  parseRoundtableSynthesis,
  resolveRoundtablePersonas,
  ROUNDTABLE_PERSONAS,
  roundtablePersonaName,
} from "./roundtable";
import type { RoundtablePersonaId, RoundtableSeatTurn } from "../db/types";

const skeptic = ROUNDTABLE_PERSONAS.find((p) => p.id === "skeptic")!;
const optimist = ROUNDTABLE_PERSONAS.find((p) => p.id === "optimist")!;

function turn(personaId: RoundtablePersonaId, content: string, ok = true): RoundtableSeatTurn {
  return ok
    ? { personaId, content, ok: true, durationMs: 10 }
    : { personaId, content: "", ok: false, error: "boom", durationMs: 10 };
}

describe("resolveRoundtablePersonas", () => {
  it("preserves selection order, dedupes and drops unknown ids", () => {
    const personas = resolveRoundtablePersonas([
      "pragmatist",
      "skeptic",
      "pragmatist",
      "no-such-persona" as RoundtablePersonaId,
    ]);
    expect(personas.map((p) => p.id)).toEqual(["pragmatist", "skeptic"]);
  });

  it("returns an empty array for an empty selection", () => {
    expect(resolveRoundtablePersonas([])).toEqual([]);
  });
});

describe("roundtablePersonaName", () => {
  it("localizes preset names and falls back to the raw id", () => {
    expect(roundtablePersonaName("skeptic", "zh")).toBe("怀疑者");
    expect(roundtablePersonaName("skeptic", "en")).toBe("Skeptic");
    expect(roundtablePersonaName("moderator", "zh")).toBe("moderator");
  });
});

describe("buildSeatTranscript", () => {
  it("packs the persona setup, topic and grounding context (zh)", () => {
    const transcript = buildSeatTranscript({
      persona: skeptic,
      question: "要不要迁移到微服务？",
      context: "[会话 1] 架构讨论\n摘要：单体遇到瓶颈",
      lang: "zh",
    });
    expect(transcript).toContain(skeptic.systemPromptZh);
    expect(transcript).toContain("圆桌话题：要不要迁移到微服务？");
    expect(transcript).toContain("背景资料");
    expect(transcript).toContain("[会话 1] 架构讨论");
    expect(transcript).toContain("3-5 段");
  });

  it("omits the context block when there is no recall, and localizes (en)", () => {
    const transcript = buildSeatTranscript({
      persona: optimist,
      question: "Ship v2 now?",
      context: "  ",
      lang: "en",
    });
    expect(transcript).toContain(optimist.systemPromptEn);
    expect(transcript).toContain("Roundtable topic: Ship v2 now?");
    expect(transcript).not.toContain("Background");
  });
});

describe("buildModeratorTranscript", () => {
  it("lists every seat turn under its localized name with the JSON contract", () => {
    const transcript = buildModeratorTranscript(
      "要不要重写前端？",
      [
        { personaId: "skeptic", content: "重写风险极大。" },
        { personaId: "optimist", content: "重写能带来新机会。" },
      ],
      "",
      "zh",
    );
    expect(transcript).toContain("圆桌话题：要不要重写前端？");
    expect(transcript).toContain("【怀疑者】\n重写风险极大。");
    expect(transcript).toContain("【乐观者】\n重写能带来新机会。");
    expect(transcript).toContain('"consensus"');
    expect(transcript).toContain('"open_questions"');
  });

  it("uses English persona names in en mode", () => {
    const transcript = buildModeratorTranscript(
      "Rewrite?",
      [{ personaId: "devils_advocate", content: "Never rewrite." }],
      undefined,
      "en",
    );
    expect(transcript).toContain("【Devil's Advocate】\nNever rewrite.");
  });
});

describe("parseRoundtableSynthesis", () => {
  it("parses clean JSON output", () => {
    const parsed = parseRoundtableSynthesis(
      JSON.stringify({
        consensus: ["都认同要分阶段"],
        disagreements: ["时间表分歧"],
        recommendation: "先试点再推广。",
        open_questions: ["预算多少？"],
      }),
    );
    expect(parsed).toEqual({
      consensus: ["都认同要分阶段"],
      disagreements: ["时间表分歧"],
      recommendation: "先试点再推广。",
      openQuestions: ["预算多少？"],
    });
  });

  it("tolerates code fences and surrounding prose", () => {
    const parsed = parseRoundtableSynthesis(
      '好的，汇总如下：\n```json\n{"consensus": ["a"], "recommendation": "r"}\n```\n以上。',
    );
    expect(parsed?.consensus).toEqual(["a"]);
    expect(parsed?.recommendation).toBe("r");
    expect(parsed?.disagreements).toEqual([]);
    expect(parsed?.openQuestions).toEqual([]);
  });

  it("returns null for garbage and for an all-empty payload", () => {
    expect(parseRoundtableSynthesis("not json at all")).toBeNull();
    expect(parseRoundtableSynthesis('{"consensus": [], "recommendation": ""}')).toBeNull();
  });

  it("caps lists and ignores non-string entries", () => {
    const parsed = parseRoundtableSynthesis(
      JSON.stringify({
        consensus: Array.from({ length: 12 }, (_, i) => `c${i}`).concat([42 as unknown as string]),
        recommendation: 7,
      }),
    );
    expect(parsed?.consensus).toHaveLength(8);
    expect(parsed?.recommendation).toBe("");
  });
});

describe("aggregateRoundtable", () => {
  it("assembles the result and parses the synthesis, keeping the raw text", () => {
    const raw = '{"consensus": ["x"], "recommendation": "y"}';
    const result = aggregateRoundtable({
      question: "q",
      lang: "zh",
      grounded: true,
      seatTurns: [turn("skeptic", "发言")],
      synthesisRaw: raw,
      sources: [],
      totalDurationMs: 123,
    });
    expect(result.synthesis?.consensus).toEqual(["x"]);
    expect(result.synthesisRaw).toBe(raw);
    expect(result.totalDurationMs).toBe(123);
  });

  it("keeps synthesisRaw verbatim when the moderator output is unusable", () => {
    const result = aggregateRoundtable({
      question: "q",
      lang: "en",
      grounded: false,
      seatTurns: [],
      synthesisRaw: "The panel could not agree on structure.",
      sources: [],
      totalDurationMs: 1,
    });
    expect(result.synthesis).toBeNull();
    expect(result.synthesisRaw).toBe("The panel could not agree on structure.");
  });
});

describe("buildRoundtableRecordMarkdown", () => {
  it("archives seats and the structured synthesis in zh", () => {
    const result = aggregateRoundtable({
      question: "q",
      lang: "zh",
      grounded: true,
      seatTurns: [turn("skeptic", "我反对。"), turn("optimist", "我支持。"), turn("pragmatist", "", false)],
      synthesisRaw: '{"consensus": ["要试点"], "recommendation": "先小规模试。"}',
      sources: [],
      totalDurationMs: 1,
    });
    const markdown = buildRoundtableRecordMarkdown(result);
    expect(markdown).toContain("## 圆桌发言");
    expect(markdown).toContain("**怀疑者**\n\n我反对。");
    expect(markdown).toContain("**乐观者**\n\n我支持。");
    expect(markdown).toContain("**实用主义者**（发言失败）");
    expect(markdown).toContain("## 主持人汇总");
    expect(markdown).toContain("**共识**\n\n- 要试点");
    expect(markdown).toContain("**建议**\n\n先小规模试。");
  });

  it("falls back to the raw synthesis text when parsing failed (en)", () => {
    const result = aggregateRoundtable({
      question: "q",
      lang: "en",
      grounded: false,
      seatTurns: [turn("skeptic", "No.")],
      synthesisRaw: "free-form synthesis",
      sources: [],
      totalDurationMs: 1,
    });
    const markdown = buildRoundtableRecordMarkdown(result);
    expect(markdown).toContain("## Panel");
    expect(markdown).toContain("## Moderator's synthesis\n\nfree-form synthesis");
  });
});
