/**
 * Shared helpers for the VESTI session-memory bench.
 * Plain ESM so scripts run directly under Electron node:
 *   ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe scripts/bench/<script>.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const BENCH_DIR = path.dirname(fileURLToPath(import.meta.url));
export const APP_ROOT = path.resolve(BENCH_DIR, '..', '..');
export const CACHE_DIR = path.join(BENCH_DIR, '.cache');
export const OUT_DIR = path.join(APP_ROOT, 'docs', 'bench', 'out');
// Windows ESM: absolute paths must be file:// URLs for dynamic import.
export const CAPTURE_CORE_DIST = pathToFileURL(
  path.join(APP_ROOT, 'packages', 'capture-core', 'dist', 'index.js'),
).href;

export function ensureDirs() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
}

/** Deterministic RNG (mulberry32) so corpus and results are reproducible. */
export function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

export function randInt(rng, min, max) {
  return min + Math.floor(rng() * (max - min + 1));
}

export function shuffle(rng, arr) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

let idCounter = 0;
export function nextId(prefix) {
  idCounter += 1;
  return `${prefix}-${String(idCounter).padStart(5, '0')}`;
}

/** Minimal CLI arg parsing: --key value pairs, booleans as --flag. */
export function parseArgs(argv, defaults = {}) {
  const args = { ...defaults };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = Number.isNaN(Number(next)) ? next : Number(next);
      i += 1;
    }
  }
  return args;
}

export function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

export function writeText(filePath, text) {
  fs.writeFileSync(filePath, text);
}

export function pct(part, whole, digits = 1) {
  if (!whole) return '—';
  return `${((part / whole) * 100).toFixed(digits)}%`;
}

/** Markdown table from header + rows (cells pre-stringified). */
export function mdTable(header, rows) {
  const line = cells => `| ${cells.join(' | ')} |`;
  return [line(header), line(header.map(() => '---')), ...rows.map(line)].join('\n');
}
