import type { ContentPackageArtifactLike } from "./types";

function uniqueLines(lines: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const line of lines) {
    const normalized = line.replace(/\s+/g, " ").trim();
    if (!normalized) {
      continue;
    }
    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(normalized);
  }

  return result;
}

function stripHtmlToText(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h1|h2|h3|blockquote|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");
}

function collectExcerptLines(value: string, maxLines: number, maxCharsPerLine: number): string[] {
  return uniqueLines(
    value
      .replace(/\r/g, "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, maxLines)
      .map((line) =>
        line.length > maxCharsPerLine ? `${line.slice(0, maxCharsPerLine - 3).trimEnd()}...` : line
      ),
  );
}

export function formatArtifactDescriptor(artifact: ContentPackageArtifactLike): string {
  const parts: string[] = [artifact.kind];

  if (artifact.captureMode) {
    parts.push(`mode=${artifact.captureMode}`);
  }

  if (artifact.renderDimensions) {
    parts.push(`${artifact.renderDimensions.width}x${artifact.renderDimensions.height}`);
  }

  return parts.join(", ");
}

export function getArtifactExcerptLines(
  artifact: ContentPackageArtifactLike,
  options: {
    maxLines?: number;
    maxCharsPerLine?: number;
  } = {},
): string[] {
  const maxLines = options.maxLines ?? 2;
  const maxCharsPerLine = options.maxCharsPerLine ?? 120;

  if (artifact.markdownSnapshot?.trim()) {
    const lines = collectExcerptLines(artifact.markdownSnapshot, maxLines, maxCharsPerLine);
    if (lines.length > 0) {
      return lines;
    }
  }

  if (artifact.plainText?.trim()) {
    const lines = collectExcerptLines(artifact.plainText, maxLines, maxCharsPerLine);
    if (lines.length > 0) {
      return lines;
    }
  }

  if (artifact.normalizedHtmlSnapshot?.trim()) {
    const lines = collectExcerptLines(
      stripHtmlToText(artifact.normalizedHtmlSnapshot),
      maxLines,
      maxCharsPerLine,
    );
    if (lines.length > 0) {
      return lines;
    }
  }

  return [];
}

export function getArtifactExcerptText(
  artifact: ContentPackageArtifactLike,
  options: {
    maxLines?: number;
    maxCharsPerLine?: number;
    separator?: string;
  } = {},
): string | null {
  const lines = getArtifactExcerptLines(artifact, options);
  if (lines.length === 0) {
    return null;
  }

  return lines.join(options.separator ?? " | ");
}
