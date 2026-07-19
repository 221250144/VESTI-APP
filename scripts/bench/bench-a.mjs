/**
 * Bench A — recall accuracy of SessionRecall (FTS5 + RRF) against the
 * synthetic corpus produced by corpus.mjs. Pure local auto-scoring.
 *
 * Query groups:
 *   single   — one query per needle; hit = needle session in top-K
 *   multi    — one query naming two needles; strict = both sessions in top-K
 *   temporal — one query per update pair; correct = NEWER session ranks first
 *   refusal  — queries for facts that do not exist; measures whether the
 *              retriever still surfaces confident-looking (misleading) hits
 *
 * Run (from VESTI-APP root):
 *   ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe scripts/bench/bench-a.mjs
 * Options: --db <corpus.db> --truth <truth.json> --topk 5
 */
import path from 'node:path';
import fs from 'node:fs';
import {
  CACHE_DIR, CAPTURE_CORE_DIST, OUT_DIR, ensureDirs, mdTable, parseArgs, pct, writeJson, writeText,
} from './common.mjs';

const { recallSessions } = await import(CAPTURE_CORE_DIST);
const BetterSqlite3 = (await import('better-sqlite3')).default;

const args = parseArgs(process.argv, {
  db: path.join(CACHE_DIR, 'bench-corpus.db'),
  truth: path.join(CACHE_DIR, 'bench-corpus-truth.json'),
  topk: 5,
});
ensureDirs();

if (!fs.existsSync(args.db) || !fs.existsSync(args.truth)) {
  console.error('[bench-a] corpus db/truth missing — run corpus.mjs first');
  process.exit(1);
}

const truth = JSON.parse(fs.readFileSync(args.truth, 'utf8'));
const db = new BetterSqlite3(args.db, { readonly: true });
const TOPK = args.topk;

const run = query => recallSessions(db, query, { topK: TOPK });
const rank = (hits, sessionId) => {
  const i = hits.findIndex(h => h.sessionId === sessionId);
  return i === -1 ? null : i + 1;
};

// ---------------------------------------------------------------------------
// 1) Single-needle recall
// ---------------------------------------------------------------------------
const singleRows = truth.needles.map((needle) => {
  const hits = run(needle.query);
  return {
    ...needle,
    top1: hits[0]?.sessionId ?? null,
    rank: rank(hits, needle.sessionId),
    hitAt1: hits[0]?.sessionId === needle.sessionId,
    hitAtK: rank(hits, needle.sessionId) !== null,
    hitsReturned: hits.length,
    top1Score: hits[0]?.score ?? 0,
    top1Confidence: hits[0]?.confidence ?? null,
    top1Title: hits[0]?.title ?? null,
    top1Snippet: hits[0]?.snippet ?? '',
  };
});
const at1 = singleRows.filter(r => r.hitAt1).length;
const atK = singleRows.filter(r => r.hitAtK).length;
const mrr = singleRows.reduce((s, r) => s + (r.rank ? 1 / r.rank : 0), 0) / singleRows.length;

function stratify(rows, keyFn) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    const g = groups.get(key) ?? { n: 0, at1: 0, atK: 0 };
    g.n += 1; g.at1 += row.hitAt1 ? 1 : 0; g.atK += row.hitAtK ? 1 : 0;
    groups.set(key, g);
  }
  return [...groups.entries()].map(([key, g]) => ({ group: key, ...g })).sort((a, b) => a.group.localeCompare(b.group));
}
const byType = stratify(singleRows, r => r.type);
const byPlatform = stratify(singleRows, r => r.platform);
const byProject = stratify(singleRows, r => r.project);
const byStyle = stratify(singleRows, r => (r.tight ? 'CJK 连写（tight）' : '分写（spaced）'));

// ---------------------------------------------------------------------------
// 2) Multi-key recall
// ---------------------------------------------------------------------------
const multiRows = truth.multiKeyQueries.map((q) => {
  const hits = run(q.query);
  const ranks = q.sessionIds.map(id => rank(hits, id));
  return {
    ...q, ranks,
    found: ranks.filter(r => r !== null).length,
    strict: ranks.every(r => r !== null),
  };
});
const multiStrict = multiRows.filter(r => r.strict).length;
const multiPartial = multiRows.filter(r => r.found > 0).length;
const multiFoundTotal = multiRows.reduce((s, r) => s + r.found, 0);

// ---------------------------------------------------------------------------
// 3) Temporal (knowledge update) queries
// ---------------------------------------------------------------------------
const temporalRows = truth.updatePairs.map((pair) => {
  const hits = run(pair.query);
  const newRank = rank(hits, pair.newSessionId);
  const oldRank = rank(hits, pair.oldSessionId);
  return {
    ...pair, newRank, oldRank,
    top1IsNew: hits[0]?.sessionId === pair.newSessionId,
    top1IsOld: hits[0]?.sessionId === pair.oldSessionId,
    newBeatsOld: newRank !== null && (oldRank === null || newRank < oldRank),
    top1Confidence: hits[0]?.confidence ?? null,
    top1Title: hits[0]?.title ?? null,
    top1Snippet: hits[0]?.snippet ?? '',
  };
});
const temporalTop1 = temporalRows.filter(r => r.top1IsNew).length;
const temporalStaleTop1 = temporalRows.filter(r => r.top1IsOld).length;
const temporalOrder = temporalRows.filter(r => r.newBeatsOld).length;

