// Capture sync: mirrors the main process's local-terminal session export
// (Codex / Cursor / Kimi Code / Claude Code, stored in SQLite) into the
// renderer's Dexie database so the @vesti/ui dashboard reads real data.
//
// On startup it pulls a full snapshot via window.vesti.exportConversations();
// afterwards the main process diffs each export against its own fingerprint
// cache and only changed bundles cross IPC, alongside the full session id
// list used here for stale reconciliation. Conversations that disappear from
// the id list are reconciled away — but only records stamped
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
import { computeBundleFingerprint } from "../../shared/exportFingerprint";
import { bumpDexieDataVersion } from "./dataVersion";

// Re-exported so existing consumers/tests keep one import site; the single
// implementation lives in shared/ because the main process diffs with it too.
export { computeBundleFingerprint } from "../../shared/exportFingerprint";

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
  /** Stable source identity. Unlike the numeric Dexie key, this survives
   * changes to cliIdToNumeric's hash implementation. */
  _cli_id?: string;
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
 * Diff an export against the current conversations table (pure). `bundles`
 * carries only new/changed sessions (the main process pre-diffs by content
 * fingerprint); `sessionIds` is the authoritative list of every session that
 * still exists upstream and drives stale reconciliation. Unchanged
 * conversations are skipped entirely — no conversation put, no message
 * delete/rewrite — and records from before the fingerprint era simply count
 * as changed once, then self-heal.
 */
export function planImport(
  bundles: ConversationExportBundle[],
  previousRecords: Array<ConversationRecord & LocalTerminalFields>,
  sessionIds: readonly string[]
): ImportPlan {
  const previousById = new Map<number, ConversationRecord & LocalTerminalFields>();
  const previousByCliId = new Map<
    string,
    ConversationRecord & LocalTerminalFields
  >();
  for (const record of previousRecords) {
    if (typeof record.id === "number") previousById.set(record.id, record);
    if (
      record._source === "local_terminal" &&
      typeof record._cli_id === "string" &&
      record._cli_id.length > 0 &&
      !previousByCliId.has(record._cli_id)
    ) {
      previousByCliId.set(record._cli_id, record);
    }
  }

  const toPut: ConversationRecord[] = [];
  const changedIds: number[] = [];
  const changedMessages: MessageRecord[] = [];
  const matchedPreviousIds = new Set<number>();

  for (const bundle of bundles) {
    const incoming = bundle.conversation as unknown as ConversationRecord &
      LocalTerminalFields;
    const fingerprint = computeBundleFingerprint(
      bundle.conversation,
      bundle.messages
    );
    // `_cli_id` is the durable identity. The numeric id is only a storage key
    // derived from a hash, and that hash has changed before (FNV32 -> FNV64).
    // Match by the durable id first so an upgrade does not classify the whole
    // old mirror as stale and rebuild it under unrelated primary keys.
    const cliId =
      typeof incoming._cli_id === "string" && incoming._cli_id.length > 0
        ? incoming._cli_id
        : null;
    const prev =
      (cliId ? previousByCliId.get(cliId) : undefined) ??
      (incoming.id !== undefined ? previousById.get(incoming.id) : undefined);
    if (prev?._source === "local_terminal" && typeof prev.id === "number") {
      matchedPreviousIds.add(prev.id);
    }

    // Preserve the established Dexie primary key. Other user-owned tables
    // (annotations, summaries, topics, notes) refer to it, so changing it just
    // because the hash implementation changed would orphan those relations.
    const resolvedId =
      typeof prev?.id === "number" ? prev.id : incoming.id;
    const conversation =
      resolvedId === incoming.id ? incoming : { ...incoming, id: resolvedId };
    const messages =
      resolvedId === incoming.id
        ? bundle.messages
        : bundle.messages.map((message) => ({
            ...message,
            conversation_id: resolvedId,
          }));
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
      for (const message of messages) {
        changedMessages.push(message as unknown as MessageRecord);
      }
    }
  }

  // Reconcile against the authoritative session id list, not against the
  // (incremental) bundles — unchanged sessions simply aren't in `bundles`
  // anymore. A previous row matched through `_cli_id` remains retained even
  // when its numeric key differs from the incoming bundle, and rows matched
  // by a changed bundle are retained too. Browser-extension records remain
  // out of scope. Mirror rows mirrored before `_cli_id` existed can't be
  // matched against the id list, so they are kept rather than risk deleting
  // user organization state. An empty id list can still mean a transient
  // startup/read failure, so preserve the mirror and wait for the next
  // non-empty authoritative export instead of wiping it.
  const authoritativeIds = new Set(sessionIds);
  const staleIds = sessionIds.length === 0
    ? []
    : previousRecords
        .filter(
          (record) =>
            record._source === "local_terminal" &&
            typeof record.id === "number" &&
            !matchedPreviousIds.has(record.id) &&
            typeof record._cli_id === "string" &&
            record._cli_id.length > 0 &&
            !authoritativeIds.has(record._cli_id)
        )
        .map((record) => record.id as number);

  return { toPut, changedIds, changedMessages, staleIds };
}

async function importBundles(
  bundles: ConversationExportBundle[],
  sessionIds: readonly string[]
): Promise<{ changed: boolean }> {
  let changed = false;
  await db.transaction("rw", db.conversations, db.messages, async () => {
    // One full sequential scan replaces the previous anyOf(ids) lookup:
    // at thousands of ids a single table scan is cheaper than a giant
    // indexedDB key-set query, and the same array feeds the stale reconcile.
    const previous = (await db.conversations.toArray()) as Array<
      ConversationRecord & LocalTerminalFields
    >;
    const plan = planImport(bundles, previous, sessionIds);
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
      const exportResult = await api.exportConversations();
      const { changed } = await importBundles(
        exportResult.bundles,
        exportResult.sessionIds
      );
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
