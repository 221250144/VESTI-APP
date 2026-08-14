// Desktop implementation of the @vesti/ui StorageApi.
//
// In the Chrome extension this surface is an RPC client forwarding every call
// to the background/offscreen worker (storageService.ts). On desktop the
// renderer runs in the same process as the Dexie database, so each method
// calls the ported repository/promptRepository directly. AI-backed methods
// reuse the existing window.vesti agent IPC instead of the extension's LLM
// service; conversation export to Notion/Obsidian goes through the P3
// upstream modules (src/ui/upstream/*). Obsidian vault connection remains
// optional; Thinking Map similarity crosses the dedicated desktop IPC seam.

import type {
  ChatSummaryData,
  ConversationDigest,
  CreateDepositInput,
  DailyLog,
  DailyLogOverview,
  Deposit,
  DepositScope,
  DepositTemplate,
  ExtractPayload,
  ExtractResult,
  GenerateDepositInput,
  PromptExtractionResult,
  PromptScanCandidate,
  PromptScanProgress,
  PromptScanResult,
  RelayAvailability,
  RelayCliCommandView,
  RelayPack,
  RelayPackPayload,
  StorageApi,
  WeeklyReport,
} from "@vesti/ui";
import { mapThinkingMapSemanticSnapshot } from "./thinkingMapSemantics";
import { computeSummaryCoverage, learnRouteFingerprint, serializeRelayPackMarkdown } from "@vesti/ui";
import { askCompanion } from "../companion/companionService";
import type {
  ConversationTreeSession,
  SessionRecallHit,
  VestiDesktopApi,
} from "../../shared/contracts";
import { db } from "../db/schema";
import type { ConversationRecord } from "../db/schema";
import { loadConversationTree } from "../sync/conversationTree";
import { listConversationDigests } from "../sync/conversationDigests";
import {
  addExploreMessage,
  bulkAddTagToConversations,
  bulkSetConversationFlags,
  createExploreSession,
  createNote,
  createRelayPack,
  deleteAnnotation,
  deleteConversation,
  deleteExploreSession,
  deleteNote,
  deleteRelayPack,
  exportAllData,
  getAllSummaries,
  getAnnotationExportContext,
  getExploreMessages,
  getExploreSession,
  getNoteAsset,
  getRelayPack,
  getStorageUsage,
  getSummary as getSummaryRecord,
  getTopics,
  importObsidianDirectory,
  importObsidianZip,
  listAnnotations,
  listConversations,
  listDailyLogs,
  listExploreSessions,
  listMessages,
  listNotes,
  listRelayPacks,
  listWeeklyReports,
  moveTagAcrossConversations,
  removeTagFromConversations,
  renameTagAcrossConversations,
  saveAnnotation,
  saveSummary,
  updateConversation,
  updateConversationTitle,
  updateExploreMessageContext,
  updateExploreSession,
  updateNote,
} from "../db/repository";
// 记忆空间: deposits persist via the main-process memory_entries store (the
// Dexie deposits table remains as a pre-migration backup).
import {
  createDeposit,
  deleteDeposit,
  getDeposit,
  listDeposits,
  renameDeposit,
} from "../deposits/depositRepository";
import { isDreamAutoEnabled, runDream, setDreamAutoEnabled } from "../memory";
import {
  createPrompt,
  deletePrompt,
  extractPromptsFromLibrary,
  incrementPromptUsage,
  listPrompts,
  searchPrompts,
  togglePromptFavorite,
  updatePrompt,
} from "../db/promptRepository";
import type { ExtractedFragment } from "../db/promptRepository";
import {
  canonicalizeForHash,
  scanUserPromptInputs,
  type PromptScanUserInput,
} from "../db/promptlib";
import type { ConversationSummaryV2, RoundtableSeatTurn, SummaryRecord } from "../db/types";
import {
  aggregateRoundtable,
  buildModeratorTranscript,
  buildRoundtableRecordMarkdown,
  buildSeatTranscript,
  resolveRoundtablePersonas,
  ROUNDTABLE_MIN_SEATS,
} from "../roundtable/roundtable";
import {
  aggregateLearnDeepen,
  buildLearnDeepenRecordMarkdown,
  buildLearnDeepenTranscript,
  buildLearnRecallContext,
} from "../learn/learnDeepen";
import {
  createUiPrefsLearnSynthesisStore,
  synthesizeLearnRoutes,
} from "../learn/learnSynthesis";
import {
  parseConversationSummaryV2,
  renderSummaryPlainText,
} from "../aiti/parseSummary";
import { buildMessageFallbackDisplayText } from "../db/utils/messageContentPackage";
import {
  exportConversationToNotion,
  exportMarkdownPayloadToNotion,
} from "../upstream/notionExport";
import {
  exportConversationToObsidian,
  exportMarkdownPayloadToObsidian,
  getConfiguredObsidianVault,
} from "../upstream/obsidianExport";
import { sanitizeFileBaseName } from "../upstream/markdownSerializer";
import {
  buildRelayTranscript,
  RELAY_CONTEXT_BUDGET_CHARS,
  type RelayContextConversation,
  type RelayProjectMemory,
} from "../relay/relayContext";
import {
  extractRelayFileAnchors,
  type RelayFileAnchor,
} from "../relay/relayFiles";
import {
  distillAndMergeDeposit,
  nextDepositVersion,
  resolveScopeConversationIds,
  type ScopeResolutionData,
} from "../deposits/deposits";
import {
  generateDailyLog as generateDailyLogService,
  generateWeeklyReport as generateWeeklyReportService,
  getDailyLogOverview as getDailyLogOverviewService,
} from "../daily/dailyService";
import {
  DAILY_TIME_PREF_KEY,
  computePendingDailyDates,
  normalizeDailyTime,
} from "../daily/dailyScheduler";
import { todayDateString } from "../daily/dailyActivity";

// Extra fields the main process stamps on local-terminal capture records;
// they ride along in Dexie but are not part of the extension's record types.
type LocalTerminalFields = {
  _source?: string;
  _cli_id?: string;
};

// Sources element type of the askKnowledgeBase contract, derived so this file
// only needs the StorageApi surface from @vesti/ui.
type RagSources = Awaited<
  ReturnType<NonNullable<StorageApi["askKnowledgeBase"]>>
>["sources"];

type ThinkingMapSemanticSnapshot = Awaited<
  ReturnType<NonNullable<StorageApi['getThinkingMapSemantics']>>
>;

function vestiApi(): VestiDesktopApi | null {
  return typeof window !== "undefined" && window.vesti ? window.vesti : null;
}

async function getConversationCliId(
  conversationId: number
): Promise<{ cliId: string | null; title: string; updatedAt: number } | null> {
  const record = (await db.conversations.get(conversationId)) as
    | (ConversationRecord & LocalTerminalFields)
    | undefined;
  if (!record) {
    return null;
  }
  return {
    cliId: typeof record._cli_id === "string" ? record._cli_id : null,
    title: record.title,
    updatedAt: record.updated_at ?? Date.now(),
  };
}

async function getThinkingMapSemanticsImpl(
  conversationIds: number[]
): Promise<ThinkingMapSemanticSnapshot> {
  const uniqueIds = [...new Set(
    conversationIds.filter((id) => Number.isInteger(id) && id >= 0)
  )];
  const total = uniqueIds.length;
  const records = total > 0
    ? await db.conversations.where('id').anyOf(uniqueIds).toArray()
    : [];
  const sessionIdByConversationId = new Map<number, string>();
  records
    .filter((record): record is ConversationRecord & LocalTerminalFields & { id: number } =>
      typeof record.id === 'number'
    )
    .sort((left, right) => left.id - right.id)
    .forEach((record) => {
      if (typeof record._cli_id !== 'string' || !record._cli_id.trim()) return;
      sessionIdByConversationId.set(record.id, record._cli_id);
    });

  const api = vestiApi();
  if (!api) return mapThinkingMapSemanticSnapshot(null, sessionIdByConversationId, total);

  const result = await api
    .getThinkingMapSemantics(
      [...new Set(sessionIdByConversationId.values())],
      total
    )
    .catch(() => null);
  return mapThinkingMapSemanticSnapshot(result, sessionIdByConversationId, total);
}

// ---- Summary mapping -------------------------------------------------------
// Lightweight local equivalent of the extension's insightAdapter: it covers
// the structured-v2 path and the plain-text fallback path with English
// defaults, which is everything the desktop pipeline can produce.

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function dedupeLines(items: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const item of items) {
    const normalized = normalizeText(item);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(normalized);
  }
  return output;
}

function toContentLines(text: string): string[] {
  return dedupeLines(
    text
      .split(/\r?\n/)
      .map((line) => line.replace(/^[-*\d.)\s]+/, "").trim())
      .filter((line) => line.length > 0)
  );
}

function inferUnresolved(lines: string[]): string[] {
  return lines
    .filter((line) => /unresolved|open|pending|risk|unknown|todo|block/i.test(line))
    .slice(0, 4);
}

function isConversationSummaryV2(value: unknown): value is ConversationSummaryV2 {
  if (!value || typeof value !== "object") return false;
  const row = value as { core_question?: unknown; thinking_journey?: unknown };
  return typeof row.core_question === "string" && Array.isArray(row.thinking_journey);
}

