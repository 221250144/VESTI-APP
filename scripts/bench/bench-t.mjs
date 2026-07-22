/**
 * Bench T — trace-tree integrity against the real library (snapshot).
 *
 * Deterministic, no LLM. Measures how faithfully the conversation tree
 * reproduces each platform's native session organization:
 *
 *   - link resolution rate: subagent_links rows whose child side resolved;
 *   - subagent leak rate: sessions that are subagents by the platform's own
 *     convention (claude `agent-*` transcripts, kimi `--agent-N` wires,
 *     cursor `is_subagent` composers) but show up as top-level mains;
 *   - mount rate: subagents actually folded under their parent in the tree;
 *   - orphan count: subagents degraded to standalone mains (parent missing /
 *     cross-project / cycle).
 *
 * The run has two phases: "current" audits the snapshot as-is, then a real
 * sync + resolveSubagentLinks pass (the exact code path the app runs after
 * the fix) is applied to the snapshot and the same metrics are re-measured
 * as "after". The snapshot is rebuilt from the live db on every run.
 *
 * Run (from VESTI-APP root):
 *   ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe scripts/bench/bench-t.mjs
 * Options: --skip-sync    (report the current phase only)
 *          --full-resync  (clear sync_state first: simulates the converged
 *                          state after a parser upgrade forces re-parse)
 */
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import {
  CACHE_DIR, CAPTURE_CORE_DIST, OUT_DIR, ensureDirs, mdTable, parseArgs, pct, writeJson, writeText,
} from './common.mjs';

const BetterSqlite3 = (await import('better-sqlite3')).default;
const core = await import(CAPTURE_CORE_DIST);

const args = parseArgs(process.argv, { 'skip-sync': false, 'full-resync': false, tag: '' });
ensureDirs();

const SNAPSHOT = path.join(CACHE_DIR, 'vesti-tree-snapshot.db');
const PLATFORMS = ['codex', 'cursor', 'kimi-code', 'claude-code'];

// Fresh snapshot every run — link state is exactly what this bench measures.
for (const suffix of ['', '-wal', '-shm']) {
  if (fs.existsSync(SNAPSHOT + suffix)) fs.rmSync(SNAPSHOT + suffix);
}
{
  const live = path.join(os.homedir(), '.vesti', 'db', 'vesti.db');
  const src = new BetterSqlite3(live, { readonly: true });
  await src.backup(SNAPSHOT);
  src.close();
}

// ---------------------------------------------------------------------------
// Metrics over one database state
// ---------------------------------------------------------------------------

/** Sessions that are subagents by each platform's own on-disk convention. */
function conventionSubagentIds(db) {
  const ids = new Set();
  const rows = db.prepare(`
    SELECT id, platform, agent_meta FROM work_sessions WHERE session_type = 'conversation'
  `).all();
  for (const row of rows) {
    if (row.platform === 'claude-code' && /^claude-code:(wsl-[^:]+-)?agent-/.test(row.id)) ids.add(row.id);
    else if (row.platform === 'kimi-code' && row.id.includes('--agent-')) ids.add(row.id);
    else if (row.platform === 'cursor' && row.agent_meta && row.agent_meta.includes('"is_subagent":true')) ids.add(row.id);
  }
  return ids;
}

function measure(dbPath, tree) {
  const db = new BetterSqlite3(dbPath, { readonly: true });
  const links = db.prepare(`
    SELECT child_session_id IS NOT NULL AS resolved, file_path FROM subagent_links
  `).all();
  const linkStats = {
    total: links.length,
    resolved: links.filter(l => l.resolved).length,
    unresolvedFileExists: links.filter(l => !l.resolved && l.file_path && fs.existsSync(l.file_path)).length,
    unresolvedFileMissing: links.filter(l => !l.resolved && (!l.file_path || !fs.existsSync(l.file_path))).length,
  };
  const convention = conventionSubagentIds(db);
  db.close();

  // Walk the tree: top-level project sessions are mains; children are mounted.
  let mains = 0;
  let mounted = 0;
  let orphans = 0;
  let leakedMainIds = [];
  const countChildren = node => {
    for (const child of node.children ?? []) {
      mounted += 1;
      countChildren(child);
    }
  };
  for (const source of tree.sources) {
    for (const project of source.projects) {
      for (const session of project.sessions) {
        mains += 1;
        if (session.orphan) orphans += 1;
        else if (convention.has(session.id)) leakedMainIds.push(session.id);
        countChildren(session);
      }
    }
  }
  return {
    links: linkStats,
    conventionSubagents: convention.size,
    tree: {
      mains,
      mounted,
      orphans,
      leaked: leakedMainIds.length,
      leakedSample: leakedMainIds.slice(0, 5),
      mountRate: convention.size > 0 ? mounted / convention.size : null,
    },
  };
}

