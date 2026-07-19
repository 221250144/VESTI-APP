// P3 upstream export: Obsidian orchestration (renderer side).
//
// Single export (SendToMenu), batch export (Settings "export all"),
// incremental auto-export (scan unexported conversations after data-updated),
// and the plain Markdown directory export all funnel through the same
// serializer (./markdownSerializer) and the restricted vault-write IPC.

import { db } from "../db/schema";
import type { ConversationRecord } from "../db/schema";
import { getSummary, getTopics, listMessages } from "../db/repository";
import { getConversationOriginAt } from "../db/timestamps";
import type { Topic } from "../db/types";
import { loadConversationTree } from "../sync/conversationTree";
import {
  buildConversationRelativePath,
  resolveConflictRelativePath,
  resolveExportPlacement,
  serializeConversationMarkdown,
  type ConversationMarkdownInput,
  type UpstreamConversation,
  type UpstreamDigest,
  type UpstreamMessage,
} from "./markdownSerializer";
import {
  runBatchExport,
  type BatchExportProgress,
  type BatchExportResult,
} from "./exportRunner";

// Capture provenance fields stamped on Dexie records by the main process /
// extension import; they ride along untyped like elsewhere in the renderer.
type ProvenanceFields = {
  _source?: string;
  _cli_id?: string;
  _project_path?: string;
};

export type ExportableConversationRecord = ConversationRecord & ProvenanceFields;

export interface ObsidianExportOutcome {
  relativePath: string;
  exportedAt: number;
}

export interface UpstreamExportStats {
  obsidian: {
    exported: number;
    failed: number;
    pending: number;
    lastExportedAt: number | null;
    lastError: string | null;
  };
  notion: {
    exported: number;
    failed: number;
    lastExportedAt: number | null;
    lastError: string | null;
  };
}

interface ExportContext {
  topicPaths: Map<number, string>;
  digests: Map<string, UpstreamDigest>;
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, "");
}

/** Strip the IPC wrapper prefix from a main-process error message. */
export function upstreamErrorText(error: unknown): string {
  return errorText(error);
}

export async function getConfiguredObsidianVault(): Promise<{ vaultPath: string; vaultName: string }> {
  const settings = await window.vesti.getSettings();
  const vaultPath = settings.upstream.obsidianVaultPath.trim();
  if (!vaultPath) throw new Error("请先在设置页选择 Obsidian 库目录");
  const segments = vaultPath.split(/[\\/]+/).filter(Boolean);
  return { vaultPath, vaultName: segments[segments.length - 1] ?? vaultPath };
}

function buildTopicPathMap(topics: Topic[]): Map<number, string> {
  const map = new Map<number, string>();
  const walk = (nodes: Topic[], prefix: string[]) => {
    for (const node of nodes) {
      const path = [...prefix, node.name];
      map.set(node.id, path.join(" / "));
      if (node.children?.length) walk(node.children, path);
    }
  };
  walk(topics, []);
  return map;
}

async function loadExportContext(): Promise<ExportContext> {
  const [topics, tree] = await Promise.all([getTopics(), loadConversationTree()]);
  const digests = new Map<string, UpstreamDigest>();
  for (const source of tree.sources) {
    for (const project of source.projects) {
      for (const session of project.sessions) {
        if (!session.oneLiner) continue;
        digests.set(session.id, {
          oneLiner: session.oneLiner,
          keyTopics: session.keyTopics,
          keyFiles: session.keyFiles,
          decisions: session.decisions,
        });
      }
    }
  }
  return { topicPaths: buildTopicPathMap(topics), digests };
}

/** Shared context loader (topics + digests) reused by the Notion export. */
export async function loadUpstreamExportContext(): Promise<ExportContext> {
  return loadExportContext();
}

