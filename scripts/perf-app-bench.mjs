#!/usr/bin/env node
/**
 * perf-app-bench — in-memory benchmark for the app-side big-library
 * performance work (no dependencies, plain node):
 *
 *   node scripts/perf-app-bench.mjs [--conversations 2000] [--messages 40]
 *
 * Compares before/after for the three fixed hot paths at a 2000-conversation
 * x 40-message scale:
 *
 *   1. capture sync import   — old: full snapshot → merge-all + delete-all
 *      80k messages + rewrite-all; new: per-bundle fingerprint, unchanged
 *      conversations are skipped. Includes the IPC-shaped JSON round-trip
 *      both designs pay for the full snapshot.
 *   2. refresh event storm   — 20 vesti:data-updated events fired back to
 *      back; old: one five-way reload per event; new: debounce + in-flight
 *      dedupe + trailing merge scheduler. Counts actual reloads.
 *   3. conversation tree     — old: full Dexie-shaped rebuild per load; new:
 *      (data version, CLI fingerprint) gates skip the rebuild when idle.
 *
 * The store is simulated with plain Maps, so absolute numbers understate
 * real Dexie/indexedDB cost (which is strictly slower); the before/after
 * ratio is the signal.
 */

const args = Object.fromEntries(
  process.argv.slice(2).map((arg, index, all) =>
    arg.startsWith("--") ? [arg.slice(2), all[index + 1] ?? true] : null
  ).filter(Boolean)
);
const N_CONVERSATIONS = Number(args.conversations ?? 2000);
const N_MESSAGES = Number(args.messages ?? 40);
const MESSAGE_CHARS = 500;

// ---------------------------------------------------------------------------
// Corpus generation (mirrors ConversationExportBundle shapes)
// ---------------------------------------------------------------------------

function makeCorpus(nConversations, nMessages) {
  const bundles = [];
  for (let c = 0; c < nConversations; c += 1) {
    const conversation = {
      id: c + 1,
      uuid: `uuid-${c}`,
      platform: "kimi-code",
      title: `Session ${c} — design discussion about performance work`,
      snippet: `Snippet of session ${c}`,
      url: "",
      source_created_at: 1_700_000_000_000 + c * 1000,
      first_captured_at: 1_700_000_000_000 + c * 1000,
      last_captured_at: 1_700_000_100_000 + c * 1000,
      created_at: 1_700_000_000_000 + c * 1000,
      updated_at: 1_700_000_100_000 + c * 1000,
      message_count: nMessages,
      turn_count: Math.ceil(nMessages / 2),
      is_archived: false,
      is_trash: false,
      tags: [],
      topic_id: null,
      is_starred: false,
      _source: "local_terminal",
      _cli_id: `cli-${c}`,
      _cli_platform: "kimi",
    };
    const messages = [];
    for (let m = 0; m < nMessages; m += 1) {
      messages.push({
        id: c * 1_000_000 + m,
        conversation_id: conversation.id,
        role: m % 2 === 0 ? "user" : "ai",
        content_text: `message ${m} of session ${c} `.padEnd(MESSAGE_CHARS, "x"),
        created_at: conversation.created_at + m * 100,
        _source: "local_terminal",
      });
    }
    bundles.push({ conversation, messages });
  }
  return bundles;
}

// ---------------------------------------------------------------------------
// Fingerprint (mirrors src/ui/sync/captureSync.ts computeBundleFingerprint)
// ---------------------------------------------------------------------------

function computeBundleFingerprint(conversation, messages) {
  let hash = 5381;
  const mix = (value) => {
    hash = ((hash * 33) ^ (value | 0)) >>> 0;
  };
  mix(conversation.updated_at);
  mix(conversation.message_count);
  mix(conversation.first_captured_at);
  mix(conversation.snippet?.length ?? 0);
  const title = conversation.title ?? "";
  for (let index = 0; index < title.length; index += 1) mix(title.charCodeAt(index));
  for (const message of messages) {
    mix(message.id);
    mix(message.created_at);
    mix(message.content_text?.length ?? 0);
    mix(message.role === "user" ? 1 : 2);
  }
  return hash >>> 0;
}

// ---------------------------------------------------------------------------
// Simulated Dexie store
// ---------------------------------------------------------------------------

