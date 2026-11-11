// Promises an adversarial review proved broken, kept as the acceptance suite:
// no reads through links swapped in after indexing, no meeting hidden by a
// page claiming its id, linear-time parsing of hostile text, big but
// plausible meetings, paging that returns everything, and input validation.

import { renameSync, rmSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isTableSeparator, parseFrontmatter, parsePersonFileName, parseReferenceId, parseTranscript } from '../src/markdown.js';
import { MAX_RESPONSE_CHARS } from '../src/paging.js';
import { listActionItemsInput, listMeetingsInput, searchMeetingsInput } from '../src/schemas.js';
import { findSections, isPlaceholderSection } from '../src/sections.js';
import { toolResult } from '../src/server.js';
import { findPerson, getMeeting, getTranscript, listActionItems, listMeetings, searchMeetingsTool } from '../src/tools.js';
import type { VaultIndex } from '../src/types.js';
import { buildIndex, createVaultStore } from '../src/vault.js';
import { removeDir, tempDir, transcriptFile, writeFile, writeGuide, writeMeeting } from './helpers/vault.js';

const ID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER_ID = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const dirs: string[] = [];
function vault(): string {
  const dir = tempDir();
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length > 0) removeDir(dirs.pop() ?? '');
});

function indexOf(root: string): VaultIndex {
  const index = createVaultStore({ resolveRoot: () => root }).get();
  if (!index) throw new Error('Vault not found');
  return index;
}

/** Milliseconds `run` takes. */
function elapsed(run: () => unknown): number {
  const start = performance.now();
  run();
  return performance.now() - start;
}

/** Every page of a tool result fits the cap; returns it unchanged. */
function fits<T>(value: T): T {
  expect(toolResult(value as Record<string, unknown>).content[0]).toBeDefined();
  expect(JSON.stringify(value).length).toBeLessThanOrEqual(MAX_RESPONSE_CHARS);
  return value;
}

describe('no reads through a link swapped in after indexing', () => {
  it('a Transcript.md replaced by a link is reported as no transcript', () => {
    const root = vault();
    const outside = vault();
    writeFileSync(join(outside, 'secret.txt'), '[00:00] Secret: PRIVATE KEY MATERIAL OUTSIDE THE VAULT\n');
    writeGuide(root);
    const folder = writeMeeting(root, { id: ID, title: 'Standup', date: '2026-11-10', transcript: ['[00:00] Speaker 1: hello'] });
    const index = indexOf(root);
    const path = join(root, folder, 'Transcript.md');
    rmSync(path);
    symlinkSync(join(outside, 'secret.txt'), path);
    expect(() => getTranscript(index, { id: ID })).toThrow(/has no transcript/u);
    expect(() => getTranscript(index, { id: ID })).not.toThrow(outside);
    expect(searchMeetingsTool(index, { query: 'private key' }).total_meetings_matched).toBe(0);
  });

  it('a meeting folder replaced by a link is reported as no transcript', () => {
    const root = vault();
    const outside = vault();
    writeFile(outside, 'elsewhere/Transcript.md', transcriptFile(['[00:00] Elsewhere: FILE FROM OUTSIDE THE VAULT']));
    writeGuide(root);
    const folder = writeMeeting(root, { id: ID, title: 'Standup', date: '2026-11-10', transcript: ['[00:00] Speaker 1: hello'] });
    const index = indexOf(root);
    renameSync(join(root, folder), join(root, `${folder}-moved`));
    symlinkSync(join(outside, 'elsewhere'), join(root, folder));
    expect(() => getTranscript(index, { id: ID })).toThrow(/has no transcript/u);
    expect(searchMeetingsTool(index, { query: 'outside' }).total_meetings_matched).toBe(0);
  });
});

