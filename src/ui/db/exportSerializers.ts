import { formatArtifactDescriptor, getArtifactExcerptText } from "@vesti/content-package";
import type {
  Annotation,
  Conversation,
  ExportPayload,
  Message,
  MessageAttachment,
  MessageArtifact,
  MessageCitation,
  SummaryRecord,
  WeeklyReportRecord,
} from "./types";
import {
  getConversationCaptureFreshnessAt,
  getConversationFirstCapturedAt,
  getConversationOriginAt,
  getConversationSourceCreatedAt,
} from "./timestamps";
import { resolveMessageExportBodyText } from "./utils/messageExportPackage";
import { getTurnMessageSupplementSections } from "./utils/turnMessageText";

export interface ExportDataset {
  conversations: Conversation[];
  messages: Message[];
  summaries: SummaryRecord[];
  weeklyReports: WeeklyReportRecord[];
  annotations: Annotation[];
}

interface ArchiveHeaderMeta {
  generatedBy: string;
  exportTimestamp: string;
  totalThreads: number;
  coveredPlatforms: string[];
  coveredPlatformsLabel: string;
  temporalRange: string;
  dateRangeLabel: string;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function toIso(value: number): string {
  return new Date(value).toISOString();
}

function toIsoWithOffset(value: number): string {
  const d = new Date(value);
  const year = d.getFullYear();
  const month = pad2(d.getMonth() + 1);
  const day = pad2(d.getDate());
  const hours = pad2(d.getHours());
  const minutes = pad2(d.getMinutes());
  const seconds = pad2(d.getSeconds());
  const tzOffsetMinutes = -d.getTimezoneOffset();
  const sign = tzOffsetMinutes >= 0 ? "+" : "-";
  const absOffset = Math.abs(tzOffsetMinutes);
  const offsetHours = pad2(Math.floor(absOffset / 60));
  const offsetMinutes = pad2(absOffset % 60);
  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}${sign}${offsetHours}:${offsetMinutes}`;
}

function toLocalDate(value: number): string {
  const d = new Date(value);
  const yyyy = d.getFullYear();
  const mm = pad2(d.getMonth() + 1);
  const dd = pad2(d.getDate());
  return `${yyyy}-${mm}-${dd}`;
}

function toLocalDateTime(value: number): string {
  const d = new Date(value);
  const yyyy = d.getFullYear();
  const mm = pad2(d.getMonth() + 1);
  const dd = pad2(d.getDate());
  const hh = pad2(d.getHours());
  const mi = pad2(d.getMinutes());
  const ss = pad2(d.getSeconds());
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
}

function buildTimestampTag(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = pad2(d.getMonth() + 1);
  const dd = pad2(d.getDate());
  const hh = pad2(d.getHours());
  const mi = pad2(d.getMinutes());
  const ss = pad2(d.getSeconds());
  return `${yyyy}${mm}${dd}-${hh}${mi}${ss}`;
}

function getMeta() {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const appVersion = typeof chrome !== "undefined"
    ? chrome.runtime?.getManifest?.().version ?? "unknown"
    : "unknown";
  return {
    exportedAtIso: new Date().toISOString(),
    timezone,
    appVersion,
    timestampTag: buildTimestampTag(),
  };
}

function buildArchiveHeaderMeta(conversations: Conversation[]): ArchiveHeaderMeta {
  const now = Date.now();
  const coveredPlatforms = Array.from(
    new Set(conversations.map((item) => item.platform))
  );

  if (conversations.length === 0) {
    return {
      generatedBy: "vesti心迹",
      exportTimestamp: toIsoWithOffset(now),
      totalThreads: 0,
      coveredPlatforms,
      coveredPlatformsLabel: "N/A",
      temporalRange: "N/A",
      dateRangeLabel: "N/A",
    };
  }

  const startTs = Math.min(...conversations.map((item) => getConversationOriginAt(item)));
  const endTs = Math.max(
    ...conversations.map((item) => getConversationCaptureFreshnessAt(item))
  );
  const startDate = toLocalDate(startTs);
  const endDate = toLocalDate(endTs);
  const dateRangeLabel = startDate === endDate ? startDate : `${startDate} to ${endDate}`;

  return {
    generatedBy: "vesti心迹",
    exportTimestamp: toIsoWithOffset(now),
    totalThreads: conversations.length,
    coveredPlatforms,
    coveredPlatformsLabel: coveredPlatforms.length > 0 ? coveredPlatforms.join(", ") : "N/A",
    temporalRange: `${startDate} to ${endDate}`,
    dateRangeLabel,
  };
}

function formatCoveredPlatformsForMetadata(platforms: string[]): string {
  return platforms.length > 0 ? `[${platforms.join(", ")}]` : "[]";
}

function pushArchiveHeader(lines: string[], header: ArchiveHeaderMeta): void {
  lines.push("# vesti心迹 | 思想档案导出 (Digital Dialogue Archive)");
  lines.push("");
  lines.push("> **[System Metadata]**");
  lines.push("> 提示：本区域结构已为后续的 AI 深度阅读、洞察捕捉与摘要重构做出精确优化。");
  lines.push(`> Generated_By: ${header.generatedBy}`);
  lines.push(`> Export_Timestamp: ${header.exportTimestamp}`);
  lines.push(`> Total_Threads: ${header.totalThreads}`);
  lines.push(
    `> Covered_Platforms: ${formatCoveredPlatformsForMetadata(header.coveredPlatforms)}`
  );
  lines.push(`> Temporal_Range: ${header.temporalRange}`);
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("## 档案概览 (Archive Overview)");
  lines.push("");
  lines.push(`* **时间跨度 (Date Range):** ${header.dateRangeLabel}`);
  lines.push(`* **收录平台 (Platforms):** ${header.coveredPlatformsLabel}`);
  lines.push(`* **对话总数 (Total Threads):** ${header.totalThreads}`);
  lines.push("* **核心线索 (Key Topics):** TBD");
  lines.push("");
}

function pushThreadHeader(
  lines: string[],
  index: number,
  conversation: Conversation,
  messageCount: number
): void {
  const threadLabel = String(index + 1).padStart(2, "0");
  lines.push(`## [Thread ${threadLabel}] ${conversation.title} - ${conversation.platform}`);
  lines.push("");
  lines.push(`* **Source URL:** ${conversation.url}`);
  lines.push(`* **Platform:** ${conversation.platform}`);
  lines.push(`* **Started At:** ${toLocalDateTime(getConversationOriginAt(conversation))}`);
  const sourceCreatedAt = getConversationSourceCreatedAt(conversation);
  if (sourceCreatedAt !== null) {
    lines.push(`* **Source Time:** ${toLocalDateTime(sourceCreatedAt)}`);
  }
  lines.push(
    `* **First Captured At:** ${toLocalDateTime(
      getConversationFirstCapturedAt(conversation)
    )}`
  );
  lines.push(
    `* **Last Captured At:** ${toLocalDateTime(
      getConversationCaptureFreshnessAt(conversation)
    )}`
  );
  lines.push(`* **Last Modified:** ${toLocalDateTime(conversation.updated_at)}`);
  lines.push(`* **Message Count:** ${messageCount}`);
  lines.push("");
}

