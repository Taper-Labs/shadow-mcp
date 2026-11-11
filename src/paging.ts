// Response size cap and opaque cursors.

/** No response text may be longer than this. */
export const MAX_RESPONSE_CHARS = 40_000;

/** Room kept free under the cap for the fields added after a page is cut. */
const SAFETY_MARGIN = 500;

export type CursorData = Record<string, string | number>;

export function encodeCursor(kind: string, data: CursorData): string {
  return Buffer.from(JSON.stringify({ k: kind, ...data }), 'utf8').toString('base64url');
}

/** Decodes a cursor made by `encodeCursor` for the same kind, or throws a plain-sentence error. */
export function decodeCursor(cursor: string, kind: string): CursorData {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    parsed = null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || (parsed as CursorData)['k'] !== kind) {
    throw new Error('That cursor is not valid for this tool; call it again without a cursor.');
  }
  const data: CursorData = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === 'string' || typeof value === 'number') data[key] = value;
  }
  return data;
}

export function cursorNumber(data: CursorData, key: string): number {
  const value = data[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error('That cursor is not valid for this tool; call it again without a cursor.');
  }
  return value;
}

/** Characters a value takes in the JSON text block. */
export function jsonLength(value: unknown): number {
  return JSON.stringify(value).length;
}

/** Characters a string adds inside JSON, without its quotes. */
export function escapedLength(text: string): number {
  return JSON.stringify(text).length - 2;
}

/** Characters left for page content once `skeleton` (the response without that content) is counted. */
export function budgetFor(skeleton: unknown): number {
  return MAX_RESPONSE_CHARS - SAFETY_MARGIN - jsonLength(skeleton);
}

/** The longest prefix of `text` whose JSON-escaped length fits `budget`, cut at a line end when one is near. */
export function cutToBudget(text: string, budget: number): string {
  if (escapedLength(text) <= budget) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (escapedLength(text.slice(0, mid)) <= budget) low = mid;
    else high = mid - 1;
  }
  // Do not end inside a surrogate pair.
  const last = text.charCodeAt(low - 1);
  if (low > 0 && last >= 0xd800 && last <= 0xdbff) low -= 1;
  const lineEnd = text.lastIndexOf('\n', low - 1);
  if (lineEnd > low * 0.8) return text.slice(0, lineEnd + 1);
  return text.slice(0, low);
}
