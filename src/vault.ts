// Scans a Vault folder into an in-memory index. Reads only `Meetings/` and
// `People/`, skips set-aside and hidden folders, never follows a symlink
// inside the Vault, and never writes. Every read goes through readVaultFile.
// Transcripts are read when a tool needs them and are not kept.

import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { readVaultFile, TRANSCRIPT_MAX_BYTES } from './files.js';
import {
  frontmatterUnclosed,
  localDateKey,
  normalizeEmail,
  normalizeText,
  parseAttendees,
  parseDateKey,
  parseFrontmatter,
  parsePersonFileName,
  parseReferenceId,
  parseShadowTimestamp,
  parseSpeakerAssignments,
  parseTranscript,
} from './markdown.js';
import { personKey } from './people.js';
import type { Material, Meeting, Person, VaultIndex } from './types.js';

/** Folder names Shadow writes but never reads back; never listed or read here. */
const SKIPPED_FOLDERS = new Set(['Unsynced Files', 'Archived Vaults']);
const INDEX_MAX_AGE_MS = 10_000;
/** How much of a `Transcript.md` indexing reads to decide whether it has a turn. */
const TRANSCRIPT_HEAD_BYTES = 4096;

interface ScannedFile {
  /** Vault-relative path with `/` separators. */
  rel: string;
  mtimeMs: number;
  size: number;
}

interface CachedFile {
  mtimeMs: number;
  size: number;
  /** Empty when the file is unreadable or too large. */
  text: string;
  /** The size in bytes when the file is too large to read, else null. */
  tooLarge: number | null;
  normalized?: string;
}

function skippedName(name: string): boolean {
  return name.startsWith('.') || SKIPPED_FOLDERS.has(name);
}

