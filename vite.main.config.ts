import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    rollupOptions: {
      // Bundle the shared capture engine. Keep only native/OS-specific modules
      // external so Vite never tries to parse a .node binary.
      external: ['better-sqlite3', 'fsevents'],
    },
  },
});
