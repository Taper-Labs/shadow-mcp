// The data shapes the server works with. Everything here is built by reading
// the Vault folder; nothing is ever written back.

export interface Attendee {
  name: string;
  email: string | null;
}

export interface SpeakerAssignment {
  /** The voice group label, for example `Speaker 1` or `Unknown`. */
  speaker: string;
  /** The assigned Person's name, or null when the speaker is unassigned. */
  person: string | null;
  email: string | null;
}

export interface TranscriptLine {
  /** `mm:ss` or `h:mm:ss`, as written. */
  time: string;
  seconds: number;
  /** The speaker label with any wikilink reduced to its display text. */
  speaker: string;
  /** The words after `Speaker:`. */
  words: string;
  /** The line exactly as written in `Transcript.md`. */
  raw: string;
}

export interface Material {
  /** File name without `.md`. */
  name: string;
  /** Vault-relative path; internal only, never returned by a tool. */
  path: string;
  /** The file size in bytes when it is too large to read (over 2 MB), else null. */
  tooLarge: number | null;
}

export interface Meeting {
  id: string;
  title: string;
  /** Local calendar day, `YYYY-MM-DD`. */
  date: string;
  /** ISO 8601 UTC, or null. */
  startedAt: string | null;
  endedAt: string | null;
  durationMinutes: number | null;
  /** Vault-relative folder and page paths; internal only. */
  folderPath: string;
  pagePath: string;
  attendees: Attendee[];
  speakers: SpeakerAssignment[];
  /** Markdown materials other than the transcript, sorted by name. */
  materials: Material[];
  /** Vault-relative path of `Transcript.md`, or null. */
  transcriptPath: string | null;
  hasTranscript: boolean;
}

export interface Person {
  name: string;
  email: string | null;
}

export interface VaultIndex {
  /** Absolute real path of the Vault root. */
  root: string;
  /** Newest first. */
  meetings: Meeting[];
  people: Person[];
  /** Reads a Vault-relative Markdown file that the scan found (not a transcript). */
  readText(path: string): string;
  /** NFKC lower-cased text of a file, cached while the file is unchanged. */
  normalizedText(path: string): string;
  /** Parsed transcript lines of a meeting, read from disk on each call; empty when it has none, null when it is too large to read. */
  transcript(meeting: Meeting): TranscriptLine[] | null;
}
