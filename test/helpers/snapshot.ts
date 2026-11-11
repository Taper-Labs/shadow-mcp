import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';

/** Every path under `root` with its kind, size, mtime and content hash. */
export function snapshot(root: string): string[] {
  const entries: string[] = [];
  const walk = (dir: string, rel: string) => {
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name);
      const path = rel ? `${rel}/${name}` : name;
      const stats = lstatSync(abs);
      if (stats.isSymbolicLink()) {
        entries.push(`link ${path} -> ${readlinkSync(abs)} ${stats.mtimeMs}`);
      } else if (stats.isDirectory()) {
        entries.push(`dir ${path} ${stats.mtimeMs}`);
        walk(abs, path);
      } else {
        const hash = createHash('sha256').update(readFileSync(abs)).digest('hex');
        entries.push(`file ${path} ${stats.size} ${stats.mtimeMs} ${hash}`);
      }
    }
  };
  walk(root, '');
  return entries;
}
