// Finding a heading's section (for example "Action Items") in a Skill result
// such as `Meeting Notes.md`, and telling a real section from a placeholder.

import { isTableRow, isTableSeparator, normalizeNewlines, normalizeText, splitTableRow } from './markdown.js';

// Closing `#`s and blanks are removed in code: a pattern for them backtracks on long blank runs.
const HEADING = /^(#{1,6})[ \t]+(.*)$/su;
const RULE = /^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/u;
const FENCE = /^[ \t]*(```|~~~)/u;

/** Text without trailing `#`s, blanks and `*`, `_`, `` ` `` marks, and without a trailing colon. */
function plainHeading(raw: string): string {
  return trimEnd(raw, ' \t#').replace(/[*_`]/gu, '').replace(/:\s*$/u, '').trim();
}

function headingText(raw: string): string {
  return normalizeText(plainHeading(raw));
}

/** One line split into heading level and plain text, or null outside a heading. */
function headingOf(line: string): { level: number; text: string } | null {
  const match = HEADING.exec(line);
  return match ? { level: (match[1] ?? '').length, text: match[2] ?? '' } : null;
}

/** The plain text of every heading of level 1 to 4 outside code fences, in order. */
export function listHeadings(markdown: string): string[] {
  const headings: string[] = [];
  let inFence = false;
  for (const line of normalizeNewlines(markdown).split('\n')) {
    if (FENCE.test(line)) inFence = !inFence;
    const heading = inFence ? null : headingOf(line);
    if (heading && heading.level <= 4) {
      const text = plainHeading(heading.text);
      if (text) headings.push(text);
    }
  }
  return headings;
}

/**
 * The Markdown under every heading of level 1 to 4 whose text equals or
 * starts with `heading` (case ignored), up to the next heading of the same
 * or a higher level or a `---` rule. Trimmed; may be empty.
 */
export function findSections(markdown: string, heading: string): string[] {
  const wanted = headingText(heading);
  if (!wanted) return [];
  const lines = normalizeNewlines(markdown).split('\n');
  const sections: string[] = [];
  let inFence = false;
  let level = 0;
  let collected: string[] | null = null;
  for (const line of lines) {
    if (FENCE.test(line)) inFence = !inFence;
    const match = inFence ? null : headingOf(line);
    const ends = match ? match.level <= level : !inFence && RULE.test(line);
    if (collected && ends) {
      sections.push(collected.join('\n').trim());
      collected = null;
      if (!match) continue;
    }
    if (!collected && match && match.level <= 4) {
      const text = headingText(match.text);
      if (text === wanted || text.startsWith(wanted)) {
        collected = [];
        level = match.level;
        continue;
      }
    }
    if (collected) collected.push(line);
  }
  if (collected) sections.push(collected.join('\n').trim());
  return sections;
}

const PLACEHOLDER =
  /^(?:none|n\/a|na|nil|nothing|tbd|-+|no (?:action items?|actions?|tasks?|decisions?|follow[- ]ups?|next steps?)\b.*|no (?:\w+ ){0,3}(?:were|was) (?:made|identified|recorded|assigned|discussed|captured|noted)\b.*)$/u;

/** `text` without trailing characters from `chars`. `/[.!]+$/` would rescan the run from every start. */
function trimEnd(text: string, chars: string): string {
  let end = text.length;
  while (end > 0 && chars.includes(text[end - 1] ?? '')) end -= 1;
  return text.slice(0, end);
}

/** True for an empty section or one holding only a placeholder such as a `*(None)*` table row, "None" or "No action items". */
export function isPlaceholderSection(section: string): boolean {
  const pieces: string[] = [];
  let tableHeaderPending = true;
  for (const line of normalizeNewlines(section).split('\n')) {
    if (!line.trim()) continue;
    if (isTableRow(line)) {
      if (isTableSeparator(line)) continue;
      if (tableHeaderPending) {
        tableHeaderPending = false;
        continue;
      }
      for (const cell of splitTableRow(line)) pieces.push(cell);
    } else {
      tableHeaderPending = true;
      pieces.push(line.replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/u, ''));
    }
  }
  const meaningful = pieces
    .map((piece) => trimEnd(normalizeText(piece).replace(/[*_()[\]>`~]/gu, ''), '.!').trim())
    .filter(Boolean);
  return meaningful.every((piece) => PLACEHOLDER.test(piece));
}