function groupMessages(messages: Message[]): Map<number, Message[]> {
  const byConversation = new Map<number, Message[]>();
  const sorted = [...messages].sort((a, b) => a.created_at - b.created_at);
  for (const message of sorted) {
    const list = byConversation.get(message.conversation_id) ?? [];
    list.push(message);
    byConversation.set(message.conversation_id, list);
  }
  return byConversation;
}

function formatExportCitationLines(citations: MessageCitation[], format: "txt" | "md"): string[] {
  if (citations.length === 0) {
    return [];
  }

  if (format === "md") {
    return citations.map((citation) => `- [${citation.label}](${citation.href}) (${citation.host})`);
  }

  return citations.map((citation) => `- ${citation.label} — ${citation.href}`);
}

function formatExportArtifactLines(artifacts: MessageArtifact[], format: "txt" | "md"): string[] {
  if (artifacts.length === 0) {
    return [];
  }

  if (format === "md") {
    return artifacts.flatMap((artifact) => {
      const title = artifact.label ?? artifact.kind;
      const excerpt = getArtifactExcerptText(artifact, {
        maxLines: 2,
        maxCharsPerLine: 120,
      });
      return [
        `- **${title}** (${formatArtifactDescriptor(artifact)})`,
        excerpt ? `  - Excerpt: ${excerpt}` : null,
      ].filter((line): line is string => Boolean(line));
    });
  }

  return artifacts.flatMap((artifact) => {
    const title = artifact.label ?? artifact.kind;
    const excerpt = getArtifactExcerptText(artifact, {
      maxLines: 2,
      maxCharsPerLine: 120,
    });
    return [
      `- ${title} (${formatArtifactDescriptor(artifact)})`,
      excerpt ? `  Excerpt: ${excerpt}` : null,
    ].filter((line): line is string => Boolean(line));
  });
}

