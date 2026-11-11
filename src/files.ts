// The one way this server reads a file in the Vault. A file is read only when
// it is a regular file, not a symbolic link, within a size limit, and its real
// path is exactly the expected path under the real Vault root, so a file or a
// parent folder swapped for a link after indexing is never followed.

import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

/** A `Transcript.md` larger than this is never read whole. */
export const TRANSCRIPT_MAX_BYTES = 4 * 1024 * 1024;
/** Any other file larger than this (meeting pages, notes, People pages, `SHADOW.md`) is never read. */
export const FILE_MAX_BYTES = 2 * 1024 * 1024;

export type FileRead = { text: string } | { tooLarge: number } | null;

/**
 * Reads `rel` under `root` (the real path of the Vault root). Returns null
 * when the file is missing or fails a check, and its size when it is larger
 * than `maxBytes`. With `headBytes`, reads only that many bytes from the
 * start and skips the size limit.
 */
export function readVaultFile(root: string, rel: string, maxBytes = FILE_MAX_BYTES, headBytes?: number): FileRead {
  const path = join(root, rel);
  let fd: number | null = null;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stats = fstatSync(fd);
    if (!stats.isFile()) return null;
    if (headBytes === undefined && stats.size > maxBytes) return { tooLarge: stats.size };
    if (realpathSync(path) !== path) return null;
    const length = headBytes === undefined ? stats.size : Math.min(stats.size, headBytes);
    const buffer = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const count = readSync(fd, buffer, read, length - read, read);
      if (count === 0) break;
      read += count;
    }
    return { text: buffer.toString('utf8', 0, read) };
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** The text of a file, or '' when it is missing, fails a check or is too large. */
export function readVaultText(root: string, rel: string): string {
  const read = readVaultFile(root, rel);
  return read && 'text' in read ? read.text : '';
}
