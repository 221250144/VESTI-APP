/**
 * Bench C — digest fidelity against the real library (read-only snapshot).
 *
 * Programmatic audit, no LLM: extract key facts (decision sentences, file
 * paths, numbers/versions) from each session's raw messages, then check how
 * many of them survive into session_digests. Facts are tagged by whether the
 * digest pipeline could even see them — the pipeline (src/main/digestService.ts)
 * only formats content_text / tool name / tool output of the last ≤60
 * messages within a 6000-char tail budget; thinking text is invisible.
 *
 * Run (from VESTI-APP root):
 *   ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe scripts/bench/bench-c.mjs
 * Options: --db <snapshot.db>  (default: scripts/bench/.cache/vesti-real-snapshot.db,
 *          created from ~/.vesti/db/vesti.db via SQLite backup when missing)
 */
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import {
  CACHE_DIR, OUT_DIR, ensureDirs, mdTable, parseArgs, pct, writeJson, writeText,
} from './common.mjs';

const BetterSqlite3 = (await import('better-sqlite3')).default;

const args = parseArgs(process.argv, {
  db: path.join(CACHE_DIR, 'vesti-real-snapshot.db'),
  tag: '',
});
ensureDirs();

// Snapshot the live db through the SQLite backup API (a plain file copy
// misses WAL pages; seen in practice — main file alone had no tables).
if (!fs.existsSync(args.db)) {
  const live = path.join(os.homedir(), '.vesti', 'db', 'vesti.db');
  console.log(`[bench-c] snapshot missing — backing up ${live} -> ${args.db}`);
  const src = new BetterSqlite3(live, { readonly: true });
  await src.backup(args.db);
  await src.close();
}

const db = new BetterSqlite3(args.db, { readonly: true });

// ---------------------------------------------------------------------------
// Digest visibility window — replicates buildDigestTranscript (digestService)
// so we can tag every fact as visible / invisible to the digest pipeline.
// ---------------------------------------------------------------------------
const RECENT_MESSAGE_LIMIT = 60;
const TRANSCRIPT_BUDGET_CHARS = 6000;
const TOOL_OUTPUT_CHARS = 200;

function formatDigestMessage(m) {
  const values = [
    m.content_text,
    m.content_tool_name ? `工具：${m.content_tool_name}` : undefined,
    m.content_tool_output ? `工具结果：${String(m.content_tool_output).slice(0, TOOL_OUTPUT_CHARS)}` : undefined,
    m.content_tool_error ? `工具错误：${String(m.content_tool_error).slice(0, TOOL_OUTPUT_CHARS)}` : undefined,
  ].filter(v => Boolean(v && String(v).trim()));
  return values.join('；');
}

/** Indices (into messages array) whose content lands in the digest transcript. */
function digestWindowIndices(messages) {
  const recent = messages.slice(-RECENT_MESSAGE_LIMIT);
  const recentOffset = messages.length - recent.length;
  const included = new Set();
  let used = 0;
  for (let i = recent.length - 1; i >= 0; i -= 1) {
    const formatted = formatDigestMessage(recent[i]);
    if (!formatted) continue;
    if (used + formatted.length > TRANSCRIPT_BUDGET_CHARS && included.size > 0) break;
    included.add(recentOffset + i);
    used += formatted.length;
  }
  return included;
}

// ---------------------------------------------------------------------------
// Digest visibility window v2 — mirrors src/main/digestTranscript.ts (the
// post-baseline window: budget 12000, recency safety valve 500, first-user
// section, file-write back-fill, oversized-only head+tail cap, newest-first).
// Returns per-message kept ranges so fact offsets can be checked against
// what actually survives truncation. Keep in sync with digestTranscript.ts.
// ---------------------------------------------------------------------------
const V2_BUDGET = 12_000;
const V2_RECENT_LIMIT = 500;
const V2_FIRST_USER_CHARS = 400;
const V2_OVERSIZED_CAP = 4_000;
const V2_FILE_WRITE_EXTRA_LIMIT = 10;
const V2_OVERSIZED_CHARS = 10_000;
const V2_MIN_SLOT = 40;
const V2_TRUNC_MARK_LEN = '……[截断]'.length;

