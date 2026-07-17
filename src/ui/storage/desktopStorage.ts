// Desktop implementation of the @vesti/ui StorageApi.
//
// In the Chrome extension this surface is an RPC client forwarding every call
// to the background/offscreen worker (storageService.ts). On desktop the
// renderer runs in the same process as the Dexie database, so each method
// calls the ported repository/promptRepository directly. AI-backed methods
// reuse the existing window.vesti agent IPC instead of the extension's LLM
// service; capabilities with no desktop equivalent (Notion/Obsidian vault,
// vector similarity) are left unimplemented — the StorageApi marks them
// optional and the UI hides them.

import type { ChatSummaryData, StorageApi } from "@vesti/ui";
import type { VestiDesktopApi } from "../../shared/contracts";
import { db } from "../db/schema";
import type { ConversationRecord } from "../db/schema";
import {
  addExploreMessage,
  createExploreSession,
  createNote,
  deleteAnnotation,
  deleteConversation,
  deleteExploreSession,
  deleteNote,
  exportAllData,
  getAnnotationExportContext,
  getExploreMessages,
  getExploreSession,
  getNoteAsset,
  getStorageUsage,
  getSummary as getSummaryRecord,
  getTopics,
  importObsidianDirectory,
  importObsidianZip,
  listAnnotations,
  listConversations,
  listExploreSessions,
  listMessages,
  listNotes,
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
import { buildMessageFallbackDisplayText } from "../db/utils/messageContentPackage";

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
  const saved = await saveSummary({
    conversationId,
    content: result.content,
    structured: null,
    format: "fallback_plain_text",
    status: "fallback",
    modelId: result.modelId,
    createdAt: result.createdAt || Date.now(),
    sourceUpdatedAt: info.updatedAt,
  });
  return summaryRecordToChatSummaryData(saved, result.sessionTitle || title);
}

const NO_CONTEXT_ANSWER =
  "Please choose at least one conversation first — the desktop explore agent answers questions against a selected local session.";

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
  renameFolderTag: async (from, to) => ({ updated: await renameTagAcrossConversations(from, to) }),
  moveFolderTag: async (from, to) => ({ updated: await moveTagAcrossConversations(from, to) }),
  removeFolderTag: async (tag) => ({ updated: await removeTagFromConversations(tag) }),

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
    const info = scopeIds.length > 0 ? await getConversationCliId(scopeIds[0]) : null;

    let answer = NO_CONTEXT_ANSWER;
    let sources: RagSources = [];

    if (api && info?.cliId) {
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