describe('a page cannot take another meeting\'s id', () => {
  it('a planted page with the same Reference ID elsewhere in Meetings/ does not replace the real meeting', () => {
    const root = vault();
    writeGuide(root);
    writeMeeting(root, { id: ID, title: 'Board meeting', date: '2026-11-10', notes: 'Real board notes.' });
    writeMeeting(root, { id: ID, title: 'Planted', date: '2026-11-10', folder: 'Meetings/x', pageName: 'x', notes: 'Attacker text.' });
    const index = buildIndex(root);
    expect(index.meetings).toHaveLength(2);
    const meeting = getMeeting(index, { id: ID });
    expect(meeting.title).toBe('Board meeting');
    expect(meeting.materials[0]?.text).toBe('Real board notes.');
    const planted = index.meetings.find((m) => m.title === 'Planted');
    expect(planted?.id).toMatch(/^path-[0-9a-f]{24}$/u);
  });

  it('the same Reference ID in folders that do not share a parent folder gives two meetings', () => {
    const root = vault();
    writeMeeting(root, { id: ID, title: 'Weekly', date: '2026-11-03', folder: 'Meetings/2026/11/2026-11-03 Weekly' });
    writeMeeting(root, { id: ID, title: 'Weekly', date: '2026-11-03', folder: 'Meetings/Old/2026-11-03 Weekly' });
    const index = buildIndex(root);
    expect(index.meetings.map((m) => [m.pagePath, m.id])).toEqual([
      ['Meetings/2026/11/2026-11-03 Weekly/Weekly.md', ID],
      ['Meetings/Old/2026-11-03 Weekly/Weekly.md', expect.stringMatching(/^path-[0-9a-f]{24}$/u)],
    ]);
  });

  it('a rename that left the old folder beside the new one is one meeting, the newer page with its materials', () => {
    const root = vault();
    const old = writeMeeting(root, { id: ID, title: 'Weekly', date: '2026-11-03', notes: 'Old notes.', folder: 'Meetings/2026/11/2026-11-03 Weekly' });
    const renamed = writeMeeting(root, {
      id: ID,
      title: 'Weekly sync with design',
      date: '2026-11-03',
      notes: 'New notes.',
      outline: 'New outline.',
      folder: 'Meetings/2026/11/2026-11-03 Weekly sync with design',
    });
    utimesSync(join(root, old, 'Weekly.md'), new Date('2026-11-03T10:00:00Z'), new Date('2026-11-03T10:00:00Z'));
    utimesSync(join(root, renamed, 'Weekly sync with design.md'), new Date('2026-11-04T10:00:00Z'), new Date('2026-11-04T10:00:00Z'));
    const index = buildIndex(root);
    expect(index.meetings).toHaveLength(1);
    const meeting = getMeeting(index, { id: ID });
    expect(meeting.title).toBe('Weekly sync with design');
    expect(meeting.materials.map((m) => [m.name, m.text])).toEqual([
      ['Meeting Notes', 'New notes.'],
      ['Meeting Outline', 'New outline.'],
    ]);
  });
});

describe('hostile text is parsed in linear time', () => {
  const LIMIT_MS = 250;

  it('a heading line with 200,000 blanks', () => {
    const notes = `## Action Items\n\n- Send the deck\n\n# a${' '.repeat(200_000)}x\n`;
    let sections: string[] = [];
    expect(elapsed(() => (sections = findSections(notes, 'Action Items')))).toBeLessThan(LIMIT_MS);
    expect(sections).toEqual(['- Send the deck']);
    expect(findSections('## Action Items ##\n- a\n## Next #\n', 'Action Items')).toEqual(['- a']);
  });

  it('a 200,000-character callout line', () => {
    const page = `> [!note] Managed by Shadow\n> ${'(Shadow Reference ID: x'.repeat(8_700)}\n`;
    expect(page.length).toBeGreaterThan(200_000);
    let id: string | null = 'unset';
    expect(elapsed(() => (id = parseReferenceId(page)))).toBeLessThan(LIMIT_MS);
    expect(id).toBeNull();
    expect(parseReferenceId('> [!note] Managed by Shadow \n> a (Shadow Reference ID: x (Shadow Reference ID: abc) \n')).toBe('abc');
  });

  it('a transcript line with 200,000 blanks after the time', () => {
    const text = transcriptFile(['[00:00] Speaker 1: hi', `[00:01]${' '.repeat(200_000)}x`]);
    let lines: ReturnType<typeof parseTranscript> = [];
    expect(elapsed(() => (lines = parseTranscript(text)))).toBeLessThan(LIMIT_MS);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatchObject({ time: '00:00', speaker: 'Speaker 1' });
    const wordy = parseTranscript(`[00:02] [[${'['.repeat(200_000)}`);
    expect(wordy).toEqual([]);
  });

  it('the other patterns found in the audit', () => {
    const blanks = ' '.repeat(200_000);
    expect(elapsed(() => expect(isTableSeparator(`|-${blanks}x`)).toBe(false))).toBeLessThan(LIMIT_MS);
    expect(elapsed(() => expect(isTableSeparator(`${blanks}x`)).toBe(false))).toBeLessThan(LIMIT_MS);
    expect(elapsed(() => expect(parsePersonFileName(`${blanks}x`).email).toBeNull())).toBeLessThan(LIMIT_MS);
    expect(elapsed(() => expect(parsePersonFileName(`(${'a@'.repeat(100_000)}`).email).toBeNull())).toBeLessThan(LIMIT_MS);
    expect(elapsed(() => expect(isPlaceholderSection(`${'.'.repeat(200_000)}x`)).toBe(false))).toBeLessThan(LIMIT_MS);
    expect(elapsed(() => parseTranscript(`[00:00] ${'[['.repeat(100_000)}: x`))).toBeLessThan(LIMIT_MS);
  });

  it('ordinary formats still parse the same way', () => {
    expect(isTableSeparator('| :--- | ---: | :-: |')).toBe(true);
    expect(isTableSeparator('---|---')).toBe(true);
    expect(isTableSeparator('| a | b |')).toBe(false);
    expect(isTableSeparator('||')).toBe(false);
    expect(parsePersonFileName('People/Ann Lee (ann@example.com).md')).toEqual({ name: 'Ann Lee', email: 'ann@example.com' });
    expect(parsePersonFileName('Ann (not an email)')).toEqual({ name: 'Ann (not an email)', email: null });
    expect(isPlaceholderSection('No action items!!.')).toBe(true);
    expect(parseTranscript('[01:02] [[People/Ann|Ann]]: hi')[0]).toMatchObject({ speaker: 'Ann', words: 'hi' });
  });
});

