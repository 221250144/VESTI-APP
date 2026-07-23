// One-off probe: how good are the current session digests and project briefs?
import Database from 'better-sqlite3';
import os from 'node:os';
import path from 'node:path';

const dbPath = path.join(os.homedir(), '.vesti', 'db', 'vesti.db');
const db = new Database(dbPath, { readonly: true });

const digests = db.prepare('SELECT * FROM session_digests').all();
const byStatus = {};
for (const d of digests) byStatus[d.embedding_status] = (byStatus[d.embedding_status] ?? 0) + 1;
const structuredEmpty = digests.filter(d =>
  JSON.parse(d.key_topics || '[]').length === 0 &&
  JSON.parse(d.key_files || '[]').length === 0 &&
  JSON.parse(d.decisions || '[]').length === 0 &&
  JSON.parse(d.open_questions || '[]').length === 0).length;
console.log('digests total:', digests.length, 'byStatus:', byStatus, 'structuredEmpty:', structuredEmpty);

// One-liner pollution: how many contain injected tags or raw prompt echoes?
const polluted = digests.filter(d => /<timestamp>|<user_query>|<user_info>|<system/.test(d.one_liner ?? ''));
console.log('one_liner with injected tags:', polluted.length);
const samples = digests.slice(0, 500).filter(d => (d.one_liner ?? '').length > 0);
console.log('\n--- sample one_liners (10 random) ---');
for (const d of samples.sort(() => Math.random() - 0.5).slice(0, 10)) {
  console.log(`[${d.embedding_status}] ${(d.one_liner ?? '').slice(0, 120).replace(/\n/g, ' ')}`);
}

const briefs = db.prepare('SELECT * FROM project_briefs').all();
console.log('\nproject_briefs:', briefs.length);
for (const b of briefs) {
  const md = b.content_markdown ?? '';
  const isFallback = md.includes('— 当前状态') && md.includes('## 活跃文件');
  console.log(`- ${b.project_key} v${b.version} ${b.updated_at?.slice(0,10)} len=${md.length} fallbackL0=${isFallback}`);
}
const states = db.prepare('SELECT * FROM project_state').all();
console.log('\nproject_state:', states.length);
for (const s of states.slice(0, 12)) {
  console.log(`- ${s.project_key} sessions=${s.session_count} oneLiner="${(s.one_liner??'').slice(0,80).replace(/\n/g,' ')}"`);
}
console.log('\n--- one brief sample (first 1500 chars) ---');
if (briefs[0]) console.log(briefs[0].content_markdown.slice(0, 1500));
db.close();
