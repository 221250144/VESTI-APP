// 夜话 (Companion) orchestration: unit tests for the pure pieces (context
// assembly + budget trimming, mood split, recall→sources mapping) plus
// end-to-end askCompanion tests with every IO seam injected via CompanionDeps
// (node environment — the real Dexie/window.vesti are never touched),
// matching the dreamService test style.

import { describe, expect, it, vi } from "vitest";
import type {
  AgentResult,
  AgentRunRequest,
  MemoryEntryView,
  SessionRecallHit,
} from "../../shared/contracts";
import type { ExploreMessage } from "../db/types";
import {
  askCompanion,
  buildCompanionContext,
  COMPANION_CONTEXT_BUDGET_CHARS,
  COMPANION_DEPOSIT_DIGEST_CHARS,
  mapCompanionRecallSources,
  splitCompanionResult,
  stripCompanionMoodLine,
  type CompanionConversationRecord,
  type CompanionDeps,
} from "./companionService";

// ---- Fixtures -------------------------------------------------------------------

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

function makeHit(overrides: Partial<SessionRecallHit> = {}): SessionRecallHit {
  return {
    sessionId: "cli-1",
    title: "会话一",
    platform: "Kimi Code",
    score: 0.8,
    snippet: "片段",
    oneLiner: null,
    ...overrides,
  };
}

function makeMessage(
  overrides: Partial<ExploreMessage> & { role: "user" | "assistant"; content: string },
): ExploreMessage {
  return {
    id: `msg-${overrides.content.slice(0, 4)}`,
    sessionId: "sess-1",
    timestamp: 1_000,
    ...overrides,
  };
}

// ---- buildCompanionContext --------------------------------------------------------

describe("buildCompanionContext", () => {
  it("assembles all four sections in order", () => {
    const text = buildCompanionContext({
      memories: [
        makeEntry({ id: "m1", tags: ["preference"], contentMarkdown: "偏好简洁的中文回复" }),
        makeEntry({ id: "m2", tags: ["goal"], contentMarkdown: "正在推进记忆空间\n第二行不进上下文" }),
      ],
      depositDigests: [
        makeEntry({ id: "d1", kind: "deposit", title: "写作风格", contentMarkdown: "用户写作\n偏口语化" }),
      ],
      recallHits: [makeHit({ title: "上次复盘", oneLiner: "聊了发布计划", snippet: "下周冻结需求" })],
      history: [
        makeMessage({ role: "user", content: "今天有点累" }),
        makeMessage({ role: "assistant", content: "warm\n辛苦了，先歇口气" }),
      ],
    });
    expect(text).toBe(
      [
        "【关于用户的长期记忆】",
        "- [preference] 偏好简洁的中文回复",
        "- [goal] 正在推进记忆空间",
        "",
        "【用户的沉淀文档（摘要）】",
        "- 《写作风格》用户写作 偏口语化",
        "",
        "【相关历史对话片段】",
        "- 《上次复盘》聊了发布计划 — 下周冻结需求",
        "",
        "【你们最近的交谈】",
        "用户：今天有点累",
        "夜话：辛苦了，先歇口气",
      ].join("\n"),
    );
  });

  it("omits empty sections entirely and tolerates an all-empty input", () => {
    const text = buildCompanionContext({
      memories: [],
      depositDigests: [],
      recallHits: [],
      history: [makeMessage({ role: "user", content: "在吗" })],
    });
    expect(text).toBe("【你们最近的交谈】\n用户：在吗");
    expect(
      buildCompanionContext({ memories: [], depositDigests: [], recallHits: [], history: [] }),
    ).toBe("");
  });

  it("caps deposit digests at the digest budget", () => {
    const text = buildCompanionContext({
      memories: [],
      depositDigests: [
        makeEntry({ id: "d1", kind: "deposit", title: "长文档", contentMarkdown: "x".repeat(500) }),
      ],
      recallHits: [],
      history: [],
    });
    expect(text).toBe(`【用户的沉淀文档（摘要）】\n- 《长文档》${"x".repeat(COMPANION_DEPOSIT_DIGEST_CHARS)}`);
  });

  it("drops recall hits before trimming history when over budget", () => {
    const hits = [1, 2, 3, 4].map((index) =>
      makeHit({
        sessionId: `cli-${index}`,
        title: `会话${index}`,
        oneLiner: "y".repeat(6_000),
      }),
    );
    const text = buildCompanionContext({
      memories: [makeEntry({ id: "m1", contentMarkdown: "y".repeat(3_000) })],
      depositDigests: [],
      recallHits: hits,
      history: [makeMessage({ role: "user", content: "y".repeat(4_000) })],
    });
    expect(text.length).toBeLessThanOrEqual(COMPANION_CONTEXT_BUDGET_CHARS + 1);
    // Recall section must be gone before any history line is sacrificed.
    expect(text).not.toContain("【相关历史对话片段】");
    expect(text).toContain("【你们最近的交谈】");
  });

  it("drops the earliest history messages when recall trimming is not enough", () => {
    const filler = "z".repeat(4_000);
    const text = buildCompanionContext({
      memories: [makeEntry({ id: "m1", contentMarkdown: "记得我" })],
      depositDigests: [],
      recallHits: [],
      history: [
        makeMessage({ role: "user", content: `最早的消息${filler}` }),
        makeMessage({ role: "user", content: `居中的消息${filler}` }),
        makeMessage({ role: "user", content: "最近的消息" }),
      ],
    });
    expect(text.length).toBeLessThanOrEqual(COMPANION_CONTEXT_BUDGET_CHARS + 1);
    expect(text).not.toContain("最早的消息");
    expect(text).toContain("最近的消息");
  });

  it("hard-caps the output even when only the memory section remains", () => {
    const memories = Array.from({ length: 60 }, (_, index) =>
      makeEntry({ id: `m${index}`, contentMarkdown: "w".repeat(300) }),
    );
    const text = buildCompanionContext({
      memories,
      depositDigests: [],
      recallHits: [],
      history: [],
    });
    expect(text.length).toBeLessThanOrEqual(COMPANION_CONTEXT_BUDGET_CHARS);
    expect(text.endsWith("…")).toBe(true);
  });
});