/** Every `.md` file under `relDir` (recursively), in a stable order. Symbolic links are skipped. */
function scanMarkdown(root: string, relDir: string): ScannedFile[] {
  const files: ScannedFile[] = [];

  const walk = (absDir: string, relPath: string) => {
    let entries;
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => compareCodeUnits(a.name, b.name));
    for (const entry of entries) {
      if (skippedName(entry.name)) continue;
      const abs = join(absDir, entry.name);
      const rel = `${relPath}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(abs, rel);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        try {
          const stats = lstatSync(abs);
          if (stats.isFile()) files.push({ rel, mtimeMs: stats.mtimeMs, size: stats.size });
        } catch {
          // Vanished between listing and stat.
        }
      }
    }
  };

  const start = join(root, relDir);
  if (isRealDirectory(start)) walk(start, relDir);
  return files;
}

/** True for a directory that is not a symbolic link. */
function isRealDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isTranscript(rel: string): boolean {
  return baseName(rel).toLowerCase() === 'transcript';
}

function isMeetingPage(text: string): boolean {
  return parseFrontmatter(text).data.get('type')?.trim().toLowerCase() === 'meeting';
}

function stableId(pagePath: string): string {
  return `path-${createHash('sha256').update(pagePath).digest('hex').slice(0, 24)}`;
}

function parentFolder(rel: string): string {
  const index = rel.lastIndexOf('/');
  return index < 0 ? '' : rel.slice(0, index);
}

function baseName(rel: string): string {
  return (rel.split('/').pop() ?? rel).replace(/\.md$/iu, '');
}

/** True for a sync client's conflict copy such as `Title (1).md` or `Folder (2)`. */
function looksLikeCopy(rel: string): boolean {
  return / \(\d+\)$/u.test(baseName(rel)) || / \(\d+\)$/u.test(baseName(parentFolder(rel)));
}

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortTime(meeting: Meeting): number {
  if (meeting.startedAt) return Date.parse(meeting.startedAt);
  const [y, m, d] = meeting.date.split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, d).getTime();
}

/** Newest first; ties by title then id so the order is stable. */
export function compareMeetings(a: Meeting, b: Meeting): number {
  const diff = sortTime(b) - sortTime(a);
  if (diff !== 0 && !Number.isNaN(diff)) return diff;
  if (a.date !== b.date) return compareCodeUnits(b.date, a.date);
  return compareCodeUnits(a.title, b.title) || compareCodeUnits(a.id, b.id);
}

interface PageCandidate {
  file: ScannedFile;
  text: string;
}

// Labels are bounded once here so that no response budget has to deal with a huge title or name.
const TITLE_CHARS = 300;
const NAME_CHARS = 200;
const EMAIL_CHARS = 254;
const MATERIAL_NAME_CHARS = 255;
/** A longer id is replaced by the path id rather than cut, so two ids cannot become one. */
const ID_CHARS = 200;

/** `text` cut to at most `max` characters, ending in `…` when cut. */
function bounded(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max - 1;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}…`;
}

function boundedPerson(person: Person): Person {
  return { name: bounded(person.name, NAME_CHARS), email: person.email === null ? null : bounded(person.email, EMAIL_CHARS) };
}

function meetingFromPage(
  page: PageCandidate,
  folderFiles: ScannedFile[],
  pageRels: Set<string>,
  tooLarge: (file: ScannedFile) => number | null,
): Meeting {
  const { data, body } = parseFrontmatter(page.text);
  const startedDate = parseShadowTimestamp(data.get('startedAt')) ?? parseShadowTimestamp(data.get('createdAt'));
  const endedDate = parseShadowTimestamp(data.get('endedAt'));
  const folderPath = parentFolder(page.file.rel);
  const date =
    parseDateKey(data.get('date')) ??
    (startedDate ? localDateKey(startedDate) : null) ??
    parseDateKey(baseName(folderPath).slice(0, 10)) ??
    localDateKey(new Date(page.file.mtimeMs));
  const duration =
    startedDate && endedDate ? Math.round((endedDate.getTime() - startedDate.getTime()) / 60_000) : null;

  const materials: Material[] = [];
  let transcriptPath: string | null = null;
  for (const file of folderFiles) {
    if (pageRels.has(file.rel)) continue;
    if (isTranscript(file.rel)) transcriptPath = file.rel;
    else materials.push({ name: bounded(baseName(file.rel), MATERIAL_NAME_CHARS), path: file.rel, tooLarge: tooLarge(file) });
  }
  materials.sort((a, b) => compareCodeUnits(a.name, b.name));

  const id = parseReferenceId(body) ?? data.get('shadow_id')?.trim();
  return {
    id: id && id.length <= ID_CHARS ? id : stableId(page.file.rel),
    title: bounded(data.get('title')?.trim() || baseName(page.file.rel), TITLE_CHARS),
    date,
    startedAt: startedDate ? startedDate.toISOString() : null,
    endedAt: endedDate ? endedDate.toISOString() : null,
    durationMinutes: duration !== null && duration >= 0 ? duration : null,
    folderPath,
    pagePath: page.file.rel,
    attendees: parseAttendees(body).map(boundedPerson),
    speakers: parseSpeakerAssignments(body).map((s) => ({
      speaker: bounded(s.speaker, NAME_CHARS),
      person: s.person === null ? null : bounded(s.person, NAME_CHARS),
      email: s.email === null ? null : bounded(s.email, EMAIL_CHARS),
    })),
    materials,
    transcriptPath,
    hasTranscript: false,
  };
}

/** Keeps one of two pages folded into one meeting: not a conflict copy, then the newest page, then the shorter path, then the smaller path. */
function preferPage(a: Meeting, b: Meeting, mtime: (meeting: Meeting) => number): Meeting {
  const copyA = looksLikeCopy(a.pagePath);
  const copyB = looksLikeCopy(b.pagePath);
  if (copyA !== copyB) return copyA ? b : a;
  if (mtime(a) !== mtime(b)) return mtime(a) > mtime(b) ? a : b;
  if (a.pagePath.length !== b.pagePath.length) return a.pagePath.length < b.pagePath.length ? a : b;
  return compareCodeUnits(a.pagePath, b.pagePath) <= 0 ? a : b;
}

/** Pages that may be folded into one meeting: same folder, or sibling folders (a rename that left the old folder behind). */
function sameMeeting(a: Meeting, b: Meeting): boolean {
  return a.folderPath === b.folderPath || parentFolder(a.folderPath) === parentFolder(b.folderPath);
}

/**
 * One meeting per page, except that pages sharing an id fold together when
 * `sameMeeting` allows it. Of the groups left with one id, the group holding
 * the smallest path keeps the id and every other group takes its path id, so
 * no page can hide another by claiming its id.
 */
function uniqueMeetings(candidates: Meeting[], mtime: (meeting: Meeting) => number): Meeting[] {
  const byId = new Map<string, Meeting[]>();
  for (const meeting of candidates) {
    const list = byId.get(meeting.id);
    if (list) list.push(meeting);
    else byId.set(meeting.id, [meeting]);
  }
  const meetings: Meeting[] = [];
  for (const pages of byId.values()) {
    pages.sort((a, b) => compareCodeUnits(a.pagePath, b.pagePath));
    const groups: Meeting[][] = [];
    for (const page of pages) {
      const group = groups.find((members) => members.some((member) => sameMeeting(member, page)));
      if (group) group.push(page);
      else groups.push([page]);
    }
    groups.forEach((group, i) => {
      const kept = group.reduce((a, b) => preferPage(a, b, mtime));
      meetings.push(i === 0 ? kept : { ...kept, id: stableId(kept.pagePath) });
    });
  }
  return meetings;
}

function peopleFrom(pages: Array<{ rel: string; text: string }>, meetings: Meeting[]): Person[] {
  const byKey = new Map<string, Person>();
  for (const page of pages) {
    const { data } = parseFrontmatter(page.text);
    const fromFile = parsePersonFileName(page.rel);
    const name = data.get('name')?.trim() || fromFile.name;
    const email = normalizeEmail(data.get('email')) ?? fromFile.email;
    if (!name && !email) continue;
    const person = boundedPerson({ name: name || (email ?? ''), email });
    const key = personKey(person);
    if (!byKey.has(key)) byKey.set(key, person);
  }
  for (const meeting of meetings) {
    for (const attendee of meeting.attendees) {
      const key = personKey(attendee);
      if (!byKey.has(key)) byKey.set(key, { name: attendee.name, email: attendee.email });
    }
  }
  return [...byKey.values()].sort((a, b) => compareCodeUnits(normalizeText(a.name), normalizeText(b.name)));
}

/** Builds an index of the Vault at `root`, reusing cached page text when a file is unchanged. */
export function buildIndex(rootPath: string, cache: Map<string, CachedFile> = new Map()): VaultIndex {
  const root = realpathSync(rootPath);
  const meetingFiles = scanMarkdown(root, 'Meetings');
  const peopleFiles = scanMarkdown(root, 'People');
  const seen = new Set<string>();

  const load = (file: ScannedFile): CachedFile => {
    seen.add(file.rel);
    const cached = cache.get(file.rel);
    if (cached && cached.mtimeMs === file.mtimeMs && cached.size === file.size) return cached;
    // An unreadable file is treated as empty until it changes.
    const read = readVaultFile(root, file.rel);
    const entry: CachedFile = {
      mtimeMs: file.mtimeMs,
      size: file.size,
      text: read && 'text' in read ? read.text : '',
      tooLarge: read && 'tooLarge' in read ? read.tooLarge : null,
    };
    cache.set(file.rel, entry);
    return entry;
  };

  const byFolder = new Map<string, ScannedFile[]>();
  const pages: PageCandidate[] = [];
  /** Whether each `Transcript.md` that is not a meeting page has turns: one in its first 4,096 bytes, or more than that to read. */
  const hasTurns = new Map<string, boolean>();
  for (const file of meetingFiles) {
    const folder = parentFolder(file.rel);
    const list = byFolder.get(folder);
    if (list) list.push(file);
    else byFolder.set(folder, [file]);
    if (isTranscript(file.rel)) {
      const head = readVaultFile(root, file.rel, TRANSCRIPT_MAX_BYTES, TRANSCRIPT_HEAD_BYTES);
      const headText = head && 'text' in head ? head.text : '';
      // A frontmatter block still open at the end of the head is decided on the whole file.
      const page = isMeetingPage(headText) || (file.size > TRANSCRIPT_HEAD_BYTES && frontmatterUnclosed(headText) && isMeetingPage(load(file).text));
      if (!page) {
        hasTurns.set(file.rel, file.size > TRANSCRIPT_HEAD_BYTES || parseTranscript(headText).length > 0);
        continue;
      }
    }
    const { text } = load(file);
    if (isMeetingPage(text)) pages.push({ file, text });
  }
  const pageRels = new Set(pages.map((page) => page.file.rel));
  const tooLarge = (file: ScannedFile) => load(file).tooLarge;

  const pageMtimes = new Map(pages.map((page) => [page.file.rel, page.file.mtimeMs]));
  const meetings = uniqueMeetings(
    pages.map((page) => meetingFromPage(page, byFolder.get(parentFolder(page.file.rel)) ?? [], pageRels, tooLarge)),
    (meeting) => pageMtimes.get(meeting.pagePath) ?? 0,
  );
  for (const meeting of meetings) {
    // Indexing reads only the head; a transcript too large to read still shows as present.
    meeting.hasTranscript = meeting.transcriptPath !== null && (hasTurns.get(meeting.transcriptPath) ?? false);
  }
  meetings.sort(compareMeetings);

  const people = peopleFrom(peopleFiles.map((file) => ({ rel: file.rel, text: load(file).text })), meetings);

  for (const key of [...cache.keys()]) if (!seen.has(key)) cache.delete(key);

  const entry = (path: string): CachedFile => {
    const cached = cache.get(path);
    if (!cached) throw new Error('That file is not part of the Vault index.');
    return cached;
  };

  return {
    root,
    meetings,
    people,
    readText: (path) => entry(path).text,
    normalizedText: (path) => {
      const cached = entry(path);
      cached.normalized ??= normalizeText(cached.text);
      return cached.normalized;
    },
    transcript: (meeting) => {
      if (!meeting.transcriptPath) return [];
      const read = readVaultFile(root, meeting.transcriptPath, TRANSCRIPT_MAX_BYTES);
      if (!read) return [];
      return 'text' in read ? parseTranscript(read.text) : null;
    },
  };
}

export interface VaultStore {
  /** The current index, rebuilt when older than 10 seconds; null when no Vault is found. */
  get(): VaultIndex | null;
}

export function createVaultStore(options: {
  resolveRoot: () => string | null;
  maxAgeMs?: number;
  now?: () => number;
}): VaultStore {
  const maxAge = options.maxAgeMs ?? INDEX_MAX_AGE_MS;
  const now = options.now ?? Date.now;
  let index: VaultIndex | null = null;
  let builtAt = Number.NEGATIVE_INFINITY;
  let cache = new Map<string, CachedFile>();
  let cacheRoot: string | null = null;
  return {
    get() {
      if (index && now() - builtAt < maxAge) return index;
      const root = options.resolveRoot();
      if (!root) {
        index = null;
        return null;
      }
      if (root !== cacheRoot) {
        cache = new Map();
        cacheRoot = root;
      }
      index = buildIndex(root, cache);
      builtAt = now();
      return index;
    },
  };
}
