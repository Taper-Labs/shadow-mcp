// Writes synthetic Vaults in the format the Shadow app writes. All people
// and meetings here are invented.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export interface SyntheticPerson {
  name: string;
  email: string | null;
}

export interface SyntheticSpeaker {
  speaker: string;
  person?: SyntheticPerson;
}

export interface SyntheticMeeting {
  /** Shadow Reference ID in the callout; null writes the callout without one. */
  id: string | null;
  /** Frontmatter `shadow_id`, used only when given. */
  shadowId?: string;
  title: string;
  date: string;
  startedAt?: string | null;
  endedAt?: string | null;
  attendees?: SyntheticPerson[];
  speakers?: SyntheticSpeaker[];
  /** Transcript lines `[mm:ss] Speaker: words`; undefined writes no Transcript.md. */
  transcript?: string[];
  notes?: string;
  outline?: string;
  /** Other materials: file name without `.md` → content. */
  extra?: Record<string, string>;
  /** Folder relative to the Vault root; default `Meetings/<yyyy>/<mm>/<date> <title>`. */
  folder?: string;
  /** Page file name without `.md`; default the title. */
  pageName?: string;
}

export const ANN: SyntheticPerson = { name: 'Ann Lee', email: 'ann@example.com' };
export const BEN: SyntheticPerson = { name: 'Ben Ortiz', email: 'ben@example.com' };
export const CHLOE: SyntheticPerson = { name: 'Chloe Park', email: null };
export const DEV: SyntheticPerson = { name: 'Dev Rao', email: 'dev.rao@example.com' };
export const EVE: SyntheticPerson = { name: 'Eve Stone', email: 'eve@example.com' };

const NOTICE =
  'Shadow keeps this file in sync. For the most reliable updates, make changes in Shadow whenever possible. Supported direct edits are applied automatically. If an edit can’t be applied safely, Shadow saves a copy before repairing the file.';

export function callout(referenceId: string | null): string {
  return `> [!note] Managed by Shadow\n> ${NOTICE}${referenceId ? ` (Shadow Reference ID: ${referenceId})` : ''}`;
}

function personTitle(person: SyntheticPerson): string {
  return person.email ? `${person.name} (${person.email})` : person.name;
}

function personLink(person: SyntheticPerson): string {
  return `[[People/${personTitle(person)}|${person.name}]]`;
}

function cell(value: string): string {
  return value.replace(/\|/gu, '\\|');
}

export function defaultFolder(meeting: SyntheticMeeting): string {
  const [year, month] = meeting.date.split('-');
  return `Meetings/${year}/${month}/${meeting.date} ${meeting.title}`;
}

export function meetingPage(meeting: SyntheticMeeting, folder: string): string {
  const quoted = (value: string | null | undefined) => (value ? JSON.stringify(value) : 'null');
  const lines = [
    '---',
    'type: meeting',
    `title: ${JSON.stringify(meeting.title)}`,
    `date: ${meeting.date}`,
    `createdAt: ${quoted(meeting.startedAt)}`,
    `startedAt: ${quoted(meeting.startedAt)}`,
    `endedAt: ${quoted(meeting.endedAt)}`,
    ...(meeting.shadowId ? [`shadow_id: ${JSON.stringify(meeting.shadowId)}`] : []),
    '---',
    '',
    callout(meeting.id),
    '',
    '## Attendees',
    '',
    '| name | email |',
    '|---|---|',
  ];
  const attendees = meeting.attendees ?? [];
  for (const person of attendees) lines.push(`| ${cell(personLink(person))} | ${person.email ?? ''} |`);
  if (attendees.length === 0) lines.push('|  |  |');
  lines.push('', '## Speaker Assignments', '', '| speaker | person | email |', '|---|---|---|');
  const speakers = meeting.speakers ?? [];
  for (const speaker of speakers) {
    lines.push(`| ${speaker.speaker} | ${speaker.person ? cell(personLink(speaker.person)) : ''} | ${speaker.person?.email ?? ''} |`);
  }
  if (speakers.length === 0) lines.push('|  |  |');
  lines.push('', '## Materials', '');
  const materials = [
    ...(meeting.transcript ? ['Transcript'] : []),
    ...(meeting.notes ? ['Meeting Notes'] : []),
    ...(meeting.outline ? ['Meeting Outline'] : []),
    ...Object.keys(meeting.extra ?? {}),
  ];
  for (const name of materials) lines.push(`- [[${folder}/${name}|${name}]]`);
  lines.push('');
  return lines.join('\n');
}

export function transcriptFile(lines: string[]): string {
  return ['# Transcript', '', callout(null), '', ...lines, ''].join('\n');
}

/** A `Meeting Notes.md` in the shape of Shadow's default notes Skill. */
export function meetingNotes(options: { overview: string; actionRows?: Array<[string, string, string]>; decisions?: string }): string {
  const rows = options.actionRows ?? [];
  return [
    '## Meeting Overview',
    '',
    options.overview,
    '',
    '---',
    '',
    '## Decisions Made',
    '',
    options.decisions ?? '*(No decisions were made during this meeting.)*',
    '',
    '---',
    '',
    '## Action Items',
    '',
    '| Task | Owner | Due / Timeline |',
    '| :--- | :--- | :--- |',
    ...(rows.length > 0 ? rows.map((row) => `| ${row.map(cell).join(' | ')} |`) : ['| *(None)* | | |']),
    '',
    '---',
    '',
    '## Key Sections',
    '',
    '### Opening [00:00]',
    '',
  ].join('\n');
}