// ---- splitCompanionResult / stripCompanionMoodLine ---------------------------------

describe("splitCompanionResult", () => {
  it("splits the parse contract into mood and body", () => {
    expect(splitCompanionResult("delighted\n太好了！\n继续说")).toEqual({
      mood: "delighted",
      body: "太好了！\n继续说",
    });
  });

  it("degrades to calm when the first line is not a mood id", () => {
    expect(splitCompanionResult("直接就是正文")).toEqual({
      mood: "calm",
      body: "直接就是正文",
    });
    expect(splitCompanionResult("不是mood\n正文")).toEqual({
      mood: "calm",
      body: "不是mood\n正文",
    });
  });
});

describe("stripCompanionMoodLine", () => {
  it("strips a leading mood id line and leaves other content alone", () => {
    expect(stripCompanionMoodLine("spark\n来点新点子")).toBe("来点新点子");
    expect(stripCompanionMoodLine("普通正文")).toBe("普通正文");
    expect(stripCompanionMoodLine("第一行\n[mood:warm]")).toBe("第一行\n[mood:warm]");
  });
});

// ---- mapCompanionRecallSources -------------------------------------------------------

describe("mapCompanionRecallSources", () => {
  const records: CompanionConversationRecord[] = [
    { id: 1, cliId: "cli-1", title: "本地会话一", platform: "Kimi Code" },
    { id: 2, cliId: "cli-2", title: "本地会话二", platform: "Claude Code" },
    { id: 3, cliId: null, title: "无 cli 会话", platform: "Kimi Code" },
  ];

  it("maps hits to conversation records with normalized similarity", () => {
    const sources = mapCompanionRecallSources(
      [makeHit({ sessionId: "cli-1", score: 0.5 }), makeHit({ sessionId: "cli-2", title: "远端标题", score: 1 })],
      records,
    );
    expect(sources).toEqual([
      { id: 1, title: "本地会话一", platform: "Kimi Code", similarity: 0.5 },
      { id: 2, title: "本地会话二", platform: "Claude Code", similarity: 1 },
    ]);
  });

  it("skips unknown sessions, folds duplicates and flags subagent hits", () => {
    const sources = mapCompanionRecallSources(
      [
        makeHit({ sessionId: "unknown", score: 1 }),
        makeHit({ sessionId: "sub-9", attributedSessionId: "cli-1", hitSource: "subagent", score: 0.4 }),
        makeHit({ sessionId: "cli-1", score: 0.2 }),
      ],
      records,
    );
    expect(sources).toEqual([
      { id: 1, title: "本地会话一", platform: "Kimi Code", similarity: 0.4, fromSubagent: true },
    ]);
  });
});

