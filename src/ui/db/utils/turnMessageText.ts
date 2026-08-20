import type { Message } from "../types";
import { resolveCanonicalBodyText } from "./messageContentPackage";

type TurnMessageTextLike = Pick<
  Message,
  "content_text" | "_followups" | "_progress_segments" | "_thinking_segments"
> & { content_ast?: unknown };

export interface TurnMessageSupplementSection {
  kind: "followup" | "progress" | "thinking";
  title: "跟进" | "进度" | "思考";
  items: NonNullable<Message["_followups"]>;
}

export function getTurnMessageSupplementSections(
  message: Pick<Message, "_followups" | "_progress_segments" | "_thinking_segments">,
): TurnMessageSupplementSection[] {
  const sections: TurnMessageSupplementSection[] = [];
  const followups = (message._followups ?? []).filter(item => item.content_text.trim());
  const progress = (message._progress_segments ?? []).filter(item => item.content_text.trim());
  const thinking = (message._thinking_segments ?? []).filter(item => item.content_text.trim());
  if (followups.length) sections.push({ kind: "followup", title: "跟进", items: followups });
  if (progress.length) sections.push({ kind: "progress", title: "进度", items: progress });
  if (thinking.length) sections.push({ kind: "thinking", title: "思考", items: thinking });
  return sections;
}

export function getTurnMessageAnalysisText(
  message: TurnMessageTextLike,
  options: { includeProcess?: boolean } = {},
): string {
  const parts: string[] = [];
  const body = resolveCanonicalBodyText(message as Message).trim();
  if (body) parts.push(body);
  for (const section of getTurnMessageSupplementSections(message)) {
    if (section.kind === "followup") {
      section.items.forEach((followup, index) => {
        parts.push(`跟进 ${index + 1}：${followup.content_text.trim()}`);
      });
    } else if (options.includeProcess) {
      parts.push(`过程（${section.title}）：\n${section.items.map(item => item.content_text.trim()).join("\n\n")}`);
    }
  }
  return parts.join("\n\n");
}
