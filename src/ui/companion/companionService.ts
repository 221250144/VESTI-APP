// 夜话 (Companion) renderer orchestration. One user message → one turn:
// fetch the recent explore-session history + (scope permitting) the dream
// long-term memories, deposit digests and cross-session recall hits →
// buildCompanionContext assembles the four context sections under a hard
// char budget → kind:'companion' runAgent (persist:false; the persona rides
// in `template`) → split the `${mood}\n${body}` parse contract → persist the
// user + assistant messages into explore_sessions (mood/persona/memoryScope
// in agentMeta, recall hits mapped to ExploreSource-shaped sources). The
// pure pieces (context assembly, mood split, sources mapping) are exported
// for tests; IO wiring (window.vesti, Dexie) lives behind CompanionDeps,
// mirroring dreamService.ts's DreamDeps injection style.

import type {
  AgentResult,
  AgentRunRequest,
  AgentStreamChunk,
  MemoryEntryListOptions,
  MemoryEntryView,
  SessionRecallHit,
  VestiDesktopApi,
} from "../../shared/contracts";
import { classifyChatError, type ChatErrorCategory } from "../../main/chatStream";
import { db } from "../db/schema";
import type { ConversationRecord } from "../db/schema";
import type {
  ExploreAgentMeta,
  ExploreMessage,
  Platform,
  RelatedConversation,
} from "../db/types";
import {
  addExploreMessage,
  createExploreSession,
  getExploreSession,
  getRecentExploreMessages,
  updateExploreSession,
} from "../db/repository";

// ---- Tunables ----------------------------------------------------------------

/** Hard cap for the assembled context. The main process caps
 * transcriptOverride at 30K; 16K feeds a generous memory section while
 * leaving ample headroom for the prompt template around it. */
export const COMPANION_CONTEXT_BUDGET_CHARS = 16_000;
/** Deposit documents enter the context as a digest of this many chars. */
export const COMPANION_DEPOSIT_DIGEST_CHARS = 320;
/** Recall hit snippets are collapsed and capped at this many chars. */
export const COMPANION_RECALL_SNIPPET_CHARS = 320;
/** Recent turns of the current conversation fed back into the context. */
export const COMPANION_HISTORY_LIMIT = 12;
/** Long-term memories fetched per turn (trimmed to budget by tag priority). */
export const COMPANION_MEMORY_LIMIT = 400;
/** Cross-session recall hits fetched per question. */
export const COMPANION_RECALL_TOP_K = 6;

// ---- Public types --------------------------------------------------------------

export type CompanionPersona = "listener" | "creator";
export type CompanionMemoryScope = "full" | "memory" | "chat";
export type CompanionMood =
  | "calm"
  | "thinking"
  | "delighted"
  | "spark"
  | "sleepy"
  | "warm";

export interface CompanionAnswer {
  sessionId: string;
  mood: CompanionMood;
  persona: CompanionPersona;
  /** Answer body with the mood tag line stripped. */
  content: string;
  /** Thinking trace when the turn streamed and the model exposed one. */
  reasoning?: string;
  sources: RelatedConversation[];
}

export interface AskCompanionInput {
  sessionId?: string;
  question: string;
  persona?: CompanionPersona;
  memoryScope?: CompanionMemoryScope;
  /** Live-typing callbacks. When set (and the host bridge supports streaming)
   * the turn streams: onStream gets the accumulated RAW answer text (mood tag
   * line included — the UI hides it while typing), onReasoning the
   * accumulated thinking trace. Without them the turn behaves exactly as
   * before (single non-streaming call). */
  onStream?: (accumulatedRaw: string) => void;
  onReasoning?: (accumulated: string) => void;
  /** Proactive opening turn (新的夜话): the owl opens the conversation from
   * long-term memories alone — no user message is persisted, recall is skipped
   * (there is no query to recall with) and the fresh session is renamed from
   * the opener's first words. Only meaningful with an empty question. */
  opener?: boolean;
}

/** agentMeta payload persisted on the assistant message: the explore fields
 * the schema requires plus the companion annotations the UI switches on. */
export type CompanionAgentMeta = ExploreAgentMeta & {
  mood?: CompanionMood;
  persona?: CompanionPersona;
  memoryScope?: CompanionMemoryScope;
  /** Persisted thinking trace (capped) so the collapsible 思考过程 block
   * survives a reload. */
  reasoning?: string;
};