function summaryRecordToChatSummaryData(
  record: SummaryRecord,
  conversationTitle?: string
): ChatSummaryData {
  const generatedAt = new Date(record.createdAt).toISOString();
  const title = conversationTitle ?? "Conversation Summary";
  const structured = record.structured;

  if (isConversationSummaryV2(structured)) {
    return {
      meta: {
        title,
        generated_at: generatedAt,
        tags: ["General"],
        fallback: record.status === "fallback",
      },
      core_question: normalizeText(structured.core_question),
      thinking_journey: structured.thinking_journey
        .map((step, index) => ({
          step: Number.isFinite(step.step) ? Math.max(1, Math.floor(step.step)) : index + 1,
          speaker: step.speaker === "AI" ? ("AI" as const) : ("User" as const),
          assertion: normalizeText(step.assertion),
          real_world_anchor: step.real_world_anchor
            ? normalizeText(step.real_world_anchor)
            : null,
        }))
        .filter((step) => step.assertion.length > 0)
        .slice(0, 10),
      key_insights: (structured.key_insights ?? [])
        .map((item) => ({
          term: normalizeText(item.term),
          definition: normalizeText(item.definition),
        }))
        .filter((item) => item.term && item.definition)
        .slice(0, 8),
      unresolved_threads: dedupeLines(structured.unresolved_threads ?? []).slice(0, 6),
      meta_observations: {
        thinking_style:
          normalizeText(String(structured.meta_observations?.thinking_style ?? "")) ||
          "Drills down step by step, tightening scope with each question.",
        emotional_tone:
          normalizeText(String(structured.meta_observations?.emotional_tone ?? "")) ||
          "Cautious yet curious, continuously validating key assumptions.",
        depth_level:
          structured.meta_observations?.depth_level === "deep" ||
          structured.meta_observations?.depth_level === "superficial"
            ? structured.meta_observations.depth_level
            : "moderate",
      },
      actionable_next_steps: dedupeLines(structured.actionable_next_steps ?? []).slice(0, 6),
      plain_text: record.content,
    };
  }

  const lines = toContentLines(record.content);
  const firstLine = lines[0] ?? title;
  const secondLine = lines[1] ?? lines[0] ?? "No stable conclusion yet.";

  return {
    meta: {
      title,
      generated_at: generatedAt,
      tags: ["General"],
      fallback: true,
    },
    core_question: conversationTitle
      ? `Core question in this conversation: ${conversationTitle}`
      : firstLine,
    thinking_journey: [
      { step: 1, speaker: "User", assertion: firstLine, real_world_anchor: null },
      { step: 2, speaker: "AI", assertion: secondLine, real_world_anchor: null },
    ],
    key_insights: lines.slice(0, 5).map((line, index) => ({
      term: `Insight ${index + 1}`,
      definition: line,
    })),
    unresolved_threads: inferUnresolved(lines),
    meta_observations: {
      thinking_style: "Sample is sparse; stable thinking-style inference is unavailable.",
      emotional_tone: "Sample is sparse; tone is treated as neutral.",
      depth_level: "superficial",
    },
    actionable_next_steps: lines
      .filter((line) => /next|todo|action|follow-up/i.test(line))
      .slice(0, 4),
    plain_text: record.content,
  };
}

// ---- Annotation → note export ---------------------------------------------
// Port of the MyNotes half of the extension's annotationExportService (the
// Notion half has no desktop equivalent).

const ANNOTATION_NOTE_HEADER = "# Annotation Review";
const ANNOTATION_TIMELINE_HEADER = "## Annotation Timeline";

function formatLocalDate(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "Unknown date";
  }
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(new Date(value));
}

function truncate(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 1))}…`;
}

function buildAnnotationMarker(annotationId: number): string {
  return `<!-- vesti-annotation-id:${annotationId} -->`;
}

function buildAnnotationEntry(
  annotationId: number,
  data: Awaited<ReturnType<typeof getAnnotationExportContext>>
): string {
  const roleLabel = data.message.role === "user" ? "You" : data.conversation.platform;

  return [
    `### ${formatLocalDate(data.annotation.created_at)} · ${data.annotation.days_after} ${
      data.annotation.days_after === 1 ? "day" : "days"
    } after`,
    "",
    buildAnnotationMarker(annotationId),
    "",
    `#### Anchor Message`,
    "",
    `Role: ${roleLabel}`,
    "",
    buildMessageFallbackDisplayText(data.message),
    "",
    `#### Annotation`,
    "",
    data.annotation.content_text,
  ].join("\n");
}

function buildAnnotationNoteContent(
  annotationId: number,
  data: Awaited<ReturnType<typeof getAnnotationExportContext>>
): string {
  const conversationDate = data.conversation.source_created_at ?? data.conversation.created_at;

  return [
    ANNOTATION_NOTE_HEADER,
    "",
    `Conversation: ${data.conversation.title}`,
    `Platform: ${data.conversation.platform}`,
    `Conversation Date: ${formatLocalDate(conversationDate)}`,
    ...(data.conversation.url ? [`Source URL: ${data.conversation.url}`] : []),
    "",
    ANNOTATION_TIMELINE_HEADER,
    "",
    buildAnnotationEntry(annotationId, data),
  ].join("\n");
}

async function exportAnnotationToMyNotes(annotationId: number) {
  const context = await getAnnotationExportContext(annotationId);
  const notes = await listNotes();
  const existingNote = notes.find(
    (note) =>
      note.linked_conversation_ids.includes(context.conversation.id) &&
      note.content.includes(ANNOTATION_NOTE_HEADER) &&
      note.content.includes(ANNOTATION_TIMELINE_HEADER)
  );
  const annotationIdMarker = buildAnnotationMarker(annotationId);

  if (existingNote) {
    if (existingNote.content.includes(annotationIdMarker)) {
      return existingNote;
    }

    const trimmed = existingNote.content.trimEnd();
    const entry = buildAnnotationEntry(annotationId, context);
    return updateNote(existingNote.id, {
      content: trimmed ? `${trimmed}\n\n---\n\n${entry}` : entry,
    });
  }

  return createNote({
    title: truncate(`Annotations - ${context.conversation.title}`, 96) || "Annotations",
    content: buildAnnotationNoteContent(annotationId, context),
    linked_conversation_ids: [context.conversation.id],
  });
}

// ---- AI-backed methods (window.vesti agent IPC) ----------------------------

/** Transcript budget for summarizing browser-captured conversations through
 * the override channel — the main process caps summary overrides at 30K. */
const WEB_SUMMARY_TRANSCRIPT_BUDGET = 24_000;

/** Serialize a Dexie conversation (browser capture, no local capture-store
 * session) into a role-tagged transcript the summary agent can read. Oversized
 * threads keep the head and tail — the question and the landing matter most. */
async function buildWebSummaryTranscript(
  conversationId: number,
  title: string
): Promise<string> {
  const messages = await listMessages(conversationId).catch(() => []);
  const lines: string[] = [];
  for (const message of messages) {
    const text = (message.content_text ?? "").trim();
    if (!text) continue;
    const role = message.role === "user" ? "用户" : "AI";
    lines.push(`${role}: ${text.length > 1200 ? `${text.slice(0, 1200)}…` : text}`);
  }
  if (lines.length === 0) return "";
  const header = `### 会话（浏览器捕获）\n标题: ${title || "未命名会话"}`;
  const body = lines.join("\n");
  if (body.length <= WEB_SUMMARY_TRANSCRIPT_BUDGET) return `${header}\n\n${body}`;
  const head = body.slice(0, Math.floor(WEB_SUMMARY_TRANSCRIPT_BUDGET * 0.6));
  const tail = body.slice(-Math.floor(WEB_SUMMARY_TRANSCRIPT_BUDGET * 0.35));
  const omitted = body.length - head.length - tail.length;
  return `${header}\n\n${head}\n\n…（中间约 ${omitted} 字略）…\n\n${tail}`;
}

/** Re-entrancy guard: the batch progress state lives in the explore
 * dashboard and resets when the user switches top-level pages, so a second
 * click could otherwise spawn a duplicate pool over the same backlog. */
const summaryInFlight = new Set<number>();

async function generateSummaryImpl(conversationId: number): Promise<ChatSummaryData> {
  if (summaryInFlight.has(conversationId)) {
    throw new Error("SUMMARY_ALREADY_RUNNING");
  }
  summaryInFlight.add(conversationId);
  try {
    return await generateSummaryInner(conversationId);
  } finally {
    summaryInFlight.delete(conversationId);
  }
}

async function generateSummaryInner(conversationId: number): Promise<ChatSummaryData> {
  const info = await getConversationCliId(conversationId);
  if (!info) {
    throw new Error("CONVERSATION_NOT_FOUND");
  }
  const title = info.title;

  const api = vestiApi();
  // Browser-captured conversations have no local capture-store session, but
  // their Dexie messages serialize into a transcriptOverride the summary
  // agent can run against — the cli id is no longer a coverage gate.
  const webTranscript =
    api && !info.cliId ? await buildWebSummaryTranscript(conversationId, title) : "";
  if (!api || (!info.cliId && !webTranscript.trim())) {
    // Non-Electron environment or an empty conversation: return an honest
    // placeholder instead of failing.
    return summaryRecordToChatSummaryData(
      {
        id: 0,
        conversationId,
        content: title,
        structured: null,
        format: "fallback_plain_text",
        status: "fallback",
        modelId: "unavailable",
        createdAt: Date.now(),
        sourceUpdatedAt: info.updatedAt,
      },
      title
    );
  }

  const result = await api.runAgent(
    info.cliId
      ? { kind: "summary", sessionId: info.cliId }
      : {
          kind: "summary",
          sessionId: `web-summary:${conversationId}`,
          transcriptOverride: webTranscript,
        }
  );
  // The summary agent answers with ConversationSummaryV2 JSON (validated +
  // normalized by the parser); prose output degrades to the legacy
  // plain-text fallback write instead of failing.
  const structured = parseConversationSummaryV2(result.content);
  const saved = await saveSummary({
    conversationId,
    content: structured ? renderSummaryPlainText(structured) : result.content,
    structured: structured ?? null,
    format: structured ? "structured_v1" : "fallback_plain_text",
    status: structured ? "ok" : "fallback",
    ...(structured ? { schemaVersion: "conversation_summary.v2" as const } : {}),
    modelId: result.modelId,
    createdAt: result.createdAt || Date.now(),
    sourceUpdatedAt: info.updatedAt,
  });
  // Summaries feed derived views that refresh on "vesti:data-updated" (AITI
  // profile, sphere emotion colors); a manual summary write must signal too,
  // otherwise those views stay stale until the next capture sync.
  window.dispatchEvent(new CustomEvent("vesti:data-updated"));
  return summaryRecordToChatSummaryData(saved, result.sessionTitle || title);
}

