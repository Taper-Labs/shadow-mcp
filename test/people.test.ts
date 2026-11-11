import { describe, expect, it } from 'vitest';
import { parsePersonFileName } from '../src/markdown.js';
import { attendeeMatches, personKey, samePerson } from '../src/people.js';

describe('person identity', () => {
  it('uses the email when there is one, ignoring case', () => {
    expect(samePerson({ name: 'Ann Lee', email: 'Ann@Example.com' }, { name: 'A. Lee', email: 'ann@example.com' })).toBe(true);
    expect(samePerson({ name: 'Ann Lee', email: 'ann@example.com' }, { name: 'Ann Lee', email: 'ann.lee@example.com' })).toBe(false);
  });

  it('uses the normalised name without an email', () => {
    expect(samePerson({ name: ' Chloe   PARK ', email: null }, { name: 'chloe park', email: null })).toBe(true);
    expect(samePerson({ name: 'Ｃｈｌｏｅ Park', email: null }, { name: 'Chloe Park', email: null })).toBe(true);
  });

  it('keeps a no-email person apart from a same-name person with an email', () => {
    expect(samePerson({ name: 'Ann Lee', email: null }, { name: 'Ann Lee', email: 'ann@example.com' })).toBe(false);
    expect(personKey({ name: 'Ann Lee', email: null })).not.toBe(personKey({ name: 'Ann Lee', email: 'ann@example.com' }));
  });

  it('splits Person file names', () => {
    expect(parsePersonFileName('People/Ann Lee (ann@example.com).md')).toEqual({ name: 'Ann Lee', email: 'ann@example.com' });
    expect(parsePersonFileName('People/Chloe Park.md')).toEqual({ name: 'Chloe Park', email: null });
    expect(parsePersonFileName('People/Team (Design).md')).toEqual({ name: 'Team (Design)', email: null });
  });
});

describe('person filter', () => {
  const ann = { name: 'Ann Lee', email: 'ann@example.com' };
  it('matches an exact email ignoring case', () => {
    expect(attendeeMatches(ann, 'ANN@example.com')).toBe(true);
    expect(attendeeMatches(ann, 'ann@example')).toBe(false);
  });

  it('matches a case-insensitive name substring', () => {
    expect(attendeeMatches(ann, 'lee')).toBe(true);
    expect(attendeeMatches(ann, 'ANN L')).toBe(true);
    expect(attendeeMatches(ann, 'Leeds')).toBe(false);
    expect(attendeeMatches({ name: 'Ｃｈｌｏｅ Park', email: null }, 'chloe')).toBe(true);
  });
});