/** Assemble everything the serializers need for one conversation. */
export async function assembleConversationInput(
  record: ExportableConversationRecord,
  context: ExportContext,
): Promise<ConversationMarkdownInput> {
  const id = record.id as number;
  const [messages, summary] = await Promise.all([
    listMessages(id) as Promise<UpstreamMessage[]>,
    getSummary(id).catch(() => null),
  ]);
  const placement = resolveExportPlacement(record);
  const topicPath = record.topic_id != null ? context.topicPaths.get(record.topic_id) : undefined;
  const digest = typeof record._cli_id === "string" ? context.digests.get(record._cli_id) : undefined;
  return {
    conversation: record as UpstreamConversation,
    messages,
    sourceLabel: placement.sourceLabel,
    projectLabel: placement.projectLabel,
    topicPath,
    digest: digest ?? null,
    summary: summary?.content ?? null,
  };
}

async function buildDocument(
  record: ExportableConversationRecord,
  context: ExportContext,
): Promise<{ content: string; desiredPath: string }> {
  const input = await assembleConversationInput(record, context);
  const content = serializeConversationMarkdown(input);
  const desiredPath = buildConversationRelativePath({
    sourceLabel: input.sourceLabel,
    projectLabel: input.projectLabel,
    originAt: getConversationOriginAt(record),
    title: record.title,
  });
  return { content, desiredPath };
}

async function writeRecord(
  record: ExportableConversationRecord,
  rootPath: string,
  context: ExportContext,
  takenPaths: Set<string>,
  options: { recordState: boolean },
): Promise<ObsidianExportOutcome> {
  const { content, desiredPath } = await buildDocument(record, context);
  const relativePath = resolveConflictRelativePath(desiredPath, takenPaths);
  const result = await window.vesti.writeUpstreamFile({
    rootPath,
    relativePath,
    content,
    previousRelativePath:
      options.recordState && typeof record.obsidian_export_path === "string"
        ? record.obsidian_export_path
        : undefined,
    expectedUuid: record.uuid,
  });
  takenPaths.add(result.relativePath);
  const exportedAt = Date.now();
  if (options.recordState) {
    await db.conversations.update(record.id as number, {
      exported_obsidian_at: exportedAt,
      obsidian_export_path: result.relativePath,
      obsidian_export_error: null,
    });
  }
  return { relativePath: result.relativePath, exportedAt };
}

async function recordExportError(conversationId: number, error: unknown): Promise<void> {
  await db.conversations
    .update(conversationId, { obsidian_export_error: errorText(error) })
    .catch(() => undefined);
}

/** SendToMenu single export: serialize one conversation into the vault. */
export async function exportConversationToObsidian(
  conversationId: number,
): Promise<ObsidianExportOutcome> {
  const { vaultPath } = await getConfiguredObsidianVault();
  const record = (await db.conversations.get(conversationId)) as
    | ExportableConversationRecord
    | undefined;
  if (!record || record.id === undefined) throw new Error("找不到该会话，请先重新同步");
  const context = await loadExportContext();
  try {
    return await writeRecord(record, vaultPath, context, new Set(), { recordState: true });
  } catch (error) {
    await recordExportError(conversationId, error);
    throw new Error(errorText(error));
  }
}

/**
 * SendToMenu payload mode (derived outputs like AITI / summary markdown):
 * no conversation record, so no idempotent state — write the Markdown as-is
 * under VestiExport/Vesti/Notes and let the vault writer bump name conflicts.
 */
export async function exportMarkdownPayloadToObsidian(input: {
  title: string;
  markdown: string;
}): Promise<ObsidianExportOutcome> {
  const { vaultPath } = await getConfiguredObsidianVault();
  const relativePath = buildConversationRelativePath({
    sourceLabel: "Vesti",
    projectLabel: "Notes",
    originAt: Date.now(),
    title: input.title,
  });
  const result = await window.vesti.writeUpstreamFile({
    rootPath: vaultPath,
    relativePath,
    content: input.markdown.trimEnd() + "\n",
  });
  return { relativePath: result.relativePath, exportedAt: Date.now() };
}

async function listExportableRecords(): Promise<ExportableConversationRecord[]> {
  const records = (await db.conversations.toArray()) as ExportableConversationRecord[];
  return records.filter((record) => record.id !== undefined && !record.is_trash);
}

/** Shared non-trash record listing reused by the Notion batch export. */
export async function listUpstreamExportableRecords(): Promise<ExportableConversationRecord[]> {
  return listExportableRecords();
}