function formatExportAttachmentLines(
  attachments: MessageAttachment[],
  format: "txt" | "md"
): string[] {
  if (attachments.length === 0) {
    return [];
  }

  const formatLabel = (attachment: MessageAttachment) => {
    const label = attachment.label && attachment.label !== attachment.indexAlt
      ? attachment.label
      : null;
    const mime = attachment.mime ?? null;

    if (format === "md") {
      if (label && mime) return `- **${attachment.indexAlt}** — ${label} (${mime})`;
      if (label) return `- **${attachment.indexAlt}** — ${label}`;
      if (mime) return `- **${attachment.indexAlt}** (${mime})`;
      return `- **${attachment.indexAlt}**`;
    }

    if (label && mime) return `- ${attachment.indexAlt} — ${label} (${mime})`;
    if (label) return `- ${attachment.indexAlt} — ${label}`;
    if (mime) return `- ${attachment.indexAlt} (${mime})`;
    return `- ${attachment.indexAlt}`;
  };

  return attachments.map(formatLabel);
}

function groupAnnotations(annotations: Annotation[]): Map<number, Annotation[]> {
  const byConversation = new Map<number, Annotation[]>();
  const sorted = [...annotations].sort((a, b) => a.created_at - b.created_at);
  for (const annotation of sorted) {
    const list = byConversation.get(annotation.conversation_id) ?? [];
    list.push(annotation);
    byConversation.set(annotation.conversation_id, list);
  }
  return byConversation;
}

function groupSummaries(summaries: SummaryRecord[]): Map<number, SummaryRecord> {
  const byConversation = new Map<number, SummaryRecord>();
  for (const summary of summaries) {
    const existing = byConversation.get(summary.conversationId);
    if (!existing || summary.createdAt > existing.createdAt) {
      byConversation.set(summary.conversationId, summary);
    }
  }
  return byConversation;
}

export function buildExportJsonV1(dataset: ExportDataset): ExportPayload {
  const meta = getMeta();
  const payload = {
    schema_version: "vesti_export.v1",
    exported_at: meta.exportedAtIso,
    timezone: meta.timezone,
    app_version: meta.appVersion,
    data: {
      conversations: dataset.conversations.map((item) => ({
        ...item,
        origin_at: getConversationOriginAt(item),
        origin_at_iso: toIso(getConversationOriginAt(item)),
        first_captured_at_iso: toIso(getConversationFirstCapturedAt(item)),
        last_captured_at_iso: toIso(getConversationCaptureFreshnessAt(item)),
        created_at_iso: toIso(item.created_at),
        source_created_at_iso:
          item.source_created_at !== null ? toIso(item.source_created_at) : null,
        updated_at_iso: toIso(item.updated_at),
      })),
      messages: dataset.messages.map((item) => ({
        ...item,
        content_text: resolveMessageExportBodyText(item),
        content_ast: item.content_ast ?? null,
        content_ast_version: item.content_ast_version ?? null,
        citations: item.citations ?? [],
        attachments: item.attachments ?? [],
        artifacts: item.artifacts ?? [],
        normalized_html_snapshot: item.normalized_html_snapshot ?? null,
        degraded_nodes_count:
          typeof item.degraded_nodes_count === "number" &&
          Number.isFinite(item.degraded_nodes_count)
            ? Math.max(0, Math.floor(item.degraded_nodes_count))
            : 0,
        created_at_iso: toIso(item.created_at),
      })),
      summaries: dataset.summaries.map((item) => ({
        ...item,
        createdAtIso: toIso(item.createdAt),
        sourceUpdatedAtIso: toIso(item.sourceUpdatedAt),
      })),
      weeklyReports: dataset.weeklyReports.map((item) => ({
        ...item,
        rangeStartIso: toIso(item.rangeStart),
        rangeEndIso: toIso(item.rangeEnd),
        createdAtIso: toIso(item.createdAt),
      })),
      annotations: dataset.annotations.map((item) => ({
        ...item,
        created_at_iso: toIso(item.created_at),
      })),
    },
  };

  return {
    content: JSON.stringify(payload, null, 2),
    mime: "application/json",
    filename: `vesti-export-${meta.timestampTag}.json`,
  };
}