const NO_CONTEXT_ANSWER =
  "Please choose at least one conversation first — the desktop explore agent answers questions against a selected local session.";

// ---- P1.5: conversation digests + cross-session recall --------------------

/** Digest rows for every local-terminal conversation live in
 * src/ui/sync/conversationDigests.ts (shared with the P4c daily pipeline). */

/** Map recalled CLI sessions back to renderer conversation records, keeping
 * the recall ranking and normalizing scores to [0, 1] for the sources UI.
 * A1: a hit that surfaced through a subagent session maps to the parent's
 * conversation record and is flagged fromSubagent for the "（来自子代理）"
 * badge; duplicate parent entries are folded (first/best-ranked wins). */
async function recallSources(hits: SessionRecallHit[]): Promise<RagSources> {
  const records = (await db.conversations.toArray()) as Array<
    ConversationRecord & LocalTerminalFields
  >;
  const conversationByCliId = new Map<string, ConversationRecord & LocalTerminalFields>();
  for (const record of records) {
    if (typeof record._cli_id === "string") conversationByCliId.set(record._cli_id, record);
  }
  const maxScore = Math.max(...hits.map((hit) => hit.score), Number.EPSILON);
  const sources: RagSources = [];
  const seenConversationIds = new Set<number>();
  for (const hit of hits) {
    const record = conversationByCliId.get(hit.attributedSessionId ?? hit.sessionId);
    if (record?.id === undefined || seenConversationIds.has(record.id)) continue;
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

// ---- P4a AI relay (handoff packs) -----------------------------------------
// Multi-select → condensed context → relay agent (persist:false) → Dexie
// relay_packs. Everything IO-bound lives here; budget/serialization logic is
// pure (src/ui/relay/relayContext, @vesti/ui serializeRelayPackMarkdown).

/** Only the tail of each conversation feeds the context; the pure assembler
 * further caps it to the most recent few messages within budget. */
const RELAY_MESSAGE_FETCH_LIMIT = 40;

function normalizeSelectedIds(conversationIds: number[]): number[] {
  return [...new Set(conversationIds)].filter(
    (id) => Number.isInteger(id) && id > 0
  );
}

/**
 * Gather the condensed per-conversation context (digest → summary → snippet
 * head + recent messages) for a selection, in the caller's selection order.
 * Shared by the relay / extract / distill pipelines (P4a/P4b).
 */
async function gatherRelayContexts(
  uniqueIds: number[]
): Promise<RelayContextConversation[]> {
  const [records, digests, summaries] = await Promise.all([
    db.conversations.where("id").anyOf(uniqueIds).toArray(),
    listConversationDigests().catch(() => []),
    getAllSummaries().catch(() => []),
  ]);
  const digestById = new Map(digests.map((digest) => [digest.conversationId, digest]));
  const summaryById = new Map<number, { content: string; createdAt: number }>();
  for (const summary of summaries) {
    const existing = summaryById.get(summary.conversationId);
    if (!existing || summary.createdAt > existing.createdAt) {
      summaryById.set(summary.conversationId, {
        content: summary.content,
        createdAt: summary.createdAt,
      });
    }
  }
  // Keep the caller's selection order for a stable, predictable transcript.
  const ordered = uniqueIds
    .map((id) => records.find((record) => record.id === id))
    .filter((record): record is NonNullable<typeof record> => Boolean(record));
  if (ordered.length === 0) {
    throw new Error("所选会话不存在，请刷新列表后重试");
  }

  // P4a v2: per-session git fields + the full digest (open_questions) live in
  // the capture store and never reach the cached tree — pull them via IPC.
  const cliIdByConversationId = new Map<number, string>();
  for (const record of ordered) {
    const cliId = (record as LocalTerminalFields)._cli_id;
    if (typeof record.id === "number" && typeof cliId === "string") {
      cliIdByConversationId.set(record.id, cliId);
    }
  }
  const api = vestiApi();
  const sessionContexts = api && cliIdByConversationId.size > 0
    ? await api
        .getRelaySessionContexts([...cliIdByConversationId.values()])
        .catch(() => [])
    : [];
  const sessionContextByCliId = new Map(
    sessionContexts.map((context) => [context.sessionId, context])
  );

  // A1: subagent briefs per selected session, from the (cached) tree — the
  // children carry title + digest one-liner, exactly the rollup the pure
  // head assembler needs. Missing tree ⇒ no rollup, never an error.
  const subagentsByCliId = new Map<
    string,
    Array<{ role?: string | null; title: string; oneLiner?: string | null }>
  >();
  if (cliIdByConversationId.size > 0) {
    const tree = await loadConversationTree().catch(() => null);
    const wanted = new Set(cliIdByConversationId.values());
    const visit = (session: ConversationTreeSession): void => {
      if (wanted.has(session.id) && (session.children?.length ?? 0) > 0) {
        subagentsByCliId.set(
          session.id,
          (session.children ?? []).map((child) => ({
            role: child.subagentRole ?? null,
            title: child.title,
            oneLiner: child.oneLiner,
          }))
        );
      }
      for (const child of session.children ?? []) visit(child);
    };
    for (const source of tree?.sources ?? []) {
      for (const project of source.projects) {
        for (const session of project.sessions) visit(session);
      }
    }
  }

  const contexts: RelayContextConversation[] = [];
  for (const record of ordered) {
    const id = record.id as number;
    const messages = await listMessages(id).catch(() => []);
    const cliId = cliIdByConversationId.get(id);
    const sessionContext = cliId ? sessionContextByCliId.get(cliId) : undefined;
    const treeDigest = digestById.get(id) ?? null;
    const fullDigest = sessionContext?.digest ?? null;
    // Tree digest wins on the fields it carries; open_questions only exists
    // in the capture-store digest.
    const digest =
      treeDigest || fullDigest
        ? {
            oneLiner: treeDigest?.oneLiner ?? fullDigest?.oneLiner ?? null,
            keyTopics: treeDigest?.keyTopics ?? fullDigest?.keyTopics ?? [],
            keyFiles: treeDigest?.keyFiles?.length
              ? treeDigest.keyFiles
              : fullDigest?.keyFiles ?? [],
            decisions: treeDigest?.decisions?.length
              ? treeDigest.decisions
              : fullDigest?.decisions ?? [],
            openQuestions: fullDigest?.openQuestions ?? [],
          }
        : null;
    contexts.push({
      id,
      title: record.title,
      platform: record.platform,
      digest,
      git: sessionContext
        ? { branch: sessionContext.gitBranch, remote: sessionContext.gitRemote }
        : null,
      summary: summaryById.get(id)?.content ?? null,
      snippet: record.snippet ?? null,
      messages: messages
        .slice(-RELAY_MESSAGE_FETCH_LIMIT)
        .map((message) => ({ role: message.role, content: message.content_text })),
      ...(cliId && subagentsByCliId.has(cliId)
        ? { subagents: subagentsByCliId.get(cliId) }
        : {}),
    });
  }
  return contexts;
}

/**
 * Deterministic key-file anchors (P4a quality): aggregate the captured
 * file-tool touches of the selected sessions into a grounded file list.
 * Subagent sessions fold into their selected parent (A1) — their touches are
 * attributed to the parent conversation. Returns [] when the capture bridge
 * or the tool data is unavailable; the transcript then simply omits the
 * anchor block.
 */
async function gatherRelayFileAnchors(
  cliIdByConversationId: Map<number, string>
): Promise<RelayFileAnchor[]> {
  const api = vestiApi();
  if (!api || cliIdByConversationId.size === 0) return [];
  const conversationIdByCliId = new Map<string, number>();
  for (const [conversationId, cliId] of cliIdByConversationId) {
    conversationIdByCliId.set(cliId, conversationId);
  }
  const tree = await loadConversationTree({ force: true }).catch(() => null);
  if (tree) {
    const collectDescendantIds = (
      session: ConversationTreeSession,
      into: string[]
    ): void => {
      for (const child of session.children ?? []) {
        into.push(child.id);
        collectDescendantIds(child, into);
      }
    };
    for (const source of tree.sources) {
      for (const project of source.projects) {
        for (const session of project.sessions) {
          const parentConversationId = conversationIdByCliId.get(session.id);
          if (parentConversationId === undefined) continue;
          const descendantIds: string[] = [];
          collectDescendantIds(session, descendantIds);
          for (const id of descendantIds) {
            if (!conversationIdByCliId.has(id)) {
              conversationIdByCliId.set(id, parentConversationId);
            }
          }
        }
      }
    }
  }
  // Selected sessions first (Map insertion order), descendants fill the rest
  // up to the main-process fan-out cap.
  const rows = await api
    .getRelayFileTouches([...conversationIdByCliId.keys()].slice(0, 200))
    .catch(() => []);
  return extractRelayFileAnchors(
    rows,
    (sessionId) => conversationIdByCliId.get(sessionId) ?? null
  );
}

/** Rebuild the conversation-id → capture-session-id map for a selection. */
async function mapSelectedCliIds(
  uniqueIds: number[]
): Promise<Map<number, string>> {
  const records = await db.conversations.where("id").anyOf(uniqueIds).toArray();
  const map = new Map<number, string>();
  for (const record of records) {
    const cliId = (record as LocalTerminalFields)._cli_id;
    if (typeof record.id === "number" && typeof cliId === "string") {
      map.set(record.id, cliId);
    }
  }
  return map;
}

/**
 * Project memory (memory v2) for the relay transcript: resolve the projects
 * the selection touches via the source tree, then pull each project's L0
 * state card and L2 brief over IPC. Best-effort — any missing piece (tree,
 * states, briefs) simply narrows the block; failures never abort the relay.
 */
async function gatherRelayProjectMemory(
  cliIdByConversationId: Map<number, string>
): Promise<RelayProjectMemory[]> {
  const api = vestiApi();
  if (!api || cliIdByConversationId.size === 0) return [];
  const tree = await loadConversationTree().catch(() => null);
  if (!tree) return [];
  const wanted = new Set(cliIdByConversationId.values());
  const sessionMatches = (session: ConversationTreeSession): boolean =>
    wanted.has(session.id) ||
    (session.children ?? []).some(sessionMatches);
  const projects: Array<{ projectKey: string; label: string }> = [];
  const seen = new Set<string>();
  for (const source of tree.sources) {
    for (const project of source.projects) {
      if (seen.has(project.projectKey)) continue;
      if (!project.sessions.some(sessionMatches)) continue;
      seen.add(project.projectKey);
      projects.push({ projectKey: project.projectKey, label: project.label });
      if (projects.length >= 2) break;
    }
    if (projects.length >= 2) break;
  }
  if (projects.length === 0) return [];
  const states = await api.getProjectStates().catch(() => []);
  const stateByKey = new Map(states.map((state) => [state.projectKey, state]));
  const memory: RelayProjectMemory[] = [];
  for (const project of projects) {
    const brief = await api.getProjectBrief(project.projectKey).catch(() => null);
    const state = stateByKey.get(project.projectKey) ?? null;
    if (!state && !brief?.contentMarkdown?.trim()) continue;
    memory.push({
      label: project.label,
      state,
      briefMarkdown: brief?.contentMarkdown ?? null,
    });
  }
  return memory;
}

async function generateRelayPackImpl(conversationIds: number[]): Promise<RelayPack> {
  const api = vestiApi();
  if (!api) {
    throw new Error("桌面环境不可用，无法生成交接包");
  }
  const uniqueIds = normalizeSelectedIds(conversationIds);
  if (uniqueIds.length === 0) {
    throw new Error("请先选择至少一个会话");
  }

  const contexts = await gatherRelayContexts(uniqueIds);
  const cliIdByConversationId = await mapSelectedCliIds(uniqueIds);
  // Ground the pack's key-files section on captured tool executions instead
  // of model recollection; the anchors also persist on the pack so the panel
  // can badge every key_files row as anchored vs. to-be-verified.
  const fileAnchors = await gatherRelayFileAnchors(cliIdByConversationId);
  // Inject the L0/L2 project memory: the pack's job is to summarize the
  // project state, and the memory layers hold exactly that, cross-session.
  const projectMemory = await gatherRelayProjectMemory(cliIdByConversationId);
  const transcript = buildRelayTranscript(contexts, RELAY_CONTEXT_BUDGET_CHARS, {
    fileAnchors,
    projectMemory,
  });
  const result = await api.runAgent({
    kind: "relay",
    // No capture-store session backs a multi-selection; the pre-built
    // transcript carries everything (same pattern as the classify pipeline).
    sessionId: `relay:${Date.now()}`,
    transcriptOverride: transcript,
    persist: false,
  });
  const payload = JSON.parse(result.content) as RelayPackPayload;
  if (fileAnchors.length > 0) {
    payload.extracted_key_files = fileAnchors.map((anchor) => ({
      path: anchor.path,
      touches: anchor.touches,
      lastTouchedAt: anchor.lastTouchedAt,
      conversationIds: anchor.conversationIds,
    }));
  }
  return createRelayPack({
    title: payload.title,
    conversationIds: contexts.map((context) => context.id),
    pack: payload,
    suggestedPrompt: payload.suggested_prompt,
  });
}

async function requireRelayPack(id: number): Promise<RelayPack> {
  const pack = await getRelayPack(id);
  if (!pack) {
    throw new Error("交接包不存在，可能已被删除");
  }
  return pack;
}

async function exportRelayPackMarkdownImpl(
  id: number
): Promise<{ relativePath: string } | null> {
  const api = vestiApi();
  if (!api) throw new Error("桌面环境不可用，无法导出交接包");
  const pack = await requireRelayPack(id);
  const markdown = serializeRelayPackMarkdown(pack);
  const directory = await api.chooseDirectory("选择交接包导出目录");
  if (!directory) return null;
  const relativePath = `VestiRelay/${sanitizeFileBaseName(pack.title)}-${pack.id}.md`;
  await api.writeUpstreamFile({ rootPath: directory, relativePath, content: markdown });
  return { relativePath };
}

async function getRelayPackCliCommandsImpl(id: number): Promise<RelayCliCommandView[]> {
  const api = vestiApi();
  if (!api) throw new Error("桌面环境不可用，无法生成启动命令");
  const pack = await requireRelayPack(id);
  const markdown = serializeRelayPackMarkdown(pack);
  const result = await api.prepareRelayCliCommands({
    id: pack.id,
    slug: pack.title,
    markdown,
  });
  return result.commands;
}

async function deliverRelayPackToBrowserImpl(id: number): Promise<void> {
  const api = vestiApi();
  if (!api) throw new Error("桌面环境不可用，无法投递到浏览器");
  const pack = await requireRelayPack(id);
  await api.enqueueRelayOutbox({ prompt: pack.suggestedPrompt });
}

async function getRelayAvailabilityImpl(): Promise<RelayAvailability> {
  const api = vestiApi();
  if (!api) return { llmConfigured: false, extensionConnected: false };
  const [settingsView, bridgeStatus] = await Promise.all([
    api.getSettings().catch(() => null),
    api.getExtensionBridgeStatus().catch(() => null),
  ]);
  const llmConfigured = settingsView
    ? settingsView.llm.mode === "demo_proxy" || settingsView.llm.apiKeyConfigured
    : false;
  return {
    llmConfigured,
    extensionConnected: (bridgeStatus?.clients.length ?? 0) > 0,
  };
}

// ---- P4b knowledge extract + deposits --------------------------------------
// Extract reuses the relay context assembly (multi-select → condensed
// transcript) but distills reusable knowledge assets instead of a handoff
// pack; the result is persisted on demand as a deposits row (template
// 'extract'). Deposits distillation resolves a scope (project / topic /
// time window / manual selection) to conversations, runs the distill agent
// and stores the Markdown body with a version chain.

const DEPOSIT_TEMPLATE_LABELS: Record<DepositTemplate, string> = {
  background_knowledge: "个人背景知识",
  project_state: "项目开发状态",
  writing_style: "写作风格",
  extract: "知识提取",
  custom: "自定义提炼",
};

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function toLocalDate(value: number): string {
  const d = new Date(value);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function describeDepositScope(scope: DepositScope): string {
  switch (scope.kind) {
    case "project":
      return `项目 ${scope.label}`;
    case "topic":
      return `话题 ${scope.label}`;
    case "timerange":
      // The one-click sweep distils the whole history as [0, now]; render it
      // as "全部会话" instead of a 1970 start date.
      return scope.start <= 0
        ? "全部会话"
        : `${toLocalDate(scope.start)} ~ ${toLocalDate(scope.end)}`;
    case "selection":
      return `手动选择 ${scope.conversationIds.length} 个会话`;
  }
}

async function generateExtractImpl(conversationIds: number[]): Promise<ExtractResult> {
  const api = vestiApi();
  if (!api) {
    throw new Error("桌面环境不可用，无法生成知识提取");
  }
  const uniqueIds = normalizeSelectedIds(conversationIds);
  if (uniqueIds.length === 0) {
    throw new Error("请先选择至少一个会话");
  }

  const contexts = await gatherRelayContexts(uniqueIds);
  const transcript = buildRelayTranscript(contexts);
  const result = await api.runAgent({
    kind: "extract",
    sessionId: `extract:${Date.now()}`,
    transcriptOverride: transcript,
    persist: false,
  });
  const extract = JSON.parse(result.content) as ExtractPayload;
  const firstTitle = truncate(contexts[0]?.title ?? "", 20) || "未命名会话";
  const title = contexts.length > 1
    ? `知识提取 · ${firstTitle} 等 ${contexts.length} 个会话`
    : `知识提取 · ${firstTitle}`;
  return { title, conversationIds: contexts.map((context) => context.id), extract };
}

/** Conversations + tree in the shape the pure scope resolver expects. */
async function gatherScopeResolutionData(): Promise<ScopeResolutionData> {
  const [records, tree] = await Promise.all([
    db.conversations.toArray() as Promise<Array<ConversationRecord & LocalTerminalFields>>,
    loadConversationTree({ force: true }).catch(() => null),
  ]);
  return {
    conversations: records
      .filter((record) => typeof record.id === "number")
      .map((record) => ({
        id: record.id as number,
        topic_id: record.topic_id ?? null,
        updated_at: record.updated_at ?? null,
        _cli_id: typeof record._cli_id === "string" ? record._cli_id : null,
      })),
    tree,
  };
}

async function resolveDepositScopeImpl(scope: DepositScope): Promise<number[]> {
  const data = await gatherScopeResolutionData();
  return resolveScopeConversationIds(scope, data);
}

async function generateDepositImpl(input: GenerateDepositInput): Promise<Deposit> {
  const api = vestiApi();
  if (!api) {
    throw new Error("桌面环境不可用，无法生成沉淀");
  }
  const conversationIds = await resolveDepositScopeImpl(input.scope);
  if (conversationIds.length === 0) {
    throw new Error("该范围内没有会话，请调整范围后重试");
  }

  const contexts = await gatherRelayContexts(conversationIds);
  const transcript = buildRelayTranscript(contexts);

  // Regeneration chains onto the previous head as version+1. With a previous
  // version the fresh distillation is merged mem0-style (ops recorded on the
  // new row); without one the distillation is stored as-is.
  const previous = input.previousId ? await getDeposit(input.previousId) : null;
  const merged = await distillAndMergeDeposit(
    { run: (request) => api.runAgent(request) },
    {
      sessionId: `distill:${Date.now()}`,
      template: input.template,
      customInstruction: input.customInstruction?.trim() || undefined,
      transcript,
      previousContent: previous?.contentMarkdown ?? null,
    }
  );
  const { version, prevId } = nextDepositVersion(previous);
  return createDeposit({
    template: input.template,
    title: `${DEPOSIT_TEMPLATE_LABELS[input.template]} · ${describeDepositScope(input.scope)}`,
    scope: input.scope,
    contentMarkdown: merged.contentMarkdown,
    version,
    prevId,
    customInstruction: input.customInstruction?.trim() || null,
    lastOps: merged.ops,
  });
}

async function exportDepositMarkdownImpl(
  id: number
): Promise<{ relativePath: string } | null> {
  const api = vestiApi();
  if (!api) throw new Error("桌面环境不可用，无法导出沉淀");
  const deposit = await getDeposit(id);
  if (!deposit) {
    throw new Error("沉淀不存在，可能已被删除");
  }
  const directory = await api.chooseDirectory("选择沉淀导出目录");
  if (!directory) return null;
  const relativePath = `VestiDeposits/${sanitizeFileBaseName(deposit.title)}-v${deposit.version}.md`;
  await api.writeUpstreamFile({
    rootPath: directory,
    relativePath,
    content: deposit.contentMarkdown,
  });
  return { relativePath };
}

// ---- P4c daily log + weekly report -------------------------------------------
// Thin wrappers over src/ui/daily/* (pure aggregation core + IO service);
// manual generation from the tab shares the same pipeline as the scheduler.

async function generateDailyLogImpl(input?: { date?: string }): Promise<DailyLog | null> {
  const date = input?.date?.trim() || todayDateString();
  return generateDailyLogService(date, "manual");
}

async function getPendingDailyDatesImpl(): Promise<string[]> {
  const stored = await window.vestiUi?.getUiPreference(DAILY_TIME_PREF_KEY).catch(() => null);
  const logs = await listDailyLogs().catch(() => []);
  return computePendingDailyDates({
    now: Date.now(),
    scheduledTime: normalizeDailyTime(stored),
    existingDates: logs.map((log) => log.date),
  });
}

function toWeeklyReportView(record: {
  id: number;
  rangeStart: number;
  rangeEnd: number;
  content: string;
  createdAt: number;
}): WeeklyReport {
  return {
    id: record.id,
    rangeStart: record.rangeStart,
    rangeEnd: record.rangeEnd,
    content: record.content,
    createdAt: record.createdAt,
  };
}

async function exportDailyLogMarkdownImpl(
  id: number
): Promise<{ relativePath: string } | null> {
  const api = vestiApi();
  if (!api) throw new Error("桌面环境不可用，无法导出日报");
  const log = await getDailyLogById(id);
  if (!log) {
    throw new Error("日报不存在，可能已被删除");
  }
  const directory = await api.chooseDirectory("选择日报导出目录");
  if (!directory) return null;
  const relativePath = `VestiDaily/daily-${log.date}.md`;
  await api.writeUpstreamFile({
    rootPath: directory,
    relativePath,
    content: log.contentMarkdown,
  });
  return { relativePath };
}

async function getDailyLogById(id: number): Promise<DailyLog | null> {
  const logs = await listDailyLogs();
  return logs.find((log) => log.id === id) ?? null;
}

// ---- Prompt library scan (agent CLI sessions + browser conversations) ------
//
// Interactive counterpart to extractPromptsFromLibrary: instead of silently
// archiving a curated few, it flattens every user turn from BOTH sources into
// reviewable candidates (frequency + provenance) and lets the user adopt or
// ignore each one. Clustering/ranking is pure (promptlib/promptScanner);
// the only LLM usage is ONE optional batch call that relabels the top
// candidates (heuristic titles stay when no model is configured).

const SCAN_AGENT_SESSION_LIMIT = 200;
const SCAN_BROWSER_CONVERSATION_LIMIT = 500;
const SCAN_MESSAGE_TEXT_CAP = 8_000;
const SCAN_AGENT_BATCH_SIZE = 10;
/** Rate limit: a single naming call over at most this many top candidates. */
const SCAN_LLM_NAMING_LIMIT = 12;

function truncateScanText(text: string): string {
  return text.length > SCAN_MESSAGE_TEXT_CAP ? text.slice(0, SCAN_MESSAGE_TEXT_CAP) : text;
}

/** Browser conversations live in Dexie and are NOT stamped local_terminal. */
async function listBrowserScanConversations(): Promise<{
  records: Array<ConversationRecord & LocalTerminalFields>;
  truncated: boolean;
}> {
  const records = (await db.conversations.toArray()) as Array<
    ConversationRecord & LocalTerminalFields
  >;
  const browser = records
    .filter((record) => record._source !== "local_terminal" && typeof record.id === "number")
    .sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0));
  return {
    records: browser.slice(0, SCAN_BROWSER_CONVERSATION_LIMIT),
    truncated: browser.length > SCAN_BROWSER_CONVERSATION_LIMIT,
  };
}

async function collectBrowserScanInputs(
  records: Array<ConversationRecord & LocalTerminalFields>,
  report: (step: number) => void,
): Promise<PromptScanUserInput[]> {
  const inputs: PromptScanUserInput[] = [];
  let sinceReport = 0;
  for (const record of records) {
    const messages = await db.messages
      .where("conversation_id")
      .equals(record.id as number)
      .toArray();
    for (const message of messages) {
      if (message.role !== "user") continue;
      const text = (message.content_text ?? "").trim();
      if (!text) continue;
      inputs.push({
        origin: "browser",
        conversationId: String(record.id),
        conversationTitle: record.title || "",
        text: truncateScanText(text),
      });
    }
    sinceReport += 1;
    if (sinceReport >= 25) {
      report(sinceReport);
      sinceReport = 0;
    }
  }
  if (sinceReport > 0) report(sinceReport);
  return inputs;
}

/** Agent CLI sessions are read straight from the main-process capture store. */
async function collectAgentScanInputs(
  api: VestiDesktopApi,
  sessions: Awaited<ReturnType<VestiDesktopApi["getSessions"]>>,
  report: (step: number) => void,
): Promise<PromptScanUserInput[]> {
  const inputs: PromptScanUserInput[] = [];
  // Batched detail fetches keep IPC pressure bounded on large libraries.
  for (let index = 0; index < sessions.length; index += SCAN_AGENT_BATCH_SIZE) {
    const batch = sessions.slice(index, index + SCAN_AGENT_BATCH_SIZE);
    const details = await Promise.all(
      batch.map((session) => api.getSession(session.id).catch(() => null)),
    );
    for (const detail of details) {
      if (!detail) continue;
      for (const message of detail.messages) {
        if (message.role !== "user") continue;
        const text = (message.contentText ?? "").trim();
        if (!text) continue;
        inputs.push({
          origin: "agent",
          conversationId: detail.session.id,
          conversationTitle: detail.session.title || "",
          text: truncateScanText(text),
        });
      }
    }
    report(batch.length);
  }
  return inputs;
}

/** Leniently parse the LLM naming response: a JSON array of short titles. */
function parseNamingTitles(raw: string, expected: number): string[] | null {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1)) as unknown;
    if (!Array.isArray(parsed) || parsed.length < expected) return null;
    const titles = parsed.slice(0, expected).map((item) =>
      typeof item === "string" ? item.trim().replace(/\s+/g, " ").slice(0, 48) : "");
    return titles.every((title) => title.length > 0) ? titles : null;
  } catch {
    return null;
  }
}

