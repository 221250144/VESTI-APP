import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') process.exit(0);

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electronPackage = JSON.parse(await fs.readFile(
  path.join(projectRoot, 'node_modules', 'electron', 'package.json'),
  'utf8',
));
const cacheDirectory = path.join(projectRoot, '.build-cache', 'electron');
const zipPath = path.join(
  cacheDirectory,
  `electron-v${electronPackage.version}-win32-${process.arch}.zip`,
);

try {
  const existing = await fs.stat(zipPath);
  if (existing.size > 1_000_000) {
    console.log(`Using local Electron archive: ${zipPath}`);
    process.exit(0);
  }
} catch {
  // Build the archive below.
}

await fs.mkdir(cacheDirectory, { recursive: true });
await fs.rm(zipPath, { force: true });
const electronDist = path.join(projectRoot, 'node_modules', 'electron', 'dist');
const quote = value => `'${value.replaceAll("'", "''")}'`;
const command = [
  'Compress-Archive',
  '-Path', quote(path.join(electronDist, '*')),
  '-DestinationPath', quote(zipPath),
  '-CompressionLevel', 'Optimal',
].join(' ');

console.log(`Creating local Electron archive: ${zipPath}`);
await new Promise((resolve, reject) => {
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    cwd: projectRoot,
    stdio: 'inherit',
  });
  child.once('error', reject);
  child.once('exit', code => code === 0
    ? resolve()
    : reject(new Error(`Compress-Archive failed with exit code ${code}`)));
});