// ---- askCompanion -----------------------------------------------------------------

interface CompanionMockOptions {
  memories?: MemoryEntryView[];
  deposits?: MemoryEntryView[];
  recallHits?: SessionRecallHit[];
  recallError?: Error;
  history?: ExploreMessage[];
  records?: CompanionConversationRecord[];
  runAgentContent?: string;
}

function makeDeps(options: CompanionMockOptions = {}) {
  const calls = {
    agentRequests: [] as AgentRunRequest[],
    memoryQueries: [] as Array<Parameters<CompanionDeps["listMemoryEntries"]>[0]>,
    recallQueries: [] as Array<{ query: string; topK?: number }>,
    createdTitles: [] as string[],
    addedMessages: [] as Array<{
      sessionId: string;
      message: Omit<ExploreMessage, "id" | "sessionId">;
    }>,
  };
  const deps: CompanionDeps = {
    runAgent: vi.fn(async (request: AgentRunRequest) => {
      calls.agentRequests.push(request);
      return {
        content: options.runAgentContent ?? "warm\n晚上好，想聊点什么？",
      } as AgentResult;
    }),
    listMemoryEntries: vi.fn(async (query) => {
      calls.memoryQueries.push(query);
      return query?.kind === "deposit" ? options.deposits ?? [] : options.memories ?? [];
    }),
    recallSessions: vi.fn(async (query: string, topK?: number) => {
      calls.recallQueries.push({ query, topK });
      if (options.recallError) throw options.recallError;
      return options.recallHits ?? [];
    }),
    createSession: vi.fn(async (title: string) => {
      calls.createdTitles.push(title);
      return "sess-new";
    }),
    getRecentMessages: vi.fn(async () => options.history ?? []),
    addMessage: vi.fn(async (sessionId, message) => {
      calls.addedMessages.push({ sessionId, message });
      return { id: "msg-x", sessionId, ...message } as ExploreMessage;
    }),
    listConversationRecords: vi.fn(async () => options.records ?? []),
    now: () => 5_000,
  };
  return { deps, calls };
}