/** Persisted reasoning is a convenience for the 思考过程 fold, not a document —
 * keep it bounded. */
export const COMPANION_REASONING_PERSIST_CHARS = 4_000;

// ---- Structured turn failures -------------------------------------------------------

export type CompanionErrorCategory = ChatErrorCategory | "session-lost";

/**
 * A failed 夜话 turn, classified for the UI. The LLM/gateway stage is wrapped
 * with classifyChatError (src/main/chatStream — the taxonomy has to survive
 * the IPC boundary as a message-only string, so the category is re-derived
 * renderer-side from the same canonical patterns). `category` is what the chat
 * pane switches its gentle banner on; `message` keeps the original gateway
 * detail (request id included) for the collapsible fine print.
 */
export class CompanionTurnError extends Error {
  constructor(
    readonly category: ChatErrorCategory,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message);
    this.name = "CompanionTurnError";
    if (options && "cause" in options) this.cause = options.cause;
  }
}

/**
 * The conversation the user is looking at no longer exists (deleted elsewhere,
 * storage corruption, cleanup). Thrown before any LLM call so nothing is
 * spent; the UI answers with the gentle lost-session banner and a one-tap
 * 新的夜话 instead of bouncing or blanking.
 */
export class CompanionSessionLostError extends Error {
  constructor(readonly sessionId: string) {
    super("这场夜话已经不在了");
    this.name = "CompanionSessionLostError";
  }
}

/** Read the category off anything askCompanion throws (CompanionTurnError,
 * CompanionSessionLostError or a raw persistence/IO failure). */
export function companionErrorCategory(error: unknown): CompanionErrorCategory {
  if (error instanceof CompanionSessionLostError) return "session-lost";
  if (error instanceof CompanionTurnError) return error.category;
  return classifyChatError(error);
}

// ---- Pure core (unit-tested) ----------------------------------------------------

const COMPANION_MOODS: readonly CompanionMood[] = [
  "calm",
  "thinking",
  "delighted",
  "spark",
  "sleepy",
  "warm",
];

export interface CompanionContextInput {
  /** kind:'dream' long-term memory entries. */
  memories: MemoryEntryView[];
  /** kind:'deposit' documents; only a digest of each enters the context. */
  depositDigests: MemoryEntryView[];
  /** Cross-session recall hits for the current question. */
  recallHits: SessionRecallHit[];
  /** Recent messages of the current conversation, chronological. */
  history: ExploreMessage[];
  /** Renderer conversation records — matched to recall hits by cliId so each
   * recalled fragment can carry its local updatedAt date. Optional: without
   * them the recall lines simply omit the date. */
  records?: CompanionConversationRecord[];
}

