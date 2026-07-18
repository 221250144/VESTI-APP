import {
  buildMessageFallbackDisplayText as buildContentPackageFallbackDisplayText,
  buildMessagePreviewText as buildContentPackagePreviewText,
  buildMessageSidecarSummaryLines as buildContentPackageSidecarSummaryLines,
} from "@vesti/content-package";
import type { Message } from "../types";
import { extractAstPlainText, isAstRoot, shouldPreferAstCanonicalText } from "./astText";

type MessageContentPackageLike = {
  content_text: string;
  content_ast?: unknown;
  citations?: Message["citations"];
  attachments?: Message["attachments"];
  artifacts?: Message["artifacts"];
};

function normalizeBodyText(value: string): string {
  return value
    .replace(/\r/g, "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function resolveCanonicalBodyText(
  message: Pick<MessageContentPackageLike, "content_text" | "content_ast">
): string {
  const fallbackText = normalizeBodyText(message.content_text);
  const astRoot = isAstRoot(message.content_ast) ? message.content_ast : null;

  if (
    astRoot &&
    shouldPreferAstCanonicalText({
      root: astRoot,
      fallbackText,
    })
  ) {
    const canonical = normalizeBodyText(extractAstPlainText(astRoot));
    if (canonical) {
      return canonical;
    }
  }

  return fallbackText;
}

export function buildMessageSidecarSummaryLines(message: MessageContentPackageLike): string[] {
  return buildContentPackageSidecarSummaryLines(message);
}

export function buildMessagePreviewText(
  message: MessageContentPackageLike,
  options: {
    maxChars?: number;
    separator?: string;
    includeSidecarsWhenBodyPresent?: boolean;
  } = {},
): string {
  return buildContentPackagePreviewText(
    {
      ...message,
      content_text: resolveCanonicalBodyText(message),
    },
    options,
  );
}

export function buildMessageFallbackDisplayText(
  message: MessageContentPackageLike
): string {
  return buildContentPackageFallbackDisplayText({
    ...message,
    content_text: resolveCanonicalBodyText(message),
  });
}

export function buildMessageSearchIndexText(message: MessageContentPackageLike): string {
  const bodyText = resolveCanonicalBodyText(message);
  const sidecarLines = buildContentPackageSidecarSummaryLines(message);
  return [bodyText, ...sidecarLines].filter(Boolean).join("\n").trim();
}
