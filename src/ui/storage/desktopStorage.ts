// Desktop implementation of the @vesti/ui StorageApi.
//
// In the Chrome extension this surface is an RPC client forwarding every call
// to the background/offscreen worker (storageService.ts). On desktop the
// renderer runs in the same process as the Dexie database, so each method
// calls the ported repository/promptRepository directly. AI-backed methods
// reuse the existing window.vesti agent IPC instead of the extension's LLM
// service; conversation export to Notion/Obsidian goes through the P3
// upstream modules (src/ui/upstream/*). Capabilities with no desktop
// equivalent (Obsidian vault connection, vector similarity) are left
// unimplemented — the StorageApi marks them optional and the UI hides them.

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
  RelayAvailability,
  RelayCliCommandView,
  RelayPack,
  RelayPackPayload,
  StorageApi,
  WeeklyReport,
} from "@vesti/ui";
import { computeSummaryCoverage, serializeRelayPackMarkdown } from "@vesti/ui";
import type { SessionRecallHit, VestiDesktopApi } from "../../shared/contracts";
import { db } from "../db/schema";
import type { ConversationRecord } from "../db/schema";
import { loadConversationTree } from "../sync/conversationTree";
import { listConversationDigests } from "../sync/conversationDigests";
import {
  addExploreMessage,
  bulkAddTagToConversations,
  bulkSetConversationFlags,
  createDeposit,
  createExploreSession,
  createNote,
  createRelayPack,
  deleteAnnotation,
  deleteConversation,
  deleteDeposit,
  deleteExploreSession,
  deleteNote,
  deleteRelayPack,
  exportAllData,
  getAllSummaries,
  getAnnotationExportContext,
  getDeposit,
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
  listDeposits,
  listExploreSessions,
  listMessages,
  listNotes,
  listRelayPacks,
  listWeeklyReports,
  moveTagAcrossConversations,
  removeTagFromConversations,
  renameDeposit,
  renameTagAcrossConversations,
  saveAnnotation,
  saveSummary,
  updateConversation,
  updateConversationTitle,
  updateExploreMessageContext,
  updateExploreSession,
  updateNote,
} from "../db/repository";
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
import type { ConversationSummaryV2, SummaryRecord } from "../db/types";
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
  type RelayContextConversation,
} from "../relay/relayContext";
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

async function generateSummaryImpl(conversationId: number): Promise<ChatSummaryData> {
  const info = await getConversationCliId(conversationId);
  if (!info) {
    throw new Error("CONVERSATION_NOT_FOUND");
  }
  const title = info.title;

  const api = vestiApi();
  if (!api || !info.cliId) {
    // Non-Electron environment or a conversation that did not come from a
    // local CLI capture: return an honest placeholder instead of failing.
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

  const result = await api.runAgent({ kind: "summary", sessionId: info.cliId });
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
    });
  }
  return contexts;
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
  const transcript = buildRelayTranscript(contexts);
  const result = await api.runAgent({
    kind: "relay",
    // No capture-store session backs a multi-selection; the pre-built
    // transcript carries everything (same pattern as the classify pipeline).
    sessionId: `relay:${Date.now()}`,
    transcriptOverride: transcript,
    persist: false,
  });
  const payload = JSON.parse(result.content) as RelayPackPayload;
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
      return `${toLocalDate(scope.start)} ~ ${toLocalDate(scope.end)}`;
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
    loadConversationTree().catch(() => null),
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

// ---- StorageApi ------------------------------------------------------------

export const desktopStorage: StorageApi = {
  getTopics: () => getTopics(),
  getConversations: (filters) => listConversations(filters),

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

  runRoundtable: async (question, _personaIds, opts) => ({
    question,
    lang: opts?.lang ?? "zh",
    grounded: false,
    seatTurns: [],
    synthesis: null,
    synthesisRaw: "",
    sources: [],
    totalDurationMs: 0,
  }),

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
      (records as Array<ConversationRecord & LocalTerminalFields>).map((record) => ({
        id: record.id,
        is_archived: record.is_archived,
        is_trash: record.is_trash,
        updatedAt: record.updated_at,
        cliId: typeof record._cli_id === "string" ? record._cli_id : null,
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
  // Offline heuristic extraction (no LLM distiller wired on desktop); the
  // result reports usedLlm: false, same as the extension's no-LLM path.
  extractPromptsFromLibrary: (options) => extractPromptsFromLibrary(options),
  completePrompt: async (payload) => ({ completion: payload.draft, usedLlm: false }),
};
