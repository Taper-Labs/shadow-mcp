// Records every path the scan touches through node:fs and checks that the
// set-aside and hidden folders are never listed or read, and that indexing
// reads no more than the first 4,096 bytes of a transcript.

import { statSync } from 'node:fs';
import { afterAll, describe, expect, it, vi } from 'vitest';

const touched: string[] = [];
/** Bytes read through readSync, by the path the descriptor was opened for. */
const bytesRead = new Map<string, number>();
const openPaths = new Map<number, string>();
/** Paths read whole through readFileSync. */
const wholeReads: string[] = [];

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const record =
    <A extends unknown[], R>(fn: (...args: A) => R) =>
    (...args: A): R => {
      touched.push(String(args[0]));
      return fn(...args);
    };
  return {
    ...actual,
    default: actual,
    readFileSync: record((...args: Parameters<typeof actual.readFileSync>) => {
      wholeReads.push(String(args[0]));
      return actual.readFileSync(...args);
    }),
    readdirSync: record(actual.readdirSync),
    statSync: record(actual.statSync),
    lstatSync: record(actual.lstatSync),
    realpathSync: record(actual.realpathSync),
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      const fd = actual.openSync(...args);
      touched.push(String(args[0]));
      openPaths.set(fd, String(args[0]));
      return fd;
    },
    readSync: (...args: Parameters<typeof actual.readSync>) => {
      const count = actual.readSync(...args);
      const path = openPaths.get(args[0]) ?? `fd ${args[0]}`;
      bytesRead.set(path, (bytesRead.get(path) ?? 0) + count);
      return count;
    },
  };
});

const { buildIndex } = await import('../src/vault.js');
const { resolveVault } = await import('../src/locate.js');
const helpers = await import('./helpers/vault.js');

const root = helpers.tempDir();
const big = helpers.tempDir();
afterAll(() => {
  helpers.removeDir(root);
  helpers.removeDir(big);
});

describe('paths the scan touches', () => {
  it('never lists or reads Unsynced Files, Archived Vaults or .shadow', () => {
    helpers.writeStandardVault(root);
    const hidden = { title: 'Hidden', date: '2026-10-06' };
    helpers.writeMeeting(root, { ...hidden, id: 'hidden-1', folder: 'Unsynced Files/Meetings/2026/10/Hidden' });
    helpers.writeMeeting(root, { ...hidden, id: 'hidden-2', folder: 'Archived Vaults/Old/Meetings/2026/10/Hidden' });
    helpers.writeFile(root, '.shadow/state.md', '---\ntype: meeting\n---\n');
    helpers.writeMeeting(root, { ...hidden, id: 'hidden-3', folder: 'Meetings/2026/Unsynced Files/Hidden' });
    helpers.writeFile(root, 'Notes of my own/README.md', '# Mine\n');
    touched.length = 0;
    const index = buildIndex(root);
    expect(resolveVault({ flag: root })).toBe(root);
    expect(index.meetings).toHaveLength(4);
    expect(touched.length).toBeGreaterThan(0);
    const bad = touched.filter((path) => /Unsynced Files|Archived Vaults|\.shadow|Notes of my own/u.test(path));
    expect(bad).toEqual([]);
  });

  it('reads at most the first 4,096 bytes of each Transcript.md while indexing', () => {
    const turns = Array.from({ length: 2000 }, (_, i) => `[${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}] Speaker 1: line ${i} of a long transcript.`);
    helpers.writeMeeting(big, { id: 'big-1', title: 'Big', date: '2026-10-09', transcript: turns });
    helpers.writeMeeting(big, { id: 'big-2', title: 'Big too', date: '2026-10-10', transcript: turns });
    touched.length = 0;
    wholeReads.length = 0;
    bytesRead.clear();
    const index = buildIndex(big);
    expect(wholeReads.filter((path) => /Transcript\.md$/iu.test(path))).toEqual([]);
    expect(index.meetings.map((m) => m.hasTranscript)).toEqual([true, true]);
    const transcripts = [...new Set(touched.filter((path) => /Transcript\.md$/iu.test(path)))];
    expect(transcripts).toHaveLength(2);
    for (const path of transcripts) {
      expect(statSync(path).size).toBeGreaterThan(50_000);
      expect(bytesRead.get(path)).toBeLessThanOrEqual(4096);
    }
  });
});
