// Dream memory pipeline: unit tests for the pure pieces (session selection,
// block rendering, batch packing, op application, journal markdown) plus
// end-to-end runDreamPipeline tests with window.vesti mocked (vi.stubGlobal)
// and the Dexie/session seams injected via DreamDeps. Node environment — the
// real Dexie is never touched (deps are injected), matching the deposits/
// dailyPipeline test style.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRunRequest, MemoryEntryView } from "../../shared/contracts";
import type { DreamMaintainOp } from "../../shared/dreamMaintain";
import { todayDateString } from "../daily/dailyActivity";
import {
  DREAM_BATCH_BUDGET_CHARS,
  applyDreamMaintainOps,
  buildDreamJournalMarkdown,
  buildDreamMaintainTranscript,
  packDreamBatches,
  parseDreamExtractResult,
  parseDreamMaintainResult,
  renderDreamSessionBlock,
  runDreamPipeline,
  selectDreamSessions,
  type DreamDeps,
  type DreamSessionBlock,
  type DreamSessionRecord,
} from "./dreamService";

const FIXED_NOW = new Date(2026, 7, 12, 10, 30).getTime();
const TODAY = todayDateString(FIXED_NOW);

// ---- Fixtures -------------------------------------------------------------------

function makeSession(
  overrides: Partial<DreamSessionRecord> & { id: number },
): DreamSessionRecord {
  return {
    sessionKey: `cli-${overrides.id}`,
    title: `会话 ${overrides.id}`,
    platform: "Kimi Code",
    projectLabel: "/work/vesti",
    activityAt: 1_000 + overrides.id,
    messageCount: 2,
    ...overrides,
  };
}

