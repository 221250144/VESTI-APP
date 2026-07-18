import { formatArtifactDescriptor, getArtifactExcerptText } from "@vesti/content-package";
import type { Message, MessageAttachment, MessageArtifact, MessageCitation } from "../types";
import { resolveCanonicalBodyText } from "./messageContentPackage";

export type MessageExportFormat = "txt" | "md";

export interface MessageExportSection {
  title: "Sources" | "Attachments" | "Artifacts";
  lines: string[];
}

function formatCitationLines(
  citations: MessageCitation[],
  format: MessageExportFormat,
): string[] {
  if (citations.length === 0) {
    return [];
  }

  if (format === "md") {
    return citations.map((citation) => `- [${citation.label}](${citation.href}) (${citation.host})`);
  }

  return citations.map((citation) => `- ${citation.label} - ${citation.href}`);
}

function formatAttachmentLabel(
  attachment: MessageAttachment,
  format: MessageExportFormat,
): string {
  const label =
    attachment.label && attachment.label !== attachment.indexAlt ? attachment.label : null;
  const mime = attachment.mime ?? null;

  if (format === "md") {
    if (label && mime) return `- **${attachment.indexAlt}** - ${label} (${mime})`;
    if (label) return `- **${attachment.indexAlt}** - ${label}`;
    if (mime) return `- **${attachment.indexAlt}** (${mime})`;
    return `- **${attachment.indexAlt}**`;
  }

  if (label && mime) return `- ${attachment.indexAlt} - ${label} (${mime})`;
  if (label) return `- ${attachment.indexAlt} - ${label}`;
  if (mime) return `- ${attachment.indexAlt} (${mime})`;
  return `- ${attachment.indexAlt}`;
}

function formatAttachmentLines(
  attachments: MessageAttachment[],
  format: MessageExportFormat,
): string[] {
  if (attachments.length === 0) {
    return [];
  }

  return attachments.map((attachment) => formatAttachmentLabel(attachment, format));
}

function formatArtifactLines(
  artifacts: MessageArtifact[],
  format: MessageExportFormat,
): string[] {
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

export function resolveMessageExportBodyText(message: Message): string {
  return resolveCanonicalBodyText(message);
}

export function buildMessageExportSections(
  message: Message,
  format: MessageExportFormat,
): MessageExportSection[] {
  const sections: MessageExportSection[] = [];
  const citationLines = formatCitationLines(message.citations ?? [], format);
  if (citationLines.length > 0) {
    sections.push({ title: "Sources", lines: citationLines });
  }

  const attachmentLines = formatAttachmentLines(message.attachments ?? [], format);
  if (attachmentLines.length > 0) {
    sections.push({ title: "Attachments", lines: attachmentLines });
  }

  const artifactLines = formatArtifactLines(message.artifacts ?? [], format);
  if (artifactLines.length > 0) {
    sections.push({ title: "Artifacts", lines: artifactLines });
  }

  return sections;
}
