import { mkdirSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultVaultCandidates, expandHome, isVaultFolder, missingVaultMessage, NO_VAULT_MESSAGE, resolveVault } from '../src/locate.js';
import { buildIndex, createVaultStore } from '../src/vault.js';
import {
  IDS,
  removeDir,
  standardMeetings,
  tempDir,
  transcriptFile,
  writeFile,
  writeGuide,
  writeMeeting,
  writeStandardVault,
} from './helpers/vault.js';

const dirs: string[] = [];
function vault(): string {
  const dir = tempDir();
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length > 0) removeDir(dirs.pop() ?? '');
});

describe('index of a standard Vault', () => {
  it('reads meetings newest first with their details', () => {
    const root = vault();
    writeStandardVault(root);
    const index = buildIndex(root);
    expect(index.meetings.map((m) => m.id)).toEqual([IDS.customer, IDS.design, IDS.planning, IDS.hiring]);
    const planning = index.meetings.find((m) => m.id === IDS.planning);
    expect(planning).toMatchObject({
      title: 'Quarterly Planning',
      date: '2026-10-14',
      startedAt: '2026-10-14T09:00:00.000Z',
      endedAt: '2026-10-14T09:45:30.000Z',
      durationMinutes: 46,
      attendees: [
        { name: 'Ann Lee', email: 'ann@example.com' },
        { name: 'Ben Ortiz', email: 'ben@example.com' },
      ],
      speakers: [
        { speaker: 'Speaker 1', person: 'Ann Lee', email: 'ann@example.com' },
        { speaker: 'Speaker 2', person: 'Ben Ortiz', email: 'ben@example.com' },
        { speaker: 'Speaker 3', person: null, email: null },
      ],
      hasTranscript: true,
    });
    expect(planning?.materials.map((m) => m.name)).toEqual(['Meeting Notes', 'Meeting Outline']);
    const customer = index.meetings.find((m) => m.id === IDS.customer);
    expect(customer).toMatchObject({ title: 'Customer Call | Acme', startedAt: '2026-10-16T01:00:00.000Z', durationMinutes: 30 });
    const hiring = index.meetings.find((m) => m.id === IDS.hiring);
    expect(hiring).toMatchObject({ startedAt: null, endedAt: null, durationMinutes: null, hasTranscript: false, transcriptPath: null });
  });

  it('merges Person pages with attendees that have no page', () => {
    const root = vault();
    writeStandardVault(root);
    const names = buildIndex(root).people.map((p) => `${p.name}|${p.email ?? ''}`);
    expect(names).toEqual([
      'Ann Lee|ann@example.com',
      'Ben Ortiz|ben@example.com',
      'Chloe Park|',
      'Dev Rao|dev.rao@example.com',
      'Eve Stone|eve@example.com',
    ]);
  });
});

describe('meeting ids', () => {
  it('falls back to frontmatter shadow_id, then a stable path id', () => {
    const root = vault();
    writeMeeting(root, { id: null, shadowId: 'frontmatter-id-1', title: 'With Shadow Id', date: '2026-10-01' });
    writeMeeting(root, { id: null, title: 'No Id At All', date: '2026-10-02' });
    const first = buildIndex(root).meetings.map((m) => m.id);
    expect(first[1]).toBe('frontmatter-id-1');
    expect(first[0]).toMatch(/^path-[0-9a-f]{24}$/u);
    expect(buildIndex(root).meetings.map((m) => m.id)).toEqual(first);
  });

  it('uses the path id when shadow_id is empty or whitespace', () => {
    const root = vault();
    const page = (title: string, shadowId: string) =>
      writeFile(root, `Meetings/${title}/${title}.md`, `---\ntype: meeting\ntitle: "${title}"\ndate: 2026-10-01\n${shadowId}\n---\n`);
    page('Quoted Empty', 'shadow_id: ""');
    page('Bare Empty', 'shadow_id:');
    page('Spaces', 'shadow_id: "   "');
    const ids = buildIndex(root).meetings.map((m) => m.id);
    expect(ids).toHaveLength(3);
    for (const id of ids) expect(id).toMatch(/^path-[0-9a-f]{24}$/u);
    expect(new Set(ids).size).toBe(3);
  });

  it('keeps one meeting when two pages share an id, preferring the non-copy', () => {
    const root = vault();
    const [planning] = standardMeetings();
    if (!planning) throw new Error('fixture missing');
    const folder = writeMeeting(root, planning);
    writeMeeting(root, { ...planning, folder, pageName: `${planning.title} (1)`, title: 'Copy title', transcript: undefined, notes: undefined, outline: undefined });
    writeMeeting(root, { ...planning, folder: `${folder} (1)`, title: 'Folder copy' });
    const index = buildIndex(root);
    expect(index.meetings).toHaveLength(1);
    expect(index.meetings[0]?.title).toBe('Quarterly Planning');
    expect(index.meetings[0]?.materials.map((m) => m.name)).toEqual(['Meeting Notes', 'Meeting Outline']);
  });
});

