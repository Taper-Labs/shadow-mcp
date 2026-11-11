// The six tools as plain functions over a Vault index. Each returns the
// structured result; a thrown Error becomes an MCP tool error.

import { createHash } from 'node:crypto';
import { normalizeEmail, parseTimecode } from './markdown.js';
import {
  budgetFor,
  cursorNumber,
  cutToBudget,
  decodeCursor,
  encodeCursor,
  escapedLength,
  jsonLength,
  MAX_RESPONSE_CHARS,
} from './paging.js';
import { attendeeMatches, normalizeName, samePerson } from './people.js';
import type {
  FindPersonInput,
  FindPersonOutput,
  GetMeetingInput,
  GetMeetingOutput,
  GetTranscriptInput,
  GetTranscriptOutput,
  ListActionItemsInput,
  ListActionItemsOutput,
  ListMeetingsInput,
  ListMeetingsOutput,
  MeetingSummary,
  SearchMeetingsInput,
  SearchMeetingsOutput,
} from './schemas.js';
import { searchMeetings, type SearchScope } from './search.js';
import { findSections, isPlaceholderSection, listHeadings } from './sections.js';
import type { Meeting, VaultIndex } from './types.js';

/** Stands in for a short cursor (numbers only) when measuring how much room a page has. */
const CURSOR_PLACEHOLDER = 'x'.repeat(160);
/** The largest number a cursor can hold, for measuring cursors at their longest. */
const MAX_NUMBER = Number.MAX_SAFE_INTEGER;
const HEADINGS_SEEN_MAX = 15;
const HEADING_SEEN_CHARS = 80;

interface MeetingFilter {
  from?: string | undefined;
  to?: string | undefined;
  person?: string | undefined;
}

export function filterMeetings(meetings: Meeting[], filter: MeetingFilter): Meeting[] {
  return meetings.filter(
    (meeting) =>
      (!filter.from || meeting.date >= filter.from) &&
      (!filter.to || meeting.date <= filter.to) &&
      (!filter.person || meeting.attendees.some((attendee) => attendeeMatches(attendee, filter.person ?? ''))),
  );
}

export function meetingSummary(meeting: Meeting): MeetingSummary {
  return {
    id: meeting.id,
    title: meeting.title,
    date: meeting.date,
    started_at: meeting.startedAt,
    ended_at: meeting.endedAt,
    duration_minutes: meeting.durationMinutes,
    attendee_count: meeting.attendees.length,
    attendees: meeting.attendees.map(({ name, email }) => ({ name, email })),
    materials: meeting.materials.map((material) => material.name),
    has_transcript: meeting.hasTranscript,
  };
}

/** `value` with attendees dropped from the end until its JSON fits `budget` (attendee_count keeps the full number). */
function attendeesWithin<T extends { attendees: unknown[] }>(value: T, budget: number): T {
  let size = jsonLength(value);
  let keep = value.attendees.length;
  while (size > budget && keep > 0) {
    keep -= 1;
    size -= jsonLength(value.attendees[keep]) + (keep > 0 ? 1 : 0);
  }
  return keep === value.attendees.length ? value : { ...value, attendees: value.attendees.slice(0, keep) };
}

export function findMeeting(index: VaultIndex, id: string): Meeting {
  const meeting = index.meetings.find((candidate) => candidate.id === id);
  if (!meeting) {
    throw new Error(`No meeting has the id "${id}"; use list_meetings or search_meetings to find meeting ids.`);
  }
  return meeting;
}