const FILE_WRITE_TOOL_NAMES = new Set([
  'edit', 'multiedit', 'write', 'notebookedit',
  'edit_file', 'edit_file_v2', 'write_file', 'create_file', 'delete_file',
  'apply_patch', 'str_replace_editor', 'fswrite',
]);
const isFileWriteTool = name => Boolean(name && FILE_WRITE_TOOL_NAMES.has(String(name).trim().toLowerCase()));

function formatDigestMessageV2(m) {
  const values = [
    m.content_text,
    m.content_tool_name ? `工具：${m.content_tool_name}` : undefined,
    m.content_tool_output ? `工具结果：${String(m.content_tool_output).slice(0, TOOL_OUTPUT_CHARS)}` : undefined,
    m.content_tool_error ? `工具错误：${String(m.content_tool_error).slice(0, TOOL_OUTPUT_CHARS)}` : undefined,
  ].filter(v => Boolean(v && String(v).trim()));
  if (!values.length) return '';
  const role = m.role === 'user' ? '用户' : m.role === 'assistant' ? 'AI' : '系统';
  return `${role}：${values.join('；')}`;
}

/** Kept character ranges + emitted length of a formatted message truncated
 * to `cap` (exact mirror of truncateForDigest in digestTranscript.ts). */
function truncateMirror(formattedLen, cap, oversized) {
  if (formattedLen <= cap) return { ranges: [[0, formattedLen]], emitted: formattedLen };
  if (cap < V2_MIN_SLOT) return { ranges: [[0, cap]], emitted: cap };
  if (oversized && cap >= 120) {
    const estimate = 20;
    let head = Math.ceil((cap - estimate) * 0.6);
    const tail = cap - estimate - head;
    const markLen = `……[中间省略 ${formattedLen - head - tail} 字符]……`.length;
    if (markLen > estimate) head = Math.max(0, head - (markLen - estimate));
    return {
      ranges: [[0, head], [formattedLen - tail, formattedLen]],
      emitted: head + markLen + (tail > 0 ? tail : 0),
    };
  }
  return { ranges: [[0, cap - V2_TRUNC_MARK_LEN]], emitted: cap };
}

/** Map msgIndex -> kept ranges of its formatted text inside the v2 transcript. */
function digestWindowMapV2(messages) {
  const entries = [];
  messages.forEach((m, index) => {
    const formatted = formatDigestMessageV2(m);
    if (formatted) entries.push({ index, message: m, formatted, oversized: formatted.length > V2_OVERSIZED_CHARS });
  });
  const kept = new Map();
  if (!entries.length) return kept;

  const recentStart = Math.max(0, entries.length - V2_RECENT_LIMIT);
  const selected = new Set();
  for (let i = recentStart; i < entries.length; i += 1) selected.add(i);
  let extras = 0;
  for (let i = recentStart - 1; i >= 0 && extras < V2_FILE_WRITE_EXTRA_LIMIT; i -= 1) {
    if (isFileWriteTool(entries[i].message.content_tool_name)) {
      selected.add(i);
      extras += 1;
    }
  }

  let remaining = V2_BUDGET;
  const firstUserPos = entries.findIndex(e => e.message.role === 'user' && String(e.message.content_text ?? '').trim());
  if (firstUserPos !== -1) {
    const entry = entries[firstUserPos];
    const cap = Math.max(V2_MIN_SLOT, Math.min(V2_FIRST_USER_CHARS, Math.floor(V2_BUDGET / 4), entry.formatted.length));
    const result = truncateMirror(entry.formatted.length, cap, entry.oversized);
    kept.set(entry.index, result.ranges);
    remaining -= '【会话开场】'.length + result.emitted + 1;
    selected.delete(firstUserPos);
  }

  const windowed = [...selected].sort((a, b) => b - a).map(i => entries[i]);
  windowed.forEach((entry, i) => {
    const isNewest = i === 0;
    let cap = entry.oversized ? Math.min(V2_OVERSIZED_CAP, remaining) : remaining;
    if (isNewest) cap = Math.max(cap, V2_MIN_SLOT);
    if (cap < V2_MIN_SLOT) return;
    const result = truncateMirror(entry.formatted.length, cap, entry.oversized);
    kept.set(entry.index, result.ranges);
    remaining -= result.emitted + 1;
  });
  return kept;
}

