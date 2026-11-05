import { describe, expect, it } from 'vitest';
import { resolveDocumentTitlebarTarget } from './document-titlebar-model';

const fileIdentity = { path: '/book/a.md', displayId: 'a' };
const session = { fileIdentity, scopePath: '/book', notebookId: 'book', relativePath: 'a.md', indexable: true };

describe('document titlebar target', () => {
  it('binds notebook metadata to the displayed identity', () => {
    expect(resolveDocumentTitlebarTarget(fileIdentity, session, '/book')).toMatchObject({
      notebookId: 'book', relativePath: 'a.md', indexable: true, isOutsideCurrentNotebook: false,
    });
  });
  it('uses the displayed note’s notebook binding instead of the primary notebook selection', () => {
    const other = { path: '/other/note.md', displayId: 'other' };
    for (const selected of ['/book', null]) {
      expect(resolveDocumentTitlebarTarget(other, {
        fileIdentity: other, scopePath: '/other', notebookId: 'other-book', relativePath: 'note.md', indexable: true,
      }, selected)).toMatchObject({ notebookId: 'other-book', isOutsideCurrentNotebook: false });
    }
  });
  it('does not inherit the active session of a different file or a stale rename path', () => {
    for (const other of [{ ...fileIdentity, displayId: 'other' }, { ...fileIdentity, path: '/book/renamed.md' }]) {
      expect(resolveDocumentTitlebarTarget(other, session, '/book')).toMatchObject({
        notebookId: null, relativePath: null, indexable: false,
      });
    }
  });
  it('keeps an explicit external scope and derives the outside badge from the displayed path', () => {
    const outside = { path: '/outside/a.md', displayId: 'outside' };
    expect(resolveDocumentTitlebarTarget(outside, { ...session, fileIdentity: outside, scopePath: null }, '/book'))
      .toMatchObject({ scopePath: null, isOutsideCurrentNotebook: true });
    expect(resolveDocumentTitlebarTarget(fileIdentity, null, '/book'))
      .toMatchObject({ indexable: false, isOutsideCurrentNotebook: false });
  });
});