async function scanPromptLibraryImpl(options?: {
  sessionLimit?: number;
  onProgress?: (progress: PromptScanProgress) => void;
}): Promise<PromptScanResult> {
  const api = vestiApi();

  // Enumerate first so the progress total is known up front.
  const browserPart = await listBrowserScanConversations();
  const allAgentSessions = api ? await api.getSessions() : [];
  const sessionLimit = Math.max(1, options?.sessionLimit ?? SCAN_AGENT_SESSION_LIMIT);
  const agentSessions = [...allAgentSessions]
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
    .slice(0, sessionLimit);
  const total = browserPart.records.length + agentSessions.length;
  let done = 0;
  const report = (step: number) => {
    done += step;
    options?.onProgress?.({ done, total });
  };
  options?.onProgress?.({ done: 0, total });

  const browserInputs = await collectBrowserScanInputs(browserPart.records, report);
  const agentInputs = api ? await collectAgentScanInputs(api, agentSessions, report) : [];

  const inputs = [...browserInputs, ...agentInputs];
  const clusters = scanUserPromptInputs(inputs);
  const candidates: PromptScanCandidate[] = clusters.map((cluster) => ({
    ...cluster,
    alreadyInLibrary: false,
  }));

  // Mark candidates whose body already lives in the prompts table.
  const existingBodies = new Set(
    (await db.prompts.toArray()).map((record) => canonicalizeForHash(record.body ?? "")),
  );
  for (const candidate of candidates) {
    candidate.alreadyInLibrary = existingBodies.has(canonicalizeForHash(candidate.body));
  }

  // Optional LLM naming: exactly ONE batch call over the top candidates; any
  // failure leaves the heuristic titles in place.
  let usedLlm = false;
  if (api && candidates.length > 0) {
    const settingsView = await api.getSettings().catch(() => null);
    const llmReady = Boolean(
      settingsView &&
        (settingsView.llm.mode === "demo_proxy" || settingsView.llm.apiKeyConfigured),
    );
    if (llmReady) {
      const top = candidates.slice(0, SCAN_LLM_NAMING_LIMIT);
      const transcript = top
        .map((candidate, index) => `${index + 1}. ${candidate.body.slice(0, 600)}`)
        .join("\n\n");
      try {
        const result = await api.runAgent({
          kind: "explore",
          sessionId: `prompt-scan:${Date.now()}`,
          transcriptOverride: transcript,
          question:
            "上面是若干条候选提示词（按编号给出）。请为每一条生成一个不超过 20 字的简短标题，严格只输出一个 JSON 字符串数组，顺序与编号一一对应，例如 [\"标题一\", \"标题二\"]。不要输出任何其他文字。",
          persist: false,
        });
        const titles = parseNamingTitles(result.content, top.length);
        if (titles) {
          top.forEach((candidate, index) => {
            candidate.title = titles[index];
          });
          usedLlm = true;
        }
      } catch {
        /* naming is best-effort; heuristic titles stay */
      }
    }
  }

  return {
    candidates,
    scannedConversations: total,
    scannedInputs: inputs.length,
    usedLlm,
    truncated: browserPart.truncated || allAgentSessions.length > agentSessions.length,
  };
}

