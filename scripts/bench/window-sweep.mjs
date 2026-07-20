/** One-off: parameter sweep for the v2 digest window policy on the real
 * snapshot — per-message cap × extras/first-user on/off. Reports fact
 * visibility (facts whose text survives inside the window) and the worst
 * session's windowed-message count. */
import path from 'node:path';
import { CACHE_DIR } from './common.mjs';

const BetterSqlite3 = (await import('better-sqlite3')).default;
const db = new BetterSqlite3(path.join(CACHE_DIR, 'vesti-real-snapshot.db'), { readonly: true });

const BUDGET = 6000;
const RECENT = 60;
const TOOL_OUTPUT_CHARS = 200;
const MIN_SLOT = 40;
const OVERSIZED = 10_000;
const FIRST_USER_CHARS = 400;
const FILE_WRITE_EXTRA_LIMIT = 10;
const FILE_WRITE_TOOL_NAMES = new Set([
  'edit', 'multiedit', 'write', 'notebookedit',
  'edit_file', 'edit_file_v2', 'write_file', 'create_file', 'delete_file',
  'apply_patch', 'str_replace_editor', 'fswrite',
]);
const isFileWriteTool = n => Boolean(n && FILE_WRITE_TOOL_NAMES.has(String(n).trim().toLowerCase()));

