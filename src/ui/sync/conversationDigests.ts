// Shared digest listing (P1.5): digest rows for every local-terminal
// conversation, sourced from the cached conversation tree (which carries
// one_liner/topics/files/decisions). Used by the desktop storage surface and
// the P4c daily-log pipeline.

import { db } from "../db/schema";
import type { ConversationRecord } from "../db/schema";
import type { ConversationDigest } from "@vesti/ui";
import { loadConversationTree } from "./conversationTree";

type LocalTerminalFields = {
  _cli_id?: string;
};

export async function listConversationDigests(): Promise<ConversationDigest[]> {
  const tree = await loadConversationTree();
  const digestByCliId = new Map<string, Omit<ConversationDigest, "conversationId">>();
  for (const source of tree.sources) {
    for (const project of source.projects) {
      for (const session of project.sessions) {
        if (!session.oneLiner) continue;
        digestByCliId.set(session.id, {
          oneLiner: session.oneLiner,
          keyTopics: session.keyTopics,
          keyFiles: session.keyFiles,
          decisions: session.decisions,
        });
      }
    }
  }
  if (digestByCliId.size === 0) return [];
  const records = (await db.conversations.toArray()) as Array<
    ConversationRecord & LocalTerminalFields
  >;
  const digests: ConversationDigest[] = [];
  for (const record of records) {
    if (typeof record.id !== "number" || typeof record._cli_id !== "string") continue;
    const digest = digestByCliId.get(record._cli_id);
    if (digest) digests.push({ conversationId: record.id, ...digest });
  }
  return digests;
}