// ---------------------------------------------------------------------------
// 4) Refusal probes
// ---------------------------------------------------------------------------
// Calibrate "confident" from genuine hits: a refusal top-1 whose score sits
// inside the genuine-hit score range is indistinguishable from a real answer.
const genuineTop1Scores = singleRows.map(r => r.top1Score).sort((a, b) => a - b);
const scoreFloor = genuineTop1Scores[Math.floor(genuineTop1Scores.length * 0.1)] ?? 0;

const refusalRows = truth.refusalQueries.map((q) => {
  const hits = run(q.query);
  const top1 = hits[0] ?? null;
  return {
    ...q,
    hitsReturned: hits.length,
    abstained: hits.length === 0,
    top1Score: top1?.score ?? 0,
    top1Confidence: top1?.confidence ?? null,
    top1Title: top1?.title ?? null,
    top1Snippet: top1?.snippet ?? '',
    misleadingSnippet: top1 ? top1.snippet.includes(q.attributeToken) : false,
    confident: top1 ? top1.score >= scoreFloor : false,
    titles: hits.map(h => h.title),
  };
});
const refusalAbstained = refusalRows.filter(r => r.abstained).length;
const refusalMisleading = refusalRows.filter(r => r.misleadingSnippet).length;
const refusalConfident = refusalRows.filter(r => r.confident).length;
// Confidence-flag observation (additive; does not alter the metrics above):
// how often is a genuine needle top-1 flagged low (false alarm), and how
// often is a refusal top-1 flagged low (correct abstention signal)?
const singleLowConf = singleRows.filter(r => r.hitAtK && r.top1Confidence === 'low').length;
const refusalLowConf = refusalRows.filter(r => !r.abstained && r.top1Confidence === 'low').length;

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
const report = {
  bench: 'A',
  generatedAt: new Date().toISOString(),
  params: { db: path.basename(args.db), topK: TOPK, ...truth.params },
  summary: {
    single: {
      n: singleRows.length,
      recallAt1: at1 / singleRows.length,
      recallAtK: atK / singleRows.length,
      mrr: Number(mrr.toFixed(3)),
    },
    multi: {
      n: multiRows.length,
      strictRate: multiRows.length ? multiStrict / multiRows.length : null,
      partialRate: multiRows.length ? multiPartial / multiRows.length : null,
      avgFound: multiRows.length ? Number((multiFoundTotal / (multiRows.length * 2)).toFixed(3)) : null,
    },
    temporal: {
      n: temporalRows.length,
      top1Accuracy: temporalRows.length ? temporalTop1 / temporalRows.length : null,
      staleTop1Rate: temporalRows.length ? temporalStaleTop1 / temporalRows.length : null,
      orderAccuracy: temporalRows.length ? temporalOrder / temporalRows.length : null,
    },
    refusal: {
      n: refusalRows.length,
      abstainRate: refusalAbstained / refusalRows.length,
      misleadingTop1Rate: refusalMisleading / refusalRows.length,
      confidentHitRate: refusalConfident / refusalRows.length,
      scoreFloor: Number(scoreFloor.toFixed(5)),
    },
    confidence: {
      genuineTop1LowRate: singleRows.some(r => r.hitAtK)
        ? Number((singleLowConf / singleRows.filter(r => r.hitAtK).length).toFixed(3)) : null,
      refusalTop1LowRate: refusalRows.some(r => !r.abstained)
        ? Number((refusalLowConf / refusalRows.filter(r => !r.abstained).length).toFixed(3)) : null,
    },
  },
  strata: { byType, byPlatform, byProject, byStyle },
  detail: { single: singleRows, multi: multiRows, temporal: temporalRows, refusal: refusalRows },
};

const date = new Date().toISOString().slice(0, 10);
const jsonPath = path.join(OUT_DIR, `bench-a-${date}.json`);
const mdPath = path.join(OUT_DIR, `bench-a-${date}.md`);
writeJson(jsonPath, report);

