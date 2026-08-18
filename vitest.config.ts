import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      // Mirror vite.renderer.config.ts so renderer modules resolve identically in tests.
      '@vesti/capture-core/injected-blocks': path.resolve(__dirname, 'packages/capture-core/src/injectedBlocks.ts'),
      '@vesti/ui': path.resolve(__dirname, 'packages/vesti-ui/src/index.ts'),
      '@vesti/content-package': path.resolve(__dirname, 'packages/vesti-content-package/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    include: [
      'src/**/*.test.ts',
      'src/**/*.test.tsx',
      // 网关众筹兑换逻辑(deploy/vesti-gate)是纯 .mjs 模块,随根仓一起跑。
      'deploy/vesti-gate/**/*.test.mjs',
      // Pure logic for the library source-tree nav / organizer (P2b) lives in
      // the UI package but is covered by the root runner (node environment,
      // no DOM needed).
      'packages/vesti-ui/src/**/*.test.ts',
    ],
  },
});
