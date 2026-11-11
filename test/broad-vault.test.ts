// --vault pointed at a home folder that happens to hold an unrelated
// Meetings/ folder: nothing outside Meetings/, People/ and SHADOW.md is
// listed, statted, opened or read.

import { afterAll, expect, it, vi } from 'vitest';

const touched: string[] = [];

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
    readFileSync: record(actual.readFileSync),
    readdirSync: record(actual.readdirSync),
    statSync: record(actual.statSync),
    lstatSync: record(actual.lstatSync),
    openSync: record(actual.openSync),
    realpathSync: record(actual.realpathSync),
  };
});

const { resolveVault } = await import('../src/locate.js');
const { buildIndex } = await import('../src/vault.js');
const helpers = await import('./helpers/vault.js');

const home = helpers.tempDir();
afterAll(() => helpers.removeDir(home));

it('reads only Meetings/, People/ and SHADOW.md of a home folder passed as the Vault', () => {
  helpers.writeFile(home, 'Meetings/club/minutes.md', '---\ntype: meeting\ntitle: Book club\n---\nprivate\n');
  helpers.writeFile(home, 'Documents/taxes.md', 'secret');
  helpers.writeFile(home, 'Library/Mail/x.md', 'secret');
  helpers.writeFile(home, 'People/notes.md', '---\nname: Someone\n---\n');
  helpers.writeFile(home, 'Projects/Meetings/a.md', '---\ntype: meeting\n---\n');
  touched.length = 0;
  const root = resolveVault({ flag: home });
  expect(root).toBe(home);
  const index = buildIndex(home);
  expect(index.meetings.map((m) => m.title)).toEqual(['Book club']);
  expect(index.people.map((p) => p.name)).toEqual(['Someone']);
  expect(touched.length).toBeGreaterThan(0);
  expect(touched.filter((path) => /Documents|Library|Projects/u.test(path))).toEqual([]);
});
