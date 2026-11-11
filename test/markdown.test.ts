import { describe, expect, it } from 'vitest';
import {
  parseAttendees,
  parseFrontmatter,
  parseReferenceId,
  parseShadowTimestamp,
  parseSpeakerAssignments,
  parseTimecode,
  parseTranscript,
  splitTableRow,
  tableUnderHeading,
} from '../src/markdown.js';
import { callout, meetingPage, transcriptFile, ANN, CHLOE } from './helpers/vault.js';

describe('frontmatter', () => {
  it('reads quoted, single-quoted, bare and null values', () => {
    const { data, body } = parseFrontmatter(
      '---\ntype: meeting\ntitle: "Plan: \\"Q4\\" review"\nother: \'It\'\'s fine\'\ndate: 2026-10-14\nendedAt: null\nempty:\n---\n\nBody',
    );
    expect(data.get('type')).toBe('meeting');
    expect(data.get('title')).toBe('Plan: "Q4" review');
    expect(data.get('other')).toBe("It's fine");
    expect(data.get('date')).toBe('2026-10-14');
    expect(data.get('endedAt')).toBeNull();
    expect(data.get('empty')).toBeNull();
    expect(body).toBe('\nBody');
  });

  it('handles CRLF and a missing block', () => {
    expect(parseFrontmatter('---\r\ntype: meeting\r\n---\r\n').data.get('type')).toBe('meeting');
    expect(parseFrontmatter('# No frontmatter').data.size).toBe(0);
  });
});

describe('tables', () => {
  it('splits on unescaped pipes only', () => {
    expect(splitTableRow('| [[People/Ann Lee (ann@example.com)\\|Ann Lee]] | ann@example.com |')).toEqual([
      '[[People/Ann Lee (ann@example.com)|Ann Lee]]',
      'ann@example.com',
    ]);
    expect(splitTableRow('| a<br>b | |')).toEqual(['a\nb', '']);
  });

  it('reads attendees with escaped pipes, people without email, and empty tables', () => {
    const page = meetingPage({ id: 'x', title: 'T', date: '2026-10-14', attendees: [ANN, CHLOE] }, 'Meetings/2026/10/2026-10-14 T');
    expect(parseAttendees(page)).toEqual([
      { name: 'Ann Lee', email: 'ann@example.com' },
      { name: 'Chloe Park', email: null },
    ]);
    const empty = meetingPage({ id: 'x', title: 'T', date: '2026-10-14' }, 'Meetings/x');
    expect(parseAttendees(empty)).toEqual([]);
    expect(parseSpeakerAssignments(empty)).toEqual([]);
    expect(tableUnderHeading('## Attendees\n\nno table here\n', 'Attendees')).toEqual([]);
  });

  it('reads speaker assignments, assigned and unassigned', () => {
    const page = meetingPage(
      { id: 'x', title: 'T', date: '2026-10-14', speakers: [{ speaker: 'Speaker 1', person: ANN }, { speaker: 'Unknown' }] },
      'Meetings/x',
    );
    expect(parseSpeakerAssignments(page)).toEqual([
      { speaker: 'Speaker 1', person: 'Ann Lee', email: 'ann@example.com' },
      { speaker: 'Unknown', person: null, email: null },
    ]);
  });
});

describe('Reference ID', () => {
  it('reads the id from the Managed by Shadow callout', () => {
    expect(parseReferenceId(`---\ntype: meeting\n---\n\n${callout('8f00aa11bb22cc33dd44ee55ff667788')}\n`)).toBe(
      '8f00aa11bb22cc33dd44ee55ff667788',
    );
  });

  it('accepts a different callout body and the older bold footer', () => {
    expect(parseReferenceId('> [!note] Managed by Shadow\n> Any wording here. (Shadow Reference ID: abc123)\n')).toBe('abc123');
    expect(parseReferenceId('**Shadow Reference ID:** `legacy-1`\n')).toBe('legacy-1');
  });

  it('returns null without an id or outside the callout', () => {
    expect(parseReferenceId(callout(null))).toBeNull();
    expect(parseReferenceId('Someone typed (Shadow Reference ID: fake) in a note.')).toBeNull();
  });
});

describe('timestamps', () => {
  it('parses UTC, GMT offsets and bare ISO', () => {
    expect(parseShadowTimestamp('2026-10-15 15:36:01 UTC')?.toISOString()).toBe('2026-10-15T15:36:01.000Z');
    expect(parseShadowTimestamp('2026-10-16 10:00 GMT+09:00')?.toISOString()).toBe('2026-10-16T01:00:00.000Z');
    expect(parseShadowTimestamp('2026-10-16 10:00 GMT-0430')?.toISOString()).toBe('2026-10-16T14:30:00.000Z');
    expect(parseShadowTimestamp('2026-10-16T01:02:03Z')?.toISOString()).toBe('2026-10-16T01:02:03.000Z');
  });

  it('returns null for null, empty, date-only and junk', () => {
    expect(parseShadowTimestamp(null)).toBeNull();
    expect(parseShadowTimestamp('')).toBeNull();
    expect(parseShadowTimestamp('2026-10-16')).toBeNull();
    expect(parseShadowTimestamp('not a time')).toBeNull();
  });

  it('reads timecodes with and without hours', () => {
    expect(parseTimecode('00:00')).toBe(0);
    expect(parseTimecode('59:59')).toBe(3599);
    expect(parseTimecode('1:05:03')).toBe(3903);
    expect(parseTimecode('12:5')).toBeNull();
    expect(parseTimecode('1:60:00')).toBeNull();
  });
});

describe('transcript lines', () => {
  it('drops the heading and callout and parses turns past one hour', () => {
    const lines = parseTranscript(
      transcriptFile([
        '[00:00] [[People/Ann Lee (ann@example.com)|Ann Lee]]: Hello: welcome.',
        '[59:59] Speaker 2: Almost an hour.',
        '[1:00:00] Speaker 2: One hour.',
        '[10:02:03] Unknown: Ten hours.',
      ]),
    );
    expect(lines.map((line) => [line.time, line.seconds, line.speaker, line.words])).toEqual([
      ['00:00', 0, 'Ann Lee', 'Hello: welcome.'],
      ['59:59', 3599, 'Speaker 2', 'Almost an hour.'],
      ['1:00:00', 3600, 'Speaker 2', 'One hour.'],
      ['10:02:03', 36123, 'Unknown', 'Ten hours.'],
    ]);
    expect(lines[0]?.raw).toBe('[00:00] [[People/Ann Lee (ann@example.com)|Ann Lee]]: Hello: welcome.');
  });

  it('keeps a stray line with the turn before it, and an empty transcript has no lines', () => {
    const lines = parseTranscript(transcriptFile(['[00:05] Speaker 1: First.', 'continued text']));
    expect(lines[1]).toMatchObject({ time: '00:05', speaker: 'Speaker 1', words: 'continued text' });
    expect(parseTranscript(transcriptFile([]))).toEqual([]);
  });
});