describe('frontmatter', () => {
  it('reads values that contain U+2028 or U+2029', () => {
    const { data } = parseFrontmatter('---\ntype: meeting\ntitle: "One Two"\nother: a b\n---\n');
    expect(data.get('title')).toBe('One Two');
    expect(data.get('other')).toBe('a b');
  });
});

describe('big but plausible meetings', () => {
  const invitees = Array.from({ length: 1000 }, (_, i) => ({ name: `Employee Number ${i}`, email: `employee${i}@example.com` }));

  it('a meeting with 1,000 attendees answers every tool, and list_action_items pages past it', () => {
    const root = vault();
    writeGuide(root);
    writeMeeting(root, {
      id: ID,
      title: 'All hands',
      date: '2026-11-10',
      attendees: invitees,
      transcript: ['[00:00] Speaker 1: Welcome to the all hands.'],
      notes: '## Action Items\n\n- Ship it\n',
    });
    writeMeeting(root, { id: OTHER_ID, title: 'Older', date: '2026-11-01', notes: '## Action Items\n\n- Older item\n' });
    const index = buildIndex(root);

    const listed = fits(listMeetings(index, {}));
    expect(listed.meetings[0]).toMatchObject({ id: ID, attendee_count: 1000 });
    const rest = fits(listMeetings(index, { cursor: listed.next_cursor ?? '' }));
    expect(rest.meetings.map((m) => m.id)).toEqual([OTHER_ID]);
    expect(fits(searchMeetingsTool(index, { query: 'all hands' })).results[0]?.meeting.attendee_count).toBe(1000);
    const meeting = fits(getMeeting(index, { id: ID }));
    expect(meeting.attendee_count).toBe(1000);
    expect(meeting.attendees.length).toBeGreaterThan(0);
    expect(meeting.attendees.length).toBeLessThan(1000);
    expect(meeting.materials[0]).toMatchObject({ name: 'Meeting Notes', text: '## Action Items\n\n- Ship it\n', truncated: false });
    expect(fits(getTranscript(index, { id: ID })).text).toContain('Welcome');
    expect(fits(findPerson(index, { query: 'employee number 7' })).people.length).toBeGreaterThan(0);

    const sections: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = fits(listActionItems(index, { ...(cursor ? { cursor } : {}) }));
      for (const item of page.items) {
        expect(item.meeting.attendee_count).toBe(item.meeting.id === ID ? 1000 : 0);
        sections.push(item.section);
      }
      cursor = page.next_cursor;
      pages += 1;
    } while (cursor && pages < 10);
    expect(sections).toEqual(['- Ship it', '- Older item']);
  });

  it('get_meeting with four long-named, long materials stays under the cap and pages each one', () => {
    const root = vault();
    const name = (n: number) => `회의록 요약 ${n} `.padEnd(80, '가');
    const extra = Object.fromEntries([1, 2, 3, 4].map((n) => [name(n), `${n}`.repeat(30_000)]));
    writeMeeting(root, { id: ID, title: 'Weekly', date: '2026-11-10', extra });
    const index = buildIndex(root);
    const first = fits(getMeeting(index, { id: ID }));
    expect(first.materials).toHaveLength(4);
    for (const material of first.materials) {
      let text = material.text;
      let cursor = material.next_cursor;
      while (cursor) {
        const page = fits(getMeeting(index, { id: ID, cursor }));
        text += page.materials[0]?.text ?? '';
        cursor = page.materials[0]?.next_cursor;
      }
      expect(text).toBe(extra[material.name]);
    }
  });

  it('a get_meeting cursor fails cleanly when the material list changes', () => {
    const root = vault();
    const folder = writeMeeting(root, { id: ID, title: 'Weekly', date: '2026-11-10', extra: { Notes: 'n'.repeat(80_000) } });
    const cursor = getMeeting(buildIndex(root), { id: ID }).materials[0]?.next_cursor ?? '';
    expect(cursor).not.toBe('');
    writeFile(root, `${folder}/Agenda.md`, 'An agenda.');
    expect(() => getMeeting(buildIndex(root), { id: ID, cursor })).toThrow(/belongs to another meeting or material/u);
  });
});

