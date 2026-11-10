import { describe, expect, it } from 'vitest';
import { localLinkReference } from './local-link-reference';

const notebooks = [{ id: 'a', name: 'Book', path: '/book' }, { id: 'b', name: 'Other', path: '/other' }];
const context = { documentPath: '/book/项目/记录.md', notebookId: 'a', notebooks };
describe('localLinkReference', () => {
  it('makes links relative to the source document directory', () => {
    expect(localLinkReference('flowix://open?b=Book&f=资料%2F说明.md', context))
      .toMatchObject({ href: '../%E8%B5%84%E6%96%99/%E8%AF%B4%E6%98%8E.md', label: '说明' });
    expect(localLinkReference('/book/项目/report.pdf', context)).toMatchObject({ href: './report.pdf', label: 'report.pdf' });
  });
  it('accepts same-notebook and ID-addressed links inside the current notebook', () => {
    expect(localLinkReference('flowix://open?f=资料%2F说明.md', context)?.href)
      .toBe('../%E8%B5%84%E6%96%99/%E8%AF%B4%E6%98%8E.md');
    expect(localLinkReference('flowix://open?notebookId=a&f=资料%2F说明.md', context)?.href)
      .toBe('../%E8%B5%84%E6%96%99/%E8%AF%B4%E6%98%8E.md');
    expect(localLinkReference('flowix://open?notebookId=b&f=资料%2F说明.md', context)).toBeNull();
  });
  it('keeps filename delimiters separate from heading anchors', () => {
    expect(localLinkReference('/book/a#b?.png', context)?.href).toBe('../a%23b%3F.png');
    expect(localLinkReference('flowix://open?b=Book&f=a%23b.md&heading=Hello%20World', context)?.href)
      .toBe('../a%23b.md#Hello%20World');
    expect(localLinkReference('file:///book/a%20b.html', context)?.href).toBe('../a%20b.html');
  });
  it('declines foreign, ambiguous, malformed, and escaping addresses', () => {
    for (const text of ['/other/a.md', '/book-other/a.md', 'flowix://open?b=Other&f=a.md',
      'flowix://open?b=Book&f=..%2Fa.md', '/book/../other/a.md', 'https://example.com', '/book/a.md\n/book/b.md']) {
      expect(localLinkReference(text, context)).toBeNull();
    }
    expect(localLinkReference('flowix://open?b=Book&f=a.md', { ...context, notebooks: [...notebooks, { id: 'c', name: 'Book', path: '/third' }] })).toBeNull();
  });
  it('uses the deepest notebook and supports Windows drive casing', () => {
    expect(localLinkReference('/book/nested/a.md', { ...context, notebooks: [...notebooks, { id: 'c', name: 'Nested', path: '/book/nested' }] })).toBeNull();
    expect(localLinkReference('c:\\Book\\a.pdf', { documentPath: 'C:/Book/sub/a.md', notebooks: [{ id: 'w', name: 'Win', path: 'C:/Book' }] })?.href).toBe('../a.pdf');
  });
  it('supports UNC addresses and file URLs without treating protocol-relative web URLs as paths', () => {
    const unc = { documentPath: '//server/share/sub/n.md', notebooks: [{ id: 'u', name: 'UNC', path: '//server/share' }] };
    for (const address of ['\\\\SERVER\\share\\a.png', '//SERVER/share/a.png', 'file://server/share/a.png']) {
      expect(localLinkReference(address, unc)?.href).toBe('../a.png');
    }
  });

});
