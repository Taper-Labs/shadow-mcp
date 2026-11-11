// Keyword search over titles, notes (non-transcript materials) and transcripts.

import { normalizeNewlines, normalizeText } from './markdown.js';
import type { Meeting, TranscriptLine, VaultIndex } from './types.js';
import { compareMeetings } from './vault.js';

export type SearchScope = 'titles' | 'notes' | 'transcripts';

export interface SearchMatch {
  /** `title`, `transcript`, or the name of the material the line is in. */
  source: string;
  time?: string;
  speaker?: string;
  snippet: string;
}

export interface MeetingHit {
  meeting: Meeting;
  matches: SearchMatch[];
  matchingLines: number;
}

const SNIPPET_CHARS = 300;
const MATCHES_PER_MEETING = 3;

/** Normalised terms: whitespace-separated words, or one phrase when the query is wrapped in double quotes. */
export function parseQuery(query: string): string[] {
  const trimmed = normalizeText(query).trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    const phrase = trimmed.slice(1, -1).trim().replace(/\s+/gu, ' ');
    return phrase ? [phrase] : [];
  }
  return [...new Set(trimmed.split(/\s+/u).filter(Boolean))];
}

/** About `SNIPPET_CHARS` characters of `text` around the first term found. */
export function snippetAround(text: string, terms: string[]): string {
  const clean = text.trim();
  if (clean.length <= SNIPPET_CHARS) return clean;
  const normalized = normalizeText(clean);
  const lower = clean.toLowerCase();
  let position = -1;
  for (const term of terms) {
    let found = normalized.length === clean.length ? normalized.indexOf(term) : lower.indexOf(term);
    if (found < 0) found = lower.indexOf(term);
    if (found >= 0 && (position < 0 || found < position)) position = found;
  }
  let start = Math.max(0, position - 100);
  const end = Math.min(clean.length, start + SNIPPET_CHARS);
  start = Math.max(0, end - SNIPPET_CHARS);
  return `${start > 0 ? '…' : ''}${clean.slice(start, end).trim()}${end < clean.length ? '…' : ''}`;
}

interface Line {
  match: Omit<SearchMatch, 'snippet'>;
  /** Text the snippet is cut from. */
  text: string;
  /** Normalised text the terms are counted in. */
  searched: string;
}

function linesOf(index: VaultIndex, meeting: Meeting, scopes: Set<SearchScope>, transcript: TranscriptLine[]): Line[] {
  const lines: Line[] = [];
  if (scopes.has('titles')) {
    lines.push({ match: { source: 'title' }, text: meeting.title, searched: normalizeText(meeting.title) });
  }
  if (scopes.has('notes')) {
    for (const material of meeting.materials) {
      for (const line of normalizeNewlines(index.readText(material.path)).split('\n')) {
        if (line.trim()) lines.push({ match: { source: material.name }, text: line, searched: normalizeText(line) });
      }
    }
  }
  if (scopes.has('transcripts')) {
    for (const line of transcript) {
      lines.push({
        match: { source: 'transcript', time: line.time, speaker: line.speaker },
        text: line.words,
        searched: normalizeText(`${line.speaker}: ${line.words}`),
      });
    }
  }
  return lines;
}

function containsAllTerms(index: VaultIndex, meeting: Meeting, terms: string[], scopes: Set<SearchScope>, transcript: TranscriptLine[]): boolean {
  const texts: string[] = [];
  if (scopes.has('titles')) texts.push(normalizeText(meeting.title));
  if (scopes.has('notes')) for (const material of meeting.materials) texts.push(index.normalizedText(material.path));
  if (scopes.has('transcripts')) texts.push(normalizeText(transcript.map((line) => `${line.speaker}: ${line.words}`).join('\n')));
  return terms.every((term) => texts.some((text) => text.includes(term)));
}

/** The meeting's best lines when every term appears somewhere in its searched text, else null. Reads the transcript once. */
export function searchMeeting(index: VaultIndex, meeting: Meeting, terms: string[], scopes: Set<SearchScope>): MeetingHit | null {
  if (terms.length === 0) return null;
  const transcript = (scopes.has('transcripts') ? index.transcript(meeting) : null) ?? [];
  if (!containsAllTerms(index, meeting, terms, scopes, transcript)) return null;
  const scored = linesOf(index, meeting, scopes, transcript)
    .map((line, order) => ({ line, order, count: terms.filter((term) => line.searched.includes(term)).length }))
    .filter((entry) => entry.count > 0);
  const best = [...scored]
    .sort((a, b) => b.count - a.count || a.order - b.order)
    .slice(0, MATCHES_PER_MEETING)
    .map(({ line }) => {
      const inText = terms.filter((term) => normalizeText(line.text).includes(term));
      return { ...line.match, snippet: snippetAround(line.text, inText.length > 0 ? inText : terms) };
    });
  return { meeting, matches: best, matchingLines: scored.length };
}

/** Matching meetings ranked by number of matching lines, then newest first. */
export function searchMeetings(index: VaultIndex, meetings: Meeting[], query: string, scopes: Set<SearchScope>): MeetingHit[] {
  const terms = parseQuery(query);
  const hits: MeetingHit[] = [];
  for (const meeting of meetings) {
    const hit = searchMeeting(index, meeting, terms, scopes);
    if (hit) hits.push(hit);
  }
  return hits.sort((a, b) => b.matchingLines - a.matchingLines || compareMeetings(a.meeting, b.meeting));
}
