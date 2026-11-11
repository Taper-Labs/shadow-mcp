import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { findPerson, getMeeting, getTranscript, listActionItems, listMeetings, searchMeetingsTool } from '../src/tools.js';
import { createVaultStore } from '../src/vault.js';
import { IDS, removeDir, tempDir, writeFile, writeStandardVault } from './helpers/vault.js';
import { snapshot } from './helpers/snapshot.js';

const root = tempDir();
afterAll(() => removeDir(root));

describe('the server never changes the Vault', () => {
  it('leaves every path, size, mtime and hash unchanged after every tool', () => {
    writeStandardVault(root);
    writeFile(root, 'Unsynced Files/Meetings/x/Copy.md', '---\ntype: meeting\n---\n');
    writeFile(root, '.shadow/state.json', '{}');
    const before = snapshot(root);
    let now = 0;
    const store = createVaultStore({ resolveRoot: () => root, now: () => now });
    for (let round = 0; round < 2; round += 1) {
      const index = store.get();
      if (!index) throw new Error('Vault not found');
      listMeetings(index, {});
      listMeetings(index, { from: '2026-10-14', person: 'ann', limit: 1 });
      searchMeetingsTool(index, { query: 'budget' });
      searchMeetingsTool(index, { query: '"marketing budget"', scope: ['transcripts'] });
      getMeeting(index, { id: IDS.planning });
      getMeeting(index, { id: IDS.planning, material: 'Meeting Notes' });
      getTranscript(index, { id: IDS.design, from_time: '45:00' });
      getTranscript(index, { id: IDS.planning });
      listActionItems(index, {});
      listActionItems(index, { heading: 'Summary', person: 'dev' });
      findPerson(index, { query: 'example.com' });
      expect(() => getMeeting(index, { id: 'missing' })).toThrow();
      now += 60_000;
    }
    expect(snapshot(root)).toEqual(before);
  });
});

const SRC = fileURLToPath(new URL('../src/', import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? sourceFiles(join(dir, entry.name)) : entry.name.endsWith('.ts') ? [join(dir, entry.name)] : [],
  );
}

const NETWORK_MODULES = ['http', 'https', 'http2', 'net', 'tls', 'dgram', 'dns', 'child_process'];
const WRITE_CALLS = ['writeFile', 'appendFile', 'rm', 'rmdir', 'unlink', 'rename', 'mkdir', 'mkdtemp', 'copyFile', 'cp', 'createWriteStream', 'truncate', 'symlink', 'link', 'chmod', 'chown', 'utimes'];

function forbiddenUses(source: string): string[] {
  const problems: string[] = [];
  for (const name of NETWORK_MODULES) {
    if (new RegExp(`(?:from|import|require)\\s*\\(?\\s*['"](?:node:)?${name}(?:/[^'"]*)?['"]`, 'u').test(source)) problems.push(`imports ${name}`);
  }
  if (/\bfetch\s*\(/u.test(source)) problems.push('calls fetch');
  for (const name of WRITE_CALLS) {
    if (new RegExp(`\\b${name}(?:Sync)?\\s*\\(`, 'u').test(source)) problems.push(`calls ${name}`);
    if (new RegExp(`import\\s*\\{[^}]*\\b${name}(?:Sync)?\\b[^}]*\\}\\s*from\\s*['"](?:node:)?fs(?:/promises)?['"]`, 'u').test(source)) {
      problems.push(`imports ${name}`);
    }
  }
  if (/\bopen(?:Sync)?\s*\([^)]*['"](?:[wa]|[rwa]\+|[wa]x\+?|rs\+)['"]/u.test(source)) problems.push('opens a file for writing');
  return problems;
}

describe('source code cannot write or reach the network', () => {
  it('the checker catches the patterns it is meant to', () => {
    expect(forbiddenUses("import http from 'node:http';")).toEqual(['imports http']);
    expect(forbiddenUses("import { spawn } from 'child_process';")).toEqual(['imports child_process']);
    expect(forbiddenUses('await fetch(url)')).toEqual(['calls fetch']);
    expect(forbiddenUses('fs.writeFileSync(p, x)')).toContain('calls writeFile');
    expect(forbiddenUses("import { rm } from 'node:fs/promises';")).toContain('imports rm');
    expect(forbiddenUses("fs.openSync(p, 'w')")).toEqual(['opens a file for writing']);
    expect(forbiddenUses("readFileSync(p, 'utf8')")).toEqual([]);
  });

  it('no file under src/ uses a network module, fetch, or a writing fs API', () => {
    const files = sourceFiles(SRC);
    expect(files.length).toBeGreaterThan(5);
    const problems = files.flatMap((file) => forbiddenUses(readFileSync(file, 'utf8')).map((problem) => `${file}: ${problem}`));
    expect(problems).toEqual([]);
  });
});
