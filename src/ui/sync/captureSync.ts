// Capture sync: mirrors the main process's local-terminal session export
// (Codex / Cursor / Kimi Code / Claude Code, stored in SQLite) into the
// renderer's Dexie database so the @vesti/ui dashboard reads real data.
//
// On startup it pulls the full snapshot via window.vesti.exportConversations()
// and imports it idempotently; afterwards it re-imports on
// window.vesti.onCaptureChanged, debounced. Conversations that disappear from
// the snapshot are reconciled away — but only records stamped
// _source === "local_terminal", never user data (notes, annotations, prompts,
// topics, summaries live in other tables and are untouched).
//
// Outside Electron (no window.vesti bridge) every entry point is a no-op.

import { db } from "../db/schema";
import type { ConversationRecord, MessageRecord } from "../db/schema";
import { logger } from "../db/logger";
import type {
  ConversationExportBundle,
  VestiDesktopApi,
} from "../../shared/contracts";
import { bumpDexieDataVersion } from "./dataVersion";

export interface CaptureSyncState {
  syncing: boolean;
  lastSyncAt: number | null;
  conversationCount: number;
}

export type CaptureSyncListener = (state: CaptureSyncState) => void;

const DEBOUNCE_MS = 500;

// The main process stamps these on every exported record (see contracts.ts).
type LocalTerminalFields = {
  _source?: string;
  /** Rolling content hash written by importBundles; compared on the next
   * sync so unchanged conversations (and their messages) are not rewritten. */
  _sync_fingerprint?: number;
};

let state: CaptureSyncState = {
  syncing: false,
  lastSyncAt: null,
  conversationCount: 0,
};

const listeners = new Set<CaptureSyncListener>();
let started = false;
let hadSynced = false;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let running: Promise<void> | null = null;
let rerunRequested = false;

function vestiApi(): VestiDesktopApi | null {
  return typeof window !== "undefined" && window.vesti ? window.vesti : null;
}

function setState(patch: Partial<CaptureSyncState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) {
    listener(state);
  }
}

export function getCaptureSyncState(): CaptureSyncState {
  return state;
}

export function subscribeCaptureSync(
  listener: CaptureSyncListener
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

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
  mix(conversation.first_captured_at);
  mix(conversation.snippet?.length ?? 0);
  const title = conversation.title ?? "";
  for (let index = 0; index < title.length; index += 1) {
    mix(title.charCodeAt(index));
  }
  for (const message of messages) {
    mix(message.id);
    mix(message.created_at);
    mix(message.content_text?.length ?? 0);
    mix(message.role === "user" ? 1 : 2);
  }
  return hash >>> 0;
}

export type ImportPlan = {
  /** Conversations to write: new or fingerprint-changed, merged over the
   * previous record's user-curated fields and stamped with the new hash. */
  toPut: ConversationRecord[];
  /** Ids whose messages must be replaced (same set as toPut's ids). */
  changedIds: number[];
  /** Messages belonging to changed conversations. */
  changedMessages: MessageRecord[];
  /** local_terminal conversations absent from the snapshot (deleted upstream). */
  staleIds: number[];
};

/**
 * Diff an export snapshot against the current conversations table (pure).
 * Unchanged conversations are skipped entirely — no conversation put, no
 * message delete/rewrite — and records from before the fingerprint era
 * simply count as changed once, then self-heal.
 */