// ---- One-click extraction wiring (agent sessions + optional LLM distill) ----
//
// extractPromptsFromLibrary itself is Dexie + injected-data only. On desktop
// the CLI agent sessions are the primary conversation source and live in the
// main-process capture store, so they are gathered here through the same
// read-only IPC the interactive scan uses and passed in as extraInputs. When
// an LLM is configured, a single batch distill call ("总结") merges the top
// candidates into reusable fragment templates; any failure is reported on the
// result (llmError) while the heuristic path still produces output.

const EXTRACT_AGENT_SESSION_LIMIT_RECENT = 50;
const EXTRACT_AGENT_SESSION_LIMIT_ALL = 200;
/** Distill input cap: keeps the transcriptOverride under the 30K IPC limit. */
const EXTRACT_DISTILL_TURNS = 30;
const EXTRACT_DISTILL_FRAGMENT_LIMIT = 6;

async function collectAgentExtractInputs(
  api: VestiDesktopApi,
  scope: "all" | "recent" | undefined,
): Promise<PromptScanUserInput[]> {
  const limit = scope === "all" ? EXTRACT_AGENT_SESSION_LIMIT_ALL : EXTRACT_AGENT_SESSION_LIMIT_RECENT;
  const sessions = (await api.getSessions().catch(() => []))
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
    .slice(0, limit);
  return collectAgentScanInputs(api, sessions, () => {});
}

