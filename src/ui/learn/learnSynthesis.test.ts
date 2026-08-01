import { describe, expect, it } from "vitest";
import {
  buildLearnSynthesisTranscript,
  createMemoryLearnSynthesisStore,
  LEARN_SYNTHESIS_TITLE_MAX_CHARS,
  parseLearnSynthesis,
  synthesizeLearnRoutes,
} from "./learnSynthesis";
import { learnRouteFingerprint } from "@vesti/ui";
import type { LearnDomain, LearnRouteSynthesis } from "@vesti/ui";

function domain(overrides?: Partial<LearnDomain>): LearnDomain {
  return {
    topicId: 1,
    name: "Kimi · 综合探索",
    count: 5,
    deep: 2,
    moderate: 2,
    superficial: 1,
    recent30: 3,
    representatives: [
      { conversationId: 11, title: "RAG 召回调优" },
      { conversationId: 12, title: "向量索引选型" },
    ],
    memberIds: [11, 12, 13],
    platforms: ["Kimi"],
    projects: ["VESTI-APP"],
    openQuestion: { text: "召回结果排序还是不稳", conversationId: 11 },
    ...overrides,
  };
}

function okRaw(title = "用 RAG 重构了桌面端记忆召回"): string {
  return JSON.stringify({
    title,
    summary: "这条路线围绕桌面端的记忆召回展开，从向量索引选型一路做到召回质量调优。目前基础链路已经跑通，排序稳定性还在打磨。",
    next_steps: ["为召回结果建立评测基线", "把排序信号抽象成可插拔模块"],
  });
}

function synthesis(fingerprint: string, overrides?: Partial<LearnRouteSynthesis>): LearnRouteSynthesis {
  return {
    fingerprint,
    lang: "zh",
    title: "旧标题",
    summary: "旧解读。",
    nextSteps: [],
    synthesizedAt: 1,
    ...overrides,
  };
}

describe("learnRouteFingerprint", () => {
  it("is stable for the same member id set, insensitive to order", () => {
    const a = learnRouteFingerprint(domain());
    const b = learnRouteFingerprint(domain({ memberIds: [13, 12, 11] }));
    expect(a).toBe(b);
    expect(a).toMatch(/^v1:/);
  });

  it("changes when membership changes", () => {
    expect(learnRouteFingerprint(domain())).not.toBe(
      learnRouteFingerprint(domain({ memberIds: [11, 12, 13, 14] })),
    );
  });

  it("falls back to representative ids when memberIds is absent", () => {
    const fp = learnRouteFingerprint(domain({ memberIds: undefined }));
    expect(fp).toBe(learnRouteFingerprint(domain({ memberIds: [11, 12] })));
  });
});

describe("buildLearnSynthesisTranscript", () => {
  it("packs the route stats, context and JSON contract (zh)", () => {
    const transcript = buildLearnSynthesisTranscript({
      domain: domain(),
      digestByConversationId: new Map([[11, "讨论了召回排序不稳的几种修法"]]),
      lang: "zh",
    });
    expect(transcript).toContain("学习路线：Kimi · 综合探索");
    expect(transcript).toContain("来源平台：Kimi");
    expect(transcript).toContain("涉及项目：VESTI-APP");
    expect(transcript).toContain("共 5 段对话；其中深入 2 段、适中 2 段、浅层 1 段");
    expect(transcript).toContain("- RAG 召回调优 — 讨论了召回排序不稳的几种修法");
    expect(transcript).toContain("还没收尾的问题：召回结果排序还是不稳");
    expect(transcript).toContain('"title"');
    expect(transcript).toContain('"summary"');
    expect(transcript).toContain('"next_steps"');
  });

  it("has an en variant and omits absent context lines", () => {
    const transcript = buildLearnSynthesisTranscript({
      domain: domain({ platforms: [], projects: [], openQuestion: undefined }),
      lang: "en",
    });
    expect(transcript).toContain("Learning route: Kimi · 综合探索");
    expect(transcript).toContain("Local stats: 5 conversations");
    expect(transcript).not.toContain("Source platforms");
    expect(transcript).not.toContain("still-open question");
  });
});

