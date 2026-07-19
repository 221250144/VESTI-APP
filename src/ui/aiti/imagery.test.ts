import { describe, expect, it } from "vitest";
import type { AitiAxisScore } from "@vesti/ui";
import {
  IMAGERY_TABLE,
  WEAK_BAND_HI,
  WEAK_BAND_LO,
  localizeImagery,
  resolveImagery,
} from "./imagery";

function axes(scores: {
  depth: number;
  maker: number;
  focus: number;
  affect: number;
  noSignal?: string[];
}): AitiAxisScore[] {
  const silent = new Set(scores.noSignal ?? []);
  return (["depth", "maker", "focus", "affect"] as const).map((key) => ({
    key,
    score: scores[key],
    evidenceConversationIds: silent.has(key) ? [] : [1],
    hasSignal: !silent.has(key),
  }));
}

describe("IMAGERY_TABLE integrity", () => {
  it("has exactly 16 entries with unique codes and unique emblem ids", () => {
    expect(IMAGERY_TABLE).toHaveLength(16);
    expect(new Set(IMAGERY_TABLE.map((e) => e.code)).size).toBe(16);
    expect(new Set(IMAGERY_TABLE.map((e) => e.emblemId)).size).toBe(16);
  });

  it("covers every one of the 16 possible type codes", () => {
    const codes = new Set(IMAGERY_TABLE.map((e) => e.code));
    for (const d of ["D", "q"])
      for (const m of ["M", "T"])
        for (const f of ["F", "W"])
          for (const s of ["S", "c"]) {
            expect(codes).toContain(`${d}${m}${f}${s}`);
          }
  });

  it("gives every entry full zh/en copy", () => {
    for (const entry of IMAGERY_TABLE) {
      for (const copy of [entry.name, entry.origin, entry.verdict]) {
        expect(copy.zh.trim()).not.toBe("");
        expect(copy.en.trim()).not.toBe("");
      }
    }
  });
});

describe("resolveImagery type mapping", () => {
  it("maps clear scores to the expected letter code (pole taken at ≥ 50)", () => {
    const cases: Array<[number, number, number, number, string]> = [
      [90, 90, 90, 90, "DMWS"],
      [10, 10, 10, 10, "qTFc"],
      [90, 10, 90, 10, "DTWc"],
      [10, 90, 10, 90, "qMFS"],
      [90, 90, 10, 10, "DMFc"],
    ];
    for (const [d, m, f, s, code] of cases) {
      const resolved = resolveImagery(axes({ depth: d, maker: m, focus: f, affect: s }));
      expect(resolved?.code).toBe(code);
      expect(resolved?.entry.code).toBe(code);
    }
  });

  it("resolves all 16 table entries from matching axis scores", () => {
    for (const entry of IMAGERY_TABLE) {
      const score = (hi: string, lo: string, letter: string) => (letter === hi ? 80 : 20);
      const resolved = resolveImagery(
        axes({
          depth: score("D", "q", entry.code[0]),
          maker: score("M", "T", entry.code[1]),
          focus: score("W", "F", entry.code[2]),
          affect: score("S", "c", entry.code[3]),
        }),
      );
      expect(resolved?.entry.emblemId).toBe(entry.emblemId);
      expect(resolved?.code).toBe(entry.code);
    }
  });

  it("treats score 50 as the high pole and 49 as the low pole", () => {
    expect(
      resolveImagery(axes({ depth: 50, maker: 50, focus: 50, affect: 50 }))?.code,
    ).toBe("DMWS");
    expect(
      resolveImagery(axes({ depth: 49, maker: 49, focus: 49, affect: 49 }))?.code,
    ).toBe("qTFc");
  });

  it("returns null when an axis is missing", () => {
    const partial = axes({ depth: 80, maker: 80, focus: 80, affect: 80 }).slice(0, 3);
    expect(resolveImagery(partial)).toBeNull();
    expect(resolveImagery([])).toBeNull();
  });
});

describe("resolveImagery weak-signal detection", () => {
  it("flags axes whose score sits inside the undecided band [45, 55]", () => {
    const resolved = resolveImagery(axes({ depth: 45, maker: 55, focus: 20, affect: 80 }));
    expect(resolved?.weakAxes).toEqual(["depth", "maker"]);
    expect(resolved?.faint).toBe(true);
  });

  it("keeps scores just outside the band as firm", () => {
    const resolved = resolveImagery(
      axes({
        depth: WEAK_BAND_LO - 1,
        maker: WEAK_BAND_HI + 1,
        focus: WEAK_BAND_LO,
        affect: WEAK_BAND_HI,
      }),
    );
    expect(resolved?.weakAxes).toEqual(["focus", "affect"]);
  });

  it("flags hasSignal=false axes as weak but still takes their pole for the code", () => {
    const resolved = resolveImagery(
      axes({ depth: 80, maker: 20, focus: 80, affect: 80, noSignal: ["affect"] }),
    );
    expect(resolved?.code).toBe("DTWS");
    expect(resolved?.weakAxes).toEqual(["affect"]);
    expect(resolved?.faint).toBe(true);
  });

  it("reports a firm outline when every axis is decided", () => {
    const resolved = resolveImagery(axes({ depth: 90, maker: 10, focus: 90, affect: 10 }));
    expect(resolved?.weakAxes).toEqual([]);
    expect(resolved?.faint).toBe(false);
  });
});

describe("localizeImagery", () => {
  it("projects the entry to localized flat strings", () => {
    const resolved = resolveImagery(axes({ depth: 90, maker: 90, focus: 90, affect: 90 }));
    expect(resolved).not.toBeNull();
    const zh = localizeImagery(resolved!, "zh");
    const en = localizeImagery(resolved!, "en");
    expect(zh.name).toBe("塞壬的挽歌");
    expect(en.name).toBe("Siren's Elegy");
    expect(zh.verdict).toBe(resolved!.entry.verdict.zh);
    expect(en.verdict).toBe(resolved!.entry.verdict.en);
    expect(zh.code).toBe("DMWS");
    expect(zh.emblemId).toBe("siren-elegy");
  });
});
