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
  MemoryEntryListOptions,
  MemoryEntryView,
  SessionRecallHit,
  VestiDesktopApi,
} from "../../shared/contracts";
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
  getRecentExploreMessages,
} from "../db/repository";

// ---- Tunables ----------------------------------------------------------------

/** Hard cap for the assembled context. The main process caps
 * transcriptOverride at 30K; 8K leaves ample headroom for the prompt
 * template around it. */
export const COMPANION_CONTEXT_BUDGET_CHARS = 8_000;
/** Deposit documents enter the context as a digest of this many chars. */
export const COMPANION_DEPOSIT_DIGEST_CHARS = 200;
/** Recall hit snippets are collapsed and capped at this many chars. */
export const COMPANION_RECALL_SNIPPET_CHARS = 200;
/** Recent turns of the current conversation fed back into the context. */
export const COMPANION_HISTORY_LIMIT = 12;

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
  sources: RelatedConversation[];
}

export interface AskCompanionInput {
  sessionId?: string;
  question: string;
  persona?: CompanionPersona;
  memoryScope?: CompanionMemoryScope;
}

/** agentMeta payload persisted on the assistant message: the explore fields
 * the schema requires plus the companion annotations the UI switches on. */
export type CompanionAgentMeta = ExploreAgentMeta & {
  mood?: CompanionMood;
  persona?: CompanionPersona;
  memoryScope?: CompanionMemoryScope;
};

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

function renderMemorySection(memories: MemoryEntryView[]): string | null {
  if (memories.length === 0) return null;
  const lines = memories.map(
    (entry) =>
      `- [${entry.tags[0] ?? "memory"}] ${firstLine(entry.contentMarkdown, 200)}`,
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
    return `- 《${entry.title}》${digest}`;
  });
  return `【用户的沉淀文档（摘要）】\n${lines.join("\n")}`;
}

function renderRecallSection(hits: SessionRecallHit[]): string | null {
  if (hits.length === 0) return null;
  const lines = hits.map((hit) => {
    const parts: string[] = [];
    if (hit.oneLiner) parts.push(hit.oneLiner);
    if (hit.snippet) {
      parts.push(
        truncate(collapseWhitespace(hit.snippet), COMPANION_RECALL_SNIPPET_CHARS),
      );
    }
    return `- 《${hit.title}》${parts.join(" — ")}`.trimEnd();
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
 * Assemble the companion context: up to four sections (【关于用户的长期记忆】
 * 【用户的沉淀文档（摘要）】 【相关历史对话片段】 【你们最近的交谈】), empty
 * sections omitted entirely, everything under a hard char budget. When over
 * budget, recall hits are dropped first (lowest-ranked last), then the
 * earliest history messages; a final hard slice guards against oversized
 * memory/deposit sections. An all-empty input yields '' (plain small talk).
 */
export function buildCompanionContext(input: CompanionContextInput): string {
  const fixedSections = [
    renderMemorySection(input.memories),
    renderDepositSection(input.depositDigests),
  ];
  const assemble = (
    recallHits: SessionRecallHit[],
    history: ExploreMessage[],
  ): string =>
    [
      ...fixedSections,
      renderRecallSection(recallHits),
      renderHistorySection(history),
    ]
      .filter((section): section is string => section !== null)
      .join("\n\n");

  let recallHits = input.recallHits;
  let history = input.history;
  let text = assemble(recallHits, history);
  while (text.length > COMPANION_CONTEXT_BUDGET_CHARS && recallHits.length > 0) {
    recallHits = recallHits.slice(0, -1);
    text = assemble(recallHits, history);
  }
  while (text.length > COMPANION_CONTEXT_BUDGET_CHARS && history.length > 0) {
    history = history.slice(1);
    text = assemble(recallHits, history);
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

/** Minimal conversation-record shape the sources mapping needs. */
export interface CompanionConversationRecord {
  id: number;
  cliId: string | null;
  title: string;
  platform: Platform;
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
  listMemoryEntries(options?: MemoryEntryListOptions): Promise<MemoryEntryView[]>;
  recallSessions(query: string, topK?: number): Promise<SessionRecallHit[]>;
  createSession(title: string): Promise<string>;
  getRecentMessages(sessionId: string, limit: number): Promise<ExploreMessage[]>;
  addMessage(
    sessionId: string,
    message: Omit<ExploreMessage, "id" | "sessionId">,
  ): Promise<ExploreMessage>;
  listConversationRecords(): Promise<CompanionConversationRecord[]>;
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
    });
  }
  return result;
}

function defaultCompanionDeps(): CompanionDeps {
  return {
    runAgent: (request) => requireVestiApi().runAgent(request),
    listMemoryEntries: (options) => requireVestiApi().listMemoryEntries(options),
    recallSessions: (query, topK) => requireVestiApi().recallSessions(query, topK),
    createSession: (title) => createExploreSession(title),
    getRecentMessages: (sessionId, limit) => getRecentExploreMessages(sessionId, limit),
    addMessage: (sessionId, message) => addExploreMessage(sessionId, message),
    listConversationRecords: listDexieCompanionConversations,
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
  const question = input.question;
  const sessionId =
    input.sessionId ?? (await deps.createSession(`夜话 · ${question.slice(0, 18)}`));

  const wantMemory = memoryScope !== "chat";
  const wantRecall = memoryScope === "full";
  const [history, memories, depositDigests, recallHits] = await Promise.all([
    deps.getRecentMessages(sessionId, COMPANION_HISTORY_LIMIT),
    wantMemory
      ? deps.listMemoryEntries({ kind: "dream", status: "active", limit: 100 })
      : Promise.resolve([] as MemoryEntryView[]),
    wantMemory
      ? deps.listMemoryEntries({ kind: "deposit", status: "active", limit: 5 })
      : Promise.resolve([] as MemoryEntryView[]),
    wantRecall
      ? deps.recallSessions(question, 4).catch(() => [] as SessionRecallHit[])
      : Promise.resolve([] as SessionRecallHit[]),
  ]);

  const context = buildCompanionContext({ memories, depositDigests, recallHits, history });
  const result = await deps.runAgent({
    kind: "companion",
    sessionId,
    question,
    template: persona,
    // The main process rejects an agent run that resolves neither a capture
    // session nor a transcript — so an empty context (本场对话 scope on a
    // fresh session) still needs a non-blank placeholder riding the channel.
    transcriptOverride: context.trim() ? context : "（暂无可参考的记忆或对话前文）",
    persist: false,
  });
  const { mood, body } = splitCompanionResult(result.content);
  const sources =
    recallHits.length > 0
      ? mapCompanionRecallSources(recallHits, await deps.listConversationRecords())
      : [];

  const now = deps.now();
  await deps.addMessage(sessionId, {
    role: "user",
    content: question,
    timestamp: now,
  });
  const agentMeta: CompanionAgentMeta = {
    mode: "agent",
    toolCalls: [],
    mood,
    persona,
    memoryScope,
  };
  await deps.addMessage(sessionId, {
    role: "assistant",
    content: `${mood}\n${body}`,
    sources,
    agentMeta,
    timestamp: now + 1,
  });

  return { sessionId, mood, persona, content: body, sources };
}
