// Local-only: reads the Shadow app's own sample Vault in place when the app
// repository sits next to this one. Skipped everywhere else.

import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getMeeting, getTranscript, listActionItems, searchMeetingsTool } from '../src/tools.js';
import { buildIndex } from '../src/vault.js';

const FIXTURE = fileURLToPath(
  new URL('../../shadow-frontend/src/main/services/vault/__fixtures__/device-2026-10-16/vault', import.meta.url),
);

function meetingFolders(dir: string): number {
  return readdirSync(dir, { withFileTypes: true }).reduce((count, entry) => {
    if (!entry.isDirectory()) return count;
    const path = `${dir}/${entry.name}`;
    const hasPage = readdirSync(path).some((name) => name.endsWith('.md') && name !== 'Transcript.md');
    return count + (hasPage && /^\d{4}-\d{2}-\d{2} /u.test(entry.name) ? 1 : 0) + meetingFolders(path);
  }, 0);
}

describe.skipIf(!existsSync(FIXTURE))('the Shadow app sample Vault', () => {
  // The app writes Reference IDs as 32 hex digits, either bare or in UUID form with dashes.
  const ID = /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/u;

  it('loads with valid ids, titles and dates, and duplicate copies collapse', () => {
    const index = buildIndex(FIXTURE);
    expect(index.meetings.length).toBeGreaterThan(0);
    for (const meeting of index.meetings) {
      expect(meeting.id).toMatch(ID);
      expect(meeting.id.replace(/-/gu, '')).toHaveLength(32);
      expect(meeting.title.length).toBeGreaterThan(0);
      expect(meeting.date).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
    }
    expect(new Set(index.meetings.map((m) => m.id)).size).toBe(index.meetings.length);
    expect(index.meetings.length).toBeLessThan(meetingFolders(`${FIXTURE}/Meetings`));
    expect(index.people.length).toBeGreaterThan(0);
  });

  it('serves every tool over it without error', () => {
    const index = buildIndex(FIXTURE);
    for (const meeting of index.meetings) {
      getMeeting(index, { id: meeting.id });
      if (meeting.hasTranscript) expect(getTranscript(index, { id: meeting.id }).total_lines).toBeGreaterThan(0);
    }
    expect(listActionItems(index, {}).meetings_scanned).toBe(index.meetings.length);
    expect(searchMeetingsTool(index, { query: 'the' }).total_meetings_matched).toBeGreaterThan(0);
  });
});
