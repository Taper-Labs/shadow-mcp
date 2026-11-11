// Bundles bench/bench.ts to a temporary file, runs it, and removes the file.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const dir = mkdtempSync(join(tmpdir(), 'shadow-mcp-bench-build-'));
try {
  const outfile = join(dir, 'bench.mjs');
  await build({ entryPoints: ['bench/bench.ts'], outfile, bundle: true, platform: 'node', format: 'esm', target: 'node20', logLevel: 'warning' });
  await import(pathToFileURL(outfile).href);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