function format(m) {
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

function truncateMirror(len, cap, oversized) {
  if (len <= cap) return { ranges: [[0, len]], emitted: len };
  if (cap < MIN_SLOT) return { ranges: [[0, cap]], emitted: cap };
  if (oversized && cap >= 120) {
    const estimate = 20;
    let head = Math.ceil((cap - estimate) * 0.6);
    const tail = cap - estimate - head;
    const markLen = `……[中间省略 ${len - head - tail} 字符]……`.length;
    if (markLen > estimate) head = Math.max(0, head - (markLen - estimate));
    return { ranges: [[0, head], [len - tail, len]], emitted: head + markLen + (tail > 0 ? tail : 0) };
  }
  return { ranges: [[0, cap - 6]], emitted: cap };
}

/** policy: { cap, budget, recent, firstUser, extras } — cap=Infinity replicates
 * v1 plus optional sections. Returns Map msgIndex -> ranges. */
function windowMap(messages, { cap, budget, recent, firstUser, extras }) {
  const entries = [];
  messages.forEach((m, index) => {
    const f = format(m);
    if (f) entries.push({ index, message: m, formatted: f, oversized: f.length > OVERSIZED });
  });
  const kept = new Map();
  if (!entries.length) return kept;
  const recentStart = Math.max(0, entries.length - recent);
  const selected = new Set();
  for (let i = recentStart; i < entries.length; i += 1) selected.add(i);
  if (extras) {
    let n = 0;
    for (let i = recentStart - 1; i >= 0 && n < FILE_WRITE_EXTRA_LIMIT; i -= 1) {
      if (isFileWriteTool(entries[i].message.content_tool_name)) { selected.add(i); n += 1; }
    }
  }
  let remaining = budget;
  const firstUserPos = firstUser
    ? entries.findIndex(e => e.message.role === 'user' && String(e.message.content_text ?? '').trim())
    : -1;
  if (firstUserPos !== -1) {
    const entry = entries[firstUserPos];
    const c = Math.max(MIN_SLOT, Math.min(FIRST_USER_CHARS, Math.floor(budget / 4), entry.formatted.length));
    const r = truncateMirror(entry.formatted.length, c, entry.oversized);
    kept.set(entry.index, r.ranges);
    remaining -= 6 + r.emitted + 1;
    selected.delete(firstUserPos);
  }
  const windowed = [...selected].sort((a, b) => b - a).map(i => entries[i]);
  windowed.forEach((entry, i) => {
    // Oversized messages (>10k) take the head+tail cap; normal messages are
    // always kept whole — facts concentrate in long messages, so capping
    // mid-size messages measurably destroys visibility (see sweep results).
    const msgCap = entry.oversized ? Math.min(cap, remaining) : remaining;
    let c = msgCap;
    if (i === 0) c = Math.max(c, MIN_SLOT);
    if (c < MIN_SLOT) return;
    const r = truncateMirror(entry.formatted.length, c, entry.oversized);
    kept.set(entry.index, r.ranges);
    remaining -= r.emitted + 1;
  });
  return kept;
}

// v1 window for reference
function windowV1(messages) {
  const recent = messages.slice(-RECENT);
  const off = messages.length - recent.length;
  const included = new Set();
  let used = 0;
  for (let i = recent.length - 1; i >= 0; i -= 1) {
    const f = format(recent[i]).slice(3); // v1 mirror had no role prefix
    if (!f) continue;
    if (used + f.length > BUDGET && included.size > 0) break;
    included.add(off + i);
    used += f.length;
  }
  return included;
}

// fact extraction (same regexes as bench-c)
const DECISION_RE = /(决定|确定|确认|采用|选用|改为|改成|切换|迁移|替换|放弃|定为|拍板|不再使用|不再用)/;
const FILE_RE = /(?:[A-Za-z]:[\\/])?(?:[\w\-一-鿿]+[\\/])*[\w\-一-鿿]+\.(?:ts|tsx|js|mjs|cjs|py|rs|go|java|md|json|ya?ml|toml|sql|css|scss|html|vue|png|jpe?g|svg|gif|sh|ps1|bat|txt)/g;
const NUMBER_RE = /(?:\bv?\d+\.\d+(?:\.\d+)?\b)|(?:\b\d+(?:\.\d+)?\s?(?:ms|s|min|kb|mb|gb|px|%|个|条|次|行|分钟|小时|天|周|元)\b)/g;
const basename = p => p.replace(/\\/g, '/').split('/').pop();

function extractFacts(messages) {
  const facts = [];
  const seenF = new Set(); const seenN = new Set(); let dec = 0;
  messages.forEach((m, idx) => {
    for (const [text, channel] of [[m.content_text, 'text'], [m.content_thinking, 'thinking']]) {
      if (!text || typeof text !== 'string') continue;
      if (dec < 15) {
        for (const match of text.matchAll(/[^。!?\n]+[。!?\n]?/g)) {
          const s = match[0].trim().replace(/[。!?]$/, '');
          const lead = match[0].length - match[0].trimStart().length;
          if (s.length >= 8 && s.length <= 160 && DECISION_RE.test(s)) {
            dec += 1;
            facts.push({ type: 'decision', offset: match.index + lead, len: s.length, msgIndex: idx, channel });
            if (dec >= 15) break;
          }
        }
      }
      if (channel === 'text') {
        for (const match of text.matchAll(FILE_RE)) {
          const bn = basename(match[0]);
          if (!bn || bn.length < 4 || seenF.has(bn.toLowerCase())) continue;
          seenF.add(bn.toLowerCase());
          facts.push({ type: 'file', offset: match.index, len: match[0].length, msgIndex: idx, channel });
          if (seenF.size >= 25) break;
        }
        for (const match of text.matchAll(NUMBER_RE)) {
          const t = match[0].trim();
          if (seenN.has(t)) continue;
          seenN.add(t);
          facts.push({ type: 'number', offset: match.index, len: match[0].length, msgIndex: idx, channel });
          if (seenN.size >= 25) break;
        }
      }
    }
  });
  return facts;
}

const sessions = db.prepare(`SELECT id FROM work_sessions WHERE session_type = 'conversation' OR session_type IS NULL ORDER BY started_at`).all();
const msgStmt = db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY sequence, timestamp');

const policies = [
  ['v1 (baseline)', null],
  ['rAll b12000 ovCap=3000', { recent: 100000, budget: 12000, cap: 3000, firstUser: true, extras: true }],
  ['rAll b12000 ovCap=4000', { recent: 100000, budget: 12000, cap: 4000, firstUser: true, extras: true }],
  ['rAll b18000 ovCap=4000', { recent: 100000, budget: 18000, cap: 4000, firstUser: true, extras: true }],
  ['rAll b18000 ovCap=6000', { recent: 100000, budget: 18000, cap: 6000, firstUser: true, extras: true }],
  ['rAll b12000 cap=Inf', { recent: 100000, budget: 12000, cap: Infinity, firstUser: true, extras: true }],
];
const totals = new Map(policies.map(([name]) => [name, {
  visible: 0, facts: 0, worstWindow: Infinity, emitted: 0,
  byType: { decision: [0, 0], file: [0, 0], number: [0, 0] },
}]));

for (const s of sessions) {
  const messages = msgStmt.all(s.id);
  const facts = extractFacts(messages);
  const v1set = windowV1(messages);
  const maps = new Map();
  for (const [name, policy] of policies) {
    if (policy === null) continue;
    maps.set(name, windowMap(messages, policy));
  }
  for (const f of facts) {
    for (const [name, t] of totals) {
      t.facts += 1;
      t.byType[f.type][1] += 1;
      if (f.channel === 'thinking') continue;
      let visible = false;
      if (name === 'v1 (baseline)') {
        visible = v1set.has(f.msgIndex);
      } else {
        const ranges = maps.get(name).get(f.msgIndex);
        if (ranges) {
          const start = f.offset + 3;
          const end = start + f.len;
          visible = ranges.some(([a, b]) => start >= a && end <= b);
        }
      }
      if (visible) {
        t.visible += 1;
        t.byType[f.type][0] += 1;
      }
    }
  }
  // worst window breadth (messages seen) + transcript cost per policy
  for (const [name, t] of totals) {
    const size = name === 'v1 (baseline)' ? v1set.size : maps.get(name).size;
    if (size < t.worstWindow && messages.length > 10) t.worstWindow = Math.min(t.worstWindow, size);
    if (name !== 'v1 (baseline)') {
      let chars = 0;
      for (const ranges of maps.get(name).values()) chars += ranges.reduce((sum, [a, b]) => sum + (b - a), 0);
      t.emitted += chars;
    }
  }
}

console.log('policy'.padEnd(22), 'visible', 'pct', 'decision', 'file', 'number', 'worstBreadth', 'avgChars/session');
for (const [name, t] of totals) {
  const pctOf = ([v, n]) => `${(v / n * 100).toFixed(1)}%`;
  console.log(
    name.padEnd(22),
    `${t.visible}/${t.facts}`.padStart(11),
    `${(t.visible / t.facts * 100).toFixed(1)}%`.padStart(6),
    pctOf(t.byType.decision).padStart(7),
    pctOf(t.byType.file).padStart(6),
    pctOf(t.byType.number).padStart(7),
    String(t.worstWindow).padStart(6),
    name === 'v1 (baseline)' ? '      —' : String(Math.round(t.emitted / sessions.length)).padStart(7),
  );
}

// Decompose v1's outside-window facts: why couldn't the pipeline see them?
let thinking = 0; let oldText = 0; let overBudgetText = 0;
for (const s of sessions) {
  const messages = msgStmt.all(s.id);
  const facts = extractFacts(messages);
  const v1set = windowV1(messages);
  const recentStart = Math.max(0, messages.length - RECENT);
  for (const f of facts) {
    if (f.channel === 'thinking') { thinking += 1; continue; }
    if (v1set.has(f.msgIndex)) continue;
    if (f.msgIndex < recentStart) oldText += 1;
    else overBudgetText += 1;
  }
}
const outside = thinking + oldText + overBudgetText;
console.log(`\nv1 outside-window decomposition (${outside} facts): thinking=${thinking} (${(thinking / outside * 100).toFixed(1)}%), older-than-60 text=${oldText} (${(oldText / outside * 100).toFixed(1)}%), recent-but-over-budget text=${overBudgetText} (${(overBudgetText / outside * 100).toFixed(1)}%)`);