/** Role prefix length ('用户：' / 'AI：' / '系统：') in formatted messages. */
const ROLE_PREFIX_LEN = 3;

function factVisibleV2(fact, windowMap) {
  if (fact.channel !== 'text') return false;
  const ranges = windowMap.get(fact.msgIndex);
  if (!ranges) return false;
  const start = fact.offset + ROLE_PREFIX_LEN;
  const end = start + fact.value.length;
  return ranges.some(([s, e]) => start >= s && end <= e);
}

// ---------------------------------------------------------------------------
// Degraded-digest exact judgment — mirrors isDegradedDigest in
// src/main/digestService.ts (four empty structured fields + one_liner echo).
// ---------------------------------------------------------------------------
function bigramDice(a, b) {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const counts = new Map();
  for (let i = 0; i + 2 <= a.length; i += 1) {
    const gram = a.slice(i, i + 2);
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  let hits = 0;
  for (let i = 0; i + 2 <= b.length; i += 1) {
    const gram = b.slice(i, i + 2);
    const available = counts.get(gram) ?? 0;
    if (available > 0) {
      hits += 1;
      counts.set(gram, available - 1);
    }
  }
  return (2 * hits) / (a.length - 1 + (b.length - 1));
}

function isDegradedDigestExact(digest, firstUserText) {
  const oneLiner = String(digest.oneLiner ?? '').replace(/\s+/g, ' ').trim();
  const firstUser = String(firstUserText ?? '').replace(/\s+/g, ' ').trim();
  if (!oneLiner || !firstUser) return false;
  if (oneLiner.length >= 90 && firstUser.startsWith(oneLiner)) return true;
  return bigramDice(oneLiner.slice(0, 400), firstUser.slice(0, 400)) > 0.8;
}

// ---------------------------------------------------------------------------
// Fact extraction
// ---------------------------------------------------------------------------
const DECISION_RE = /(决定|确定|确认|采用|选用|改为|改成|切换|迁移|替换|放弃|定为|拍板|不再使用|不再用)/;
const FILE_RE = /(?:[A-Za-z]:[\\/])?(?:[\w\-一-鿿]+[\\/])*[\w\-一-鿿]+\.(?:ts|tsx|js|mjs|cjs|py|rs|go|java|md|json|ya?ml|toml|sql|css|scss|html|vue|png|jpe?g|svg|gif|sh|ps1|bat|txt)/g;
const NUMBER_RE = /(?:\bv?\d+\.\d+(?:\.\d+)?\b)|(?:\b\d+(?:\.\d+)?\s?(?:ms|s|min|kb|mb|gb|px|%|个|条|次|行|分钟|小时|天|周|元)\b)/g;
const MAX_DECISIONS = 15;
const MAX_FILES = 25;
const MAX_NUMBERS = 25;

const basename = p => p.replace(/\\/g, '/').split('/').pop();

function extractFacts(messages, windowSet) {
  const facts = [];
  const seenFile = new Set();
  const seenNumber = new Set();
  let decisions = 0;
  messages.forEach((m, idx) => {
    const channels = [
      { text: m.content_text, channel: 'text' },
      { text: m.content_thinking, channel: 'thinking' },
    ];
    for (const { text, channel } of channels) {
      if (!text || typeof text !== 'string') continue;
      const visibility = channel === 'text' && windowSet.has(idx) ? 'window' : 'outside';

      if (decisions < MAX_DECISIONS) {
        // Offset-tracking sentence split so v2 kept-range checks can see
        // whether the sentence survives message truncation.
        for (const match of text.matchAll(/[^。!?\n]+[。!?\n]?/g)) {
          const raw = match[0];
          const leadingWs = raw.length - raw.trimStart().length;
          // Strip the trailing separator to keep extraction identical to the
          // baseline's split()-based version.
          const s = raw.trim().replace(/[。!?]$/, '');
          if (s.length >= 8 && s.length <= 160 && DECISION_RE.test(s)) {
            decisions += 1;
            facts.push({ type: 'decision', value: s, offset: match.index + leadingWs, channel, visibility, msgIndex: idx });
            if (decisions >= MAX_DECISIONS) break;
          }
        }
      }

      if (channel === 'text') {
        for (const match of text.matchAll(FILE_RE)) {
          const bn = basename(match[0]);
          if (!bn || bn.length < 4 || seenFile.has(bn.toLowerCase())) continue;
          seenFile.add(bn.toLowerCase());
          facts.push({ type: 'file', value: match[0], token: bn, offset: match.index, channel, visibility, msgIndex: idx });
          if (seenFile.size >= MAX_FILES) break;
        }
        for (const match of text.matchAll(NUMBER_RE)) {
          const token = match[0].trim();
          if (seenNumber.has(token)) continue;
          seenNumber.add(token);
          facts.push({ type: 'number', value: token, token, offset: match.index, channel, visibility, msgIndex: idx });
          if (seenNumber.size >= MAX_NUMBERS) break;
        }
      }
    }
  });
  return facts;
}

/** CJK 4-gram containment: covered if any 4-char CJK substring appears. */
function cjkCovered(sentence, digestText) {
  const runs = sentence.match(/[一-鿿]{2,}/g) ?? [];
  for (const run of runs) {
    if (run.length < 4) {
      if (digestText.includes(run)) return true;
      continue;
    }
    for (let i = 0; i + 4 <= run.length; i += 1) {
      if (digestText.includes(run.slice(i, i + 4))) return true;
    }
  }
  return false;
}

function factCovered(fact, digestText, digestTextLower) {
  if (fact.type === 'decision') return cjkCovered(fact.value, digestText);
  if (fact.type === 'file') return digestTextLower.includes(fact.token.toLowerCase());
  return digestText.includes(fact.token);
}

// ---------------------------------------------------------------------------
// Main scan
// ---------------------------------------------------------------------------
const sessions = db.prepare(`
  SELECT ws.id, ws.platform, ws.title, ws.message_count, ws.last_activity_at,
         sd.one_liner, sd.key_topics, sd.key_files, sd.decisions, sd.open_questions,
         sd.message_count AS digest_message_count, sd.updated_at AS digest_updated_at, sd.digest_version
  FROM work_sessions ws
  LEFT JOIN session_digests sd ON sd.session_id = ws.id
  WHERE ws.session_type = 'conversation' OR ws.session_type IS NULL
  ORDER BY ws.started_at
`).all();

const msgStmt = db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY sequence, timestamp');

const allFacts = [];
const sessionRows = [];
let degradedDigests = 0;
let degradedExactDigests = 0;
let staleDigests = 0;
let missingDigests = 0;

for (const s of sessions) {
  const messages = msgStmt.all(s.id);
  const digestText = [s.one_liner, s.key_topics, s.key_files, s.decisions, s.open_questions]
    .filter(Boolean).join('\n');
  const digestTextLower = digestText.toLowerCase();

  if (!s.one_liner && !s.key_topics) {
    missingDigests += 1;
  } else {
    const emptyArrays = ['[]', '[]', '[]', '[]'];
    const arrays = [s.key_topics, s.key_files, s.decisions, s.open_questions].map(v => (v ?? '[]').trim());
    if (arrays.every((a, i) => a === emptyArrays[i])) {
      degradedDigests += 1;
      // Exact rule (mirrors isDegradedDigest in digestService): the one_liner
      // must also echo the first user message.
      const firstUser = messages.find(m => m.role === 'user' && String(m.content_text ?? '').trim());
      if (isDegradedDigestExact({ oneLiner: s.one_liner }, firstUser?.content_text ?? '')) {
        degradedExactDigests += 1;
      }
    }
  }
  if (s.digest_message_count != null && s.digest_message_count < messages.length) staleDigests += 1;

  const windowSet = digestWindowIndices(messages);
  const windowMapV2 = digestWindowMapV2(messages);
  const facts = extractFacts(messages, windowSet);
  for (const f of facts) {
    f.covered = factCovered(f, digestText, digestTextLower);
    f.visibilityV2 = factVisibleV2(f, windowMapV2) ? 'window' : 'outside';
    f.sessionId = s.id;
    f.platform = s.platform;
    allFacts.push(f);
  }

  const covered = facts.filter(f => f.covered).length;
  sessionRows.push({
    sessionId: s.id, platform: s.platform, title: (s.title ?? '').slice(0, 40),
    messages: messages.length, facts: facts.length, covered,
    coverage: facts.length ? covered / facts.length : null,
    windowMessages: windowSet.size,
    windowMessagesV2: windowMapV2.size,
    digestStale: s.digest_message_count != null && s.digest_message_count < messages.length,
  });
}

// ---------------------------------------------------------------------------
// Aggregates
// ---------------------------------------------------------------------------
function coverageOf(rows) {
  if (!rows.length) return null;
  return rows.filter(f => f.covered).length / rows.length;
}
function group(rows, keyFn) {
  const m = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return [...m.entries()].map(([group, g]) => ({
    group, n: g.length, covered: g.filter(f => f.covered).length, coverage: coverageOf(g),
  })).sort((a, b) => a.group.localeCompare(b.group));
}

const byType = group(allFacts, f => f.type);
const byTypeVisibility = group(allFacts, f => `${f.type} / ${f.visibility}`);
const byTypeVisibilityV2 = group(allFacts, f => `${f.type} / ${f.visibilityV2}`);
const byPlatformType = group(allFacts, f => `${f.platform} / ${f.type}`);
const byChannel = group(allFacts, f => `${f.type} / ${f.channel}`);

const sessionsWithFacts = sessionRows.filter(s => s.facts >= 5);
const buckets = [0, 0, 0, 0]; // 0-25,25-50,50-75,75-100
for (const s of sessionsWithFacts) {
  buckets[Math.min(3, Math.floor((s.coverage ?? 0) * 4))] += 1;
}
const worst = [...sessionsWithFacts].sort((a, b) => (a.coverage ?? 0) - (b.coverage ?? 0) || b.facts - a.facts).slice(0, 8);

// In-window misses are pure compression loss: the pipeline SAW the fact and
// the digest still dropped it. Sample them as evidence.
const inWindowMisses = allFacts.filter(f => f.visibility === 'window' && !f.covered);
const missedSamples = {
  decision: inWindowMisses.filter(f => f.type === 'decision').slice(0, 6).map(f => f.value),
  file: inWindowMisses.filter(f => f.type === 'file').slice(0, 6).map(f => f.value),
  number: inWindowMisses.filter(f => f.type === 'number').slice(0, 6).map(f => f.value),
};

const report = {
  bench: 'C',
  generatedAt: new Date().toISOString(),
  db: path.basename(args.db),
  totals: {
    sessions: sessions.length,
    sessionsWithFacts: sessionsWithFacts.length,
    facts: allFacts.length,
    missingDigests,
    degradedDigests,
    degradedExactDigests,
    staleDigests,
    factsCovered: allFacts.filter(f => f.covered).length,
    coverage: coverageOf(allFacts),
    windowVisibility: {
      window: allFacts.filter(f => f.visibility === 'window').length,
      outside: allFacts.filter(f => f.visibility === 'outside').length,
    },
    windowVisibilityV2: {
      window: allFacts.filter(f => f.visibilityV2 === 'window').length,
      outside: allFacts.filter(f => f.visibilityV2 === 'outside').length,
    },
  },
  coverageByType: byType,
  coverageByTypeVisibility: byTypeVisibility,
  visibilityByTypeV2: byTypeVisibilityV2,
  coverageByChannel: byChannel,
  coverageByPlatformType: byPlatformType,
  sessionCoverageBuckets: { '0-25%': buckets[0], '25-50%': buckets[1], '50-75%': buckets[2], '75-100%': buckets[3] },
  worstSessions: worst,
  missedInWindowSamples: missedSamples,
};

const date = new Date().toISOString().slice(0, 10);
const baseName = `bench-c-${args.tag ? `${args.tag}-` : ''}${date}`;
const jsonPath = path.join(OUT_DIR, `${baseName}.json`);
const mdPath = path.join(OUT_DIR, `${baseName}.md`);
writeJson(jsonPath, report);

const t = report.totals;
const md = `# Bench C digest 保真度报告（${date}${args.tag ? `，${args.tag}` : ''}）

库：${path.basename(args.db)}（真实库只读快照）；会话 ${t.sessions} 个；程序抽取关键事实 ${t.facts} 条；digest 覆盖 ${t.factsCovered} 条（总覆盖率 ${pct(t.factsCovered, t.facts)}）。
digest 状态：缺失 ${t.missingDigests}，退化（四字段全空）${t.degradedDigests}（其中精确规则——one_liner 复述首条用户消息——命中 ${t.degradedExactDigests}），滞后（digest 消息数 < 当前消息数）${t.staleDigests}。
事实可见性（窗口 v1，基线口径）：在 digest 输入窗口内 ${t.windowVisibility.window} 条，窗口外 ${t.windowVisibility.outside} 条（窗口 = 最近 ≤60 条消息、尾部 6000 字符预算，thinking 不可见）。
事实可见性（窗口 v2，新组装）：窗口内 ${t.windowVisibilityV2.window} 条，窗口外 ${t.windowVisibilityV2.outside} 条（窗口 = 首条用户消息 + 最近 ≤500 条（安全阀）+ 阀外最近 10 条文件写操作，12000 字符预算、超大消息（>10k）头尾截断至 4000、普通消息整吞、新者优先）。

## 覆盖率 — 按事实类型

${mdTable(['事实类型', 'n', '覆盖', '覆盖率'], byType.map(g => [g.group, String(g.n), String(g.covered), pct(g.covered, g.n)]))}

## 覆盖率 — 按类型 × 可见性（窗口 v1）

${mdTable(['类型 / 可见性', 'n', '覆盖', '覆盖率'], byTypeVisibility.map(g => [g.group, String(g.n), String(g.covered), pct(g.covered, g.n)]))}

## 事实可见性 — 按类型（窗口 v2，新组装）

${mdTable(['类型 / 可见性', 'n', '覆盖', '覆盖率'], byTypeVisibilityV2.map(g => [g.group, String(g.n), String(g.covered), pct(g.covered, g.n)]))}

## 覆盖率 — 按平台 × 类型

${mdTable(['平台 / 类型', 'n', '覆盖', '覆盖率'], byPlatformType.map(g => [g.group, String(g.n), String(g.covered), pct(g.covered, g.n)]))}

## 每会话覆盖率分布（仅统计事实数 ≥5 的会话，n=${sessionsWithFacts.length}）

${mdTable(['覆盖率区间', '会话数'], Object.entries(report.sessionCoverageBuckets).map(([k, v]) => [k, String(v)]))}

## 覆盖率最低的会话（窗口消息数 v1 → v2）

${mdTable(
  ['会话', '平台', '消息数', '事实数', '覆盖率', '窗口消息数 v1→v2', 'digest 滞后'],
  worst.map(s => [`${s.title}（${s.sessionId.slice(0, 28)}…）`, s.platform, String(s.messages), String(s.facts), pct(s.covered, s.facts), `${s.windowMessages}→${s.windowMessagesV2}`, s.digestStale ? '是' : '否']))}

## 窗口内仍丢失的事实样本（压缩损失直接证据）

- decision：${missedSamples.decision.map(v => `「${v.slice(0, 60)}」`).join('、') || '无'}
- file：${missedSamples.file.join('、') || '无'}
- number：${missedSamples.number.join('、') || '无'}
`;
writeText(mdPath, md);

console.log(`[bench-c] sessions=${t.sessions} facts=${t.facts} coverage=${pct(t.factsCovered, t.facts)}`);
for (const g of byTypeVisibility) console.log(`[bench-c]   ${g.group}: ${pct(g.covered, g.n)} (${g.covered}/${g.n})`);
console.log(`[bench-c] window v1: ${t.windowVisibility.window}/${t.facts} in-window (${pct(t.windowVisibility.window, t.facts)})`);
console.log(`[bench-c] window v2: ${t.windowVisibilityV2.window}/${t.facts} in-window (${pct(t.windowVisibilityV2.window, t.facts)})`);
console.log(`[bench-c] degraded=${t.degradedDigests} degradedExact=${t.degradedExactDigests} stale=${t.staleDigests} missing=${t.missingDigests}`);
console.log(`[bench-c] wrote ${jsonPath}`);
console.log(`[bench-c] wrote ${mdPath}`);
