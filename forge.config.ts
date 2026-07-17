import type { ForgeConfig } from '@electron-forge/shared-types';
import path from 'node:path';
import { MakerZIP } from '@electron-forge/maker-zip';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { VitePlugin } from '@electron-forge/plugin-vite';

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    executableName: 'vesti',
    icon: 'assets/icon',
    extraResource: ['assets/icon.png', 'assets/icon.ico'],
    electronZipDir: process.env.VESTI_ELECTRON_ZIP_DIR
      || (process.platform === 'win32' ? path.join(process.cwd(), '.build-cache', 'electron') : undefined),
    // The capture core is bundled by Vite; copy only SQLite's runtime tree.
    prune: false,
    ignore: [
      /^\/\.build-cache(?:\/|$)/,
      /^\/node_modules\/(?!better-sqlite3(?:\/|$)|bindings(?:\/|$)|file-uri-to-path(?:\/|$))/,
      /^\/node_modules\/\.pnpm(?:\/|$)/,
      // Workspace packages are bundled by Vite from source; their local
      // node_modules are pnpm symlinks Windows cannot copy without admin.
      /^\/packages\/[^/]+\/node_modules(?:\/|$)/,
    ],
  },
  // scripts/prepare-native.mjs installs the matching official prebuild first.
  // Avoid a second rebuild that would require a local Visual C++ toolchain.
  rebuildConfig: { onlyModules: ['__vesti_prebuilt_native__'] },
  makers: [
    new MakerZIP({}, ['darwin', 'linux']),
  ],
  plugins: [
    new AutoUnpackNativesPlugin({}),
    new VitePlugin({
      build: [
        { entry: 'src/main.ts', config: 'vite.main.config.ts', target: 'main' },
        { entry: 'src/preload.ts', config: 'vite.preload.config.ts', target: 'preload' },
      ],
      renderer: [
        { name: 'main_window', config: 'vite.renderer.config.ts' },
      ],
    }),
  ],
};

export default config;
