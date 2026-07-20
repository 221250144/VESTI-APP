/* Debug: score distributions for temporal queries + regressed needles. */
import path from 'node:path';
import fs from 'node:fs';
import { CACHE_DIR, CAPTURE_CORE_DIST } from './common.mjs';

const { recallSessions } = await import(CAPTURE_CORE_DIST);
const BetterSqlite3 = (await import('better-sqlite3')).default;

const db = new BetterSqlite3(path.join(CACHE_DIR, 'bench-corpus.db'), { readonly: true });
const truth = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, 'bench-corpus-truth.json'), 'utf8'));

function show(label, query, marks = {}) {
  const hits = recallSessions(db, query, { topK: 8 });
  console.log(`\n## ${label}: ${query}`);
  hits.forEach((h, i) => {
    const age = db.prepare('SELECT last_activity_at FROM work_sessions WHERE id=?').get(h.sessionId);
    const ageDays = ((Date.now() - age.last_activity_at) / 86400000).toFixed(0);
    const tag = marks[h.sessionId] ?? '';
    console.log(`  ${i + 1}. ${h.sessionId} score=${h.score.toFixed(5)} conf=${h.confidence} age=${ageDays}d ${tag} | ${h.title}`);
  });
}

for (const p of truth.updatePairs) {
  show(`temporal ${p.key}`, p.query, { [p.newSessionId]: '<- NEW', [p.oldSessionId]: '<- OLD' });
}
for (const n of truth.needles) {
  const hits = recallSessions(db, n.query, { topK: 5 });
  const rank = hits.findIndex(h => h.sessionId === n.sessionId);
  if (rank !== 0) show(`needle ${n.key} (rank=${rank === -1 ? 'miss' : rank + 1})`, n.query, { [n.sessionId]: '<- NEEDLE' });
}
