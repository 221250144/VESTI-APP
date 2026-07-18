import type {
  ContentPackageAttachmentLike,
  ContentPackageArtifactLike,
  ContentPackageCitationLike,
  ContentPackageMessageLike,
} from "./types";
import { formatArtifactDescriptor, getArtifactExcerptText } from "./artifactSummary";

function normalizeMultilineText(value: string | null | undefined): string {
  if (typeof value !== "string") {
    return "";
  }

  return value
    .replace(/\u00a0/g, " ")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeInlineText(value: string | null | undefined): string {
  return normalizeMultilineText(value).replace(/\n+/g, " ").trim();
}

function buildCitationSummaryLines(citations: ContentPackageCitationLike[]): string[] {
  return citations.map((citation) => `Source: ${citation.label} (${citation.host})`);
}

function buildAttachmentSummaryLine(attachment: ContentPackageAttachmentLike): string {
  const label =
    attachment.label && attachment.label !== attachment.indexAlt ? attachment.label : null;
  const mime = attachment.mime ?? null;

  if (label && mime) {
    return `Attachment: ${attachment.indexAlt} - ${label} (${mime})`;
  }
  if (label) {
    return `Attachment: ${attachment.indexAlt} - ${label}`;
  }
  if (mime) {
    return `Attachment: ${attachment.indexAlt} (${mime})`;
  }
  return `Attachment: ${attachment.indexAlt}`;
}

function buildArtifactSummaryLines(artifacts: ContentPackageArtifactLike[]): string[] {
  return artifacts.flatMap((artifact) => {
    const title = artifact.label ?? artifact.kind;
    const descriptor = formatArtifactDescriptor(artifact);
    const excerpt = getArtifactExcerptText(artifact, {
      maxLines: 2,
      maxCharsPerLine: 120,
      separator: " | ",
    });

    return [
      `Artifact: ${title} (${descriptor})`,
      excerpt ? `Artifact Excerpt: ${excerpt}` : null,
    ].filter((line): line is string => Boolean(line));
  });
}

export function buildMessageSidecarSummaryLines(
  message: Pick<ContentPackageMessageLike, "citations" | "attachments" | "artifacts">,
): string[] {
  const citations = buildCitationSummaryLines(message.citations ?? []);
  const attachments = (message.attachments ?? []).map(buildAttachmentSummaryLine);
  const artifacts = buildArtifactSummaryLines(message.artifacts ?? []);
  return [...citations, ...attachments, ...artifacts];
}

export function buildMessagePreviewText(
  message: Pick<ContentPackageMessageLike, "content_text" | "citations" | "attachments" | "artifacts">,
  options: {
    maxChars?: number;
    separator?: string;
    includeSidecarsWhenBodyPresent?: boolean;
  } = {},
): string {
  const bodyText = normalizeInlineText(message.content_text);
  const sidecarText = buildMessageSidecarSummaryLines(message).join(options.separator ?? " | ");

  let value = bodyText;
  if (options.includeSidecarsWhenBodyPresent && sidecarText) {
    value = [bodyText, sidecarText].filter(Boolean).join(options.separator ?? " | ");
  } else if (!value) {
    value = sidecarText;
  }

  const maxChars = options.maxChars ?? 0;
  if (maxChars > 0 && value.length > maxChars) {
    return `${value.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
  }
  return value;
}

export function buildMessageFallbackDisplayText(
  message: Pick<ContentPackageMessageLike, "content_text" | "citations" | "attachments" | "artifacts">,
): string {
  const bodyText = normalizeMultilineText(message.content_text);
  if (bodyText) {
    return bodyText;
  }

  return buildMessageSidecarSummaryLines(message).join("\n").trim();
}