describe('what the scan reads', () => {
  it('does not treat a folder with only Transcript.md as a meeting', () => {
    const root = vault();
    writeFile(root, 'Meetings/2026/10/2026-10-03 Orphan/Transcript.md', transcriptFile(['[00:00] Speaker 1: Hello.']));
    expect(buildIndex(root).meetings).toEqual([]);
  });

  it('reads meeting pages at odd nesting', () => {
    const root = vault();
    writeMeeting(root, { id: 'odd-nesting-0000000000000000000001', title: 'Odd', date: '2026-10-04', folder: 'Meetings/2026 (1)/10 2/Odd' });
    writeMeeting(root, { id: 'odd-nesting-0000000000000000000002', title: 'Shallow', date: '2026-10-05', folder: 'Meetings' });
    expect(buildIndex(root).meetings.map((m) => m.title).sort()).toEqual(['Odd', 'Shallow']);
  });

  it('skips Unsynced Files, Archived Vaults and dot-folders', () => {
    const root = vault();
    const hidden = { title: 'Hidden', date: '2026-10-06' };
    writeMeeting(root, { ...hidden, id: 'hidden-1', folder: 'Unsynced Files/Meetings/2026/10/Hidden' });
    writeMeeting(root, { ...hidden, id: 'hidden-2', folder: 'Meetings/Unsynced Files/Hidden' });
    writeMeeting(root, { ...hidden, id: 'hidden-3', folder: 'Meetings/Archived Vaults/Hidden' });
    writeMeeting(root, { ...hidden, id: 'hidden-4', folder: 'Meetings/.shadow/Hidden' });
    writeMeeting(root, { ...hidden, id: 'hidden-5', folder: 'Meetings/2026/.trash/Hidden' });
    writeFile(root, 'People/.shadow/Ghost (ghost@example.com).md', '---\nname: "Ghost"\n---\n');
    const index = buildIndex(root);
    expect(index.meetings).toEqual([]);
    expect(index.people).toEqual([]);
  });

  it('does not follow a symlink that leaves the Vault', () => {
    const root = vault();
    const outside = vault();
    writeMeeting(outside, { id: 'outside-1', title: 'Outside', date: '2026-10-07', folder: 'Elsewhere' });
    mkdirSync(join(root, 'Meetings'), { recursive: true });
    symlinkSync(join(outside, 'Elsewhere'), join(root, 'Meetings', 'Linked'));
    symlinkSync(join(outside, 'Elsewhere', 'Outside.md'), join(root, 'Meetings', 'Linked page.md'));
    writeMeeting(root, { id: 'inside-1', title: 'Inside', date: '2026-10-08', folder: 'Meetings/Real' });
    symlinkSync(join(root, 'Meetings', 'Real'), join(root, 'Meetings', 'Alias'));
    const index = buildIndex(root);
    expect(index.meetings.map((m) => m.id)).toEqual(['inside-1']);
  });
});

