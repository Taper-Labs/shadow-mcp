// Parsing of the Markdown Shadow writes into its Vault: frontmatter, the
// "Managed by Shadow" callout, Attendees / Speaker Assignments tables,
// timestamps and transcript lines. Pure functions, no file access.

import type { Attendee, SpeakerAssignment, TranscriptLine } from './types.js';

export function normalizeNewlines(text: string): string {
  return text.replace(/^﻿/u, '').replace(/\r\n?/gu, '\n');
}

/** Text matching for search and filters: Unicode NFKC, lower case. */
export function normalizeText(text: string): string {
  return text.normalize('NFKC').toLowerCase();
}

function frontmatterScalar(raw: string): string | null {
  const value = raw.trim();
  if (!value || value === '~' || value.toLowerCase() === 'null') return null;
  if (value.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value);
      return typeof parsed === 'string' ? parsed : null;
    } catch {
      return value.replace(/^"|"$/gu, '');
    }
  }
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
    return value.slice(1, -1).replace(/''/gu, "'");
  }
  return value;
}

export interface Frontmatter {
  data: Map<string, string | null>;
  body: string;
}

const FRONTMATTER = /^---\n([\s\S]*?)\n---(?:\n|$)/u;

/** True when `text` starts a `---` block that it does not close, as a cut-off head of a file can. */
export function frontmatterUnclosed(text: string): boolean {
  const source = normalizeNewlines(text);
  return source.startsWith('---\n') && !FRONTMATTER.test(source);
}

/** Top-level `key: value` pairs of a leading `---` block. Lists and nesting are ignored. */
export function parseFrontmatter(text: string): Frontmatter {
  const source = normalizeNewlines(text);
  const match = FRONTMATTER.exec(source);
  const data = new Map<string, string | null>();
  if (!match) return { data, body: source };
  for (const line of (match[1] ?? '').split('\n')) {
    const pair = /^([A-Za-z_][\w-]*):(.*)$/su.exec(line);
    if (pair?.[1] !== undefined) data.set(pair[1], frontmatterScalar(pair[2] ?? ''));
  }
  return { data, body: source.slice(match[0].length) };
}

const CALLOUT_TITLE = '> [!note] Managed by Shadow';
const CALLOUT_ID = '(Shadow Reference ID: ';
const LEGACY_REFERENCE = /^\*\*Shadow Reference ID:\*\*[ \t]*`([^`\n]+)`[ \t]*$/imu;

function trimBlanksEnd(line: string): string {
  let end = line.length;
  while (end > 0 && (line[end - 1] === ' ' || line[end - 1] === '\t')) end -= 1;
  return line.slice(0, end);
}

/** The id at the end of a callout body line: after the last `(Shadow Reference ID: `, up to the closing `)`. */
function calloutId(line: string): string | null {
  const body = trimBlanksEnd(line);
  if (!body.startsWith('> ') || !body.endsWith(')')) return null;
  const at = body.lastIndexOf(CALLOUT_ID);
  if (at < 2) return null;
  const id = body.slice(at + CALLOUT_ID.length, -1);
  return id && !id.includes(')') ? id : null;
}

/** The Shadow Reference ID from the "Managed by Shadow" callout (or the older bold footer). */
export function parseReferenceId(text: string): string | null {
  const source = normalizeNewlines(text);
  const lines = source.split('\n');
  let id: string | null = null;
  for (let i = 0; i + 1 < lines.length && id === null; i += 1) {
    if (trimBlanksEnd(lines[i] ?? '') === CALLOUT_TITLE) id = calloutId(lines[i + 1] ?? '');
  }
  id ??= LEGACY_REFERENCE.exec(source)?.[1] ?? '';
  return id.trim() || null;
}

/** Splits a Markdown table row on pipes that are not escaped as `\|`. */
export function splitTableRow(line: string): string[] {
  let row = line.trim();
  if (row.startsWith('|')) row = row.slice(1);
  if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1);
  const cells: string[] = [];
  let current = '';
  for (let i = 0; i < row.length; i += 1) {
    const char = row[i];
    if (char === '\\' && row[i + 1] === '|') {
      current += '|';
      i += 1;
    } else if (char === '|') {
      cells.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current.trim());
  return cells.map((cell) => cell.replace(/<br\s*\/?>/giu, '\n'));
}

/** A `| --- | :---: |` row. Cells are checked one by one; a single pattern over the row backtracks on long blank runs. */
export function isTableSeparator(line: string): boolean {
  let row = line.trim();
  if (row.startsWith('|')) row = row.slice(1);
  if (row.endsWith('|')) row = row.slice(0, -1);
  return row.split('|').every((cell) => /^:?-+:?$/u.test(cell.trim()));
}

export function isTableRow(line: string): boolean {
  return line.trim().startsWith('|');
}

/** Data rows of the first table under a `## <heading>`, header and separator removed. */
export function tableUnderHeading(text: string, heading: string): string[][] {
  const lines = normalizeNewlines(text).split('\n');
  const wanted = heading.toLowerCase();
  const start = lines.findIndex((line) => /^#{1,6}\s/u.test(line) && line.replace(/^#+\s*/u, '').trim().toLowerCase() === wanted);
  if (start < 0) return [];
  const rows: string[][] = [];
  let seenTable = false;
  let headerSkipped = false;
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6}\s/u.test(line)) break;
    if (!isTableRow(line)) {
      if (seenTable) break;
      continue;
    }
    seenTable = true;
    if (!headerSkipped) {
      headerSkipped = true;
      continue;
    }
    if (isTableSeparator(line)) continue;
    rows.push(splitTableRow(line));
  }
  return rows;
}

