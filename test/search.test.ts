import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseQuery, searchMeetings, snippetAround, type SearchScope } from '../src/search.js';
import type { VaultIndex } from '../src/types.js';
import { buildIndex } from '../src/vault.js';
import { IDS, removeDir, tempDir, writeMeeting, writeStandardVault } from './helpers/vault.js';

const ALL = new Set<SearchScope>(['titles', 'notes', 'transcripts']);
let root: string;
let index: VaultIndex;

beforeAll(() => {
  root = tempDir();
  writeStandardVault(root);
  writeMeeting(root, {
    id: 'ffeeddccbbaa99887766554433221100',
    title: 'Long Notes',
    date: '2026-09-01',
    notes: `## Summary\n\n${'filler words '.repeat(60)}the zebra crossing plan ${'more filler '.repeat(60)}\n`,
  });
  writeMeeting(root, { id: 'aaaa0000000000000000000000000001', title: 'Kiwi Sync A', date: '2026-08-01' });
  writeMeeting(root, { id: 'aaaa0000000000000000000000000002', title: 'Kiwi Sync B', date: '2026-08-02' });
  index = buildIndex(root);
});
afterAll(() => removeDir(root));

const ids = (query: string, scopes = ALL) => searchMeetings(index, index.meetings, query, scopes).map((hit) => hit.meeting.id);

describe('query parsing', () => {
  it('splits terms, normalises, and keeps a quoted query as one phrase', () => {
    expect(parseQuery('  Budget  ROADMAP ')).toEqual(['budget', 'roadmap']);
    expect(parseQuery('"Marketing  Budget"')).toEqual(['marketing budget']);
    expect(parseQuery('ＡＣＭＥ')).toEqual(['acme']);
  });
});

describe('search', () => {
  it('requires every term somewhere in the meeting', () => {
    expect(ids('budget')).toEqual([IDS.planning, IDS.design]);
    expect(ids('budget onboarding')).toEqual([IDS.design]);
    expect(ids('budget zebra')).toEqual([]);
  });

  it('matches a quoted phrase exactly', () => {
    expect(ids('"marketing budget"')).toEqual([IDS.planning]);
    expect(ids('"budget marketing"')).toEqual([]);
  });

  it('limits matching to the chosen scopes', () => {
    expect(ids('review', new Set<SearchScope>(['titles']))).toEqual([IDS.design]);
    expect(ids('reviewed', new Set<SearchScope>(['notes']))).toEqual([IDS.design, IDS.planning]);
    expect(ids('reviewed', new Set<SearchScope>(['transcripts']))).toEqual([]);
    expect(ids('acme', new Set<SearchScope>(['transcripts']))).toEqual([IDS.customer]);
  });

  it('searches speaker names but not wikilink targets', () => {
    expect(ids('people')).toEqual([]);
    expect(ids('ortiz marketing', new Set<SearchScope>(['transcripts']))).toEqual([IDS.planning]);
  });

  it('ranks by matching lines, then newest first', () => {
    const hits = searchMeetings(index, index.meetings, 'budget', ALL);
    expect(hits[0]?.matchingLines).toBeGreaterThan(hits[1]?.matchingLines ?? 0);
    expect(ids('kiwi')).toEqual(['aaaa0000000000000000000000000002', 'aaaa0000000000000000000000000001']);
  });

  it('returns at most 3 matches, best lines first, with time and speaker for transcripts', () => {
    const [hit] = searchMeetings(index, index.meetings, 'budget', ALL);
    expect(hit?.matches.length).toBeLessThanOrEqual(3);
    const [palette] = searchMeetings(index, index.meetings, 'palette', ALL);
    expect(palette?.matches[0]).toEqual({
      source: 'transcript',
      time: '1:05:03',
      speaker: 'Speaker 1',
      snippet: 'Final point on the color palette for onboarding.',
    });
    const [both] = searchMeetings(index, index.meetings, 'marketing friday', ALL);
    expect(both?.matches[0]?.snippet).toContain('Friday');
    expect(both?.matches[0]?.snippet.toLowerCase()).toContain('marketing');
  });

  it('names the material a notes match is in', () => {
    const [hit] = searchMeetings(index, index.meetings, 'candidates', ALL);
    expect(hit?.matches[0]?.source).toBe('Meeting Notes');
  });

  it('trims long lines to about 300 characters around the hit', () => {
    const [hit] = searchMeetings(index, index.meetings, 'zebra', ALL);
    const snippet = hit?.matches[0]?.snippet ?? '';
    expect(snippet).toContain('zebra');
    expect(snippet.length).toBeLessThanOrEqual(302);
    expect(snippet.startsWith('…')).toBe(true);
    expect(snippet.endsWith('…')).toBe(true);
    expect(snippetAround('short line', ['short'])).toBe('short line');
  });
});
