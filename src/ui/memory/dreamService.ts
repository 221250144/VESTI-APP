// Dream memory (记忆空间「梦境」) renderer orchestration. Nightly pipeline:
// collect the sessions with fresh activity (Dexie, same enumeration path as
// the daily pipeline) → render each into a compressed transcript block (user
// messages whole, AI turns truncated, tool calls as one-line markers) → pack
// blocks ascending by time into ~24K-char batches → dream-extract per batch
// (best-effort: a failed batch is logged and skipped) → dream-maintain merges
// all candidates into the memory_entries library as ADD/UPDATE/DELETE/NOOP
// ops → a kind:'dream-log' journal entry records the run → watermarks advance
// in memory_meta. The pure pieces (selection, rendering, packing, op
// application, journal markdown) are exported for tests; IO wiring (Dexie,
// window.vesti) lives at the bottom.

import type { MemoryEntryView, VestiDesktopApi } from "../../shared/contracts";
import {
  parseDreamExtractPayload,
  parseDreamMaintainPayload,
  type DreamMaintainOp,
  type DreamMemoryCandidate,
} from "../../shared/dreamMaintain";
import { db } from "../db/schema";
import type { ConversationRecord } from "../db/schema";
import { listMessages } from "../db/repository";
import { pad2, toLocalDateString, todayDateString } from "../daily/dailyActivity";

// ---- Tunables ----------------------------------------------------------------

/** Per-batch transcript budget. dream-extract/dream-maintain get a raised
 * 60K transcriptOverride cap in main.ts's validAgentRequest (other kinds stay
 * at 30K); 48K leaves headroom for the prompt template around it. */
export const DREAM_BATCH_BUDGET_CHARS = 48_000;
/** AI turns are truncated to this many chars; user turns stay whole. */
export const DREAM_ASSISTANT_SNIPPET_CHARS = 300;
/** Concurrent extract lanes. A first full sweep means dozens of batches and
 * the LLM endpoint tolerates a few parallel calls; 3 keeps the gateway calm
 * while cutting wall time ~3x. */
export const DREAM_EXTRACT_LANES = 3;
/** Pause between extract batches per lane so a full sweep doesn't flood the gateway. */
export const DREAM_EXTRACT_DELAY_MS = 300;
/** Existing-library cap fed into the maintain step. */
export const DREAM_EXISTING_LIMIT = 500;
/** Candidates per maintain round; large sweeps run at most two rounds. */
export const DREAM_MAINTAIN_ROUND_SIZE = 30;
export const DREAM_MAINTAIN_MAX_ROUNDS = 2;
/** Keep the maintain transcript comfortably under the 30K IPC cap. */
const DREAM_MAINTAIN_TRANSCRIPT_BUDGET = 26_000;

const META_FIRST_FULL_DONE = "dream.firstFullDone";
const META_LAST_RUN_AT = "dream.lastRunAt";
const META_LAST_SESSION_TS = "dream.lastSessionTs";

// ---- Public types --------------------------------------------------------------

export type DreamMode = "auto" | "manual" | "full";

export interface DreamProgress {
  phase: "collect" | "extract" | "maintain" | "journal";
  batchIndex?: number;
  batchCount?: number;
  message: string;
}

export interface DreamRunResult {
  ok: boolean;
  firstFull: boolean;
  sessionsProcessed: number;
  added: number;
  updated: number;
  deleted: number;
  noop: number;
  journalEntryId?: string;
  /** Human-readable one-liner (e.g. the "nothing to do" hint in manual mode). */
  message?: string;
  error?: string;
}

// ---- Pure core (unit-tested) ----------------------------------------------------

/** Minimal session shape the pipeline needs; the Dexie adapter builds it. */
export interface DreamSessionRecord {
  id: number;
  /** Model-facing session id (cli id, or `browser:<dexieId>` — mirrors the
   * conversation-tree browser id scheme) so candidates can cite session_ids. */
  sessionKey: string;
  title: string;
  platform: string;
  projectLabel: string | null;
  /** lastActivityAt equivalent: conversation updated_at. */
  activityAt: number;
  messageCount: number;
}