function makeStore(bundles, { stamped }) {
  const conversations = new Map();
  const messages = new Map(); // conversation_id -> Map(messageId -> message)
  for (const bundle of bundles) {
    const record = stamped
      ? {
          ...bundle.conversation,
          _sync_fingerprint: computeBundleFingerprint(
            bundle.conversation,
            bundle.messages
          ),
        }
      : { ...bundle.conversation };
    conversations.set(record.id, record);
    const bucket = new Map();
    for (const message of bundle.messages) bucket.set(message.id, message);
    messages.set(record.id, bucket);
  }
  return { conversations, messages };
}

// Old importBundles: anyOf(ids) lookup + merge-all + delete-all messages +
// rewrite-all + full-table reconcile scan. Returns logical write counts.
function importOld(bundles, store) {
  const ids = bundles.map((bundle) => bundle.conversation.id);
  const keep = new Set(ids);
  // anyOf(ids).toArray()
  const previous = ids.map((id) => store.conversations.get(id)).filter(Boolean);
  const previousById = new Map(previous.map((record) => [record.id, record]));
  // merge-all + bulkPut(all)
  let conversationPuts = 0;
  for (const bundle of bundles) {
    const prev = previousById.get(bundle.conversation.id);
    const merged = prev
      ? {
          ...bundle.conversation,
          topic_id: prev.topic_id ?? null,
          is_starred: prev.is_starred ?? false,
        }
      : { ...bundle.conversation };
    store.conversations.set(merged.id, merged);
    conversationPuts += 1;
  }
  // where(conversation_id).anyOf(ids).delete() + bulkPut(all messages)
  let messageDeletes = 0;
  let messagePuts = 0;
  for (const id of ids) {
    messageDeletes += store.messages.get(id)?.size ?? 0;
    store.messages.delete(id);
  }
  for (const bundle of bundles) {
    const bucket = new Map();
    for (const message of bundle.messages) bucket.set(message.id, message);
    store.messages.set(bundle.conversation.id, bucket);
    messagePuts += bundle.messages.length;
  }
  // db.conversations.toArray() reconcile scan
  let stale = 0;
  for (const record of store.conversations.values()) {
    if (record._source === "local_terminal" && !keep.has(record.id)) stale += 1;
  }
  return { conversationPuts, messageDeletes, messagePuts, stale };
}

// New importBundles: one scan + fingerprint diff; unchanged skipped.
function importNew(bundles, store) {
  const previous = [...store.conversations.values()];
  const previousById = new Map(previous.map((record) => [record.id, record]));
  let changed = 0;
  let conversationPuts = 0;
  let messageDeletes = 0;
  let messagePuts = 0;
  for (const bundle of bundles) {
    const fingerprint = computeBundleFingerprint(
      bundle.conversation,
      bundle.messages
    );
    const prev = previousById.get(bundle.conversation.id);
    if (prev && prev._sync_fingerprint === fingerprint) continue;
    changed += 1;
    store.conversations.set(bundle.conversation.id, {
      ...bundle.conversation,
      _sync_fingerprint: fingerprint,
    });
    conversationPuts += 1;
    messageDeletes += store.messages.get(bundle.conversation.id)?.size ?? 0;
    store.messages.delete(bundle.conversation.id);
    const bucket = new Map();
    for (const message of bundle.messages) bucket.set(message.id, message);
    store.messages.set(bundle.conversation.id, bucket);
    messagePuts += bundle.messages.length;
  }
  return { changed, conversationPuts, messageDeletes, messagePuts };
}

function timeIt(label, fn, repeats = 5) {
  // Warm up once outside the measurement, then take the best run (steady
  // state — matches a long-lived renderer process).
  fn();
  let best = Infinity;
  for (let i = 0; i < repeats; i += 1) {
    const start = performance.now();
    fn();
    best = Math.min(best, performance.now() - start);
  }
  return { label, ms: best };
}

function fmt(ms) {
  return ms >= 100 ? ms.toFixed(1) : ms.toFixed(2);
}

// Maps make every operation O(1); indexedDB writes are not. To keep the
// before/after comparison honest, the import paths report their logical
// write counts, and a modeled estimate multiplies them by a conservative
// per-record Dexie write cost (bulkPut/bulkDelete ~0.1 ms/record — observed
// order of magnitude for small records; the extension-side work measured
// the same regime).
const MODELED_WRITE_COST_MS = 0.1;

// ---------------------------------------------------------------------------
// Bench 1: sync import
// ---------------------------------------------------------------------------

