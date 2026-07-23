// Probe 1: is the demo proxy LLM reachable again?
// Probe 2: what do tool_executions rows carry (for L0 active-files quality)?
import Database from 'better-sqlite3';
import os from 'node:os';
import path from 'node:path';

const dbPath = path.join(os.homedir(), '.vesti', 'db', 'vesti.db');
const db = new Database(dbPath, { readonly: true });

const counts = db.prepare(`
  SELECT tool_name, COUNT(*) c FROM tool_executions GROUP BY tool_name ORDER BY c DESC LIMIT 20
`).all();
console.log('tool_name distribution:', counts.map(r => `${r.tool_name}:${r.c}`).join(' '));
const rows = db.prepare(`
  SELECT tool_name, input_summary FROM tool_executions
  WHERE input_summary IS NOT NULL ORDER BY timestamp DESC LIMIT 25
`).all();
console.log('\n--- recent input_summary samples ---');
for (const r of rows) {
  console.log(`[${r.tool_name}] ${(r.input_summary ?? '').slice(0, 140).replace(/\n/g, ' ')}`);
}
db.close();

try {
  const response = await fetch('https://vesti-gate.vercel.app/api/chat', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-vesti-service-token': 'vesti-kcq-default-d850d4dcd610a0e2e919eb610f42066faff1e1c57c0c047c',
    },
    body: JSON.stringify({
      model: 'qwen-plus',
      messages: [{ role: 'user', content: 'reply with the single word: ok' }],
      max_tokens: 8,
    }),
  });
  console.log('\nLLM probe status:', response.status, (await response.text()).slice(0, 300));
} catch (error) {
  console.log('\nLLM probe error:', String(error).slice(0, 200));
}
