import { describe, expect, it } from 'vitest';
import { findSections, isPlaceholderSection } from '../src/sections.js';
import { meetingNotes } from './helpers/vault.js';

describe('action-item sections', () => {
  it('returns the table under Action Items, stopping at the rule', () => {
    const notes = meetingNotes({ overview: 'x', actionRows: [['Send the deck', 'Ann Lee', 'Friday']] });
    const sections = findSections(notes, 'Action Items');
    expect(sections).toHaveLength(1);
    expect(sections[0]).toBe('| Task | Owner | Due / Timeline |\n| :--- | :--- | :--- |\n| Send the deck | Ann Lee | Friday |');
    expect(isPlaceholderSection(sections[0] ?? '')).toBe(false);
  });

  it('treats a placeholder-only section as empty', () => {
    const [section] = findSections(meetingNotes({ overview: 'x' }), 'action items');
    expect(section).toContain('*(None)*');
    expect(isPlaceholderSection(section ?? '')).toBe(true);
    for (const text of ['', 'None', 'N/A.', '- No action items were identified.', '*(No action items)*', '| A | B |\n|---|---|\n| None | |']) {
      expect(isPlaceholderSection(text)).toBe(true);
    }
    expect(isPlaceholderSection('- [ ] Book the venue')).toBe(false);
  });

  it('returns nothing when the heading is missing', () => {
    expect(findSections('## Summary\n\nText\n', 'Action Items')).toEqual([]);
  });

  it('matches a custom heading by prefix and stops at a same-level heading', () => {
    const text = '# Notes\n\n### Next Steps (agreed)\n- Ship it\n#### Detail\n- sub point\n### Risks\n- none known\n';
    expect(findSections(text, 'Next steps')).toEqual(['- Ship it\n#### Detail\n- sub point']);
    expect(findSections(text, 'Detail')).toEqual(['- sub point']);
  });

  it('ignores headings inside code fences and level 5+ headings', () => {
    const text = '```\n## Action Items\nnot a heading\n```\n##### Action Items\n- deep\n';
    expect(findSections(text, 'Action Items')).toEqual([]);
  });

  it('accepts bold heading text and a trailing colon', () => {
    expect(findSections('## **Action Items:**\n- Call Ben\n', 'Action Items')).toEqual(['- Call Ben']);
  });
});