function makeEntry(
  overrides: Partial<MemoryEntryView> & { id: string },
): MemoryEntryView {
  return {
    kind: "dream",
    title: overrides.id,
    contentMarkdown: "内容",
    summary: null,
    scope: null,
    template: null,
    sourceSessionIds: [],
    tags: ["profile"],
    version: 1,
    prevId: null,
    lastOps: null,
    status: "active",
    entryDate: "2026-01-01",
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

function makeBlock(sessionKey: string, length: number): DreamSessionBlock {
  return { sessionKey, activityAt: 0, text: "x".repeat(length) };
}

function makeOp(overrides: Partial<DreamMaintainOp> & { op: DreamMaintainOp["op"] }) {
  return {
    target_id: null,
    tag: "profile",
    title: "",
    content: "",
    reason: "r",
    ...overrides,
  } as DreamMaintainOp;
}

// ---- window.vesti mock ------------------------------------------------------------

interface VestiMockOptions {
  meta?: Array<[string, string]>;
  existing?: MemoryEntryView[];
  journal?: MemoryEntryView | null;
  onRunAgent?: (request: AgentRunRequest) => { content: string } | Promise<{ content: string }>;
}

function makeVestiMock(options: VestiMockOptions = {}) {
  const meta = new Map<string, string>(options.meta ?? []);
  const calls = {
    agentRequests: [] as AgentRunRequest[],
    upserts: [] as MemoryEntryView[],
    deletes: [] as string[],
    metaSets: [] as Array<[string, string]>,
  };
  const vesti = {
    runAgent: vi.fn(async (request: AgentRunRequest) => {
      calls.agentRequests.push(request);
      if (!options.onRunAgent) throw new Error(`unexpected agent kind ${request.kind}`);
      return options.onRunAgent(request);
    }),
    listMemoryEntries: vi.fn(async () => options.existing ?? []),
    getMemoryEntries: vi.fn(async () => (options.journal ? [options.journal] : [])),
    upsertMemoryEntry: vi.fn(async (entry: MemoryEntryView) => {
      calls.upserts.push(entry);
    }),
    deleteMemoryEntry: vi.fn(async (id: string) => {
      calls.deletes.push(id);
    }),
    getMemoryMeta: vi.fn(async (key: string) => meta.get(key) ?? null),
    setMemoryMeta: vi.fn(async (key: string, value: string) => {
      meta.set(key, value);
      calls.metaSets.push([key, value]);
    }),
  };
  vi.stubGlobal("window", { vesti });
  return { vesti, calls, meta };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function makeDeps(
  sessions: DreamSessionRecord[],
  messagesById: Record<number, Array<{ role: "user" | "ai"; contentText: string; toolName?: string | null }>>,
): DreamDeps {
  return {
    listSessions: async () => sessions,
    listMessages: async (session) => messagesById[session.id] ?? [],
    sleep: async () => undefined,
    now: () => FIXED_NOW,
  };
}

// ---- Pure pieces -------------------------------------------------------------------

describe("selectDreamSessions", () => {
  const sessions = [
    makeSession({ id: 3, activityAt: 300 }),
    makeSession({ id: 1, activityAt: 100 }),
    makeSession({ id: 2, activityAt: 200 }),
  ];

  it("full sweep selects everything, oldest first", () => {
    expect(
      selectDreamSessions(sessions, { full: true, lastSessionTs: 250 }).map((s) => s.id),
    ).toEqual([1, 2, 3]);
  });

  it("incremental selects only sessions after the watermark", () => {
    expect(
      selectDreamSessions(sessions, { full: false, lastSessionTs: 150 }).map((s) => s.id),
    ).toEqual([2, 3]);
    expect(selectDreamSessions(sessions, { full: false, lastSessionTs: 300 })).toEqual([]);
  });
});

describe("renderDreamSessionBlock", () => {
  const session = makeSession({ id: 1 });

  it("keeps user messages whole, truncates AI turns, marks tool calls", () => {
    const block = renderDreamSessionBlock(session, [
      { role: "user", contentText: "帮我修这个 bug" },
      { role: "ai", contentText: "y".repeat(400) },
      { role: "ai", contentText: "", toolName: "Edit" },
      { role: "user", contentText: "   " },
    ]);
    expect(block).not.toBeNull();
    expect(block).toContain("### 会话 cli-1");
    expect(block).toContain("平台: Kimi Code | 项目: /work/vesti | 标题: 会话 1");
    expect(block).toContain("用户: 帮我修这个 bug");
    expect(block).toContain(`AI: ${"y".repeat(299)}…`);
    expect(block).not.toContain("y".repeat(350));
    expect(block).toContain("[工具: Edit]");
  });

  it("returns null for sessions without real user content", () => {
    expect(renderDreamSessionBlock(session, [{ role: "ai", contentText: "hello" }])).toBeNull();
    expect(
      renderDreamSessionBlock(session, [{ role: "user", contentText: "  \n " }]),
    ).toBeNull();
    expect(renderDreamSessionBlock(session, [])).toBeNull();
  });
});

describe("packDreamBatches", () => {
  it("packs small blocks together up to the budget", () => {
    // half + 2 (separator) + half = budget exactly → one batch.
    const half = (DREAM_BATCH_BUDGET_CHARS - 2) / 2;
    const [batch] = packDreamBatches([makeBlock("a", half), makeBlock("b", half)]);
    expect(batch.sessionIds).toEqual(["a", "b"]);
    expect(batch.text.length).toBe(DREAM_BATCH_BUDGET_CHARS);
  });

  it("opens a new batch when the next block would cross the budget", () => {
    const half = DREAM_BATCH_BUDGET_CHARS / 2;
    const batches = packDreamBatches([makeBlock("a", half), makeBlock("b", half)]);
    expect(batches.map((b) => b.sessionIds)).toEqual([["a"], ["b"]]);
  });

  it("hard-cuts a single oversized session into budget-sized batches", () => {
    const big = makeBlock("big", DREAM_BATCH_BUDGET_CHARS * 2 + 10_000);
    const batches = packDreamBatches([big]);
    expect(batches).toHaveLength(3);
    for (const batch of batches) {
      expect(batch.sessionIds).toEqual(["big"]);
      expect(batch.text.length).toBeLessThanOrEqual(DREAM_BATCH_BUDGET_CHARS);
    }
    expect(batches[1].text).toMatch(/^（接续会话 big，第 2 段）/);
    // Stripping the continuation markers restores the original text.
    const restored =
      batches[0].text +
      batches
        .slice(1)
        .map((batch) => batch.text.slice(batch.text.indexOf("\n") + 1))
        .join("");
    expect(restored).toBe(big.text);
  });

  it("flushes the current batch around an oversized block", () => {
    const batches = packDreamBatches([
      makeBlock("a", 100),
      makeBlock("big", DREAM_BATCH_BUDGET_CHARS * 2 + 10_000),
      makeBlock("b", 100),
    ]);
    expect(batches.map((batch) => batch.sessionIds)).toEqual([
      ["a"],
      ["big"],
      ["big"],
      ["big"],
      ["b"],
    ]);
  });
});

describe("parseDreamExtractResult / parseDreamMaintainResult", () => {
  it("passes through the main-process pre-parsed arrays", () => {
    const candidates = [{ tag: "goal", fact: "f", evidence: "", session_ids: ["s1"] }];
    expect(parseDreamExtractResult(JSON.stringify(candidates))).toEqual(candidates);
    const ops = [{ op: "NOOP", target_id: null, tag: null, title: "", content: "", reason: "" }];
    expect(parseDreamMaintainResult(JSON.stringify(ops))).toEqual(ops);
  });

  it("falls back to the raw payload shape", () => {
    const raw = JSON.stringify({
      memories: [{ tag: "goal", fact: "想做独立开发", evidence: "提到产品计划", session_ids: [] }],
    });
    expect(parseDreamExtractResult(raw)).toHaveLength(1);
  });

  it("throws on unusable output (the batch try/catch records it as a failure)", () => {
    expect(() => parseDreamExtractResult("不是 JSON")).toThrow();
  });
});

describe("buildDreamMaintainTranscript", () => {
  it("serializes the existing list and candidates the prompt builder expects", () => {
    const transcript = buildDreamMaintainTranscript(
      [makeEntry({ id: "dream:e1", tags: ["goal"], contentMarkdown: "第一行\n第二行" })],
      [{ tag: "preference", fact: "喜欢简洁", evidence: "多次要求", session_ids: ["s1"] }],
    );
    const payload = JSON.parse(transcript) as {
      existing: Array<{ id: string; tag: string; content: string }>;
      candidates: Array<{ tag: string; fact: string; evidence: string }>;
    };
    expect(payload.existing).toEqual([{ id: "dream:e1", tag: "goal", content: "第一行" }]);
    expect(payload.candidates).toEqual([
      { tag: "preference", fact: "喜欢简洁", evidence: "多次要求" },
    ]);
  });
});

describe("applyDreamMaintainOps", () => {
  const ctx = { today: TODAY, sourceSessionIds: ["s1"], now: FIXED_NOW };

  it("applies ADD/UPDATE/NOOP and drops orphan targets", () => {
    const existing = makeEntry({
      id: "dream:e1",
      title: "旧标题",
      contentMarkdown: "旧内容",
      tags: ["profile"],
      version: 2,
      createdAt: 111,
      sourceSessionIds: ["s0"],
    });
    const byId = new Map([[existing.id, existing]]);
    const result = applyDreamMaintainOps(
      [
        makeOp({
          op: "ADD",
          tag: "event",
          content: "用户发布了 Vesti 的第一个正式版本，内容比较长需要截断",
        }),
        makeOp({ op: "UPDATE", target_id: "dream:e1", tag: "goal", title: "新标题", content: "新内容" }),
        makeOp({ op: "DELETE", target_id: "dream:ghost" }),
        makeOp({ op: "NOOP" }),
      ],
      byId,
      ctx,
    );
    expect(result.counts).toEqual({ added: 1, updated: 1, deleted: 0, noop: 1 });
    expect(result.orphans).toBe(1);

    const added = result.addedEntries[0];
    expect(added.id).toMatch(/^dream:[\da-z]+:[\da-z]{6}$/);
    expect(added.kind).toBe("dream");
    // No op title → content truncated to 12 chars.
    expect(added.title).toBe(`${"用户发布了 Vesti 的第一个正式版本，内容比较长需要截断".slice(0, 11)}…`);
    expect(added.tags).toEqual(["event"]);
    expect(added.version).toBe(1);
    expect(added.status).toBe("active");
    expect(added.entryDate).toBe(TODAY);
    expect(added.sourceSessionIds).toEqual(["s1"]);
    expect(byId.has(added.id)).toBe(true);

    const updated = result.updatedEntries[0];
    expect(updated.id).toBe("dream:e1");
    expect(updated.title).toBe("新标题");
    expect(updated.contentMarkdown).toBe("新内容");
    expect(updated.tags).toEqual(["goal"]);
    expect(updated.version).toBe(3);
    expect(updated.createdAt).toBe(111);
    expect(updated.sourceSessionIds).toEqual(["s0", "s1"]);
  });

  it("deletes existing targets and treats repeats as orphans", () => {
    const existing = makeEntry({ id: "dream:e1" });
    const byId = new Map([[existing.id, existing]]);
    const first = applyDreamMaintainOps([makeOp({ op: "DELETE", target_id: "dream:e1" })], byId, ctx);
    expect(first.deletes).toEqual(["dream:e1"]);
    expect(byId.has("dream:e1")).toBe(false);
    const second = applyDreamMaintainOps([makeOp({ op: "DELETE", target_id: "dream:e1" })], byId, ctx);
    expect(second.orphans).toBe(1);
  });
});

describe("buildDreamJournalMarkdown", () => {
  it("renders counts, sections and warnings", () => {
    const markdown = buildDreamJournalMarkdown({
      today: TODAY,
      firstFull: true,
      sessionsProcessed: 5,
      counts: { added: 1, updated: 1, deleted: 0, noop: 2 },
      orphans: 1,
      warnings: ["批次 2 提取失败：boom"],
      addedEntries: [makeEntry({ id: "a", title: "新记忆", contentMarkdown: "新增内容一句话" })],
      updatedEntries: [makeEntry({ id: "u", title: "旧记忆", contentMarkdown: "更新后内容" })],
    });
    expect(markdown).toContain(`# 梦境 · ${TODAY}`);
    expect(markdown).toContain("本次处理了 5 个会话（首次全量整理）。");
    expect(markdown).toContain("新增 1 · 更新 1 · 删除 0 · 跳过 2 · 丢弃孤儿操作 1");
    expect(markdown).toContain("## 新增记忆");
    expect(markdown).toContain("- **新记忆**：新增内容一句话");
    expect(markdown).toContain("## 更新记忆");
    expect(markdown).toContain("## 警告");
    expect(markdown).toContain("- 批次 2 提取失败：boom");
  });
});

// ---- runDreamPipeline end-to-end -----------------------------------------------------

describe("runDreamPipeline", () => {
  const sessions = [makeSession({ id: 1, activityAt: 1_000 }), makeSession({ id: 2, activityAt: 2_000 })];
  const messages = {
    1: [{ role: "user" as const, contentText: "我在做 Vesti 的记忆功能" }],
    2: [
      { role: "user" as const, contentText: "帮我看看梦境管线" },
      { role: "ai" as const, contentText: "好的" },
    ],
  };

  it("first full run: extract → maintain → journal → watermarks", async () => {
    const { calls } = makeVestiMock({
      onRunAgent: (request) => {
        if (request.kind === "dream-extract") {
          return {
            content: JSON.stringify([
              { tag: "goal", fact: "用户在开发 Vesti 记忆功能", evidence: "多个会话提及", session_ids: ["cli-1"] },
            ]),
          };
        }
        return {
          content: JSON.stringify([
            { op: "ADD", target_id: null, tag: "goal", title: "开发记忆功能", content: "用户正在开发 Vesti 的记忆空间功能", reason: "新事实" },
          ]),
        };
      },
    });
    const result = await runDreamPipeline({ mode: "auto" }, makeDeps(sessions, messages));

    expect(result).toMatchObject({
      ok: true,
      firstFull: true,
      sessionsProcessed: 2,
      added: 1,
      updated: 0,
      deleted: 0,
      noop: 0,
      journalEntryId: `dream-log:${TODAY}`,
    });

    // extract ran with the batch anchor and the compressed transcript.
    const extractRequest = calls.agentRequests[0];
    expect(extractRequest.kind).toBe("dream-extract");
    expect(extractRequest.sessionId).toBe("cli-1");
    expect(extractRequest.persist).toBe(false);
    expect(extractRequest.transcriptOverride).toContain("### 会话 cli-1");
    expect(extractRequest.transcriptOverride).toContain("用户: 我在做 Vesti 的记忆功能");

    // maintain received the serialized candidates.
    const maintainRequest = calls.agentRequests[1];
    expect(maintainRequest.kind).toBe("dream-maintain");
    const maintainPayload = JSON.parse(maintainRequest.transcriptOverride as string) as {
      existing: unknown[];
      candidates: unknown[];
    };
    expect(maintainPayload.existing).toEqual([]);
    expect(maintainPayload.candidates).toHaveLength(1);

    // One ADD upsert + one dream-log journal upsert.
    expect(calls.upserts).toHaveLength(2);
    const added = calls.upserts[0];
    expect(added.kind).toBe("dream");
    expect(added.title).toBe("开发记忆功能");
    expect(added.sourceSessionIds).toEqual(["cli-1"]);
    expect(added.entryDate).toBe(TODAY);
    const journal = calls.upserts[1];
    expect(journal.id).toBe(`dream-log:${TODAY}`);
    expect(journal.kind).toBe("dream-log");
    expect(journal.title).toBe(`梦境 · ${TODAY}`);
    expect(journal.contentMarkdown).toContain("首次全量整理");
    expect(journal.contentMarkdown).toContain("## 新增记忆");
    expect(journal.contentMarkdown).toContain("开发记忆功能");
    expect(journal.summary).toContain("新增 1");

    // Watermarks advanced.
    expect(calls.metaSets).toEqual([
      ["dream.lastRunAt", String(FIXED_NOW)],
      ["dream.lastSessionTs", "2000"],
      ["dream.firstFullDone", "1"],
    ]);
  });

  it("incremental run only selects sessions after dream.lastSessionTs", async () => {
    const { calls } = makeVestiMock({
      meta: [
        ["dream.firstFullDone", "1"],
        ["dream.lastSessionTs", "1500"],
      ],
      onRunAgent: () => ({ content: "[]" }),
    });
    const result = await runDreamPipeline({ mode: "auto" }, makeDeps(sessions, messages));
    expect(result.ok).toBe(true);
    expect(result.firstFull).toBe(false);
    expect(result.sessionsProcessed).toBe(1);
    const extractRequest = calls.agentRequests.find((r) => r.kind === "dream-extract");
    expect(extractRequest?.transcriptOverride).toContain("### 会话 cli-2");
    expect(extractRequest?.transcriptOverride).not.toContain("### 会话 cli-1");
  });

  it("incremental run with nothing new exits before any LLM call", async () => {
    const { calls } = makeVestiMock({
      meta: [
        ["dream.firstFullDone", "1"],
        ["dream.lastSessionTs", "99999"],
      ],
      onRunAgent: () => ({ content: "[]" }),
    });
    const result = await runDreamPipeline({ mode: "manual" }, makeDeps(sessions, messages));
    expect(result).toMatchObject({ ok: true, sessionsProcessed: 0 });
    expect(result.message).toContain("没有新的对话需要整理");
    expect(calls.agentRequests).toHaveLength(0);
    expect(calls.upserts).toHaveLength(0);
    // Only lastRunAt is stamped (today counts as checked); the session
    // watermark stays put.
    expect(calls.metaSets).toEqual([["dream.lastRunAt", String(FIXED_NOW)]]);
  });

  it("retries a failed extract batch once and only records the warning when both attempts fail", async () => {
    const bigSessions = [makeSession({ id: 1 }), makeSession({ id: 2 })];
    const bigMessages = {
      1: [{ role: "user" as const, contentText: `甲${"长".repeat(30_000)}` }],
      2: [{ role: "user" as const, contentText: `乙${"长".repeat(30_000)}` }],
    };
    const { calls } = makeVestiMock({
      onRunAgent: (request) => {
        if (request.kind === "dream-extract") {
          // Batch 1 (marked by its 甲 payload) fails every attempt; batch 2
          // succeeds first try. Failing by payload keeps the intent stable
          // under the lanes' concurrent call interleaving.
          if (String(request.transcriptOverride).includes("甲")) {
            throw new Error("网关超时");
          }
          return { content: JSON.stringify([{ tag: "profile", fact: "用户是开发者", evidence: "", session_ids: ["cli-2"] }]) };
        }
        return { content: JSON.stringify([{ op: "NOOP", target_id: null, tag: null, title: "", content: "", reason: "重复" }]) };
      },
    });
    const result = await runDreamPipeline({ mode: "full" }, makeDeps(bigSessions, bigMessages));
    expect(result.ok).toBe(true);
    expect(result.noop).toBe(1);
    expect(calls.agentRequests.map((r) => r.kind)).toEqual([
      // Batch 1 fails both attempts; batch 2 succeeds on its first.
      "dream-extract",
      "dream-extract",
      "dream-extract",
      "dream-maintain",
    ]);
    const journal = calls.upserts[calls.upserts.length - 1];
    expect(journal.contentMarkdown).toContain("批次 1 提取失败：网关超时");
  });

  it("recovers a flaky extract batch via retry without a warning", async () => {
    let extractCalls = 0;
    const { calls } = makeVestiMock({
      onRunAgent: (request) => {
        if (request.kind === "dream-extract") {
          extractCalls += 1;
          if (extractCalls === 1) throw new Error("瞬时 504");
          return { content: JSON.stringify([{ tag: "profile", fact: "用户是开发者", evidence: "", session_ids: ["cli-1"] }]) };
        }
        return { content: JSON.stringify([{ op: "NOOP", target_id: null, tag: null, title: "", content: "", reason: "重复" }]) };
      },
    });
    const result = await runDreamPipeline({ mode: "auto" }, makeDeps(sessions, messages));
    expect(result.ok).toBe(true);
    expect(extractCalls).toBe(2);
    const journal = calls.upserts[calls.upserts.length - 1];
    expect(journal.contentMarkdown).not.toContain("提取失败");
  });

  it("recovers a flaky maintain round via retry without a warning", async () => {
    let maintainCalls = 0;
    const { calls } = makeVestiMock({
      onRunAgent: (request) => {
        if (request.kind === "dream-extract") {
          return { content: JSON.stringify([{ tag: "event", fact: "用户发布了 1.0", evidence: "", session_ids: ["cli-1"] }]) };
        }
        maintainCalls += 1;
        if (maintainCalls === 1) throw new Error("模型没有返回可显示的内容");
        return { content: JSON.stringify([{ op: "ADD", target_id: null, tag: "event", title: "发布 1.0", content: "用户发布了 Vesti 1.0", reason: "里程碑" }]) };
      },
    });
    const result = await runDreamPipeline({ mode: "auto" }, makeDeps(sessions, messages));
    expect(result).toMatchObject({ ok: true, added: 1 });
    expect(maintainCalls).toBe(2);
    const journal = calls.upserts[calls.upserts.length - 1];
    expect(journal.contentMarkdown).not.toContain("合并失败");
  });

  it("fails the run without touching watermarks when every batch fails", async () => {
    const { calls } = makeVestiMock({
      onRunAgent: () => {
        throw new Error("LLM 未配置");
      },
    });
    const result = await runDreamPipeline({ mode: "auto" }, makeDeps(sessions, messages));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("所有批次提取失败");
    expect(calls.upserts).toHaveLength(0);
    expect(calls.metaSets).toHaveLength(0);
  });

  it("applies maintain ops end to end, dropping orphan targets", async () => {
    const existing = makeEntry({ id: "dream:old1", version: 2, createdAt: 111 });
    const { calls } = makeVestiMock({
      existing: [existing],
      onRunAgent: (request) => {
        if (request.kind === "dream-extract") {
          return { content: JSON.stringify([{ tag: "event", fact: "用户发布了 1.0", evidence: "", session_ids: ["cli-1"] }]) };
        }
        return {
          content: JSON.stringify([
            { op: "UPDATE", target_id: "dream:old1", tag: "goal", title: "新标题", content: "更新后的内容", reason: "修正" },
            { op: "DELETE", target_id: "dream:ghost", tag: null, title: "", content: "", reason: "幻觉" },
            { op: "NOOP", target_id: null, tag: null, title: "", content: "", reason: "重复" },
            { op: "ADD", target_id: null, tag: "event", title: "发布 1.0", content: "用户发布了 Vesti 1.0", reason: "里程碑" },
          ]),
        };
      },
    });
    const result = await runDreamPipeline({ mode: "auto" }, makeDeps(sessions, messages));
    expect(result).toMatchObject({ ok: true, added: 1, updated: 1, deleted: 0, noop: 1 });

    const updated = calls.upserts.find((entry) => entry.id === "dream:old1");
    expect(updated?.contentMarkdown).toBe("更新后的内容");
    expect(updated?.version).toBe(3);
    expect(updated?.createdAt).toBe(111);
    expect(calls.deletes).toEqual([]);
    const journal = calls.upserts[calls.upserts.length - 1];
    expect(journal.contentMarkdown).toContain("丢弃孤儿操作 1");
  });

  it("splits >60 candidates into three maintain rounds, the second seeing the first's adds", async () => {
    const candidates = Array.from({ length: 65 }, (_, index) => ({
      tag: "profile",
      fact: `事实 ${index}`,
      evidence: "",
      session_ids: ["cli-1"],
    }));
    const { calls } = makeVestiMock({
      onRunAgent: (request) => {
        if (request.kind === "dream-extract") return { content: JSON.stringify(candidates) };
        return { content: JSON.stringify([{ op: "ADD", target_id: null, tag: "profile", title: "新条目", content: "内容", reason: "r" }]) };
      },
    });
    const result = await runDreamPipeline({ mode: "auto" }, makeDeps(sessions, messages));
    expect(result.ok).toBe(true);
    const maintainRequests = calls.agentRequests.filter((r) => r.kind === "dream-maintain");
    expect(maintainRequests).toHaveLength(3);
    const roundOne = JSON.parse(maintainRequests[0].transcriptOverride as string) as { candidates: unknown[] };
    const roundTwo = JSON.parse(maintainRequests[1].transcriptOverride as string) as {
      existing: Array<{ id: string }>;
      candidates: unknown[];
    };
    const roundThree = JSON.parse(maintainRequests[2].transcriptOverride as string) as { candidates: unknown[] };
    expect(roundOne.candidates).toHaveLength(30);
    expect(roundTwo.candidates).toHaveLength(30);
    expect(roundThree.candidates).toHaveLength(5);
    // Round 2's existing list includes round 1's ADD.
    const roundOneAdded = calls.upserts.find((entry) => entry.kind === "dream");
    expect(roundTwo.existing.map((entry) => entry.id)).toContain(roundOneAdded?.id);
    // 65 candidates fit within the round budget — nothing is dropped.
    const journal = calls.upserts[calls.upserts.length - 1];
    expect(journal.contentMarkdown).not.toContain("丢弃 ");
  });

  it("caps maintain at 12 rounds and records the overflow as a journal warning", async () => {
    const candidates = Array.from({ length: 365 }, (_, index) => ({
      tag: "profile",
      fact: `事实 ${index}`,
      evidence: "",
      session_ids: ["cli-1"],
    }));
    const { calls } = makeVestiMock({
      onRunAgent: (request) => {
        if (request.kind === "dream-extract") return { content: JSON.stringify(candidates) };
        return { content: JSON.stringify([{ op: "ADD", target_id: null, tag: "profile", title: "新条目", content: "内容", reason: "r" }]) };
      },
    });
    const result = await runDreamPipeline({ mode: "auto" }, makeDeps(sessions, messages));
    expect(result.ok).toBe(true);
    const maintainRequests = calls.agentRequests.filter((r) => r.kind === "dream-maintain");
    expect(maintainRequests).toHaveLength(12);
    // 365 - 12×30 = 5 candidates overflow into the warning.
    const journal = calls.upserts[calls.upserts.length - 1];
    expect(journal.contentMarkdown).toContain("丢弃 5 条");
  });

  it("dedupes identical candidate facts before maintain", async () => {
    const candidates = [
      { tag: "goal", fact: "用户在开发 VESTI", evidence: "a", session_ids: ["s1"] },
      { tag: "goal", fact: "用户在开发VESTI ", evidence: "b", session_ids: ["s2"] },
      { tag: "goal", fact: "用户，在开发VESTI！", evidence: "c", session_ids: ["s3"] },
      { tag: "preference", fact: "用户在开发 VESTI", evidence: "d", session_ids: ["s4"] },
    ];
    const { calls } = makeVestiMock({
      onRunAgent: (request) => {
        if (request.kind === "dream-extract") return { content: JSON.stringify(candidates) };
        return { content: JSON.stringify([{ op: "NOOP", target_id: null, tag: null, title: "", content: "", reason: "重复" }]) };
      },
    });
    const result = await runDreamPipeline({ mode: "auto" }, makeDeps(sessions, messages));
    expect(result.ok).toBe(true);
    const maintainRequests = calls.agentRequests.filter((r) => r.kind === "dream-maintain");
    expect(maintainRequests).toHaveLength(1);
    const round = JSON.parse(maintainRequests[0].transcriptOverride as string) as {
      candidates: unknown[];
    };
    // 4 candidates → 2 unique keys (tag + punctuation-insensitive fact).
    expect(round.candidates).toHaveLength(2);
  });

  it("upserts over the same-day journal on a second run", async () => {
    const previousJournal = makeEntry({
      id: `dream-log:${TODAY}`,
      kind: "dream-log",
      version: 3,
      createdAt: 222,
    });
    const { calls } = makeVestiMock({
      journal: previousJournal,
      onRunAgent: () => ({ content: "[]" }),
    });
    const result = await runDreamPipeline({ mode: "auto" }, makeDeps(sessions, messages));
    expect(result.ok).toBe(true);
    const journal = calls.upserts[calls.upserts.length - 1];
    expect(journal.id).toBe(`dream-log:${TODAY}`);
    expect(journal.version).toBe(4);
    expect(journal.createdAt).toBe(222);
  });

  it("rejects a concurrent run with 'dream already running'", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    makeVestiMock({
      onRunAgent: async () => {
        await gate;
        return { content: "[]" };
      },
    });
    const deps = makeDeps(sessions, messages);
    const first = runDreamPipeline({ mode: "auto" }, deps);
    // Let the first run reach the gated extract call.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = await runDreamPipeline({ mode: "auto" }, deps);
    expect(second).toMatchObject({ ok: false, error: "dream already running" });
    release();
    const firstResult = await first;
    expect(firstResult.ok).toBe(true);
  });
});