describe('paging returns everything', () => {
  it('a transcript turn longer than one page comes back whole across cursors', () => {
    const root = vault();
    const longTurn = `[00:00] Speaker 1: ${'word "quoted" \\ '.repeat(6_000)}END-OF-TURN`;
    const lines = ['[00:00] Speaker 2: before', longTurn, '[45:00] Speaker 2: question'];
    writeMeeting(root, { id: ID, title: 'Lecture', date: '2026-11-10', transcript: lines });
    const index = buildIndex(root);
    let text = '';
    let previousLast: number | null = null;
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = fits(getTranscript(index, { id: ID, ...(cursor ? { cursor } : {}) }));
      // A page that starts inside the line the previous page ended in continues it.
      text += previousLast === null ? page.text : page.first_line === previousLast ? page.text : `\n${page.text}`;
      previousLast = page.last_line;
      cursor = page.next_cursor;
      pages += 1;
    } while (cursor && pages < 20);
    expect(pages).toBeGreaterThan(2);
    expect(text.split('\n')).toEqual(lines);
  });
});

describe('ordinary Vaults', () => {
  it('a meeting page named Transcript.md is listed', () => {
    const root = vault();
    writeMeeting(root, { id: ID, title: 'Transcript', date: '2026-11-10', notes: 'Notes.' });
    const index = buildIndex(root);
    expect(index.meetings.map((m) => [m.title, m.hasTranscript, m.materials.map((x) => x.name)])).toEqual([['Transcript', false, ['Meeting Notes']]]);
  });

  it('impossible dates are a validation error', () => {
    for (const schema of [listMeetingsInput, listActionItemsInput]) {
      expect(schema.safeParse({ from: '2026-13-45' }).success).toBe(false);
      expect(schema.safeParse({ to: '2026-02-30' }).success).toBe(false);
      expect(schema.safeParse({ from: '2024-02-29', to: '2026-12-31' }).success).toBe(true);
    }
    expect(searchMeetingsInput.safeParse({ query: 'x', from: '2025-02-29' }).success).toBe(false);
  });

  it('notes in another language: headings_seen names their headings and the right heading finds the section', () => {
    const root = vault();
    writeMeeting(root, { id: ID, title: '주간 회의', date: '2026-11-10', notes: '## 회의 개요\n\n예산 검토.\n\n## 액션 아이템\n\n- 예산안 보내기\n' });
    writeMeeting(root, { id: OTHER_ID, title: 'Weekly', date: '2026-11-03', notes: '## Summary\n\nBudget.\n' });
    const index = buildIndex(root);
    const first = fits(listActionItems(index, {}));
    expect(first.items).toEqual([]);
    expect(first.meetings_with_notes_but_no_section).toBe(2);
    expect(first.headings_seen).toEqual(expect.arrayContaining(['액션 아이템', '회의 개요', 'Summary']));
    const again = fits(listActionItems(index, { heading: '액션 아이템' }));
    expect(again.items.map((item) => [item.meeting.id, item.section])).toEqual([[ID, '- 예산안 보내기']]);
    expect(again.meetings_with_notes_but_no_section).toBe(1);
  });

  it('English notes with the section return no headings_seen', () => {
    const root = vault();
    writeMeeting(root, { id: ID, title: 'Weekly', date: '2026-11-10', notes: '## Summary\n\nx\n\n## Action Items\n\n- Send it\n' });
    writeMeeting(root, { id: OTHER_ID, title: 'Daily', date: '2026-11-09', notes: '## Action Items\n\nNone.\n' });
    const result = fits(listActionItems(buildIndex(root), {}));
    expect(result.items.map((item) => item.section)).toEqual(['- Send it']);
    expect(result.meetings_with_notes_but_no_section).toBe(0);
    expect(result.headings_seen).toBeUndefined();
  });

  it('headings_seen holds at most 15 headings of at most 80 characters, most frequent first', () => {
    const root = vault();
    const headings = Array.from({ length: 20 }, (_, i) => `## ${String(i).padStart(2, '0')} ${'긴'.repeat(100)}`).join('\n\nx\n\n');
    writeMeeting(root, { id: ID, title: 'A', date: '2026-11-10', notes: `## Common\n\n${headings}\n` });
    writeMeeting(root, { id: OTHER_ID, title: 'B', date: '2026-11-09', notes: '## Common\n\ny\n' });
    const seen = fits(listActionItems(buildIndex(root), {})).headings_seen ?? [];
    expect(seen).toHaveLength(15);
    expect(seen[0]).toBe('Common');
    for (const heading of seen) expect([...heading].length).toBeLessThanOrEqual(80);
  });
});

