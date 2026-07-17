import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const electronVersion = packageJson.devDependencies?.electron;
const moduleDir = path.join(root, 'node_modules', 'better-sqlite3');
const executable = path.join(
  root,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'prebuild-install.cmd' : 'prebuild-install',
);

if (!/^\d+\.\d+\.\d+$/.test(electronVersion ?? '')) {
  throw new Error('Electron must be pinned to an exact version before preparing native modules.');
}
if (!fs.existsSync(executable) || !fs.existsSync(moduleDir)) {
  throw new Error('Dependencies are missing. Run pnpm install first.');
}

const result = spawnSync(
  executable,
  ['--runtime', 'electron', '--target', electronVersion],
  {
    cwd: moduleDir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  },
);

if (result.error) throw result.error;
if (result.status !== 0) {
  throw new Error(`Failed to install the better-sqlite3 prebuild for Electron ${electronVersion}.`);
}