export function writeFile(root: string, relPath: string, content: string): void {
  const path = join(root, ...relPath.split('/'));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

export function writeMeeting(root: string, meeting: SyntheticMeeting): string {
  const folder = meeting.folder ?? defaultFolder(meeting);
  writeFile(root, `${folder}/${meeting.pageName ?? meeting.title}.md`, meetingPage(meeting, folder));
  if (meeting.transcript) writeFile(root, `${folder}/Transcript.md`, transcriptFile(meeting.transcript));
  if (meeting.notes) writeFile(root, `${folder}/Meeting Notes.md`, meeting.notes);
  if (meeting.outline) writeFile(root, `${folder}/Meeting Outline.md`, meeting.outline);
  for (const [name, content] of Object.entries(meeting.extra ?? {})) writeFile(root, `${folder}/${name}.md`, content);
  return folder;
}

export function writePerson(root: string, person: SyntheticPerson, referenceId: string): void {
  const lines = ['---', `name: ${JSON.stringify(person.name)}`];
  if (person.email) lines.push(`email: ${JSON.stringify(person.email)}`);
  lines.push('---', '', callout(referenceId), '', '## Meetings', '', '');
  writeFile(root, `People/${personTitle(person)}.md`, lines.join('\n'));
}

export function writeGuide(root: string): void {
  writeFile(
    root,
    'SHADOW.md',
    ['---', 'type: shadow-vault', 'schema_version: 1', '---', '', '# Shadow vault', '', 'Synthetic guide for tests.', ''].join('\n'),
  );
}

export function tempDir(prefix = 'shadow-mcp-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function removeDir(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

export const IDS = {
  planning: '0a1b2c3d4e5f60718293a4b5c6d7e8f9',
  design: '1b2c3d4e5f60718293a4b5c6d7e8f90a',
  customer: '2c3d4e5f60718293a4b5c6d7e8f90a1b',
  hiring: '3d4e5f60718293a4b5c6d7e8f90a1b2c',
};

/** Four meetings, three Person pages and a guide. */
export function standardMeetings(): SyntheticMeeting[] {
  return [
    {
      id: IDS.planning,
      title: 'Quarterly Planning',
      date: '2026-10-14',
      startedAt: '2026-10-14 09:00:00 UTC',
      endedAt: '2026-10-14 09:45:30 UTC',
      attendees: [ANN, BEN],
      speakers: [
        { speaker: 'Speaker 1', person: ANN },
        { speaker: 'Speaker 2', person: BEN },
        { speaker: 'Speaker 3' },
      ],
      transcript: [
        `[00:00] [[People/Ann Lee (ann@example.com)|Ann Lee]]: Welcome everyone, let us review the budget for next quarter.`,
        `[00:12] [[People/Ben Ortiz (ben@example.com)|Ben Ortiz]]: The marketing budget needs a second look before Friday.`,
        `[01:05] Speaker 3: I can draft the hiring plan.`,
        `[02:30] [[People/Ann Lee (ann@example.com)|Ann Lee]]: Great, then the roadmap is settled.`,
      ],
      notes: meetingNotes({
        overview: 'The team reviewed the quarterly budget and the roadmap.',
        actionRows: [
          ['Send the revised budget', 'Ben Ortiz', 'Friday'],
          ['Draft the hiring plan', 'Speaker 3', 'Next week'],
        ],
        decisions: '- The roadmap is settled.',
      }),
      outline: '### Budget\n- Marketing budget needs review. [00:12]\n---\n',
    },
    {
      id: IDS.design,
      title: 'Design Review',
      date: '2026-10-15',
      startedAt: '2026-10-15 13:00:00 UTC',
      endedAt: '2026-10-15 14:20:00 UTC',
      attendees: [ANN, CHLOE],
      speakers: [{ speaker: 'Speaker 1', person: CHLOE }, { speaker: 'Speaker 2' }],
      transcript: [
        '[00:00] Speaker 1: Let us look at the onboarding screens.',
        '[45:10] Speaker 2: The budget slide is confusing.',
        '[1:05:03] Speaker 1: Final point on the color palette for onboarding.',
        '[1:19:59] Speaker 2: Thanks all.',
      ],
      notes: meetingNotes({ overview: 'Onboarding screens were reviewed.' }),
    },
    {
      id: IDS.customer,
      title: 'Customer Call | Acme',
      folder: 'Meetings/2026/10/2026-10-16 Customer Call Acme',
      pageName: 'Customer Call Acme',
      date: '2026-10-16',
      startedAt: '2026-10-16 10:00 GMT+09:00',
      endedAt: '2026-10-16 10:30 GMT+09:00',
      attendees: [DEV],
      speakers: [{ speaker: 'Speaker 1', person: DEV }],
      transcript: ['[00:00] [[People/Dev Rao (dev.rao@example.com)|Dev Rao]]: Acme wants the export feature by December.'],
    },
    {
      id: IDS.hiring,
      title: 'Hiring Sync',
      date: '2026-10-10',
      startedAt: null,
      endedAt: null,
      attendees: [BEN, DEV],
      notes: '## Summary\n\nWe discussed two candidates.\n',
    },
  ];
}

export function writeStandardVault(root: string): void {
  writeGuide(root);
  for (const meeting of standardMeetings()) writeMeeting(root, meeting);
  writePerson(root, ANN, 'person_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  writePerson(root, BEN, 'person_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  writePerson(root, EVE, 'person_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee');
}
