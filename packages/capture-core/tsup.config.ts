import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/injectedBlocks.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  external: ['better-sqlite3', 'chokidar', 'express', 'cors', 'ws', 'fs-extra'],
  target: 'node18',
});