describe('symbolic links inside the Vault', () => {
  it('ignores linked files and folders, even when they point inside the Vault', () => {
    const root = vault();
    const outside = vault();
    writeMeeting(outside, { id: 'outside-1', title: 'Outside', date: '2026-10-07', folder: 'Elsewhere' });
    writeMeeting(root, { id: 'unsynced-1', title: 'Unsynced', date: '2026-10-08', folder: 'Unsynced Files/Meetings/Unsynced' });
    writeMeeting(root, { id: 'real-1', title: 'Real', date: '2026-10-09', folder: 'Meetings/Real' });
    mkdirSync(join(root, 'Meetings', 'Links'), { recursive: true });
    symlinkSync(join(outside, 'Elsewhere', 'Outside.md'), join(root, 'Meetings', 'Links', 'Outside.md'));
    symlinkSync(join(root, 'Unsynced Files', 'Meetings', 'Unsynced', 'Unsynced.md'), join(root, 'Meetings', 'Links', 'Unsynced.md'));
    symlinkSync(join(root, 'Meetings', 'Real'), join(root, 'Meetings', 'Linked folder'));
    writeFile(root, 'People/Ann Lee (ann@example.com).md', '---\nname: "Ann Lee"\n---\n');
    symlinkSync(join(outside, 'Elsewhere', 'Outside.md'), join(root, 'People', 'Linked (linked@example.com).md'));
    const index = buildIndex(root);
    expect(index.meetings.map((m) => m.id)).toEqual(['real-1']);
    expect(index.meetings[0]?.pagePath).toBe('Meetings/Real/Real.md');
    expect(index.people.map((p) => p.email)).toEqual(['ann@example.com']);
  });

  it('ignores a linked Meetings folder and does not accept it as a Vault', () => {
    const real = vault();
    writeMeeting(real, { id: 'real-2', title: 'Real', date: '2026-10-09', folder: 'Meetings/Real' });
    const root = vault();
    symlinkSync(join(real, 'Meetings'), join(root, 'Meetings'));
    expect(buildIndex(root).meetings).toEqual([]);
    expect(isVaultFolder(root)).toBe(false);
  });

  it('does not accept a Vault whose only meeting page is a linked file', () => {
    const real = vault();
    writeMeeting(real, { id: 'real-3', title: 'Real', date: '2026-10-09', folder: 'Meetings/Real' });
    const root = vault();
    mkdirSync(join(root, 'Meetings', 'Real'), { recursive: true });
    symlinkSync(join(real, 'Meetings', 'Real', 'Real.md'), join(root, 'Meetings', 'Real', 'Real.md'));
    symlinkSync(join(real, 'Meetings', 'Real'), join(root, 'Meetings', 'Linked'));
    expect(isVaultFolder(root)).toBe(false);
  });

  it('works when the Vault root itself is a symlink to a real Vault', () => {
    const real = vault();
    writeStandardVault(real);
    const parent = vault();
    const link = join(parent, 'Vault link');
    symlinkSync(real, link);
    expect(resolveVault({ flag: link })).toBe(link);
    const index = buildIndex(link);
    expect(index.meetings).toHaveLength(4);
    expect(index.meetings.filter((m) => m.hasTranscript)).toHaveLength(3);
  });
});

