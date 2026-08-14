import { describe, expect, it } from "vitest";
import {
  EMOTION_FAMILIES,
  EMOTION_FAMILY_LABELS,
  getEmotionColor,
  getEmotionFamily,
} from "./emotionColors";

describe("getEmotionFamily", () => {
  it("buckets English keywords into all seven families", () => {
    expect(getEmotionFamily("A calm and peaceful evening")).toBe("calm");
    expect(getEmotionFamily("deeply thoughtful and curious")).toBe("thinking");
    expect(getEmotionFamily("happy and joyful")).toBe("delighted");
    expect(getEmotionFamily("a sudden spark of insight")).toBe("spark");
    expect(getEmotionFamily("sad and heartbroken")).toBe("grief");
    expect(getEmotionFamily("anxious and exhausted")).toBe("strained");
    expect(getEmotionFamily("warm and grateful")).toBe("warm");
  });

  it("buckets Chinese keywords into all seven families", () => {
    expect(getEmotionFamily("心情平静安宁")).toBe("calm");
    expect(getEmotionFamily("陷入沉思与思考")).toBe("thinking");
    expect(getEmotionFamily("非常开心快乐")).toBe("delighted");
    expect(getEmotionFamily("突然有了灵感和顿悟")).toBe("spark");
    expect(getEmotionFamily("孤独又伤感")).toBe("grief");
    expect(getEmotionFamily("感到焦虑不安")).toBe("strained");
    expect(getEmotionFamily("温暖治愈的对话")).toBe("warm");
  });

  it("covers achievement / relief / insight vocabulary", () => {
    expect(getEmotionFamily("终于跑通了,成就感满满")).toBe("delighted");
    expect(getEmotionFamily("a proud, satisfying result")).toBe("delighted");
    expect(getEmotionFamily("被理解之后释然了")).toBe("warm");
    expect(getEmotionFamily("relieved and supported")).toBe("warm");
    expect(getEmotionFamily("恍然大悟,原来如此")).toBe("spark");
  });

  it("covers grief / heartbreak vocabulary (breakup conversations must color)", () => {
    expect(getEmotionFamily("悲伤")).toBe("grief");
    expect(getEmotionFamily("整体氛围伤感又忧郁")).toBe("grief");
    expect(getEmotionFamily("用户在倾诉心碎的经历,倍感孤独")).toBe("grief");
    expect(getEmotionFamily("深夜 emo")).toBe("grief");
    expect(getEmotionFamily("a melancholic, heartbroken reflection")).toBe("grief");
    expect(getEmotionFamily("grief and sorrow after the breakup")).toBe("grief");
    expect(getEmotionFamily("feeling lonely and dejected")).toBe("grief");
  });

  it("covers strained vocabulary: anxiety, frustration, fatigue, stuckness", () => {
    expect(getEmotionFamily("焦虑")).toBe("strained");
    expect(getEmotionFamily("debug 一晚上,挫败又烦躁")).toBe("strained");
    expect(getEmotionFamily("需求反复变,压力好大快崩溃了")).toBe("strained");
    expect(getEmotionFamily("迷茫,有点困惑,无从下手")).toBe("strained");
    expect(getEmotionFamily("疲惫")).toBe("strained");
    expect(getEmotionFamily("anxious about the deadline")).toBe("strained");
    expect(getEmotionFamily("frustrated and stuck on this bug")).toBe("strained");
    expect(getEmotionFamily("burned out and overwhelmed")).toBe("strained");
  });

  it("separates grief from strained (sadness is not fatigue)", () => {
    expect(getEmotionFamily("悲伤")).toBe("grief");
    expect(getEmotionFamily("疲惫")).toBe("strained");
    expect(getEmotionFamily("沮丧")).toBe("strained");
    expect(getEmotionFamily("失落")).toBe("grief");
  });

  it("is case-insensitive for latin keywords", () => {
    expect(getEmotionFamily("EXCITED")).toBe("delighted");
    expect(getEmotionFamily("Calm")).toBe("calm");
    expect(getEmotionFamily("GrAtEfUl")).toBe("warm");
  });

  it("uses word boundaries so substrings do not false-match", () => {
    // "low" is a strained keyword but must not hit inside "follow" / "below".
    expect(getEmotionFamily("follow the instructions below")).toBeNull();
    // "down" must not hit inside "shutdown".
    expect(getEmotionFamily("shutdown sequence complete")).toBeNull();
    // "sad" must not hit inside "saddle".
    expect(getEmotionFamily("back in the saddle")).toBeNull();
    // ...but the standalone words still match.
    expect(getEmotionFamily("feeling low")).toBe("strained");
    expect(getEmotionFamily("feeling down")).toBe("strained");
  });

  it("applies table-order priority when several families match", () => {
    // delighted comes before grief/strained, so the delight wins.
    expect(getEmotionFamily("疲惫但开心")).toBe("delighted");
    // spark is first in the table: it beats every other family.
    expect(getEmotionFamily("灵感突现,开心又温暖")).toBe("spark");
    // warm comes before delighted.
    expect(getEmotionFamily("grateful and happy")).toBe("warm");
    // grief comes before strained: explicit sadness beats generic strain.
    expect(getEmotionFamily("悲伤又焦虑")).toBe("grief");
  });

  it("returns null for empty / missing / unmatchable tones", () => {
    expect(getEmotionFamily("")).toBeNull();
    expect(getEmotionFamily("   ")).toBeNull();
    expect(getEmotionFamily(undefined)).toBeNull();
    expect(getEmotionFamily(null)).toBeNull();
    expect(getEmotionFamily("the conversation continued")).toBeNull();
  });

  it("matches CJK keywords as substrings (no word boundaries needed)", () => {
    expect(getEmotionFamily("虽然疲惫但收获很多")).toBe("strained");
    expect(getEmotionFamily("我今天真的是太累了")).toBe("strained");
  });
});

describe("getEmotionColor", () => {
  it("returns a hex color for every family in both themes", () => {
    for (const family of EMOTION_FAMILIES) {
      expect(getEmotionColor(family, "light")).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(getEmotionColor(family, "dark")).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });

  it("uses different colors per theme (bright on dark space, deep on light paper)", () => {
    for (const family of EMOTION_FAMILIES) {
      expect(getEmotionColor(family, "light")).not.toBe(getEmotionColor(family, "dark"));
    }
  });

  it("gives every family a visually distinct color per theme", () => {
    for (const theme of ["light", "dark"] as const) {
      const colors = EMOTION_FAMILIES.map((family) => getEmotionColor(family, theme));
      expect(new Set(colors).size).toBe(EMOTION_FAMILIES.length);
    }
  });

  it("falls back to the neutral grey-white star for null families", () => {
    expect(getEmotionColor(null, "light")).toMatch(/^#[0-9A-Fa-f]{6}$/);
    expect(getEmotionColor(null, "dark")).toMatch(/^#[0-9A-Fa-f]{6}$/);
    expect(getEmotionColor(null, "light")).not.toBe(getEmotionColor(null, "dark"));
  });
});

describe("EMOTION_FAMILIES / EMOTION_FAMILY_LABELS", () => {
  it("lists all seven families exactly once, each with a display label", () => {
    expect(EMOTION_FAMILIES).toHaveLength(7);
    expect(new Set(EMOTION_FAMILIES).size).toBe(7);
    for (const family of EMOTION_FAMILIES) {
      expect(EMOTION_FAMILY_LABELS[family]).toBeTruthy();
    }
  });
});