export interface DreamMessageRecord {
  role: "user" | "ai";
  contentText: string;
  toolName?: string | null;
}

export interface DreamSessionBlock {
  sessionKey: string;
  activityAt: number;
  text: string;
}

export interface DreamBatch {
  sessionIds: string[];
  text: string;
}

/**
 * Pick the sessions due for this run, oldest first: everything on a full
 * sweep, only sessions with activity after the watermark on an incremental
 * run. Records without real user content are filtered later at render time
 * (message_count alone is not a reliable emptiness signal).
 */
export function selectDreamSessions(
  sessions: DreamSessionRecord[],
  opts: { full: boolean; lastSessionTs: number },
): DreamSessionRecord[] {
  return sessions
    .filter((session) => opts.full || session.activityAt > opts.lastSessionTs)
    .sort((a, b) => a.activityAt - b.activityAt);
}

function truncate(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars - 1)}…`;
}

function firstLine(value: string, maxChars: number): string {
  const line = value.split(/\r?\n/, 1)[0] ?? "";
  return truncate(line.trim(), maxChars);
}

function formatSessionTime(timestamp: number): string {
  const date = new Date(timestamp);
  return `${toLocalDateString(timestamp)} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/**
 * Render one session as a compact transcript block: a header the model can
 * cite (session id, platform, project, title, time), then one line per turn —
 * user messages whole, AI turns truncated, tool calls as `[工具: x]` markers,
 * thinking/tool detail omitted. Returns null when the session carries no real
 * user content (skipped, never reaches the LLM).
 */
export function renderDreamSessionBlock(
  session: DreamSessionRecord,
  messages: DreamMessageRecord[],
): string | null {
  const lines: string[] = [];
  let hasUserContent = false;
  for (const message of messages) {
    const text = message.contentText.trim();
    if (message.role === "user") {
      if (text) {
        hasUserContent = true;
        lines.push(`用户: ${text}`);
      }
      if (message.toolName) lines.push(`[工具: ${message.toolName}]`);
      continue;
    }
    if (text) lines.push(`AI: ${truncate(text, DREAM_ASSISTANT_SNIPPET_CHARS)}`);
    if (message.toolName) lines.push(`[工具: ${message.toolName}]`);
  }
  if (!hasUserContent) return null;
  const header = [
    `### 会话 ${session.sessionKey}`,
    `平台: ${session.platform} | 项目: ${session.projectLabel ?? "-"} | 标题: ${
      session.title || "未命名会话"
    } | 时间: ${formatSessionTime(session.activityAt)}`,
  ].join("\n");
  return `${header}\n\n${lines.join("\n")}`;
}

/**
 * Bin-pack session blocks (already time-ascending) into batches of ~budget
 * chars. A single oversized session gets its own batch(es), hard-cut at the
 * budget with a continuation marker on every part after the first.
 */
export function packDreamBatches(
  blocks: DreamSessionBlock[],
  budget: number = DREAM_BATCH_BUDGET_CHARS,
): DreamBatch[] {
  const batches: DreamBatch[] = [];
  let current: DreamSessionBlock[] = [];
  let size = 0;
  const flush = (): void => {
    if (current.length === 0) return;
    batches.push({
      sessionIds: current.map((block) => block.sessionKey),
      text: current.map((block) => block.text).join("\n\n"),
    });
    current = [];
    size = 0;
  };
  for (const block of blocks) {
    if (block.text.length > budget) {
      flush();
      let offset = 0;
      let part = 0;
      while (offset < block.text.length) {
        part += 1;
        const marker = part === 1 ? "" : `（接续会话 ${block.sessionKey}，第 ${part} 段）\n`;
        const slice = block.text.slice(offset, offset + budget - marker.length);
        batches.push({ sessionIds: [block.sessionKey], text: `${marker}${slice}` });
        offset += slice.length;
      }
      continue;
    }
    if (size + (size > 0 ? 2 : 0) + block.text.length > budget) flush();
    current.push(block);
    size += (size > 0 && current.length > 1 ? 2 : 0) + block.text.length;
  }
  flush();
  return batches;
}