export function buildExportTxtV1(dataset: ExportDataset): ExportPayload {
  const meta = getMeta();
  const conversations = [...dataset.conversations].sort(
    (a, b) => getConversationOriginAt(a) - getConversationOriginAt(b)
  );
  const messagesByConversation = groupMessages(dataset.messages);
  const summariesByConversation = groupSummaries(dataset.summaries);
  const annotationsByConversation = groupAnnotations(dataset.annotations);
  const lines: string[] = [];
  const header = buildArchiveHeaderMeta(conversations);

  pushArchiveHeader(lines, header);
  lines.push("================================================================================");
  lines.push("");

  conversations.forEach((conversation, index) => {
    const messages = messagesByConversation.get(conversation.id) ?? [];
    const annotations = annotationsByConversation.get(conversation.id) ?? [];
    const annotationByMessage = new Map<number, Annotation[]>();
    for (const annotation of annotations) {
      const bucket = annotationByMessage.get(annotation.message_id) ?? [];
      bucket.push(annotation);
      annotationByMessage.set(annotation.message_id, bucket);
    }
    pushThreadHeader(lines, index, conversation, messages.length);

    for (const message of messages) {
      const role = message.role === "user" ? "User" : "AI";
      lines.push(`${role}: [${toLocalDateTime(message.created_at)}]`);
      const bodyText = resolveMessageExportBodyText(message);
      if (bodyText) {
        lines.push(bodyText);
      }
      for (const section of getTurnMessageSupplementSections(message)) {
        if (section.kind === "followup") {
          section.items.forEach((item, itemIndex) => {
            lines.push(`跟进 ${itemIndex + 1}:`);
            lines.push(item.content_text);
          });
        } else {
          lines.push(`过程 · ${section.title}:`);
          lines.push(...section.items.map(item => item.content_text));
        }
      }
      if ((message.citations ?? []).length > 0) {
        lines.push("Sources:");
        lines.push(...formatExportCitationLines(message.citations ?? [], "txt"));
      }
      if ((message.attachments ?? []).length > 0) {
        lines.push("Attachments:");
        lines.push(...formatExportAttachmentLines(message.attachments ?? [], "txt"));
      }
      if ((message.artifacts ?? []).length > 0) {
        lines.push("Artifacts:");
        lines.push(...formatExportArtifactLines(message.artifacts ?? [], "txt"));
      }
      const messageAnnotations = annotationByMessage.get(message.id) ?? [];
      for (const annotation of messageAnnotations) {
        const dayLabel = annotation.days_after === 1 ? "day" : "days";
        lines.push(
          `【Annotation】(${toLocalDateTime(annotation.created_at)} · ${annotation.days_after} ${dayLabel} after) ${annotation.content_text}`
        );
      }
      lines.push("");
    }

    const summary = summariesByConversation.get(conversation.id);
    if (summary) {
      lines.push("### Cached Summary");
      lines.push(`Summary Schema: ${summary.schemaVersion ?? "unknown"}`);
      lines.push(`Summary Created: ${toLocalDateTime(summary.createdAt)}`);
      lines.push("Summary Content:");
      lines.push(summary.content);
      lines.push("");
    }

    lines.push("================================================================================");
    lines.push("");
  });

  if (dataset.weeklyReports.length > 0) {
    lines.push("## Weekly Reports");
    lines.push("");
    dataset.weeklyReports
      .sort((a, b) => a.rangeStart - b.rangeStart)
      .forEach((report, index) => {
        lines.push(`### [Weekly ${String(index + 1).padStart(2, "0")}]`);
        lines.push(`Range: ${toLocalDateTime(report.rangeStart)} -> ${toLocalDateTime(report.rangeEnd)}`);
        lines.push(`Schema: ${report.schemaVersion ?? "unknown"}`);
        lines.push(`Created: ${toLocalDateTime(report.createdAt)}`);
        lines.push("Content:");
        lines.push(report.content);
        lines.push("");
      });
  }

  return {
    content: lines.join("\n"),
    mime: "text/plain;charset=utf-8",
    filename: `vesti-export-${meta.timestampTag}.txt`,
  };
}

