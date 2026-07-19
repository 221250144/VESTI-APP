// Tests for the curated 设计/创作 collections (curatedCollections.ts) and their
// integration into the plaza catalog:
//   1. Content integrity — every entry has all required fields, bilingual.
//   2. Placeholder format — balanced {{...}} pairs, en/zh parity.
//   3. Seed/merge idempotency — merging the same collections again is a no-op.
//   4. Plaza integration — new categories surface, and the date-seeded daily
//      rotation eventually features every entry (new collections included).
//   5. Clarity scoring — every body scores normally (promptlib scorePrompt).
// Pure logic, node environment, no Dexie/DOM involved.

import { describe, expect, it } from "vitest";
import {
  CURATED_PROMPTS,
  buildPlazaPrompts,
  getCuratedCategories,
  mergeCuratedPrompts,
  resolveCuratedPrompts,
  searchCuratedPrompts,
} from "./commonPrompts";
import { CURATED_COLLECTIONS } from "./curatedCollections";
import { scorePrompt } from "../db/promptlib";

const DAY_MS = 86_400_000;

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("curated collections content integrity", () => {
  it("covers the four design/creation collections with the expected sizes", () => {
    const byCategory = new Map<string, number>();
    for (const p of CURATED_COLLECTIONS) {
      byCategory.set(p.category.zh, (byCategory.get(p.category.zh) ?? 0) + 1);
    }
    expect(byCategory.get("AI 绘画与图标")).toBeGreaterThanOrEqual(6);
    expect(byCategory.get("UI/UX 设计")).toBeGreaterThanOrEqual(4);
    expect(byCategory.get("创作与写作")).toBeGreaterThanOrEqual(4);
    expect(byCategory.get("工程效率")).toBeGreaterThanOrEqual(4);
  });

  it("every entry has all required fields, bilingual and non-empty", () => {
    for (const p of CURATED_COLLECTIONS) {
      expect(p.id.trim(), `${p.id}: id`).not.toBe("");
      expect(p.category.en.trim(), `${p.id}: category.en`).not.toBe("");
      expect(p.category.zh.trim(), `${p.id}: category.zh`).not.toBe("");
      expect(p.title.en.trim(), `${p.id}: title.en`).not.toBe("");
      expect(p.title.zh.trim(), `${p.id}: title.zh`).not.toBe("");
      expect(p.body.en.trim(), `${p.id}: body.en`).not.toBe("");
      expect(p.body.zh.trim(), `${p.id}: body.zh`).not.toBe("");
      // 适用场景说明 (description) is required for curated collections.
      expect(p.description?.en.trim(), `${p.id}: description.en`).not.toBe("");
      expect(p.description?.zh.trim(), `${p.id}: description.zh`).not.toBe("");
      // Tags are required and usable for search.
      expect(p.tags?.length ?? 0, `${p.id}: tags`).toBeGreaterThan(0);
      for (const tag of p.tags ?? []) {
        expect(tag.trim(), `${p.id}: empty tag`).not.toBe("");
      }
      expect(p.source.trim(), `${p.id}: source`).not.toBe("");
    }
  });

  it("placeholders are balanced {{...}} pairs with en/zh parity", () => {
    for (const p of CURATED_COLLECTIONS) {
      for (const lang of ["en", "zh"] as const) {
        const body = p.body[lang];
        const opens = countOccurrences(body, "{{");
        const closes = countOccurrences(body, "}}");
        expect(opens, `${p.id} (${lang}): unbalanced placeholder`).toBe(closes);
        expect(opens, `${p.id} (${lang}): expected at least one placeholder`).toBeGreaterThan(0);
      }
      // The bilingual versions must offer the same number of fill-in slots.
      expect(
        countOccurrences(p.body.en, "{{"),
        `${p.id}: en/zh placeholder count mismatch`,
      ).toBe(countOccurrences(p.body.zh, "{{"));
    }
  });
});

