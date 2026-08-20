import type { Conversation, Message, TurnMessageSegment } from "../../types";

export type FollowupPlacement = "under_prompt" | "inside_response";

export const FOLLOWUP_PLACEMENT_PREFERENCE_KEY = "library.followupPlacement";

export function getConversationTurnCount(
  conversation: Conversation | undefined,
  messages: Message[],
): number {
  if (
    typeof conversation?.turn_count === "number"
    && Number.isFinite(conversation.turn_count)
  ) {
    return Math.max(0, Math.floor(conversation.turn_count));
  }
  const ids = new Set(messages.flatMap(message => message._turn_id ? [message._turn_id] : []));
  return ids.size || messages.filter(message => message.role === "user").length;
}

export function buildFollowupsByTurn(
  messages: Message[],
): Map<string, TurnMessageSegment[]> {
  const result = new Map<string, TurnMessageSegment[]>();
  for (const message of messages) {
    if (message._turn_id && message._followups?.length) {
      result.set(message._turn_id, message._followups);
    }
  }
  return result;
}

export function shouldRenderFollowupsUnderPrompt(
  message: Message,
  placement: FollowupPlacement,
  responseTurnIds: ReadonlySet<string>,
): boolean {
  if (placement === "under_prompt") return true;
  return !message._turn_id || !responseTurnIds.has(message._turn_id);
}
