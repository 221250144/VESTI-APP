import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/cli.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  external: ['@modelcontextprotocol/sdk'],
  target: 'node22',
  banner: { js: '#!/usr/bin/env node' },
});
