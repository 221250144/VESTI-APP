import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        main_window: path.resolve(__dirname, 'index.html'),
        capsule: path.resolve(__dirname, 'capsule.html'),
      },
    },
  },
  resolve: {
    alias: {
      // Consume workspace UI packages from source so the renderer shares
      // a single React instance and picks up Tailwind classes directly.
      '@vesti/ui': path.resolve(__dirname, 'packages/vesti-ui/src/index.ts'),
      '@vesti/content-package': path.resolve(__dirname, 'packages/vesti-content-package/src/index.ts'),
    },
  },
});
