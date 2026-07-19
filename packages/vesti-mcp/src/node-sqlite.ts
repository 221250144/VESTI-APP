/**
 * Indirection around `node:sqlite`.
 *
 * The production build (tsup) externalizes node builtins without trouble,
 * but vitest 1.x bundles a vite whose builtin-module list predates the
 * `sqlite` module, so a literal `import 'node:sqlite'` fails to resolve in
 * tests. Loading it through createRequire sidesteps vite's resolver; the
 * type import is erased at compile time and never reaches the resolver.
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sqlite = require('node:sqlite') as typeof import('node:sqlite');

export const DatabaseSync = sqlite.DatabaseSync;
export type DatabaseSync = InstanceType<typeof DatabaseSync>;