export interface Wikilink {
  target: string;
  display: string;
}

/** `[[target|display]]` or `[[target]]` when the whole value is one wikilink, else null. */
export function parseWikilink(value: string): Wikilink | null {
  const match = /^\[\[([^\]|]*)(?:\|([^\]]*))?\]\]$/u.exec(value.trim());
  if (!match) return null;
  const target = (match[1] ?? '').trim();
  const display = (match[2] ?? '').trim() || (target.split('/').pop() ?? target);
  return { target, display };
}

/** Replaces every wikilink in a string with its display text. The parts exclude `[` so a run of `[[` is not rescanned from every start. */
export function stripWikilinks(value: string): string {
  return value.replace(/\[\[([^[\]|]*)(?:\|([^[\]]*))?\]\]/gu, (_all, target: string, display?: string) =>
    (display ?? '').trim() || (target.split('/').pop() ?? target).trim(),
  );
}


export function normalizeEmail(value: string | null | undefined): string | null {
  const email = (value ?? '').trim().toLowerCase();
  return email.includes('@') ? email : null;
}

/** Splits a Person file name: `<name> (<email>)` or `<name>`. */
export function parsePersonFileName(fileName: string): Attendee {
  const base = (fileName.split('/').pop() ?? fileName).replace(/\.md$/iu, '');
  const open = base.lastIndexOf('(');
  const email = base.endsWith(')') && open >= 0 ? base.slice(open + 1, -1) : '';
  // `x@y`: no blanks or parentheses, and an `@` with something on both sides.
  if (/[\s()]/u.test(email) || !email.slice(1, -1).includes('@')) return { name: base.trim(), email: null };
  return { name: base.slice(0, open).trim(), email: normalizeEmail(email) };
}

function personCell(cell: string): Attendee | null {
  const link = parseWikilink(cell);
  if (!link) {
    const name = cell.trim();
    return name ? { name, email: null } : null;
  }
  const fromTarget = parsePersonFileName(link.target);
  const name = link.display || fromTarget.name;
  return name ? { name, email: fromTarget.email } : null;
}

export function parseAttendees(text: string): Attendee[] {
  const attendees: Attendee[] = [];
  for (const row of tableUnderHeading(text, 'Attendees')) {
    const person = personCell(row[0] ?? '');
    if (!person) continue;
    attendees.push({ name: person.name, email: normalizeEmail(row[1]) ?? person.email });
  }
  return attendees;
}

