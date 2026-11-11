// Person identity, matched the way the Shadow app matches People:
//   1. An email is one Person (case ignored).
//   2. Without an email, a name is one Person (NFKC, spaces collapsed, case ignored).
//   3. A Person with an email and a no-email Person of the same name are two People.

import { normalizeEmail, normalizeText } from './markdown.js';
import type { Attendee } from './types.js';

export function normalizeName(name: string): string {
  return normalizeText(name).trim().replace(/\s+/gu, ' ');
}

export function personKey(person: Attendee): string {
  const email = normalizeEmail(person.email);
  return email ? `email:${email}` : `name:${normalizeName(person.name)}`;
}

export function samePerson(a: Attendee, b: Attendee): boolean {
  return personKey(a) === personKey(b);
}

/**
 * The `person` filter: an attendee matches by exact email (case ignored) or
 * when the query is a case-insensitive substring of the attendee's name.
 */
export function attendeeMatches(attendee: Attendee, query: string): boolean {
  const wanted = query.trim();
  if (!wanted) return false;
  const email = normalizeEmail(attendee.email);
  if (email && email === normalizeEmail(wanted)) return true;
  return normalizeName(attendee.name).includes(normalizeName(wanted));
}