describe('files over the size limits: 4 MB for a transcript, 2 MB for any other file', () => {
  it('are never read: a clean transcript error, and a material listed with its size', () => {
    const root = vault();
    const folder = writeMeeting(root, {
      id: ID,
      title: 'Huge',
      date: '2026-11-10',
      transcript: ['[00:00] Speaker 1: The start of a very long recording.'],
      extra: { Dump: '# Dump\n' },
    });
    const size = 2 * 1024 * 1024 + 1;
    truncateSync(join(root, folder, 'Transcript.md'), 4 * 1024 * 1024 + 1);
    truncateSync(join(root, folder, 'Dump.md'), size);
    writeMeeting(root, { id: OTHER_ID, title: 'Big page', date: '2026-11-09', folder: 'Meetings/Big page' });
    truncateSync(join(root, 'Meetings/Big page/Big page.md'), size);
    writeFile(root, 'People/Big (big@example.com).md', '---\nname: "Big"\n---\n');
    truncateSync(join(root, 'People/Big (big@example.com).md'), size);
    const index = buildIndex(root);
    expect(index.meetings.map((m) => m.title)).toEqual(['Huge']);
    expect(index.meetings[0]?.hasTranscript).toBe(true);
    expect(() => getTranscript(index, { id: ID })).toThrow(/too large to read \(over 4 MB\)/u);
    expect(fits(getMeeting(index, { id: ID })).materials).toEqual([{ name: 'Dump', chars: 0, bytes: size, text: '', truncated: true }]);
    expect(fits(getMeeting(index, { id: ID, material: 'Dump' })).materials).toEqual([{ name: 'Dump', chars: 0, bytes: size, text: '', truncated: true }]);
    expect(fits(searchMeetingsTool(index, { query: 'huge' })).total_meetings_matched).toBe(1);
    expect(fits(listActionItems(index, {})).meetings_scanned).toBe(1);
  });
});

describe('a transcript\'s first 4,096 bytes', () => {
  it('has_transcript is true when the first turn starts after the head', () => {
    const root = vault();
    const folder = writeMeeting(root, { id: ID, title: 'Late start', date: '2026-11-10', transcript: ['[00:00] Speaker 1: placeholder'] });
    writeFile(root, `${folder}/Transcript.md`, `# Transcript\n\n${'> preamble line\n'.repeat(400)}\n[00:05] Speaker 1: Finally, the first turn.\n`);
    const index = buildIndex(root);
    expect(index.meetings[0]?.hasTranscript).toBe(true);
    expect(listMeetings(index, {}).meetings[0]?.has_transcript).toBe(true);
    expect(getTranscript(index, { id: ID }).text).toBe('[00:05] Speaker 1: Finally, the first turn.');
  });

  it('a meeting page named Transcript.md with frontmatter longer than the head is listed', () => {
    const root = vault();
    writeFile(root, 'Meetings/2026/11/2026-11-10 Transcript/Transcript.md', `---\nnotes: "${'x'.repeat(5000)}"\ntype: meeting\ntitle: Transcript\ndate: 2026-11-10\n---\n\nBody.\n`);
    writeFile(root, 'Meetings/2026/11/2026-11-10 Transcript/Meeting Notes.md', 'Notes.');
    const index = buildIndex(root);
    expect(index.meetings.map((m) => [m.title, m.hasTranscript, m.materials.map((x) => x.name)])).toEqual([['Transcript', false, ['Meeting Notes']]]);
  });
});