describe("catalog merge idempotency", () => {
  it("merging the collections twice yields no duplicates", () => {
    const once = mergeCuratedPrompts(CURATED_COLLECTIONS);
    const twice = mergeCuratedPrompts(CURATED_COLLECTIONS, CURATED_COLLECTIONS);
    expect(twice.length).toBe(once.length);
    expect(twice.map((p) => p.id)).toEqual(once.map((p) => p.id));
  });

  it("re-seeding the full catalog (same lists again) is a no-op", () => {
    const reseeded = mergeCuratedPrompts(CURATED_PROMPTS, CURATED_COLLECTIONS);
    expect(reseeded.length).toBe(CURATED_PROMPTS.length);
  });

  it("the merged catalog has no duplicate ids", () => {
    const ids = CURATED_PROMPTS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("all curated collections are present in the full catalog", () => {
    const catalogIds = new Set(CURATED_PROMPTS.map((p) => p.id));
    for (const p of CURATED_COLLECTIONS) {
      expect(catalogIds.has(p.id), `${p.id} missing from CURATED_PROMPTS`).toBe(true);
    }
  });
});

describe("plaza integration", () => {
  it("the four new categories surface in the supermarket category list", () => {
    const zh = getCuratedCategories("zh");
    expect(zh).toContain("AI 绘画与图标");
    expect(zh).toContain("UI/UX 设计");
    expect(zh).toContain("创作与写作");
    expect(zh).toContain("工程效率");
    const en = getCuratedCategories("en");
    expect(en).toContain("AI Art & Icons");
    expect(en).toContain("UI/UX Design");
    expect(en).toContain("Creative Writing");
    expect(en).toContain("Engineering");
  });

  it("resolved prompts carry description and tags through to the UI shape", () => {
    const resolved = resolveCuratedPrompts("zh");
    const sample = resolved.find((p) => p.id === "art-emblem-dontstarve");
    expect(sample?.description?.trim()).not.toBe("");
    expect((sample?.tags ?? []).length).toBeGreaterThan(0);
  });

  it("daily rotation features every catalog entry (incl. new collections) within a cycle", () => {
    // Day-seeded rotation: stepping 3/day over a 31-day cycle covers the whole
    // catalog; 40 days is a safe margin regardless of catalog size.
    const featured = new Set<string>();
    const t0 = Math.floor(Date.now() / DAY_MS) * DAY_MS;
    for (let day = 0; day < 40; day += 1) {
      for (const p of buildPlazaPrompts("zh", t0 + day * DAY_MS)) {
        if (p.featured) featured.add(p.id);
      }
    }
    for (const p of CURATED_PROMPTS) {
      expect(featured.has(p.id), `${p.id} never featured in daily rotation`).toBe(true);
    }
  });

  it("search matches tags", () => {
    const hits = searchCuratedPrompts("深色模式", "zh", 10);
    expect(hits.some((p) => p.id === "uiux-dark-mode-audit")).toBe(true);
    const enHits = searchCuratedPrompts("i2i", "en", 10);
    expect(enHits.some((p) => p.id === "art-i2i-consistent-variants")).toBe(true);
  });
});

describe("clarity scoring", () => {
  it("every collection body scores normally (computes to a sane non-zero value)", () => {
    // scorePrompt is 0..1; long STYLE-prefix bodies land in the fair band while
    // structured zh bodies score higher. 0.25 is the sanity floor (a broken or
    // empty body scores 0).
    for (const p of CURATED_COLLECTIONS) {
      for (const lang of ["en", "zh"] as const) {
        const score = scorePrompt(p.body[lang]);
        expect(
          score,
          `${p.id} (${lang}): clarity score ${score} below floor`,
        ).toBeGreaterThanOrEqual(0.25);
        expect(score, `${p.id} (${lang}): score out of range`).toBeLessThanOrEqual(1);
      }
    }
  });
});
