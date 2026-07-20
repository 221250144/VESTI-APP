/** One-off: distinct tool names in the real snapshot, to calibrate the
 * file-write tool set used by the digest window v2. */
import path from 'node:path';
import { CACHE_DIR } from './common.mjs';

const BetterSqlite3 = (await import('better-sqlite3')).default;
const db = new BetterSqlite3(path.join(CACHE_DIR, 'vesti-real-snapshot.db'), { readonly: true });
const rows = db.prepare(`
  SELECT content_tool_name AS name, COUNT(*) AS n
  FROM messages
  WHERE content_tool_name IS NOT NULL AND content_tool_name != ''
  GROUP BY content_tool_name
  ORDER BY n DESC
`).all();
for (const r of rows) console.log(`${r.n}\t${r.name}`);