export function listMeetings(index: VaultIndex, input: ListMeetingsInput): ListMeetingsOutput {
  const limit = input.limit ?? 50;
  const matching = filterMeetings(index.meetings, input);
  const offset = input.cursor ? cursorNumber(decodeCursor(input.cursor, 'list_meetings'), 'o') : 0;
  const budget = budgetFor({ meetings: [], total: matching.length, next_cursor: CURSOR_PLACEHOLDER });
  const meetings: MeetingSummary[] = [];
  let used = 0;
  let next = offset;
  while (next < matching.length && meetings.length < limit) {
    const candidate = matching[next];
    if (!candidate) break;
    let summary = meetingSummary(candidate);
    const size = jsonLength(summary) + 1;
    if (used + size > budget) {
      if (meetings.length > 0) break;
      summary = attendeesWithin(summary, budget);
    }
    meetings.push(summary);
    used += jsonLength(summary) + 1;
    next += 1;
  }
  return {
    meetings,
    total: matching.length,
    ...(next < matching.length ? { next_cursor: encodeCursor('list_meetings', { o: next }) } : {}),
  };
}

export function searchMeetingsTool(index: VaultIndex, input: SearchMeetingsInput): SearchMeetingsOutput {
  const limit = input.limit ?? 20;
  const scopes = new Set<SearchScope>(input.scope ?? ['titles', 'notes', 'transcripts']);
  const hits = searchMeetings(index, filterMeetings(index.meetings, input), input.query, scopes);
  const budget = budgetFor({ results: [], total_meetings_matched: hits.length, truncated: true });
  const results: SearchMeetingsOutput['results'] = [];
  let used = 0;
  for (const hit of hits) {
    if (results.length >= limit) break;
    let result = { meeting: meetingSummary(hit.meeting), matches: hit.matches };
    const size = jsonLength(result) + 1;
    if (used + size > budget) {
      if (results.length > 0) break;
      result = { meeting: attendeesWithin(result.meeting, budget - jsonLength(result.matches) - 20), matches: result.matches };
    }
    results.push(result);
    used += jsonLength(result) + 1;
  }
  return { results, total_meetings_matched: hits.length, truncated: results.length < hits.length };
}

/** Splits `budget` across texts so that small ones are whole and large ones share the rest equally. */
function fairShares(sizes: number[], budget: number): number[] {
  const shares = sizes.map(() => 0);
  const order = sizes.map((_, i) => i).sort((a, b) => (sizes[a] ?? 0) - (sizes[b] ?? 0));
  let remaining = Math.max(0, budget);
  order.forEach((i, position) => {
    const share = Math.floor(remaining / (order.length - position));
    const give = Math.min(sizes[i] ?? 0, share);
    shares[i] = give;
    remaining -= give;
  });
  return shares;
}

/** A short hash of a material name, so a cursor fails cleanly when the material list changes. */
function nameHash(name: string): string {
  return createHash('sha256').update(name).digest('hex').slice(0, 8);
}

function materialCursor(meeting: Meeting, position: number, offset: number): string {
  return encodeCursor('get_meeting', { id: meeting.id, m: position, h: nameHash(meeting.materials[position]?.name ?? ''), o: offset });
}