describe("parseLearnSynthesis", () => {
  it("parses clean JSON and tolerates code fences", () => {
    const parsed = parseLearnSynthesis(`\`\`\`json\n${okRaw()}\n\`\`\``);
    expect(parsed?.title).toBe("用 RAG 重构了桌面端记忆召回");
    expect(parsed?.summary).toContain("记忆召回");
    expect(parsed?.nextSteps).toEqual(["为召回结果建立评测基线", "把排序信号抽象成可插拔模块"]);
  });

  it("rejects an empty title (falls back to the deterministic label)", () => {
    expect(parseLearnSynthesis(okRaw(""))).toBeNull();
    expect(parseLearnSynthesis(okRaw("   "))).toBeNull();
  });

  it("rejects an overlong (keyword-stuffed) title", () => {
    expect(parseLearnSynthesis(okRaw("标".repeat(LEARN_SYNTHESIS_TITLE_MAX_CHARS + 1)))).toBeNull();
  });

  it("rejects a missing summary and unusable payloads", () => {
    const noSummary = JSON.stringify({ title: "好标题", next_steps: [] });
    expect(parseLearnSynthesis(noSummary)).toBeNull();
    expect(parseLearnSynthesis("not json at all")).toBeNull();
    expect(parseLearnSynthesis("")).toBeNull();
  });

  it("caps next steps at 3 and drops empty items", () => {
    const parsed = parseLearnSynthesis(
      JSON.stringify({
        title: "好标题",
        summary: "解读。",
        next_steps: ["一", "", "二", "三", "四"],
      }),
    );
    expect(parsed?.nextSteps).toEqual(["一", "二", "三"]);
  });
});