describe("askCompanion", () => {
  it("runs the full-scope turn and persists both messages", async () => {
    const { deps, calls } = makeDeps({
      memories: [makeEntry({ id: "m1", tags: ["emotion"], contentMarkdown: "最近在赶发布" })],
      deposits: [makeEntry({ id: "d1", kind: "deposit", title: "风格", contentMarkdown: "简洁" })],
      recallHits: [makeHit({ sessionId: "cli-1", score: 0.5, snippet: "发布片段" })],
      records: [{ id: 7, cliId: "cli-1", title: "发布复盘", platform: "Kimi Code" }],
      history: [makeMessage({ role: "user", content: "昨天聊到发布" })],
      runAgentContent: "thinking\n先把最担心的那件事说出来？",
    });

    const answer = await askCompanion(
      { sessionId: "sess-1", question: "心里有点没底" },
      deps,
    );

    expect(calls.createdTitles).toEqual([]);
    expect(calls.agentRequests).toHaveLength(1);
    const request = calls.agentRequests[0];
    expect(request.kind).toBe("companion");
    expect(request.sessionId).toBe("sess-1");
    expect(request.question).toBe("心里有点没底");
    expect(request.template).toBe("listener");
    expect(request.persist).toBe(false);
    expect(request.transcriptOverride).toContain("【关于用户的长期记忆】");
    expect(request.transcriptOverride).toContain("- [emotion] 最近在赶发布");
    expect(request.transcriptOverride).toContain("【用户的沉淀文档（摘要）】");
    expect(request.transcriptOverride).toContain("【相关历史对话片段】");
    expect(request.transcriptOverride).toContain("发布片段");
    expect(request.transcriptOverride).toContain("【你们最近的交谈】");
    expect(calls.recallQueries).toEqual([{ query: "心里有点没底", topK: 4 }]);

    expect(answer).toEqual({
      sessionId: "sess-1",
      mood: "thinking",
      persona: "listener",
      content: "先把最担心的那件事说出来？",
      sources: [{ id: 7, title: "发布复盘", platform: "Kimi Code", similarity: 1 }],
    });

    expect(calls.addedMessages).toHaveLength(2);
    expect(calls.addedMessages[0].message).toEqual({
      role: "user",
      content: "心里有点没底",
      timestamp: 5_000,
    });
    expect(calls.addedMessages[1].message.role).toBe("assistant");
    expect(calls.addedMessages[1].message.content).toBe("thinking\n先把最担心的那件事说出来？");
    expect(calls.addedMessages[1].message.sources).toEqual(answer.sources);
    expect(calls.addedMessages[1].message.agentMeta).toMatchObject({
      mood: "thinking",
      persona: "listener",
      memoryScope: "full",
    });
    expect(calls.addedMessages[1].message.timestamp).toBe(5_001);
  });

  it("creates a session when sessionId is omitted and honors the persona", async () => {
    const { deps, calls } = makeDeps({ runAgentContent: "spark\n试试点子 A！" });
    const answer = await askCompanion(
      { question: "这是一个非常非常长的问题标题，超过了十八个字符限制", persona: "creator" },
      deps,
    );
    // 标题取问题前 18 个字符。
    expect(calls.createdTitles).toEqual(["夜话 · 这是一个非常非常长的问题标题，超过了"]);
    expect(answer.sessionId).toBe("sess-new");
    expect(answer.persona).toBe("creator");
    expect(calls.agentRequests[0].template).toBe("creator");
    expect(calls.agentRequests[0].sessionId).toBe("sess-new");
    expect(answer.mood).toBe("spark");
  });

  it("scope 'chat' skips memories, deposits and recall entirely", async () => {
    const { deps, calls } = makeDeps({
      memories: [makeEntry({ id: "m1" })],
      recallHits: [makeHit()],
    });
    await askCompanion(
      { sessionId: "sess-1", question: "随便聊聊", memoryScope: "chat" },
      deps,
    );
    expect(calls.memoryQueries).toEqual([]);
    expect(calls.recallQueries).toEqual([]);
    // A blank context must not reach the main process verbatim: it rejects
    // agent runs with neither a capture session nor a transcript.
    expect(calls.agentRequests[0].transcriptOverride).toBe("（暂无可参考的记忆或对话前文）");
  });

  it("scope 'memory' keeps memories but skips recall", async () => {
    const { deps, calls } = makeDeps({
      memories: [makeEntry({ id: "m1", contentMarkdown: "偏好中文" })],
    });
    await askCompanion(
      { sessionId: "sess-1", question: "hi", memoryScope: "memory" },
      deps,
    );
    expect(calls.memoryQueries).toEqual([
      { kind: "dream", status: "active", limit: 100 },
      { kind: "deposit", status: "active", limit: 5 },
    ]);
    expect(calls.recallQueries).toEqual([]);
    expect(calls.agentRequests[0].transcriptOverride).toContain("- [profile] 偏好中文");
    expect(calls.agentRequests[0].transcriptOverride).not.toContain("【相关历史对话片段】");
  });

  it("degrades to no recall context when recall fails, without sinking the turn", async () => {
    const { deps, calls } = makeDeps({
      recallError: new Error("embedding down"),
      runAgentContent: "calm\n我在。",
    });
    const answer = await askCompanion({ sessionId: "sess-1", question: "在吗" }, deps);
    expect(answer.mood).toBe("calm");
    expect(answer.sources).toEqual([]);
    expect(calls.agentRequests[0].transcriptOverride).not.toContain("【相关历史对话片段】");
    expect(calls.addedMessages[1].message.sources).toEqual([]);
  });

  it("defaults the mood to calm when the result misses the contract", async () => {
    const { deps } = makeDeps({ runAgentContent: "没有情绪标签的回答" });
    const answer = await askCompanion({ sessionId: "sess-1", question: "hi" }, deps);
    expect(answer.mood).toBe("calm");
    expect(answer.content).toBe("没有情绪标签的回答");
  });

  it("propagates runAgent failures to the caller", async () => {
    const { deps } = makeDeps();
    deps.runAgent = vi.fn(async () => {
      throw new Error("LLM offline");
    });
    await expect(
      askCompanion({ sessionId: "sess-1", question: "hi" }, deps),
    ).rejects.toThrow("LLM offline");
  });
});
