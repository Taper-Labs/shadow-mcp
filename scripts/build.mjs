// Bundles src/index.ts and every dependency into one unminified ESM file.
import { chmodSync } from 'node:fs';
import { build } from 'esbuild';

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  minify: false,
  legalComments: 'inline',
  banner: { js: '#!/usr/bin/env node' },
  logLevel: 'warning',
});
chmodSync('dist/index.js', 0o755);
