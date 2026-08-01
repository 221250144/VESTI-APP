// Stage the vesti-mcp server for packaging: copy the bundled dist/ into a
// directory whose basename is `vesti-mcp`, so electron-packager's
// extraResource lands it at `<resources>/vesti-mcp/cli.js` — the path
// agentMcpRegistry probes after the dev location.
// A minimal package.json with "type":"module" rides along: dist is ESM and
// the staged tree no longer sits under packages/vesti-mcp/package.json.
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const dist = path.join(root, 'packages', 'vesti-mcp', 'dist');
const stage = path.join(root, '.build-cache', 'mcp-stage', 'vesti-mcp');

rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
cpSync(dist, stage, { recursive: true });
writeFileSync(
  path.join(stage, 'package.json'),
  JSON.stringify({ name: 'vesti-mcp', private: true, type: 'module' }, null, 2),
  'utf8',
);
console.log(`[mcp:stage] staged ${dist} -> ${stage}`);
