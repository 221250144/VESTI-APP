import type { MessageCitation, MessageCitationSourceType } from "../types";

function stripTrackingParams(url: URL): URL {
  const stripped = new URL(url.toString());
  const keysToDelete: string[] = [];

  stripped.searchParams.forEach((_value, key) => {
    if (key.toLowerCase().startsWith("utm_")) {
      keysToDelete.push(key);
    }
  });

  for (const key of keysToDelete) {
    stripped.searchParams.delete(key);
  }

  return stripped;
}

function normalizeHost(value: string): string {
  return value.replace(/^www\./i, "").toLowerCase();
}

export function normalizeCitationLabel(value: string): string {
  return value
    .replace(/\r/g, "")
    .split("\n")
    .map((part) => part.trim())
    .find((part) => part.length > 0) ?? "";
}

export function normalizeCitationHref(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const url = stripTrackingParams(new URL(trimmed));
    return url.toString();
  } catch {
    return null;
  }
}

export function createMessageCitation(params: {
  label: string;
  href: string;
  sourceType: MessageCitationSourceType;
}): MessageCitation | null {
  const label = normalizeCitationLabel(params.label);
  const href = normalizeCitationHref(params.href);
  if (!label || !href) {
    return null;
  }

  try {
    const host = normalizeHost(new URL(href).hostname);
    if (!host) {
      return null;
    }

    return {
      label,
      href,
      host,
      sourceType: params.sourceType,
    };
  } catch {
    return null;
  }
}

export function normalizeMessageCitations(value: unknown): MessageCitation[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set<string>();
  const normalized: MessageCitation[] = [];

  for (const item of value) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const record = item as {
      label?: unknown;
      href?: unknown;
      host?: unknown;
      sourceType?: unknown;
    };

    if (typeof record.label !== "string" || typeof record.href !== "string") {
      continue;
    }

    const citation = createMessageCitation({
      label: record.label,
      href: record.href,
      sourceType:
        record.sourceType === "inline_pill" ||
        record.sourceType === "search_card" ||
        record.sourceType === "reference_list"
          ? record.sourceType
          : "unknown",
    });

    if (!citation) {
      continue;
    }

    if (seen.has(citation.href)) {
      continue;
    }

    seen.add(citation.href);
    normalized.push(citation);
  }

  return normalized;
}