function benchSync() {
  const snapshot = makeCorpus(N_CONVERSATIONS, N_MESSAGES);

  // IPC-shaped cost both designs pay on every sync: the full snapshot
  // crosses the bridge (structured clone ~ JSON round-trip order of cost).
  const ipc = timeIt("snapshot JSON round-trip (per sync)", () => {
    JSON.parse(JSON.stringify(snapshot));
  });

  // Steady state: the store already mirrors the snapshot, nothing changed.
  // Stores are built once, outside the timer; both imports are idempotent
  // here, so repeated timed runs see identical input.
  const oldStore = makeStore(snapshot, { stamped: false });
  const newStore = makeStore(snapshot, { stamped: true });

  const oldSteady = timeIt(
    "OLD import CPU (steady, 0 changed)",
    () => importOld(snapshot, oldStore),
    7
  );
  const oldCounts = importOld(snapshot, oldStore);
  const newSteady = timeIt(
    "NEW import CPU (steady, 0 changed)",
    () => importNew(snapshot, newStore),
    7
  );
  const newCounts = importNew(snapshot, newStore);

  const fingerprintOnly = timeIt(
    "  of which fingerprint compute",
    () => {
      for (const bundle of snapshot) {
        computeBundleFingerprint(bundle.conversation, bundle.messages);
      }
    },
    7
  );

  const oldWrites =
    oldCounts.conversationPuts + oldCounts.messageDeletes + oldCounts.messagePuts;
  const newWrites =
    newCounts.conversationPuts + newCounts.messageDeletes + newCounts.messagePuts;
  const oldModeled = oldSteady.ms + oldWrites * MODELED_WRITE_COST_MS;
  const newModeled = newSteady.ms + newWrites * MODELED_WRITE_COST_MS;

  return {
    ipc,
    oldSteady,
    newSteady,
    fingerprintOnly,
    oldCounts,
    newCounts,
    oldWrites,
    newWrites,
    oldModeled,
    newModeled,
  };
}

// ---------------------------------------------------------------------------
// Bench 2: refresh event storm
// ---------------------------------------------------------------------------

async function benchRefreshStorm() {
  const EVENTS = 20;
  const DEBOUNCE_MS = 150;
  const RUN_MS = 40; // simulated five-way reload latency

  // OLD: one reload per event, no coalescing.
  let oldRuns = 0;
  const oldStart = performance.now();
  for (let i = 0; i < EVENTS; i += 1) {
    oldRuns += 1;
    await new Promise((resolve) => setTimeout(resolve, RUN_MS));
  }
  const oldMs = performance.now() - oldStart;

  // NEW: debounce + in-flight dedupe + trailing (mirrors library-data.tsx).
  let newRuns = 0;
  let timer = null;
  let running = null;
  let queued = false;
  const runOnce = async () => {
    newRuns += 1;
    await new Promise((resolve) => setTimeout(resolve, RUN_MS));
  };
  const schedule = () => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (running) {
        queued = true;
        return;
      }
      running = (async () => {
        try {
          await runOnce();
        } finally {
          running = null;
          if (queued) {
            queued = false;
            schedule();
          }
        }
      })();
    }, DEBOUNCE_MS);
  };
  const newStart = performance.now();
  // Burst half the events synchronously, drip the rest while a run is
  // in flight (worst case for the scheduler: every drip lands mid-run).
  for (let i = 0; i < EVENTS / 2; i += 1) schedule();
  for (let i = 0; i < EVENTS / 2; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, RUN_MS / 4));
    schedule();
  }
  while (timer !== null || running) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const newMs = performance.now() - newStart;

  return { EVENTS, oldRuns, oldMs, newRuns, newMs };
}

// ---------------------------------------------------------------------------
// Bench 3: conversation tree load
// ---------------------------------------------------------------------------

