// Conversation tree (P1.5): pulls the CLI conversation tree from the main
// process (SQLite: platform+host → project → session+digest) and merges a
// renderer-side "browser" subtree built from Dexie — browser-extension
// conversations are grouped by site domain, mirroring the CLI tree shape.
//
// The tree is cached after the first load and re-fetched (debounced) when
// capture data changes (vesti:capture-changed) or Dexie data lands
// ("vesti:data-updated", which captureSync and the extension import fire).
// Outside Electron (no window.vesti bridge) the CLI part is simply empty
// and only the browser subtree is produced.

import { db } from "../db/schema";
import type { ConversationRecord } from "../db/schema";
import type {
  ConversationTree,
  ConversationTreeProject,
  ConversationTreeSession,
  ConversationTreeSource,
  VestiDesktopApi,
} from "../../shared/contracts";
import { getDexieDataVersion } from "./dataVersion";

export type { ConversationTree };

const BROWSER_SOURCE_PLATFORM = "browser";
const RELOAD_DEBOUNCE_MS = 500;

type BrowserFields = {
  _source?: string;
};

function vestiApi(): VestiDesktopApi | null {
  return typeof window !== "undefined" && window.vesti ? window.vesti : null;
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname || "unknown";
  } catch {
    return "unknown";
  }
}

