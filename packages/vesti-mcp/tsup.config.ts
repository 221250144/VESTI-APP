import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/cli.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  // The MCP SDK is bundled so the packaged desktop app can ship dist/
  // standalone (extraResource) without a node_modules tree alongside it.
  noExternal: ['@modelcontextprotocol/sdk', '@vesti/search-files-core'],
  target: 'node22',
  banner: { js: '#!/usr/bin/env node' },
});