describe('a conflict copy cannot hide a meeting', () => {
  it('three pages with one id under three different parents, one copy-named, are three meetings', () => {
    const root = vault();
    writeMeeting(root, { id: ID, title: 'X', date: '2025-03-01', folder: 'Meetings/2025/03/2025-03-01 X' });
    writeMeeting(root, { id: ID, title: 'Y', date: '2026-09-01', folder: 'Meetings/2026/09/2026-09-01 Y' });
    writeMeeting(root, { id: ID, title: 'Z', date: '2024-01-01', folder: 'Meetings/2024/01/2024-01-01 Z (1)' });
    const index = buildIndex(root);
    expect(index.meetings.map((m) => m.title).sort()).toEqual(['X', 'Y', 'Z']);
    expect(new Set(index.meetings.map((m) => m.id)).size).toBe(3);
  });
});

describe('very long labels are bounded when the index is built', () => {
  it('a 300,000-character title, attendee name and speaker cell: every tool answers and paging reaches every meeting', () => {
    const root = vault();
    const huge = 'L'.repeat(300_000);
    const ids = Array.from({ length: 12 }, (_, i) => `${String(i).padStart(2, '0')}${'c'.repeat(30)}`);
    ids.forEach((id, i) => {
      const day = `2026-10-${String(i + 1).padStart(2, '0')}`;
      writeMeeting(root, {
        id,
        title: i === 3 ? huge : `Meeting ${i}`,
        folder: `Meetings/2026/10/${day} Meeting ${i}`,
        pageName: `Meeting ${i}`,
        date: day,
        attendees: i === 5 ? [{ name: huge, email: null }] : [{ name: 'Ann Lee', email: 'ann@example.com' }],
        speakers: i === 7 ? [{ speaker: huge, person: { name: huge, email: null } }] : [],
        transcript: ['[00:00] Speaker 1: hello'],
        notes: `## Action Items\n\n- Task ${i}\n`,
      });
    });
    const index = buildIndex(root);
    const long = index.meetings.find((m) => m.id === ids[3]);
    expect(long?.title.length).toBe(300);
    expect(long?.title.endsWith('…')).toBe(true);
    expect(index.meetings.find((m) => m.id === ids[5])?.attendees[0]?.name.length).toBe(200);
    expect(index.meetings.find((m) => m.id === ids[7])?.speakers[0]).toMatchObject({ speaker: expect.stringMatching(/^L{199}…$/u), person: expect.stringMatching(/^L{199}…$/u) });

    for (const id of ids) {
      fits(getMeeting(index, { id }));
      fits(getTranscript(index, { id }));
    }
    fits(searchMeetingsTool(index, { query: 'hello', limit: 50 }));
    fits(findPerson(index, { query: 'l' }));

    const listed: string[] = [];
    let cursor: string | undefined;
    do {
      const page = fits(listMeetings(index, { limit: 3, ...(cursor ? { cursor } : {}) }));
      listed.push(...page.meetings.map((m) => m.id));
      cursor = page.next_cursor;
    } while (cursor && listed.length < 100);
    expect(listed.sort()).toEqual([...ids].sort());

    const items: string[] = [];
    let itemCursor: string | undefined;
    do {
      const page = fits(listActionItems(index, { limit: 2, ...(itemCursor ? { cursor: itemCursor } : {}) }));
      items.push(...page.items.map((item) => item.meeting.id));
      itemCursor = page.next_cursor;
    } while (itemCursor && items.length < 100);
    expect(items.sort()).toEqual([...ids].sort());
  });
});

describe('a table row of 300,000 pipes', () => {
  it('list_action_items answers without overflowing the stack', () => {
    const root = vault();
    writeMeeting(root, { id: ID, title: 'Pipes', date: '2026-11-10', notes: `## Action Items\n\n| Task | Owner |\n|---|---|\n${'|'.repeat(300_000)} Send it |\n` });
    const result = fits(listActionItems(buildIndex(root), {}));
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.section).toContain('…[section cut]');
    expect(isPlaceholderSection(`| a |\n|---|\n${'|'.repeat(300_000)}`)).toBe(true);
  });
});