export function getMeeting(index: VaultIndex, input: GetMeetingInput): GetMeetingOutput {
  const meeting = findMeeting(index, input.id);
  // The details take at most half a page, so a meeting with very many attendees still shows its materials.
  const base = attendeesWithin(
    { ...meetingSummary(meeting), speakers: meeting.speakers.map((s) => ({ ...s })) },
    Math.floor(budgetFor({}) / 2),
  );
  let position: number | undefined;
  let offset = 0;
  if (input.cursor) {
    const data = decodeCursor(input.cursor, 'get_meeting');
    position = cursorNumber(data, 'm');
    const named = meeting.materials[position];
    if (data['id'] !== meeting.id || !named || data['h'] !== nameHash(named.name) || (input.material !== undefined && input.material !== named.name)) {
      throw new Error('That cursor belongs to another meeting or material; call get_meeting again without a cursor.');
    }
    offset = cursorNumber(data, 'o');
  } else if (input.material !== undefined) {
    const materialName = input.material;
    position = meeting.materials.findIndex((candidate) => candidate.name === materialName);
    if (position < 0) {
      if (materialName.toLowerCase() === 'transcript' && meeting.transcriptPath) {
        throw new Error('Use get_transcript to read the transcript of this meeting.');
      }
      const names = meeting.materials.map((m) => `"${m.name}"`).join(', ') || 'none';
      throw new Error(`This meeting has no material named "${materialName}"; its materials are: ${names}.`);
    }
  }

  if (position === undefined) {
    const texts = meeting.materials.map((material) => index.readText(material.path));
    const skeleton = {
      ...base,
      materials: meeting.materials.map((material, i) => ({
        name: material.name,
        chars: texts[i]?.length ?? 0,
        text: '',
        truncated: true,
        next_cursor: materialCursor(meeting, i, texts[i]?.length ?? 0),
      })),
    };
    const shares = fairShares(texts.map(escapedLength), budgetFor(skeleton));
    return {
      ...base,
      materials: meeting.materials.map((material, i) => {
        if (material.tooLarge !== null) return tooLargeMaterial(material.name, material.tooLarge);
        const full = texts[i] ?? '';
        const text = cutToBudget(full, shares[i] ?? 0);
        const truncated = text.length < full.length;
        return {
          name: material.name,
          chars: full.length,
          text,
          truncated,
          ...(truncated ? { next_cursor: materialCursor(meeting, i, text.length) } : {}),
        };
      }),
    };
  }

  const material = meeting.materials[position];
  if (!material) throw new Error('That cursor belongs to another meeting or material; call get_meeting again without a cursor.');
  if (material.tooLarge !== null) return { ...base, materials: [tooLargeMaterial(material.name, material.tooLarge)] };
  const full = index.readText(material.path);
  if (offset > full.length) throw new Error('That cursor is past the end of the material; call get_meeting again without a cursor.');
  const skeleton = {
    ...base,
    materials: [{ name: material.name, chars: full.length, text: '', truncated: true, next_cursor: materialCursor(meeting, position, full.length) }],
  };
  const text = cutToBudget(full.slice(offset), budgetFor(skeleton));
  const end = offset + text.length;
  const truncated = offset > 0 || end < full.length;
  return {
    ...base,
    materials: [
      {
        name: material.name,
        chars: full.length,
        text,
        truncated,
        ...(end < full.length ? { next_cursor: materialCursor(meeting, position, end) } : {}),
      },
    ],
  };
}

/** A material over 2 MB: listed with its size, never read. */
function tooLargeMaterial(name: string, bytes: number): GetMeetingOutput['materials'][number] {
  return { name, chars: 0, bytes, text: '', truncated: true };
}

function timeArgument(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const seconds = parseTimecode(value);
  if (seconds === null) throw new Error(`${name} must look like mm:ss or h:mm:ss.`);
  return seconds;
}

