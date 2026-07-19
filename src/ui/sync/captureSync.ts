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
};

let state: CaptureSyncState = {
  syncing: false,
  lastSyncAt: null,
  conversationCount: 0,
};

const listeners = new Set<CaptureSyncListener>();
let started = false;
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

async function importBundles(bundles: ConversationExportBundle[]): Promise<void> {
  const ids = bundles.map((bundle) => bundle.conversation.id);
  const keep = new Set(ids);
  const conversations = bundles.map(
    (bundle) => bundle.conversation as unknown as ConversationRecord
  );
  const messages = bundles.flatMap(
    (bundle) => bundle.messages as unknown as MessageRecord[]
  );

  await db.transaction("rw", db.conversations, db.messages, async () => {
    // Upsert conversations by their stable numeric id. User-curated fields
    // (topic assignment, star, tags) live on the same record, so merge them
    // over the fresh export instead of letting a re-sync wipe them.
    const previous = await db.conversations.where("id").anyOf(ids).toArray();
    const previousById = new Map(
      previous
        .filter((record) => typeof record.id === "number")
        .map((record) => [record.id as number, record])
    );
    const merged = conversations.map((conversation) => {
      const prev =
        conversation.id !== undefined ? previousById.get(conversation.id) : undefined;
      if (!prev) {
        return conversation;
      }
      return {
        ...conversation,
        topic_id: prev.topic_id ?? null,
        is_starred: prev.is_starred ?? false,
        tags: Array.isArray(prev.tags) ? prev.tags : conversation.tags,
        // P2a auto-classify bookkeeping rides the same merge so a re-sync
        // never wipes it.
        auto_classified: prev.auto_classified ?? 0,
        classify_suggestion: prev.classify_suggestion ?? null,
        // P2b: local trash/archive flags are user organization state; the
        // source export always reports them false, so without preserving them
        // a re-sync would silently resurrect organized-away records.
        is_trash: prev.is_trash ?? false,
        is_archived: prev.is_archived ?? false,
      };
    });
    await db.conversations.bulkPut(merged);

    // Replace each exported conversation's messages wholesale. bulkPut (not
    // bulkAdd) so a numeric-id collision in the source export overwrites
    // instead of aborting the whole sync.
    await db.messages.where("conversation_id").anyOf(ids).delete();
    await db.messages.bulkPut(messages);

    // Reconcile: local-terminal conversations absent from the snapshot were
    // deleted at the source; drop them and their messages here too.
    const staleIds = (await db.conversations.toArray())
      .filter(
        (record) =>
          (record as ConversationRecord & LocalTerminalFields)._source ===
            "local_terminal" &&
          typeof record.id === "number" &&
          !keep.has(record.id)
      )
      .map((record) => record.id as number);

    if (staleIds.length > 0) {
      await db.messages.where("conversation_id").anyOf(staleIds).delete();
      await db.conversations.bulkDelete(staleIds);
    }
  });
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
      await importBundles(bundles);
      setState({
        lastSyncAt: Date.now(),
        conversationCount: await db.conversations.count(),
      });
      // Notify the dashboard's library-data context (and any other listener)
      // that fresh data landed in Dexie.
      window.dispatchEvent(new CustomEvent("vesti:data-updated"));
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
