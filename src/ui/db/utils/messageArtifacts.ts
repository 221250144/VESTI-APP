import type { MessageArtifact, MessageArtifactKind } from "../types";

export function createMessageArtifact(params: {
  kind: MessageArtifactKind;
  label?: string;
}): MessageArtifact {
  const label = params.label?.trim();
  return label
    ? { kind: params.kind, label }
    : { kind: params.kind };
}

export function normalizeMessageArtifacts(value: unknown): MessageArtifact[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized: MessageArtifact[] = [];
  const seen = new Set<string>();

  for (const item of value) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const record = item as {
      kind?: unknown;
      label?: unknown;
      captureMode?: unknown;
      renderDimensions?: unknown;
      plainText?: unknown;
      markdownSnapshot?: unknown;
      normalizedHtmlSnapshot?: unknown;
    };

    const kind =
      record.kind === "canvas" ||
      record.kind === "preview" ||
      record.kind === "code_artifact" ||
      record.kind === "download_card"
        || record.kind === "standalone_artifact"
        ? record.kind
        : "unknown";

    const artifact = createMessageArtifact({
      kind,
      label: typeof record.label === "string" ? record.label : undefined,
    });

    if (
      record.captureMode === "presence_only" ||
      record.captureMode === "embedded_dom_snapshot" ||
      record.captureMode === "standalone_artifact"
    ) {
      artifact.captureMode = record.captureMode;
    }

    if (
      record.renderDimensions &&
      typeof record.renderDimensions === "object" &&
      typeof (record.renderDimensions as { width?: unknown }).width === "number" &&
      typeof (record.renderDimensions as { height?: unknown }).height === "number"
    ) {
      artifact.renderDimensions = {
        width: (record.renderDimensions as { width: number }).width,
        height: (record.renderDimensions as { height: number }).height,
      };
    }

    if (typeof record.plainText === "string") {
      artifact.plainText = record.plainText;
    }

    if (typeof record.markdownSnapshot === "string") {
      artifact.markdownSnapshot = record.markdownSnapshot;
    }

    if (typeof record.normalizedHtmlSnapshot === "string") {
      artifact.normalizedHtmlSnapshot = record.normalizedHtmlSnapshot;
    }

    const renderSignature = artifact.renderDimensions
      ? `${artifact.renderDimensions.width}x${artifact.renderDimensions.height}`
      : "";
    const signature = [
      artifact.kind,
      artifact.label ?? "",
      artifact.captureMode ?? "",
      renderSignature,
      artifact.plainText ?? "",
      artifact.markdownSnapshot ?? "",
      artifact.normalizedHtmlSnapshot ?? "",
    ].join("|");
    if (seen.has(signature)) {
      continue;
    }

    seen.add(signature);
    normalized.push(artifact);
  }

  return normalized;
}