/** Leniently parse the distill response: a JSON array of {title, body, category}. */
function parseDistillFragments(raw: string, limit: number): ExtractedFragment[] {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start === -1 || end <= start) return [];
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1)) as unknown;
    if (!Array.isArray(parsed)) return [];
    const fragments: ExtractedFragment[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const candidate = item as { title?: unknown; body?: unknown; category?: unknown };
      const body = typeof candidate.body === "string" ? candidate.body.trim() : "";
      if (!body) continue;
      fragments.push({
        title: typeof candidate.title === "string" ? candidate.title.trim().slice(0, 48) : "",
        body: body.slice(0, 4_000),
        category: typeof candidate.category === "string" && candidate.category.trim()
          ? candidate.category.trim().slice(0, 40)
          : null,
      });
      if (fragments.length >= limit) break;
    }
    return fragments;
  } catch {
    return [];
  }
}

/**
 * Build the one-batch LLM distiller for extraction ("总结"): merge the top
 * candidate prompts into reusable fragment templates. Returns undefined when
 * no LLM is configured — extraction then runs the deterministic heuristic
 * path (scanner clustering still aggregates similar prompts offline).
 */
async function buildPromptDistiller(
  api: VestiDesktopApi,
): Promise<((turns: string[]) => Promise<ExtractedFragment[]>) | undefined> {
  const settingsView = await api.getSettings().catch(() => null);
  const llmReady = Boolean(
    settingsView &&
      (settingsView.llm.mode === "demo_proxy" || settingsView.llm.apiKeyConfigured),
  );
  if (!llmReady) return undefined;
  return async (turns) => {
    const top = turns.slice(0, EXTRACT_DISTILL_TURNS);
    if (top.length === 0) return [];
    const transcript = top.map((body, index) => `${index + 1}. ${body.slice(0, 600)}`).join("\n\n");
    const result = await api.runAgent({
      kind: "explore",
      sessionId: `prompt-distill:${Date.now()}`,
      transcriptOverride: transcript,
      question:
        "上面是用户在与 AI 对话中反复使用的候选提示词（按编号给出）。请把它们提炼成至多 6 条可复用的提示词模板：合并语义相似的条目、把一次性的具体内容抽象成 {{变量}} 占位符、保留条目原来的语言。严格只输出一个 JSON 数组，每项形如 {\"title\": \"简短标题\", \"body\": \"完整模板正文\", \"category\": \"分类或 null\"}，不要输出任何其他文字。",
      persist: false,
    });
    return parseDistillFragments(result.content, EXTRACT_DISTILL_FRAGMENT_LIMIT);
  };
}

async function extractPromptsFromDesktop(options?: {
  scope?: "all" | "recent";
  limit?: number;
}): Promise<PromptExtractionResult> {
  const api = vestiApi();
  const extraInputs = api ? await collectAgentExtractInputs(api, options?.scope) : [];
  const distill = api ? await buildPromptDistiller(api) : undefined;
  return extractPromptsFromLibrary({
    ...options,
    extraInputs,
    ...(distill ? { distill } : {}),
  });
}

// ---- StorageApi ------------------------------------------------------------

