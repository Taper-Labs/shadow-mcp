// npm run bench: 1,000 synthetic meetings with ~60 KB transcripts in a temp
// folder. The measurements run in a fresh child process so that the numbers,
// including peak resident memory, describe the server only and not the
// generator: index build (first and unchanged), list_meetings and a
// three-term transcript search (first and repeated). A second child serves a
// 3.9 MB transcript and a 1.9 MB note and fails the run when peak memory
// reaches 300 MB.

import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { createVaultStore } from '../src/vault.js';
import type { VaultIndex } from '../src/types.js';
import { getMeeting, getTranscript, listMeetings, searchMeetingsTool } from '../src/tools.js';
import { ANN, BEN, DEV, meetingNotes, removeDir, tempDir, writeGuide, writeMeeting } from '../test/helpers/vault.js';

const MEETINGS = 1000;
const TRANSCRIPT_BYTES = 60_000;
const WORDS = 'the budget roadmap launch customer design review hiring plan metrics revenue onboarding pricing feedback timeline risk scope demo partner support release'.split(' ');

let seed = 42;
function random(): number {
  seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
  return seed / 2_147_483_648;
}

function transcript(meetingNumber: number): string[] {
  const lines: string[] = [];
  let size = 0;
  let seconds = 0;
  while (size < TRANSCRIPT_BYTES) {
    const words = Array.from({ length: 14 + Math.floor(random() * 10) }, () => WORDS[Math.floor(random() * WORDS.length)] ?? 'word');
    if (meetingNumber % 50 === 0 && lines.length === 100) words.push('zebra', 'quartz', 'harbor');
    const h = Math.floor(seconds / 3600);
    const m = String(Math.floor((seconds % 3600) / 60)).padStart(2, '0');
    const s = String(seconds % 60).padStart(2, '0');
    const line = `[${h > 0 ? `${h}:${m}` : m}:${s}] Speaker ${1 + (lines.length % 3)}: ${words.join(' ')}.`;
    lines.push(line);
    size += line.length + 1;
    seconds += 7;
  }
  return lines;
}

function time<T>(run: () => T): [T, number] {
  const start = performance.now();
  const value = run();
  return [value, performance.now() - start];
}

/** Runs in the child process: measures the server code against the Vault at `root`. */
function measure(root: string): void {
  let now = 0;
  const store = createVaultStore({ resolveRoot: () => root, now: () => now });
  const load = (): VaultIndex => {
    const built = store.get();
    if (!built) throw new Error('Vault not found');
    return built;
  };
  const [, buildMs] = time(load);
  now += 60_000;
  const [index, rebuildMs] = time(load);
  const [list, listMs] = time(() => listMeetings(index, { limit: 50 }));
  const [search, searchMs] = time(() => searchMeetingsTool(index, { query: 'zebra quartz harbor', scope: ['transcripts'] }));
  const [, searchAgainMs] = time(() => searchMeetingsTool(index, { query: 'zebra quartz harbor', scope: ['transcripts'] }));

  const out = (label: string, value: string) => process.stdout.write(`${label.padEnd(40)} ${value}\n`);
  const ms = (value: number) => `${value.toFixed(1)} ms`;
  process.stdout.write(`${index.meetings.length} meetings, ${list.total} listed, ${search.total_meetings_matched} matched the search\n`);
  out('index build (first)', ms(buildMs));
  out('index rebuild (no file changed)', ms(rebuildMs));
  out('list_meetings (limit 50)', ms(listMs));
  out('search, 3 terms, transcripts (first)', ms(searchMs));
  out('search, 3 terms, transcripts (again)', ms(searchAgainMs));
  // maxRSS is in kilobytes.
  out('peak resident memory (server process)', `${Math.round(process.resourceUsage().maxRSS / 1024)} MB`);
}

function generate(root: string): void {
  writeGuide(root);
  for (let i = 0; i < MEETINGS; i += 1) {
    const day = new Date(Date.UTC(2024, 0, 1) + i * 86_400_000);
    const date = day.toISOString().slice(0, 10);
    writeMeeting(root, {
      id: (i + 1).toString(16).padStart(32, '0'),
      title: `Meeting ${i + 1}`,
      date,
      startedAt: `${date} 09:00:00 UTC`,
      endedAt: `${date} 10:10:00 UTC`,
      attendees: [ANN, BEN, DEV],
      transcript: transcript(i),
      notes: meetingNotes({ overview: 'Synthetic meeting.', actionRows: [[`Task ${i}`, 'Ann Lee', 'Friday']] }),
    });
  }
}

/** Peak resident memory allowed while serving files just under the size limits. */
const MEMORY_LIMIT_MB = 300;
const BIG_ID = 'b1'.repeat(16);

/** One meeting with a 3.9 MB transcript and a 1.9 MB note, just under the 4 MB and 2 MB limits. */
function generateBig(root: string): void {
  writeGuide(root);
  const lines: string[] = [];
  let size = 0;
  for (let i = 0; size < 3.9 * 1024 * 1024; i += 1) {
    const line = `[${Math.floor(i / 3600)}:${String(Math.floor(i / 60) % 60).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}] Speaker ${1 + (i % 3)}: ${WORDS[i % WORDS.length]} budget review line ${i} with enough words to be a real turn.`;
    lines.push(line);
    size += line.length + 1;
  }
  const notes = `## Action Items\n\n${'- Review the budget numbers with the team before Friday.\n'.repeat(Math.floor((1.9 * 1024 * 1024) / 58))}`;
  writeMeeting(root, { id: BIG_ID, title: 'Big meeting', date: '2026-11-10', attendees: [ANN], transcript: lines, notes });
}

/** Runs in a child process: search, read the transcript and the meeting, then check peak memory. */
function measureMemory(root: string): void {
  const index = createVaultStore({ resolveRoot: () => root }).get();
  if (!index) throw new Error('Vault not found');
  searchMeetingsTool(index, { query: 'budget review' });
  getTranscript(index, { id: BIG_ID });
  getMeeting(index, { id: BIG_ID });
  const peak = Math.round(process.resourceUsage().maxRSS / 1024);
  process.stdout.write(`${'peak memory, 3.9 MB transcript + 1.9 MB note'.padEnd(40)} ${peak} MB (limit ${MEMORY_LIMIT_MB} MB)\n`);
  if (peak >= MEMORY_LIMIT_MB) process.exitCode = 1;
}

/** Writes a Vault with `make`, runs this file with `flag` on it in a fresh process, and removes it. */
function runChild(make: (root: string) => void, flag: string): void {
  const root = tempDir('shadow-mcp-bench-');
  try {
    make(root);
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), flag, root], { stdio: 'inherit' });
    if (child.status !== 0) process.exitCode = child.status ?? 1;
  } finally {
    removeDir(root);
  }
}

const MEASURE_FLAG = '--measure';
const MEMORY_FLAG = '--memory';
const measureAt = process.argv.indexOf(MEASURE_FLAG);
const memoryAt = process.argv.indexOf(MEMORY_FLAG);
if (measureAt >= 0) {
  measure(process.argv[measureAt + 1] ?? '');
} else if (memoryAt >= 0) {
  measureMemory(process.argv[memoryAt + 1] ?? '');
} else {
  runChild(generate, MEASURE_FLAG);
  runChild(generateBig, MEMORY_FLAG);
}