async function buildTree(dbPath) {
  const manager = new core.DatabaseManager(dbPath);
  await manager.initialize();
  const tree = manager.buildConversationTree();
  await manager.close();
  return tree;
}

// ---------------------------------------------------------------------------
// Phase 1: current state
// ---------------------------------------------------------------------------
const current = measure(SNAPSHOT, await buildTree(SNAPSHOT));
console.log('[bench-t] current:', JSON.stringify(current, null, 2));

// ---------------------------------------------------------------------------
// Phase 2: real sync + resolution pass on the snapshot (the post-fix path)
// ---------------------------------------------------------------------------
let after = null;
if (!args['skip-sync']) {
  if (args['full-resync']) {
    const db = new BetterSqlite3(SNAPSHOT);
    db.exec('DELETE FROM sync_state');
    db.close();
  }
  const manager = new core.DatabaseManager(SNAPSHOT);
  await manager.initialize();
  const adapters = new core.AdapterManager();
  const engine = new core.SyncEngine(adapters, manager); // no vault: bench must not write ~/.vesti
  for (const platform of PLATFORMS) {
    const adapter = adapters.getAdapter(platform);
    if (!adapter) continue;
    try {
      const files = await adapter.getSessionFiles();
      const result = await engine.syncPlatform(platform, files);
      console.log(`[bench-t] synced ${platform}: ${result.sessionsProcessed} sessions, ${result.errors.length} errors`);
    } catch (err) {
      console.log(`[bench-t] sync ${platform} failed: ${err?.message ?? err}`);
    }
  }
  const resolved = await engine.resolveSubagentLinks();
  console.log(`[bench-t] resolution pass resolved ${resolved} links`);
  const tree = manager.buildConversationTree();
  await manager.close();
  after = measure(SNAPSHOT, tree);
  console.log('[bench-t] after:', JSON.stringify(after, null, 2));
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
const date = new Date().toISOString().slice(0, 10);
const tag = args.tag ? `-${args.tag}` : '';
const stem = `bench-t-${date}${tag}`;
writeJson(path.join(OUT_DIR, `${stem}.json`), { date, current, after });

const row = (label, m) => [
  label,
  `${m.links.resolved}/${m.links.total}`,
  String(m.links.unresolvedFileExists),
  String(m.links.unresolvedFileMissing),
  String(m.conventionSubagents),
  String(m.tree.mounted),
  String(m.tree.leaked),
  String(m.tree.orphans),
  m.tree.mountRate == null ? '—' : pct(m.tree.mounted, m.conventionSubagents),
];
const rows = [row('current', current)];
if (after) rows.push(row('after sync+resolve', after));
const md = [
  `# Bench T — 追踪树完整性（${date}${tag ? `, ${args.tag}` : ''}）`,
  '',
  '快照上的确定性审计：subagent_links 解析率、按平台惯例识别的子代理会话数、树中实际挂载数、',
  '泄漏为顶层 main 的子代理数（= 用户看到“子 agent 被当成独立对话”的直接度量）、orphan 降级数。',
  '"after" 行 = 在快照上运行修复后的真实同步 + resolveSubagentLinks 代码路径后的同一组指标。',
  '',
  mdTable(
    ['phase', 'links resolved', 'unresolved (file exists)', 'unresolved (file gone)', 'convention subagents', 'mounted in tree', 'leaked as main', 'orphans', 'mount rate'],
    rows,
  ),
  '',
].join('\n');
writeText(path.join(OUT_DIR, `${stem}.md`), md);
console.log(`[bench-t] report: docs/bench/out/${stem}.md`);