export function buildExportMdV1(dataset: ExportDataset): ExportPayload {
  const meta = getMeta();
  const conversations = [...dataset.conversations].sort(
    (a, b) => getConversationOriginAt(a) - getConversationOriginAt(b)
  );
  const messagesByConversation = groupMessages(dataset.messages);
  const summariesByConversation = groupSummaries(dataset.summaries);
  const annotationsByConversation = groupAnnotations(dataset.annotations);
  const lines: string[] = [];
  const header = buildArchiveHeaderMeta(conversations);

  pushArchiveHeader(lines, header);
  lines.push("---");
  lines.push("");

  conversations.forEach((conversation, index) => {
    const messages = messagesByConversation.get(conversation.id) ?? [];
    const annotations = annotationsByConversation.get(conversation.id) ?? [];
    const annotationByMessage = new Map<number, Annotation[]>();
    for (const annotation of annotations) {
      const bucket = annotationByMessage.get(annotation.message_id) ?? [];
      bucket.push(annotation);
      annotationByMessage.set(annotation.message_id, bucket);
    }
    pushThreadHeader(lines, index, conversation, messages.length);
    lines.push("[正文内容从这里开始...]");
    lines.push("");

    for (const message of messages) {
      const role = message.role === "user" ? "User" : "AI";
      lines.push(`### ${role} [${toLocalDateTime(message.created_at)}]`);
      lines.push("");
      const bodyText = resolveMessageExportBodyText(message);
      if (bodyText) {
        lines.push(bodyText);
      }
      const supplementSections = getTurnMessageSupplementSections(message);
      for (const section of supplementSections.filter(item => item.kind === "followup")) {
        section.items.forEach((item, itemIndex) => {
          lines.push("");
          lines.push(`#### 跟进 ${itemIndex + 1}`);
          lines.push("");
          lines.push(item.content_text);
        });
      }
      const processSections = supplementSections.filter(item => item.kind !== "followup");
      if (processSections.length) {
        lines.push("", "<details>", "<summary>过程</summary>", "");
        for (const section of processSections) {
          lines.push(`#### ${section.title}`, "");
          section.items.forEach(item => lines.push(item.content_text, ""));
        }
        lines.push("</details>");
      }
      if ((message.citations ?? []).length > 0) {
        lines.push("");
        lines.push("#### Sources");
        lines.push("");
        lines.push(...formatExportCitationLines(message.citations ?? [], "md"));
      }
      if ((message.attachments ?? []).length > 0) {
        lines.push("");
        lines.push("#### Attachments");
        lines.push("");
        lines.push(...formatExportAttachmentLines(message.attachments ?? [], "md"));
      }
      if ((message.artifacts ?? []).length > 0) {
        lines.push("");
        lines.push("#### Artifacts");
        lines.push("");
        lines.push(...formatExportArtifactLines(message.artifacts ?? [], "md"));
      }
      const messageAnnotations = annotationByMessage.get(message.id) ?? [];
      if (messageAnnotations.length > 0) {
        lines.push("");
        messageAnnotations.forEach((annotation) => {
          const dayLabel = annotation.days_after === 1 ? "day" : "days";
          lines.push(
            `> 【Annotation】${toLocalDateTime(annotation.created_at)} · ${annotation.days_after} ${dayLabel} after`
          );
          lines.push(`> ${annotation.content_text}`);
          lines.push(">");
        });
      }
      lines.push("");
    }

    const summary = summariesByConversation.get(conversation.id);
    if (summary) {
      lines.push("### Cached Summary");
      lines.push("");
      lines.push(`- Schema: ${summary.schemaVersion ?? "unknown"}`);
      lines.push(`- Status: ${summary.status ?? "unknown"}`);
      lines.push(`- Model: ${summary.modelId}`);
      lines.push(`- Created: ${toIso(summary.createdAt)}`);
      lines.push("");
      lines.push(summary.content);
      lines.push("");
    }

    lines.push("---");
    lines.push("");
  });

  if (dataset.weeklyReports.length > 0) {
    lines.push("## Weekly Reports");
    lines.push("");
    dataset.weeklyReports
      .sort((a, b) => a.rangeStart - b.rangeStart)
      .forEach((report, index) => {
        lines.push(`### [Weekly ${String(index + 1).padStart(2, "0")}] ${toIso(report.rangeStart)} -> ${toIso(report.rangeEnd)}`);
        lines.push("");
        lines.push(`- Schema: ${report.schemaVersion ?? "unknown"}`);
        lines.push(`- Status: ${report.status ?? "unknown"}`);
        lines.push(`- Model: ${report.modelId}`);
        lines.push(`- Created: ${toIso(report.createdAt)}`);
        lines.push("");
        lines.push(report.content);
        lines.push("");
      });
  }

  return {
    content: lines.join("\n"),
    mime: "text/markdown;charset=utf-8",
    filename: `vesti-export-${meta.timestampTag}.md`,
  };
}