/**
 * The main process already runs each dream kind's parse (which re-serializes
 * the validated array), so result.content is normally a JSON array string.
 * Fall back to the payload parsers for raw model output so the renderer is
 * robust either way.
 */
export function parseDreamExtractResult(raw: string): DreamMemoryCandidate[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as DreamMemoryCandidate[];
  } catch {
    // Not the pre-parsed array — try the raw {"memories": [...]} payload.
  }
  return parseDreamExtractPayload(raw);
}

export function parseDreamMaintainResult(raw: string): DreamMaintainOp[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as DreamMaintainOp[];
  } catch {
    // Not the pre-parsed array — try the raw {"ops": [...]} payload.
  }
  return parseDreamMaintainPayload(raw);
}

/**
 * Serialize the dream-maintain input ({"existing": [...], "candidates":
 * [...]}) — the exact shape the kind's prompt builder understands. Two
 * degradation levels keep it under the IPC cap for very large libraries.
 */
export function buildDreamMaintainTranscript(
  existing: MemoryEntryView[],
  candidates: DreamMemoryCandidate[],
): string {
  const render = (contentCap: number, evidenceCap: number): string =>
    JSON.stringify({
      existing: existing.map((entry) => ({
        id: entry.id,
        tag: entry.tags[0] ?? "-",
        content: firstLine(entry.contentMarkdown, contentCap),
      })),
      candidates: candidates.map((candidate) => ({
        tag: candidate.tag,
        fact: candidate.fact,
        evidence: candidate.evidence.slice(0, evidenceCap),
      })),
    });
  const full = render(120, 300);
  return full.length <= DREAM_MAINTAIN_TRANSCRIPT_BUDGET ? full : render(60, 120);
}

export interface DreamApplyContext {
  today: string;
  /** Union of the run's candidate session_ids, stamped on every ADD and
   * merged into UPDATE targets (the ops carry no candidate mapping). */
  sourceSessionIds: string[];
  now: number;
}

export interface DreamApplyResult {
  upserts: MemoryEntryView[];
  deletes: string[];
  counts: { added: number; updated: number; deleted: number; noop: number };
  /** UPDATE/DELETE ops naming an unknown target_id, dropped. */
  orphans: number;
  addedEntries: MemoryEntryView[];
  updatedEntries: MemoryEntryView[];
}

function randomIdSuffix(): string {
  return Math.floor(Math.random() * 36 ** 6)
    .toString(36)
    .padStart(6, "0");
}

function dedupeStrings(items: string[]): string[] {
  return [...new Set(items)];
}

/**
 * Apply one round of maintain ops against the in-memory library map (mutated
 * in place, so a second round sees the first round's results). IO is left to
 * the caller: it receives the upserts/deletes to persist. Ops naming a
 * target_id that doesn't exist are dropped and counted as orphans.
 */
export function applyDreamMaintainOps(
  ops: DreamMaintainOp[],
  byId: Map<string, MemoryEntryView>,
  ctx: DreamApplyContext,
): DreamApplyResult {
  const result: DreamApplyResult = {
    upserts: [],
    deletes: [],
    counts: { added: 0, updated: 0, deleted: 0, noop: 0 },
    orphans: 0,
    addedEntries: [],
    updatedEntries: [],
  };
  for (const op of ops) {
    switch (op.op) {
      case "ADD": {
        const entry: MemoryEntryView = {
          id: `dream:${ctx.now.toString(36)}:${randomIdSuffix()}`,
          kind: "dream",
          title: op.title || truncate(op.content, 12),
          contentMarkdown: op.content,
          summary: null,
          scope: null,
          template: null,
          sourceSessionIds: ctx.sourceSessionIds,
          tags: [op.tag ?? "profile"],
          version: 1,
          prevId: null,
          lastOps: null,
          status: "active",
          entryDate: ctx.today,
          createdAt: ctx.now,
          updatedAt: ctx.now,
        };
        byId.set(entry.id, entry);
        result.upserts.push(entry);
        result.addedEntries.push(entry);
        result.counts.added += 1;
        break;
      }
      case "UPDATE": {
        const existing = op.target_id ? byId.get(op.target_id) : undefined;
        if (!existing) {
          result.orphans += 1;
          break;
        }
        const entry: MemoryEntryView = {
          ...existing,
          title: op.title || existing.title,
          contentMarkdown: op.content || existing.contentMarkdown,
          tags: [op.tag ?? existing.tags[0] ?? "profile"],
          sourceSessionIds: dedupeStrings([
            ...existing.sourceSessionIds,
            ...ctx.sourceSessionIds,
          ]).slice(0, 100),
          version: existing.version + 1,
          updatedAt: ctx.now,
        };
        byId.set(entry.id, entry);
        result.upserts.push(entry);
        result.updatedEntries.push(entry);
        result.counts.updated += 1;
        break;
      }
      case "DELETE": {
        if (!op.target_id || !byId.has(op.target_id)) {
          result.orphans += 1;
          break;
        }
        byId.delete(op.target_id);
        result.deletes.push(op.target_id);
        result.counts.deleted += 1;
        break;
      }
      case "NOOP":
        result.counts.noop += 1;
        break;
    }
  }
  return result;
}

