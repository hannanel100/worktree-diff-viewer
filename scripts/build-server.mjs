// Bundles server/main.ts (and the lib/ it imports) into one dependency-free
// ESM file, dist/server.mjs, that bin/wtdiff.js loads at runtime.
import { rmSync } from 'node:fs';
import { build } from 'esbuild';

rmSync('dist', { recursive: true, force: true });

await build({
  entryPoints: ['server/main.ts'],
  outfile: 'dist/server.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'info',
});