function benchTree() {
  const conversations = makeCorpus(N_CONVERSATIONS, 1).map((bundle) => ({
    ...bundle.conversation,
    _source: "browser_extension",
    url: `https://site-${bundle.conversation.id % 25}.example.com/chat/${bundle.conversation.id}`,
  }));

  // buildBrowserSubtree-shaped work: full scan + group + per-domain sort.
  const buildBrowserSubtree = () => {
    const browserRecords = conversations.filter(
      (record) => record._source === "browser_extension" && !record.is_trash
    );
    const byDomain = new Map();
    for (const record of browserRecords) {
      const domain = new URL(record.url).hostname || "unknown";
      const sessions = byDomain.get(domain) ?? [];
      sessions.push({
        id: `browser:${record.id}`,
        title: record.title,
        messageCount: record.message_count ?? 0,
        lastActivityAt: record.updated_at ?? 0,
      });
      byDomain.set(domain, sessions);
    }
    return [...byDomain.entries()].map(([domain, sessions]) => ({
      projectKey: `web:${domain}`,
      sessions: sessions.sort((a, b) => b.lastActivityAt - a.lastActivityAt),
    }));
  };

  // Digest-injection-shaped work: tree walk + full scan mapping.
  const injectDigests = () => {
    const digestByCliId = new Map();
    for (const record of conversations) {
      digestByCliId.set(record._cli_id, { oneLiner: "x" });
    }
    const digests = [];
    for (const record of conversations) {
      const digest = digestByCliId.get(record._cli_id);
      if (digest) digests.push({ conversationId: record.id, ...digest });
    }
    return digests;
  };

  // Fingerprint-gated path: O(n) cheap comparisons, no rebuild.
  const fingerprintGate = () => {
    let hash = 5381;
    for (const record of conversations) {
      hash = ((hash * 33) ^ (record.updated_at | 0)) >>> 0;
      hash = ((hash * 33) ^ record.id) >>> 0;
    }
    return hash;
  };

  const oldLoad = timeIt(
    "OLD tree load (rebuild + digest inject)",
    () => {
      buildBrowserSubtree();
      injectDigests();
    },
    9
  );
  const newLoad = timeIt(
    "NEW tree load (gates hit, no rebuild)",
    () => {
      fingerprintGate();
    },
    9
  );
  return [oldLoad, newLoad];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log(
  `perf-app-bench: ${N_CONVERSATIONS} conversations x ${N_MESSAGES} messages ` +
    `(${N_CONVERSATIONS * N_MESSAGES} messages total, Map-simulated store)\n`
);

console.log("== 1. capture sync import (steady state: 0 of 2000 changed) ==");
const sync = benchSync();
console.log(`  ${sync.ipc.label.padEnd(46)} ${fmt(sync.ipc.ms).padStart(8)} ms`);
console.log(`  ${sync.oldSteady.label.padEnd(46)} ${fmt(sync.oldSteady.ms).padStart(8)} ms`);
console.log(
  `  ${"".padEnd(46)} writes: ${sync.oldWrites.toLocaleString()} ` +
    `(${sync.oldCounts.conversationPuts} conv puts + ${sync.oldCounts.messageDeletes} msg deletes + ${sync.oldCounts.messagePuts} msg puts)`
);
console.log(`  ${sync.newSteady.label.padEnd(46)} ${fmt(sync.newSteady.ms).padStart(8)} ms`);
console.log(
  `  ${"".padEnd(46)} writes: ${sync.newWrites.toLocaleString()} (unchanged conversations skipped)`
);
console.log(`  ${sync.fingerprintOnly.label.padEnd(46)} ${fmt(sync.fingerprintOnly.ms).padStart(8)} ms`);
console.log(
  `  modeled total @${MODELED_WRITE_COST_MS}ms/write: OLD ${fmt(sync.oldModeled)} ms → ` +
    `NEW ${fmt(sync.newModeled)} ms (${(sync.oldModeled / sync.newModeled).toFixed(1)}x faster)`
);
console.log(
  "  note: the snapshot export + IPC round-trip is unchanged by design (kept\n" +
    "  idempotent full snapshot); the win is on the Dexie write side.\n"
);

console.log(`== 2. refresh storm (${20} data-updated events) ==`);
const storm = await benchRefreshStorm();
console.log(`  OLD: ${storm.oldRuns} full reloads, ${fmt(storm.oldMs)} ms total`);
console.log(
  `  NEW: ${storm.newRuns} full reloads, ${fmt(storm.newMs)} ms total ` +
    `(${(storm.oldRuns / storm.newRuns).toFixed(1)}x fewer reloads)\n`
);

console.log("== 3. conversation tree load ==");
const treeRows = benchTree();
for (const row of treeRows) console.log(`  ${row.label.padEnd(46)} ${fmt(row.ms).padStart(8)} ms`);
console.log(
  `  idle load: ${(treeRows[0].ms / treeRows[1].ms).toFixed(1)}x cheaper when nothing changed`
);
