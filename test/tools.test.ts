import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_RESPONSE_CHARS } from '../src/paging.js';
import {
  findPersonOutput,
  getMeetingOutput,
  getTranscriptOutput,
  listActionItemsOutput,
  listMeetingsOutput,
  searchMeetingsOutput,
} from '../src/schemas.js';
import { toolResult } from '../src/server.js';
import { findPerson, getMeeting, getTranscript, listActionItems, listMeetings, searchMeetingsTool } from '../src/tools.js';
import type { VaultIndex } from '../src/types.js';
import { buildIndex } from '../src/vault.js';
import { ANN, BEN, IDS, meetingNotes, removeDir, tempDir, writeMeeting, writeStandardVault } from './helpers/vault.js';

const LONG_ID = '9999aaaabbbbccccddddeeeeffff0000';
const BIG_NOTES_ID = '8888aaaabbbbccccddddeeeeffff0000';
let root: string;
let index: VaultIndex;

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function timecode(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

const longLines = Array.from(
  { length: 3000 },
  (_, i) => `[${timecode(i * 3)}] Speaker ${(i % 3) + 1}: Line ${i} says "quoted" things \\ with a backslash and ünïcode ${'words '.repeat(12)}`,
);

/** Every result must fit the cap and match its schema. */
function checked<T>(schema: { parse: (value: unknown) => T }, value: T): T {
  expect(toolResult(value as Record<string, unknown>).content[0]).toBeDefined();
  expect(JSON.stringify(value).length).toBeLessThanOrEqual(MAX_RESPONSE_CHARS);
  return schema.parse(value);
}

beforeAll(() => {
  root = tempDir();
  writeStandardVault(root);
  writeMeeting(root, {
    id: LONG_ID,
    title: 'All Hands Marathon',
    date: '2026-09-20',
    startedAt: '2026-09-20 08:00:00 UTC',
    endedAt: '2026-09-20 10:30:00 UTC',
    attendees: [ANN, BEN],
    transcript: longLines,
  });
  writeMeeting(root, {
    id: BIG_NOTES_ID,
    title: 'Big Notes',
    date: '2026-09-19',
    notes: meetingNotes({ overview: 'Long notes. '.repeat(5000), actionRows: [['Archive the notes', 'Ann Lee', 'Soon']] }),
    outline: '### Short outline\n- one point\n',
    extra: { 'Follow Up Email': `Hi all,\n${'Thanks for the meeting. '.repeat(3000)}\n` },
  });
  for (let i = 0; i < 30; i += 1) {
    writeMeeting(root, {
      id: `bulk-${pad(i)}-000000000000000000000000`,
      title: `Standup ${pad(i)}`,
      date: `2026-08-${pad(i + 1)}`,
      attendees: [BEN],
      notes: meetingNotes({ overview: 'Daily standup.', actionRows: i % 2 === 0 ? [[`Task ${i}`, 'Ben Ortiz', 'Tomorrow']] : [] }),
    });
  }
  index = buildIndex(root);
});
afterAll(() => removeDir(root));

describe('list_meetings', () => {
  it('lists newest first with summaries', () => {
    const result = checked(listMeetingsOutput, listMeetings(index, {}));
    expect(result.total).toBe(36);
    expect(result.meetings[0]).toEqual({
      id: IDS.customer,
      title: 'Customer Call | Acme',
      date: '2026-10-16',
      started_at: '2026-10-16T01:00:00.000Z',
      ended_at: '2026-10-16T01:30:00.000Z',
      duration_minutes: 30,
      attendee_count: 1,
      attendees: [{ name: 'Dev Rao', email: 'dev.rao@example.com' }],
      materials: [],
      has_transcript: true,
    });
    expect(result.next_cursor).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(root);
    expect(JSON.stringify(result)).not.toContain('Meetings/');
  });

  it('filters by inclusive dates and person', () => {
    expect(listMeetings(index, { from: '2026-10-14', to: '2026-10-15' }).meetings.map((m) => m.id)).toEqual([IDS.design, IDS.planning]);
    expect(listMeetings(index, { person: 'ANN@EXAMPLE.COM' }).meetings.map((m) => m.id)).toEqual([IDS.design, IDS.planning, LONG_ID]);
    expect(listMeetings(index, { person: 'chloe' }).meetings.map((m) => m.id)).toEqual([IDS.design]);
    expect(listMeetings(index, { person: 'nobody' }).total).toBe(0);
  });

  it('pages with a cursor', () => {
    const first = checked(listMeetingsOutput, listMeetings(index, { limit: 10 }));
    expect(first.meetings).toHaveLength(10);
    const seen = [...first.meetings];
    let cursor = first.next_cursor;
    while (cursor) {
      const page = checked(listMeetingsOutput, listMeetings(index, { limit: 10, cursor }));
      seen.push(...page.meetings);
      cursor = page.next_cursor;
    }
    expect(seen.map((m) => m.id)).toEqual(index.meetings.map((m) => m.id));
    expect(() => listMeetings(index, { cursor: 'garbage' })).toThrow(/cursor is not valid/u);
  });
});

describe('search_meetings', () => {
  it('returns summaries with matches and respects limit', () => {
    const result = checked(searchMeetingsOutput, searchMeetingsTool(index, { query: 'budget' }));
    expect(result.total_meetings_matched).toBe(2);
    expect(result.results[0]?.meeting.id).toBe(IDS.planning);
    expect(result.truncated).toBe(false);
    const limited = checked(searchMeetingsOutput, searchMeetingsTool(index, { query: 'standup', limit: 5 }));
    expect(limited.results).toHaveLength(5);
    expect(limited.total_meetings_matched).toBe(30);
    expect(limited.truncated).toBe(true);
  });

  it('applies date, person and scope filters', () => {
    expect(searchMeetingsTool(index, { query: 'budget', person: 'chloe' }).results.map((r) => r.meeting.id)).toEqual([IDS.design]);
    expect(searchMeetingsTool(index, { query: 'budget', to: '2026-10-14' }).results.map((r) => r.meeting.id)).toEqual([IDS.planning]);
    expect(searchMeetingsTool(index, { query: 'budget', scope: ['titles'] }).total_meetings_matched).toBe(0);
  });

  it('stays under the cap when many meetings match', () => {
    const result = checked(searchMeetingsOutput, searchMeetingsTool(index, { query: 'line', limit: 50 }));
    expect(result.results.length).toBeGreaterThan(0);
  });
});

describe('get_meeting', () => {
  it('returns details, speakers and materials but not the transcript', () => {
    const result = checked(getMeetingOutput, getMeeting(index, { id: IDS.planning }));
    expect(result.speakers).toHaveLength(3);
    expect(result.materials.map((m) => [m.name, m.truncated])).toEqual([
      ['Meeting Notes', false],
      ['Meeting Outline', false],
    ]);
    expect(result.materials[0]?.text).toContain('## Action Items');
    expect(result.materials[0]?.chars).toBe(result.materials[0]?.text.length);
  });

  it('gives each material a fair share and pages one material to its end', () => {
    const result = checked(getMeetingOutput, getMeeting(index, { id: BIG_NOTES_ID }));
    const byName = new Map(result.materials.map((m) => [m.name, m]));
    expect(byName.get('Meeting Outline')?.truncated).toBe(false);
    expect(byName.get('Meeting Notes')?.truncated).toBe(true);
    expect(byName.get('Follow Up Email')?.truncated).toBe(true);
    const notes = byName.get('Meeting Notes');
    const email = byName.get('Follow Up Email');
    expect(Math.abs((notes?.text.length ?? 0) - (email?.text.length ?? 0))).toBeLessThan(4000);

    let text = notes?.text ?? '';
    let cursor = notes?.next_cursor;
    while (cursor) {
      const page = checked(getMeetingOutput, getMeeting(index, { id: BIG_NOTES_ID, cursor }));
      expect(page.materials).toHaveLength(1);
      text += page.materials[0]?.text ?? '';
      cursor = page.materials[0]?.next_cursor;
    }
    const full = checked(getMeetingOutput, getMeeting(index, { id: BIG_NOTES_ID, material: 'Meeting Notes' }));
    expect(text.length).toBe(notes?.chars);
    expect(full.materials[0]?.text).toBe(text.slice(0, full.materials[0]?.text.length));
  });

  it('explains unknown ids and materials', () => {
    expect(() => getMeeting(index, { id: 'nope' })).toThrow(/list_meetings or search_meetings/u);
    expect(() => getMeeting(index, { id: IDS.planning, material: 'Transcript' })).toThrow(/get_transcript/u);
    expect(() => getMeeting(index, { id: IDS.planning, material: 'Nope' })).toThrow(/"Meeting Notes", "Meeting Outline"/u);
  });
});

describe('get_transcript', () => {
  it('returns the lines as written without the heading or callout', () => {
    const result = checked(getTranscriptOutput, getTranscript(index, { id: IDS.planning }));
    expect(result.total_lines).toBe(4);
    expect(result.first_line).toBe(1);
    expect(result.last_line).toBe(4);
    expect(result.text.split('\n')[0]).toBe('[00:00] [[People/Ann Lee (ann@example.com)|Ann Lee]]: Welcome everyone, let us review the budget for next quarter.');
    expect(result.text).not.toContain('Managed by Shadow');
    expect(result.next_cursor).toBeUndefined();
  });

  it('filters by a time range past one hour', () => {
    const result = getTranscript(index, { id: IDS.design, from_time: '45:00', to_time: '1:10:00' });
    expect(result.text.split('\n')).toEqual(['[45:10] Speaker 2: The budget slide is confusing.', '[1:05:03] Speaker 1: Final point on the color palette for onboarding.']);
    expect([result.first_line, result.last_line]).toEqual([2, 3]);
    const none = getTranscript(index, { id: IDS.design, from_time: '2:00:00' });
    expect([none.text, none.first_line, none.last_line]).toEqual(['', null, null]);
  });

  it('pages on line boundaries under the cap and covers every line once', () => {
    const pages = [];
    let cursor: string | undefined;
    do {
      const page = checked(getTranscriptOutput, getTranscript(index, { id: LONG_ID, ...(cursor ? { cursor } : {}) }));
      pages.push(page);
      cursor = page.next_cursor;
    } while (cursor);
    expect(pages.length).toBeGreaterThan(5);
    const lines = pages.flatMap((page) => page.text.split('\n'));
    expect(lines).toEqual(longLines);
    for (let i = 1; i < pages.length; i += 1) expect(pages[i]?.first_line).toBe((pages[i - 1]?.last_line ?? 0) + 1);
  });

  it('keeps the time range across pages', () => {
    const lines: string[] = [];
    let cursor: string | undefined;
    do {
      const page = getTranscript(index, { id: LONG_ID, from_time: '10:00', to_time: '1:40:00', ...(cursor ? { cursor } : {}) });
      lines.push(...page.text.split('\n'));
      cursor = page.next_cursor;
    } while (cursor);
    expect(lines[0]?.startsWith('[10:00]')).toBe(true);
    expect(lines[lines.length - 1]?.startsWith('[1:40:00]')).toBe(true);
    expect(lines).toHaveLength((6000 - 600) / 3 + 1);
  });

  it('errors for a meeting without a transcript', () => {
    expect(() => getTranscript(index, { id: IDS.hiring })).toThrow(/has no transcript/u);
  });
});

describe('list_action_items', () => {
  it('returns real sections, skips placeholders and counts meetings without notes', () => {
    const result = checked(listActionItemsOutput, listActionItems(index, { from: '2026-10-01' }));
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ meeting: { id: IDS.planning, title: 'Quarterly Planning', date: '2026-10-14' }, source: 'Meeting Notes' });
    expect(result.items[0]?.section).toContain('| Send the revised budget | Ben Ortiz | Friday |');
    expect(result.meetings_scanned).toBe(4);
    expect(result.meetings_without_notes).toBe(1);
    expect(result.next_cursor).toBeUndefined();
  });

  it('pages by item with a cursor', () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    let scanned = 0;
    do {
      const page = checked(listActionItemsOutput, listActionItems(index, { person: 'ben', limit: 4, ...(cursor ? { cursor } : {}) }));
      expect(page.items.length).toBeLessThanOrEqual(4);
      seen.push(...page.items.map((item) => item.meeting.id));
      scanned += page.meetings_scanned;
      cursor = page.next_cursor;
    } while (cursor);
    expect(seen).toEqual([IDS.planning, ...Array.from({ length: 15 }, (_, k) => `bulk-${pad(28 - 2 * k)}-000000000000000000000000`)]);
    expect(scanned).toBe(listMeetings(index, { person: 'ben' }).total);
  });

  it('supports a custom heading', () => {
    const result = listActionItems(index, { heading: 'Decisions' });
    expect(result.items.map((item) => [item.meeting.id, item.section])).toEqual([[IDS.planning, '- The roadmap is settled.']]);
    expect(listActionItems(index, { heading: 'Summary' }).items.map((item) => item.meeting.id)).toEqual([IDS.hiring]);
  });
});

describe('find_person', () => {
  it('finds by name or email substring with meeting history', () => {
    const result = checked(findPersonOutput, findPerson(index, { query: 'ann' }));
    expect(result.people[0]).toMatchObject({ name: 'Ann Lee', email: 'ann@example.com', meeting_count: 3, last_meeting_date: '2026-10-15' });
    expect(result.people[0]?.meetings.map((m) => m.id)).toEqual([IDS.design, IDS.planning, LONG_ID]);
    expect(findPerson(index, { query: 'example.com' }).people.map((p) => p.name)).toContain('Eve Stone');
    expect(findPerson(index, { query: 'eve' }).people[0]).toMatchObject({ meeting_count: 0, last_meeting_date: null, meetings: [] });
    expect(findPerson(index, { query: 'chloe' }).people[0]).toMatchObject({ name: 'Chloe Park', email: null, meeting_count: 1 });
  });

  it('lists at most the newest 20 meetings and honours limit', () => {
    const [ben] = findPerson(index, { query: 'ben@example.com' }).people;
    expect(ben?.meeting_count).toBe(33);
    expect(ben?.meetings).toHaveLength(20);
    expect(findPerson(index, { query: 'e', limit: 2 }).people).toHaveLength(2);
  });
});