export const desktopStorage: StorageApi = {
  getTopics: () => getTopics(),
  getConversations: (filters) => listConversations(filters),
  getThinkingMapSemantics: (conversationIds) =>
    getThinkingMapSemanticsImpl(conversationIds),

  getMessages: (conversationId) => listMessages(conversationId),

  getAnnotationsByConversation: (conversationId) => listAnnotations(conversationId),
  saveAnnotation: (payload) => saveAnnotation(payload),
  deleteAnnotation: async (annotationId) => {
    await deleteAnnotation(annotationId);
  },
  exportAnnotationToNote: (annotationId) => exportAnnotationToMyNotes(annotationId),

  updateConversation: (id, changes) => updateConversation(id, changes),
  updateConversationTitle: (id, title) => updateConversationTitle(id, title),
  deleteConversation: async (id) => {
    await deleteConversation(id);
  },
  // P2b organizer: source tree + bulk operations. Soft trash keeps the record
  // (and its capture lineage), so re-syncs reconcile instead of resurrecting.
  getConversationTree: () => loadConversationTree(),
  // Memory v2: L0 project cards / L2 briefs / file timelines (main-process).
  getProjectStates: async () => (await vestiApi()?.getProjectStates()) ?? [],
  getProjectBrief: async (projectKey) =>
    (await vestiApi()?.getProjectBrief(projectKey)) ?? null,
  getFileTimeline: async (query) => (await vestiApi()?.getFileTimeline(query)) ?? [],
  trashConversations: (ids) => bulkSetConversationFlags(ids, { is_trash: true }),
  bulkAddTag: (ids, tag) => bulkAddTagToConversations(ids, tag),
  renameFolderTag: async (from, to) => ({ updated: await renameTagAcrossConversations(from, to) }),
  moveFolderTag: async (from, to) => ({ updated: await moveTagAcrossConversations(from, to) }),
  removeFolderTag: async (tag) => ({ updated: await removeTagFromConversations(tag) }),

  // P4a AI relay: handoff packs over multi-selected conversations.
  listRelayPacks: () => listRelayPacks(),
  generateRelayPack: (conversationIds) => generateRelayPackImpl(conversationIds),
  deleteRelayPack: async (id) => {
    await deleteRelayPack(id);
  },
  exportRelayPackMarkdown: (id) => exportRelayPackMarkdownImpl(id),
  getRelayPackCliCommands: (id) => getRelayPackCliCommandsImpl(id),
  deliverRelayPackToBrowser: (id) => deliverRelayPackToBrowserImpl(id),
  getRelayAvailability: () => getRelayAvailabilityImpl(),

  // P4b knowledge extract + deposits area.
  generateExtract: (conversationIds) => generateExtractImpl(conversationIds),
  listDeposits: () => listDeposits(),
  createDeposit: (input) => createDeposit(input),
  generateDeposit: (input) => generateDepositImpl(input),
  renameDeposit: (id, title) => renameDeposit(id, title),
  deleteDeposit: async (id) => {
    await deleteDeposit(id);
  },
  resolveDepositScope: (scope) => resolveDepositScopeImpl(scope),
  exportDepositMarkdown: (id) => exportDepositMarkdownImpl(id),

  // 记忆空间 (memory space): dream memories + dream logs from memory_entries,
  // and the dream pipeline itself (src/ui/memory).
  listMemoryEntries: async (options) => (await vestiApi()?.listMemoryEntries(options)) ?? [],
  runDream: (options) =>
    runDream({
      mode: options.mode,
      onProgress: options.onProgress
        ? (progress) => options.onProgress?.(progress.message)
        : undefined,
    }),
  getDreamAutoEnabled: () => isDreamAutoEnabled(),
  setDreamAutoEnabled: (enabled) => setDreamAutoEnabled(enabled),

  // P4c daily log + weekly report.
  listDailyLogs: () => listDailyLogs(),
  generateDailyLog: (input) => generateDailyLogImpl(input),
  getPendingDailyDates: () => getPendingDailyDatesImpl(),
  getDailyLogOverview: (): Promise<DailyLogOverview> => getDailyLogOverviewService(),
  listWeeklyReports: async () => (await listWeeklyReports()).map(toWeeklyReportView),
  generateWeeklyReport: async () => toWeeklyReportView(await generateWeeklyReportService()),
  exportDailyLogMarkdown: (id) => exportDailyLogMarkdownImpl(id),

  askKnowledgeBase: async (query, sessionId, _limit, _mode, options) => {
    const trimmed = query.trim();
    const exploreSessionId = sessionId ?? (await createExploreSession(trimmed.slice(0, 60) || "Explore"));

    await addExploreMessage(exploreSessionId, {
      role: "user",
      content: trimmed,
      timestamp: Date.now(),
    });

    const scopeIds = options?.searchScope?.conversationIds ?? [];
    const api = vestiApi();

    let answer = NO_CONTEXT_ANSWER;
    let sources: RagSources = [];

    if (api) {
      // P1.5: cross-session recall first — digests + FTS hit snippets from the
      // top-K sessions become the explore context; answers cite their sources.
      const hits = await api.recallSessions(trimmed, 5).catch(() => []);
      if (hits.length > 0) {
        const context = hits
          .map((hit, index) => {
            const lines = [`[会话 ${index + 1}] ${hit.title}`];
            if (hit.oneLiner) lines.push(`摘要：${hit.oneLiner}`);
            if (hit.snippet) lines.push(`命中片段：${hit.snippet}`);
            return lines.join("\n");
          })
          .join("\n\n");
        const result = await api.runAgent({
          kind: "explore",
          sessionId: hits[0].sessionId,
          question: trimmed,
          transcriptOverride: context,
        });
        answer = result.content;
        sources = await recallSources(hits);
      } else {
        // No recall hits: fall back to the first selected conversation.
        const info = scopeIds.length > 0 ? await getConversationCliId(scopeIds[0]) : null;
        if (info?.cliId) {
          const result = await api.runAgent({
            kind: "explore",
            sessionId: info.cliId,
            question: trimmed,
          });
          answer = result.content;
          const record = await db.conversations.get(scopeIds[0]);
          if (record?.id !== undefined) {
            sources = [
              {
                id: record.id,
                title: record.title,
                platform: record.platform,
                similarity: 1,
              },
            ];
          }
        }
      }
    }

    await addExploreMessage(exploreSessionId, {
      role: "assistant",
      content: answer,
      sources,
      timestamp: Date.now(),
    });

    return { answer, sources, sessionId: exploreSessionId };
  },

  createExploreSession: (title) => createExploreSession(title),
  listExploreSessions: (limit) => listExploreSessions(limit),
  getExploreSession: (sessionId) => getExploreSession(sessionId),
  getExploreMessages: (sessionId) => getExploreMessages(sessionId),
  deleteExploreSession: (sessionId) => deleteExploreSession(sessionId),
  renameExploreSession: (sessionId, title) => updateExploreSession(sessionId, { title }),
  updateExploreMessageContext: (messageId, contextDraft, selectedContextConversationIds) =>
    updateExploreMessageContext(messageId, contextDraft, selectedContextConversationIds),

  // 夜话: one companion turn through the renderer orchestration service
  // (context assembly + kind:'companion' agent + explore-session persistence).
  askCompanion: (input) => askCompanion(input),

  // UI preferences (window.vestiUi → ui-prefs.json): the 夜话 persona /
  // memory-scope switches persist here — same bridge dailyScheduler reads.
  getUiPreference: (key) =>
    window.vestiUi?.getUiPreference(key) ?? Promise.resolve(null),
  setUiPreference: async (key, value) => {
    await window.vestiUi?.setUiPreference(key, value);
  },

  // AI 圆桌: convene the selected personas on the configured LLM (one
  // 'roundtable-turn' run per seat, serial so progress arrives in order and
  // rate limits stay calm), then a 'roundtable-synthesis' moderator pass over
  // the successful turns. Recall hits ground the discussion when available.
  // The finished run is archived into explore_sessions so it replays from the
  // Ask history — same convention as askKnowledgeBase.
  runRoundtable: async (question, personaIds, opts) => {
    const lang = opts?.lang ?? "zh";
    const api = vestiApi();
    if (!api) {
      throw new Error(
        lang === "zh" ? "桌面接口不可用，无法运行圆桌。" : "Desktop API unavailable — cannot run the roundtable.",
      );
    }
    // LLM gate (same probe as getLlmConfigured): the panel disables the run up
    // front; this guard keeps direct callers honest too.
    const settingsView = await api.getSettings().catch(() => null);
    const llmConfigured = settingsView
      ? settingsView.llm.mode === "demo_proxy" || settingsView.llm.apiKeyConfigured
      : false;
    if (!llmConfigured) {
      throw new Error(
        lang === "zh"
          ? "尚未配置模型 —— 请先在「设置」中配置 LLM，圆桌需要模型才能讨论。"
          : "No model configured — set up an LLM in Settings first; the panel needs one to deliberate.",
      );
    }
    const personas = resolveRoundtablePersonas(personaIds);
    if (personas.length < ROUNDTABLE_MIN_SEATS) {
      throw new Error(
        lang === "zh" ? "圆桌至少需要 2 位成员。" : "The roundtable needs at least 2 panelists.",
      );
    }

    const startedAt = Date.now();

    // Optional grounding: cross-session recall, same context shape as Ask.
    const hits = await api.recallSessions(question, 5).catch(() => []);
    const context =
      hits.length > 0
        ? hits
            .map((hit, index) => {
              const lines = [`[会话 ${index + 1}] ${hit.title}`];
              if (hit.oneLiner) lines.push(`摘要：${hit.oneLiner}`);
              if (hit.snippet) lines.push(`命中片段：${hit.snippet}`);
              return lines.join("\n");
            })
            .join("\n\n")
        : "";
    const sources = hits.length > 0 ? await recallSources(hits) : [];

    const seatTurns: RoundtableSeatTurn[] = [];
    for (const persona of personas) {
      const seatStart = Date.now();
      let turn: RoundtableSeatTurn;
      try {
        const result = await api.runAgent({
          kind: "roundtable-turn",
          sessionId: `roundtable:${startedAt}:${persona.id}`,
          question,
          transcriptOverride: buildSeatTranscript({ persona, question, context, lang }),
          persist: false,
        });
        turn = {
          personaId: persona.id,
          content: result.content.trim(),
          ok: true,
          durationMs: Date.now() - seatStart,
        };
      } catch (error) {
        turn = {
          personaId: persona.id,
          content: "",
          ok: false,
          error: (error as Error)?.message ?? String(error),
          durationMs: Date.now() - seatStart,
        };
      }
      seatTurns.push(turn);
      opts?.onSeatComplete?.(turn);
    }

    // Moderator over whatever seats succeeded; a failed/absent synthesis never
    // sinks the seat turns.
    const okTurns = seatTurns.filter((turn) => turn.ok && turn.content.trim());
    let synthesisRaw = "";
    if (okTurns.length > 0) {
      try {
        const result = await api.runAgent({
          kind: "roundtable-synthesis",
          sessionId: `roundtable:${startedAt}:moderator`,
          question,
          transcriptOverride: buildModeratorTranscript(question, okTurns, context, lang),
          persist: false,
        });
        synthesisRaw = result.content.trim();
      } catch (error) {
        console.warn("[Roundtable] synthesis failed; returning seat turns only", error);
      }
    }

    const result = aggregateRoundtable({
      question,
      lang,
      grounded: hits.length > 0,
      seatTurns,
      synthesisRaw,
      sources,
      totalDurationMs: Date.now() - startedAt,
    });

    // Archive into explore_sessions (best-effort — storage failures must not
    // sink a finished run). A fully-failed run yields empty markdown and is
    // not archived at all: an Ask history entry of "(turn failed)" markers
    // would only be noise when the model service is down.
    try {
      const markdown = buildRoundtableRecordMarkdown(result);
      if (markdown) {
        const titlePrefix = lang === "zh" ? "圆桌：" : "Roundtable: ";
        const sessionId = await createExploreSession(
          `${titlePrefix}${question.slice(0, 50)}` || "Roundtable",
        );
        await addExploreMessage(sessionId, {
          role: "user",
          content: question,
          timestamp: startedAt,
        });
        await addExploreMessage(sessionId, {
          role: "assistant",
          content: markdown,
          sources,
          timestamp: Date.now(),
        });
      }
    } catch (error) {
      console.warn("[Roundtable] failed to archive the session", error);
    }

    return result;
  },

  // AI 深化 (Learn): one recall-grounded LLM pass over a learning domain
  // (kind 'learn-deepen'), archived into explore_sessions like a roundtable
  // run so it replays from the Ask history. The domain card owns the UI
  // state; the uncategorized bucket never reaches here (the card hides the
  // affordance — a "uncategorized" recall query would ground on nothing).
  runLearnDeepen: async (domain, opts) => {
    const lang = opts?.lang ?? "zh";
    const api = vestiApi();
    if (!api) {
      throw new Error(
        lang === "zh"
          ? "桌面接口不可用，无法运行 AI 深化。"
          : "Desktop API unavailable — cannot run the deep-dive.",
      );
    }
    // LLM gate (same probe as the roundtable run): the card gates the button
    // up front; this guard keeps direct callers honest too.
    const settingsView = await api.getSettings().catch(() => null);
    const llmConfigured = settingsView
      ? settingsView.llm.mode === "demo_proxy" || settingsView.llm.apiKeyConfigured
      : false;
    if (!llmConfigured) {
      throw new Error(
        lang === "zh"
          ? "尚未配置模型 —— 请先在「设置」中配置 LLM，AI 深化需要模型才能分析。"
          : "No model configured — set up an LLM in Settings first; the deep-dive needs one to analyze.",
      );
    }

    const startedAt = Date.now();

    // Optional grounding: cross-session recall on the domain name, same
    // context shape as the roundtable.
    const hits = await api.recallSessions(domain.name, 5).catch(() => []);
    const context = buildLearnRecallContext(hits);
    const sources = hits.length > 0 ? await recallSources(hits) : [];

    const agentResult = await api.runAgent({
      kind: "learn-deepen",
      sessionId: `learn-deepen:${startedAt}`,
      question: domain.name,
      transcriptOverride: buildLearnDeepenTranscript({ domain, context, lang }),
      persist: false,
    });

    const deepen = aggregateLearnDeepen({
      domain: domain.name,
      lang,
      grounded: hits.length > 0,
      raw: agentResult.content.trim(),
      sources,
      durationMs: Date.now() - startedAt,
    });

    // Archive into explore_sessions (best-effort — storage failures must not
    // sink a finished run).
    try {
      const titlePrefix = lang === "zh" ? "学习深化：" : "Learn deep-dive: ";
      const sessionId = await createExploreSession(
        `${titlePrefix}${domain.name.slice(0, 50)}` || "Learn deep-dive",
      );
      await addExploreMessage(sessionId, {
        role: "user",
        content:
          lang === "zh"
            ? `深入分析学习领域「${domain.name}」`
            : `Deep-dive into the learning domain "${domain.name}"`,
        timestamp: startedAt,
      });
      const markdown = buildLearnDeepenRecordMarkdown(deepen);
      if (markdown) {
        await addExploreMessage(sessionId, {
          role: "assistant",
          content: markdown,
          sources,
          timestamp: Date.now(),
        });
      }
    } catch (error) {
      console.warn("[LearnDeepen] failed to archive the session", error);
    }

    return deepen;
  },

  // 路线级 LLM 合成 (Learn V4): one synthesized reading per learning route
  // (kind 'learn-synthesis') — full-sentence title + interpretation + next
  // steps, fingerprint-cached in ui-prefs. The pure orchestration (sequential
  // runner, cache hit/prune, parse quality bar) lives in
  // src/ui/learn/learnSynthesis; this wrapper only supplies the agent runner
  // and the store. Everything fails soft: no LLM / route errors / unusable
  // output all yield a missing entry, and the card falls back to the
  // deterministic computeLearn labels.
  runLearnSynthesis: async (domains, opts) => {
    const lang = opts?.lang ?? "zh";
    const api = vestiApi();
    if (!api) return {};
    // LLM gate (same probe as runLearnDeepen): silent empty map — the card
    // never shows an error for synthesis, only the deterministic labels.
    const settingsView = await api.getSettings().catch(() => null);
    const llmConfigured = settingsView
      ? settingsView.llm.mode === "demo_proxy" || settingsView.llm.apiKeyConfigured
      : false;
    if (!llmConfigured) return {};

    // Grounding: existing digest one-liners keyed by conversation id (no
    // long transcript pulls).
    const digestByConversationId = new Map<number, string>();
    const digests = await listConversationDigests().catch(() => []);
    for (const digest of digests) {
      const oneLiner = digest.oneLiner?.trim();
      if (oneLiner) digestByConversationId.set(digest.conversationId, oneLiner);
    }

    return synthesizeLearnRoutes(domains, {
      lang,
      digestByConversationId,
      force: opts?.force,
      onProgress: opts?.onProgress,
      store: createUiPrefsLearnSynthesisStore(),
      runner: async (domain, transcript) => {
        const agentResult = await api.runAgent({
          kind: "learn-synthesis",
          sessionId: `learn-synthesis:${learnRouteFingerprint(domain)}`,
          question: domain.name,
          transcriptOverride: transcript,
          persist: false,
        });
        return agentResult.content.trim();
      },
    });
  },

  getSummary: async (conversationId) => {
    const record = await getSummaryRecord(conversationId);
    if (!record) {
      return null;
    }
    const info = await getConversationCliId(conversationId);
    return summaryRecordToChatSummaryData(record, info?.title);
  },
  generateSummary: (conversationId) => generateSummaryImpl(conversationId),
  // AITI 摘要覆盖率: drives the coverage header + 立即生成摘要 batch queue
  // on the aiti pane (pure computation lives in @vesti/ui lib/summaryCoverage).
  getSummaryCoverage: async () => {
    const [records, summaries] = await Promise.all([
      db.conversations.toArray(),
      getAllSummaries(),
    ]);
    return computeSummaryCoverage(
      (records as Array<ConversationRecord & LocalTerminalFields>)
        // A1: folded subagent runs are not standalone summary targets — they
        // would inflate the coverage denominator with rows the batch queue
        // never surfaces.
        .filter((record) => !(record as { _subagent_of?: unknown })._subagent_of)
        .map((record) => ({
          id: record.id,
          is_archived: record.is_archived,
          is_trash: record.is_trash,
          updatedAt: record.updated_at,
          // Browser captures summarize through a transcriptOverride built from
          // their Dexie messages; any conversation with messages qualifies.
          summarizable:
            (typeof record._cli_id === "string" && record._cli_id.trim() !== "") ||
            (record.message_count ?? 0) > 0,
        })),
      summaries
    );
  },
  getLlmConfigured: async () => {
    const api = vestiApi();
    if (!api) return false;
    const settingsView = await api.getSettings().catch(() => null);
    return settingsView
      ? settingsView.llm.mode === "demo_proxy" || settingsView.llm.apiKeyConfigured
      : false;
  },
  getConversationDigests: () => listConversationDigests(),

  // P3 upstream export (SendToMenu): whole conversations re-serialize from
  // structured Dexie data (frontmatter, digest, AST); the summary scope and
  // derived payloads (AITI etc.) send the prebuilt markdown instead.
  exportConversationToNotion: async (input) => {
    if (input.scope !== "summary" && input.conversation?.id != null) {
      return exportConversationToNotion(input.conversation.id);
    }
    return exportMarkdownPayloadToNotion({ title: input.title, markdown: input.markdown });
  },
  exportConversationToObsidian: async (input) => {
    const { vaultName } = await getConfiguredObsidianVault();
    const outcome = input.scope !== "summary" && input.conversation?.id != null
      ? await exportConversationToObsidian(input.conversation.id)
      : await exportMarkdownPayloadToObsidian({ title: input.title, markdown: input.markdown });
    return {
      relative_path: outcome.relativePath,
      vault_name: vaultName,
      exported_at: outcome.exportedAt,
    };
  },

  getNotes: () => listNotes(),
  saveNote: (note) => createNote(note),
  updateNote: (id, changes) => updateNote(id, changes),
  deleteNote: (id) => deleteNote(id),

  importObsidianDirectory: (vaultName, entries) => importObsidianDirectory(vaultName, entries),
  importObsidianZip: (fileName, data) => importObsidianZip(fileName, data),
  getNoteAsset: (assetId) => getNoteAsset(assetId),

  getStorageUsage: () => getStorageUsage(),
  exportData: async (format) => {
    const payload = await exportAllData(format);
    return {
      blob: new Blob([payload.content], { type: payload.mime }),
      filename: payload.filename,
      mime: payload.mime,
    };
  },
  clearAllData: async () => {
    // Desktop parity with "wipe everything": the extension only cleared the
    // capture/insight tables, but on desktop the Dexie instance holds only
    // app data, so clearing every table is safe and matches user expectation.
    await db.transaction("rw", db.tables, async () => {
      await Promise.all(db.tables.map((table) => table.clear()));
    });
  },

  listPrompts: (filter) => listPrompts(filter),
  searchPrompts: (query, limit) => searchPrompts(query, limit),
  createPrompt: (input) => createPrompt(input),
  updatePrompt: (id, changes) => updatePrompt(id, changes),
  deletePrompt: async (id) => {
    await deletePrompt(id);
  },
  togglePromptFavorite: (id, isFavorite) => togglePromptFavorite(id, isFavorite),
  incrementPromptUsage: (id) => incrementPromptUsage(id),
  // One-click extraction: agent CLI sessions are gathered over IPC and an
  // LLM distiller ("总结") is injected when configured; without one the
  // deterministic heuristic path still produces output (usedLlm: false).
  extractPromptsFromLibrary: (options) => extractPromptsFromDesktop(options),
  scanPromptLibrary: (options) => scanPromptLibraryImpl(options),
  completePrompt: async (payload) => ({ completion: payload.draft, usedLlm: false }),
};