function truncate(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars - 1)}…`;
}

function firstLine(value: string, maxChars: number): string {
  const line = value.split(/\r?\n/, 1)[0] ?? "";
  return truncate(line.trim(), maxChars);
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** Local-day YYYY-MM-DD — the granularity at which "它真的记得我" reads as
 * memory rather than a log file. */
function formatDay(timestamp: number): string {
  const date = new Date(timestamp);
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/** A memory's day: entryDate (YYYY-MM-DD, the dream-write day) when present,
 * else the last-update day. */
function memoryDay(entry: MemoryEntryView): string {
  return entry.entryDate?.trim() || formatDay(entry.updatedAt);
}

function renderMemorySection(memories: MemoryEntryView[]): string | null {
  if (memories.length === 0) return null;
  const lines = memories.map(
    (entry) =>
      `- [${entry.tags[0] ?? "memory"}]（${memoryDay(entry)}）${firstLine(entry.contentMarkdown, 200)}`,
  );
  return `【关于用户的长期记忆】\n${lines.join("\n")}`;
}

function renderDepositSection(deposits: MemoryEntryView[]): string | null {
  if (deposits.length === 0) return null;
  const lines = deposits.map((entry) => {
    const digest = collapseWhitespace(entry.contentMarkdown).slice(
      0,
      COMPANION_DEPOSIT_DIGEST_CHARS,
    );
    return `- 《${entry.title}》（${memoryDay(entry)}）${digest}`;
  });
  return `【用户的沉淀文档（摘要）】\n${lines.join("\n")}`;
}

function renderRecallSection(
  hits: SessionRecallHit[],
  records: CompanionConversationRecord[] | undefined,
): string | null {
  if (hits.length === 0) return null;
  const recordByCliId = new Map<string, CompanionConversationRecord>();
  for (const record of records ?? []) {
    if (record.cliId) recordByCliId.set(record.cliId, record);
  }
  const lines = hits.map((hit) => {
    // 命中来源: 平台 + 本地会话的最近活跃日期，让回忆落在具体时空里。
    const record = recordByCliId.get(hit.attributedSessionId ?? hit.sessionId);
    const meta: string[] = [];
    if (hit.platform.trim()) meta.push(hit.platform.trim());
    if (record?.updatedAt) meta.push(formatDay(record.updatedAt));
    const parts: string[] = [];
    if (hit.oneLiner) parts.push(hit.oneLiner);
    if (hit.snippet) {
      parts.push(
        `片段：${truncate(collapseWhitespace(hit.snippet), COMPANION_RECALL_SNIPPET_CHARS)}`,
      );
    }
    const metaSuffix = meta.length > 0 ? `（${meta.join(" · ")}）` : "";
    return `- 《${hit.title}》${metaSuffix}${parts.length > 0 ? `：${parts.join(" — ")}` : ""}`;
  });
  return `【相关历史对话片段】\n${lines.join("\n")}`;
}

const MOOD_LINE_PATTERN = /^(calm|thinking|delighted|spark|sleepy|warm)$/;

/** Strip a leading mood id line from persisted assistant content (the
 * kind's parse contract stores `${mood}\n${body}`); content without one is
 * returned unchanged. */
export function stripCompanionMoodLine(content: string): string {
  const newline = content.indexOf("\n");
  if (newline === -1) {
    return MOOD_LINE_PATTERN.test(content.trim()) ? "" : content;
  }
  const first = content.slice(0, newline).trim();
  if (MOOD_LINE_PATTERN.test(first)) return content.slice(newline + 1).trim();
  return content;
}

function renderHistorySection(history: ExploreMessage[]): string | null {
  if (history.length === 0) return null;
  const lines = history.map((message) =>
    message.role === "user"
      ? `用户：${message.content}`
      : `夜话：${stripCompanionMoodLine(message.content)}`,
  );
  return `【你们最近的交谈】\n${lines.join("\n")}`;
}

/**
 * 个人信息优先级: profile/preference/goal memories are the ones the user
 * most wants the owl to "remember about me" — they enter the context first
 * and are dropped last; within a tag, freshest first.
 */
export const COMPANION_MEMORY_TAG_PRIORITY: Record<string, number> = {
  profile: 0,
  preference: 1,
  goal: 2,
  emotion: 3,
  relationship: 4,
  event: 5,
};

export function prioritizeMemories(memories: MemoryEntryView[]): MemoryEntryView[] {
  return [...memories].sort((a, b) => {
    const pa = COMPANION_MEMORY_TAG_PRIORITY[a.tags[0] ?? ""] ?? 6;
    const pb = COMPANION_MEMORY_TAG_PRIORITY[b.tags[0] ?? ""] ?? 6;
    if (pa !== pb) return pa - pb;
    return b.updatedAt - a.updatedAt;
  });
}

/**
 * Assemble the companion context: up to four sections (【关于用户的长期记忆】
 * 【用户的沉淀文档（摘要）】 【相关历史对话片段】 【你们最近的交谈】), empty
 * sections omitted entirely, everything under a hard char budget. When over
 * budget, sections shrink in rising-value order: recall hits first
 * (lowest-ranked last), then deposit digests, then the earliest history
 * messages, finally the lowest-priority memory lines; a final hard slice
 * guards the remainder. An all-empty input yields '' (plain small talk).
 */
export function buildCompanionContext(input: CompanionContextInput): string {
  let memories = input.memories;
  let deposits = input.depositDigests;
  let recallHits = input.recallHits;
  let history = input.history;
  const assemble = (): string =>
    [
      renderMemorySection(memories),
      renderDepositSection(deposits),
      renderRecallSection(recallHits, input.records),
      renderHistorySection(history),
    ]
      .filter((section): section is string => section !== null)
      .join("\n\n");

  let text = assemble();
  while (text.length > COMPANION_CONTEXT_BUDGET_CHARS && recallHits.length > 0) {
    recallHits = recallHits.slice(0, -1);
    text = assemble();
  }
  while (text.length > COMPANION_CONTEXT_BUDGET_CHARS && deposits.length > 0) {
    deposits = deposits.slice(0, -1);
    text = assemble();
  }
  while (text.length > COMPANION_CONTEXT_BUDGET_CHARS && history.length > 0) {
    history = history.slice(1);
    text = assemble();
  }
  while (text.length > COMPANION_CONTEXT_BUDGET_CHARS && memories.length > 0) {
    memories = memories.slice(0, -1);
    text = assemble();
  }
  if (text.length > COMPANION_CONTEXT_BUDGET_CHARS) {
    text = `${text.slice(0, COMPANION_CONTEXT_BUDGET_CHARS - 1)}…`;
  }
  return text;
}

/**
 * Split the kind's parse contract (`${mood}\n${body}`) back apart. The main
 * process already ran parse(), so the first line is normally a valid mood id;
 * anything else degrades to 'calm' with the whole content as body.
 */
export function splitCompanionResult(content: string): {
  mood: CompanionMood;
  body: string;
} {
  const newline = content.indexOf("\n");
  const first = (newline === -1 ? content : content.slice(0, newline))
    .trim()
    .toLowerCase();
  if ((COMPANION_MOODS as readonly string[]).includes(first)) {
    return {
      mood: first as CompanionMood,
      body: newline === -1 ? "" : content.slice(newline + 1).trim(),
    };
  }
  return { mood: "calm", body: content.trim() };
}

/** Minimal conversation-record shape the sources mapping needs. `updatedAt`
 * lets the recall section date each fragment ("它真的记得我" needs a when, not
 * just a what). */
export interface CompanionConversationRecord {
  id: number;
  cliId: string | null;
  title: string;
  platform: Platform;
  updatedAt?: number | null;
}

/**
 * Map recalled sessions back to renderer conversation records, keeping the
 * recall ranking and normalizing scores to [0, 1] — the same shape the
 * explore pipeline produces (desktopStorage.recallSources): subagent hits map
 * to the parent's record flagged fromSubagent, duplicates folded.
 */
export function mapCompanionRecallSources(
  hits: SessionRecallHit[],
  records: CompanionConversationRecord[],
): RelatedConversation[] {
  const conversationByCliId = new Map<string, CompanionConversationRecord>();
  for (const record of records) {
    if (record.cliId) conversationByCliId.set(record.cliId, record);
  }
  const maxScore = Math.max(...hits.map((hit) => hit.score), Number.EPSILON);
  const sources: RelatedConversation[] = [];
  const seenConversationIds = new Set<number>();
  for (const hit of hits) {
    const record = conversationByCliId.get(hit.attributedSessionId ?? hit.sessionId);
    if (!record || seenConversationIds.has(record.id)) continue;
    seenConversationIds.add(record.id);
    sources.push({
      id: record.id,
      title: record.title || hit.title,
      platform: record.platform,
      similarity: hit.score / maxScore,
      ...(hit.hitSource === "subagent" ? { fromSubagent: true } : {}),
    });
  }
  return sources;
}

// ---- IO orchestration -----------------------------------------------------------

/** Injectable seams so the turn pipeline is testable without Dexie/window. */
export interface CompanionDeps {
  runAgent(request: AgentRunRequest): Promise<AgentResult>;
  /** Streaming bridge pair — when absent the turn silently uses runAgent. */
  runAgentStream?(request: AgentRunRequest, runId: string): Promise<AgentResult>;
  onAgentStreamChunk?(runId: string, listener: (chunk: AgentStreamChunk) => void): () => void;
  listMemoryEntries(options?: MemoryEntryListOptions): Promise<MemoryEntryView[]>;
  recallSessions(query: string, topK?: number): Promise<SessionRecallHit[]>;
  createSession(title: string): Promise<string>;
  /** Optional rename so an opener turn can retitle its fresh session from the
   * opener's first words. */
  renameSession?(sessionId: string, title: string): Promise<void>;
  getRecentMessages(sessionId: string, limit: number): Promise<ExploreMessage[]>;
  addMessage(
    sessionId: string,
    message: Omit<ExploreMessage, "id" | "sessionId">,
  ): Promise<ExploreMessage>;
  listConversationRecords(): Promise<CompanionConversationRecord[]>;
  /** Existence probe for the lost-session guard: when wired and the caller
   * passed a sessionId, askCompanion checks the session still exists before
   * spending an LLM call. Returns null when the session is gone; a rejected
   * probe is treated as "unknown" and does not block the turn. */
  getSession?(sessionId: string): Promise<{ id: string } | null>;
  now(): number;
}

function vestiApi(): VestiDesktopApi | null {
  return typeof window !== "undefined" && window.vesti ? window.vesti : null;
}

function requireVestiApi(): VestiDesktopApi {
  const api = vestiApi();
  if (!api) throw new Error("桌面环境不可用");
  return api;
}

// Extra fields the main process stamps on local-terminal capture records.
type LocalTerminalFields = {
  _cli_id?: string;
};

async function listDexieCompanionConversations(): Promise<
  CompanionConversationRecord[]
> {
  const records = (await db.conversations.toArray()) as Array<
    ConversationRecord & LocalTerminalFields
  >;
  const result: CompanionConversationRecord[] = [];
  for (const record of records) {
    if (typeof record.id !== "number") continue;
    result.push({
      id: record.id,
      cliId:
        typeof record._cli_id === "string" && record._cli_id
          ? record._cli_id
          : null,
      title: record.title,
      platform: record.platform,
      updatedAt:
        typeof record.updated_at === "number" ? record.updated_at : null,
    });
  }
  return result;
}

function defaultCompanionDeps(): CompanionDeps {
  return {
    runAgent: (request) => requireVestiApi().runAgent(request),
    runAgentStream: (request, runId) => {
      const api = requireVestiApi();
      if (!api.runAgentStream) throw new Error("流式通道不可用");
      return api.runAgentStream(request, runId);
    },
    onAgentStreamChunk: (runId, listener) =>
      requireVestiApi().onAgentStreamChunk?.(runId, listener) ?? (() => undefined),
    listMemoryEntries: (options) => requireVestiApi().listMemoryEntries(options),
    recallSessions: (query, topK) => requireVestiApi().recallSessions(query, topK),
    createSession: (title) => createExploreSession(title),
    renameSession: (sessionId, title) =>
      updateExploreSession(sessionId, { title }),
    getRecentMessages: (sessionId, limit) => getRecentExploreMessages(sessionId, limit),
    addMessage: (sessionId, message) => addExploreMessage(sessionId, message),
    listConversationRecords: listDexieCompanionConversations,
    getSession: (sessionId) => getExploreSession(sessionId),
    now: () => Date.now(),
  };
}

/**
 * One 夜话 turn. LLM and storage errors propagate to the caller (the UI layer
 * surfaces them); a failed recall degrades to no recall context instead of
 * sinking the turn.
 */
export async function askCompanion(
  input: AskCompanionInput,
  deps: CompanionDeps = defaultCompanionDeps(),
): Promise<CompanionAnswer> {
  const persona: CompanionPersona = input.persona ?? "listener";
  const memoryScope: CompanionMemoryScope = input.memoryScope ?? "full";
  // Opener turns: the owl speaks first. No user message exists to persist or
  // to recall with — memories/deposits carry the whole context.
  const isOpener = input.opener === true && !input.question.trim();
  const question = input.question;
  const sessionId =
    input.sessionId ??
    (await deps.createSession(
      isOpener ? "夜话 · 新的开场" : `夜话 · ${question.slice(0, 18)}`,
    ));

  // Lost-session guard: a caller-supplied sessionId that no longer exists
  // (deleted in another window, storage corruption, cleanup) must fail fast
  // and loudly — writing the turn into an orphaned session would look exactly
  // like a successful send while the record never appears anywhere.
  if (input.sessionId && deps.getSession) {
    const existing = await deps.getSession(sessionId).catch(() => undefined);
    if (existing === null) throw new CompanionSessionLostError(sessionId);
  }

  const wantMemory = memoryScope !== "chat";
  const wantRecall = memoryScope === "full" && !isOpener;
  const [history, memories, depositDigests, recallHits, records] = await Promise.all([
    deps.getRecentMessages(sessionId, COMPANION_HISTORY_LIMIT),
    wantMemory
      ? deps
          .listMemoryEntries({ kind: "dream", status: "active", limit: COMPANION_MEMORY_LIMIT })
          .then(prioritizeMemories)
      : Promise.resolve([] as MemoryEntryView[]),
    wantMemory
      ? deps.listMemoryEntries({ kind: "deposit", status: "active", limit: 5 })
      : Promise.resolve([] as MemoryEntryView[]),
    wantRecall
      ? deps.recallSessions(question, COMPANION_RECALL_TOP_K).catch(() => [] as SessionRecallHit[])
      : Promise.resolve([] as SessionRecallHit[]),
    // Conversation records date the recall fragments in the context AND map
    // the sources afterwards — one scan serves both. A failed scan degrades
    // to undated fragments instead of sinking the turn.
    wantRecall
      ? deps.listConversationRecords().catch(() => [] as CompanionConversationRecord[])
      : Promise.resolve([] as CompanionConversationRecord[]),
  ]);

  const context = buildCompanionContext({ memories, depositDigests, recallHits, history, records });
  const request: AgentRunRequest = {
    kind: "companion",
    sessionId,
    question,
    template: persona,
    // The main process rejects an agent run that resolves neither a capture
    // session nor a transcript — so an empty context (本场对话 scope on a
    // fresh session) still needs a non-blank placeholder riding the channel.
    transcriptOverride: context.trim() ? context : "（暂无可参考的记忆或对话前文）",
    persist: false,
  };

  // Streaming is opt-in per turn: the UI passes live-typing callbacks and the
  // host bridge must expose the stream pair; otherwise the plain call runs.
  // LLM-stage failures are re-thrown as CompanionTurnError with the canonical
  // gateway category so the chat pane can tell "网络连不上" from "服务配置问题".
  let reasoning = "";
  let result: AgentResult;
  try {
    if (input.onStream && deps.runAgentStream && deps.onAgentStreamChunk) {
      const runId = crypto.randomUUID();
      let accumulated = "";
      const off = deps.onAgentStreamChunk(runId, (chunk) => {
        if (chunk.delta) {
          accumulated += chunk.delta;
          input.onStream?.(accumulated);
        }
        if (chunk.reasoning) {
          reasoning += chunk.reasoning;
          input.onReasoning?.(reasoning);
        }
      });
      try {
        result = await deps.runAgentStream(request, runId);
      } finally {
        off();
      }
    } else {
      result = await deps.runAgent(request);
    }
  } catch (error) {
    if (error instanceof CompanionTurnError || error instanceof CompanionSessionLostError) {
      throw error;
    }
    throw new CompanionTurnError(
      classifyChatError(error),
      error instanceof Error ? error.message : "夜话暂时没能回答",
      { cause: error },
    );
  }
  const { mood, body } = splitCompanionResult(result.content);
  const trimmedReasoning = reasoning.trim();
  const persistedReasoning = trimmedReasoning
    ? trimmedReasoning.slice(0, COMPANION_REASONING_PERSIST_CHARS)
    : undefined;
  const sources =
    recallHits.length > 0 ? mapCompanionRecallSources(recallHits, records) : [];

  const now = deps.now();
  if (!isOpener) {
    await deps.addMessage(sessionId, {
      role: "user",
      content: question,
      timestamp: now,
    });
  }
  const agentMeta: CompanionAgentMeta = {
    mode: "agent",
    toolCalls: [],
    mood,
    persona,
    memoryScope,
    ...(persistedReasoning ? { reasoning: persistedReasoning } : {}),
  };
  await deps.addMessage(sessionId, {
    role: "assistant",
    content: `${mood}\n${body}`,
    sources,
    agentMeta,
    timestamp: now + 1,
  });

  // An opener session was created with a placeholder title; retitle it from
  // the opener's first words. Best-effort — a rename failure must not sink
  // the turn.
  if (isOpener && deps.renameSession) {
    const firstWords = firstLine(body, 12);
    if (firstWords) {
      await deps
        .renameSession(sessionId, `夜话 · ${firstWords}`)
        .catch(() => undefined);
    }
  }

  return {
    sessionId,
    mood,
    persona,
    content: body,
    sources,
    ...(persistedReasoning ? { reasoning: persistedReasoning } : {}),
  };
}