/** Build the "browser" subtree from Dexie conversations grouped by domain. */
async function buildBrowserSubtree(): Promise<ConversationTreeSource | null> {
  const records = (await db.conversations.toArray()) as Array<
    ConversationRecord & BrowserFields
  >;
  const browserRecords = records.filter(
    (record) => record._source === "browser_extension" && !record.is_trash
  );
  if (browserRecords.length === 0) return null;

  const byDomain = new Map<string, ConversationTreeSession[]>();
  for (const record of browserRecords) {
    const domain = domainOf(record.url ?? "");
    const sessions = byDomain.get(domain) ?? [];
    sessions.push({
      id: `browser:${record.id}`,
      title: record.title,
      messageCount: record.message_count ?? 0,
      lastActivityAt: record.updated_at ?? 0,
      oneLiner: null,
      keyTopics: [],
      keyFiles: [],
      decisions: [],
    });
    byDomain.set(domain, sessions);
  }

  const projects: ConversationTreeProject[] = [...byDomain.entries()]
    .map(([domain, sessions]) => ({
      projectKey: `web:${domain}`,
      label: domain,
      pathOrDomain: domain,
      sessions: sessions.sort((a, b) => b.lastActivityAt - a.lastActivityAt),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));

  return { platform: BROWSER_SOURCE_PLATFORM, host: "browser", projects };
}

type TreeCache = {
  tree: ConversationTree;
  /** Value of getDexieDataVersion() when browserSubtree was built. */
  dexieVersion: number;
  /** Fingerprint of the CLI tree the merged tree was built from. */
  cliFingerprint: number;
  browserSubtree: ConversationTreeSource | null;
};

let cache: TreeCache | null = null;
let loading: Promise<ConversationTree> | null = null;

/**
 * Cheap O(sessions) fingerprint of the CLI tree: session identity, counts,
 * activity stamps and digest presence/length. Rebuilding the merged tree is
 * skipped when this matches the cache — the digest pipeline updating
 * one-liners without touching conversations still changes it.
 */
function fingerprintCliTree(tree: ConversationTree | null): number {
  let hash = 5381;
  const mix = (value: number) => {
    hash = ((hash * 33) ^ (value | 0)) >>> 0;
  };
  const mixText = (text: string) => {
    for (let index = 0; index < text.length; index += 1) {
      mix(text.charCodeAt(index));
    }
  };
  for (const source of tree?.sources ?? []) {
    mixText(`${source.platform}|${source.host}`);
    for (const project of source.projects) {
      mixText(project.projectKey);
      for (const session of project.sessions) {
        mixText(session.id);
        mix(session.messageCount);
        mix(session.lastActivityAt);
        mix(session.oneLiner?.length ?? -1);
      }
    }
  }
  return hash >>> 0;
}

function mergeTree(
  cliTree: ConversationTree | null,
  browserSubtree: ConversationTreeSource | null
): ConversationTree {
  const sources = [...(cliTree?.sources ?? [])];
  if (browserSubtree) sources.push(browserSubtree);
  return {
    generatedAt: cliTree?.generatedAt ?? new Date().toISOString(),
    sources,
  };
}

async function fetchCliTree(api: VestiDesktopApi | null) {
  return api ? await api.getConversationTree().catch(() => null) : null;
}

/**
 * Full merged tree: main-process CLI tree + renderer browser subtree.
 *
 * Cached by (Dexie data version, CLI-tree fingerprint): when neither the
 * renderer tables nor the CLI tree changed since the last load, the cached
 * merge is returned without re-scanning Dexie or re-merging; a Dexie-only
 * change rebuilds just the browser subtree. `force` bypasses the gates for
 * callers that must observe writes made in the same tick (relay/extract).
 */
export async function loadConversationTree(options?: {
  force?: boolean;
}): Promise<ConversationTree> {
  if (loading) return loading;
  loading = (async () => {
    const api = vestiApi();
    const dexieVersion = getDexieDataVersion();
    if (!options?.force && cache && cache.dexieVersion === dexieVersion) {
      const cliTree = await fetchCliTree(api);
      const cliFingerprint = fingerprintCliTree(cliTree);
      // Re-read the version after the IPC await: a sync that landed in
      // between must not be served the stale browser subtree.
      if (
        getDexieDataVersion() === dexieVersion &&
        cliFingerprint === cache.cliFingerprint
      ) {
        return cache.tree;
      }
      if (getDexieDataVersion() === dexieVersion) {
        // CLI side moved (e.g. fresh digests); the browser subtree is keyed
        // on the unchanged Dexie version, so reuse it and only re-merge.
        cache = {
          tree: mergeTree(cliTree, cache.browserSubtree),
          dexieVersion,
          cliFingerprint,
          browserSubtree: cache.browserSubtree,
        };
        return cache.tree;
      }
      // Dexie changed mid-flight: rebuild the browser subtree fresh and
      // merge with the CLI tree we already fetched.
      const browserSubtree = await buildBrowserSubtree().catch(() => null);
      cache = {
        tree: mergeTree(cliTree, browserSubtree),
        dexieVersion: getDexieDataVersion(),
        cliFingerprint,
        browserSubtree,
      };
      return cache.tree;
    }
    const [cliTree, browserSubtree] = await Promise.all([
      fetchCliTree(api),
      buildBrowserSubtree().catch(() => null),
    ]);
    cache = {
      tree: mergeTree(cliTree, browserSubtree),
      dexieVersion,
      cliFingerprint: fingerprintCliTree(cliTree),
      browserSubtree,
    };
    return cache.tree;
  })();
  try {
    return await loading;
  } finally {
    loading = null;
  }
}

/** Last loaded tree, null before the first loadConversationTree() call. */
export function getCachedConversationTree(): ConversationTree | null {
  return cache?.tree ?? null;
}

export type ConversationTreeListener = (tree: ConversationTree) => void;

/**
 * Subscribe to tree updates: the tree is reloaded (debounced) whenever
 * capture or Dexie data changes, and the listener gets the fresh tree.
 * Returns an unsubscribe function. The first load is triggered immediately.
 */
export function subscribeConversationTree(
  listener: ConversationTreeListener
): () => void {
  let debounce: ReturnType<typeof setTimeout> | null = null;
  const reload = () => {
    if (debounce !== null) clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = null;
      void loadConversationTree().then(listener);
    }, RELOAD_DEBOUNCE_MS);
  };

  reload();
  const api = vestiApi();
  const unsubscribeCapture = api?.onCaptureChanged(reload);
  if (typeof window !== "undefined") {
    window.addEventListener("vesti:data-updated", reload);
  }
  return () => {
    if (debounce !== null) clearTimeout(debounce);
    unsubscribeCapture?.();
    if (typeof window !== "undefined") {
      window.removeEventListener("vesti:data-updated", reload);
    }
  };
}
