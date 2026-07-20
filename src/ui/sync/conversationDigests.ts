// Shared digest listing (P1.5): digest rows for every local-terminal
// conversation, sourced from the cached conversation tree (which carries
// one_liner/topics/files/decisions). Used by the desktop storage surface and
// the P4c daily-log pipeline.
//
// The result is memoized on (tree object identity, Dexie data version): the
// cli_id → conversation-id mapping requires a full Dexie scan, which is only
// redone when one of the two inputs actually changed.

import { db } from "../db/schema";
import type { ConversationRecord } from "../db/schema";
import type { ConversationDigest } from "@vesti/ui";
import type { ConversationTree } from "../../shared/contracts";
import { loadConversationTree } from "./conversationTree";
import { getDexieDataVersion } from "./dataVersion";

type LocalTerminalFields = {
  _cli_id?: string;
};

let memo: {
  tree: ConversationTree;
  dexieVersion: number;
  digests: ConversationDigest[];
} | null = null;

export async function listConversationDigests(): Promise<ConversationDigest[]> {
  const tree = await loadConversationTree();
  const dexieVersion = getDexieDataVersion();
  if (memo && memo.tree === tree && memo.dexieVersion === dexieVersion) {
    return memo.digests;
  }
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
          projectKey: project.projectKey,
          projectLabel: project.label,
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
  memo = { tree, dexieVersion, digests };
  return digests;
}
