import { describe, expect, it } from 'vitest';
import {
  buildNoteOpenLink,
  buildNoteOpenLinkById,
  buildNoteOpenLinkFromPath,
  buildNotebookRelativeOpenLink,
} from './path-link';

describe('path deep links', () => {
  it('encodes notebook, nested path, and heading without an ID', () => {
    const link = buildNoteOpenLink('My Vault', 'Projects/Plan.md', 'Goals');
    expect(link).toBe('flowix://open?b=My+Vault&f=Projects%2FPlan.md&heading=Goals');
    expect(link).not.toContain('memo/');
  });

  it('distinguishes a literal # in the filename from a heading', () => {
    expect(buildNoteOpenLink('A', 'Plan#Goals.md')).toBe('flowix://open?b=A&f=Plan%23Goals.md&heading=');
  });

  it('addresses a same-notebook file without any notebook key', () => {
    expect(buildNotebookRelativeOpenLink('Projects/Plan.md')).toBe('flowix://open?f=Projects%2FPlan.md');
    expect(buildNotebookRelativeOpenLink('Projects/Plan.md', 'Goals'))
      .toBe('flowix://open?f=Projects%2FPlan.md&heading=Goals');
    expect(() => buildNotebookRelativeOpenLink('/Plan.md')).toThrow('Invalid notebook link target');
    expect(() => buildNotebookRelativeOpenLink('Projects/../Plan.md')).toThrow('Invalid notebook link target');
  });

  it('addresses a cross-notebook file by ID', () => {
    expect(buildNoteOpenLinkById('book-1', 'Projects/Plan.md', 'Goals'))
      .toBe('flowix://open?notebookId=book-1&f=Projects%2FPlan.md&heading=Goals');
    expect(() => buildNoteOpenLinkById('', 'Plan.md')).toThrow('Invalid notebook link target');
  });

  it('uses the exact notebook root and refuses ambiguous names', () => {
    const books = [
      { name: 'Root', path: 'C:/Notes' },
      { name: 'Nested', path: 'C:/Notes/Book' },
    ];
    expect(buildNoteOpenLinkFromPath('C:/Notes/Book/Plan.md', books)).toBe('flowix://open?b=Nested&f=Plan.md');
    expect(buildNoteOpenLinkFromPath('c:/notes/book/Plan.md', books)).toBe('flowix://open?b=Nested&f=Plan.md');
    expect(buildNoteOpenLinkFromPath('C:/Notes/Book/Plan.md', [...books, { name: 'Nested', path: 'D:/Other' }])).toBeNull();
  });
});
