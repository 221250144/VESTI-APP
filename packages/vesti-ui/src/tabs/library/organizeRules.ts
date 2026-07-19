// Organizer assistant rule engine (P2b) — pure, React-free local rules.
//
// No LLM involved: every action is a deterministic rule over the library
// conversation list. The panel previews the affected set, then executes via
// StorageApi methods (soft trash / bulk tag / per-conversation topic move),
// which the capture re-sync merge preserves.

import type { Conversation } from "../../types";

/** Organizer rules look at capture lineage fields the desktop shell stamps on
 * records (`uuid`, `_source`); both are absent in the extension build. */
export type OrganizerConversation = Conversation & {
  uuid?: string;
  _source?: string;
};

const TAG_CAP = 6;

// ---- Empty conversations ------------------------------------------------------

/**
 * Empty conversations: nothing captured yet. On desktop `message_count` is
 * stamped from the message table (user/ai roles only — there are no "system"
 * messages in the desktop schema), so count === 0 covers the
 * "no real messages" case.
 */
export function findEmptyConversations<T extends OrganizerConversation>(
  conversations: T[],
): T[] {
  return conversations.filter(
    (conversation) =>
      !conversation.is_trash && (conversation.message_count ?? 0) === 0,
  );
}

// ---- Duplicate candidates -------------------------------------------------------

export type DuplicateReason = "same_source_id" | "same_title";

export type DuplicateGroup<T extends OrganizerConversation = OrganizerConversation> = {
  key: string;
  reason: DuplicateReason;
  /** All conversations in the group, keep first. */
  conversations: T[];
  keepId: number;
  duplicateIds: number[];
};

function sourceOf(conversation: OrganizerConversation): string {
  return conversation._source ?? "unknown";
}

/** Pick the copy worth keeping: most messages, then most recently updated,
 * then the lowest id for a stable result. */
export function pickDuplicateKeep<T extends OrganizerConversation>(
  group: T[],
): T {
  return [...group].sort((a, b) => {
    const byMessages = (b.message_count ?? 0) - (a.message_count ?? 0);
    if (byMessages !== 0) return byMessages;
    const byUpdated = (b.updated_at ?? 0) - (a.updated_at ?? 0);
    if (byUpdated !== 0) return byUpdated;
    return a.id - b.id;
  })[0];
}

function toGroup<T extends OrganizerConversation>(
  key: string,
  reason: DuplicateReason,
  conversations: T[],
): DuplicateGroup<T> {
  const keep = pickDuplicateKeep(conversations);
  const ordered = [keep, ...conversations.filter((item) => item.id !== keep.id)];
  return {
    key,
    reason,
    conversations: ordered,
    keepId: keep.id,
    duplicateIds: ordered.slice(1).map((item) => item.id),
  };
}

/**
 * Duplicate candidates across capture sources:
 *  1. same `platform + uuid` captured by more than one `_source`
 *     (e.g. a CLI session also captured by the browser extension);
 *  2. byte-identical titles (after trimming) across more than one `_source`.
 * A conversation appears in at most one group (rule 1 wins).
 */
export function findDuplicateGroups<T extends OrganizerConversation>(
  conversations: T[],
): DuplicateGroup<T>[] {
  const candidates = conversations.filter((conversation) => !conversation.is_trash);
  const groups: DuplicateGroup<T>[] = [];
  const claimed = new Set<number>();

  const byPlatformUuid = new Map<string, T[]>();
  for (const conversation of candidates) {
    if (!conversation.uuid) continue;
    const key = `${conversation.platform}|${conversation.uuid}`;
    const bucket = byPlatformUuid.get(key) ?? [];
    bucket.push(conversation);
    byPlatformUuid.set(key, bucket);
  }
  for (const [key, bucket] of byPlatformUuid) {
    if (bucket.length < 2) continue;
    if (new Set(bucket.map(sourceOf)).size < 2) continue;
    const group = toGroup(key, "same_source_id", bucket);
    groups.push(group);
    for (const item of bucket) claimed.add(item.id);
  }

  const byTitle = new Map<string, T[]>();
  for (const conversation of candidates) {
    if (claimed.has(conversation.id)) continue;
    const title = (conversation.title ?? "").trim();
    if (!title) continue;
    const bucket = byTitle.get(title) ?? [];
    bucket.push(conversation);
    byTitle.set(title, bucket);
  }
  for (const [title, bucket] of byTitle) {
    if (bucket.length < 2) continue;
    if (new Set(bucket.map(sourceOf)).size < 2) continue;
    groups.push(toGroup(title, "same_title", bucket));
  }

  return groups;
}

// ---- Batch tag ------------------------------------------------------------------

export type BatchTagChange = {
  id: number;
  title: string;
  nextTags: string[];
};

/** Conversations in scope that don't carry `tag` yet and still have room under
 * the tag cap (mirrors the repository rule). */
export function buildBatchTagPlan<T extends OrganizerConversation>(
  conversations: T[],
  tag: string,
  tagCap: number = TAG_CAP,
): BatchTagChange[] {
  const normalized = tag.trim();
  if (!normalized) return [];
  const lowered = normalized.toLowerCase();
  const plan: BatchTagChange[] = [];
  for (const conversation of conversations) {
    if (conversation.is_trash) continue;
    const tags = Array.isArray(conversation.tags) ? conversation.tags : [];
    if (tags.some((existing) => existing.trim().toLowerCase() === lowered)) {
      continue;
    }
    if (tags.length >= tagCap) continue;
    plan.push({
      id: conversation.id,
      title: conversation.title,
      nextTags: [...tags, normalized],
    });
  }
  return plan;
}

// ---- Batch archive (move to topic) -------------------------------------------------

export type ArchiveChange = {
  id: number;
  title: string;
  fromTopicId: number | null;
  toTopicId: number | null;
};

/** Conversations in scope whose topic assignment would actually change. */
export function buildArchivePlan<T extends OrganizerConversation>(
  conversations: T[],
  targetTopicId: number | null,
): ArchiveChange[] {
  const plan: ArchiveChange[] = [];
  for (const conversation of conversations) {
    if (conversation.is_trash) continue;
    const current = conversation.topic_id ?? null;
    if (current === targetTopicId) continue;
    plan.push({
      id: conversation.id,
      title: conversation.title,
      fromTopicId: current,
      toTopicId: targetTopicId,
    });
  }
  return plan;
}

/** Scope helper for the time-window archive variant. */
export function filterOlderThan<T extends OrganizerConversation>(
  conversations: T[],
  cutoffTimestamp: number,
): T[] {
  return conversations.filter(
    (conversation) =>
      !conversation.is_trash && (conversation.updated_at ?? 0) < cutoffTimestamp,
  );
}
