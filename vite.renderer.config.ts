import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Resolve to a UTF-8-normalized absolute path so Vite's /@fs/ URL handler
 *  encodes non-ASCII segments correctly on Windows. */
function aliasPath(...segments: string[]): string {
  return fileURLToPath(pathToFileURL(path.resolve(__dirname, ...segments)));
}

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
      '@vesti/ui': aliasPath('packages/vesti-ui/src/index.ts'),
      '@vesti/content-package': aliasPath('packages/vesti-content-package/src/index.ts'),
    },
  },
});