async function exportRecords(
  records: ExportableConversationRecord[],
  rootPath: string,
  options: { recordState: boolean },
  onProgress?: (progress: BatchExportProgress) => void,
): Promise<BatchExportResult> {
  const context = await loadExportContext();
  const takenPaths = new Set<string>();
  const items = records.map((record) => ({
    id: record.id as number,
    title: record.title || "未命名会话",
  }));
  const recordById = new Map(records.map((record) => [record.id as number, record]));
  return runBatchExport(
    items,
    async (item) => {
      const record = recordById.get(item.id);
      if (!record) throw new Error("找不到该会话");
      try {
        await writeRecord(record, rootPath, context, takenPaths, options);
      } catch (error) {
        if (options.recordState) await recordExportError(item.id, error);
        throw new Error(errorText(error));
      }
    },
    onProgress,
  );
}

/** Settings "导出全部到 Obsidian": every non-trash conversation into the vault. */
export async function exportConversationsToObsidian(
  onProgress?: (progress: BatchExportProgress) => void,
): Promise<BatchExportResult> {
  const { vaultPath } = await getConfiguredObsidianVault();
  return exportRecords(await listExportableRecords(), vaultPath, { recordState: true }, onProgress);
}

/**
 * Incremental auto-export: only conversations never exported and not already
 * failed (failures stay visible in Settings until a manual re-export).
 */
export async function exportPendingConversationsToObsidian(): Promise<BatchExportResult> {
  const settings = await window.vesti.getSettings();
  const { vaultPath } = await getConfiguredObsidianVault();
  const since = settings.upstream.obsidianAutoExportSince;
  const pending = (await listExportableRecords()).filter((record) =>
    isPendingObsidianExport(record)
      && (since === null || record.first_captured_at >= since - 1_000),
  );
  return exportRecords(pending, vaultPath, { recordState: true });
}

/** Settings "导出全部到 Markdown 目录": same serializer, chosen directory, no state. */
export async function exportAllToMarkdownDirectory(
  rootPath: string,
  onProgress?: (progress: BatchExportProgress) => void,
): Promise<BatchExportResult> {
  return exportRecords(await listExportableRecords(), rootPath, { recordState: false }, onProgress);
}

/**
 * Incremental auto-export predicate: never exported and not already failed
 * (failures stay visible in Settings until a manual re-export). Pure.
 */
export function isPendingObsidianExport(record: {
  is_trash?: boolean;
  exported_obsidian_at?: number;
  obsidian_export_error?: string | null;
}): boolean {
  return !record.is_trash
    && typeof record.exported_obsidian_at !== "number"
    && !record.obsidian_export_error;
}

/** Settings-card statistics over conversation export-state fields. Pure. */
export function computeUpstreamExportStats(
  records: Array<{
    is_trash?: boolean;
    exported_obsidian_at?: number;
    obsidian_export_error?: string | null;
    exported_notion_at?: number;
    notion_export_error?: string | null;
  }>,
): UpstreamExportStats {
  const stats: UpstreamExportStats = {
    obsidian: { exported: 0, failed: 0, pending: 0, lastExportedAt: null, lastError: null },
    notion: { exported: 0, failed: 0, lastExportedAt: null, lastError: null },
  };
  for (const record of records) {
    if (record.is_trash) continue;
    if (typeof record.exported_obsidian_at === "number") {
      stats.obsidian.exported += 1;
      stats.obsidian.lastExportedAt = Math.max(stats.obsidian.lastExportedAt ?? 0, record.exported_obsidian_at);
    } else if (record.obsidian_export_error) {
      stats.obsidian.failed += 1;
      stats.obsidian.lastError = record.obsidian_export_error;
    } else {
      stats.obsidian.pending += 1;
    }
    if (typeof record.exported_notion_at === "number") {
      stats.notion.exported += 1;
      stats.notion.lastExportedAt = Math.max(stats.notion.lastExportedAt ?? 0, record.exported_notion_at);
    }
    if (record.notion_export_error) {
      stats.notion.failed += 1;
      stats.notion.lastError = record.notion_export_error;
    }
  }
  return stats;
}

export async function getUpstreamExportStats(): Promise<UpstreamExportStats> {
  return computeUpstreamExportStats(await db.conversations.toArray());
}
