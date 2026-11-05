import { describe, expect, it } from 'vitest';
import { documentRelativeHref, documentFileHref, resolveDocumentRelativeHref } from './document-relative-path';

const documentPath = '/book/notes/note.md';

describe('document-relative filesystem URL semantics', () => {
  it.each([
    'images/a.jpg?v=2#detail',
    '/book/notes/images/a.jpg?v=2#detail',
    'file:///book/notes/images/a.jpg?v=2#detail',
  ])('separates the path, query and fragment consistently: %s', href => {
    expect(resolveDocumentRelativeHref(href, documentPath)).toEqual({
      path: '/book/notes/images/a.jpg', search: '?v=2', anchor: 'detail',
    });
  });

  it('keeps encoded URL delimiters inside filenames', () => {
    expect(resolveDocumentRelativeHref('images/a%3Fb%23c.jpg?v=2#detail', documentPath)).toEqual({
      path: '/book/notes/images/a?b#c.jpg', search: '?v=2', anchor: 'detail',
    });
  });

  it('supports root-level documents and Windows paths without traversing above a drive root', () => {
    expect(resolveDocumentRelativeHref('images/a.jpg', '/note.md')).toEqual({ path: '/images/a.jpg', anchor: null });
    expect(resolveDocumentRelativeHref('../images/a.jpg', 'C:/book/notes/note.md'))
      .toEqual({ path: 'C:/book/images/a.jpg', anchor: null });
    expect(resolveDocumentRelativeHref('../../../outside.jpg', 'C:/book/notes/note.md')).toBeNull();
  });

  it.each(['https://example.com/a.jpg', 'javascript:alert(1)', '../../../../outside.jpg', 'image%00.jpg'])(
    'rejects non-file or invalid local destinations: %s', href => {
      expect(resolveDocumentRelativeHref(href, documentPath)).toBeNull();
    },
  );
});

// UNC addresses retain their share boundary while relative web URLs keep web semantics.
it('resolves UNC file URLs and relative resources inside a UNC notebook', () => {
  expect(resolveDocumentRelativeHref('file://server/share/a.png', '/book/n.md')?.path).toBe('//server/share/a.png');
  expect(resolveDocumentRelativeHref('../a.png', '//server/share/sub/n.md')?.path).toBe('//server/share/a.png');
  expect(resolveDocumentRelativeHref('../../a.png', '//server/share/n.md')).toBeNull();
  expect(resolveDocumentRelativeHref('//example.com/a.png', '/book/n.md')).toBeNull();
});

it('builds encoded destinations at filesystem roots and across drives', () => {
  expect(documentRelativeHref({ path: '/a.png', anchor: 'Part (1)' }, '/n.md')).toBe('./a.png#Part%20%281%29');
  expect(documentRelativeHref({ path: 'D:/a.png', anchor: null }, 'C:/n.md')).toBeNull();
  expect(documentFileHref({ path: 'D:/a b.png', anchor: null })).toBe('file:///D:/a%20b.png');
});