export interface DreamJournalInput {
  today: string;
  firstFull: boolean;
  sessionsProcessed: number;
  counts: { added: number; updated: number; deleted: number; noop: number };
  orphans: number;
  warnings: string[];
  addedEntries: MemoryEntryView[];
  updatedEntries: MemoryEntryView[];
}

/** Readable Markdown body of the kind:'dream-log' journal entry. */
export function buildDreamJournalMarkdown(input: DreamJournalInput): string {
  const { counts } = input;
  const lines: string[] = [`# 梦境 · ${input.today}`, ""];
  lines.push(
    `本次处理了 ${input.sessionsProcessed} 个会话${input.firstFull ? "（首次全量整理）" : ""}。`,
  );
  lines.push(
    `新增 ${counts.added} · 更新 ${counts.updated} · 删除 ${counts.deleted} · 跳过 ${counts.noop}${
      input.orphans > 0 ? ` · 丢弃孤儿操作 ${input.orphans}` : ""
    }`,
  );
  if (input.addedEntries.length > 0) {
    lines.push("", "## 新增记忆");
    for (const entry of input.addedEntries) {
      lines.push(`- **${entry.title}**：${firstLine(entry.contentMarkdown, 80)}`);
    }
  }
  if (input.updatedEntries.length > 0) {
    lines.push("", "## 更新记忆");
    for (const entry of input.updatedEntries) {
      lines.push(`- **${entry.title}**：${firstLine(entry.contentMarkdown, 80)}`);
    }
  }
  if (input.warnings.length > 0) {
    lines.push("", "## 警告");
    for (const warning of input.warnings) lines.push(`- ${warning}`);
  }
  return lines.join("\n");
}

// ---- IO orchestration -----------------------------------------------------------

