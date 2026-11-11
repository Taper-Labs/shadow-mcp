// Input and output schemas of the six tools. Output types are inferred from
// these so the handlers and the advertised schemas cannot drift apart.

import { z } from 'zod';

const DAY = /^\d{4}-\d{2}-\d{2}$/u;
const TIME = /^(?:\d+:)?\d{1,2}:\d{2}$/u;

/** True for a real calendar day such as 2026-02-28 (not 2026-02-30 or 2026-13-45). */
function isCalendarDay(value: string): boolean {
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
const day = z.string().regex(DAY).refine(isCalendarDay, 'Must be a real calendar day, YYYY-MM-DD.');
const from = day.optional().describe('Earliest meeting day to include, YYYY-MM-DD (inclusive, local calendar day).');
const to = day.optional().describe('Latest meeting day to include, YYYY-MM-DD (inclusive, local calendar day).');
const person = z
  .string()
  .min(1)
  .optional()
  .describe('Only meetings with this attendee: an exact email address, or part of the attendee name (case-insensitive).');
const cursor = z.string().min(1).optional().describe('The next_cursor value from the previous call, to get the next page.');
const meetingId = z.string().min(1).describe('A meeting id from list_meetings, search_meetings, find_person or list_action_items.');

const attendee = z.object({ name: z.string(), email: z.string().nullable() });
const attendeeCount = z.number().int().describe('Number of attendees; the attendees list is shortened when it does not fit in one response.');
const speaker = z.object({
  speaker: z.string().describe('Voice group label, for example "Speaker 1". Voice groups can be wrong.'),
  person: z.string().nullable().describe('Name of the Person assigned to this voice group, or null when unassigned.'),
  email: z.string().nullable(),
});

export const meetingSummary = z.object({
  id: z.string(),
  title: z.string(),
  date: z.string().describe('Local calendar day, YYYY-MM-DD.'),
  started_at: z.string().nullable().describe('ISO 8601 UTC start time, or null.'),
  ended_at: z.string().nullable().describe('ISO 8601 UTC end time, or null.'),
  duration_minutes: z.number().nullable(),
  attendee_count: attendeeCount,
  attendees: z.array(attendee),
  materials: z.array(z.string()).describe('Names of the Markdown materials other than the transcript, such as "Meeting Notes".'),
  has_transcript: z.boolean(),
});

export const listMeetingsInput = z.object({
  from,
  to,
  person,
  limit: z.number().int().min(1).max(200).optional().describe('Most meetings to return (default 50, max 200).'),
  cursor,
});
export const listMeetingsOutput = z.object({
  meetings: z.array(meetingSummary),
  total: z.number().int().describe('Number of meetings that match the filters, across all pages.'),
  next_cursor: z.string().optional(),
});

export const searchMeetingsInput = z.object({
  query: z
    .string()
    .min(1)
    .describe('Words that must all appear in a meeting (any order, case-insensitive). Wrap the whole query in double quotes for one exact phrase.'),
  from,
  to,
  person,
  scope: z
    .array(z.enum(['titles', 'notes', 'transcripts']))
    .min(1)
    .optional()
    .describe('Where to search: "titles", "notes" (AI notes and other materials), "transcripts". Default: all three.'),
  limit: z.number().int().min(1).max(50).optional().describe('Most meetings to return (default 20, max 50).'),
});
export const searchMeetingsOutput = z.object({
  results: z.array(
    z.object({
      meeting: meetingSummary,
      matches: z.array(
        z.object({
          source: z.string().describe('"title", "transcript", or the name of the material the line is in.'),
          time: z.string().optional().describe('Transcript time, mm:ss or h:mm:ss.'),
          speaker: z.string().optional(),
          snippet: z.string(),
        }),
      ),
    }),
  ),
  total_meetings_matched: z.number().int(),
  truncated: z.boolean().describe('True when more meetings matched than are returned.'),
});

export const getMeetingInput = z.object({
  id: meetingId,
  material: z
    .string()
    .min(1)
    .optional()
    .describe('Exact material name from the meeting\'s materials list, to read only that material in full, page by page.'),
  cursor,
});
const materialText = z.object({
  name: z.string(),
  chars: z.number().int().describe('Length of the whole material in characters.'),
  bytes: z.number().int().optional().describe('File size in bytes, given only when the material is too large (over 2 MB) to read; text is then empty.'),
  text: z.string(),
  truncated: z.boolean().describe('True when text is only part of the material; pass next_cursor to read on.'),
  next_cursor: z.string().optional(),
});
export const getMeetingOutput = meetingSummary.extend({
  speakers: z.array(speaker),
  materials: z.array(materialText),
});

export const getTranscriptInput = z.object({
  id: meetingId,
  from_time: z.string().regex(TIME).optional().describe('Start of the time range, mm:ss or h:mm:ss.'),
  to_time: z.string().regex(TIME).optional().describe('End of the time range (inclusive), mm:ss or h:mm:ss.'),
  cursor,
});
export const getTranscriptOutput = z.object({
  meeting_id: z.string(),
  title: z.string(),
  speakers: z.array(speaker),
  total_lines: z.number().int(),
  first_line: z.number().int().nullable().describe('1-based number of the first line returned, or null when none.'),
  last_line: z.number().int().nullable(),
  text: z.string().describe('Transcript lines as written: [mm:ss] Speaker: words.'),
  next_cursor: z.string().optional(),
});

export const listActionItemsInput = z.object({
  from,
  to,
  person,
  heading: z
    .string()
    .min(1)
    .optional()
    .describe('Heading to look for in the notes (default "Action Items"); a heading that starts with this text also counts.'),
  limit: z.number().int().min(1).max(50).optional().describe('Most sections to return (default 20, max 50).'),
  cursor,
});
const meetingRef = z.object({ id: z.string(), title: z.string(), date: z.string() });
export const listActionItemsOutput = z.object({
  items: z.array(
    z.object({
      meeting: meetingRef.extend({ attendee_count: attendeeCount, attendees: z.array(attendee) }),
      source: z.string().describe('Name of the material the section is in, such as "Meeting Notes".'),
      section: z.string().describe('The Markdown under the heading, as written.'),
    }),
  ),
  meetings_scanned: z.number().int(),
  meetings_without_notes: z.number().int().describe('Scanned meetings that have no notes or other materials at all.'),
  meetings_with_notes_but_no_section: z
    .number()
    .int()
    .describe('Scanned meetings that have notes but no section under the heading, often because the notes are in another language.'),
  headings_seen: z
    .array(z.string())
    .optional()
    .describe('When meetings_with_notes_but_no_section is above 0: the headings those notes use, most frequent first. Call again with the right one in heading.'),
  next_cursor: z.string().optional(),
});

export const findPersonInput = z.object({
  query: z.string().min(1).describe('Part of a name or email address (case-insensitive).'),
  limit: z.number().int().min(1).max(50).optional().describe('Most people to return (default 10, max 50).'),
});
export const findPersonOutput = z.object({
  people: z.array(
    z.object({
      name: z.string(),
      email: z.string().nullable(),
      meeting_count: z.number().int(),
      last_meeting_date: z.string().nullable(),
      meetings: z.array(meetingRef).describe('Newest 20 meetings this person attended.'),
    }),
  ),
  truncated: z.boolean().describe('True when more people matched than are returned.'),
});

export type MeetingSummary = z.infer<typeof meetingSummary>;
export type ListMeetingsInput = z.infer<typeof listMeetingsInput>;
export type ListMeetingsOutput = z.infer<typeof listMeetingsOutput>;
export type SearchMeetingsInput = z.infer<typeof searchMeetingsInput>;
export type SearchMeetingsOutput = z.infer<typeof searchMeetingsOutput>;
export type GetMeetingInput = z.infer<typeof getMeetingInput>;
export type GetMeetingOutput = z.infer<typeof getMeetingOutput>;
export type GetTranscriptInput = z.infer<typeof getTranscriptInput>;
export type GetTranscriptOutput = z.infer<typeof getTranscriptOutput>;
export type ListActionItemsInput = z.infer<typeof listActionItemsInput>;
export type ListActionItemsOutput = z.infer<typeof listActionItemsOutput>;
export type FindPersonInput = z.infer<typeof findPersonInput>;
export type FindPersonOutput = z.infer<typeof findPersonOutput>;