export function getTranscript(index: VaultIndex, input: GetTranscriptInput): GetTranscriptOutput {
  const meeting = findMeeting(index, input.id);
  const lines = index.transcript(meeting);
  if (lines === null) {
    throw new Error(`The transcript of "${meeting.title}" is too large to read (over 4 MB).`);
  }
  if (lines.length === 0) {
    throw new Error(`The meeting "${meeting.title}" has no transcript; use get_meeting to read its other materials.`);
  }
  let start: number;
  /** Characters of the first line already returned by the previous page. */
  let offset = 0;
  let toSeconds = timeArgument(input.to_time, 'to_time');
  if (input.cursor) {
    const data = decodeCursor(input.cursor, 'get_transcript');
    if (data['id'] !== meeting.id) throw new Error('That cursor belongs to another meeting; call get_transcript again without a cursor.');
    start = cursorNumber(data, 'l');
    if (data['c'] !== undefined) offset = cursorNumber(data, 'c');
    if (offset > 0 && offset >= (lines[start]?.raw.length ?? 0)) {
      throw new Error('That cursor is not valid for this tool; call it again without a cursor.');
    }
    if (typeof data['to'] === 'number') toSeconds = data['to'];
  } else {
    const fromSeconds = timeArgument(input.from_time, 'from_time') ?? 0;
    start = lines.findIndex((line) => line.seconds >= fromSeconds);
    if (start < 0) start = lines.length;
  }
  const inRange = (i: number) => {
    const line = lines[i];
    return line !== undefined && (toSeconds === undefined || line.seconds <= toSeconds);
  };
  const cursorFor = (line: number, at: number) =>
    encodeCursor('get_transcript', { id: meeting.id, l: line, ...(at > 0 ? { c: at } : {}), ...(toSeconds === undefined ? {} : { to: toSeconds }) });

  const base = { meeting_id: meeting.id, title: meeting.title, speakers: meeting.speakers.map((s) => ({ ...s })), total_lines: lines.length };
  const budget = budgetFor({ ...base, first_line: lines.length, last_line: lines.length, text: '', next_cursor: cursorFor(MAX_NUMBER, MAX_NUMBER) });
  const picked: string[] = [];
  let used = 0;
  let end = start;
  /** Where the next page starts inside line `end` when this page ends inside it, else 0. */
  let cut = 0;
  while (inRange(end)) {
    const raw = lines[end]?.raw ?? '';
    const lineStart = end === start ? offset : 0;
    const rest = raw.slice(lineStart);
    const size = escapedLength(`${rest}\n`);
    if (used + size > budget) {
      // A line longer than the whole page: return what fits and continue inside it on the next page.
      if (picked.length === 0) {
        const piece = cutToBudget(rest, budget);
        picked.push(piece);
        cut = lineStart + piece.length;
      }
      break;
    }
    picked.push(rest);
    used += size;
    end += 1;
  }
  return {
    ...base,
    first_line: picked.length > 0 ? start + 1 : null,
    last_line: picked.length > 0 ? (cut > 0 ? end + 1 : end) : null,
    text: picked.join('\n'),
    ...(cut > 0 ? { next_cursor: cursorFor(end, cut) } : inRange(end) ? { next_cursor: cursorFor(end, 0) } : {}),
  };
}