/** Injectable seams so the pipeline is testable without Dexie/timers. */
export interface DreamDeps {
  listSessions(): Promise<DreamSessionRecord[]>;
  listMessages(session: DreamSessionRecord): Promise<DreamMessageRecord[]>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

// Extra fields the main process stamps on local-terminal capture records.
type LocalTerminalFields = {
  _source?: string;
  _cli_id?: string;
  _project_path?: string;
  _subagent_of?: unknown;
};

function vestiApi(): VestiDesktopApi | null {
  return typeof window !== "undefined" && window.vesti ? window.vesti : null;
}

/**
 * Session enumeration over the Dexie mirror — the same path the daily
 * pipeline uses (gatherDailyInputs): skip trash, skip subagent runs (they
 * fold into their parent conversation, daily A1). capture-core's
 * session_type != 'conversation' rows never reach Dexie as top-level records,
 * so the renderer-side equivalent of the session_type filter is exactly the
 * _subagent_of skip.
 */
async function listDexieDreamSessions(): Promise<DreamSessionRecord[]> {
  const records = (await db.conversations.toArray()) as Array<
    ConversationRecord & LocalTerminalFields
  >;
  const sessions: DreamSessionRecord[] = [];
  for (const record of records) {
    if (typeof record.id !== "number" || record.is_trash) continue;
    if (record._subagent_of) continue;
    sessions.push({
      id: record.id,
      sessionKey:
        typeof record._cli_id === "string" && record._cli_id
          ? record._cli_id
          : `browser:${record.id}`,
      title: record.title,
      platform: record.platform,
      projectLabel:
        typeof record._project_path === "string" && record._project_path
          ? record._project_path
          : null,
      activityAt: record.updated_at ?? record.created_at ?? 0,
      messageCount: record.message_count ?? 0,
    });
  }
  return sessions;
}

async function listDexieDreamMessages(
  session: DreamSessionRecord,
): Promise<DreamMessageRecord[]> {
  const messages = await listMessages(session.id).catch(() => []);
  return messages.map((message) => ({
    role: message.role === "user" ? "user" : "ai",
    contentText: message.content_text ?? "",
    toolName:
      typeof (message as { _tool_name?: unknown })._tool_name === "string"
        ? ((message as { _tool_name?: string })._tool_name as string)
        : null,
  }));
}

function defaultDreamDeps(): DreamDeps {
  return {
    listSessions: listDexieDreamSessions,
    listMessages: listDexieDreamMessages,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function emptyResult(firstFull: boolean): DreamRunResult {
  return {
    ok: true,
    firstFull,
    sessionsProcessed: 0,
    added: 0,
    updated: 0,
    deleted: 0,
    noop: 0,
  };
}

/** Agent-run sessionId anchor: the batch's first session id when it passes
 * the main-process validator (`/^[\w:.-]+$/`, length > 2), a fixed fallback
 * otherwise. */
function batchAnchor(batch: DreamBatch): string {
  const first = batch.sessionIds[0] ?? "";
  return /^[\w:.-]{3,240}$/.test(first) ? first : "dream:batch";
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

let dreamRunning = false;

/** One dream pass. Module-level single-flight: a second invocation while a
 * run is in flight resolves immediately with {ok:false}. */
export async function runDream(opts: {
  mode: DreamMode;
  onProgress?: (progress: DreamProgress) => void;
}): Promise<DreamRunResult> {
  return runDreamPipeline(opts, defaultDreamDeps());
}

export async function runDreamPipeline(
  opts: { mode: DreamMode; onProgress?: (progress: DreamProgress) => void },
  deps: DreamDeps,
): Promise<DreamRunResult> {
  if (dreamRunning) {
    return { ...emptyResult(false), ok: false, error: "dream already running" };
  }
  dreamRunning = true;
  try {
    const api = vestiApi();
    if (!api) {
      return { ...emptyResult(false), ok: false, error: "桌面环境不可用" };
    }
    const progress = opts.onProgress ?? ((): void => undefined);
    const today = todayDateString(deps.now());

    // ---- collect ------------------------------------------------------------
    progress({ phase: "collect", message: "正在收集待整理的会话…" });
    const firstFull =
      opts.mode === "full" ||
      (await api.getMemoryMeta(META_FIRST_FULL_DONE).catch(() => null)) !== "1";
    const lastSessionTs =
      Number((await api.getMemoryMeta(META_LAST_SESSION_TS).catch(() => null)) ?? 0) || 0;
    const sessions = selectDreamSessions(await deps.listSessions(), {
      full: firstFull,
      lastSessionTs,
    });
    if (sessions.length === 0) {
      // Nothing new: no LLM call, no journal. Stamp lastRunAt so the
      // scheduler treats today as done instead of re-checking every tick.
      await api.setMemoryMeta(META_LAST_RUN_AT, String(deps.now())).catch(() => undefined);
      if (firstFull) {
        await api.setMemoryMeta(META_FIRST_FULL_DONE, "1").catch(() => undefined);
      }
      return { ...emptyResult(firstFull), message: "没有新的对话需要整理" };
    }

    // ---- render + pack --------------------------------------------------------
    const blocks: DreamSessionBlock[] = [];
    for (const session of sessions) {
      const text = renderDreamSessionBlock(session, await deps.listMessages(session));
      if (text) {
        blocks.push({ sessionKey: session.sessionKey, activityAt: session.activityAt, text });
      }
    }
    // Watermark target: every selected session was inspected, including the
    // content-less ones we skipped — advancing past them avoids re-scanning.
    const maxSessionTs = sessions[sessions.length - 1].activityAt;
    if (blocks.length === 0) {
      await api.setMemoryMeta(META_LAST_RUN_AT, String(deps.now())).catch(() => undefined);
      await api.setMemoryMeta(META_LAST_SESSION_TS, String(maxSessionTs)).catch(() => undefined);
      if (firstFull) {
        await api.setMemoryMeta(META_FIRST_FULL_DONE, "1").catch(() => undefined);
      }
      return { ...emptyResult(firstFull), message: "没有包含用户内容的新对话" };
    }
    const batches = packDreamBatches(blocks);

    // ---- extract --------------------------------------------------------------
    // Parallel lanes: batches are independent; results are collected per batch
    // index so candidate order stays deterministic. `cursor++` between awaits
    // is safe (JS runs to completion between suspension points).
    console.info(`[dream] collect done: ${blocks.length} sessions -> ${batches.length} batches, extract with ${Math.min(DREAM_EXTRACT_LANES, batches.length)} lanes`);
    const candidates: DreamMemoryCandidate[] = [];
    const warnings: string[] = [];
    const laneResults: Array<DreamMemoryCandidate[] | null> = new Array(batches.length).fill(null);
    let cursor = 0;
    let finished = 0;
    let failures = 0;
    const worker = async (): Promise<void> => {
      while (cursor < batches.length) {
        const index = cursor;
        cursor += 1;
        progress({
          phase: "extract",
          batchIndex: finished,
          batchCount: batches.length,
          message: `正在提取记忆（完成 ${finished}/${batches.length}）…`,
        });
        const startedAt = deps.now();
        try {
          const result = await api.runAgent({
            kind: "dream-extract",
            sessionId: batchAnchor(batches[index]),
            transcriptOverride: batches[index].text,
            persist: false,
          });
          laneResults[index] = parseDreamExtractResult(result.content);
        } catch (error) {
          failures += 1;
          warnings.push(`批次 ${index + 1} 提取失败：${errorMessage(error)}`);
          laneResults[index] = [];
        }
        finished += 1;
        console.info(`[dream] extract batch ${index + 1}/${batches.length} done in ${Math.round((deps.now() - startedAt) / 1000)}s (${laneResults[index]?.length ?? 0} candidates)`);
        if (cursor < batches.length) await deps.sleep(DREAM_EXTRACT_DELAY_MS);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(DREAM_EXTRACT_LANES, batches.length) }, () => worker()),
    );
    for (const laneResult of laneResults) {
      if (laneResult) candidates.push(...laneResult);
    }
    if (candidates.length === 0 && failures === batches.length) {
      // Total extract outage: fail the run without touching the watermarks,
      // so the sessions are retried on the next pass.
      return {
        ...emptyResult(firstFull),
        ok: false,
        error: `所有批次提取失败（共 ${batches.length} 批）：${warnings[0] ?? ""}`,
      };
    }

    // ---- maintain ---------------------------------------------------------------
    const counts = { added: 0, updated: 0, deleted: 0, noop: 0 };
    let orphans = 0;
    const addedEntries: MemoryEntryView[] = [];
    const updatedEntries: MemoryEntryView[] = [];
    if (candidates.length > 0) {
      progress({ phase: "maintain", message: "正在合并长期记忆…" });
      console.info(`[dream] maintain: ${candidates.length} candidates`);
      const existing = await api
        .listMemoryEntries({ kind: "dream", status: "active", limit: DREAM_EXISTING_LIMIT })
        .catch(() => [] as MemoryEntryView[]);
      const byId = new Map(existing.map((entry) => [entry.id, entry]));
      const sourceSessionIds = dedupeStrings(
        candidates.flatMap((candidate) => candidate.session_ids),
      ).slice(0, 100);
      const rounds = chunkArray(candidates, DREAM_MAINTAIN_ROUND_SIZE).slice(
        0,
        DREAM_MAINTAIN_MAX_ROUNDS,
      );
      const overflow =
        candidates.length - DREAM_MAINTAIN_ROUND_SIZE * DREAM_MAINTAIN_MAX_ROUNDS;
      if (overflow > 0) {
        warnings.push(`候选记忆超出两轮合并容量，丢弃 ${overflow} 条`);
      }
      for (let round = 0; round < rounds.length; round += 1) {
        try {
          const result = await api.runAgent({
            kind: "dream-maintain",
            sessionId: batchAnchor(batches[0]),
            transcriptOverride: buildDreamMaintainTranscript(
              [...byId.values()],
              rounds[round],
            ),
            persist: false,
          });
          const applied = applyDreamMaintainOps(
            parseDreamMaintainResult(result.content),
            byId,
            { today, sourceSessionIds, now: deps.now() },
          );
          for (const entry of applied.upserts) await api.upsertMemoryEntry(entry);
          for (const id of applied.deletes) await api.deleteMemoryEntry(id);
          counts.added += applied.counts.added;
          counts.updated += applied.counts.updated;
          counts.deleted += applied.counts.deleted;
          counts.noop += applied.counts.noop;
          orphans += applied.orphans;
          addedEntries.push(...applied.addedEntries);
          updatedEntries.push(...applied.updatedEntries);
        } catch (error) {
          warnings.push(`第 ${round + 1} 轮记忆合并失败：${errorMessage(error)}`);
        }
      }
    }

    // ---- journal ------------------------------------------------------------------
    progress({ phase: "journal", message: "正在写入梦境日志…" });
    const journalId = `dream-log:${today}`;
    const previousJournal = (
      await api.getMemoryEntries([journalId]).catch(() => [] as MemoryEntryView[])
    )[0];
    const summary = `整理 ${blocks.length} 个会话：新增 ${counts.added} / 更新 ${counts.updated} / 删除 ${counts.deleted} / 跳过 ${counts.noop}`;
    const journal: MemoryEntryView = {
      id: journalId,
      kind: "dream-log",
      title: `梦境 · ${today}`,
      contentMarkdown: buildDreamJournalMarkdown({
        today,
        firstFull,
        sessionsProcessed: blocks.length,
        counts,
        orphans,
        warnings,
        addedEntries,
        updatedEntries,
      }),
      summary,
      scope: null,
      template: null,
      sourceSessionIds: blocks.map((block) => block.sessionKey).slice(0, 100),
      tags: ["dream-log"],
      version: previousJournal ? previousJournal.version + 1 : 1,
      prevId: null,
      lastOps: null,
      status: "active",
      entryDate: today,
      createdAt: previousJournal?.createdAt ?? deps.now(),
      updatedAt: deps.now(),
    };
    await api.upsertMemoryEntry(journal);

    // ---- watermarks (advanced even on partial failure; the journal records it) -----
    await api.setMemoryMeta(META_LAST_RUN_AT, String(deps.now()));
    await api.setMemoryMeta(META_LAST_SESSION_TS, String(maxSessionTs));
    await api.setMemoryMeta(META_FIRST_FULL_DONE, "1");
    console.info(`[dream] run done: ${summary}${warnings.length ? `, ${warnings.length} warnings` : ""}`);

    // Announce the finished run on the capsule bubble. Best-effort: a hidden
    // capsule, an open panel, or a partial window.vesti mock all fail silently
    // and never block the pipeline.
    try {
      const touched = counts.added + counts.updated + counts.deleted;
      await api.showCapsuleBubble?.({
        text:
          touched > 0
            ? `梦境整理好了：新增 ${counts.added} 条记忆，更新 ${counts.updated} 条`
            : `梦境整理好了：看过 ${blocks.length} 个会话，记忆没有新变化`,
        mood: "sleepy",
      });
    } catch {
      // The bubble is cosmetic; the run result below is what matters.
    }

    return {
      ok: true,
      firstFull,
      sessionsProcessed: blocks.length,
      added: counts.added,
      updated: counts.updated,
      deleted: counts.deleted,
      noop: counts.noop,
      journalEntryId: journalId,
      message: summary,
    };
  } catch (error) {
    return { ...emptyResult(false), ok: false, error: errorMessage(error) };
  } finally {
    dreamRunning = false;
  }
}
