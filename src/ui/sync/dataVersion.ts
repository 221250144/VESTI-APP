// Renderer Dexie data version: a monotonically increasing counter bumped by
// every writer that changes the conversations/messages tables in ways the
// cached conversation tree / digest views depend on. Cache consumers
// (conversationTree, conversationDigests) compare their cached version
// against the current one instead of re-scanning Dexie to detect change.
//
// The counter is process-local and intentionally lossy: it only ever moves
// forward, so a missed bump degrades to a stale cache for one load cycle,
// never to corruption.

let version = 0;

export function getDexieDataVersion(): number {
  return version;
}

export function bumpDexieDataVersion(): void {
  version += 1;
}