describe("synthesizeLearnRoutes", () => {
  it("synthesizes every route once and reports progress", async () => {
    const d1 = domain();
    const d2 = domain({ topicId: 2, name: "前端", memberIds: [21, 22] });
    const store = createMemoryLearnSynthesisStore();
    const calls: string[] = [];
    const progress: Array<[number, number]> = [];
    const out = await synthesizeLearnRoutes([d1, d2], {
      lang: "zh",
      store,
      runner: async (d) => {
        calls.push(d.name);
        return okRaw();
      },
      onProgress: (done, total) => progress.push([done, total]),
    });
    expect(calls).toEqual(["Kimi · 综合探索", "前端"]);
    expect(progress).toEqual([[1, 2], [2, 2]]);
    expect(out[learnRouteFingerprint(d1)]?.title).toBe("用 RAG 重构了桌面端记忆召回");
    expect(out[learnRouteFingerprint(d2)]?.title).toBe("用 RAG 重构了桌面端记忆召回");
    // Both fresh entries persisted under fingerprint::lang keys.
    expect(Object.keys(store.snapshot()).sort()).toEqual(
      [`${learnRouteFingerprint(d1)}::zh`, `${learnRouteFingerprint(d2)}::zh`].sort(),
    );
  });

  it("hits the cache for unchanged fingerprints and re-runs only changed routes", async () => {
    const d1 = domain();
    const d2 = domain({ topicId: 2, name: "前端", memberIds: [21, 22] });
    const d2Changed = domain({ topicId: 2, name: "前端", memberIds: [21, 22, 23] });
    const cached = synthesis(learnRouteFingerprint(d1), { title: "缓存标题" });
    const staleD2 = synthesis(learnRouteFingerprint(d2), { title: "过期标题" });
    const store = createMemoryLearnSynthesisStore({
      [`${cached.fingerprint}::zh`]: cached,
      [`${staleD2.fingerprint}::zh`]: staleD2,
    });
    const calls: string[] = [];
    const out = await synthesizeLearnRoutes([d1, d2Changed], {
      lang: "zh",
      store,
      runner: async () => {
        calls.push("run");
        return okRaw("新标题");
      },
    });
    // d1 unchanged → cache hit, no LLM call; d2's membership changed → re-run.
    expect(calls).toHaveLength(1);
    expect(out[learnRouteFingerprint(d1)]?.title).toBe("缓存标题");
    expect(out[learnRouteFingerprint(d2Changed)]?.title).toBe("新标题");
    // The stale d2 fingerprint is pruned from the persisted cache.
    expect(store.snapshot()[`${learnRouteFingerprint(d2)}::zh`]).toBeUndefined();
    expect(store.snapshot()[`${learnRouteFingerprint(d2Changed)}::zh`]?.title).toBe("新标题");
  });

  it("reuses nothing when lang differs, but keeps the other-language entry", async () => {
    const d1 = domain();
    const cached = synthesis(learnRouteFingerprint(d1), { lang: "zh", title: "中文标题" });
    const store = createMemoryLearnSynthesisStore({ [`${cached.fingerprint}::zh`]: cached });
    const out = await synthesizeLearnRoutes([d1], {
      lang: "en",
      store,
      runner: async () =>
        JSON.stringify({ title: "Rebuilt desktop memory recall with RAG", summary: "An English reading.", next_steps: [] }),
    });
    expect(out[learnRouteFingerprint(d1)]?.lang).toBe("en");
    // A second run back in zh finds the earlier entry again.
    const back = await synthesizeLearnRoutes([d1], {
      lang: "zh",
      store,
      runner: async () => {
        throw new Error("must not run — cache hit expected");
      },
    });
    expect(back[learnRouteFingerprint(d1)]?.title).toBe("中文标题");
  });

  it("force re-runs cached routes (重新生成)", async () => {
    const d1 = domain();
    const cached = synthesis(learnRouteFingerprint(d1), { title: "缓存标题" });
    const store = createMemoryLearnSynthesisStore({ [`${cached.fingerprint}::zh`]: cached });
    const out = await synthesizeLearnRoutes([d1], {
      lang: "zh",
      store,
      force: true,
      runner: async () => okRaw("重生成的标题"),
    });
    expect(out[learnRouteFingerprint(d1)]?.title).toBe("重生成的标题");
  });

  it("partial failure: failed routes fall back, the rest still synthesize", async () => {
    const d1 = domain();
    const d2 = domain({ topicId: 2, name: "前端", memberIds: [21, 22] });
    const store = createMemoryLearnSynthesisStore();
    const out = await synthesizeLearnRoutes([d1, d2], {
      lang: "zh",
      store,
      runner: async (d) => {
        if (d.name === "Kimi · 综合探索") throw new Error("LLM down");
        return okRaw();
      },
    });
    expect(out[learnRouteFingerprint(d1)]).toBeUndefined();
    expect(out[learnRouteFingerprint(d2)]?.title).toBe("用 RAG 重构了桌面端记忆召回");
    // Failures are not cached — a later run retries them.
    expect(store.snapshot()[learnRouteFingerprint(d1)]).toBeUndefined();
  });

  it("total failure: every route falls back, nothing cached", async () => {
    const d1 = domain();
    const store = createMemoryLearnSynthesisStore();
    const out = await synthesizeLearnRoutes([d1], {
      lang: "zh",
      store,
      runner: async () => {
        throw new Error("LLM down");
      },
    });
    expect(out).toEqual({});
    expect(store.snapshot()).toEqual({});
  });

  it("unusable model output (bad title) falls back without caching", async () => {
    const d1 = domain();
    const store = createMemoryLearnSynthesisStore();
    const out = await synthesizeLearnRoutes([d1], {
      lang: "zh",
      store,
      runner: async () => okRaw(""),
    });
    expect(out).toEqual({});
    expect(store.snapshot()).toEqual({});
  });
});