export function parseSpeakerAssignments(text: string): SpeakerAssignment[] {
  const speakers: SpeakerAssignment[] = [];
  for (const row of tableUnderHeading(text, 'Speaker Assignments')) {
    const speaker = (row[0] ?? '').trim();
    if (!speaker) continue;
    const person = personCell(row[1] ?? '');
    speakers.push({
      speaker,
      person: person?.name ?? null,
      email: normalizeEmail(row[2]) ?? person?.email ?? null,
    });
  }
  return speakers;
}

const TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(UTC|Z|GMT\s*[+-]\d{2}:?\d{2}|[+-]\d{2}:?\d{2})?$/iu;

function offsetMinutes(zone: string | undefined): number | null {
  if (!zone) return null;
  const normalized = zone.toUpperCase().replace(/^GMT\s*/u, '');
  if (normalized === 'UTC' || normalized === 'Z') return 0;
  const match = /^([+-])(\d{2}):?(\d{2})$/u.exec(normalized);
  if (!match) return null;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === '-' ? -minutes : minutes;
}

/**
 * Parses Shadow's readable timestamps ("2026-10-15 15:36:01 UTC",
 * "2026-10-15 15:36 GMT+09:00"). A value without a zone is local time.
 */
export function parseShadowTimestamp(value: string | null | undefined): Date | null {
  const raw = (value ?? '').trim();
  if (!raw) return null;
  const match = TIMESTAMP.exec(raw);
  if (match) {
    const [year, month, day, hour, minute] = match.slice(1, 6).map(Number) as [number, number, number, number, number];
    const second = match[6] ? Number(match[6]) : 0;
    const offset = offsetMinutes(match[7]);
    const date =
      offset === null
        ? new Date(year, month - 1, day, hour, minute, second)
        : new Date(Date.UTC(year, month - 1, day, hour, minute, second) - offset * 60_000);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (/^\d{4}-\d{2}-\d{2}$/u.test(raw)) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function localDateKey(date: Date): string {
  const two = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
}

export function parseDateKey(value: string | null | undefined): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec((value ?? '').trim());
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

/** `mm:ss` or `h:mm:ss` to seconds, or null. */
export function parseTimecode(value: string): number | null {
  const match = /^(?:(\d+):)?(\d{1,2}):(\d{2})$/u.exec(value.trim());
  if (!match) return null;
  const hours = match[1] ? Number(match[1]) : 0;
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  if (seconds >= 60 || (match[1] && minutes >= 60)) return null;
  return hours * 3600 + minutes * 60 + seconds;
}

// The speaker is a wikilink or starts with a non-blank, and is at most about 200 characters, so the blanks before it match one way only.
const TRANSCRIPT_LINE = /^\[((?:\d{1,6}:)?\d{1,2}:\d{2})\]\s+(\[\[[^\]]{0,200}\]\]|[^:\s][^:]{0,199}):\s?(.*)$/su;

/**
 * Transcript turns, `[mm:ss] Speaker: words`. The `# Transcript` heading and
 * the "Managed by Shadow" callout are dropped. A non-empty line that is not a
 * turn is kept as its own line with the time and speaker of the turn before it.
 */
export function parseTranscript(text: string): TranscriptLine[] {
  const lines: TranscriptLine[] = [];
  for (const raw of normalizeNewlines(text).split('\n')) {
    if (!raw.trim()) continue;
    const match = TRANSCRIPT_LINE.exec(raw);
    const seconds = match ? parseTimecode(match[1] ?? '') : null;
    if (match && seconds !== null) {
      lines.push({
        time: match[1] ?? '',
        seconds,
        speaker: stripWikilinks(match[2] ?? '').trim(),
        words: (match[3] ?? '').trim(),
        raw,
      });
      continue;
    }
    const previous = lines[lines.length - 1];
    // Heading and callout lines come before the first turn.
    if (!previous) continue;
    lines.push({ time: previous.time, seconds: previous.seconds, speaker: previous.speaker, words: raw.trim(), raw });
  }
  return lines;
}