describe('locating the Vault', () => {
  it('accepts a folder with SHADOW.md, or with meetings and no SHADOW.md', () => {
    const guided = vault();
    writeGuide(guided);
    expect(isVaultFolder(guided)).toBe(true);
    const bare = vault();
    writeMeeting(bare, standardMeetings()[0] ?? { id: 'x', title: 'x', date: '2026-10-01' });
    expect(isVaultFolder(bare)).toBe(true);
    expect(resolveVault({ flag: bare })).toBe(bare);
  });

  it('rejects an empty folder or one with a different SHADOW.md', () => {
    const empty = vault();
    expect(isVaultFolder(empty)).toBe(false);
    writeFile(empty, 'SHADOW.md', '---\ntype: something-else\n---\n');
    writeFile(empty, 'Meetings/notes.md', '# Not a meeting\n');
    expect(isVaultFolder(empty)).toBe(false);
    expect(resolveVault({ flag: empty })).toBeNull();
  });

  it('does not accept a SHADOW.md that is a symlink to a file outside the folder', () => {
    const outside = vault();
    writeGuide(outside);
    const root = vault();
    symlinkSync(join(outside, 'SHADOW.md'), join(root, 'SHADOW.md'));
    expect(isVaultFolder(root)).toBe(false);
  });

  it('prefers --vault over SHADOW_VAULT and does not fall back from an explicit path', () => {
    const a = vault();
    const b = vault();
    writeGuide(a);
    writeGuide(b);
    expect(resolveVault({ flag: a, env: b })).toBe(a);
    expect(resolveVault({ env: b })).toBe(b);
    expect(resolveVault({ flag: join(a, 'missing'), env: b })).toBeNull();
  });

  it('treats an empty, blank or placeholder explicit value as not given', () => {
    const home = vault();
    writeGuide(join(home, 'Documents', 'Shadow'));
    const found = join(home, 'Documents', 'Shadow');
    for (const value of ['', '   ', '${user_config.vault_path}', '  ${VAULT}  ']) {
      expect(resolveVault({ flag: value, home })).toBe(found);
      expect(resolveVault({ env: value, home })).toBe(found);
      expect(missingVaultMessage({ flag: value, env: value })).toBe(NO_VAULT_MESSAGE);
    }
    const other = vault();
    writeGuide(other);
    expect(resolveVault({ flag: '${user_config.vault_path}', env: other, home })).toBe(other);
  });

  it('names the explicit path that was tried when it is not a Vault', () => {
    const empty = vault();
    const missing = join(empty, 'missing');
    const message = missingVaultMessage({ flag: missing });
    expect(message).toBe(
      `"${missing}" is not a Shadow Vault folder. Open Shadow → Settings → Meeting → Vault location, copy that folder path and pass it with --vault (or set SHADOW_VAULT).`,
    );
    expect(missingVaultMessage({ env: empty })).toContain(`"${empty}" is not a Shadow Vault folder.`);
    expect(missingVaultMessage({ flag: '~/x' })).toContain(`"${join(homedir(), 'x')}"`);
    expect(missingVaultMessage({})).toBe(NO_VAULT_MESSAGE);
  });

  it('finds the default folders under a home folder, including numbered ones', () => {
    const home = vault();
    expect(resolveVault({ home })).toBeNull();
    writeGuide(join(home, 'Documents', 'Shadow 2'));
    expect(resolveVault({ home })).toBe(join(home, 'Documents', 'Shadow 2'));
    writeGuide(join(home, 'Library', 'Application Support', 'Shadow', 'User Data', 'Vault'));
    expect(resolveVault({ home })).toBe(join(home, 'Documents', 'Shadow 2'));
    expect(defaultVaultCandidates(home)).toContain(join(home, 'Library', 'Application Support', 'Shadow', 'User Data', 'Vault'));
  });

  it('expands ~', () => {
    expect(expandHome('~')).toBe(homedir());
    expect(expandHome('~/Shadow')).toBe(join(homedir(), 'Shadow'));
    expect(expandHome('/tmp/x')).toBe('/tmp/x');
  });
});

describe('index refresh', () => {
  it('rebuilds only when the index is older than 10 seconds', () => {
    const root = vault();
    writeStandardVault(root);
    let now = 1_000_000;
    const store = createVaultStore({ resolveRoot: () => root, now: () => now });
    expect(store.get()?.meetings).toHaveLength(4);
    writeMeeting(root, { id: 'new-meeting-1', title: 'New', date: '2026-10-20' });
    now += 9_000;
    expect(store.get()?.meetings).toHaveLength(4);
    now += 1_001;
    expect(store.get()?.meetings).toHaveLength(5);
  });

  it('returns null while no Vault is found', () => {
    expect(createVaultStore({ resolveRoot: () => null }).get()).toBeNull();
  });
});
