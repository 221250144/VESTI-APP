import { describe, expect, it } from "vitest";
import {
  MEMORY_SPACE_COPY,
  detectMemorySpaceLocale,
} from "./memorySpaceCopy";
import { previewDailyLog, todayLocalDateString } from "./dailyLogSection";

describe("detectMemorySpaceLocale", () => {
  it("detects Chinese from the deposits labels", () => {
    expect(detectMemorySpaceLocale({ title: "记忆空间" })).toBe("zh");
  });

  it("detects Japanese from kana before the kanji check", () => {
    // ja labels mix kanji with kana — kana must win over the CJK probe.
    expect(detectMemorySpaceLocale({ title: "メモリースペース" })).toBe("ja");
  });

  it("detects Korean from hangul", () => {
    expect(detectMemorySpaceLocale({ title: "메모리 스페이스" })).toBe("ko");
  });

  it("falls back to the library labels (sendToLabels) for ja/ko, where the deposits group is untranslated", () => {
    expect(detectMemorySpaceLocale({ title: "Memory Space" }, { justNow: "たった今" })).toBe("ja");
    expect(detectMemorySpaceLocale({ title: "Memory Space" }, { justNow: "방금 전" })).toBe("ko");
  });

  it("defaults to English", () => {
    expect(detectMemorySpaceLocale({ title: "Memory Space" })).toBe("en");
    expect(detectMemorySpaceLocale(undefined, undefined)).toBe("en");
  });
});

describe("MEMORY_SPACE_COPY", () => {
  it("ships all four locales with non-empty card titles", () => {
    for (const locale of ["en", "zh", "ja", "ko"] as const) {
      const copy = MEMORY_SPACE_COPY[locale];
      expect(copy.memories.title.length).toBeGreaterThan(0);
      expect(copy.dreams.title.length).toBeGreaterThan(0);
      expect(copy.daily.title.length).toBeGreaterThan(0);
      expect(copy.deposits.title.length).toBeGreaterThan(0);
      expect(copy.entryCount).toContain("{count}");
    }
  });

  it("ships the grouping/collapse chrome copy in all four locales", () => {
    for (const locale of ["en", "zh", "ja", "ko"] as const) {
      const copy = MEMORY_SPACE_COPY[locale];
      expect(copy.unlinkedProject.length).toBeGreaterThan(0);
      expect(copy.expandSection.length).toBeGreaterThan(0);
      expect(copy.collapseSection.length).toBeGreaterThan(0);
    }
    expect(MEMORY_SPACE_COPY.zh.unlinkedProject).toBe("未关联");
  });

  it("ships hover-tooltip intros (tip) for every card in all four locales", () => {
    for (const locale of ["en", "zh", "ja", "ko"] as const) {
      const copy = MEMORY_SPACE_COPY[locale];
      expect(copy.memories.tip.length).toBeGreaterThan(0);
      expect(copy.dreams.tip.length).toBeGreaterThan(0);
      expect(copy.daily.tip.length).toBeGreaterThan(0);
      expect(copy.deposits.tip.length).toBeGreaterThan(0);
    }
  });
});

describe("previewDailyLog", () => {
  it("skips headings/quotes and keeps the first meaningful line", () => {
    const markdown = "# 2026-08-15 日报\n\n> note line\n\n- first real line\n- second";
    expect(previewDailyLog(markdown)).toBe("first real line");
  });

  it("truncates long lines with an ellipsis", () => {
    const markdown = "x".repeat(200);
    const preview = previewDailyLog(markdown, 120);
    expect(preview.length).toBe(120);
    expect(preview.endsWith("…")).toBe(true);
  });

  it("returns an empty string for heading-only markdown", () => {
    expect(previewDailyLog("# title\n## section")).toBe("");
  });
});

describe("todayLocalDateString", () => {
  it("matches the YYYY-MM-DD convention of the stored log rows", () => {
    expect(todayLocalDateString()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
