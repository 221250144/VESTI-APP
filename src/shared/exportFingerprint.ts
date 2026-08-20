// Shared content fingerprint for the conversation export pipeline. The main
// process (captureService) diffs each freshly built bundle against the last
// exported fingerprint so unchanged sessions never cross IPC; the renderer
// (captureSync) stamps the same hash on mirrored records so user-curated
// fields survive re-syncs. Both sides must stay on this one implementation —
// a session whose content did not change must always hash identically.

import type { ConversationExportBundle } from "./contracts";

/**
 * Content fingerprint for one exported bundle: a djb2-style 32-bit rolling
 * hash over the fields that move when the source capture changes —
 * conversation updated_at/message_count/title/snippet, and per message its
 * stable id, created_at, role and content length. O(messages) with O(1)
 * work per message (no content scan), so 2000 conversations x 40 messages
 * cost single-digit milliseconds.
 *
 * Coverage note: an in-place content edit that keeps the exact same length
 * AND the same updated_at would be missed; CLI captures are append-mostly
 * (streaming growth changes length), so this trade-off is deliberate.
 */
export function computeBundleFingerprint(
  conversation: ConversationExportBundle["conversation"],
  messages: ConversationExportBundle["messages"]
): number {
  let hash = 5381;
  const mix = (value: number) => {
    hash = ((hash * 33) ^ (value | 0)) >>> 0;
  };
  mix(conversation.updated_at);
  mix(conversation.message_count);
  mix(conversation.turn_count);
  mix(conversation.first_captured_at);
  mix(conversation.snippet?.length ?? 0);
  const title = conversation.title ?? "";
  for (let index = 0; index < title.length; index += 1) {
    mix(title.charCodeAt(index));
  }
  // A1: subagent lineage can resolve after the transcript itself last moved
  // (link resolution is a separate pass); mix it in so the stamp still
  // propagates to the mirror even when nothing else changed.
  const lineage = conversation._subagent_of ?? "";
  for (let index = 0; index < lineage.length; index += 1) {
    mix(lineage.charCodeAt(index));
  }
  for (const message of messages) {
    mix(message.id);
    mix(message.created_at);
    mix(message.content_text?.length ?? 0);
    mix(message.role === "user" ? 1 : 2);
    for (const segment of [
      ...(message._followups ?? []),
      ...(message._progress_segments ?? []),
      ...(message._thinking_segments ?? []),
    ]) {
      mix(segment.id);
      mix(segment.created_at);
      mix(segment.content_text.length);
    }
  }
  return hash >>> 0;
}