export function planImport(
  bundles: ConversationExportBundle[],
  previousRecords: Array<ConversationRecord & LocalTerminalFields>
): ImportPlan {
  const keep = new Set(bundles.map((bundle) => bundle.conversation.id));
  const previousById = new Map<number, ConversationRecord & LocalTerminalFields>();
  for (const record of previousRecords) {
    if (typeof record.id === "number") previousById.set(record.id, record);
  }

  const toPut: ConversationRecord[] = [];
  const changedIds: number[] = [];
  const changedMessages: MessageRecord[] = [];

  for (const bundle of bundles) {
    const conversation = bundle.conversation as unknown as ConversationRecord &
      LocalTerminalFields;
    const fingerprint = computeBundleFingerprint(
      bundle.conversation,
      bundle.messages
    );
    const prev =
      conversation.id !== undefined ? previousById.get(conversation.id) : undefined;
    if (prev && prev._sync_fingerprint === fingerprint) {
      continue;
    }
    const merged: ConversationRecord & LocalTerminalFields = prev
      ? {
          ...conversation,
          // User-curated fields live on the same record; merge them over the
          // fresh export instead of letting a re-sync wipe them.
          topic_id: prev.topic_id ?? null,
          is_starred: prev.is_starred ?? false,
          tags: Array.isArray(prev.tags) ? prev.tags : conversation.tags,
          // P2a auto-classify bookkeeping rides the same merge so a re-sync
          // never wipes it.
          auto_classified: prev.auto_classified ?? 0,
          classify_suggestion: prev.classify_suggestion ?? null,
          // P2b: local trash/archive flags are user organization state; the
          // source export always reports them false, so without preserving
          // them a re-sync would silently resurrect organized-away records.
          is_trash: prev.is_trash ?? false,
          is_archived: prev.is_archived ?? false,
          _sync_fingerprint: fingerprint,
        }
      : { ...conversation, _sync_fingerprint: fingerprint };
    toPut.push(merged);
    if (typeof conversation.id === "number") {
      changedIds.push(conversation.id);
      for (const message of bundle.messages) {
        changedMessages.push(message as unknown as MessageRecord);
      }
    }
  }

  // Reconcile: local-terminal conversations absent from the snapshot were
  // deleted at the source; drop them and their messages here too.
  const staleIds = previousRecords
    .filter(
      (record) =>
        record._source === "local_terminal" &&
        typeof record.id === "number" &&
        !keep.has(record.id)
    )
    .map((record) => record.id as number);

  return { toPut, changedIds, changedMessages, staleIds };
}

async function importBundles(
  bundles: ConversationExportBundle[]
): Promise<{ changed: boolean }> {
  let changed = false;
  await db.transaction("rw", db.conversations, db.messages, async () => {
    // One full sequential scan replaces the previous anyOf(ids) lookup:
    // at thousands of ids a single table scan is cheaper than a giant
    // indexedDB key-set query, and the same array feeds the stale reconcile.
    const previous = (await db.conversations.toArray()) as Array<
      ConversationRecord & LocalTerminalFields
    >;
    const plan = planImport(bundles, previous);
    changed =
      plan.toPut.length > 0 || plan.staleIds.length > 0;
    if (plan.toPut.length > 0) {
      await db.conversations.bulkPut(plan.toPut);
    }
    if (plan.changedIds.length > 0) {
      // Replace each changed conversation's messages wholesale. bulkPut (not
      // bulkAdd) so a numeric-id collision in the source export overwrites
      // instead of aborting the whole sync.
      await db.messages.where("conversation_id").anyOf(plan.changedIds).delete();
      await db.messages.bulkPut(plan.changedMessages);
    }
    if (plan.staleIds.length > 0) {
      await db.messages.where("conversation_id").anyOf(plan.staleIds).delete();
      await db.conversations.bulkDelete(plan.staleIds);
    }
  });
  return { changed };
}

async function runSync(): Promise<void> {
  const api = vestiApi();
  if (!api) {
    return;
  }
  if (running) {
    // A capture change landed mid-sync; run once more with fresh data after.
    rerunRequested = true;
    return running;
  }

  setState({ syncing: true });
  running = (async () => {
    try {
      const bundles = await api.exportConversations();
      const { changed } = await importBundles(bundles);
      setState({
        lastSyncAt: Date.now(),
        conversationCount: await db.conversations.count(),
      });
      // Notify the dashboard's library-data context (and any other listener)
      // that fresh data landed in Dexie. A sync whose snapshot matches the
      // mirror exactly writes nothing and stays silent — otherwise every
      // capture-changed tick (including pure digest updates) would trigger
      // a full reload storm downstream.
      if (changed || !hadSynced) {
        hadSynced = true;
        bumpDexieDataVersion();
        window.dispatchEvent(new CustomEvent("vesti:data-updated"));
      }
    } catch (error) {
      logger.error("db", "Capture sync failed", error as Error);
    } finally {
      setState({ syncing: false });
      running = null;
      if (rerunRequested) {
        rerunRequested = false;
        void runSync();
      }
    }
  })();
  return running;
}

export function startCaptureSync(): void {
  if (started) {
    return;
  }
  const api = vestiApi();
  if (!api) {
    // Non-Electron environment (tests, Storybook, plain browser): no-op.
    return;
  }
  started = true;

  void runSync();

  api.onCaptureChanged(() => {
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void runSync();
    }, DEBOUNCE_MS);
  });
}