const misses = singleRows.filter(r => !r.hitAtK);
const md = `# Bench A 召回准确率报告（${date}）

语料：${truth.params.sessions} 会话 / ${truth.params.needles} 单针 / ${truth.params.updatePairs} 更新对 / seed=${truth.params.seed}；topK=${TOPK}；召回器：SessionRecall（纯 FTS5+RRF，无向量）。

## 总览

${mdTable(
  ['指标', '值'],
  [
    ['Recall@1（单针）', `${pct(at1, singleRows.length)}（${at1}/${singleRows.length}）`],
    [`Recall@${TOPK}（单针）`, `${pct(atK, singleRows.length)}（${atK}/${singleRows.length}）`],
    ['MRR（单针）', mrr.toFixed(3)],
    ['多键查询 双命中率', multiRows.length ? `${pct(multiStrict, multiRows.length)}（${multiStrict}/${multiRows.length}）` : '—'],
    ['多键查询 平均键命中', report.summary.multi.avgFound ?? '—'],
    ['时序查询 top1=新值', temporalRows.length ? `${pct(temporalTop1, temporalRows.length)}（${temporalTop1}/${temporalRows.length}）` : '—'],
    ['时序查询 top1=旧值（陈旧）', temporalRows.length ? `${pct(temporalStaleTop1, temporalRows.length)}` : '—'],
    ['时序查询 新值排在旧值前', temporalRows.length ? `${pct(temporalOrder, temporalRows.length)}` : '—'],
    ['拒答查询 零结果率', `${pct(refusalAbstained, refusalRows.length)}（${refusalAbstained}/${refusalRows.length}）`],
    ['拒答查询 top1 误导率', `${pct(refusalMisleading, refusalRows.length)}（${refusalMisleading}/${refusalRows.length}）`],
    ['拒答查询 top1 达正常分数线', `${pct(refusalConfident, refusalRows.length)}（分数线=${scoreFloor.toFixed(4)}）`],
  ])}

## 单针分层 — 按针类型

${mdTable(['针类型', 'n', 'Recall@1', `Recall@${TOPK}`], byType.map(g => [g.group, String(g.n), pct(g.at1, g.n), pct(g.atK, g.n)]))}

## 单针分层 — 按平台

${mdTable(['平台', 'n', 'Recall@1', `Recall@${TOPK}`], byPlatform.map(g => [g.group, String(g.n), pct(g.at1, g.n), pct(g.atK, g.n)]))}

## 单针分层 — 按项目

${mdTable(['项目', 'n', 'Recall@1', `Recall@${TOPK}`], byProject.map(g => [g.group, String(g.n), pct(g.at1, g.n), pct(g.atK, g.n)]))}

## 单针分层 — 按针写法（CJK 连写 vs 分写）

${mdTable(['写法', 'n', 'Recall@1', `Recall@${TOPK}`], byStyle.map(g => [g.group, String(g.n), pct(g.at1, g.n), pct(g.atK, g.n)]))}

## 未命中（top${TOPK} 内找不到针会话）

${misses.length === 0 ? '无' : mdTable(
  ['针', '写法', '针原文', '查询', 'top1 命中标题'],
  misses.map(r => [`${r.type}: ${r.key}=${r.value}`, r.tight ? '连写' : '分写', (r.statement ?? '—').slice(0, 60), r.query, r.top1Title ?? '—']))}

## 时序明细

${mdTable(
  ['键', '旧值→新值', '新会话 rank', '旧会话 rank', 'top1', 'top1 snippet'],
  temporalRows.map(r => [
    r.key, `${r.oldValue} → ${r.newValue}`, r.newRank ?? '未命中', r.oldRank ?? '未命中',
    r.top1IsNew ? '新值 ✅' : r.top1IsOld ? '**旧值 ❌**' : '其他 ❌',
    (r.top1Snippet || '—').replace(/\|/g, '\\|').slice(0, 110),
  ]))}

## 拒答明细

${mdTable(
  ['查询', '返回数', 'top1 分数', 'top1 标题', 'snippet 含被查属性', 'snippet'],
  refusalRows.map(r => [
    r.query, String(r.hitsReturned), r.top1Score.toFixed(4), r.top1Title ?? '—',
    r.misleadingSnippet ? '**是**' : '否', (r.top1Snippet || '—').replace(/\|/g, '\\|').slice(0, 110),
  ]))}

## 多键明细

${mdTable(
  ['查询', '目标会话 rank', '命中键数'],
  multiRows.map(r => [r.query, r.ranks.map(x => x ?? '未命中').join(' / '), `${r.found}/2`]))}
`;
writeText(mdPath, md);

console.log(`[bench-a] Recall@1=${pct(at1, singleRows.length)} Recall@${TOPK}=${pct(atK, singleRows.length)} MRR=${mrr.toFixed(3)}`);
console.log(`[bench-a] temporal top1=${pct(temporalTop1, temporalRows.length)} staleTop1=${pct(temporalStaleTop1, temporalRows.length)} order=${pct(temporalOrder, temporalRows.length)}`);
console.log(`[bench-a] refusal abstain=${pct(refusalAbstained, refusalRows.length)} misleading=${pct(refusalMisleading, refusalRows.length)}`);
console.log(`[bench-a] confidence: genuine top1 low=${singleLowConf}/${singleRows.filter(r => r.hitAtK).length} refusal top1 low=${refusalLowConf}/${refusalRows.filter(r => !r.abstained).length}`);
console.log(`[bench-a] wrote ${jsonPath}`);
console.log(`[bench-a] wrote ${mdPath}`);
