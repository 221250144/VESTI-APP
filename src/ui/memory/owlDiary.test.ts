import { describe, expect, it } from "vitest";
import {
  OWL_DIARY_MAX_CHARS,
  OWL_DIARY_QUESTION,
  buildOwlDiaryContext,
  buildOwlDiaryFallback,
  owlDiarySummary,
  parseOwlDiaryBody,
  type OwlDiaryInput,
} from "./owlDiary";
import type { MemoryEntryView } from "../../shared/contracts";

function makeEntry(partial: Partial<MemoryEntryView> = {}): MemoryEntryView {
  return {
    id: "mem:1",
    kind: "dream",
    title: partial.title ?? "默认记忆",
    contentMarkdown: partial.contentMarkdown ?? "内容",
    summary: null,
    scope: null,
    template: null,
    sourceSessionIds: [],
    tags: partial.tags ?? ["profile"],
    version: 1,
    prevId: null,
    lastOps: null,
    status: "active",
    entryDate: "2026-08-12",
    createdAt: 1000,
    updatedAt: 1000,
    ...partial,
  };
}

function makeInput(partial: Partial<OwlDiaryInput> = {}): OwlDiaryInput {
  return {
    today: "2026-08-12",
    firstFull: false,
    sessionsProcessed: 3,
    gatedSessions: 0,
    cappedBatches: 0,
    counts: { added: 1, updated: 0, deleted: 0, noop: 0 },
    addedEntries: [makeEntry({ title: "测试记忆", tags: ["event"] })],
    updatedEntries: [],
    ...partial,
  };
}

describe("buildOwlDiaryContext", () => {
  it("includes counts and new memory titles but not full bodies", () => {
    const ctx = buildOwlDiaryContext(makeInput());
    expect(ctx).toContain("2026-08-12");
    expect(ctx).toContain("测试记忆");
    expect(ctx).toContain("新增记忆 1 条");
    expect(ctx).not.toContain("内容");
  });

  it("notes first full run", () => {
    const ctx = buildOwlDiaryContext(makeInput({ firstFull: true }));
    expect(ctx).toContain("首次全量整理");
  });

  it("caps the number of listed titles", () => {
    const addedEntries = Array.from({ length: 10 }, (_, i) =>
      makeEntry({ title: `记忆${i}`, tags: ["event"] }),
    );
    const ctx = buildOwlDiaryContext(makeInput({ addedEntries }));
    const matches = ctx.match(/记忆/g) ?? [];
    expect(matches.length).toBeLessThanOrEqual(10);
  });
});

describe("parseOwlDiaryBody", () => {
  it("strips a [mood:xxx] tag line", () => {
    const body = parseOwlDiaryBody("[mood:warm]\n今天用户完成了很多事。\n它悄悄记下了。");
    expect(body).toBe("今天用户完成了很多事。\n它悄悄记下了。");
  });

  it("strips a bare mood word line", () => {
    const body = parseOwlDiaryBody("warm\n今天用户完成了很多事。");
    expect(body).toBe("今天用户完成了很多事。");
  });

  it("returns null for JSON or empty output", () => {
    expect(parseOwlDiaryBody("")).toBeNull();
    expect(parseOwlDiaryBody("[]")).toBeNull();
    expect(parseOwlDiaryBody('{"ok":true}')).toBeNull();
  });

  it("caps runaway bodies", () => {
    const long = "a".repeat(OWL_DIARY_MAX_CHARS + 100);
    const body = parseOwlDiaryBody(long);
    expect(body!.length).toBeLessThanOrEqual(OWL_DIARY_MAX_CHARS);
    expect(body!.endsWith("…")).toBe(true);
  });
});

describe("buildOwlDiaryFallback", () => {
  it("narrates a day with added memories", () => {
    const body = buildOwlDiaryFallback(makeInput());
    expect(body).toContain("今天用户");
    expect(body).toContain("测试记忆");
    expect(body).toContain("3 段对话");
    expect(body).toContain("新记下 1 件事");
    expect(body).toContain("它悄悄记下了");
  });

  it("handles an empty run warmly", () => {
    const body = buildOwlDiaryFallback(
      makeInput({
        counts: { added: 0, updated: 0, deleted: 0, noop: 0 },
        addedEntries: [],
      }),
    );
    expect(body).toContain("今天用户与 AI 又度过了忙碌的一天");
    expect(body).toContain("记忆都很妥帖");
  });
});

describe("owlDiarySummary", () => {
  it("returns the first sentence capped at 120 chars", () => {
    const summary = owlDiarySummary("今天用户完成了很多事。它悄悄记下了。");
    expect(summary).toBe("今天用户完成了很多事。");
  });
});

describe("OWL_DIARY_QUESTION", () => {
  it("instructs the model to write in third person and avoid emoji", () => {
    expect(OWL_DIARY_QUESTION).toContain("今天用户");
    expect(OWL_DIARY_QUESTION).toContain("猫头鹰日记");
    expect(OWL_DIARY_QUESTION).toContain("不用 emoji");
  });
});