export function listActionItems(index: VaultIndex, input: ListActionItemsInput): ListActionItemsOutput {
  const limit = input.limit ?? 20;
  const heading = input.heading ?? 'Action Items';
  const meetings = filterMeetings(index.meetings, input);
  let meetingIndex = 0;
  let sectionIndex = 0;
  if (input.cursor) {
    const data = decodeCursor(input.cursor, 'list_action_items');
    meetingIndex = cursorNumber(data, 'm');
    sectionIndex = cursorNumber(data, 's');
  }
  const count = meetings.length;
  const budget = budgetFor({
    items: [],
    meetings_scanned: count,
    meetings_without_notes: count,
    meetings_with_notes_but_no_section: count,
    headings_seen: Array.from({ length: HEADINGS_SEEN_MAX }, () => 'x'.repeat(HEADING_SEEN_CHARS)),
    next_cursor: CURSOR_PLACEHOLDER,
  });
  const items: ListActionItemsOutput['items'] = [];
  let used = 0;
  let scanned = 0;
  let withoutNotes = 0;
  let withoutSection = 0;
  /** Headings of the notes that lack the section, by the number of meetings that use them. */
  const headingCounts = new Map<string, number>();
  let next: { m: number; s: number } | null = null;

  for (let m = meetingIndex; m < meetings.length && !next; m += 1) {
    const meeting = meetings[m];
    if (!meeting) break;
    const found = meeting.materials.flatMap((material) =>
      findSections(index.readText(material.path), heading).map((section) => ({ source: material.name, section })),
    );
    const sections = found.filter(({ section }) => !isPlaceholderSection(section));
    const ref = {
      id: meeting.id,
      title: meeting.title,
      date: meeting.date,
      attendee_count: meeting.attendees.length,
      attendees: meeting.attendees.map(({ name, email }) => ({ name, email })),
    };
    for (let s = m === meetingIndex ? sectionIndex : 0; s < sections.length; s += 1) {
      const section = sections[s];
      if (!section) break;
      let item = { meeting: ref, ...section };
      const size = jsonLength(item) + 1;
      if (items.length >= limit || (used + size > budget && items.length > 0)) {
        next = { m, s };
        break;
      }
      if (used + size > budget) {
        // Alone on the page and still too large: shorten the attendees to half a page, then the section.
        const shortened = { meeting: attendeesWithin(ref, Math.floor(budget / 2)), source: section.source, section: '' };
        const room = budget - jsonLength(shortened) - 1;
        const text = escapedLength(section.section) <= room ? section.section : `${cutToBudget(section.section, room - 40)}\n…[section cut]`;
        item = { ...shortened, section: text };
      }
      items.push(item);
      used += jsonLength(item) + 1;
    }
    if (next) break;
    scanned += 1;
    if (meeting.materials.length === 0) withoutNotes += 1;
    else if (found.length === 0) {
      withoutSection += 1;
      const headings = new Set(meeting.materials.flatMap((material) => listHeadings(index.readText(material.path))));
      for (const text of headings) {
        const short = [...text].slice(0, HEADING_SEEN_CHARS).join('');
        headingCounts.set(short, (headingCounts.get(short) ?? 0) + 1);
      }
    }
    if (items.length >= limit && m + 1 < meetings.length) next = { m: m + 1, s: 0 };
  }
  const result: ListActionItemsOutput = {
    items,
    meetings_scanned: scanned,
    meetings_without_notes: withoutNotes,
    meetings_with_notes_but_no_section: withoutSection,
    ...(next ? { next_cursor: encodeCursor('list_action_items', next) } : {}),
  };
  if (withoutSection === 0) return result;
  const seen = [...headingCounts]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, HEADINGS_SEEN_MAX)
    .map(([text]) => text);
  // Headings full of escaped characters can take more room than was kept for them.
  while (seen.length > 0 && jsonLength({ ...result, headings_seen: seen }) > MAX_RESPONSE_CHARS) seen.pop();
  return { ...result, headings_seen: seen };
}

export function findPerson(index: VaultIndex, input: FindPersonInput): FindPersonOutput {
  const limit = input.limit ?? 10;
  const query = normalizeName(input.query);
  const matches = index.people.filter(
    (person) => normalizeName(person.name).includes(query) || (normalizeEmail(person.email) ?? '').includes(query),
  );
  const ranked = matches
    .map((person) => {
      const meetings = index.meetings.filter(
        (meeting) =>
          meeting.attendees.some((attendee) => samePerson(attendee, person)) ||
          meeting.speakers.some((speaker) => speaker.person !== null && samePerson({ name: speaker.person, email: speaker.email }, person)),
      );
      const exact = normalizeName(person.name) === query || normalizeEmail(person.email) === query;
      return { person, meetings, exact };
    })
    .sort(
      (a, b) =>
        Number(b.exact) - Number(a.exact) ||
        b.meetings.length - a.meetings.length ||
        normalizeName(a.person.name).localeCompare(normalizeName(b.person.name)),
    );
  const budget = budgetFor({ people: [], truncated: true });
  const people: FindPersonOutput['people'] = [];
  let used = 0;
  for (const { person, meetings } of ranked) {
    if (people.length >= limit) break;
    const entry = {
      name: person.name,
      email: person.email,
      meeting_count: meetings.length,
      last_meeting_date: meetings[0]?.date ?? null,
      meetings: meetings.slice(0, 20).map((meeting) => ({ id: meeting.id, title: meeting.title, date: meeting.date })),
    };
    const size = jsonLength(entry) + 1;
    if (used + size > budget) break;
    people.push(entry);
    used += size;
  }
  return { people, truncated: people.length < ranked.length };
}
