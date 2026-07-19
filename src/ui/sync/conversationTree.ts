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

let cache: ConversationTree | null = null;
let loading: Promise<ConversationTree> | null = null;

/** Full merged tree: main-process CLI tree + renderer browser subtree. */
export async function loadConversationTree(): Promise<ConversationTree> {
  if (loading) return loading;
  loading = (async () => {
    const api = vestiApi();
    const cliTree = api
      ? await api.getConversationTree().catch(() => null)
      : null;
    const browserSubtree = await buildBrowserSubtree().catch(() => null);
    const sources = [...(cliTree?.sources ?? [])];
    if (browserSubtree) sources.push(browserSubtree);
    cache = {
      generatedAt: cliTree?.generatedAt ?? new Date().toISOString(),
      sources,
    };
    loading = null;
    return cache;
  })();
  return loading;
}

/** Last loaded tree, null before the first loadConversationTree() call. */
export function getCachedConversationTree(): ConversationTree | null {
  return cache;
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
