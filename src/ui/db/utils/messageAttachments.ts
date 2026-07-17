import type { MessageAttachment } from "../types";

const GENERIC_IMAGE_LABELS = new Set([
  "uploaded image",
  "uploaded images",
  "image",
  "images",
  "已上传的图片",
  "已上传图片",
  "图片",
]);

const MIME_BY_EXTENSION: Record<string, string> = {
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  html: "text/html",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  zip: "application/zip",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  mp4: "video/mp4",
  mov: "video/quicktime",
};

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function sanitizeAttachmentLabel(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = normalizeWhitespace(value);
  if (!normalized) {
    return undefined;
  }

  if (GENERIC_IMAGE_LABELS.has(normalized.toLowerCase())) {
    return undefined;
  }

  if (
    /^(?:open|view)(?:\s+[\w-]+){0,3}\s+image$/i.test(normalized) ||
    /^(?:以全视图打开图片|打开图片|查看图片|查看已上传图片)$/i.test(normalized)
  ) {
    return undefined;
  }

  return normalized;
}

export function inferMimeFromLabel(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = normalizeWhitespace(value).toLowerCase();
  if (!normalized) {
    return null;
  }

  if (/^(pdf|csv|json|html|txt|markdown|docx?|xlsx?|pptx?|zip|png|jpe?g|gif|webp|svg|mp3|wav|mp4|mov)$/.test(normalized)) {
    return MIME_BY_EXTENSION[normalized] ?? null;
  }

  const extensionMatch = normalized.match(/\.([a-z0-9]{2,8})$/i);
  if (!extensionMatch?.[1]) {
    return null;
  }

  return MIME_BY_EXTENSION[extensionMatch[1].toLowerCase()] ?? null;
}

export function createMessageAttachment(params: {
  indexAlt: string;
  label?: string;
  mime?: string | null;
  occurrenceRole?: "user_upload";
}): MessageAttachment | null {
  const indexAlt = normalizeWhitespace(params.indexAlt);
  if (!indexAlt) {
    return null;
  }

  const label = sanitizeAttachmentLabel(params.label);
  const mime =
    typeof params.mime === "string" ? normalizeWhitespace(params.mime).toLowerCase() || null : null;

  return {
    indexAlt,
    label,
    mime,
    occurrenceRole: params.occurrenceRole ?? "user_upload",
  };
}

export function normalizeMessageAttachments(value: unknown): MessageAttachment[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized: MessageAttachment[] = [];
  const seen = new Set<string>();

  for (const item of value) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const record = item as {
      indexAlt?: unknown;
      label?: unknown;
      mime?: unknown;
      occurrenceRole?: unknown;
    };

    if (typeof record.indexAlt !== "string") {
      continue;
    }

    const attachment = createMessageAttachment({
      indexAlt: record.indexAlt,
      label: typeof record.label === "string" ? record.label : undefined,
      mime: typeof record.mime === "string" ? record.mime : null,
      occurrenceRole: record.occurrenceRole === "user_upload" ? "user_upload" : "user_upload",
    });

    if (!attachment) {
      continue;
    }

    const signature = [
      attachment.indexAlt,
      attachment.label ?? "",
      attachment.mime ?? "",
      attachment.occurrenceRole,
    ].join("|");

    if (seen.has(signature)) {
      continue;
    }

    seen.add(signature);
    normalized.push(attachment);
  }

  return normalized;
}
