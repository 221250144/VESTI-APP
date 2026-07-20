/** One-off: where do facts sit inside their message? (offset percentiles)
 * Informs the v2 window per-message cap policy. */
import path from 'node:path';
import { CACHE_DIR } from './common.mjs';

const BetterSqlite3 = (await import('better-sqlite3')).default;
const db = new BetterSqlite3(path.join(CACHE_DIR, 'vesti-real-snapshot.db'), { readonly: true });

const DECISION_RE = /(决定|确定|确认|采用|选用|改为|改成|切换|迁移|替换|放弃|定为|拍板|不再使用|不再用)/;
const FILE_RE = /(?:[A-Za-z]:[\\/])?(?:[\w\-一-鿿]+[\\/])*[\w\-一-鿿]+\.(?:ts|tsx|js|mjs|cjs|py|rs|go|java|md|json|ya?ml|toml|sql|css|scss|html|vue|png|jpe?g|svg|gif|sh|ps1|bat|txt)/g;
const NUMBER_RE = /(?:\bv?\d+\.\d+(?:\.\d+)?\b)|(?:\b\d+(?:\.\d+)?\s?(?:ms|s|min|kb|mb|gb|px|%|个|条|次|行|分钟|小时|天|周|元)\b)/g;

const sessions = db.prepare(`SELECT id FROM work_sessions WHERE session_type = 'conversation' OR session_type IS NULL`).all();
const msgStmt = db.prepare('SELECT content_text FROM messages WHERE session_id = ? ORDER BY sequence, timestamp');

const offsets = [];
const msgLens = [];
for (const s of sessions) {
  for (const m of msgStmt.all(s.id)) {
    const text = m.content_text;
    if (!text || typeof text !== 'string') continue;
    msgLens.push(text.length);
    const seen = new Set();
    for (const match of text.matchAll(/[^。!?\n]+[。!?\n]?/g)) {
      const sentence = match[0].trim();
      if (sentence.length >= 8 && sentence.length <= 160 && DECISION_RE.test(sentence)) offsets.push(match.index);
    }
    for (const match of text.matchAll(FILE_RE)) { if (!seen.has('f' + match[0])) { seen.add('f' + match[0]); offsets.push(match.index); } }
    for (const match of text.matchAll(NUMBER_RE)) { if (!seen.has('n' + match[0])) { seen.add('n' + match[0]); offsets.push(match.index); } }
  }
}
offsets.sort((a, b) => a - b);
msgLens.sort((a, b) => a - b);
const q = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(arr.length * p))];
console.log(`facts=${offsets.length}`);
for (const p of [0.5, 0.75, 0.9, 0.95, 0.99]) console.log(`fact offset p${p * 100}=${q(offsets, p)}`);
for (const p of [0.5, 0.75, 0.9, 0.95, 0.99]) console.log(`msg length p${p * 100}=${q(msgLens, p)}`);
// share of facts within the first N chars of their message
for (const n of [100, 200, 400, 800]) {
  console.log(`facts within first ${n} chars: ${(offsets.filter(o => o < n).length / offsets.length * 100).toFixed(1)}%`);
}
